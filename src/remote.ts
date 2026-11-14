import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
    type Logger,
    type NodeEntity,
    NodeWithSameNameExistsValidationError,
    type ProtonDriveClient,
} from '@protontech/drive-sdk';

import { generateThumbnails } from '../commands/fileSystem/generateThumbnails';
import { getLocalFileMediaType } from '../commands/fileSystem/mediaType';
import { sha1File } from './local';
import type { RemoteEntry } from './state';
import { baseName, joinRel, parentRel } from './util';

/** A child as returned by a folder listing. */
export interface RemoteChild extends RemoteEntry {
    name: string;
}

export interface UploadResult {
    uid: string;
    rev: string;
    sha1: string;
    size: number;
}

/** Proton Docs / Sheets only exist online and cannot be downloaded. */
function isOnlineOnly(node: NodeEntity): boolean {
    return (node.mediaType ?? '').startsWith('application/vnd.proton.');
}

export function toChild(node: NodeEntity): RemoteChild | null {
    const name = node.name.ok ? node.name.value : null;
    if (!name || node.trashTime || isOnlineOnly(node)) {
        return null;
    }
    if (node.type === 'folder') {
        return { name, uid: node.uid, dir: true };
    }
    if (node.type !== 'file' || !node.activeRevision) {
        return null; // drafts, albums, ...
    }
    const rev = node.activeRevision;
    return {
        name,
        uid: node.uid,
        dir: false,
        rev: rev.uid,
        sha1: rev.claimedDigests?.sha1,
        size: rev.claimedSize ?? 0,
    };
}

export class Remote {
    constructor(
        private readonly sdk: ProtonDriveClient,
        private readonly logger: Logger,
        readonly dryRun: boolean,
    ) {}

    /** "My files" root node. */
    async root(): Promise<NodeEntity> {
        return this.sdk.getMyFilesRootFolder();
    }

    async list(folderUid: string): Promise<RemoteChild[]> {
        const out: RemoteChild[] = [];
        for await (const node of this.sdk.iterateFolderChildren(folderUid)) {
            const child = toChild(node);
            if (child) {
                out.push(child);
            }
        }
        return out;
    }

    /**
     * Resolve a path below "My files" ("/" = root). With `create`, missing
     * folders are created. Returns null if it does not exist.
     */
    async resolveFolder(remotePath: string, create: boolean): Promise<{ uid: string; scopeId: string } | null> {
        const root = await this.root();
        let uid = root.uid;
        for (const name of remotePath.split('/').filter(Boolean)) {
            const child = (await this.list(uid)).find((c) => c.name === name);
            if (child?.dir) {
                uid = child.uid;
                continue;
            }
            if (child) {
                throw new Error(`${remotePath}: „${name}“ ist in Proton Drive eine Datei, kein Ordner`);
            }
            if (!create) {
                return null;
            }
            uid = await this.mkdir(uid, name);
        }
        return { uid, scopeId: root.treeEventScopeId };
    }

    /** Full recursive listing below `rootUid`: rel path -> entry. */
    async scanTree(rootUid: string, isExcluded: (rel: string) => boolean): Promise<Record<string, RemoteEntry>> {
        const tree: Record<string, RemoteEntry> = {};
        await this.scanInto(tree, rootUid, '', isExcluded);
        return tree;
    }

    private async scanInto(
        tree: Record<string, RemoteEntry>,
        folderUid: string,
        relDir: string,
        isExcluded: (rel: string) => boolean,
    ): Promise<void> {
        for (const child of await this.list(folderUid)) {
            const rel = joinRel(relDir, child.name);
            if (isExcluded(rel)) {
                continue;
            }
            const { name: _name, ...entry } = child;
            tree[rel] = entry;
            if (child.dir) {
                await this.scanInto(tree, child.uid, rel, isExcluded);
            }
        }
    }

    /**
     * Incremental update of a known tree: re-list only the folders in `dirty`
     * (relative paths, "" = root); new subfolders are scanned completely,
     * vanished entries are removed with everything below them.
     */
    async rescan(
        tree: Record<string, RemoteEntry>,
        rootUid: string,
        dirty: Iterable<string>,
        isExcluded: (rel: string) => boolean,
    ): Promise<Record<string, RemoteEntry>> {
        const next = { ...tree };
        // shallowest first, so a re-listed parent can drop a vanished child folder
        const folders = [...new Set(dirty)].sort((a, b) => a.split('/').length - b.split('/').length);
        for (const relDir of folders) {
            const uid = relDir === '' ? rootUid : next[relDir]?.dir ? next[relDir]!.uid : undefined;
            if (!uid) {
                continue; // folder itself vanished; its parent's re-listing handles it
            }
            const children = await this.list(uid);
            const present = new Set<string>();
            for (const child of children) {
                const rel = joinRel(relDir, child.name);
                if (isExcluded(rel)) {
                    continue;
                }
                present.add(rel);
                const before = next[rel];
                const { name: _name, ...entry } = child;
                if (before && before.uid !== entry.uid) {
                    removeSubtree(next, rel); // replaced by another node
                }
                next[rel] = entry;
                if (entry.dir && (!before || before.uid !== entry.uid)) {
                    await this.scanInto(next, entry.uid, rel, isExcluded);
                }
            }
            for (const rel of Object.keys(next)) {
                if (parentRel(rel) === relDir && !present.has(rel)) {
                    removeSubtree(next, rel);
                }
            }
        }
        return next;
    }

    /** Create a folder (or return the existing one with that name). */
    async mkdir(parentUid: string, name: string): Promise<string> {
        if (this.dryRun) {
            return `dry-run:${name}`;
        }
        try {
            return (await this.sdk.createFolder(parentUid, name)).uid;
        } catch (error) {
            if (error instanceof NodeWithSameNameExistsValidationError && error.existingNodeUid) {
                return error.existingNodeUid;
            }
            throw error;
        }
    }

    /** Current active revision of a node (to detect changes not yet seen via events). */
    async currentRevision(uid: string): Promise<string | undefined> {
        const node = await this.sdk.getNode(uid);
        return node.activeRevision?.uid;
    }

    /**
     * Upload a local file. With `existingUid` a new revision is created,
     * otherwise a new file (an existing file with the same name gets a new
     * revision as well).
     */
    async upload(localPath: string, parentUid: string, name: string, existingUid?: string): Promise<UploadResult> {
        const file = Bun.file(localPath);
        const sha1 = await sha1File(localPath);
        const size = file.size;
        const mediaType = getLocalFileMediaType(this.logger, localPath);
        const metadata = {
            mediaType,
            expectedSize: size,
            expectedSha1: sha1,
            modificationTime: file.lastModified ? new Date(file.lastModified) : undefined,
        };
        let thumbnails: Awaited<ReturnType<typeof generateThumbnails>> = [];
        try {
            thumbnails = await generateThumbnails(mediaType, localPath);
        } catch {
            thumbnails = [];
        }

        let target = existingUid;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const uploader = target
                    ? await this.sdk.getFileRevisionUploader(target, metadata)
                    : await this.sdk.getFileUploader(parentUid, name, metadata);
                const controller = await uploader.uploadFromStream(file.stream(), thumbnails);
                const { nodeUid, nodeRevisionUid } = await controller.completion();
                return { uid: nodeUid, rev: nodeRevisionUid, sha1, size };
            } catch (error) {
                if (!target && error instanceof NodeWithSameNameExistsValidationError && error.existingNodeUid) {
                    target = error.existingNodeUid; // file appeared meanwhile: upload as new revision
                    continue;
                }
                throw error;
            }
        }
        throw new Error(`Upload von ${localPath} fehlgeschlagen`);
    }

    /** Download a revision to exactly `dest` (temp file + verify SHA-1 + rename). */
    async download(revisionUid: string, dest: string, expectedSha1?: string): Promise<void> {
        await mkdir(path.dirname(dest), { recursive: true });
        const tmp = path.join(path.dirname(dest), `.proton-sync-${process.pid}-${Date.now()}.part`);
        const writer = Bun.file(tmp).writer();
        const stream = {
            getWriter: () => writer,
            close: async () => {
                await writer.end();
            },
            abort: async () => {
                await writer.end();
            },
        } as unknown as WritableStream;
        try {
            const downloader = await this.sdk.getFileRevisionDownloader(revisionUid);
            await downloader.downloadToStream(stream).completion();
            await writer.end();
            if (expectedSha1 && (await sha1File(tmp)) !== expectedSha1) {
                throw new Error(`Prüfsumme stimmt nicht: ${baseName(dest)}`);
            }
            await rename(tmp, dest);
        } catch (error) {
            try {
                await writer.end();
            } catch {}
            await unlink(tmp).catch(() => {});
            throw error;
        }
    }

    /** Move a node to the Proton Drive trash. */
    async trash(uid: string): Promise<void> {
        for await (const result of this.sdk.trashNodes([uid])) {
            if (!result.ok) {
                throw result.error instanceof Error ? result.error : new Error(String(result.error));
            }
        }
    }
}

export function removeSubtree(tree: Record<string, RemoteEntry>, rel: string): void {
    delete tree[rel];
    const prefix = rel + '/';
    for (const key of Object.keys(tree)) {
        if (key.startsWith(prefix)) {
            delete tree[key];
        }
    }
}
