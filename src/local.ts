import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { LocalSnap } from './state';
import { joinRel } from './util';

/** Always ignored: our temp files, editor swap/lock files, OS metadata. */
export const DEFAULT_EXCLUDES = [
    '.proton-sync-*',
    '*.part',
    '*.tmp',
    '*.swp',
    '*~',
    '.~lock.*#',
    '~$*',
    '.DS_Store',
    'Thumbs.db',
];

/** fnmatch-style glob ("*" may also match "/") compiled to a RegExp. */
function globToRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]!;
        if (c === '*') {
            re += '.*';
        } else if (c === '?') {
            re += '.';
        } else if (c === '[') {
            const end = glob.indexOf(']', i + 1);
            if (end < 0) {
                re += '\\[';
            } else {
                let cls = glob.slice(i + 1, end);
                if (cls.startsWith('!')) {
                    cls = '^' + cls.slice(1);
                }
                re += `[${cls.replace(/\\/g, '\\\\')}]`;
                i = end;
            }
        } else {
            re += c.replace(/[.+^${}()|\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`, 's');
}

export class Excluder {
    private readonly patterns: RegExp[];

    constructor(patterns: string[]) {
        this.patterns = patterns.map(globToRegExp);
    }

    /** Matches the base name or the whole relative path. */
    matches(rel: string): boolean {
        const name = rel.slice(rel.lastIndexOf('/') + 1);
        return this.patterns.some((p) => p.test(name) || p.test(rel));
    }
}

export interface LocalTree {
    files: Map<string, LocalSnap>;
    dirs: Set<string>;
}

export async function snapshot(file: string): Promise<LocalSnap> {
    const st = await lstat(file);
    return { size: st.size, mtime: st.mtimeMs };
}

export function sameSnap(a: LocalSnap, b: LocalSnap): boolean {
    return a.size === b.size && Math.abs(a.mtime - b.mtime) < 0.001;
}

export async function scanLocal(root: string, excluder: Excluder): Promise<LocalTree> {
    const files = new Map<string, LocalSnap>();
    const dirs = new Set<string>();
    const walk = async (dir: string, relDir: string): Promise<void> => {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const rel = joinRel(relDir, e.name);
            if (e.isSymbolicLink() || excluder.matches(rel)) {
                continue;
            }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                dirs.add(rel);
                await walk(full, rel);
            } else if (e.isFile()) {
                try {
                    files.set(rel, await snapshot(full));
                } catch {}
            }
        }
    };
    await walk(root, '');
    return { files, dirs };
}

export async function sha1File(file: string): Promise<string> {
    const hash = createHash('sha1');
    for await (const chunk of createReadStream(file)) {
        hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
}
