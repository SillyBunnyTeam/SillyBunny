import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

export const CHAT_RECOVERY_DIRECTORY = '_chat_recovery';
export const CHAT_RECOVERY_QUARANTINE_LIMIT = 3;

const GROUP_CHAT_OWNER = 'shared';
const RECOVERY_STATE_FILE_REGEXP = /^([a-f0-9]{64})\.(?:latest\.jsonl|deleted|corrupt-\d+\.jsonl)$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const rekeyTransactions = new WeakMap();

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

function readRegularFile(filePath) {
    let pathStats;
    try {
        pathStats = fs.lstatSync(filePath);
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
        const descriptorStats = fs.fstatSync(descriptor);
        if (!descriptorStats.isFile()) {
            return corruptResult('non-regular');
        }
        if (pathStats.ino && descriptorStats.ino && (pathStats.dev !== descriptorStats.dev || pathStats.ino !== descriptorStats.ino)) {
            return corruptResult('changed-during-read');
        }
        return { status: 'ok', data: fs.readFileSync(descriptor) };
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

export function parseChatJsonl(data) {
    let serialized;
    try {
        serialized = utf8Decoder.decode(toBuffer(data));
    } catch {
        return corruptResult('invalid-utf8', data);
    }

    const records = [];
    const lines = serialized.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.trim() === '') {
            continue;
        }

        let record;
        try {
            record = JSON.parse(line);
        } catch {
            return corruptResult('invalid-json', data, { line: index + 1 });
        }
        if (!isPlainObject(record)) {
            return corruptResult('non-object', data, { line: index + 1 });
        }
        records.push(record);
    }

    if (records.length === 0) {
        return corruptResult('empty', data);
    }
    if (!isRecognizedChatHeader(records[0])) {
        return corruptResult('missing-chat-metadata', data);
    }
    if (!isPlainObject(records[0].chat_metadata)) {
        records[0] = { ...records[0], chat_metadata: {} };
    }

    return {
        status: 'ok',
        data,
        records,
    };
}

export function readChatJsonlStrict(filePath) {
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
    const normalizedRootDirectory = normalizeDirectory(rootDirectory, type === 'character' ? 'Chats directory' : 'Group chats directory');
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

export function normalizeChatRecoveryTarget(target) {
    if (target?.type === 'character') {
        return createCharacterChatTarget(target);
    }
    if (target?.type === 'group') {
        return createGroupChatTarget(target);
    }
    throw new TypeError('Chat recovery target type must be "character" or "group".');
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
    writeFileAtomicSync(filePath, data);
}

function removeRegularFile(filePath) {
    try {
        const stats = fs.lstatSync(filePath);
        if (stats.isSymbolicLink() || !stats.isFile()) {
            throw new Error(`Unsafe chat recovery file: ${filePath}`);
        }
        fs.unlinkSync(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function pruneRecoveryStates(target) {
    const limit = target.maxRecoveryStates;
    if (limit === null || !assertRecoveryDirectory(target)) {
        return;
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
    for (const group of sortedGroups.slice(limit)) {
        for (const filePath of group.paths) {
            removeRegularFile(filePath);
        }
    }
}

function isTombstoned(target) {
    if (!assertRecoveryDirectory(target)) {
        return false;
    }

    const { tombstonePath } = getChatRecoveryPaths(target);
    const result = readRegularFile(tombstonePath);
    if (result.status === 'missing') {
        return false;
    }
    if (result.status !== 'ok') {
        throw new Error(`Unsafe chat recovery tombstone: ${tombstonePath}`);
    }
    return true;
}

function isStoredSnapshotCurrent(latestPath, data) {
    const existing = readRegularFile(latestPath);
    return existing.status === 'ok' && toBuffer(existing.data).equals(toBuffer(data));
}

function storeValidSnapshot(target, parsed) {
    const { latestPath, tombstonePath } = getChatRecoveryPaths(target);
    // SillyBunny: every chat load refreshes this snapshot, so an unchanged one would mean a disk
    // write on each open. Only the redundant write is dropped; clearing the tombstone and pruning
    // still run, because skipping those would leave a recoverable chat looking deleted.
    if (!isStoredSnapshotCurrent(latestPath, parsed.data)) {
        atomicWriteRecoveryFile(target, latestPath, parsed.data);
    }
    removeRegularFile(tombstonePath);
    pruneRecoveryStates(target);
}

export function writeLatestChatSnapshot(target, data) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    const parsed = parseChatJsonl(toBuffer(data));
    if (parsed.status !== 'ok') {
        throw new TypeError(`Invalid chat JSONL snapshot: ${parsed.reason}.`);
    }

    storeValidSnapshot(normalizedTarget, parsed);
    const { latestPath } = getChatRecoveryPaths(normalizedTarget);
    return { ...parsed, stored: isStoredSnapshotCurrent(latestPath, parsed.data) };
}

export function seedLatestChatSnapshot(target) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    const active = readChatJsonlStrict(normalizedTarget.activePath);
    if (active.status !== 'ok') {
        return { ...active, seeded: false };
    }

    storeValidSnapshot(normalizedTarget, active);
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
}

function ensureActiveDirectory(target) {
    const rootDirectory = target.type === 'character' ? target.chatsDirectory : target.groupChatsDirectory;
    assertSafeDirectory(rootDirectory, { create: true });
    assertSafeDirectory(target.activeDirectory, { create: true });
}

function atomicRestoreActive(target, data) {
    ensureActiveDirectory(target);
    assertWritableRegularPath(target.activePath);
    writeFileAtomicSync(target.activePath, data);
}

export function loadActiveChatWithRecovery(target) {
    const normalizedTarget = normalizeChatRecoveryTarget(target);
    const active = readChatJsonlStrict(normalizedTarget.activePath);
    if (active.status === 'ok') {
        try {
            storeValidSnapshot(normalizedTarget, active);
        } catch (error) {
            // The active chat remains authoritative when optional recovery storage is unavailable.
            console.warn('Failed to refresh the exact chat recovery snapshot; continuing with the valid active chat.', error);
        }
        return {
            ...active,
            source: 'active',
            recovered: false,
            quarantinePath: null,
        };
    }

    const recoveryInspection = runChatRecoveryBestEffort(() => {
        if (isTombstoned(normalizedTarget)) {
            return { tombstoned: true, snapshot: null };
        }

        const { latestPath } = getChatRecoveryPaths(normalizedTarget);
        return { tombstoned: false, snapshot: readChatJsonlStrict(latestPath) };
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

    atomicRestoreActive(normalizedTarget, snapshot.data);
    return {
        ...snapshot,
        source: 'snapshot',
        recovered: true,
        quarantinePath,
    };
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
    atomicWriteRecoveryFile(normalizedTarget, tombstonePath, Buffer.from(`${normalizedTarget.id}\n`, 'utf8'));
    pruneRecoveryStates(normalizedTarget);
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
    if (!assertRecoveryDirectory(normalizedTarget)) {
        return { status: 'missing', cleared: 0 };
    }

    let cleared = 0;
    for (const filePath of getRecoveryStatePaths(normalizedTarget)) {
        if (removeRegularFile(filePath)) {
            cleared++;
        }
    }
    return { status: 'cleared', cleared };
}

function captureRecoveryState(target) {
    if (!assertRecoveryDirectory(target)) {
        return getRecoveryStatePaths(target).map(() => null);
    }
    return getRecoveryStatePaths(target).map(captureRecoveryFile);
}

function applyRecoveryState(target, state) {
    const paths = getRecoveryStatePaths(target);
    for (let index = 0; index < paths.length; index++) {
        if (state[index] === null) {
            removeRegularFile(paths[index]);
        } else {
            atomicWriteRecoveryFile(target, paths[index], state[index]);
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
}
