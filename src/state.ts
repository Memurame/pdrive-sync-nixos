import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { VERSION } from './util';

export const STATE_VERSION = 2;

/** Local file as seen after the last sync. */
export interface LocalSnap {
    size: number;
    mtime: number; // ms with sub-ms precision
}

/** Remote node as seen after the last sync / scan. */
export interface RemoteEntry {
    uid: string;
    dir: boolean;
    rev?: string; // active revision UID (files)
    sha1?: string;
    size?: number;
}

export interface FileState {
    local: LocalSnap;
    /** Remote revision both sides agreed on; null = uploaded, revision not known yet. */
    rev: string | null;
}

export interface FolderState {
    version: number;
    rootUid?: string;
    scopeId?: string;
    lastFullScan?: number;
    files: Record<string, FileState>;
    dirs: string[];
    /** Remote tree (rel path -> entry), kept current through events. */
    remote: Record<string, RemoteEntry>;
}

function atomicWrite(file: string, data: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
}

export function loadFolderState(file: string): FolderState {
    const empty: FolderState = { version: STATE_VERSION, files: {}, dirs: [], remote: {} };
    if (!existsSync(file)) {
        return empty;
    }
    try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as FolderState;
        if (data.version !== STATE_VERSION) {
            // v1 (Python version) had no remote tree – start fresh, the first
            // run compares contents via SHA-1 without re-transferring.
            return empty;
        }
        return { ...empty, ...data };
    } catch {
        return empty;
    }
}

export function saveFolderState(file: string, state: FolderState): void {
    atomicWrite(file, JSON.stringify(state));
}

// --------------------------------------------------------------------------- //
// event IDs per tree scope
// --------------------------------------------------------------------------- //

export function loadEventIds(stateDir: string): Record<string, string> {
    try {
        return JSON.parse(readFileSync(path.join(stateDir, 'events.json'), 'utf8')) as Record<string, string>;
    } catch {
        return {};
    }
}

export function saveEventIds(stateDir: string, ids: Record<string, string>): void {
    atomicWrite(path.join(stateDir, 'events.json'), JSON.stringify(ids));
}

// --------------------------------------------------------------------------- //
// status + activity log (read by `status` and `log`)
// --------------------------------------------------------------------------- //

export type AgentState = 'starting' | 'idle' | 'syncing' | 'error' | 'auth' | 'stopped';

export interface FolderStatus {
    state?: 'syncing' | 'ok' | 'error' | 'auth';
    local?: string;
    remote?: string;
    lastSync?: number;
    message?: string | null;
    stats?: Record<string, number>;
}

export interface StatusFile {
    version: string;
    pid: number;
    state: AgentState;
    message?: string | null;
    folder?: string | null;
    updated?: number;
    folders: Record<string, FolderStatus>;
}

export interface ActivityEvent {
    time: number;
    folder: string;
    action: 'up' | 'down' | 'del_local' | 'del_remote' | 'conflict' | 'error';
    path: string;
    message?: string | null;
}

export class Activity {
    static readonly MAX_EVENTS = 500;
    readonly statusPath: string;
    readonly logPath: string;
    data: StatusFile;

    constructor(stateDir: string) {
        this.statusPath = path.join(stateDir, 'status.json');
        this.logPath = path.join(stateDir, 'activity.jsonl');
        let folders: Record<string, FolderStatus> = {};
        try {
            folders = (JSON.parse(readFileSync(this.statusPath, 'utf8')) as StatusFile).folders ?? {};
        } catch {}
        this.data = { version: VERSION, pid: process.pid, state: 'starting', folders };
        this.trim();
        this.save();
    }

    save(): void {
        this.data.updated = Date.now();
        try {
            atomicWrite(this.statusPath, JSON.stringify(this.data));
        } catch {}
    }

    set(state: AgentState, message: string | null = null, folder: string | null = null): void {
        Object.assign(this.data, { state, message, folder });
        this.save();
    }

    folder(name: string, update: FolderStatus): void {
        this.data.folders[name] = { ...this.data.folders[name], ...update };
        this.save();
    }

    /** Waiting state after a run: idle, or error if a folder's last run failed. */
    settle(): void {
        const bad = Object.entries(this.data.folders)
            .filter(([, f]) => f.state === 'error' || f.state === 'auth')
            .map(([n]) => n);
        this.set(bad.length ? 'error' : 'idle', bad.length ? `Fehler in: ${bad.join(', ')}` : null);
    }

    event(e: Omit<ActivityEvent, 'time'>): void {
        try {
            appendFileSync(this.logPath, JSON.stringify({ time: Date.now(), ...e }) + '\n');
        } catch {}
    }

    trim(): void {
        try {
            const lines = readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
            if (lines.length > Activity.MAX_EVENTS) {
                atomicWrite(this.logPath, lines.slice(-Activity.MAX_EVENTS).join('\n') + '\n');
            }
        } catch {}
    }
}

export function readStatus(stateDir: string): StatusFile | null {
    try {
        return JSON.parse(readFileSync(path.join(stateDir, 'status.json'), 'utf8')) as StatusFile;
    } catch {
        return null;
    }
}

export function readActivity(stateDir: string, limit: number): ActivityEvent[] {
    try {
        const lines = readFileSync(path.join(stateDir, 'activity.jsonl'), 'utf8').split('\n').filter(Boolean);
        return lines.slice(-limit).flatMap((l) => {
            try {
                return [JSON.parse(l) as ActivityEvent];
            } catch {
                return [];
            }
        });
    } catch {
        return [];
    }
}

export function isAlive(pid?: number): boolean {
    if (!pid) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
