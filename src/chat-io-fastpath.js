import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { fsyncDirectorySync } from './util.js';

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export const CHAT_STATE_CACHE_MAX_BYTES = process.env.SILLYBUNNY_ANDROID_APP === '1'
    ? 24 * 1024 * 1024
    : 96 * 1024 * 1024;

export const CHAT_INFO_CACHE_MAX_BYTES = process.env.SILLYBUNNY_ANDROID_APP === '1'
    ? 8 * 1024 * 1024
    : 32 * 1024 * 1024;

export const CHAT_INFO_CACHE_MAX_ENTRIES = 2000;
export const BACKUP_DEDUPE_CACHE_MAX_ENTRIES = 512;
/**
 * Timestamps that are all multiples of this value come from a volume that stores coarse timestamps:
 * whole seconds, the 2 second modification time of FAT, and the 10 ms units of FAT creation times and exFAT.
 * A filesystem that keeps nanoseconds produces such a value by chance only about once in 10^7 stamps.
 */
export const COARSE_TIMESTAMP_MODULO_NS = 10_000_000n;

/**
 * A filesystem stamps a write with a clock that advances once per tick, so two writes within one tick
 * leave the same (mtime, ctime). A cached tuple therefore proves "unchanged" only when the cache validated
 * the file at least this long after the file's newest timestamp. Any later write then falls into a later tick.
 * The margin must stay above the coarsest tick of a supported platform (Linux 4 to 10 ms, Windows about 16 ms).
 */
export const STAT_TIMESTAMP_RACY_MARGIN_NS = 100_000_000n;

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
 * Returns true only when all 5 stat fields are non-zero and the timestamps do not look like those of a coarse volume
 * (see `COARSE_TIMESTAMP_MODULO_NS`).
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
 * Wall-clock time in nanoseconds, comparable with file timestamps of a local filesystem.
 * @returns {bigint}
 */
export function currentTimeNs() {
    return BigInt(Date.now()) * 1_000_000n;
}

/**
 * Attaches the instant at which a stat tuple was validated against the file's content.
 * Take `validatedAtNs` before the content was read, or right after the stat of a file this process wrote.
 * @template {object} T
 * @param {T|null|undefined} tuple
 * @param {bigint} [validatedAtNs]
 * @returns {(T & { validatedAtNs: bigint })|null}
 */
export function withValidationTime(tuple, validatedAtNs = currentTimeNs()) {
    return tuple ? { ...tuple, validatedAtNs } : null;
}

function toTimestampNs(value) {
    return typeof value === 'bigint' ? value : BigInt(Math.round(Number(value) * 1_000_000));
}

/**
 * Returns true when a write that happened after the tuple was validated could still leave the same
 * (mtime, ctime) as `tuple`, so that an equal stat tuple does not prove that the content is unchanged.
 * A tuple without a validation time, or with timestamps ahead of it, is racy.
 * @param {{ mtimeNs: bigint|number, ctimeNs: bigint|number, validatedAtNs?: bigint }|null|undefined} tuple
 * @returns {boolean}
 */
export function isStatTupleRacy(tuple) {
    if (!tuple || typeof tuple.validatedAtNs !== 'bigint') {
        return true;
    }
    const mtimeNs = toTimestampNs(tuple.mtimeNs);
    const ctimeNs = toTimestampNs(tuple.ctimeNs);
    const newestNs = mtimeNs > ctimeNs ? mtimeNs : ctimeNs;
    return tuple.validatedAtNs - newestNs < STAT_TIMESTAMP_RACY_MARGIN_NS;
}

/**
 * Reads a regular file and checks that its bytes still hash to `expectedSha256`. Used to confirm a racy cache
 * hit (see `isStatTupleRacy`), where an equal stat tuple cannot rule out a write that kept the tuple.
 * The validation time is taken before the read starts, because a write that lands during the read can
 * leave the content this function hashed behind the timestamps it reports.
 * @param {string} filePath
 * @param {string|null|undefined} expectedSha256
 * @param {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }|null} [expectedTuple] When given, the file must also still carry this stat tuple
 * @returns {{ tuple: { dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }, validatedAtNs: bigint }|null} The stat tuple of the file and the time of its validation, or null when the content is not the expected one or could not be read stably
 */
export function confirmFileContentSync(filePath, expectedSha256, expectedTuple = null) {
    if (!expectedSha256) {
        return null;
    }
    const validatedAtNs = currentTimeNs();
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const initialStats = fs.fstatSync(descriptor, { bigint: true });
        if (!initialStats.isFile()) {
            return null;
        }
        const data = fs.readFileSync(descriptor);
        const tuple = extractStatTuple(fs.fstatSync(descriptor, { bigint: true }));
        if (!statTuplesEqual(extractStatTuple(initialStats), tuple)
            || (expectedTuple && !statTuplesEqual(tuple, expectedTuple))
            || computeSha256(data) !== expectedSha256) {
            return null;
        }
        return { tuple, validatedAtNs };
    } catch {
        return null;
    } finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // The content check already has its result.
            }
        }
    }
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
    const coarseModuloMs = Number(COARSE_TIMESTAMP_MODULO_NS / 1_000_000n);
    const isCoarseMtime = Number.isInteger(stats.mtimeMs) && stats.mtimeMs % coarseModuloMs === 0;
    const isCoarseCtime = Number.isInteger(stats.ctimeMs) && stats.ctimeMs % coarseModuloMs === 0;
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
 * Returns a copy of the exact raw Buffer bytes of a ChatStateCache entry, so the caller can change it freely.
 * @param {object} entry
 * @returns {Buffer}
 */
export function getEntryRawBuffer(entry) {
    if (entry.rawBuffer) {
        return Buffer.from(entry.rawBuffer);
    }
    return Buffer.from(entry.lines.join('\n'), 'utf8');
}

function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}

/**
 * Copies the parts of an entry that a caller can also hold, so that nothing a caller does to its own objects
 * reaches the cache and nothing that the cache hands out can be used to change it. The header is stored as the
 * JSON round trip of the caller's header, which is what a fresh read of the saved row produces.
 * @param {{ header?: object|null, lines?: string[], rawBuffer?: Buffer|null }} entryData
 */
function isolateChatStateEntryData(entryData) {
    return {
        header: entryData.header ? deepFreeze(JSON.parse(JSON.stringify(entryData.header))) : entryData.header,
        lines: Array.isArray(entryData.lines) ? Object.freeze([...entryData.lines]) : entryData.lines,
        rawBuffer: entryData.rawBuffer ? Buffer.from(entryData.rawBuffer) : entryData.rawBuffer,
    };
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
     * is reliable and matches the cached entry exactly. An entry validated within the racy-timestamp
     * margin of its file's newest timestamp is served only after its bytes are read and hashed again;
     * the entry is dropped when they differ.
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
        if (isStatTupleRacy(entry)) {
            const confirmed = confirmFileContentSync(filePath, entry.sha256, tuple);
            if (!confirmed) {
                this.invalidate(filePath);
                return null;
            }
            entry.validatedAtNs = confirmed.validatedAtNs;
        }
        return entry;
    }

    /**
     * Stores or replaces an entry for `filePath`, evicting LRU entries to remain within `maxBytes`.
     * `entryData.validatedAtNs` is the time at which the entry's content was read or written (see `withValidationTime`).
     * The entry keeps its own copies of `header`, `lines` and `rawBuffer`; the header and the lines are frozen.
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
            ...isolateChatStateEntryData(entryData),
            validatedAtNs: typeof entryData.validatedAtNs === 'bigint' ? entryData.validatedAtNs : currentTimeNs(),
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
     * Caches a summary only when the file's timestamps leave no racy window: a summary has no content hash to
     * confirm a later hit with, so a file changed within the margin before `validatedAtNs` is not cached.
     * @param {string} filePath
     * @param {import('node:fs').Stats} stats Stat taken before the file was scanned
     * @param {object} infoEntry
     * @param {bigint} [validatedAtNs] Time taken before `stats` was read
     */
    set(filePath, stats, infoEntry, validatedAtNs = currentTimeNs()) {
        const tuple = extractChatInfoStatTuple(stats);
        if (!tuple || isStatTupleRacy({ ...tuple, validatedAtNs }) || this.maxEntries <= 0 || this.maxBytes <= 0) {
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
        const tuple = extractStatTuple(fs.lstatSync(filePath, { bigint: true }));
        return withValidationTime(tuple);
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
 * Atomically writes a backup file from memory, preserving Windows retries. `write-file-atomic` fsyncs the
 * temporary file before the rename, so a power cut cannot leave a zero-length or partial backup under its
 * final name. The directory is not fsynced, so a power cut can lose the newest backup but not corrupt it.
 * @param {string} filePath Target path
 * @param {string|Buffer} data File contents
 * @param {string} [encoding]
 * @returns {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }|null}
 */
export function writeAtomicBackupFileSync(filePath, data, encoding = 'utf8') {
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }

    const atomicOptions = Buffer.isBuffer(data) ? {} : { encoding };
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
 * Identity-preserving in-place chat writer used ONLY when a durable redo snapshot (`.latest.jsonl`)
 * has already been stored (Invariants I2, I3, I4).
 *
 * Crash-durability barriers:
 * - Barrier #1: write poisoned byte 0 (`dataBuffer[0] ^ 0xFF`) + `fsyncSync(fd)`
 * - Barrier #2: write body bytes `[1..end]` + `ftruncateSync` + `fsyncSync(fd)`
 * - Barrier #3: restore byte 0 (`dataBuffer[0]`) + `fsyncSync(fd)`
 *
 * Barrier #3 makes the complete, valid file reach the disk before the save is acknowledged. Without
 * it a power cut after the response can leave the poisoned byte 0 on disk. Recovery would repair
 * that from `.latest.jsonl` when the chat is opened, but every reader that does not go through
 * recovery (chat lists, export, other tools) would see an unparseable file until then.
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
 * }} options
 * @returns {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }} Post-write stat tuple
 */
export function writeChatFileInPlaceFast(filePath, dataBuffer, {
    expectedFileIdentity = undefined,
    expectedFileHash = undefined,
    expectedStatTuple = null,
    getRollbackBuffer = undefined,
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

                // Barrier #3: restore byte 0 and fsync, so the valid file is on disk before the save is acknowledged.
                maybeInjectChatIoFault('before_restore_byte0');
                writeAllSync(fileDescriptor, dataBuffer.subarray(0, 1));
                maybeInjectChatIoFault('after_restore_byte0_before_close');
                try {
                    fs.fsyncSync(fileDescriptor);
                } catch (error) {
                    try {
                        // A byte 0 that may not have reached the disk must not pass for a complete file.
                        writeAllSync(fileDescriptor, Buffer.from([dataBuffer[0] ^ 0xFF]));
                        fs.fsyncSync(fileDescriptor);
                    } catch {
                        // The original flush error is more useful; recovery still has the exact snapshot.
                    }
                    throw error;
                }
            }

            const finalDescriptorStats = fs.fstatSync(fileDescriptor, { bigint: true });
            const finalPathStats = fs.lstatSync(filePath, { bigint: true });
            if (finalDescriptorStats.dev !== finalPathStats.dev || finalDescriptorStats.ino !== finalPathStats.ino
                || finalDescriptorStats.nlink !== 1n || finalPathStats.nlink !== 1n) {
                throw Object.assign(new Error(`Refused to finish writing a replaced or hard-linked file: ${filePath}`), { code: 'ESTALE' });
            }

            return withValidationTime(extractStatTuple(finalDescriptorStats));
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
 * @param {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint, validatedAtNs?: bigint }} expectedSourceTuple
 * @param {number|null} newestExistingMtimeMs Mtime (ms) of the newest existing pre-write backup for this prefix, if any
 * @param {string|null} [expectedSourceSha256] SHA-256 of the source bytes. A source whose tuple is racy is linked only after its bytes are read and match this hash.
 * @returns {{ linked: true, tuple: object|null, bumpedMtime: boolean } | { linked: false }}
 */
export function tryHardLinkPreWriteBackupSync(sourceLatestPath, destinationBackupPath, expectedSourceTuple, newestExistingMtimeMs = null, expectedSourceSha256 = null) {
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
    // The backup must hold the pre-image of the chat. A source that an external write could have changed
    // without changing its tuple is copied from memory by the caller instead of linked.
    if (isStatTupleRacy(expectedSourceTuple) && !confirmFileContentSync(sourceLatestPath, expectedSourceSha256, expectedSourceTuple)) {
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
