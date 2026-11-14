import { existsSync } from 'node:fs';
import { mkdir, rename, rmdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import { DEFAULT_EXCLUDES, Excluder, type LocalTree, sameSnap, scanLocal, sha1File, snapshot } from './local';
import { Remote, removeSubtree } from './remote';
import type { FolderConfig } from './settings';
import {
    Activity,
    type ActivityEvent,
    type FileState,
    type FolderState,
    loadFolderState,
    type RemoteEntry,
    saveFolderState,
} from './state';
import { baseName, errorMessage, expandHome, joinRel, log, parentRel, timestamp, warn } from './util';

const CHECKPOINT_MS = 20_000;

export interface SyncOptions {
    maxDeletes: number;
    force: boolean;
    dryRun: boolean;
    /** true: list the whole remote tree; otherwise only `dirtyRemote` folders. */
    fullScan: boolean;
    dirtyRemote: Set<string>;
    globalExclude: string[];
    trashDir: string;
    stateDir: string;
    activity?: Activity;
    shouldStop: () => boolean;
}

type Action = 'noop' | 'up' | 'down' | 'del_local' | 'del_remote' | 'first_both' | 'conflict' | 'forget';

export class AuthError extends Error {}
export class StopRequested extends Error {}

export function conflictName(rel: string): string {
    const dir = parentRel(rel);
    const name = baseName(rel);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return joinRel(dir, `${stem} (Konflikt ${hostname()} ${timestamp()})${ext}`);
}

export function stateFile(stateDir: string, name: string): string {
    return path.join(stateDir, `${name}.json`);
}

export class Syncer {
    readonly local: string;
    readonly excluder: Excluder;
    readonly stats = { up: 0, down: 0, del_local: 0, del_remote: 0, conflict: 0, error: 0 };
    state: FolderState;
    private remoteTree: Record<string, RemoteEntry> = {};
    private newFiles: Record<string, FileState> = {};

    constructor(
        readonly folder: FolderConfig,
        private readonly remote: Remote,
        private readonly opts: SyncOptions,
    ) {
        this.local = path.resolve(expandHome(folder.local));
        this.excluder = new Excluder([...DEFAULT_EXCLUDES, ...opts.globalExclude, ...folder.exclude]);
        this.state = loadFolderState(stateFile(opts.stateDir, folder.name));
    }

    private lpath(rel: string): string {
        return path.join(this.local, rel);
    }

    private report(action: ActivityEvent['action'], rel: string, message: string | null = null): void {
        if (!this.opts.dryRun) {
            this.opts.activity?.event({ folder: this.folder.name, action, path: rel, message });
        }
    }

    private save(): void {
        if (!this.opts.dryRun) {
            saveFolderState(stateFile(this.opts.stateDir, this.folder.name), this.state);
        }
    }

    /** Cheap local check (no network): has anything changed since the last sync? */
    async localDirty(): Promise<boolean> {
        const tree = await scanLocal(this.local, this.excluder);
        const known = Object.keys(this.state.files);
        if (known.length !== tree.files.size) {
            return true;
        }
        for (const rel of known) {
            const now = tree.files.get(rel);
            if (!now || !sameSnap(now, this.state.files[rel]!.local)) {
                return true;
            }
        }
        const dirs = new Set(this.state.dirs);
        return dirs.size !== tree.dirs.size || [...tree.dirs].some((d) => !dirs.has(d));
    }

    // ----------------------------------------------------------------------- //
    // main run
    // ----------------------------------------------------------------------- //

    async run(): Promise<boolean> {
        const f = this.folder;
        log(`== ${f.name}: ${this.local} ⇄ Proton:${f.remote}${this.opts.fullScan ? '' : ' (Änderungen)'}`);

        if (!existsSync(this.local)) {
            if (Object.keys(this.state.files).length) {
                warn(`${this.local} fehlt, obwohl schon synchronisiert wurde – übersprungen (Laufwerk nicht eingehängt?)`);
                return false;
            }
            log(`  lokalen Ordner ${this.local} angelegt`);
            if (!this.opts.dryRun) {
                await mkdir(this.local, { recursive: true });
            }
        }

        // --- remote root ---
        if (!this.state.rootUid || this.opts.fullScan) {
            const resolved = await this.remote.resolveFolder(f.remote, false);
            if (!resolved) {
                if (Object.keys(this.state.files).length) {
                    warn(`Proton:${f.remote} fehlt, obwohl schon synchronisiert wurde – übersprungen`);
                    return false;
                }
                log(`  Proton:${f.remote} angelegt`);
                const created = await this.remote.resolveFolder(f.remote, !this.opts.dryRun);
                if (!created) {
                    return true; // dry run: nothing more to show
                }
                Object.assign(this.state, { rootUid: created.uid, scopeId: created.scopeId });
            } else {
                if (this.state.rootUid && this.state.rootUid !== resolved.uid) {
                    this.state.remote = {}; // folder was replaced – forget remote knowledge
                }
                Object.assign(this.state, { rootUid: resolved.uid, scopeId: resolved.scopeId });
            }
        }
        const rootUid = this.state.rootUid!;
        const isExcluded = (rel: string) => this.excluder.matches(rel);

        // --- remote tree: full scan, or update only the folders events reported ---
        if (this.opts.fullScan || !Object.keys(this.state.remote).length) {
            this.remoteTree = await this.remote.scanTree(rootUid, isExcluded);
            this.state.lastFullScan = Date.now();
        } else {
            this.remoteTree = await this.remote.rescan(this.state.remote, rootUid, this.opts.dirtyRemote, isExcluded);
        }

        const local = await scanLocal(this.local, this.excluder);
        const plan = this.plan(local);

        const deletes = plan.filter(([a]) => a === 'del_local' || a === 'del_remote').length;
        if (deletes > this.opts.maxDeletes && !this.opts.force) {
            warn(
                `${f.name}: ${deletes} Löschungen geplant (Limit ${this.opts.maxDeletes}). Abbruch zum Schutz – ` +
                    'prüfe mit `pdrive-sync sync --dry-run` und starte ggf. mit --force.',
            );
            return false;
        }

        const old = this.state.files;
        this.newFiles = {};
        let ok = true;
        let lastSave = Date.now();
        const checkpoint = (next: number) => {
            const files = { ...this.newFiles };
            for (const [, rest] of plan.slice(next)) {
                if (old[rest] && !files[rest]) {
                    files[rest] = old[rest]!;
                }
            }
            this.state.files = files;
            this.state.remote = this.remoteTree;
            this.save();
        };

        for (let i = 0; i < plan.length; i++) {
            const [action, rel] = plan[i]!;
            if (this.opts.shouldStop()) {
                checkpoint(i);
                throw new StopRequested();
            }
            try {
                const kept = await this.apply(action, rel, local);
                if (kept) {
                    this.newFiles[rel] = kept;
                }
            } catch (error) {
                if (isAuthError(error)) {
                    checkpoint(i);
                    throw new AuthError(errorMessage(error));
                }
                warn(`${rel}: ${errorMessage(error)}`);
                this.stats.error++;
                this.report('error', rel, errorMessage(error));
                ok = false;
                if (old[rel]) {
                    this.newFiles[rel] = old[rel]!; // retry next run
                }
            }
            if (action !== 'noop' && Date.now() - lastSave > CHECKPOINT_MS) {
                checkpoint(i + 1);
                lastSave = Date.now();
            }
        }

        const dirs = await this.syncDirs(local);
        if (!this.opts.dryRun) {
            this.state.files = this.newFiles;
            this.state.dirs = [...dirs].sort();
            this.state.remote = this.remoteTree;
            this.save();
        }
        const s = this.stats;
        log(
            `   fertig: ↑${s.up} ↓${s.down}  gelöscht lokal ${s.del_local} / remote ${s.del_remote}  ` +
                `Konflikte ${s.conflict}  Fehler ${s.error}`,
        );
        return ok;
    }

    // ----------------------------------------------------------------------- //
    // planning
    // ----------------------------------------------------------------------- //

    private plan(local: LocalTree): [Action, string][] {
        const remoteFiles = new Map<string, RemoteEntry>();
        const remoteDirs = new Set<string>();
        for (const [rel, e] of Object.entries(this.remoteTree)) {
            if (e.dir) {
                remoteDirs.add(rel);
            } else {
                remoteFiles.set(rel, e);
            }
        }
        const old = this.state.files;
        const all = new Set([...local.files.keys(), ...remoteFiles.keys(), ...Object.keys(old)]);
        const plan: [Action, string][] = [];
        for (const rel of [...all].sort()) {
            const l = local.files.get(rel);
            const r = remoteFiles.get(rel);
            const s = old[rel];
            if ((l && remoteDirs.has(rel)) || (r && local.dirs.has(rel))) {
                warn(`${rel}: Datei auf der einen, Ordner auf der anderen Seite – übersprungen`);
                continue;
            }
            const lChanged = !!l && (!s || !sameSnap(l, s.local));
            // rev null = uploaded but revision never learned (interrupted run): trust it
            const rChanged = !!r && (!s || (s.rev !== null && r.rev !== s.rev));
            if (l && r) {
                plan.push([!s ? 'first_both' : lChanged && rChanged ? 'conflict' : lChanged ? 'up' : rChanged ? 'down' : 'noop', rel]);
            } else if (l) {
                plan.push([!s || lChanged ? 'up' : 'del_local', rel]);
            } else if (r) {
                plan.push([!s || rChanged ? 'down' : 'del_remote', rel]);
            } else {
                plan.push(['forget', rel]);
            }
        }
        return plan;
    }

    // ----------------------------------------------------------------------- //
    // actions
    // ----------------------------------------------------------------------- //

    private async apply(action: Action, rel: string, local: LocalTree): Promise<FileState | null> {
        const dry = this.opts.dryRun;
        const r = this.remoteTree[rel];
        switch (action) {
            case 'noop':
                return { local: this.state.files[rel]!.local, rev: r?.rev ?? null };
            case 'forget':
                return null;
            case 'up': {
                // a remote change we have not seen yet (event still pending)? then it's a conflict
                if (r && this.state.files[rel] && !dry) {
                    const current = await this.remote.currentRevision(r.uid);
                    if (current && current !== r.rev) {
                        this.remoteTree[rel] = { ...r, rev: current, sha1: undefined };
                        return this.apply('conflict', rel, local);
                    }
                }
                await this.upload(rel);
                return dry ? null : { local: await snapshot(this.lpath(rel)), rev: this.remoteTree[rel]?.rev ?? null };
            }
            case 'down':
                await this.download(rel);
                return dry ? null : { local: await snapshot(this.lpath(rel)), rev: r!.rev ?? null };
            case 'del_local':
                await this.trashLocal(rel);
                return null;
            case 'del_remote':
                await this.trashRemote(rel);
                return null;
            case 'first_both': {
                const l = local.files.get(rel)!;
                if (l.size === r!.size && (dry || (await this.sameContent(rel)))) {
                    log(`  identisch     ${rel}`);
                    return dry ? null : { local: l, rev: r!.rev ?? null };
                }
                return this.apply('conflict', rel, local);
            }
            case 'conflict': {
                // keep both: the local version is renamed and uploaded, the remote one keeps the name
                const cname = conflictName(rel);
                log(`  KONFLIKT      ${rel}  → lokale Version als ${baseName(cname)}`);
                this.stats.conflict++;
                this.report('conflict', rel, `lokale Version gespeichert als ${baseName(cname)}`);
                if (!dry) {
                    await rename(this.lpath(rel), this.lpath(cname));
                }
                await this.download(rel);
                await this.upload(cname);
                if (dry) {
                    return null;
                }
                this.newFiles[cname] = { local: await snapshot(this.lpath(cname)), rev: this.remoteTree[cname]?.rev ?? null };
                return { local: await snapshot(this.lpath(rel)), rev: this.remoteTree[rel]!.rev ?? null };
            }
        }
    }

    /** SHA-1 of the local file against the remote claimed SHA-1 (download only if unknown). */
    private async sameContent(rel: string): Promise<boolean> {
        const r = this.remoteTree[rel]!;
        const localSha1 = await sha1File(this.lpath(rel));
        if (r.sha1) {
            return localSha1 === r.sha1;
        }
        const tmp = path.join(path.dirname(this.lpath(rel)), `.pdrive-sync-cmp-${process.pid}`);
        try {
            await this.remote.download(r.rev!, tmp);
            return (await sha1File(tmp)) === localSha1;
        } finally {
            await Bun.file(tmp).delete().catch(() => {});
        }
    }

    private async ensureRemoteDir(relDir: string): Promise<string> {
        if (relDir === '') {
            return this.state.rootUid!;
        }
        const known = this.remoteTree[relDir];
        if (known?.dir) {
            return known.uid;
        }
        const parentUid = await this.ensureRemoteDir(parentRel(relDir));
        log(`  mkdir remote  ${relDir}/`);
        const uid = await this.remote.mkdir(parentUid, baseName(relDir));
        this.remoteTree[relDir] = { uid, dir: true };
        this.report('mkdir_remote', `${relDir}/`);
        return uid;
    }

    private async upload(rel: string): Promise<void> {
        const parentUid = await this.ensureRemoteDir(parentRel(rel));
        log(`  upload  ↑     ${rel}`);
        this.stats.up++;
        if (this.opts.dryRun) {
            return;
        }
        const existing = this.remoteTree[rel];
        const res = await this.remote.upload(this.lpath(rel), parentUid, baseName(rel), existing && !existing.dir ? existing.uid : undefined);
        this.remoteTree[rel] = { uid: res.uid, dir: false, rev: res.rev, sha1: res.sha1, size: res.size };
        this.report('up', rel);
    }

    private async download(rel: string): Promise<void> {
        const r = this.remoteTree[rel]!;
        log(`  download ↓    ${rel}`);
        this.stats.down++;
        if (this.opts.dryRun) {
            return;
        }
        await this.remote.download(r.rev!, this.lpath(rel), r.sha1);
        this.report('down', rel);
    }

    private async trashLocal(rel: string): Promise<void> {
        const dest0 = path.join(this.opts.trashDir, this.folder.name, new Date().toISOString().slice(0, 10), rel);
        log(`  delete local  ${rel}  (→ lokaler Papierkorb)`);
        this.stats.del_local++;
        if (this.opts.dryRun) {
            return;
        }
        let dest = dest0;
        if (await Bun.file(dest).exists()) {
            dest = `${dest0}.${Date.now()}`;
        }
        await mkdir(path.dirname(dest), { recursive: true });
        await rename(this.lpath(rel), dest).catch(async (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EXDEV') {
                throw error;
            }
            // different filesystem: copy + delete
            await Bun.write(dest, Bun.file(this.lpath(rel)));
            await Bun.file(this.lpath(rel)).delete();
        });
        this.report('del_local', rel, `verschoben nach ${dest}`);
    }

    private async trashRemote(rel: string): Promise<void> {
        const r = this.remoteTree[rel]!;
        log(`  delete remote ${rel}  (→ Proton-Papierkorb)`);
        this.stats.del_remote++;
        if (this.opts.dryRun) {
            return;
        }
        await this.remote.trash(r.uid);
        removeSubtree(this.remoteTree, rel);
        this.report('del_remote', r.dir ? `${rel}/` : rel, 'im Proton-Papierkorb');
    }

    // ----------------------------------------------------------------------- //
    // directories
    // ----------------------------------------------------------------------- //

    private async syncDirs(local: LocalTree): Promise<Set<string>> {
        const oldDirs = new Set(this.state.dirs);
        const remoteDirs = new Set(Object.entries(this.remoteTree).filter(([, e]) => e.dir).map(([rel]) => rel));
        const result = new Set<string>();
        const all = [...new Set([...local.dirs, ...remoteDirs, ...oldDirs])].sort((a, b) => b.split('/').length - a.split('/').length);
        const hasContent = (rel: string) =>
            Object.keys(this.newFiles).some((f) => f.startsWith(rel + '/')) || [...result].some((d) => d.startsWith(rel + '/'));
        for (const rel of all) {
            const inL = local.dirs.has(rel);
            const inR = remoteDirs.has(rel);
            try {
                if (inL && inR) {
                    result.add(rel);
                } else if (inL) {
                    if (oldDirs.has(rel) && !hasContent(rel)) {
                        log(`  rmdir local   ${rel}/`);
                        if (!this.opts.dryRun) {
                            await rmdir(this.lpath(rel)).then(
                                () => this.report('del_local', `${rel}/`, 'in Proton gelöscht'),
                                () => this.trashLocal(rel), // still contains excluded files
                            );
                        }
                    } else {
                        await this.ensureRemoteDir(rel);
                        result.add(rel);
                    }
                } else if (inR) {
                    if (oldDirs.has(rel) && !hasContent(rel)) {
                        await this.trashRemote(rel);
                    } else {
                        log(`  mkdir local   ${rel}/`);
                        if (!this.opts.dryRun) {
                            await mkdir(this.lpath(rel), { recursive: true });
                            this.report('mkdir_local', `${rel}/`);
                        }
                        result.add(rel);
                    }
                }
            } catch (error) {
                if (isAuthError(error)) {
                    throw new AuthError(errorMessage(error));
                }
                warn(`${rel}/: ${errorMessage(error)}`);
                this.stats.error++;
            }
        }
        return result;
    }
}

/** Session missing/expired (the SDK/account layer reports HTTP 401 or "login" errors). */
export function isAuthError(error: unknown): boolean {
    if (error instanceof AuthError) {
        return true;
    }
    const e = error as { status?: number; statusCode?: number; code?: number; message?: string };
    const status = e?.status ?? e?.statusCode;
    return status === 401 || /need to log ?in|not logged in|login first|session (has )?expired|unauthori[sz]ed/i.test(e?.message ?? '');
}
