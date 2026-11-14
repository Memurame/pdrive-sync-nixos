import { homedir } from 'node:os';
import path from 'node:path';

declare const APP_VERSION: string | undefined;
declare const SDK_VERSION: string | undefined;

/** e.g. "external-drive-proton_drive_sync@0.6.0-beta" (set by the build) */
export const APP_VERSION_STRING: string = typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'external-drive-proton_drive_sync@0.0.0-dev';
export const SDK_VERSION_STRING: string | undefined = typeof SDK_VERSION !== 'undefined' ? SDK_VERSION : undefined;
/** Plain version number, e.g. "0.6.0-beta". */
export const VERSION = APP_VERSION_STRING.split('@')[1] ?? 'dev';

export const THIRD_PARTY_NOTICE =
    'Dies ist ein Drittanbieter-Programm, das nicht offiziell von Proton unterstützt wird.\n' +
    'This is a third-party application not officially supported by Proton.';

export function log(message: string): void {
    console.log(message);
}

export function warn(message: string): void {
    console.error(`WARN: ${message}`);
}

export function xdg(variable: string, fallback: string): string {
    return process.env[variable] || path.join(homedir(), fallback);
}

export function expandHome(p: string): string {
    if (p === '~') {
        return homedir();
    }
    if (p.startsWith('~/')) {
        return path.join(homedir(), p.slice(2));
    }
    return p;
}

/** Shortens /home/<user>/x to ~/x for display. */
export function tildify(p: string): string {
    const home = homedir();
    return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/** Join remote path parts into a normalized absolute POSIX path ("/a/b"). */
export function rjoin(...parts: string[]): string {
    const segments: string[] = [];
    for (const part of parts) {
        for (const s of (part || '').split('/')) {
            if (s && s !== '.') {
                segments.push(s);
            }
        }
    }
    return '/' + segments.join('/');
}

/** Parent of a relative path ("a/b/c" -> "a/b", "c" -> ""). */
export function parentRel(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i < 0 ? '' : rel.slice(0, i);
}

export function baseName(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i < 0 ? rel : rel.slice(i + 1);
}

export function joinRel(dir: string, name: string): string {
    return dir ? `${dir}/${name}` : name;
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ago(ts?: number | null): string {
    if (!ts) {
        return 'noch nie';
    }
    const d = (Date.now() - ts) / 1000;
    if (d < 60) {
        return 'gerade eben';
    }
    if (d < 3600) {
        return `vor ${Math.floor(d / 60)} Min.`;
    }
    if (d < 86400) {
        return `vor ${Math.floor(d / 3600)} Std.`;
    }
    return new Date(ts).toLocaleString('de-CH');
}

export function timestamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
