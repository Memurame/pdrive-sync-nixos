import path from 'node:path';

import { type DriveEvent, DriveEventType, type ProtonDriveClient } from '@protontech/drive-sdk';

import { DEFAULT_EXCLUDES, Excluder } from './local';
import { Remote } from './remote';
import type { FolderConfig, Settings } from './settings';
import { Activity, loadEventIds, loadFolderState, saveEventIds } from './state';
import { AuthError, StopRequested, stateFile, Syncer } from './syncer';
import { errorMessage, expandHome, log, parentRel, sleep, VERSION, warn } from './util';

export interface AgentContext {
    sdk: ProtonDriveClient;
    clearCaches: () => Promise<void>;
    remote: Remote;
    settings: Settings;
    stateDir: string;
    trashDir: string;
    activity: Activity;
}

/**
 * Bring the SDK's persistent node cache up to date before scanning: replay the
 * Drive events since the last stored event ID (the SDK updates its cache while
 * iterating them). Without a stored ID the cache may be stale, so it is cleared.
 * Returns the event scope of "My files".
 */
export async function catchUpEvents(
    sdk: ProtonDriveClient,
    stateDir: string,
    clearCaches: () => Promise<void>,
    onEvent?: (event: DriveEvent) => void,
): Promise<string> {
    const scope = (await sdk.getMyFilesRootFolder()).treeEventScopeId;
    const ids = loadEventIds(stateDir);
    if (!ids[scope]) {
        await clearCaches();
    }
    for await (const event of sdk.iterateEvents(scope, ids[scope])) {
        onEvent?.(event);
        ids[scope] = event.eventId;
    }
    saveEventIds(stateDir, ids);
    return scope;
}

interface Pending {
    /** time of the last local filesystem event */
    localAt?: number;
    /** remote folders (relative paths) reported changed by events */
    remoteDirs: Set<string>;
    full: boolean;
}

/**
 * Long-running agent:
 *  - local changes (inotify) are synced `debounce` seconds after the last event,
 *  - remote changes arrive as Drive events (the SDK scheduler polls the event
 *    stream, not the file tree) and only the affected folders are re-listed,
 *  - a full remote scan runs at start (if needed) and every `fullScanHours`.
 */
export async function runAgent(ctx: AgentContext, folders: FolderConfig[]): Promise<number> {
    const { settings, activity } = ctx;
    const debounceMs = settings.debounce * 1000;
    const fullScanMs = settings.fullScanHours * 3600 * 1000;
    let stopping = false;
    let authBackoffUntil = 0;
    let authBackoff = 60_000;

    const pending = new Map<string, Pending>(folders.map((f) => [f.name, { remoteDirs: new Set<string>(), full: false }]));
    const locals = new Map(folders.map((f) => [f.name, path.resolve(expandHome(f.local))]));
    const excluders = new Map(
        folders.map((f) => [f.name, new Excluder([...DEFAULT_EXCLUDES, ...settings.exclude, ...f.exclude])]),
    );

    // full scan at start when we have no remote picture or it is too old
    for (const f of folders) {
        const st = loadFolderState(stateFile(ctx.stateDir, f.name));
        const p = pending.get(f.name)!;
        p.full = !st.rootUid || !Object.keys(st.remote).length || !st.lastFullScan || Date.now() - st.lastFullScan > fullScanMs;
        p.localAt = 0; // compare local tree once at start
    }

    // --- signals -------------------------------------------------------------
    const stop = () => {
        stopping = true;
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.on('SIGUSR1', () => {
        for (const p of pending.values()) {
            p.full = true;
        }
    });

    // --- local watcher (inotifywait) ---------------------------------------
    const watcher = Bun.spawn(
        [
            'inotifywait', '-m', '-r', '-q', '--format', '%w%f',
            '-e', 'close_write', '-e', 'create', '-e', 'delete', '-e', 'moved_to', '-e', 'moved_from', '-e', 'delete_self',
            ...[...locals.values()],
        ],
        { stdout: 'pipe', stderr: 'inherit' },
    );
    (async () => {
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of watcher.stdout) {
            buf += decoder.decode(chunk, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const p = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                for (const [name, root] of locals) {
                    if (p === root || p.startsWith(root + '/')) {
                        const rel = p.slice(root.length + 1);
                        if (rel && !excluders.get(name)!.matches(rel)) {
                            pending.get(name)!.localAt = Date.now();
                        }
                    }
                }
            }
        }
    })().catch((error) => warn(`Dateiwächter: ${errorMessage(error)}`));

    // --- remote events ------------------------------------------------------
    let eventIds: Record<string, string> = {};
    const handleEvent = (event: DriveEvent) => {
        if (event.type === DriveEventType.TreeRefresh) {
            for (const f of folders) {
                pending.get(f.name)!.full = true;
            }
            return;
        }
        if (event.type !== DriveEventType.NodeCreated && event.type !== DriveEventType.NodeUpdated && event.type !== DriveEventType.NodeDeleted) {
            return;
        }
        const nodeUid = event.nodeUid;
        const parentUid = 'parentNodeUid' in event ? event.parentNodeUid : undefined;
        for (const f of folders) {
            const st = loadFolderState(stateFile(ctx.stateDir, f.name));
            const index = new Map<string, string>(); // uid -> rel ("" = root)
            if (st.rootUid) {
                index.set(st.rootUid, '');
            }
            for (const [rel, e] of Object.entries(st.remote)) {
                index.set(e.uid, rel);
            }
            const dirty = pending.get(f.name)!.remoteDirs;
            const known = index.get(nodeUid);
            if (known !== undefined && known !== '') {
                dirty.add(parentRel(known)); // node renamed/moved/changed/deleted
            }
            if (parentUid !== undefined && index.has(parentUid)) {
                const parentRelPath = index.get(parentUid)!;
                if (parentRelPath === '' || st.remote[parentRelPath]?.dir) {
                    dirty.add(parentRelPath); // something appeared/changed in a folder we sync
                }
            }
        }
    };

    const pollScope = async (scopeId: string) => {
        if (stopping) {
            return;
        }
        try {
            for await (const event of ctx.sdk.iterateEvents(scopeId, eventIds[scopeId])) {
                handleEvent(event);
                eventIds[scopeId] = event.eventId;
            }
            saveEventIds(ctx.stateDir, eventIds);
        } catch (error) {
            warn(`Events für ${scopeId}: ${errorMessage(error)}`);
        }
    };

    // replay what happened while we were not running (also refreshes the SDK cache)
    await catchUpEvents(ctx.sdk, ctx.stateDir, ctx.clearCaches, handleEvent);
    eventIds = loadEventIds(ctx.stateDir);

    const scheduler = await ctx.sdk.getEventScheduler(pollScope);
    const scopes = new Set<string>();
    const ensureScopes = () => {
        for (const f of folders) {
            const scope = loadFolderState(stateFile(ctx.stateDir, f.name)).scopeId;
            if (scope && !scopes.has(scope)) {
                scopes.add(scope);
                scheduler.addScope(scope);
            }
        }
    };

    log(
        `proton-drive-sync ${VERSION} – überwache ${folders.length} Ordner ` +
            `(Verzögerung ${settings.debounce}s, Remote über Drive-Events, voller Abgleich alle ${settings.fullScanHours} h)`,
    );
    activity.settle();

    // --- main loop ------------------------------------------------------------
    try {
        while (!stopping) {
            ensureScopes();
            const now = Date.now();
            for (const f of folders) {
                if (stopping) {
                    break;
                }
                const p = pending.get(f.name)!;
                const st = loadFolderState(stateFile(ctx.stateDir, f.name));
                if (st.lastFullScan && now - st.lastFullScan > fullScanMs) {
                    p.full = true;
                }
                const localDue = p.localAt !== undefined && now - p.localAt >= debounceMs;
                const remoteDue = p.remoteDirs.size > 0 || p.full;
                if (!localDue && !remoteDue) {
                    continue;
                }
                if (now < authBackoffUntil) {
                    continue;
                }

                const syncer = new Syncer(f, ctx.remote, {
                    maxDeletes: settings.maxDeletes,
                    force: false,
                    dryRun: false,
                    fullScan: p.full,
                    dirtyRemote: new Set(p.remoteDirs),
                    globalExclude: settings.exclude,
                    trashDir: ctx.trashDir,
                    stateDir: ctx.stateDir,
                    activity,
                    shouldStop: () => stopping,
                });
                if (localDue && !remoteDue && !(await syncer.localDirty())) {
                    p.localAt = undefined; // only our own writes
                    continue;
                }
                const taken = new Set(p.remoteDirs);
                const wasFull = p.full;
                p.localAt = undefined;
                p.full = false;
                for (const d of taken) {
                    p.remoteDirs.delete(d);
                }

                const ok = await runOne(syncer, ctx, f).catch((error) => {
                    // keep the work for the next round
                    p.full ||= wasFull;
                    for (const d of taken) {
                        p.remoteDirs.add(d);
                    }
                    throw error;
                }).catch((error) => {
                    if (error instanceof StopRequested) {
                        return true;
                    }
                    if (error instanceof AuthError) {
                        warn(`Nicht angemeldet / Sitzung abgelaufen – \`proton-drive-sync login\` ausführen. (${error.message})`);
                        activity.set('auth', 'Nicht angemeldet – `proton-drive-sync login` ausführen');
                        authBackoffUntil = Date.now() + authBackoff;
                        authBackoff = Math.min(authBackoff * 2, 3600_000);
                        return false;
                    }
                    warn(`${f.name}: ${errorMessage(error)}`);
                    return false;
                });
                if (ok) {
                    authBackoff = 60_000;
                }
                if (activity.data.state !== 'auth') {
                    activity.settle();
                }
                activity.trim();
            }
            await sleep(1000);
        }
    } finally {
        for (const scope of scopes) {
            scheduler.removeScope(scope);
        }
        saveEventIds(ctx.stateDir, eventIds);
        watcher.kill();
        activity.set('stopped');
        log('Agent beendet.');
    }
    return 0;
}

/** One sync run with status bookkeeping. */
export async function runOne(syncer: Syncer, ctx: { activity?: Activity }, f: FolderConfig): Promise<boolean> {
    const activity = ctx.activity;
    activity?.set('syncing', null, f.name);
    activity?.folder(f.name, { state: 'syncing', local: syncer.local, remote: f.remote });
    let ok = false;
    let message: string | null = null;
    try {
        ok = await syncer.run();
        if (!ok) {
            message = syncer.stats.error ? `${syncer.stats.error} Fehler – Details mit \`proton-drive-sync log\`` : 'übersprungen – siehe Log';
        }
        return ok;
    } catch (error) {
        message = errorMessage(error);
        if (error instanceof AuthError) {
            activity?.folder(f.name, { state: 'auth', message: 'Nicht angemeldet' });
        }
        throw error;
    } finally {
        if (activity && activity.data.folders[f.name]?.state !== 'auth') {
            activity.folder(f.name, { state: ok ? 'ok' : 'error', message, lastSync: Date.now(), stats: { ...syncer.stats } });
        }
    }
}
