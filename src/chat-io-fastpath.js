import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { fsyncDirectorySync } from './util.js';

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
const DIRTY_BYTE0_TRACKING_MAX = 512;

export const CHAT_STATE_CACHE_MAX_BYTES = process.env.SILLYBUNNY_ANDROID_APP === '1'
    ? 24 * 1024 * 1024
    : 96 * 1024 * 1024;

export const CHAT_INFO_CACHE_MAX_BYTES = process.env.SILLYBUNNY_ANDROID_APP === '1'
    ? 8 * 1024 * 1024
    : 32 * 1024 * 1024;

export const CHAT_INFO_CACHE_MAX_ENTRIES = 2000;
export const BACKUP_DEDUPE_CACHE_MAX_ENTRIES = 512;
export const COARSE_TIMESTAMP_MODULO_NS = 1_000_000_000n;

const WINDOWS_RETRY_DELAYS_MS = [50, 125, 250];
const HARDLINK_FALLBACK_ERROR_CODES = new Set([
    'EXDEV',
    'EPERM',
    'ENOTSUP',
    'EEXIST',
    'EMLINK',
    'ENOSYS',
    'EACCES',
    'EBUSY',
    'EROFS',
    'ENOENT',
    'EINVAL',
    'UNKNOWN',
]);

function isPlainObject(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Computes a SHA-256 hex digest for a string or Buffer.
 * @param {string|Buffer|Uint8Array} data Input bytes or UTF-8 string
 * @returns {string} Hex digest
 */
export function computeSha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Extracts the 5-field bigint stat tuple used to validate cached file state.
 * @param {import('node:fs').BigIntStats|null|undefined} stats BigInt stat result
 * @returns {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }|null}
 */
export function extractStatTuple(stats) {
    if (!stats || typeof stats.size !== 'bigint') {
        return null;
    }
    return {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
    };
}

/**
 * Returns true only when all 5 stat fields are non-zero and filesystem timestamp granularity is finer than 1 second.
 * @param {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }|null|undefined} tuple
 * @returns {boolean}
 */
export function isReliableStatTuple(tuple) {
    if (!tuple) {
        return false;
    }
    if (tuple.dev === 0n || tuple.ino === 0n || tuple.size === 0n || tuple.mtimeNs === 0n || tuple.ctimeNs === 0n) {
        return false;
    }
    if (tuple.mtimeNs % COARSE_TIMESTAMP_MODULO_NS === 0n && tuple.ctimeNs % COARSE_TIMESTAMP_MODULO_NS === 0n) {
        return false;
    }
    return true;
}

/**
 * Compares two 5-field bigint stat tuples for exact equality.
 * @param {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }|null|undefined} left
 * @param {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }|null|undefined} right
 * @returns {boolean}
 */
export function statTuplesEqual(left, right) {
    return Boolean(left && right)
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}

/**
 * Validates that a Buffer or Uint8Array contains strictly valid UTF-8 byte sequences.
 * @param {Buffer|Uint8Array} buffer
 * @returns {boolean}
 */
export function isValidUtf8Buffer(buffer) {
    if (!(buffer instanceof Uint8Array)) {
        return false;
    }
    try {
        fatalUtf8Decoder.decode(buffer);
        return true;
    } catch {
        return false;
    }
}

/**
 * Extracts a comparable stat tuple from `BigIntStats` (preferred, avoiding NTFS 64-bit `ino` precision loss)
 * or standard number-based `Stats` for ChatInfo caching.
 * Returns null when fields are missing/zero or appear to come from a coarse 1-second filesystem.
 * @param {import('node:fs').BigIntStats|import('node:fs').Stats|null|undefined} stats
 * @returns {{ dev: bigint|number, ino: bigint|number, size: bigint|number, mtimeNs: bigint|number, ctimeNs: bigint|number }|null}
 */
export function extractChatInfoStatTuple(stats) {
    if (!stats) {
        return null;
    }
    if (typeof stats.size === 'bigint') {
        const tuple = extractStatTuple(stats);
        return isReliableStatTuple(tuple) ? tuple : null;
    }
    if (typeof stats.dev !== 'number' || !Number.isFinite(stats.dev) || stats.dev === 0
        || typeof stats.ino !== 'number' || !Number.isFinite(stats.ino) || stats.ino === 0
        || typeof stats.size !== 'number' || !Number.isFinite(stats.size) || stats.size <= 0
        || typeof stats.mtimeMs !== 'number' || !Number.isFinite(stats.mtimeMs) || stats.mtimeMs === 0
        || typeof stats.ctimeMs !== 'number' || !Number.isFinite(stats.ctimeMs) || stats.ctimeMs === 0) {
        return null;
    }
    const isCoarseMtime = Number.isInteger(stats.mtimeMs) && stats.mtimeMs % 1000 === 0;
    const isCoarseCtime = Number.isInteger(stats.ctimeMs) && stats.ctimeMs % 1000 === 0;
    if (isCoarseMtime && isCoarseCtime) {
        return null;
    }
    return {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeNs: stats.mtimeMs,
        ctimeNs: stats.ctimeMs,
    };
}

/**
 * Resolves a canonical cache key for a chat path using `realpathSync` when available,
 * walking up ancestor directories when the file or parent directories have already been deleted.
 * Callers must check `lstatSync` first so file symlinks never hit cached entries for their targets.
 * @param {string} filePath
 * @returns {string}
 */
export function getCanonicalChatCacheKey(filePath) {
    const absolutePath = path.resolve(filePath);
    let current = absolutePath;
    const trailingSegments = [];
    let resolved = absolutePath;
    while (true) {
        try {
            const realCurrent = fs.realpathSync(current);
            resolved = trailingSegments.length > 0
                ? path.join(realCurrent, ...trailingSegments.reverse())
                : realCurrent;
            break;
        } catch {
            const parent = path.dirname(current);
            if (parent === current) {
                resolved = absolutePath;
                break;
            }
            trailingSegments.push(path.basename(current));
            current = parent;
        }
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isTestFaultInjectionAllowed() {
    return process.env.SB_ALLOW_TEST_FAULTS === '1'
        || process.env.NODE_ENV === 'test'
        || Boolean(process.env.JEST_WORKER_ID);
}

/**
 * Test-only fault injection hook controlled by `SB_FAULT_AT` (active only under test environments).
 * Has negligible overhead when `SB_FAULT_AT` is unset.
 * @param {string} point Fault injection point name
 */
export function maybeInjectChatIoFault(point) {
    const targetPoint = process.env.SB_FAULT_AT;
    if (!targetPoint || targetPoint !== point || !isTestFaultInjectionAllowed()) {
        return;
    }
    if (process.env.SB_FAULT_MODE === 'throw') {
        throw Object.assign(new Error(`Injected chat I/O fault at ${point}`), {
            code: 'EFAULT_INJECTED',
            faultPoint: point,
        });
    }
    process.kill(process.pid, 'SIGKILL');
}

/**
 * Returns the exact raw UTF-8 text of a ChatStateCache entry.
 * @param {object} entry
 * @returns {string}
 */
export function getEntryRawText(entry) {
    if (entry.rawBuffer) {
        return entry.rawBuffer.toString('utf8');
    }
    return entry.lines.join('\n');
}

/**
 * Returns the exact raw Buffer bytes of a ChatStateCache entry.
 * @param {object} entry
 * @returns {Buffer}
 */
export function getEntryRawBuffer(entry) {
    if (entry.rawBuffer) {
        return entry.rawBuffer;
    }
    return Buffer.from(entry.lines.join('\n'), 'utf8');
}

function estimateChatStateEntryBytes(entry) {
    const fileSize = typeof entry.size === 'bigint' ? Number(entry.size) : Number(entry.size || 0);
    const lineOverhead = Array.isArray(entry.lines) ? entry.lines.length * 64 : 0;
    const rawBufferBytes = entry.rawBuffer ? entry.rawBuffer.byteLength : 0;
    return Math.max(0, fileSize * 2) + lineOverhead + rawBufferBytes + 1024;
}

/**
 * Per-process byte-capped LRU cache for validated active chat state.
 */
export class ChatStateCache {
    /**
     * @param {number} [maxBytes]
     */
    constructor(maxBytes = CHAT_STATE_CACHE_MAX_BYTES) {
        this.maxBytes = Math.max(0, Number(maxBytes) || 0);
        /** @type {Map<string, any>} */
        this.entries = new Map();
        this.totalBytes = 0;
    }

    /**
     * Retrieves an entry by canonical key and promotes it to MRU.
     * @param {string} filePath
     * @returns {any|null}
     */
    get(filePath) {
        const key = getCanonicalChatCacheKey(filePath);
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry;
    }

    /**
     * Retrieves a cached entry only if `stats` describes a regular file whose 5-field stat tuple
     * is reliable and matches the cached entry exactly.
     * @param {string} filePath
     * @param {import('node:fs').BigIntStats} stats
     * @returns {any|null}
     */
    getIfStatMatches(filePath, stats) {
        if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
            return null;
        }
        const tuple = extractStatTuple(stats);
        if (!isReliableStatTuple(tuple)) {
            return null;
        }
        const entry = this.get(filePath);
        if (!entry) {
            return null;
        }
        if (!statTuplesEqual(tuple, entry)) {
            return null;
        }
        return entry;
    }

    /**
     * Stores or replaces an entry for `filePath`, evicting LRU entries to remain within `maxBytes`.
     * @param {string} filePath
     * @param {object} entryData
     * @returns {any|null}
     */
    set(filePath, entryData) {
        const tuple = extractStatTuple(entryData);
        if (!isReliableStatTuple(tuple)) {
            this.invalidate(filePath);
            return null;
        }
        const key = getCanonicalChatCacheKey(filePath);
        const estimatedBytes = estimateChatStateEntryBytes(entryData);
        const existing = this.entries.get(key);
        if (existing) {
            this.totalBytes -= existing.estimatedBytes;
            this.entries.delete(key);
        }
        if (this.maxBytes <= 0 || estimatedBytes > this.maxBytes) {
            return null;
        }
        const entry = {
            ...entryData,
            key,
            estimatedBytes,
        };
        this.entries.set(key, entry);
        this.totalBytes += estimatedBytes;
        while (this.totalBytes > this.maxBytes && this.entries.size > 0) {
            const oldestKey = this.entries.keys().next().value;
            const oldest = this.entries.get(oldestKey);
            this.entries.delete(oldestKey);
            if (oldest) {
                this.totalBytes -= oldest.estimatedBytes;
            }
        }
        return entry;
    }

    /**
     * Updates mutable recovery/backup metadata fields on an existing cached entry if present.
     * @param {string} filePath
     * @param {object} patch
     */
    update(filePath, patch) {
        const key = getCanonicalChatCacheKey(filePath);
        const entry = this.entries.get(key);
        if (!entry) {
            return;
        }
        Object.assign(entry, patch);
    }

    /**
     * Removes any cached entry for `filePath`.
     * @param {string} filePath
     */
    invalidate(filePath) {
        if (!filePath) {
            return;
        }
        const keys = new Set([
            getCanonicalChatCacheKey(filePath),
            process.platform === 'win32' ? path.resolve(filePath).toLowerCase() : path.resolve(filePath),
        ]);
        for (const key of keys) {
            const existing = this.entries.get(key);
            if (existing) {
                this.totalBytes -= existing.estimatedBytes;
                this.entries.delete(key);
            }
        }
    }

    clear() {
        this.entries.clear();
        this.totalBytes = 0;
    }

    getStats() {
        return {
            entries: this.entries.size,
            totalBytes: this.totalBytes,
            maxBytes: this.maxBytes,
        };
    }
}

/**
 * Bounded stat-tuple LRU cache for `getChatInfo` summaries.
 */
export class ChatInfoCache {
    /**
     * @param {number} [maxEntries]
     * @param {number} [maxBytes]
     */
    constructor(maxEntries = CHAT_INFO_CACHE_MAX_ENTRIES, maxBytes = CHAT_INFO_CACHE_MAX_BYTES) {
        this.maxEntries = Math.max(0, Number(maxEntries) || 0);
        this.maxBytes = Math.max(0, Number(maxBytes) || 0);
        /** @type {Map<string, any>} */
        this.entries = new Map();
        this.totalBytes = 0;
    }

    /**
     * @param {string} filePath
     * @param {import('node:fs').Stats} stats
     * @param {number} previewLimit
     * @returns {any|null}
     */
    getIfStatMatches(filePath, stats, previewLimit = 0) {
        const tuple = extractChatInfoStatTuple(stats);
        if (!tuple) {
            return null;
        }
        const key = getCanonicalChatCacheKey(filePath);
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        if (entry.dev !== tuple.dev
            || entry.ino !== tuple.ino
            || entry.size !== tuple.size
            || entry.mtimeNs !== tuple.mtimeNs
            || entry.ctimeNs !== tuple.ctimeNs) {
            return null;
        }
        if (previewLimit > 0 && entry.previewLimitCached < previewLimit) {
            return null;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry;
    }

    /**
     * @param {string} filePath
     * @param {import('node:fs').Stats} stats
     * @param {object} infoEntry
     */
    set(filePath, stats, infoEntry) {
        const tuple = extractChatInfoStatTuple(stats);
        if (!tuple || this.maxEntries <= 0 || this.maxBytes <= 0) {
            return;
        }
        const key = getCanonicalChatCacheKey(filePath);
        const estimatedBytes = 512
            + (typeof infoEntry.mes === 'string' ? infoEntry.mes.length * 2 : 0)
            + (infoEntry.chatMetadataJson ? infoEntry.chatMetadataJson.length * 2 : 0)
            + (infoEntry.previewMessagesJson ? infoEntry.previewMessagesJson.length * 2 : 0);
        const existing = this.entries.get(key);
        if (existing) {
            this.totalBytes -= existing.estimatedBytes;
            this.entries.delete(key);
        }
        if (estimatedBytes > this.maxBytes) {
            return;
        }
        const entry = {
            ...tuple,
            ...infoEntry,
            estimatedBytes,
        };
        this.entries.set(key, entry);
        this.totalBytes += estimatedBytes;
        while ((this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) && this.entries.size > 0) {
            const oldestKey = this.entries.keys().next().value;
            const oldest = this.entries.get(oldestKey);
            this.entries.delete(oldestKey);
            if (oldest) {
                this.totalBytes -= oldest.estimatedBytes;
            }
        }
    }

    invalidate(filePath) {
        if (!filePath) {
            return;
        }
        const keys = new Set([
            getCanonicalChatCacheKey(filePath),
            process.platform === 'win32' ? path.resolve(filePath).toLowerCase() : path.resolve(filePath),
        ]);
        for (const key of keys) {
            const existing = this.entries.get(key);
            if (existing) {
                this.totalBytes -= existing.estimatedBytes;
                this.entries.delete(key);
            }
        }
    }

    clear() {
        this.entries.clear();
        this.totalBytes = 0;
    }
}

/**
 * Small bounded LRU cache mapping `(backupDirectory, prefix)` to its latest observed backup file metadata and normalized content hash.
 */
export class BackupDedupeCache {
    constructor(maxEntries = BACKUP_DEDUPE_CACHE_MAX_ENTRIES) {
        this.maxEntries = maxEntries;
        /** @type {Map<string, any>} */
        this.entries = new Map();
    }

    _makeKey(directory, prefix) {
        const resolvedDir = path.resolve(directory);
        const dirKey = process.platform === 'win32' ? resolvedDir.toLowerCase() : resolvedDir;
        return `${dirKey}\0${prefix}`;
    }

    get(directory, prefix) {
        const key = this._makeKey(directory, prefix);
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry;
    }

    set(directory, prefix, value) {
        const key = this._makeKey(directory, prefix);
        this.entries.delete(key);
        this.entries.set(key, value);
        while (this.entries.size > this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            this.entries.delete(oldestKey);
        }
    }

    clear() {
        this.entries.clear();
    }
}

export const chatStateCache = new ChatStateCache();
export const chatInfoCache = new ChatInfoCache();
export const backupDedupeCache = new BackupDedupeCache();

/**
 * Computes the SHA-256 hash of `normalizeSerializedChatForBackupComparison(data)` without splitting
 * the entire serialized chat string or copying the body rows.
 * Matches legacy `normalizeSerializedChatForBackupComparison` byte-for-byte.
 * @param {string|Buffer} data Serialized chat JSONL
 * @returns {string} Hex SHA-256 digest
 */
export function computeNormalizedBackupHash(data) {
    const serialized = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
    const firstNewline = serialized.indexOf('\n');
    const firstLine = firstNewline === -1 ? serialized : serialized.slice(0, firstNewline);

    if (!firstLine) {
        return computeSha256(serialized);
    }

    try {
        const header = JSON.parse(firstLine);
        if (!isPlainObject(header?.chat_metadata)) {
            return computeSha256(serialized);
        }

        const chatMetadata = { ...header.chat_metadata };
        delete chatMetadata.integrity;
        const normalizedFirstLine = JSON.stringify({ ...header, chat_metadata: chatMetadata });
        const hash = crypto.createHash('sha256');
        hash.update(normalizedFirstLine);
        if (firstNewline !== -1) {
            hash.update(serialized.slice(firstNewline));
        }
        return hash.digest('hex');
    } catch {
        return computeSha256(serialized);
    }
}

function isRetryableWindowsWriteError(error) {
    return process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
}

function sleepSync(delayMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function runWithWindowsRetries(operation) {
    let lastError;
    for (let attempt = 0; attempt <= WINDOWS_RETRY_DELAYS_MS.length; attempt++) {
        try {
            return { ok: true, value: operation() };
        } catch (error) {
            if (!isRetryableWindowsWriteError(error)) {
                throw error;
            }
            lastError = error;
            if (attempt < WINDOWS_RETRY_DELAYS_MS.length) {
                sleepSync(WINDOWS_RETRY_DELAYS_MS[attempt]);
            }
        }
    }
    return { ok: false, error: lastError };
}

function writeAllSync(fileDescriptor, data, position = 0) {
    let offset = 0;
    while (offset < data.byteLength) {
        const bytesWritten = fs.writeSync(fileDescriptor, data, offset, data.byteLength - offset, position + offset);
        if (bytesWritten === 0) {
            throw new Error('Could not finish writing the file.');
        }
        offset += bytesWritten;
    }
}

function resizeFileSync(fileDescriptor, size) {
    if (fs.fstatSync(fileDescriptor, { bigint: true }).size !== BigInt(size)) {
        fs.ftruncateSync(fileDescriptor, size);
    }
}

function safeLstatTuple(filePath) {
    try {
        return extractStatTuple(fs.lstatSync(filePath, { bigint: true }));
    } catch {
        return null;
    }
}

/**
 * Atomically writes a durable file with exactly ONE file fsync (inside `write-file-atomic`)
 * plus one directory fsync on POSIX, avoiding the duplicate re-open + fsync performed by `tryWriteFileSync(..., { durable: true })`.
 * @param {string} filePath Target path
 * @param {string|Buffer} data File contents
 * @param {string|object} [options] Encoding or options passed to `write-file-atomic`
 * @returns {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }|null} Post-write stat tuple
 */
export function writeDurableAtomicFileSync(filePath, data, options = undefined) {
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }

    const atomicResult = runWithWindowsRetries(() => writeFileAtomicSync(filePath, data, options));
    if (atomicResult.ok) {
        fsyncDirectorySync(directory);
        return safeLstatTuple(filePath);
    }

    const encoding = typeof options === 'string' ? options : options?.encoding || 'utf8';
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
    const createdTempPaths = new Set();
    let tempFilePath = null;
    try {
        const writeTempResult = runWithWindowsRetries(() => {
            const candidatePath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
            const fd = fs.openSync(candidatePath, 'wx');
            createdTempPaths.add(candidatePath);
            try {
                writeAllSync(fd, dataBuffer);
                resizeFileSync(fd, dataBuffer.byteLength);
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            tempFilePath = candidatePath;
        });
        if (!writeTempResult.ok) {
            throw writeTempResult.error;
        }
        const renameResult = runWithWindowsRetries(() => fs.renameSync(tempFilePath, filePath));
        if (renameResult.ok) {
            createdTempPaths.delete(tempFilePath);
            fsyncDirectorySync(directory);
            return safeLstatTuple(filePath);
        }

        // Never fall back to in-place copyFileSync when target is hard-linked (nlink > 1), a symlink,
        // or non-regular: copyFileSync mutates the existing inode and would corrupt hard-linked pre-write backups.
        const assertSafeForInPlaceCopy = () => {
            let targetStats = null;
            try {
                targetStats = fs.lstatSync(filePath, { bigint: true });
            } catch (statError) {
                if (statError?.code !== 'ENOENT') {
                    throw renameResult.error;
                }
            }
            if (targetStats && (targetStats.isSymbolicLink() || !targetStats.isFile() || targetStats.nlink !== 1n)) {
                throw renameResult.error;
            }
        };
        assertSafeForInPlaceCopy();

        const copyResult = runWithWindowsRetries(() => {
            assertSafeForInPlaceCopy();
            fs.copyFileSync(tempFilePath, filePath);
            const fd = fs.openSync(filePath, 'r+');
            try {
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
        });
        if (copyResult.ok) {
            fsyncDirectorySync(directory);
            return safeLstatTuple(filePath);
        }
        throw copyResult.error;
    } finally {
        for (const candidatePath of createdTempPaths) {
            try {
                fs.unlinkSync(candidatePath);
            } catch {
                // Best-effort cleanup of temp file.
            }
        }
    }
}

/**
 * Atomically writes a non-durable backup file (with `fsync: false`) from memory, preserving Windows retries.
 * @param {string} filePath Target path
 * @param {string|Buffer} data File contents
 * @param {string} [encoding]
 * @returns {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }|null}
 */
export function writeNonDurableAtomicFileSync(filePath, data, encoding = 'utf8') {
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }

    const atomicOptions = Buffer.isBuffer(data) ? { fsync: false } : { encoding, fsync: false };
    const atomicResult = runWithWindowsRetries(() => writeFileAtomicSync(filePath, data, atomicOptions));
    if (atomicResult.ok) {
        return safeLstatTuple(filePath);
    }

    const tempFilePath = `${filePath}.tmp`;
    try {
        const writeTempResult = runWithWindowsRetries(() => fs.writeFileSync(tempFilePath, data, encoding));
        if (!writeTempResult.ok) {
            throw writeTempResult.error;
        }
        const renameResult = runWithWindowsRetries(() => fs.renameSync(tempFilePath, filePath));
        if (renameResult.ok) {
            return safeLstatTuple(filePath);
        }
        const copyResult = runWithWindowsRetries(() => fs.copyFileSync(tempFilePath, filePath));
        if (copyResult.ok) {
            return safeLstatTuple(filePath);
        }
        const directResult = runWithWindowsRetries(() => fs.writeFileSync(filePath, data, encoding));
        if (directResult.ok) {
            return safeLstatTuple(filePath);
        }
        throw directResult.error;
    } finally {
        try {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        } catch {
            // Best-effort cleanup of temp file.
        }
    }
}

/**
 * Tracks active chat paths whose Barrier #3 byte-0 restore was intentionally deferred to OS writeback
 * while a durable `.latest.jsonl` redo snapshot guarantees crash recovery.
 * Any recovery eviction/clear/rekey flushes the corresponding active file before dropping `.latest.jsonl`.
 * @type {Map<string, { activePath: string, latestKey: string|null }>}
 */
const dirtyByte0ByActiveKey = new Map();
/** @type {Map<string, string>} */
const dirtyByte0ActiveKeyByLatestKey = new Map();

function removeDirtyByte0Entry(activeKey) {
    const entry = dirtyByte0ByActiveKey.get(activeKey);
    if (!entry) {
        return;
    }
    dirtyByte0ByActiveKey.delete(activeKey);
    if (entry.latestKey && dirtyByte0ActiveKeyByLatestKey.get(entry.latestKey) === activeKey) {
        dirtyByte0ActiveKeyByLatestKey.delete(entry.latestKey);
    }
}

function fsyncRegularActiveFileSync(filePath) {
    let pathStats;
    try {
        pathStats = fs.lstatSync(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
        return false;
    }
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const flushOp = () => {
        const fd = fs.openSync(filePath, fs.constants.O_RDWR | noFollow);
        try {
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    };
    const retryResult = runWithWindowsRetries(flushOp);
    if (!retryResult.ok) {
        throw retryResult.error;
    }
    return true;
}

/**
 * Records an active chat path whose restored byte 0 has not yet been explicitly fsynced.
 * @param {string} activePath
 * @param {string|null} [recoveryLatestPath]
 */
export function markActiveFileDirtyByte0(activePath, recoveryLatestPath = null) {
    if (!activePath) {
        return;
    }
    const activeKey = getCanonicalChatCacheKey(activePath);
    removeDirtyByte0Entry(activeKey);
    const latestKey = recoveryLatestPath ? getCanonicalChatCacheKey(recoveryLatestPath) : null;
    dirtyByte0ByActiveKey.set(activeKey, { activePath, latestKey });
    if (latestKey) {
        dirtyByte0ActiveKeyByLatestKey.set(latestKey, activeKey);
    }
    while (dirtyByte0ByActiveKey.size > DIRTY_BYTE0_TRACKING_MAX) {
        const oldestKey = dirtyByte0ByActiveKey.keys().next().value;
        const oldestEntry = dirtyByte0ByActiveKey.get(oldestKey);
        removeDirtyByte0Entry(oldestKey);
        if (oldestEntry) {
            try {
                fsyncRegularActiveFileSync(oldestEntry.activePath);
            } catch {
                // Best-effort eviction flush.
            }
        }
    }
}

/**
 * Clears dirty byte-0 tracking for an active chat path after a full durable write or deletion.
 * @param {string} activePath
 */
export function clearDirtyByte0ActiveFile(activePath) {
    if (!activePath) {
        return;
    }
    removeDirtyByte0Entry(getCanonicalChatCacheKey(activePath));
}

/**
 * Synchronously fsyncs `activePath` if it has a pending un-fsynced Barrier #3 byte-0 restore,
 * then clears it from tracking. Returns true if an fsync was performed.
 * @param {string} activePath
 * @param {string|null} [fallbackActivePath] Alternate path if the file was already renamed (e.g. rekey)
 * @returns {boolean}
 */
export function flushDirtyByte0ActiveFileSync(activePath, fallbackActivePath = null) {
    if (!activePath) {
        return false;
    }
    const activeKey = getCanonicalChatCacheKey(activePath);
    const entry = dirtyByte0ByActiveKey.get(activeKey);
    if (!entry) {
        return false;
    }
    let flushed = false;
    try {
        flushed = fsyncRegularActiveFileSync(entry.activePath);
        if (!flushed && fallbackActivePath) {
            flushed = fsyncRegularActiveFileSync(fallbackActivePath);
        }
    } finally {
        removeDirtyByte0Entry(activeKey);
    }
    return flushed;
}

/**
 * Flushes any dirty byte-0 active chat associated with `recoveryLatestPath` before that
 * `.latest.jsonl` redo snapshot is pruned, removed, or rekeyed.
 * @param {string} recoveryLatestPath
 * @returns {boolean}
 */
export function flushDirtyByte0ForRecoveryPathSync(recoveryLatestPath) {
    if (!recoveryLatestPath) {
        return false;
    }
    const latestKey = getCanonicalChatCacheKey(recoveryLatestPath);
    const activeKey = dirtyByte0ActiveKeyByLatestKey.get(latestKey);
    if (!activeKey) {
        return false;
    }
    const entry = dirtyByte0ByActiveKey.get(activeKey);
    if (!entry) {
        dirtyByte0ActiveKeyByLatestKey.delete(latestKey);
        return false;
    }
    let flushed = false;
    try {
        flushed = fsyncRegularActiveFileSync(entry.activePath);
    } finally {
        removeDirtyByte0Entry(activeKey);
    }
    return flushed;
}

/**
 * Resets dirty byte-0 tracking state (for test isolation).
 */
export function clearDirtyByte0Tracking() {
    dirtyByte0ByActiveKey.clear();
    dirtyByte0ActiveKeyByLatestKey.clear();
}

/**
 * Returns the number of tracked active chat files awaiting byte-0 flush.
 * @returns {number}
 */
export function getDirtyByte0TrackingCount() {
    return dirtyByte0ByActiveKey.size;
}

/**
 * Identity-preserving in-place chat writer used ONLY when a durable redo snapshot (`.latest.jsonl`)
 * has already been stored (Invariants I2, I3, I4).
 *
 * Crash-durability barriers preserved:
 * - Barrier #1: write poisoned byte 0 (`dataBuffer[0] ^ 0xFF`) + `fsyncSync(fd)`
 * - Barrier #2: write body bytes `[1..end]` + `ftruncateSync` + `fsyncSync(fd)`
 * - Restore byte 0: write `dataBuffer[0]` (Barrier #3 is omitted because durable `.latest.jsonl`
 *   already holds the exact new bytes; a power cut before byte 0 reaches disk leaves byte 0 poisoned
 *   from Barrier #1 and triggers exact recovery from `.latest.jsonl`. Any later recovery eviction,
 *   clear, or rekey flushes the active file first via `flushDirtyByte0*`).
 *
 * When a reliable pre-verified `expectedStatTuple` is provided, verifies all 5 stat fields on the
 * open file descriptor and path instead of re-reading and re-hashing the active file.
 *
 * @param {string} filePath Active chat path
 * @param {Buffer} dataBuffer New UTF-8 JSONL bytes
 * @param {{
 *   expectedFileIdentity?: { dev: bigint, ino: bigint },
 *   expectedFileHash?: string,
 *   expectedStatTuple?: { dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }|null,
 *   getRollbackBuffer?: () => Buffer,
 *   recoveryLatestPath?: string|null,
 * }} options
 * @returns {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }} Post-write stat tuple
 */
export function writeChatFileInPlaceFast(filePath, dataBuffer, {
    expectedFileIdentity = undefined,
    expectedFileHash = undefined,
    expectedStatTuple = null,
    getRollbackBuffer = undefined,
    recoveryLatestPath = null,
} = {}) {
    const dataLength = dataBuffer.byteLength;

    const writeInPlace = () => {
        const fileDescriptor = fs.openSync(filePath, 'r+');
        let operationFailed = false;
        let targetMutated = false;
        let readOriginalData = null;

        try {
            const descriptorStats = fs.fstatSync(fileDescriptor, { bigint: true });
            const pathStats = fs.lstatSync(filePath, { bigint: true });
            const matchesExpectedIdentity = !expectedFileIdentity
                || (descriptorStats.dev === expectedFileIdentity.dev && descriptorStats.ino === expectedFileIdentity.ino);
            if (!descriptorStats.isFile() || !pathStats.isFile()
                || descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino
                || !matchesExpectedIdentity) {
                throw Object.assign(new Error(`Refused to overwrite a replaced file: ${filePath}`), { code: 'ESTALE' });
            }
            if (descriptorStats.nlink !== 1n || pathStats.nlink !== 1n) {
                throw Object.assign(new Error(`Refused to overwrite a hard-linked file: ${filePath}`), { code: 'EMLINK' });
            }

            const descriptorTuple = extractStatTuple(descriptorStats);
            const pathTuple = extractStatTuple(pathStats);
            if (expectedStatTuple && isReliableStatTuple(expectedStatTuple)) {
                if (!statTuplesEqual(descriptorTuple, expectedStatTuple) || !statTuplesEqual(pathTuple, expectedStatTuple)) {
                    throw Object.assign(new Error(`Refused to overwrite a changed file: ${filePath}`), { code: 'ESTALE' });
                }
            } else if (expectedFileHash) {
                readOriginalData = Buffer.alloc(Number(descriptorStats.size));
                let offset = 0;
                while (offset < readOriginalData.byteLength) {
                    const bytesRead = fs.readSync(fileDescriptor, readOriginalData, offset, readOriginalData.byteLength - offset, offset);
                    if (bytesRead === 0) break;
                    offset += bytesRead;
                }
                if (computeSha256(readOriginalData) !== expectedFileHash) {
                    throw Object.assign(new Error(`Refused to overwrite a changed file: ${filePath}`), { code: 'ESTALE' });
                }
            }

            if (dataLength > 0) {
                targetMutated = true;
                // Barrier #1: poison byte 0 and fsync so any crash during body write triggers snapshot recovery.
                writeAllSync(fileDescriptor, Buffer.from([dataBuffer[0] ^ 0xFF]));
                fs.fsyncSync(fileDescriptor);
                maybeInjectChatIoFault('after_barrier_1');

                // Barrier #2: write body + resize/truncate and fsync so complete payload is durable before restoring byte 0.
                if (dataLength > 1) {
                    const body = dataBuffer.subarray(1);
                    if (process.env.SB_FAULT_AT === 'during_body_write' && body.byteLength > 2) {
                        const half = Math.floor(body.byteLength / 2);
                        writeAllSync(fileDescriptor, body.subarray(0, half), 1);
                        maybeInjectChatIoFault('during_body_write');
                    }
                    writeAllSync(fileDescriptor, body, 1);
                }
                resizeFileSync(fileDescriptor, dataLength);
                fs.fsyncSync(fileDescriptor);
                maybeInjectChatIoFault('after_barrier_2');

                // Restore byte 0 without barrier #3; redo snapshot in .latest.jsonl already guarantees zero data loss.
                maybeInjectChatIoFault('before_restore_byte0');
                writeAllSync(fileDescriptor, dataBuffer.subarray(0, 1));
                maybeInjectChatIoFault('after_restore_byte0_before_close');
            }

            const finalDescriptorStats = fs.fstatSync(fileDescriptor, { bigint: true });
            const finalPathStats = fs.lstatSync(filePath, { bigint: true });
            if (finalDescriptorStats.dev !== finalPathStats.dev || finalDescriptorStats.ino !== finalPathStats.ino
                || finalDescriptorStats.nlink !== 1n || finalPathStats.nlink !== 1n) {
                throw Object.assign(new Error(`Refused to finish writing a replaced or hard-linked file: ${filePath}`), { code: 'ESTALE' });
            }

            if (dataLength > 0) {
                markActiveFileDirtyByte0(filePath, recoveryLatestPath);
            }

            return extractStatTuple(finalDescriptorStats);
        } catch (error) {
            operationFailed = true;
            if (targetMutated && ['EMLINK', 'ESTALE'].includes(error?.code)) {
                const rollbackData = readOriginalData ?? (typeof getRollbackBuffer === 'function' ? getRollbackBuffer() : null);
                if (rollbackData) {
                    try {
                        writeAllSync(fileDescriptor, rollbackData);
                        resizeFileSync(fileDescriptor, rollbackData.byteLength);
                        fs.fsyncSync(fileDescriptor);
                    } catch (rollbackError) {
                        throw new AggregateError([error, rollbackError], `Failed to write and restore ${filePath}.`);
                    }
                }
            }
            throw error;
        } finally {
            try {
                fs.closeSync(fileDescriptor);
            } catch (error) {
                if (!operationFailed) {
                    console.warn(`Failed to close ${filePath} after its data was flushed.`, error?.code);
                }
            }
        }
    };

    const retryResult = runWithWindowsRetries(writeInPlace);
    if (retryResult.ok) {
        return retryResult.value;
    }
    throw retryResult.error;
}

/**
 * Attempts to create a pre-write backup by hard-linking the already-durable `.latest.jsonl` snapshot
 * before the new snapshot is renamed into place (0 bytes copied, 0 data fsyncs).
 * Safely falls back on cross-device, permission, FAT/SAF, or unsupported-hardlink errors.
 *
 * @param {string} sourceLatestPath Path to `.latest.jsonl`
 * @param {string} destinationBackupPath Path to pre-write backup file
 * @param {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }} expectedSourceTuple
 * @param {number|null} newestExistingMtimeMs Mtime (ms) of the newest existing pre-write backup for this prefix, if any
 * @returns {{ linked: true, tuple: object|null, bumpedMtime: boolean } | { linked: false }}
 */
export function tryHardLinkPreWriteBackupSync(sourceLatestPath, destinationBackupPath, expectedSourceTuple, newestExistingMtimeMs = null) {
    if (!sourceLatestPath || !expectedSourceTuple || !isReliableStatTuple(expectedSourceTuple)) {
        return { linked: false };
    }

    let sourceStats;
    try {
        sourceStats = fs.lstatSync(sourceLatestPath, { bigint: true });
    } catch {
        return { linked: false };
    }
    if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
        return { linked: false };
    }
    if (!statTuplesEqual(extractStatTuple(sourceStats), expectedSourceTuple)) {
        return { linked: false };
    }

    try {
        fs.linkSync(sourceLatestPath, destinationBackupPath);
    } catch (error) {
        if (HARDLINK_FALLBACK_ERROR_CODES.has(error?.code)) {
            return { linked: false };
        }
        throw error;
    }

    let bumpedMtime = false;
    const sourceMtimeMs = Number(sourceStats.mtimeNs) / 1_000_000;
    const minTargetMtimeMs = Math.max(
        Date.now(),
        newestExistingMtimeMs !== null ? Math.ceil(newestExistingMtimeMs) + 1 : 0,
    );
    if (sourceMtimeMs < minTargetMtimeMs) {
        try {
            const targetTime = new Date(minTargetMtimeMs);
            fs.utimesSync(destinationBackupPath, targetTime, targetTime);
            bumpedMtime = true;
        } catch {
            // If mtime cannot be updated on the hard link, global mtime pruning could immediately
            // delete a brand-new pre-write backup of an older chat. Remove the link and fall back to copy.
            try {
                fs.unlinkSync(destinationBackupPath);
            } catch {
                // Best-effort cleanup before copy fallback.
            }
            return { linked: false };
        }
    }

    fsyncDirectorySync(path.dirname(destinationBackupPath));
    return {
        linked: true,
        tuple: safeLstatTuple(destinationBackupPath),
        bumpedMtime,
    };
}

/**
 * Finds the newest backup file matching `prefix` using a single stat per matching file (no O(N log N) stat calls
 * and never relying on timestamp filenames across DST/TZ changes).
 * @param {string} directory Backup directory
 * @param {string} prefix Filename prefix
 * @returns {{ fileName: string, filePath: string, mtimeNs: bigint, mtimeMs: number, tuple: object|null }|null}
 */
export function getLatestBackupFileInfo(directory, prefix) {
    let best = null;
    for (const fileName of fs.readdirSync(directory)) {
        if (!fileName.startsWith(prefix)) {
            continue;
        }
        const filePath = path.join(directory, fileName);
        const stats = fs.lstatSync(filePath, { bigint: true });
        const mtimeNs = stats.mtimeNs;
        if (!best
            || mtimeNs > best.mtimeNs
            || (mtimeNs === best.mtimeNs && fileName.localeCompare(best.fileName) > 0)) {
            best = {
                fileName,
                filePath,
                mtimeNs,
                mtimeMs: Number(mtimeNs) / 1_000_000,
                tuple: extractStatTuple(stats),
            };
        }
    }
    return best;
}

/**
 * Prunes old backup files matching `prefix` down to `limit` using a Schwartzian transform
 * (at most 1 `statSync` per matching file, sorted by mtime, never by filename timestamp).
 * @param {string} directory Backup directory
 * @param {string} prefix Filename prefix
 * @param {number} limit Maximum files to keep
 * @param {string[]} [excludedPrefixes] Prefixes to ignore
 */
export function pruneBackupsByPrefix(directory, prefix, limit, excludedPrefixes = []) {
    const safeLimit = Math.max(0, limit);
    const matchingFiles = fs.readdirSync(directory)
        .filter(file => file.startsWith(prefix) && !excludedPrefixes.some(excluded => file.startsWith(excluded)));

    if (matchingFiles.length <= safeLimit) {
        return;
    }

    const entries = matchingFiles.map(file => {
        const filePath = path.join(directory, file);
        return {
            filePath,
            mtimeMs: fs.statSync(filePath).mtimeMs,
        };
    });
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);

    const removeCount = entries.length - safeLimit;
    for (let index = 0; index < removeCount; index++) {
        fs.unlinkSync(entries[index].filePath);
    }
}
