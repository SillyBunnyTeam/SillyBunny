import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import express from 'express';
import sanitize from 'sanitize-filename';

import { formatBytes, isPathUnderParent, tryParse } from '../util.js';

const INVENTORY_SCOPES = new Set(['archive', 'orphans']);
const DEFAULT_PAGE_SIZE = 200;
export const MAX_ARCHIVE_PAGE_SIZE = 500;
const INVENTORY_TTL_MS = 5 * 60 * 1000;
const READ_TOKEN_TTL_MS = 15 * 60 * 1000;
const INVENTORY_CONCURRENCY = 8;
const METADATA_READ_BUFFER_SIZE = 64 * 1024;
const MAX_METADATA_PREVIEW_CHARS = 512;
const METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_METADATA_CACHE_ENTRIES = 2_048;
const MAX_ARCHIVE_SESSIONS_PER_USER = 8;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const PROC_FD_DIRECTORY = '/proc/self/fd';
const PROCFS_UNAVAILABLE_CODES = new Set(['EACCES', 'ENOENT', 'ENOTDIR', 'ENOSYS', 'EPERM']);

function abortError(signal) {
    if (signal?.reason instanceof Error) {
        return signal.reason;
    }

    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw abortError(signal);
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function forbiddenArchivePath(message = 'Archive file is outside the user directory.', cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = 'ARCHIVE_PATH_FORBIDDEN';
    return error;
}

function sameFileIdentity(firstStats, secondStats) {
    return firstStats.dev === secondStats.dev
        && firstStats.ino !== 0n
        && firstStats.ino === secondStats.ino;
}

async function resolveProcFileDescriptor(fileDescriptor) {
    try {
        await fs.promises.realpath(PROC_FD_DIRECTORY);
    } catch (error) {
        if (PROCFS_UNAVAILABLE_CODES.has(error?.code)) {
            return null;
        }
        throw error;
    }

    try {
        return await fs.promises.realpath(path.join(PROC_FD_DIRECTORY, String(fileDescriptor)));
    } catch (error) {
        if (PROCFS_UNAVAILABLE_CODES.has(error?.code)) {
            return null;
        }
        throw forbiddenArchivePath('Archive file descriptor could not be verified.', error);
    }
}

async function openRegularArchiveFile(filePath, rootDirectory = null) {
    let canonicalRoot = null;
    let expectedIdentity = null;
    if (rootDirectory) {
        canonicalRoot = await fs.promises.realpath(rootDirectory);
    }
    let pathToOpen = await fs.promises.realpath(filePath);
    if (canonicalRoot) {
        if (!isPathUnderParent(canonicalRoot, pathToOpen)) {
            throw forbiddenArchivePath();
        }
        const canonicalStats = await fs.promises.stat(pathToOpen, { bigint: true });
        if (!canonicalStats.isFile()) {
            throw new Error('Archive inventory entry is not a regular file.');
        }
        expectedIdentity = canonicalStats;
    }

    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const fileHandle = await fs.promises.open(pathToOpen, fs.constants.O_RDONLY | noFollow);
    try {
        const [stats, openedIdentity] = await Promise.all([
            fileHandle.stat(),
            fileHandle.stat({ bigint: true }),
        ]);
        if (!stats.isFile() || !openedIdentity.isFile()) {
            throw new Error('Archive inventory entry is not a regular file.');
        }

        if (canonicalRoot) {
            const descriptorPath = await resolveProcFileDescriptor(fileHandle.fd);
            if (descriptorPath && !isPathUnderParent(canonicalRoot, descriptorPath)) {
                throw forbiddenArchivePath();
            }

            let currentCanonicalFile;
            let currentIdentity;
            try {
                currentCanonicalFile = await fs.promises.realpath(filePath);
                if (!isPathUnderParent(canonicalRoot, currentCanonicalFile) || currentCanonicalFile !== pathToOpen) {
                    throw forbiddenArchivePath('Archive file path changed while it was being opened.');
                }
                currentIdentity = await fs.promises.stat(currentCanonicalFile, { bigint: true });
            } catch (error) {
                if (error?.code === 'ARCHIVE_PATH_FORBIDDEN') {
                    throw error;
                }
                throw forbiddenArchivePath('Archive file path changed while it was being opened.', error);
            }

            if (!sameFileIdentity(expectedIdentity, openedIdentity)
                || !sameFileIdentity(openedIdentity, currentIdentity)) {
                throw forbiddenArchivePath('Archive file identity changed while it was being opened.');
            }
            pathToOpen = currentCanonicalFile;
        }

        return { fileHandle, pathToOpen, stats, cacheStats: openedIdentity };
    } catch (error) {
        await fileHandle.close();
        throw error;
    }
}

export class ArchiveMetadataCache {
    static ENTRIES = new Map();

    static cleanup(now = Date.now()) {
        for (const [key, entry] of this.ENTRIES) {
            if (entry.expiresAt <= now) {
                this.ENTRIES.delete(key);
            }
        }
    }

    static key(canonicalPath, stats) {
        const modifiedTime = stats.mtimeNs === undefined
            ? `ms:${String(stats.mtimeMs)}`
            : `ns:${String(stats.mtimeNs)}`;
        return [
            canonicalPath,
            String(stats.dev),
            String(stats.ino),
            String(stats.size),
            modifiedTime,
        ].join('\0');
    }

    static get(canonicalPath, stats, now = Date.now()) {
        const key = this.key(canonicalPath, stats);
        const entry = this.ENTRIES.get(key);
        if (!entry || entry.expiresAt <= now) {
            this.ENTRIES.delete(key);
            return null;
        }
        this.ENTRIES.delete(key);
        this.ENTRIES.set(key, entry);
        return entry.metadata;
    }

    static set(canonicalPath, stats, metadata, now = Date.now()) {
        const key = this.key(canonicalPath, stats);
        this.ENTRIES.delete(key);
        if (this.ENTRIES.size >= MAX_METADATA_CACHE_ENTRIES) {
            this.cleanup(now);
        }
        while (this.ENTRIES.size >= MAX_METADATA_CACHE_ENTRIES) {
            this.ENTRIES.delete(this.ENTRIES.keys().next().value);
        }
        this.ENTRIES.set(key, {
            metadata,
            expiresAt: now + METADATA_CACHE_TTL_MS,
        });
    }
}

async function readDirectory(directory) {
    try {
        return await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

function isJsonlFile(dirent) {
    return dirent.isFile() && path.extname(dirent.name).toLowerCase() === '.jsonl';
}

function compareDirentNames(left, right) {
    if (left.name === right.name) {
        return 0;
    }
    return left.name < right.name ? -1 : 1;
}

function archiveIdentity(descriptor) {
    const record = {
        _source: descriptor.hash ? 'archive-orphan' : 'archive-inventory',
        file_id: path.parse(descriptor.fileName).name,
        file_name: descriptor.fileName,
    };

    if (descriptor.avatar) {
        record.avatar = descriptor.avatar;
    }
    if (descriptor.groupId !== undefined) {
        record.group = descriptor.groupId;
    }
    if (descriptor.chatFolder) {
        record.chatFolder = descriptor.chatFolder;
    }
    if (descriptor.orphanType) {
        record.orphan_type = descriptor.orphanType;
        record.archive_hash = descriptor.hash;
    }

    return record;
}

/**
 * Reads archive list metadata while parsing only the header and final JSONL records.
 * The intervening records are counted as lines and are never materialized or parsed.
 * @param {string} filePath Chat JSONL path.
 * @param {AbortSignal} [signal] Cancellation signal.
 * @param {string|null} [rootDirectory] User root that must contain the file.
 * @returns {Promise<object>} Archive-compatible chat metadata.
 */
export async function readArchiveChatMetadata(filePath, signal, rootDirectory = null) {
    throwIfAborted(signal);
    const { fileHandle, pathToOpen, stats, cacheStats } = await openRegularArchiveFile(filePath, rootDirectory);
    const cachedMetadata = ArchiveMetadataCache.get(pathToOpen, cacheStats);
    if (cachedMetadata) {
        await fileHandle.close();
        throwIfAborted(signal);
        return cachedMetadata;
    }

    const metadata = {
        file_size: formatBytes(stats.size),
        chat_items: 0,
        last_mes: stats.mtimeMs,
        mes: '[The chat is empty]',
    };
    let firstLine = '';
    let lastLine = '';
    let recordCount = 0;
    let pending = '';
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(METADATA_READ_BUFFER_SIZE);
    const consumeLine = (rawLine) => {
        let line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line.trim()) {
            return;
        }
        if (!firstLine) {
            line = line.replace(/^\uFEFF/, '');
            firstLine = line;
        }
        lastLine = line;
        recordCount++;
    };

    try {
        let position = 0;
        while (position < stats.size) {
            throwIfAborted(signal);
            const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) {
                break;
            }
            position += bytesRead;
            pending += decoder.write(buffer.subarray(0, bytesRead));
            let lineEnd;
            while ((lineEnd = pending.indexOf('\n')) >= 0) {
                consumeLine(pending.slice(0, lineEnd));
                pending = pending.slice(lineEnd + 1);
            }
        }
        pending += decoder.end();
        if (pending) {
            consumeLine(pending);
        }
    } finally {
        await fileHandle.close();
    }

    throwIfAborted(signal);
    const header = firstLine ? tryParse(firstLine) : null;
    const lastRecord = lastLine ? tryParse(lastLine) : null;
    const hasHeader = isPlainObject(header) && !Object.hasOwn(header, 'mes');
    metadata.chat_items = Math.max(0, recordCount - (hasHeader ? 1 : 0));
    if (isPlainObject(header?.chat_metadata)) {
        metadata.chat_metadata = header.chat_metadata;
    }
    if (isPlainObject(lastRecord) && (!hasHeader || lastLine !== firstLine)) {
        metadata.last_mes = lastRecord.send_date || stats.mtimeMs;
        metadata.mes = typeof lastRecord.mes === 'string' && lastRecord.mes
            ? lastRecord.mes.slice(0, MAX_METADATA_PREVIEW_CHARS)
            : '[The message is empty]';
    }

    ArchiveMetadataCache.set(pathToOpen, cacheStats, metadata);
    return metadata;
}

async function readGroupLinks(directories, groupChatFiles, signal) {
    const links = new Map();
    const groupEntries = (await readDirectory(directories.groups))
        .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
        .sort(compareDirentNames);

    for (const entry of groupEntries) {
        throwIfAborted(signal);
        try {
            const groupPath = path.join(directories.groups, entry.name);
            const group = JSON.parse(await fs.promises.readFile(groupPath, 'utf8'));
            if ((typeof group?.id !== 'string' && typeof group?.id !== 'number') || String(group.id) === '') {
                continue;
            }

            const chatIds = new Set(Array.isArray(group.chats) ? group.chats : []);
            if (group.chat_id !== undefined && group.chat_id !== null && group.chat_id !== '') {
                chatIds.add(group.chat_id);
            }
            for (const chatId of chatIds) {
                if (typeof chatId !== 'string' && typeof chatId !== 'number') {
                    continue;
                }
                const fileName = sanitize(`${chatId}.jsonl`);
                if (!fileName || !groupChatFiles.has(fileName) || links.has(fileName)) {
                    continue;
                }
                links.set(fileName, group.id);
            }
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw error;
            }
            console.warn(`[Chat Archive] Could not read group links from ${entry.name}:`, error);
        }
    }

    return links;
}

async function collectArchiveDescriptors(directories, scope, signal) {
    throwIfAborted(signal);
    for (const key of ['root', 'characters', 'chats', 'groups', 'groupChats']) {
        if (typeof directories[key] !== 'string') {
            throw new TypeError(`Chat Archive requires the ${key} user directory.`);
        }
    }
    const [characterEntries, chatEntries, groupChatEntries] = await Promise.all([
        readDirectory(directories.characters),
        readDirectory(directories.chats),
        readDirectory(directories.groupChats),
    ]);
    const characterAvatars = new Map(characterEntries
        .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.png')
        .map(entry => [path.parse(entry.name).name, entry.name]));
    const groupChatFiles = new Set(groupChatEntries.filter(isJsonlFile).map(entry => entry.name));
    const groupLinks = await readGroupLinks(directories, groupChatFiles, signal);
    const descriptors = [];

    for (const entry of chatEntries.sort(compareDirentNames)) {
        throwIfAborted(signal);
        if (entry.isFile() && isJsonlFile(entry)) {
            if (scope === 'archive') {
                descriptors.push({
                    fileName: entry.name,
                    filePath: path.join(directories.chats, entry.name),
                    orphanType: 'root',
                });
            }
            continue;
        }
        if (!entry.isDirectory()) {
            continue;
        }

        const avatar = characterAvatars.get(entry.name);
        const isLinked = Boolean(avatar);
        if ((scope === 'archive') !== isLinked) {
            continue;
        }
        const chatFolderPath = path.join(directories.chats, entry.name);
        const chatFiles = (await readDirectory(chatFolderPath)).filter(isJsonlFile)
            .sort(compareDirentNames);
        for (const chatFile of chatFiles) {
            descriptors.push({
                fileName: chatFile.name,
                filePath: path.join(chatFolderPath, chatFile.name),
                avatar,
                chatFolder: entry.name,
                orphanType: isLinked ? null : 'missing-character',
            });
        }
    }

    for (const entry of groupChatEntries.filter(isJsonlFile).sort(compareDirentNames)) {
        throwIfAborted(signal);
        const groupId = groupLinks.get(entry.name);
        const isLinked = groupId !== undefined;
        if ((scope === 'archive') !== isLinked) {
            continue;
        }
        descriptors.push({
            fileName: entry.name,
            filePath: path.join(directories.groupChats, entry.name),
            groupId,
            orphanType: isLinked ? null : 'unlinked-group',
        });
    }

    return descriptors;
}

async function mapWithConcurrency(items, signal, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
        while (true) {
            throwIfAborted(signal);
            const index = nextIndex++;
            if (index >= items.length) {
                return;
            }
            results[index] = await mapper(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(INVENTORY_CONCURRENCY, items.length) }, worker));
    return results;
}

export class ArchiveReadTokenService {
    static TOKENS = new Map();

    static cleanup(now = Date.now()) {
        for (const [token, entry] of this.TOKENS) {
            if (entry.expiresAt <= now) {
                this.TOKENS.delete(token);
            }
        }
    }

    static create(handle, root, descriptors) {
        this.cleanup();
        const userTokens = [...this.TOKENS]
            .filter(([, entry]) => entry.handle === handle)
            .map(([token]) => token);
        while (userTokens.length >= MAX_ARCHIVE_SESSIONS_PER_USER) {
            this.TOKENS.delete(userTokens.shift());
        }
        const token = crypto.randomBytes(32).toString('hex');
        const files = new Map();
        for (const descriptor of descriptors) {
            const hash = crypto.createHash('sha256').update(`${token}\0${descriptor.filePath}`).digest('hex');
            descriptor.hash = hash;
            files.set(hash, descriptor.filePath);
        }
        this.TOKENS.set(token, {
            handle,
            root: fs.realpathSync(root),
            files,
            expiresAt: Date.now() + READ_TOKEN_TTL_MS,
        });
        return token;
    }

    static get(token, handle) {
        this.cleanup();
        const entry = this.TOKENS.get(token);
        if (!entry || entry.handle !== handle) {
            return null;
        }
        entry.expiresAt = Date.now() + READ_TOKEN_TTL_MS;
        return entry;
    }

    static canRelease(token, handle) {
        this.cleanup();
        const entry = this.TOKENS.get(token);
        return !!entry && entry.handle === handle;
    }

    static release(token, handle) {
        this.cleanup();
        if (!this.canRelease(token, handle)) {
            return false;
        }
        this.TOKENS.delete(token);
        return true;
    }
}

export class ArchiveInventoryService {
    static INVENTORIES = new Map();

    static CREATION_LOCKS = new Map();

    static cleanup(now = Date.now()) {
        for (const [cursor, entry] of this.INVENTORIES) {
            if (entry.expiresAt <= now) {
                this.INVENTORIES.delete(cursor);
                if (entry.readToken) {
                    ArchiveReadTokenService.release(entry.readToken, entry.handle);
                }
            }
        }
    }

    static async create(handle, directories, scope, signal) {
        const previous = this.CREATION_LOCKS.get(handle) ?? Promise.resolve();
        let release;
        const current = new Promise(resolve => {
            release = resolve;
        });
        this.CREATION_LOCKS.set(handle, current);
        await previous;
        try {
            this.cleanup();
            const userInventories = [...this.INVENTORIES]
                .filter(([, entry]) => entry.handle === handle)
                .map(([cursor]) => cursor);
            while (userInventories.length >= MAX_ARCHIVE_SESSIONS_PER_USER) {
                this.discard(userInventories.shift(), handle);
            }
            const canonicalRoot = await fs.promises.realpath(directories.root);
            const descriptors = await collectArchiveDescriptors(directories, scope, signal);
            throwIfAborted(signal);
            const cursor = crypto.randomBytes(32).toString('hex');
            const readToken = scope === 'orphans'
                ? ArchiveReadTokenService.create(handle, canonicalRoot, descriptors)
                : null;
            this.INVENTORIES.set(cursor, {
                handle,
                scope,
                descriptors,
                offset: 0,
                readToken,
                root: canonicalRoot,
                busy: false,
                expiresAt: Date.now() + INVENTORY_TTL_MS,
            });
            return cursor;
        } finally {
            release();
            if (this.CREATION_LOCKS.get(handle) === current) {
                this.CREATION_LOCKS.delete(handle);
            }
        }
    }

    static get(cursor, handle) {
        this.cleanup();
        const inventory = this.INVENTORIES.get(cursor);
        if (!inventory || inventory.handle !== handle) {
            return null;
        }
        inventory.expiresAt = Date.now() + INVENTORY_TTL_MS;
        if (inventory.readToken) {
            ArchiveReadTokenService.get(inventory.readToken, handle);
        }
        return inventory;
    }

    static discard(cursor, handle) {
        const inventory = this.INVENTORIES.get(cursor);
        if (!inventory || inventory.handle !== handle) {
            return false;
        }
        this.INVENTORIES.delete(cursor);
        if (inventory.readToken) {
            ArchiveReadTokenService.release(inventory.readToken, handle);
        }
        return true;
    }

    static canDiscard(cursor, handle) {
        this.cleanup();
        const inventory = this.INVENTORIES.get(cursor);
        return !!inventory && inventory.handle === handle;
    }

    static async page(
        cursor,
        handle,
        pageSize,
        signal,
        inventory = this.get(cursor, handle),
        metadataReader = readArchiveChatMetadata,
    ) {
        if (!inventory) {
            return { status: 'missing' };
        }
        if (inventory.busy) {
            return { status: 'busy' };
        }

        inventory.busy = true;
        const start = inventory.offset;
        const descriptors = inventory.descriptors.slice(start, start + pageSize);
        let errors = 0;
        try {
            const rows = await mapWithConcurrency(descriptors, signal, async descriptor => {
                try {
                    const metadata = await metadataReader(descriptor.filePath, signal, inventory.root);
                    return { ...archiveIdentity(descriptor), ...metadata };
                } catch (error) {
                    if (error?.name === 'AbortError' || signal?.aborted) {
                        throw abortError(signal);
                    }
                    errors++;
                    return archiveIdentity(descriptor);
                }
            });
            throwIfAborted(signal);
            inventory.offset = start + descriptors.length;
            const complete = inventory.offset >= inventory.descriptors.length;
            if (complete) {
                this.INVENTORIES.delete(cursor);
            }
            return {
                status: 'ok',
                rows,
                errors,
                cursor: complete ? null : cursor,
                readToken: inventory.readToken,
                total: inventory.descriptors.length,
            };
        } finally {
            inventory.busy = false;
        }
    }
}

function parsePageSize(value) {
    if (value === undefined) {
        return DEFAULT_PAGE_SIZE;
    }
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ARCHIVE_PAGE_SIZE) {
        return null;
    }
    return value;
}

function requestAbortController(request, response) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortOnClosedResponse = () => {
        if (!response.writableEnded) {
            abort();
        }
    };
    request.once('aborted', abort);
    response.once('close', abortOnClosedResponse);
    return {
        signal: controller.signal,
        cleanup: () => {
            request.removeListener('aborted', abort);
            response.removeListener('close', abortOnClosedResponse);
        },
    };
}

export const router = express.Router();

router.post('/inventory', async (request, response) => {
    if (!request.user?.directories || typeof request.user?.profile?.handle !== 'string') {
        return response.sendStatus(403);
    }

    const pageSize = parsePageSize(request.body?.page_size);
    const suppliedCursor = request.body?.cursor;
    const scope = request.body?.scope;
    if (pageSize === null
        || (suppliedCursor !== undefined && suppliedCursor !== null && (typeof suppliedCursor !== 'string' || !TOKEN_PATTERN.test(suppliedCursor)))
        || ((suppliedCursor === undefined || suppliedCursor === null) && !INVENTORY_SCOPES.has(scope))
        || (scope !== undefined && !INVENTORY_SCOPES.has(scope))) {
        return response.sendStatus(400);
    }

    const cancellation = requestAbortController(request, response);
    const handle = request.user.profile.handle;
    let cursor = null;
    try {
        cursor = suppliedCursor ?? await ArchiveInventoryService.create(
            handle,
            request.user.directories,
            scope,
            cancellation.signal,
        );
        const inventory = ArchiveInventoryService.get(cursor, handle);
        if (!inventory) {
            return response.sendStatus(403);
        }
        if (scope !== undefined && inventory.scope !== scope) {
            return response.sendStatus(400);
        }

        const page = await ArchiveInventoryService.page(cursor, handle, pageSize, cancellation.signal, inventory);
        if (page.status === 'missing') {
            return response.sendStatus(403);
        }
        if (page.status === 'busy') {
            return response.sendStatus(409);
        }
        return response.json({
            rows: page.rows,
            cursor: page.cursor,
            read_token: page.readToken,
            errors: page.errors,
            total: page.total,
        });
    } catch (error) {
        if (error?.name === 'AbortError' || cancellation.signal.aborted) {
            if (cursor) {
                ArchiveInventoryService.discard(cursor, handle);
            }
            return;
        }
        console.error('[Chat Archive] Failed to build archive inventory:', error);
        return response.sendStatus(500);
    } finally {
        cancellation.cleanup();
    }
});

router.get('/view', async (request, response) => {
    if (!request.user?.directories || typeof request.user?.profile?.handle !== 'string') {
        return response.sendStatus(403);
    }
    const token = typeof request.query.token === 'string' ? request.query.token : '';
    const hash = typeof request.query.hash === 'string' ? request.query.hash : '';
    if (!TOKEN_PATTERN.test(token) || !TOKEN_PATTERN.test(hash)) {
        return response.sendStatus(400);
    }

    const session = ArchiveReadTokenService.get(token, request.user.profile.handle);
    if (!session) {
        return response.sendStatus(403);
    }
    const filePath = session.files.get(hash);
    if (!filePath) {
        return response.sendStatus(404);
    }
    let archiveFile;
    try {
        archiveFile = await openRegularArchiveFile(filePath, session.root);
        const contents = await archiveFile.fileHandle.readFile();
        response.type('application/x-ndjson');
        return response.send(contents);
    } catch (error) {
        if (error?.code === 'ARCHIVE_PATH_FORBIDDEN' || error?.code === 'ELOOP') {
            return response.sendStatus(403);
        }
        if (error?.code === 'ENOENT') {
            return response.sendStatus(404);
        }
        console.error('[Chat Archive] Failed to read archive file:', error);
        return response.sendStatus(500);
    } finally {
        await archiveFile?.fileHandle.close();
    }
});

router.post('/release', (request, response) => {
    if (!request.user?.directories || typeof request.user?.profile?.handle !== 'string') {
        return response.sendStatus(403);
    }
    const token = request.body?.token ?? null;
    const cursor = request.body?.cursor ?? null;
    if ((!token && !cursor)
        || (token !== null && (typeof token !== 'string' || !TOKEN_PATTERN.test(token)))
        || (cursor !== null && (typeof cursor !== 'string' || !TOKEN_PATTERN.test(cursor)))) {
        return response.sendStatus(400);
    }
    const handle = request.user.profile.handle;
    if ((token && !ArchiveReadTokenService.canRelease(token, handle))
        || (cursor && !ArchiveInventoryService.canDiscard(cursor, handle))) {
        return response.sendStatus(403);
    }
    if (cursor) {
        ArchiveInventoryService.discard(cursor, handle);
    }
    if (token) {
        ArchiveReadTokenService.release(token, handle);
    }
    return response.sendStatus(204);
});
