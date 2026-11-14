import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { openBrowserUrl } from '../cli/openBrowserUrl';
import { init } from '../init';
import { catchUpEvents, runAgent, runOne } from './agent';
import { Remote } from './remote';
import {
    defaultConfigPath,
    type FolderConfig,
    isManaged,
    loadSettings,
    saveSettings,
    SETTABLE,
    type Settings,
    stateDirOf,
    trashDirOf,
    validateFolders,
} from './settings';
import { Activity, type ActivityEvent, isAlive, readActivity, readStatus } from './state';
import { AuthError, stateFile, Syncer } from './syncer';
import {
    ago,
    APP_VERSION_STRING,
    errorMessage,
    expandHome,
    log,
    rjoin,
    SDK_VERSION_STRING,
    sleep,
    THIRD_PARTY_NOTICE,
    tildify,
    VERSION,
    warn,
    xdg,
} from './util';

const SERVICE = 'pdrive-sync.service';

const HELP = `pdrive-sync ${VERSION} – Zwei-Wege-Sync zwischen lokalen Ordnern und Proton Drive
(Drittanbieter-Programm, nicht offiziell von Proton unterstützt)

Verwendung: pdrive-sync [--config DATEI] [-v] <befehl> [optionen]

Anmeldung
  login                          im Browser bei Proton anmelden
  logout                         abmelden und gespeicherte Sitzung löschen

Ordner
  folder list                    konfigurierte Ordner anzeigen
  folder add NAME LOKAL REMOTE [--exclude MUSTER]…
                                 Ordner hinzufügen – REMOTE ist relativ zu „Meine Dateien“,
                                 "/" synchronisiert das ganze Proton Drive
  folder remove NAME             Ordner entfernen (Dateien bleiben unberührt)

Einstellungen
  config                         Einstellungen anzeigen
  config set SCHLÜSSEL WERT      ändern: ${Object.keys(SETTABLE).join(', ')}
  config path                    Pfad der Konfigurationsdatei

Abgleich
  sync [-n|--dry-run] [--force] [--folder NAME]…
                                 einmal abgleichen (läuft der Agent, wird er angestoßen)
  watch                          als Agent laufen (so läuft der systemd-Dienst)
  status                         Agent, Anmeldung und Stand der Ordner
  log [-n ANZAHL] [-f]           letzte Änderungen (-f: fortlaufend anzeigen)
  reset NAME                     gespeicherten Stand eines Ordners vergessen

  version                        Version anzeigen
  help                           diese Hilfe
`;

interface Args {
    config: string;
    verbose: boolean;
    cmd: string;
    rest: string[];
}

function parseArgs(argv: string[]): Args {
    let config = defaultConfigPath();
    let verbose = false;
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === '--config' || a === '-c') {
            config = expandHome(argv[++i] ?? '');
        } else if (a.startsWith('--config=')) {
            config = expandHome(a.slice('--config='.length));
        } else if ((a === '-v' || a === '--verbose') && rest.length === 0) {
            verbose = true;
        } else if ((a === '-V' || a === '--version') && rest.length === 0) {
            rest.push('version');
        } else if ((a === '-h' || a === '--help') && rest.length === 0) {
            rest.push('help');
        } else {
            rest.push(a);
        }
    }
    const [cmd = 'help', ...more] = rest;
    return { config, verbose, cmd, rest: more };
}

/** Pull "--flag VALUE" / "--flag" options out of an argument list. */
function takeOptions(args: string[], spec: Record<string, 'bool' | 'multi' | 'value'>) {
    const out: Record<string, boolean | string | string[]> = {};
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        const key = Object.keys(spec).find((k) => k.split('|').includes(a));
        if (!key) {
            if (a.startsWith('-') && a !== '-') {
                throw new UsageError(`Unbekannte Option: ${a}`);
            }
            positional.push(a);
            continue;
        }
        const name = key.split('|').at(-1)!.replace(/^-+/, '');
        if (spec[key] === 'bool') {
            out[name] = true;
        } else {
            const v = args[++i];
            if (v === undefined) {
                throw new UsageError(`${a} braucht einen Wert`);
            }
            out[name] = spec[key] === 'multi' ? [...((out[name] as string[]) ?? []), v] : v;
        }
    }
    return { opts: out, positional };
}

class UsageError extends Error {}

// --------------------------------------------------------------------------- //
// SDK session
// --------------------------------------------------------------------------- //

type Session = Awaited<ReturnType<typeof init>>;

// --------------------------------------------------------------------------- //
// migration from the old name "proton-drive-sync" (< 0.7)
// --------------------------------------------------------------------------- //

const OLD_NAME = 'proton-drive-sync';
const NEW_NAME = 'pdrive-sync';
const SESSION_ENTRY = 'auth-session';

/** Move data directories and a self-managed config to the new name (once). */
function migrateDirectories(): void {
    // never pull the directories away from a still running old agent
    const oldPid = path.join(xdg('XDG_STATE_HOME', '.local/state'), OLD_NAME, 'agent.pid');
    try {
        if (existsSync(oldPid) && isAlive(Number(readFileSync(oldPid, 'utf8')))) {
            return;
        }
    } catch {}
    for (const [variable, fallback] of [
        ['XDG_STATE_HOME', '.local/state'],
        ['XDG_DATA_HOME', '.local/share'],
        ['XDG_CACHE_HOME', '.cache'],
    ] as const) {
        const base = xdg(variable, fallback);
        const from = path.join(base, OLD_NAME);
        const to = path.join(base, NEW_NAME);
        if (existsSync(from) && !existsSync(to)) {
            try {
                renameSync(from, to);
                log(`Übernommen: ${tildify(from)} → ${tildify(to)}`);
            } catch (error) {
                warn(`Konnte ${from} nicht übernehmen: ${errorMessage(error)}`);
            }
        }
    }
    // a config written by the CLI (Home Manager's symlinks are handled by HM itself)
    const configBase = xdg('XDG_CONFIG_HOME', '.config');
    const oldConfig = path.join(configBase, OLD_NAME, 'config.json');
    const newConfig = path.join(configBase, NEW_NAME, 'config.json');
    try {
        if (existsSync(oldConfig) && !lstatSync(oldConfig).isSymbolicLink() && !existsSync(newConfig)) {
            mkdirSync(path.dirname(newConfig), { recursive: true });
            renameSync(oldConfig, newConfig);
            log(`Übernommen: ${tildify(oldConfig)} → ${tildify(newConfig)}`);
        }
    } catch (error) {
        warn(`Konnte ${oldConfig} nicht übernehmen: ${errorMessage(error)}`);
    }
}

/**
 * Copy the stored session to the new keyring / pass entry, so no new login is
 * needed. The old entry is left in place (a still running old agent keeps working).
 */
async function migrateSession(store: Settings['credentialsStore']): Promise<void> {
    try {
        if (store === 'pass') {
            const has = (entry: string) => Bun.spawnSync(['pass', 'show', entry], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
            if (!has(`${NEW_NAME}/${SESSION_ENTRY}`) && has(`${OLD_NAME}/${SESSION_ENTRY}`)) {
                const old = Bun.spawnSync(['pass', 'show', `${OLD_NAME}/${SESSION_ENTRY}`]).stdout;
                Bun.spawnSync(['pass', 'insert', '-f', '-m', `${NEW_NAME}/${SESSION_ENTRY}`], { stdin: old });
            }
            return;
        }
        if (await Bun.secrets.get({ service: NEW_NAME, name: SESSION_ENTRY })) {
            return;
        }
        const old = await Bun.secrets.get({ service: OLD_NAME, name: SESSION_ENTRY });
        if (old) {
            await Bun.secrets.set({ service: NEW_NAME, name: SESSION_ENTRY, value: old });
        }
    } catch {
        // keyring locked/unavailable: the session check afterwards reports it
    }
}

async function openSession(settings: Settings, verbose: boolean): Promise<Session> {
    await migrateSession(settings.credentialsStore);
    process.env.PROTON_DRIVE_CREDENTIALS_STORE = settings.credentialsStore;
    process.env.PROTON_DRIVE_LOG_LEVEL ??= verbose ? 'DEBUG' : 'INFO';
    return init({
        appVersion: APP_VERSION_STRING,
        sdkVersion: SDK_VERSION_STRING,
        clientUidPrefix: 'pdrive-sync',
        enablePersistedEvents: false, // we track event IDs ourselves
        enableConsoleLog: verbose,
        enableMetrics: false,
    });
}

function requireLogin(session: Session): void {
    if (!session.auth.isLoggedIn()) {
        throw new AuthError('Nicht angemeldet. Bitte zuerst `pdrive-sync login` ausführen.');
    }
}

// --------------------------------------------------------------------------- //
// agent process helpers
// --------------------------------------------------------------------------- //

function pidFile(stateDir: string): string {
    return path.join(stateDir, 'agent.pid');
}

function runningAgentPid(stateDir: string): number | null {
    try {
        const pid = Number(readFileSync(pidFile(stateDir), 'utf8'));
        return pid && pid !== process.pid && isAlive(pid) ? pid : null;
    } catch {
        return null;
    }
}

/** (Re)start the systemd service after config changes, if it is installed. */
async function restartService(): Promise<void> {
    try {
        const enabled = Bun.spawnSync(['systemctl', '--user', 'is-enabled', SERVICE]).exitCode === 0;
        if (enabled) {
            Bun.spawnSync(['systemctl', '--user', 'restart', SERVICE]);
            log('Agent mit neuer Konfiguration neu gestartet.');
        }
    } catch {}
}

// --------------------------------------------------------------------------- //
// commands
// --------------------------------------------------------------------------- //

async function cmdLogin(configFile: string, settings: Settings, verbose: boolean): Promise<number> {
    log(THIRD_PARTY_NOTICE + '\n');
    const session = await openSession(settings, verbose);
    try {
        await session.auth.authViaWeb((url: string) => {
            openBrowserUrl(url);
            log('Bitte im Browser anmelden. Falls er sich nicht öffnet, diesen Link aufrufen (geht auch auf einem anderen Gerät):');
            log(url);
            log('\nWarte auf die Anmeldung …');
        });
        log('✓ Angemeldet.');
        if (path.resolve(configFile) === path.resolve(defaultConfigPath())) {
            await restartService();
        }
        return 0;
    } finally {
        await session.dispose();
    }
}

async function cmdLogout(settings: Settings, verbose: boolean): Promise<number> {
    const session = await openSession(settings, verbose);
    try {
        await session.auth.logout();
        await session.clearCaches();
        log('Abgemeldet, Sitzung gelöscht.');
        return 0;
    } finally {
        await session.dispose();
    }
}

function cmdFolder(file: string, settings: Settings, args: string[]): number {
    const [sub = 'list', ...rest] = args;
    if (sub === 'list') {
        if (!settings.folders.length) {
            log('Keine Ordner konfiguriert. Hinzufügen mit: pdrive-sync folder add NAME LOKAL REMOTE');
            return 0;
        }
        const st = stateDirOf(settings);
        for (const f of settings.folders) {
            const known = existsSync(stateFile(st, f.name))
                ? `${Object.keys((JSON.parse(readFileSync(stateFile(st, f.name), 'utf8')) as { files?: object }).files ?? {}).length} Dateien bekannt`
                : 'noch nie synchronisiert';
            const excl = f.exclude.length ? `  Ausnahmen: ${f.exclude.join(', ')}` : '';
            log(`${f.name.padEnd(16)} ${f.local} ⇄ Proton:${f.remote}   (${known})${excl}`);
        }
        return 0;
    }
    if (sub === 'add') {
        const { opts, positional } = takeOptions(rest, { '-e|--exclude': 'multi' });
        const [name, local, remote] = positional;
        if (!name || !local || !remote || positional.length > 3) {
            throw new UsageError('Verwendung: pdrive-sync folder add NAME LOKAL REMOTE [--exclude MUSTER]…');
        }
        if (settings.folders.some((f) => f.name === name)) {
            throw new UsageError(`Es gibt bereits einen Ordner „${name}“.`);
        }
        const abs = path.resolve(expandHome(local));
        const folder: FolderConfig = { name, local: tildify(abs), remote: rjoin(remote), exclude: (opts.exclude as string[]) ?? [] };
        const folders = [...settings.folders, folder];
        const err = validateFolders(folders);
        if (err) {
            throw new UsageError(err);
        }
        saveSettings(file, { ...settings, folders });
        log(`Ordner „${name}“ hinzugefügt: ${folder.local} ⇄ Proton:${folder.remote}`);
        if (folder.remote === '/') {
            log('Hinweis: Das ganze Proton Drive wird synchronisiert – der erste Abgleich kann dauern.');
        }
        return 0;
    }
    if (sub === 'remove' || sub === 'rm') {
        const [name] = rest;
        if (!name || !settings.folders.some((f) => f.name === name)) {
            throw new UsageError(`Unbekannter Ordner: ${name ?? '(fehlt)'}`);
        }
        saveSettings(file, { ...settings, folders: settings.folders.filter((f) => f.name !== name) });
        log(`Ordner „${name}“ entfernt. Lokale Dateien und Proton Drive bleiben unverändert.`);
        log(`Gespeicherten Stand ebenfalls löschen: pdrive-sync reset ${name}`);
        return 0;
    }
    throw new UsageError(`Unbekannter Unterbefehl: folder ${sub}`);
}

function cmdConfig(file: string, settings: Settings, args: string[]): number {
    const [sub = 'show', key, ...values] = args;
    if (sub === 'path') {
        log(file);
        return 0;
    }
    if (sub === 'show') {
        log(`Konfiguration: ${file}${isManaged(file) ? '  (von Home Manager verwaltet)' : existsSync(file) ? '' : '  (noch nicht angelegt)'}`);
        log(`  debounce          ${settings.debounce} s`);
        log(`  fullScanHours     ${settings.fullScanHours} h`);
        log(`  maxDeletes        ${settings.maxDeletes}`);
        log(`  exclude           ${settings.exclude.join(', ') || '–'}`);
        log(`  credentialsStore  ${settings.credentialsStore}`);
        log(`  Ordner            ${settings.folders.length ? settings.folders.map((f) => f.name).join(', ') : '–'}`);
        log(`  Stand / Log       ${tildify(stateDirOf(settings))}`);
        log(`  lokaler Papierkorb ${tildify(trashDirOf(settings))}`);
        return 0;
    }
    if (sub === 'set') {
        if (!key || !SETTABLE[key] || !values.length) {
            const list = Object.entries(SETTABLE).map(([k, v]) => `  ${k.padEnd(17)} ${v.help}`).join('\n');
            throw new UsageError(`Verwendung: pdrive-sync config set SCHLÜSSEL WERT\n${list}`);
        }
        let value: unknown;
        try {
            value = SETTABLE[key]!.parse(values.join(' '));
        } catch (error) {
            throw new UsageError(`${key}: ${errorMessage(error)}`);
        }
        saveSettings(file, { ...settings, [key]: value });
        log(`${key} = ${Array.isArray(value) ? value.join(', ') : String(value)}`);
        return 0;
    }
    throw new UsageError(`Unbekannter Unterbefehl: config ${sub}`);
}

async function cmdStatus(settings: Settings, verbose: boolean): Promise<number> {
    const stateDir = stateDirOf(settings);
    const status = readStatus(stateDir);
    const pid = runningAgentPid(stateDir);
    const stateText: Record<string, string> = {
        idle: 'alles synchronisiert',
        syncing: `synchronisiert gerade ${status?.folder ?? ''}`,
        error: `Fehler – ${status?.message ?? ''}`,
        auth: 'nicht angemeldet',
        starting: 'startet',
        stopped: 'gestoppt',
    };
    log(`Version     ${VERSION}`);
    log(pid ? `Agent       läuft (PID ${pid}) – ${stateText[status?.state ?? 'idle']}` : 'Agent       läuft nicht');

    let login = '?';
    try {
        const session = await openSession(settings, verbose);
        login = session.auth.isLoggedIn() ? 'angemeldet' : 'nicht angemeldet – `pdrive-sync login`';
        await session.dispose();
    } catch (error) {
        login = `Sitzung nicht lesbar (${errorMessage(error)})`;
    }
    log(`Anmeldung   ${login}`);

    if (!settings.folders.length) {
        log('Ordner      keine – hinzufügen mit `pdrive-sync folder add NAME LOKAL REMOTE`');
        return 0;
    }
    log('Ordner');
    for (const f of settings.folders) {
        const s = status?.folders[f.name];
        let text = 'noch nie synchronisiert';
        if (s?.state === 'syncing' && pid) {
            text = 'wird synchronisiert …';
        } else if (s?.state === 'error' || s?.state === 'auth') {
            text = `✗ ${s.message ?? 'Fehler'} (${ago(s.lastSync)})`;
        } else if (s?.lastSync) {
            const st = s.stats ?? {};
            const counts = [
                st.up ? `↑${st.up}` : '',
                st.down ? `↓${st.down}` : '',
                st.del_local || st.del_remote ? `✕${(st.del_local ?? 0) + (st.del_remote ?? 0)}` : '',
                st.conflict ? `Konflikte ${st.conflict}` : '',
            ].filter(Boolean).join(' ');
            text = `✓ ${ago(s.lastSync)}${counts ? `  (${counts})` : ''}`;
        }
        log(`  ${f.name.padEnd(16)} ${f.local} ⇄ Proton:${f.remote}`);
        log(`  ${''.padEnd(16)} ${text}`);
    }
    return 0;
}

const ACTION_TEXT: Record<ActivityEvent['action'], string> = {
    up: '↑ hochgeladen    ',
    down: '↓ heruntergeladen',
    del_local: '✕ lokal gelöscht ',
    del_remote: '✕ remote gelöscht',
    conflict: '! Konflikt       ',
    error: '✗ Fehler         ',
};

function formatEvent(e: ActivityEvent): string {
    const t = new Date(e.time);
    const p = (n: number) => String(n).padStart(2, '0');
    const when = `${p(t.getDate())}.${p(t.getMonth() + 1)}. ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
    return `${when}  ${ACTION_TEXT[e.action] ?? e.action}  ${e.folder}/${e.path}${e.message ? `  – ${e.message}` : ''}`;
}

async function cmdLog(settings: Settings, args: string[]): Promise<number> {
    const { opts } = takeOptions(args, { '-n|--lines': 'value', '-f|--follow': 'bool' });
    const n = Number(opts.lines ?? 30);
    const stateDir = stateDirOf(settings);
    const events = readActivity(stateDir, n);
    if (!events.length && !opts.follow) {
        log('Noch keine Änderungen.');
    }
    for (const e of events) {
        log(formatEvent(e));
    }
    if (!opts.follow) {
        return 0;
    }
    const file = path.join(stateDir, 'activity.jsonl');
    let size = existsSync(file) ? statSync(file).size : 0;
    for (;;) {
        await sleep(1000);
        const now = existsSync(file) ? statSync(file).size : 0;
        if (now < size) {
            size = 0; // trimmed
        }
        if (now > size) {
            const fd = Bun.file(file).slice(size, now);
            for (const line of (await fd.text()).split('\n').filter(Boolean)) {
                try {
                    log(formatEvent(JSON.parse(line) as ActivityEvent));
                } catch {}
            }
            size = now;
        }
    }
}

function cmdReset(settings: Settings, args: string[]): number {
    const [name] = args;
    if (!name) {
        throw new UsageError('Verwendung: pdrive-sync reset NAME');
    }
    const file = stateFile(stateDirOf(settings), name);
    if (existsSync(file)) {
        unlinkSync(file);
    }
    log(`Stand für „${name}“ gelöscht – der nächste Abgleich vergleicht neu (per Prüfsumme, ohne zu löschen).`);
    return 0;
}

function selectFolders(settings: Settings, names: string[] | undefined): FolderConfig[] {
    if (!names?.length) {
        return settings.folders;
    }
    const unknown = names.filter((n) => !settings.folders.some((f) => f.name === n));
    if (unknown.length) {
        throw new UsageError(`Unbekannte Ordner: ${unknown.join(', ')}`);
    }
    return settings.folders.filter((f) => names.includes(f.name));
}

async function cmdSync(settings: Settings, args: string[], verbose: boolean): Promise<number> {
    const { opts } = takeOptions(args, { '-n|--dry-run': 'bool', '--force': 'bool', '--folder': 'multi' });
    const folders = selectFolders(settings, opts.folder as string[] | undefined);
    if (!folders.length) {
        log('Keine Ordner konfiguriert – `pdrive-sync folder add NAME LOKAL REMOTE`.');
        return 1;
    }
    const stateDir = stateDirOf(settings);
    const agent = runningAgentPid(stateDir);
    if (agent && !opts['dry-run']) {
        process.kill(agent, 'SIGUSR1');
        log(`Der Agent läuft (PID ${agent}) – vollständiger Abgleich angestoßen. Verfolgen mit: pdrive-sync log -f`);
        return 0;
    }
    const session = await openSession(settings, verbose);
    try {
        requireLogin(session);
        const dryRun = !!opts['dry-run'];
        await catchUpEvents(session.sdk, stateDir, session.clearCaches);
        const remote = new Remote(session.sdk, session.logger, dryRun);
        const activity = dryRun ? undefined : new Activity(stateDir);
        let ok = true;
        for (const f of folders) {
            const syncer = new Syncer(f, remote, {
                maxDeletes: settings.maxDeletes,
                force: !!opts.force,
                dryRun,
                fullScan: true,
                dirtyRemote: new Set(),
                globalExclude: settings.exclude,
                trashDir: trashDirOf(settings),
                stateDir,
                activity,
                shouldStop: () => false,
            });
            ok = (await runOne(syncer, { activity }, f)) && ok;
        }
        activity?.settle();
        activity?.set('stopped');
        return ok ? 0 : 1;
    } finally {
        await session.dispose();
    }
}

async function cmdWatch(settings: Settings, verbose: boolean): Promise<number> {
    const stateDir = stateDirOf(settings);
    if (!settings.folders.length) {
        log('Keine Ordner konfiguriert – Agent beendet. Hinzufügen mit: pdrive-sync folder add NAME LOKAL REMOTE');
        return 0;
    }
    const other = runningAgentPid(stateDir);
    if (other) {
        log(`Der Agent läuft bereits (PID ${other}) – beende.`);
        return 0;
    }
    const session = await openSession(settings, verbose);
    requireLogin(session);
    writeFileSync(pidFile(stateDir), String(process.pid));
    try {
        return await runAgent(
            {
                sdk: session.sdk,
                clearCaches: session.clearCaches,
                remote: new Remote(session.sdk, session.logger, false),
                settings,
                stateDir,
                trashDir: trashDirOf(settings),
                activity: new Activity(stateDir),
            },
            settings.folders,
        );
    } finally {
        try {
            unlinkSync(pidFile(stateDir));
        } catch {}
        await session.dispose();
    }
}

// --------------------------------------------------------------------------- //
// main
// --------------------------------------------------------------------------- //

async function main(argv: string[]): Promise<number> {
    migrateDirectories();
    const args = parseArgs(argv);
    const settings = loadSettings(args.config);
    const changesConfig = (args.cmd === 'folder' && ['add', 'remove', 'rm'].includes(args.rest[0] ?? '')) || (args.cmd === 'config' && args.rest[0] === 'set');

    let code: number;
    switch (args.cmd) {
        case 'help':
            log(HELP);
            return 0;
        case 'version':
            log(`pdrive-sync ${VERSION} (${APP_VERSION_STRING}, SDK ${SDK_VERSION_STRING ?? '?'})`);
            return 0;
        case 'login':
            return cmdLogin(args.config, settings, args.verbose);
        case 'logout':
            return cmdLogout(settings, args.verbose);
        case 'folder':
        case 'folders':
            code = cmdFolder(args.config, settings, args.rest);
            break;
        case 'config':
            code = cmdConfig(args.config, settings, args.rest);
            break;
        case 'status':
            return cmdStatus(settings, args.verbose);
        case 'log':
            return cmdLog(settings, args.rest);
        case 'reset':
            return cmdReset(settings, args.rest);
        case 'sync':
        case 'run':
            return cmdSync(settings, args.rest, args.verbose);
        case 'watch':
            return cmdWatch(settings, args.verbose);
        default:
            throw new UsageError(`Unbekannter Befehl: ${args.cmd}\n\n${HELP}`);
    }
    // only the default config belongs to the systemd service
    if (changesConfig && code === 0 && path.resolve(args.config) === path.resolve(defaultConfigPath())) {
        await restartService();
    }
    return code;
}

try {
    process.exit(await main(process.argv.slice(2)));
} catch (error) {
    if (error instanceof UsageError) {
        console.error(error.message);
        process.exit(2);
    }
    if (error instanceof AuthError) {
        console.error(error.message);
        process.exit(3);
    }
    console.error(`Fehler: ${errorMessage(error)}`);
    if (process.argv.includes('-v') || process.argv.includes('--verbose')) {
        console.error(error);
    }
    process.exit(1);
}
