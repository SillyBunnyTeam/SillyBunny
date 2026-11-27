import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import sanitize from 'sanitize-filename';
import { acquireChatFileLock } from './chat-file-lock.js';
import {
    chatInfoCache,
    chatStateCache,
    computeSha256,
    extractStatTuple,
    getEntryRawBuffer,
    isReliableStatTuple,
    statTuplesEqual,
    writeDurableAtomicFileSync,
} from './chat-io-fastpath.js';
import { fsyncDirectorySync, recoverFileWriteSync } from './util.js';

export const CHAT_RECOVERY_DIRECTORY = '_chat_recovery';
export const CHAT_RECOVERY_QUARANTINE_LIMIT = 3;
export const CHAT_RAW_ROWS_SYMBOL = Symbol('chatRawRows');
export const CHAT_HEADER_FIXED_UP_SYMBOL = Symbol('chatHeaderFixedUp');

const CHAT_ORIGINAL_HEADER_SYMBOL = Symbol('chatOriginalHeader');
const CHAT_IS_CANONICAL_SYMBOL = Symbol('chatIsCanonical');
const GROUP_CHAT_OWNER = 'shared';
const ROOT_DIRECTORY_LABELS = Object.freeze({
    character: 'Chats directory',
    group: 'Group chats directory',
    conversation: 'Conversations directory',
});
const ROOT_DIRECTORY_KEYS = Object.freeze({
    character: 'chatsDirectory',
    group: 'groupChatsDirectory',
    conversation: 'conversationsDirectory',
});
const RECOVERY_STATE_FILE_REGEXP = /^([a-f0-9]{64})\.(?:latest\.jsonl|deleted|corrupt-\d+\.jsonl)$/;
const LATEST_SNAPSHOT_META_CACHE_MAX = 512;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const rekeyTransactions = new WeakMap();
/** @type {Set<string>} */
const tombstonesMayExist = new Set();
/** @type {Map<string, number>} */
const lastPrunedLimitByDir = new Map();
/** @type {Map<string, { tuple: { dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }|null, sha256: string }>} */
const latestSnapshotMetaCache = new Map();

function getLatestSnapshotMeta(latestPath) {
    const entry = latestSnapshotMetaCache.get(latestPath);
    if (!entry) {
        return null;
    }
    latestSnapshotMetaCache.delete(latestPath);
    latestSnapshotMetaCache.set(latestPath, entry);
    return entry;
}

function setLatestSnapshotMeta(latestPath, tuple, sha256) {
    latestSnapshotMetaCache.delete(latestPath);
    latestSnapshotMetaCache.set(latestPath, { tuple, sha256 });
    while (latestSnapshotMetaCache.size > LATEST_SNAPSHOT_META_CACHE_MAX) {
        const oldestKey = latestSnapshotMetaCache.keys().next().value;
        latestSnapshotMetaCache.delete(oldestKey);
    }
}

function deleteLatestSnapshotMeta(latestPath) {
    latestSnapshotMetaCache.delete(latestPath);
}

/**
 * Resets in-memory recovery tracking caches (for test isolation).
 */
export function clearChatRecoveryRuntimeCaches() {
    tombstonesMayExist.clear();
    lastPrunedLimitByDir.clear();
    latestSnapshotMetaCache.clear();
}

function acquireRecoveryStateLock(target) {
    assertRecoveryDirectory(target, { create: true });
    return acquireChatFileLock(path.join(target.recoveryDirectory, '.sillybunny-recovery-state'));
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Matches the standard metadata header and the legacy headers accepted by the JSONL importer.
 * @param {unknown} record Parsed first JSONL record.
 * @returns {boolean} Whether the record is a recognized chat header.
 */
export function isRecognizedChatHeader(record) {
    if (!isPlainObject(record)) {
        return false;
    }
    if (record.chat_metadata !== undefined) {
        return isPlainObject(record.chat_metadata);
    }
    return record.user_name !== undefined || record.name !== undefined;
}

function corruptResult(reason, data = null, details = {}) {
    return {
        status: 'corrupt',
        reason,
        data,
        records: null,
        ...details,
    };
}

/**
 * Runs supplementary recovery work without allowing sidecar failures to block authoritative chat operations.
 * @template T
 * @param {() => T} operation Recovery operation
 * @param {string} warningMessage Warning emitted when the operation fails
 * @returns {{ok: true, value: T}|{ok: false, error: unknown}} Operation result
 */
export function runChatRecoveryBestEffort(operation, warningMessage) {
    try {
        return { ok: true, value: operation() };
    } catch (error) {
        console.warn(warningMessage, error);
        return { ok: false, error };
    }
}

function readRegularFile(filePath, { includeStats = false } = {}) {
    let pathStats;
    try {
        pathStats = fs.lstatSync(filePath, includeStats ? { bigint: true } : undefined);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { status: 'missing', data: null };
        }
        return corruptResult('read-error', null, { errorCode: error?.code });
    }

    if (pathStats.isSymbolicLink()) {
        return corruptResult('symlink');
    }
    if (!pathStats.isFile()) {
        return corruptResult('non-regular');
    }

    let descriptor;
    try {
        const noFollow = fs.constants.O_NOFOLLOW ?? 0;
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
        const descriptorStats = fs.fstatSync(descriptor, includeStats ? { bigint: true } : undefined);
        if (!descriptorStats.isFile()) {
            return corruptResult('non-regular');
        }
        if (pathStats.ino && descriptorStats.ino && (pathStats.dev !== descriptorStats.dev || pathStats.ino !== descriptorStats.ino)) {
            return corruptResult('changed-during-read');
        }
        const data = fs.readFileSync(descriptor);
        if (includeStats) {
            const finalDescriptorStats = fs.fstatSync(descriptor, { bigint: true });
            const descriptorChanged = finalDescriptorStats.dev !== descriptorStats.dev
                || finalDescriptorStats.ino !== descriptorStats.ino
                || finalDescriptorStats.size !== descriptorStats.size
                || finalDescriptorStats.mtimeNs !== descriptorStats.mtimeNs
                || finalDescriptorStats.ctimeNs !== descriptorStats.ctimeNs;
            if (descriptorChanged) {
                return corruptResult('changed-during-read');
            }
            return {
                status: 'ok',
                data,
                statTuple: extractStatTuple(finalDescriptorStats),
            };
        }
        return { status: 'ok', data };
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { status: 'missing', data: null };
        }
        if (error?.code === 'ELOOP') {
            return corruptResult('symlink');
        }
        return corruptResult('read-error', null, { errorCode: error?.code });
    } finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}

function toBuffer(data) {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (data instanceof Uint8Array) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === 'string') {
        return Buffer.from(data, 'utf8');
    }
    throw new TypeError('Chat JSONL data must be a string, Buffer, or Uint8Array.');
}

function attachChatFastMetadata(result, { rawRows, headerFixedUp, originalHeader, isCanonical }) {
    Object.defineProperties(result, {
        [CHAT_RAW_ROWS_SYMBOL]: { value: rawRows, enumerable: false, configurable: true },
        [CHAT_HEADER_FIXED_UP_SYMBOL]: { value: headerFixedUp, enumerable: false, configurable: true },
        [CHAT_ORIGINAL_HEADER_SYMBOL]: { value: originalHeader, enumerable: false, configurable: true },
        [CHAT_IS_CANONICAL_SYMBOL]: { value: isCanonical, enumerable: false, configurable: true },
    });
    return result;
}

export function parseChatJsonl(data) {
    const buffer = toBuffer(data);
    const hasBom = buffer.byteLength >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
    let serialized;
    try {
        serialized = utf8Decoder.decode(buffer);
    } catch {
        return corruptResult('invalid-utf8', data);
    }

    const records = [];
    const rawRows = [];
    const lines = serialized.split('\n');
    let hasBlankOrCr = false;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.trim() === '') {
            hasBlankOrCr = true;
            continue;
        }

        const cleanLine = line.endsWith('\r') ? (hasBlankOrCr = true, line.slice(0, -1)) : line;

        let record;
        try {
            record = JSON.parse(cleanLine);
        } catch {
            return corruptResult('invalid-json', data, { line: index + 1 });
        }
        if (!isPlainObject(record)) {
            return corruptResult('non-object', data, { line: index + 1 });
        }
        records.push(record);
        rawRows.push(cleanLine);
    }

    if (records.length === 0) {
        return corruptResult('empty', data);
    }
    if (!isRecognizedChatHeader(records[0])) {
        return corruptResult('missing-chat-metadata', data);
    }
    const originalHeader = records[0];
    let headerFixedUp = false;
    if (!isPlainObject(records[0].chat_metadata)) {
        records[0] = { ...records[0], chat_metadata: {} };
        headerFixedUp = true;
    }

    const result = {
        status: 'ok',
        data,
        records,
    };
    return attachChatFastMetadata(result, {
        rawRows,
        headerFixedUp,
        originalHeader,
        isCanonical: !hasBom && !hasBlankOrCr,
    });
}

export function readChatJsonlStrict(filePath) {
    recoverFileWriteSync(filePath);
    const rawResult = readRegularFile(filePath);
    if (rawResult.status !== 'ok') {
        return {
            ...rawResult,
            records: null,
        };
    }
    return parseChatJsonl(rawResult.data);
}

function normalizeDirectory(directory, label) {
    if (typeof directory !== 'string' || directory.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    return path.resolve(directory);
}

function normalizeOwner(owner) {
    if (typeof owner !== 'string' || owner.length === 0 || owner === '.' || owner === '..' || owner.includes('\0') || /[\\/]/.test(owner)) {
        throw new TypeError('Character chat owner must be one safe path segment.');
    }
    return owner;
}

function normalizeFilename(filename) {
    if (typeof filename !== 'string' || filename.length === 0) {
        throw new TypeError('Chat filename must be a non-empty string.');
    }

    const sanitizedFilename = sanitize(filename);
    if (!sanitizedFilename) {
        throw new TypeError('Chat filename is empty after sanitization.');
    }
    return sanitizedFilename;
}

function normalizeMaxRecoveryStates(value) {
    if (value === undefined || value === null) {
        return null;
    }
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
        return null;
    }
    return Math.floor(numericValue);
}

function createTarget({ type, owner, filename, activeDirectory, backupDirectory, rootDirectoryKey, rootDirectory, maxRecoveryStates }) {
    const normalizedFilename = normalizeFilename(filename);
    const normalizedBackupDirectory = normalizeDirectory(backupDirectory, 'Backup directory');
    const normalizedRootDirectory = normalizeDirectory(rootDirectory, ROOT_DIRECTORY_LABELS[type]);
    const normalizedActiveDirectory = path.resolve(activeDirectory);
    const id = crypto.createHash('sha256')
        .update(type)
        .update('\0')
        .update(owner)
        .update('\0')
        .update(normalizedFilename)
        .digest('hex');

    return Object.freeze({
        type,
        owner,
        filename: normalizedFilename,
        [rootDirectoryKey]: normalizedRootDirectory,
        backupDirectory: normalizedBackupDirectory,
        activeDirectory: normalizedActiveDirectory,
        activePath: path.join(normalizedActiveDirectory, normalizedFilename),
        recoveryDirectory: path.join(normalizedBackupDirectory, CHAT_RECOVERY_DIRECTORY),
        maxRecoveryStates: normalizeMaxRecoveryStates(maxRecoveryStates),
        id,
    });
}

export function createCharacterChatTarget({ chatsDirectory, backupDirectory, owner, filename, maxRecoveryStates }) {
    const normalizedOwner = normalizeOwner(owner);
    const normalizedChatsDirectory = normalizeDirectory(chatsDirectory, 'Chats directory');
    return createTarget({
        type: 'character',
        owner: normalizedOwner,
        filename,
        activeDirectory: path.join(normalizedChatsDirectory, normalizedOwner),
        backupDirectory,
        rootDirectoryKey: 'chatsDirectory',
        rootDirectory: normalizedChatsDirectory,
        maxRecoveryStates,
    });
}

export function createGroupChatTarget({ groupChatsDirectory, backupDirectory, filename, maxRecoveryStates }) {
    const normalizedGroupChatsDirectory = normalizeDirectory(groupChatsDirectory, 'Group chats directory');
    return createTarget({
        type: 'group',
        owner: GROUP_CHAT_OWNER,
        filename,
        activeDirectory: normalizedGroupChatsDirectory,
        backupDirectory,
        rootDirectoryKey: 'groupChatsDirectory',
        rootDirectory: normalizedGroupChatsDirectory,
        maxRecoveryStates,
    });
}

/**
 * The chat of a conversation, which lives in its own folder under `conversations/`. The conversation id is the owner,
 * so a conversation chat never shares recovery state with a character chat or a group chat of the same file name.
 */
export function createConversationChatTarget({ conversationsDirectory, backupDirectory, owner, filename, maxRecoveryStates }) {
    const normalizedOwner = normalizeOwner(owner);
    const normalizedConversationsDirectory = normalizeDirectory(conversationsDirectory, ROOT_DIRECTORY_LABELS.conversation);
    return createTarget({
        type: 'conversation',
        owner: normalizedOwner,
        filename,
        activeDirectory: path.join(normalizedConversationsDirectory, normalizedOwner, 'chats'),
        backupDirectory,
        rootDirectoryKey: ROOT_DIRECTORY_KEYS.conversation,
        rootDirectory: normalizedConversationsDirectory,
        maxRecoveryStates,
    });
}

export function normalizeChatRecoveryTarget(target) {
    if (target?.type === 'character') {
        return createCharacterChatTarget(target);
    }
    if (target?.type === 'group') {
        return createGroupChatTarget(target);
    }
    if (target?.type === 'conversation') {
        return createConversationChatTarget(target);
    }
    throw new TypeError('Chat recovery target type must be "character", "group" or "conversation".');
}

export function getChatRecoveryPaths(target) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    const basePath = path.join(normalizedTarget.recoveryDirectory, normalizedTarget.id);
    return Object.freeze({
        directory: normalizedTarget.recoveryDirectory,
        latestPath: `${basePath}.latest.jsonl`,
        tombstonePath: `${basePath}.deleted`,
        quarantinePaths: Object.freeze(Array.from(
            { length: CHAT_RECOVERY_QUARANTINE_LIMIT },
            (_, index) => `${basePath}.corrupt-${index}.jsonl`,
        )),
    });
}

function assertSafeDirectory(directory, { create = false } = {}) {
    let stats;
    try {
        stats = fs.lstatSync(directory);
    } catch (error) {
        if (error?.code !== 'ENOENT' || !create) {
            if (error?.code === 'ENOENT') {
                return false;
            }
            throw error;
        }
        fs.mkdirSync(directory, { recursive: true });
        stats = fs.lstatSync(directory);
    }

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Unsafe chat recovery directory: ${directory}`);
    }
    return true;
}

function assertRecoveryDirectory(target, { create = false } = {}) {
    if (create) {
        assertSafeDirectory(target.backupDirectory, { create: true });
    }
    return assertSafeDirectory(target.recoveryDirectory, { create });
}

function assertWritableRegularPath(filePath) {
    try {
        const stats = fs.lstatSync(filePath);
        if (stats.isSymbolicLink() || !stats.isFile()) {
            throw new Error(`Unsafe chat recovery file: ${filePath}`);
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
}

function atomicWriteRecoveryFile(target, filePath, data) {
    assertRecoveryDirectory(target, { create: true });
    assertWritableRegularPath(filePath);
    return writeDurableAtomicFileSync(filePath, data);
}

function removeRegularFile(filePath) {
    try {
        const stats = fs.lstatSync(filePath);
        if (stats.isSymbolicLink() || !stats.isFile()) {
            throw new Error(`Unsafe chat recovery file: ${filePath}`);
        }
        fs.unlinkSync(filePath);
        fsyncDirectorySync(path.dirname(filePath));
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function setLastPrunedLimit(recoveryDirectory, limit) {
    lastPrunedLimitByDir.delete(recoveryDirectory);
    lastPrunedLimitByDir.set(recoveryDirectory, limit);
    while (lastPrunedLimitByDir.size > LATEST_SNAPSHOT_META_CACHE_MAX) {
        const oldestKey = lastPrunedLimitByDir.keys().next().value;
        lastPrunedLimitByDir.delete(oldestKey);
    }
}

function pruneRecoveryStates(target) {
    const limit = target.maxRecoveryStates;
    if (limit === null || !assertRecoveryDirectory(target)) {
        return false;
    }

    /** @type {Map<string, {id: string, mtimeMs: number, paths: string[]}>} */
    const groups = new Map();
    for (const name of fs.readdirSync(target.recoveryDirectory)) {
        const match = RECOVERY_STATE_FILE_REGEXP.exec(name);
        if (!match) {
            continue;
        }
        const filePath = path.join(target.recoveryDirectory, name);
        const stats = fs.lstatSync(filePath);
        if (stats.isSymbolicLink() || !stats.isFile()) {
            throw new Error(`Unsafe chat recovery file: ${filePath}`);
        }
        const id = match[1];
        const group = groups.get(id) ?? { id, mtimeMs: 0, paths: [] };
        group.mtimeMs = Math.max(group.mtimeMs, stats.mtimeMs);
        group.paths.push(filePath);
        groups.set(id, group);
    }

    const sortedGroups = [...groups.values()].sort((left, right) => {
        if (left.id === target.id && right.id !== target.id) {
            return -1;
        }
        if (right.id === target.id && left.id !== target.id) {
            return 1;
        }
        return right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id);
    });
    let targetPruned = false;
    for (const group of sortedGroups.slice(limit)) {
        if (group.id === target.id) {
            targetPruned = true;
        }
        for (const filePath of group.paths) {
            removeRegularFile(filePath);
            deleteLatestSnapshotMeta(filePath);
            tombstonesMayExist.delete(filePath);
        }
    }
    setLastPrunedLimit(target.recoveryDirectory, limit);
    return targetPruned;
}

function isTombstoned(target) {
    if (!assertRecoveryDirectory(target)) {
        return false;
    }

    const { tombstonePath } = getChatRecoveryPaths(target);
    const result = readRegularFile(tombstonePath);
    if (result.status === 'missing') {
        tombstonesMayExist.delete(tombstonePath);
        return false;
    }
    if (result.status !== 'ok') {
        throw new Error(`Unsafe chat recovery tombstone: ${tombstonePath}`);
    }
    tombstonesMayExist.add(tombstonePath);
    return true;
}

function isTombstoneAbsentFast(tombstonePath) {
    if (tombstonesMayExist.has(tombstonePath)) {
        return false;
    }
    try {
        fs.lstatSync(tombstonePath);
        tombstonesMayExist.add(tombstonePath);
        return false;
    } catch (error) {
        return error?.code === 'ENOENT';
    }
}

function isStoredSnapshotCurrent(latestPath, data) {
    const existing = readRegularFile(latestPath);
    return existing.status === 'ok' && toBuffer(existing.data).equals(toBuffer(data));
}

function storeValidSnapshotInternal(target, dataBuffer, { dataSha = undefined, cachedLatestTuple = null, cachedLatestSha = null } = {}) {
    const { latestPath, tombstonePath } = getChatRecoveryPaths(target);
    const sha = dataSha ?? computeSha256(dataBuffer);
    const release = acquireRecoveryStateLock(target);
    try {
        let existingStats = null;
        let createdNewRecoveryFile = false;
        try {
            existingStats = fs.lstatSync(latestPath, { bigint: true });
            if (existingStats.isSymbolicLink() || !existingStats.isFile()) {
                throw new Error(`Unsafe chat recovery file: ${latestPath}`);
            }
        } catch (error) {
            if (error?.code === 'ENOENT') {
                createdNewRecoveryFile = true;
            } else {
                throw error;
            }
        }

        const knownMeta = (cachedLatestTuple && cachedLatestSha)
            ? { tuple: cachedLatestTuple, sha256: cachedLatestSha }
            : getLatestSnapshotMeta(latestPath);

        let alreadyCurrent = false;
        let latestTuple = null;

        if (existingStats !== null) {
            const existingTuple = extractStatTuple(existingStats);
            const metaMatchesDisk = Boolean(
                knownMeta
                && isReliableStatTuple(knownMeta.tuple)
                && statTuplesEqual(existingTuple, knownMeta.tuple),
            );
            if (metaMatchesDisk) {
                alreadyCurrent = knownMeta.sha256 === sha;
            } else if (existingStats.size === BigInt(dataBuffer.byteLength)) {
                alreadyCurrent = isStoredSnapshotCurrent(latestPath, dataBuffer);
            }
            if (alreadyCurrent) {
                latestTuple = existingTuple;
            }
        }

        // SillyBunny: every chat load refreshes this snapshot, so an unchanged one would mean a disk
        // write on each open. Only the redundant write is dropped; clearing the tombstone and pruning
        // still run, because skipping those would leave a recoverable chat looking deleted.
        if (!alreadyCurrent) {
            latestTuple = atomicWriteRecoveryFile(target, latestPath, dataBuffer);
        }
        setLatestSnapshotMeta(latestPath, latestTuple, sha);

        removeRegularFile(tombstonePath);
        tombstonesMayExist.delete(tombstonePath);

        const limit = target.maxRecoveryStates;
        const previousLimit = lastPrunedLimitByDir.get(target.recoveryDirectory);
        const shouldPrune = limit !== null
            && (createdNewRecoveryFile || limit === 0 || previousLimit === undefined || limit < previousLimit);

        let targetPruned = false;
        if (shouldPrune) {
            targetPruned = pruneRecoveryStates(target);
        }

        if (targetPruned) {
            deleteLatestSnapshotMeta(latestPath);
            latestTuple = null;
        }

        return {
            stored: !targetPruned,
            latestTuple,
            latestSha: sha,
        };
    } finally {
        release();
    }
}

function storeValidSnapshot(target, parsed, options = {}) {
    return storeValidSnapshotInternal(target, toBuffer(parsed.data), options);
}

/**
 * Writes a pre-validated chat JSONL snapshot without re-parsing JSONL rows, re-reading unchanged/changed
 * snapshots when cached metadata matches, or performing a redundant post-write read-back or second file fsync.
 * Callers must only supply bytes generated by validated serialization or previously verified disk bytes.
 * @param {object} target Chat recovery target
 * @param {string|Buffer|Uint8Array} data Pre-validated chat JSONL bytes
 * @param {{ dataSha?: string, cachedLatestTuple?: object|null, cachedLatestSha?: string|null }} [options]
 * @returns {{ status: 'ok', data: Buffer, stored: boolean, latestTuple: object|null, latestSha: string }}
 */
export function writeLatestChatSnapshotTrusted(target, data, { dataSha = undefined, cachedLatestTuple = null, cachedLatestSha = null } = {}) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    const dataBuffer = toBuffer(data);
    const result = storeValidSnapshotInternal(normalizedTarget, dataBuffer, {
        dataSha,
        cachedLatestTuple,
        cachedLatestSha,
    });
    return {
        status: 'ok',
        data: dataBuffer,
        stored: result.stored,
        latestTuple: result.latestTuple,
        latestSha: result.latestSha,
    };
}

export function writeLatestChatSnapshot(target, data) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    const buffer = toBuffer(data);
    const parsed = parseChatJsonl(buffer);
    if (parsed.status !== 'ok') {
        throw new TypeError(`Invalid chat JSONL snapshot: ${parsed.reason}.`);
    }

    const result = storeValidSnapshotInternal(normalizedTarget, buffer);
    return { ...parsed, stored: result.stored };
}

export function removeLatestChatSnapshotIfMatches(target, expectedData) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    if (!assertRecoveryDirectory(normalizedTarget)) {
        return false;
    }

    const { latestPath } = getChatRecoveryPaths(normalizedTarget);
    const release = acquireRecoveryStateLock(normalizedTarget);
    try {
        if (!isStoredSnapshotCurrent(latestPath, expectedData)) {
            return false;
        }
        const removed = removeRegularFile(latestPath);
        if (removed) {
            deleteLatestSnapshotMeta(latestPath);
            chatStateCache.update(normalizedTarget.activePath, {
                latestTuple: null,
                latestSha: null,
                latestEqualsActive: false,
            });
        }
        return removed;
    } finally {
        release();
    }
}

export function seedLatestChatSnapshot(target) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    const active = readChatJsonlStrict(normalizedTarget.activePath);
    if (active.status !== 'ok') {
        return { ...active, seeded: false };
    }

    const stored = storeValidSnapshot(normalizedTarget, active);
    chatStateCache.update(normalizedTarget.activePath, {
        latestTuple: stored.latestTuple,
        latestSha: stored.latestSha,
        latestEqualsActive: stored.stored,
    });
    return { ...active, seeded: true };
}

export function isChatRecoverable(target) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    const inspection = runChatRecoveryBestEffort(() => {
        if (isTombstoned(normalizedTarget)) {
            return false;
        }
        if (!assertRecoveryDirectory(normalizedTarget)) {
            return false;
        }

        const { latestPath } = getChatRecoveryPaths(normalizedTarget);
        return readChatJsonlStrict(latestPath).status === 'ok';
    }, 'Failed to inspect chat recoverability; treating recovery as unavailable.');
    return inspection.ok ? inspection.value : false;
}

function captureRecoveryFile(filePath) {
    const result = readRegularFile(filePath);
    if (result.status === 'missing') {
        return null;
    }
    if (result.status !== 'ok') {
        throw new Error(`Unsafe chat recovery file: ${filePath}`);
    }
    return result.data;
}

function quarantineCorruptChat(target, data) {
    const { quarantinePaths } = getChatRecoveryPaths(target);
    const release = acquireRecoveryStateLock(target);
    try {
        const previous = quarantinePaths.map(captureRecoveryFile);

        for (let index = quarantinePaths.length - 1; index > 0; index--) {
            const priorData = previous[index - 1];
            if (priorData === null) {
                removeRegularFile(quarantinePaths[index]);
            } else {
                atomicWriteRecoveryFile(target, quarantinePaths[index], priorData);
            }
        }
        atomicWriteRecoveryFile(target, quarantinePaths[0], data);
        pruneRecoveryStates(target);
        return quarantinePaths[0];
    } finally {
        release();
    }
}

function ensureActiveDirectory(target) {
    const rootDirectory = target[ROOT_DIRECTORY_KEYS[target.type]];
    assertSafeDirectory(rootDirectory, { create: true });
    assertSafeDirectory(target.activeDirectory, { create: true });
}

function atomicRestoreActive(target, data) {
    ensureActiveDirectory(target);
    assertWritableRegularPath(target.activePath);
    return writeDurableAtomicFileSync(target.activePath, data);
}

function buildLazyCachedActiveResult(cached) {
    let cachedRecords = null;
    let cachedBuffer = null;
    const result = {
        status: 'ok',
        source: 'active',
        recovered: false,
        quarantinePath: null,
    };
    Object.defineProperties(result, {
        data: {
            enumerable: true,
            configurable: true,
            get() {
                if (cachedBuffer === null) {
                    cachedBuffer = getEntryRawBuffer(cached);
                }
                return cachedBuffer;
            },
        },
        records: {
            enumerable: true,
            configurable: true,
            get() {
                if (cachedRecords === null) {
                    const parsed = cached.lines.map(line => JSON.parse(line));
                    if (cached.headerFixedUp && parsed.length > 0 && !isPlainObject(parsed[0].chat_metadata)) {
                        parsed[0] = { ...parsed[0], chat_metadata: {} };
                    }
                    cachedRecords = parsed;
                }
                return cachedRecords;
            },
        },
    });
    return attachChatFastMetadata(result, {
        rawRows: cached.lines,
        headerFixedUp: cached.headerFixedUp,
        originalHeader: cached.header,
        isCanonical: cached.isCanonical,
    });
}

function isRecoverySnapshotUpToDateFast(target, cached) {
    if (target.maxRecoveryStates === 0 || !cached.latestEqualsActive) {
        return false;
    }
    if (!cached.latestTuple || !isReliableStatTuple(cached.latestTuple)) {
        return false;
    }
    const { latestPath, tombstonePath } = getChatRecoveryPaths(target);
    if (!isTombstoneAbsentFast(tombstonePath)) {
        return false;
    }
    try {
        const latestStats = fs.lstatSync(latestPath, { bigint: true });
        if (latestStats.isSymbolicLink() || !latestStats.isFile()) {
            return false;
        }
        return statTuplesEqual(extractStatTuple(latestStats), cached.latestTuple);
    } catch {
        return false;
    }
}

export function loadActiveChatWithRecovery(target) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    if (recoverFileWriteSync(normalizedTarget.activePath)) {
        chatStateCache.invalidate(normalizedTarget.activePath);
    }

    let activePathStats = null;
    try {
        activePathStats = fs.lstatSync(normalizedTarget.activePath, { bigint: true });
    } catch {
        activePathStats = null;
    }

    if (activePathStats && !activePathStats.isSymbolicLink() && activePathStats.isFile()) {
        const cached = chatStateCache.getIfStatMatches(normalizedTarget.activePath, activePathStats);
        if (cached) {
            if (!isRecoverySnapshotUpToDateFast(normalizedTarget, cached)) {
                try {
                    const stored = storeValidSnapshotInternal(normalizedTarget, getEntryRawBuffer(cached), {
                        dataSha: cached.sha256,
                        cachedLatestTuple: cached.latestTuple,
                        cachedLatestSha: cached.latestSha,
                    });
                    chatStateCache.update(normalizedTarget.activePath, {
                        latestTuple: stored.latestTuple,
                        latestSha: stored.latestSha,
                        latestEqualsActive: stored.stored,
                    });
                } catch (error) {
                    chatStateCache.update(normalizedTarget.activePath, { latestEqualsActive: false });
                    // The active chat remains authoritative when optional recovery storage is unavailable.
                    console.warn('Failed to refresh the exact chat recovery snapshot; continuing with the valid active chat.', error);
                }
            }
            return buildLazyCachedActiveResult(cached);
        }
    }

    const rawActive = readRegularFile(normalizedTarget.activePath, { includeStats: true });
    const active = rawActive.status === 'ok'
        ? parseChatJsonl(rawActive.data)
        : { ...rawActive, records: null };

    if (active.status === 'ok') {
        const activeSha = computeSha256(rawActive.data);
        let latestTuple = null;
        let latestSha = null;
        let latestEqualsActive = false;
        try {
            const stored = storeValidSnapshotInternal(normalizedTarget, rawActive.data, { dataSha: activeSha });
            latestTuple = stored.latestTuple;
            latestSha = stored.latestSha;
            latestEqualsActive = stored.stored;
        } catch (error) {
            // The active chat remains authoritative when optional recovery storage is unavailable.
            console.warn('Failed to refresh the exact chat recovery snapshot; continuing with the valid active chat.', error);
        }

        if (rawActive.statTuple && isReliableStatTuple(rawActive.statTuple)) {
            const isCanonical = active[CHAT_IS_CANONICAL_SYMBOL] === true;
            chatStateCache.set(normalizedTarget.activePath, {
                ...rawActive.statTuple,
                sha256: activeSha,
                lines: active[CHAT_RAW_ROWS_SYMBOL],
                header: active[CHAT_ORIGINAL_HEADER_SYMBOL],
                headerFixedUp: active[CHAT_HEADER_FIXED_UP_SYMBOL] === true,
                isCanonical,
                rawBuffer: isCanonical ? null : rawActive.data,
                latestTuple,
                latestSha,
                latestEqualsActive,
            });
        }

        return attachChatFastMetadata({
            ...active,
            source: 'active',
            recovered: false,
            quarantinePath: null,
        }, {
            rawRows: active[CHAT_RAW_ROWS_SYMBOL],
            headerFixedUp: active[CHAT_HEADER_FIXED_UP_SYMBOL] === true,
            originalHeader: active[CHAT_ORIGINAL_HEADER_SYMBOL],
            isCanonical: active[CHAT_IS_CANONICAL_SYMBOL] === true,
        });
    }

    chatStateCache.invalidate(normalizedTarget.activePath);

    const recoveryInspection = runChatRecoveryBestEffort(() => {
        if (isTombstoned(normalizedTarget)) {
            return { tombstoned: true, snapshot: null };
        }

        const { latestPath } = getChatRecoveryPaths(normalizedTarget);
        const rawSnapshot = readRegularFile(latestPath, { includeStats: true });
        if (rawSnapshot.status !== 'ok') {
            return { tombstoned: false, snapshot: { ...rawSnapshot, records: null }, latestTuple: null };
        }
        return {
            tombstoned: false,
            snapshot: parseChatJsonl(rawSnapshot.data),
            latestTuple: rawSnapshot.statTuple ?? null,
        };
    }, 'Failed to inspect chat recovery state; continuing without sidecar recovery.');

    if (!recoveryInspection.ok) {
        return {
            ...active,
            source: null,
            recovered: false,
            recoveryReason: 'recovery-unavailable',
            quarantinePath: null,
        };
    }

    if (recoveryInspection.value.tombstoned) {
        return {
            ...active,
            source: null,
            recovered: false,
            recoveryReason: 'tombstoned',
            quarantinePath: null,
        };
    }

    const snapshot = recoveryInspection.value.snapshot;
    if (snapshot.status !== 'ok') {
        return {
            ...active,
            source: null,
            recovered: false,
            recoveryReason: snapshot.status === 'missing' ? 'no-snapshot' : 'invalid-snapshot',
            snapshotStatus: snapshot.status,
            quarantinePath: null,
        };
    }

    let quarantinePath = null;
    if (active.status === 'corrupt') {
        if (active.data === null) {
            return {
                ...active,
                source: null,
                recovered: false,
                recoveryReason: 'unsafe-active',
                snapshotStatus: snapshot.status,
                quarantinePath: null,
            };
        }
        const quarantineResult = runChatRecoveryBestEffort(
            () => quarantineCorruptChat(normalizedTarget, active.data),
            'Failed to quarantine corrupt chat bytes; continuing with safe snapshot recovery.',
        );
        quarantinePath = quarantineResult.ok ? quarantineResult.value : null;
    }

    const restoredTuple = atomicRestoreActive(normalizedTarget, snapshot.data);
    if (restoredTuple && isReliableStatTuple(restoredTuple)) {
        const restoredSha = computeSha256(snapshot.data);
        const isCanonical = snapshot[CHAT_IS_CANONICAL_SYMBOL] === true;
        chatStateCache.set(normalizedTarget.activePath, {
            ...restoredTuple,
            sha256: restoredSha,
            lines: snapshot[CHAT_RAW_ROWS_SYMBOL],
            header: snapshot[CHAT_ORIGINAL_HEADER_SYMBOL],
            headerFixedUp: snapshot[CHAT_HEADER_FIXED_UP_SYMBOL] === true,
            isCanonical,
            rawBuffer: isCanonical ? null : snapshot.data,
            latestTuple: recoveryInspection.value.latestTuple,
            latestSha: restoredSha,
            latestEqualsActive: recoveryInspection.value.latestTuple !== null,
        });
    }

    return attachChatFastMetadata({
        ...snapshot,
        source: 'snapshot',
        recovered: true,
        quarantinePath,
    }, {
        rawRows: snapshot[CHAT_RAW_ROWS_SYMBOL],
        headerFixedUp: snapshot[CHAT_HEADER_FIXED_UP_SYMBOL] === true,
        originalHeader: snapshot[CHAT_ORIGINAL_HEADER_SYMBOL],
        isCanonical: snapshot[CHAT_IS_CANONICAL_SYMBOL] === true,
    });
}

export function markChatDeleted(target) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    const active = readChatJsonlStrict(normalizedTarget.activePath);
    let snapshotUpdated = false;

    if (active.status === 'ok') {
        storeValidSnapshot(normalizedTarget, active);
        snapshotUpdated = true;
    }

    const { tombstonePath } = getChatRecoveryPaths(normalizedTarget);
    const release = acquireRecoveryStateLock(normalizedTarget);
    try {
        atomicWriteRecoveryFile(normalizedTarget, tombstonePath, Buffer.from(`${normalizedTarget.id}\n`, 'utf8'));
        tombstonesMayExist.add(tombstonePath);
        chatStateCache.update(normalizedTarget.activePath, { latestEqualsActive: false });
        pruneRecoveryStates(normalizedTarget);
    } finally {
        release();
    }
    return {
        status: 'marked',
        active,
        activePath: normalizedTarget.activePath,
        snapshotUpdated,
    };
}

function getRecoveryStatePaths(target) {
    const paths = getChatRecoveryPaths(target);
    return [paths.latestPath, paths.tombstonePath, ...paths.quarantinePaths];
}

/**
 * Removes all sidecar state for a chat after its authoritative file is intentionally deleted.
 * @param {object} target Chat recovery target
 * @returns {{status: 'cleared'|'missing', cleared: number}} Cleanup result
 */
export function clearChatRecoveryState(target) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    chatStateCache.invalidate(normalizedTarget.activePath);
    chatInfoCache.invalidate(normalizedTarget.activePath);
    if (!assertRecoveryDirectory(normalizedTarget)) {
        return { status: 'missing', cleared: 0 };
    }

    const release = acquireRecoveryStateLock(normalizedTarget);
    try {
        let cleared = 0;
        for (const filePath of getRecoveryStatePaths(normalizedTarget)) {
            if (removeRegularFile(filePath)) {
                cleared++;
            }
            deleteLatestSnapshotMeta(filePath);
            tombstonesMayExist.delete(filePath);
        }
        return { status: 'cleared', cleared };
    } finally {
        release();
    }
}

function captureRecoveryState(target) {
    if (!assertRecoveryDirectory(target)) {
        return getRecoveryStatePaths(target).map(() => null);
    }
    return getRecoveryStatePaths(target).map(captureRecoveryFile);
}

function applyRecoveryState(target, state) {
    const paths = getRecoveryStatePaths(target);
    chatStateCache.invalidate(target.activePath);
    chatInfoCache.invalidate(target.activePath);
    for (let index = 0; index < paths.length; index++) {
        deleteLatestSnapshotMeta(paths[index]);
        if (state[index] === null) {
            removeRegularFile(paths[index]);
            tombstonesMayExist.delete(paths[index]);
        } else {
            atomicWriteRecoveryFile(target, paths[index], state[index]);
            if (index === 1) {
                tombstonesMayExist.add(paths[index]);
            }
        }
    }
}

function recoveryStatesEqual(left, right) {
    return left.length === right.length && left.every((data, index) => {
        const other = right[index];
        return data === null ? other === null : Buffer.isBuffer(other) && data.equals(other);
    });
}

function rollbackRecoveryStates(source, destination, sourceState, destinationState, cause) {
    try {
        applyRecoveryState(source, sourceState);
        applyRecoveryState(destination, destinationState);
    } catch (rollbackError) {
        throw new AggregateError([cause, rollbackError], 'Chat recovery rekey rollback failed.');
    }
    throw cause;
}

export function rekeyChatRecoveryState(sourceTarget, destinationTarget) {
    const source = normalizeChatRecoveryTarget(sourceTarget);
    const destination = normalizeChatRecoveryTarget(destinationTarget);
    if (source.type !== destination.type || source.owner !== destination.owner || source.recoveryDirectory !== destination.recoveryDirectory) {
        throw new TypeError('Chat recovery state can only be rekeyed within the same owner and backup directory.');
    }

    const token = Object.freeze({
        sourceId: source.id,
        destinationId: destination.id,
    });
    if (source.id === destination.id) {
        rekeyTransactions.set(token, { used: false, noop: true });
        return token;
    }

    const release = acquireRecoveryStateLock(source);
    try {
        const sourceState = captureRecoveryState(source);
        const destinationState = captureRecoveryState(destination);
        const emptyState = sourceState.map(() => null);

        try {
            applyRecoveryState(destination, sourceState);
            applyRecoveryState(source, emptyState);
        } catch (error) {
            rollbackRecoveryStates(source, destination, sourceState, destinationState, error);
        }

        rekeyTransactions.set(token, {
            used: false,
            noop: false,
            source,
            destination,
            sourceState,
            destinationState,
            expectedSourceState: emptyState,
            expectedDestinationState: sourceState,
        });
        return token;
    } finally {
        release();
    }
}

export function reverseChatRecoveryRekey(token) {
    const transaction = rekeyTransactions.get(token);
    if (!transaction || transaction.used) {
        throw new TypeError('Invalid or already reversed chat recovery rekey token.');
    }
    if (transaction.noop) {
        transaction.used = true;
        return;
    }

    const release = acquireRecoveryStateLock(transaction.source);
    try {
        const currentSourceState = captureRecoveryState(transaction.source);
        const currentDestinationState = captureRecoveryState(transaction.destination);
        if (!recoveryStatesEqual(currentSourceState, transaction.expectedSourceState)
            || !recoveryStatesEqual(currentDestinationState, transaction.expectedDestinationState)) {
            throw new Error('Chat recovery state changed after rekey; refusing to overwrite it.');
        }

        try {
            applyRecoveryState(transaction.source, transaction.sourceState);
            applyRecoveryState(transaction.destination, transaction.destinationState);
        } catch (error) {
            rollbackRecoveryStates(
                transaction.source,
                transaction.destination,
                currentSourceState,
                currentDestinationState,
                error,
            );
        }
        transaction.used = true;
    } finally {
        release();
    }
}
