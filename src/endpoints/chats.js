import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import _ from 'lodash';

import { acquireChatFileLock, acquireChatFileLocks } from '../chat-file-lock.js';
import validateAvatarUrlMiddleware, { forbiddenRegExp } from '../middleware/validateFileName.js';
import { renameChatFile } from '../chat-rename.js';
import { resolveConversationChatTarget } from '../conversation-paths.js';
// SillyBunny: bounded chat state/info/dedupe caches, crash-safe in-place writer, and backup pruning helpers.
import {
    backupDedupeCache,
    chatInfoCache,
    chatStateCache,
    computeNormalizedBackupHash,
    computeSha256,
    confirmFileContentSync,
    currentTimeNs,
    extractStatTuple,
    getEntryRawBuffer,
    getEntryRawText,
    getLatestBackupFileInfo,
    isReliableStatTuple,
    isStatTupleRacy,
    isValidUtf8Buffer,
    maybeInjectChatIoFault,
    pruneBackupsByPrefix,
    statTuplesEqual,
    tryHardLinkPreWriteBackupSync,
    withValidationTime,
    writeChatFileInPlaceFast,
    writeAtomicBackupFileSync,
} from '../chat-io-fastpath.js';
import {
    CHAT_HEADER_FIXED_UP_SYMBOL,
    CHAT_RAW_ROWS_SYMBOL,
    clearChatRecoveryState,
    createCharacterChatTarget,
    createGroupChatTarget,
    getChatRecoveryPaths,
    isRecognizedChatHeader,
    loadActiveChatWithRecovery,
    markChatDeleted,
    parseChatJsonl,
    readChatJsonlStrict,
    removeLatestChatSnapshotIfMatches,
    rekeyChatRecoveryState,
    runChatRecoveryBestEffort,
    seedLatestChatSnapshot,
    writeLatestChatSnapshot,
    writeLatestChatSnapshotTrusted,
} from '../chat-recovery.js';
import {
    getConfigValue,
    humanizedDateTime,
    tryParse,
    generateTimestamp,
    formatBytes,
    color,
    recoverFileWriteSync,
    tryWriteFileSync,
    tryReadFileSync,
    tryDeleteFile,
    isPathUnderParent,
    uuidv4,
} from '../util.js';

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', 25, 'number'));
const throttleInterval = Number(getConfigValue('backups.chat.throttleInterval', 10_000, 'number'));
const checkIntegrity = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');
const isBackupLoggingEnabled = !!getConfigValue('backups.chat.logging', false, 'boolean');

export const CHAT_BACKUPS_PREFIX = 'chat_';
const CHAT_FORCED_OVERWRITE_BACKUPS_PREFIX = 'chat_forced_overwrite_';
const CHAT_PRE_WRITE_BACKUPS_PREFIX = 'chat_pre_write_';
const PRE_WRITE_BACKUP_RING_SIZE = 3;

/**
 * Builds a stable filename key for a chat's backups.
 * Non-ASCII characters are replaced with underscores, so names such as CJK ones
 * would all collapse to the same key and share one backup quota. A short hash of
 * the raw name keeps those keys distinct while ASCII names stay unchanged (#5780).
 * @param {string} name The name of the chat.
 * @returns {string} Sanitized filename key for the backup files.
 */
export function getBackupKey(name) {
    const sanitized = sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    if (/[^\x20-\x7E]/.test(name)) {
        const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
        return `${sanitized}_${hash}`;
    }
    return sanitized;
}

/**
 * Trims regular chat backups only. `CHAT_BACKUPS_PREFIX` is a prefix of the pre-write and
 * forced-overwrite prefixes, so a plain prefix sweep would also rotate away those recovery layers.
 * Uses a Schwartzian transform (at most 1 `statSync` per file, sorted by mtime).
 * @param {string} directory The user's backup directory.
 * @param {number} limit Maximum number of regular chat backups to keep.
 */
export function removeOldRegularChatBackups(directory, limit) {
    // SillyBunny: Schwartzian-transform 1-stat mtime pruning avoids O(N log N) statSync calls.
    const reservedPrefixes = [CHAT_PRE_WRITE_BACKUPS_PREFIX, CHAT_FORCED_OVERWRITE_BACKUPS_PREFIX];
    pruneBackupsByPrefix(directory, CHAT_BACKUPS_PREFIX, limit, reservedPrefixes);
}

function logBackupEvent(action, details = {}) {
    if (!isBackupLoggingEnabled) {
        return;
    }

    const fields = Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
    console.info(color.cyan(`[Backup] ${action}${fields ? ` ${fields}` : ''}`));
}

function getSerializedBackupSizeDetails(data, knownByteLength = undefined) {
    if (!isBackupLoggingEnabled) {
        return {};
    }
    const sizeBytes = typeof knownByteLength === 'number'
        ? knownByteLength
        : (Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(String(data ?? ''), 'utf8'));
    return {
        bytes: sizeBytes,
        size: formatBytes(sizeBytes),
    };
}

function getChatBackupType(backupPrefix) {
    if (backupPrefix === CHAT_FORCED_OVERWRITE_BACKUPS_PREFIX) {
        return 'forced-overwrite';
    }

    if (backupPrefix === CHAT_PRE_WRITE_BACKUPS_PREFIX) {
        return 'pre-write';
    }

    return 'regular';
}

// SillyBunny: stream-hash header without integrity + message rows directly to avoid copying large chats.
function computeNormalizedBackupHashFromLines(headerRecord, messageLines) {
    const hash = crypto.createHash('sha256');
    if (isPlainObject(headerRecord?.chat_metadata)) {
        const chatMetadata = { ...headerRecord.chat_metadata };
        delete chatMetadata.integrity;
        hash.update(JSON.stringify({ ...headerRecord, chat_metadata: chatMetadata }));
    } else {
        hash.update(JSON.stringify(headerRecord));
    }
    for (let index = 0; index < messageLines.length; index++) {
        hash.update('\n');
        hash.update(messageLines[index]);
    }
    return hash.digest('hex');
}

function normalizeChatMessageExtraForComparison(extra) {
    if (!isPlainObject(extra)) {
        return extra;
    }

    const normalized = JSON.parse(JSON.stringify(extra));
    if (Object.hasOwn(normalized, 'file')) {
        normalized.files = Array.isArray(normalized.files) ? normalized.files : [];
        if (normalized.file) {
            normalized.files.push(normalized.file);
        }
        delete normalized.file;
    }
    if (Array.isArray(normalized.image_swipes)) {
        normalized.media = Array.isArray(normalized.media) ? normalized.media : [];
        for (const imageUrl of normalized.image_swipes) {
            if (typeof imageUrl === 'string' && imageUrl) {
                normalized.media_display = 'gallery';
                normalized.media.push({ type: 'image', url: imageUrl });
            }
        }
        delete normalized.image_swipes;
    }
    if (Object.hasOwn(normalized, 'image')) {
        normalized.media = Array.isArray(normalized.media) ? normalized.media : [];
        const imageUrl = normalized.image;
        if (typeof imageUrl === 'string' && imageUrl) {
            normalized.media.push({ type: 'image', url: imageUrl });
        }
        if (normalized.media_display === 'gallery' && typeof imageUrl === 'string' && imageUrl) {
            const selectedIndex = normalized.media.findIndex(media => media?.url === imageUrl);
            if (selectedIndex > -1) {
                normalized.media_index = selectedIndex;
            }
        }
        // SillyBunny: retain unknown media entries verbatim; comparison must not discard data or block saves.
        normalized.media = normalized.media.filter((media, index, allMedia) => !isPlainObject(media)
            || typeof media.url !== 'string' || !media.url
            || index === allMedia.findIndex(other => other?.url === media.url));
        delete normalized.image;
    }
    if (Object.hasOwn(normalized, 'video')) {
        normalized.media = Array.isArray(normalized.media) ? normalized.media : [];
        if (typeof normalized.video === 'string' && normalized.video) {
            normalized.media.push({ type: 'video', url: normalized.video });
        }
        delete normalized.video;
    }

    // SillyBunny: clean up empty hydration containers so on-disk chats without media/files
    // compare identical to in-memory hydrated chats whose media/files arrays were initialized to [].
    if (Array.isArray(normalized.media) && normalized.media.length === 0) {
        delete normalized.media;
        if (normalized.media_display === 'gallery') {
            delete normalized.media_display;
        }
        if (normalized.media_index === 0) {
            delete normalized.media_index;
        }
    }
    if (Array.isArray(normalized.files) && normalized.files.length === 0) {
        delete normalized.files;
    }
    return normalized;
}

function normalizeChatMessageForComparison(message, chatMetadata, messageCount) {
    // Reparse JSONL data so retained and synthesized nested values share one realm for strict comparison.
    const normalized = JSON.parse(JSON.stringify(message));
    normalized.extra = normalizeChatMessageExtraForComparison(normalized.extra);
    if (normalized.is_user || normalized.extra?.isSmallSys) {
        return normalized;
    }

    if (!Array.isArray(normalized.swipes)) {
        normalized.swipes = [normalized.mes ?? ''];
    }
    if (typeof normalized.swipe_id !== 'number') {
        normalized.swipe_id = 0;
    }
    const createSwipeInfo = () => {
        const info = { extra: {} };
        for (const key of ['send_date', 'gen_started', 'gen_finished']) {
            if (normalized[key] !== undefined) {
                info[key] = normalized[key];
            }
        }
        return info;
    };
    if (!Array.isArray(normalized.swipe_info)) {
        normalized.swipe_info = normalized.swipes.map(createSwipeInfo);
    }
    for (let index = 0; index < normalized.swipes.length; index++) {
        if (typeof normalized.swipes[index] !== 'string') {
            normalized.swipes[index] = '';
        }
        if (!isPlainObject(normalized.swipe_info[index])) {
            normalized.swipe_info[index] = createSwipeInfo();
        } else {
            // SillyBunny: normalize extra inside all swipe_info records symmetrically with message.extra.
            normalized.swipe_info[index].extra = normalizeChatMessageExtraForComparison(normalized.swipe_info[index].extra);
        }
    }

    const activeSwipe = normalized.swipe_id;
    if (typeof normalized.swipes[activeSwipe] === 'string' && isPlainObject(normalized.swipe_info[activeSwipe])) {
        if (chatMetadata.tainted || messageCount > 1) {
            normalized.swipes[activeSwipe] = normalized.mes;
        }
        const swipeInfo = normalized.swipe_info[activeSwipe];
        for (const key of ['send_date', 'gen_started', 'gen_finished']) {
            if (normalized[key] === undefined) {
                delete swipeInfo[key];
            } else {
                swipeInfo[key] = normalized[key];
            }
        }
        if (normalized.extra === undefined) {
            delete swipeInfo.extra;
        } else {
            swipeInfo.extra = JSON.parse(JSON.stringify(normalized.extra));
        }
    }
    return normalized;
}

// SillyBunny: row-level comparison helpers avoid JSON.parse/normalization on byte-equal chat rows.
function parseStrictPlainJsonObject(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object') {
        return null;
    }
    const prototype = Object.getPrototypeOf(parsed);
    if (prototype !== Object.prototype && prototype !== null) {
        return null;
    }
    return parsed;
}

/**
 * Splits serialized UTF-8 chat text into non-blank lines for fast comparison,
 * matching `parseChatJsonl` (strips UTF-8 BOM only at offset 0, skips blank lines, strips trailing `\r`).
 * @param {string} rawText
 * @returns {{ lines: string[], hasBom: boolean, isCanonical: boolean }}
 */
export function splitChatLinesForComparison(rawText) {
    const serialized = String(rawText ?? '');
    const hasBom = serialized.charCodeAt(0) === 0xFEFF;
    const text = hasBom ? serialized.slice(1) : serialized;
    const rawSplit = text.split('\n');
    const lines = [];
    let hasBlankOrCr = false;
    for (let index = 0; index < rawSplit.length; index++) {
        const line = rawSplit[index];
        if (line.trim() === '') {
            hasBlankOrCr = true;
            continue;
        }
        if (line.endsWith('\r')) {
            hasBlankOrCr = true;
            lines.push(line.slice(0, -1));
        } else {
            lines.push(line);
        }
    }
    return {
        lines,
        hasBom,
        isCanonical: !hasBom && !hasBlankOrCr,
    };
}

function normalizeChatHeaderForComparison(headerRecord, { ignoreDerivedMetadata = true } = {}) {
    if (!isRecognizedChatHeader(headerRecord)) {
        return null;
    }
    const sourceMetadata = isPlainObject(headerRecord.chat_metadata) ? headerRecord.chat_metadata : {};
    const chatMetadata = { ...sourceMetadata };
    delete chatMetadata.integrity;
    if (ignoreDerivedMetadata) {
        delete chatMetadata.chat_id_hash;
        if (isPlainObject(chatMetadata.variables) && Object.keys(chatMetadata.variables).length === 0) {
            delete chatMetadata.variables;
        }
    }
    return { chat_metadata: chatMetadata };
}

function getChatSaveComparisonRecords(data, { ignoreDerivedMetadata = true } = {}) {
    const parsedChat = parseChatJsonl(String(data ?? ''));
    if (parsedChat.status !== 'ok') {
        return null;
    }

    const [header, ...messages] = parsedChat.records;
    const chatMetadata = { ...header.chat_metadata };
    delete chatMetadata.integrity;
    if (ignoreDerivedMetadata) {
        delete chatMetadata.chat_id_hash;
        if (isPlainObject(chatMetadata.variables) && Object.keys(chatMetadata.variables).length === 0) {
            delete chatMetadata.variables;
        }
    }

    // SillyBunny: chat loads retain chat_metadata but discard and recreate the outer header envelope.
    return [
        { chat_metadata: chatMetadata },
        ...messages.map(message => normalizeChatMessageForComparison(message, chatMetadata, messages.length)),
    ];
}

export function isSameChatSaveContentLegacy(left, right, options = {}) {
    const leftRecords = getChatSaveComparisonRecords(left, options);
    const rightRecords = getChatSaveComparisonRecords(right, options);
    return leftRecords !== null && rightRecords !== null && isDeepStrictEqual(leftRecords, rightRecords);
}

// SillyBunny: true when the incoming save keeps the existing metadata and every message unchanged
// and in order, so it can only append without rolling back another client's metadata changes.
export function isChatSaveExtensionLegacy(newSerializedChat, existingSerializedChat, options = {}) {
    const incomingRecords = getChatSaveComparisonRecords(newSerializedChat, options);
    const existingRecords = getChatSaveComparisonRecords(existingSerializedChat, options);
    if (incomingRecords === null || existingRecords === null) {
        return false;
    }

    const [incomingHeader, ...incomingMessages] = incomingRecords;
    const [existingHeader, ...existingMessages] = existingRecords;
    return isDeepStrictEqual(incomingHeader, existingHeader)
        && incomingMessages.length >= existingMessages.length
        && isDeepStrictEqual(incomingMessages.slice(0, existingMessages.length), existingMessages);
}

/**
 * Row-level fast comparison equivalent to `isSameChatSaveContentLegacy`.
 * Parses only row 0 and differing message rows (`i >= 1`), skipping byte-equal rows.
 * @param {{ lines: string[], header?: object|null, validated?: boolean }} incoming
 * @param {{ lines: string[], header?: object|null, validated?: boolean }} existing
 * @param {{ ignoreDerivedMetadata?: boolean }} [options]
 * @returns {boolean}
 */
export function isSameChatSaveContentFast(incoming, existing, { ignoreDerivedMetadata = true } = {}) {
    const inLines = incoming?.lines;
    const diskLines = existing?.lines;
    if (!Array.isArray(inLines) || !Array.isArray(diskLines) || inLines.length === 0 || diskLines.length === 0) {
        return false;
    }
    if (inLines.length !== diskLines.length) {
        return false;
    }

    const inHeaderRaw = incoming.header ?? parseStrictPlainJsonObject(inLines[0]);
    const diskHeaderRaw = existing.header ?? parseStrictPlainJsonObject(diskLines[0]);
    if (!inHeaderRaw || !diskHeaderRaw) {
        return false;
    }
    const inHeaderNorm = normalizeChatHeaderForComparison(inHeaderRaw, { ignoreDerivedMetadata });
    const diskHeaderNorm = normalizeChatHeaderForComparison(diskHeaderRaw, { ignoreDerivedMetadata });
    if (!inHeaderNorm || !diskHeaderNorm || !isDeepStrictEqual(inHeaderNorm, diskHeaderNorm)) {
        return false;
    }

    const messageCount = inLines.length - 1;
    const inValidated = incoming.validated === true;
    const diskValidated = existing.validated === true;

    for (let index = 1; index < inLines.length; index++) {
        const inLine = inLines[index];
        const diskLine = diskLines[index];
        if (inLine === diskLine) {
            if (!inValidated && !diskValidated && !parseStrictPlainJsonObject(inLine)) {
                return false;
            }
            continue;
        }

        const inMsg = parseStrictPlainJsonObject(inLine);
        const diskMsg = parseStrictPlainJsonObject(diskLine);
        if (!inMsg || !diskMsg) {
            return false;
        }
        const normIn = normalizeChatMessageForComparison(inMsg, inHeaderNorm.chat_metadata, messageCount);
        const normDisk = normalizeChatMessageForComparison(diskMsg, diskHeaderNorm.chat_metadata, messageCount);
        if (!isDeepStrictEqual(normIn, normDisk)) {
            return false;
        }
    }
    return true;
}

/**
 * Row-level fast extension check equivalent to `isChatSaveExtensionLegacy`.
 * Falls back to exact legacy full compare whenever normalization context `(tainted, messageCount > 1)`
 * differs (`n_disk === 1 && n_in > 1 && !tainted` or differing `tainted`).
 * @param {{ lines: string[], header?: object|null, validated?: boolean, rawText?: string, getRawText?: () => string }} incoming
 * @param {{ lines: string[], header?: object|null, validated?: boolean, rawText?: string, getRawText?: () => string }} existing
 * @param {{ ignoreDerivedMetadata?: boolean }} [options]
 * @returns {boolean}
 */
export function isChatSaveExtensionFast(incoming, existing, { ignoreDerivedMetadata = true } = {}) {
    const inLines = incoming?.lines;
    const diskLines = existing?.lines;
    if (!Array.isArray(inLines) || !Array.isArray(diskLines) || inLines.length === 0 || diskLines.length === 0) {
        return false;
    }

    const inMessageCount = inLines.length - 1;
    const diskMessageCount = diskLines.length - 1;
    if (inMessageCount < diskMessageCount) {
        return false;
    }

    const inHeaderRaw = incoming.header ?? parseStrictPlainJsonObject(inLines[0]);
    const diskHeaderRaw = existing.header ?? parseStrictPlainJsonObject(diskLines[0]);
    if (!inHeaderRaw || !diskHeaderRaw) {
        return false;
    }
    const inHeaderNorm = normalizeChatHeaderForComparison(inHeaderRaw, { ignoreDerivedMetadata });
    const diskHeaderNorm = normalizeChatHeaderForComparison(diskHeaderRaw, { ignoreDerivedMetadata });
    if (!inHeaderNorm || !diskHeaderNorm) {
        return false;
    }

    const inTainted = Boolean(inHeaderNorm.chat_metadata.tainted);
    const diskTainted = Boolean(diskHeaderNorm.chat_metadata.tainted);

    if (inTainted !== diskTainted || (diskMessageCount === 1 && inMessageCount > 1 && !diskTainted)) {
        const inRaw = incoming.rawText ?? (typeof incoming.getRawText === 'function' ? incoming.getRawText() : inLines.join('\n'));
        const diskRaw = existing.rawText ?? (typeof existing.getRawText === 'function' ? existing.getRawText() : diskLines.join('\n'));
        return isChatSaveExtensionLegacy(inRaw, diskRaw, { ignoreDerivedMetadata });
    }

    if (!isDeepStrictEqual(inHeaderNorm, diskHeaderNorm)) {
        return false;
    }

    const inValidated = incoming.validated === true;
    const diskValidated = existing.validated === true;

    for (let index = 1; index < diskLines.length; index++) {
        const inLine = inLines[index];
        const diskLine = diskLines[index];
        if (inLine === diskLine) {
            if (!inValidated && !diskValidated && !parseStrictPlainJsonObject(inLine)) {
                return false;
            }
            continue;
        }

        const inMsg = parseStrictPlainJsonObject(inLine);
        const diskMsg = parseStrictPlainJsonObject(diskLine);
        if (!inMsg || !diskMsg) {
            return false;
        }
        const normIn = normalizeChatMessageForComparison(inMsg, inHeaderNorm.chat_metadata, inMessageCount);
        const normDisk = normalizeChatMessageForComparison(diskMsg, diskHeaderNorm.chat_metadata, diskMessageCount);
        if (!isDeepStrictEqual(normIn, normDisk)) {
            return false;
        }
    }

    if (!inValidated) {
        for (let index = diskLines.length; index < inLines.length; index++) {
            if (!parseStrictPlainJsonObject(inLines[index])) {
                return false;
            }
        }
    }

    return true;
}

// SillyBunny: dedupe regular and pre-write backups via stat-validated normalized SHA-256 hashes.
function checkDuplicateChatBackup(directory, prefix, incomingNormalizedHash) {
    // Taken before the newest backup is listed and read, as `withValidationTime` requires.
    const validatedAtNs = currentTimeNs();
    const latestInfo = getLatestBackupFileInfo(directory, prefix);
    if (!latestInfo) {
        return { isDuplicate: false, latestInfo: null };
    }

    // A backup whose tuple is racy is read again, because skipping a backup that is not a duplicate loses history.
    const cached = backupDedupeCache.get(directory, prefix);
    if (cached
        && cached.filePath === latestInfo.filePath
        && latestInfo.tuple
        && isReliableStatTuple(latestInfo.tuple)
        && statTuplesEqual(latestInfo.tuple, cached.tuple)
        && !isStatTupleRacy(cached.tuple)) {
        return {
            isDuplicate: cached.size > 0n && cached.normalizedHash === incomingNormalizedHash,
            latestInfo,
        };
    }

    const latestBackupData = tryReadFileSync(latestInfo.filePath);
    if (!latestBackupData) {
        return { isDuplicate: false, latestInfo };
    }

    const latestNormalizedHash = computeNormalizedBackupHash(latestBackupData);
    if (latestInfo.tuple && isReliableStatTuple(latestInfo.tuple)) {
        backupDedupeCache.set(directory, prefix, {
            filePath: latestInfo.filePath,
            tuple: withValidationTime(latestInfo.tuple, validatedAtNs),
            size: latestInfo.tuple.size,
            normalizedHash: latestNormalizedHash,
        });
    }

    return {
        isDuplicate: latestNormalizedHash === incomingNormalizedHash,
        latestInfo,
    };
}

/**
 * Saves a chat to the backups directory.
 * @param {string} directory The user's backup directory.
 * @param {string} name The name of the chat.
 * @param {string|Buffer} data The serialized chat to save.
 * @param {string} backupPrefix The file prefix. Typically CHAT_BACKUPS_PREFIX.
 * @param {string} handle User handle for diagnostic logging.
 * @param {{ normalizedHash?: string|null }} [meta] Optional precomputed backup metadata.
 * @returns
 */
function backupChat(directory, name, data, backupPrefix = CHAT_BACKUPS_PREFIX, handle = '', meta = undefined) {
    const originalName = name;
    const backupType = getChatBackupType(backupPrefix);
    try {
        if (!isBackupEnabled) {
            logBackupEvent('chat-backup-skipped', { type: backupType, handle, chat: originalName, reason: 'disabled' });
            return;
        }
        if (!fs.existsSync(directory)) {
            console.error(`The chat couldn't be backed up because no directory exists at ${directory}!`);
            logBackupEvent('chat-backup-skipped', { type: backupType, handle, chat: originalName, reason: 'missing-directory' });
            return;
        }
        // replace non-alphanumeric characters with underscores
        name = getBackupKey(name);
        const prefix = `${backupPrefix}${name}_`;
        const sizeDetails = getSerializedBackupSizeDetails(data);
        const isRegularBackup = backupPrefix === CHAT_BACKUPS_PREFIX;
        const normalizedHash = isRegularBackup
            ? (meta?.normalizedHash ?? computeNormalizedBackupHash(data))
            : null;

        if (isRegularBackup) {
            const { isDuplicate } = checkDuplicateChatBackup(directory, prefix, normalizedHash);
            if (isDuplicate) {
                logBackupEvent('chat-backup-skipped', {
                    type: backupType,
                    handle,
                    chat: originalName,
                    sanitizedName: name,
                    reason: 'duplicate',
                    ...sizeDetails,
                });
                return;
            }
        }

        const backupFile = path.join(directory, `${backupPrefix}${name}_${generateTimestamp()}.jsonl`);

        // SillyBunny: regular chat backups never hard-link to live `.latest.jsonl` and are written from memory.
        let writtenTuple = null;
        if (isRegularBackup) {
            writtenTuple = writeAtomicBackupFileSync(backupFile, data);
        } else {
            tryWriteFileSync(backupFile, data);
        }

        if (isRegularBackup && normalizedHash && writtenTuple && isReliableStatTuple(writtenTuple)) {
            backupDedupeCache.set(directory, prefix, {
                filePath: backupFile,
                tuple: writtenTuple,
                size: writtenTuple.size,
                normalizedHash,
            });
        }

        logBackupEvent('chat-backup-written', {
            type: backupType,
            handle,
            chat: originalName,
            sanitizedName: name,
            file: path.basename(backupFile),
            ...sizeDetails,
        });
        const commonBackupLimit = Number(getConfigValue('backups.common.numberOfBackups', 50, 'number'));
        pruneBackupsByPrefix(directory, prefix, commonBackupLimit);
        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return;
        }
        if (isRegularBackup) {
            removeOldRegularChatBackups(directory, maxTotalChatBackups);
            return;
        }
        pruneBackupsByPrefix(directory, backupPrefix, maxTotalChatBackups);
    } catch (err) {
        console.error(`Could not backup chat for ${name}`, err);
    }
}

function backupChatPreWrite(directory, name, dataOrGetter, handle = '', options = undefined) {
    const originalName = name;
    try {
        if (!isBackupEnabled) {
            logBackupEvent('chat-backup-skipped', { type: 'pre-write', handle, chat: originalName, reason: 'disabled' });
            return { skipped: true };
        }
        if (!fs.existsSync(directory)) {
            console.error(`The chat couldn't be backed up because no directory exists at ${directory}!`);
            logBackupEvent('chat-backup-skipped', { type: 'pre-write', handle, chat: originalName, reason: 'missing-directory' });
        }
        name = getBackupKey(name);
        const prefix = `${CHAT_PRE_WRITE_BACKUPS_PREFIX}${name}_`;
        let materializedData = typeof dataOrGetter === 'function' ? null : dataOrGetter;
        const getData = () => {
            if (materializedData === null) {
                materializedData = dataOrGetter();
            }
            return materializedData;
        };

        const normalizedHash = options?.normalizedHash ?? computeNormalizedBackupHash(getData());
        const sizeDetails = getSerializedBackupSizeDetails(
            isBackupLoggingEnabled ? getData() : '',
            options?.byteLength,
        );

        const { isDuplicate, latestInfo } = checkDuplicateChatBackup(directory, prefix, normalizedHash);
        if (isDuplicate) {
            logBackupEvent('chat-backup-skipped', {
                type: 'pre-write',
                handle,
                chat: originalName,
                sanitizedName: name,
                reason: 'duplicate',
                ...sizeDetails,
            });
            return { duplicate: true, normalizedHash };
        }

        const backupFile = path.join(directory, `${CHAT_PRE_WRITE_BACKUPS_PREFIX}${name}_${generateTimestamp()}_${uuidv4()}.jsonl`);
        let linked = false;
        let writtenTuple = null;
        let bumpedSourceMtime = false;

        // SillyBunny: hard-link the already-durable `.latest.jsonl` before it is replaced by rename.
        const hardLinkContext = options?.hardLinkContext;
        if (hardLinkContext?.latestPath && hardLinkContext?.latestTuple) {
            const linkResult = tryHardLinkPreWriteBackupSync(
                hardLinkContext.latestPath,
                backupFile,
                hardLinkContext.latestTuple,
                latestInfo ? latestInfo.mtimeMs : null,
                hardLinkContext.latestSha ?? null,
            );
            if (linkResult.linked) {
                linked = true;
                writtenTuple = linkResult.tuple;
                bumpedSourceMtime = linkResult.bumpedMtime;
            }
        }

        if (!linked) {
            tryWriteFileSync(backupFile, getData());
            try {
                writtenTuple = withValidationTime(extractStatTuple(fs.lstatSync(backupFile, { bigint: true })));
            } catch {
                writtenTuple = null;
            }
        }

        if (writtenTuple && isReliableStatTuple(writtenTuple)) {
            backupDedupeCache.set(directory, prefix, {
                filePath: backupFile,
                tuple: writtenTuple,
                size: writtenTuple.size,
                normalizedHash,
            });
        }

        logBackupEvent('chat-backup-written', {
            type: 'pre-write',
            handle,
            chat: originalName,
            sanitizedName: name,
            file: path.basename(backupFile),
            ...sizeDetails,
        });
        pruneBackupsByPrefix(directory, prefix, PRE_WRITE_BACKUP_RING_SIZE);
        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return { duplicate: false, normalizedHash, bumpedSourceMtime, linked, writtenTuple };
        }
        pruneBackupsByPrefix(directory, CHAT_PRE_WRITE_BACKUPS_PREFIX, maxTotalChatBackups);
        return { duplicate: false, normalizedHash, bumpedSourceMtime, linked, writtenTuple };
    } catch (err) {
        console.error(`Could not create pre-write chat backup for ${name}`, err);
        throw err;
    }
}

/**
 * Classifies a save that would replace an existing chat with substantially less content
 * using precomputed non-blank row counts (avoiding redundant full-string splits).
 * A chat payload carries one metadata header, so a length below two rows has no messages at all.
 * @param {number} newRowCount Incoming chat row count.
 * @param {number} existingRowCount Current non-blank row count on disk.
 * @returns {''|'emptied'|'shrink'} Reason the save is destructive, or an empty string.
 */
function getDestructiveChatSaveReasonByCount(newRowCount, existingRowCount) {
    if (existingRowCount < 2) {
        return '';
    }

    if (newRowCount < 2) {
        return 'emptied';
    }

    if (existingRowCount <= 5) {
        return '';
    }

    return newRowCount < existingRowCount * 0.5 ? 'shrink' : '';
}

/**
 * @type {Map<string, import('lodash').DebouncedFunc<typeof backupChat>>}
 */
const backupFunctions = new Map();

// SillyBunny: track active deferred save sequences (e.g. multi-step in-chat agent runs).
// A deferred run captures one pre-write snapshot of the pre-run on-disk state before the first
// intermediate mutation, and suppresses redundant pre-write churn during subsequent in-flight passes (#373).
const deferredPreWriteBackupSequences = new Map();

function normalizeDeferredBackupPath(filePath) {
    return path.resolve(filePath);
}

function hasDeferredSequenceId(deferSequenceId) {
    return deferSequenceId !== undefined && deferSequenceId !== null && String(deferSequenceId).trim().length > 0;
}

export function clearActiveDeferredChatPreWrites() {
    deferredPreWriteBackupSequences.clear();
}

function getDeferredPreWriteBackupDecision({
    filePath,
    deferBackup,
    deferSequenceId,
}) {
    const normalizedPath = normalizeDeferredBackupPath(filePath);
    const hasSequence = hasDeferredSequenceId(deferSequenceId);
    const activeSequence = deferredPreWriteBackupSequences.get(normalizedPath);

    // No token means this is an unrelated ordinary save. It must always retain
    // normal pre-write backup behavior and clear any stale abandoned sequence.
    if (!hasSequence) {
        return {
            normalizedPath,
            shouldCreateBackup: true,
            closeSequence: false,
            clearActiveSequenceAfterSuccess: Boolean(activeSequence),
        };
    }

    if (deferBackup === true) {
        if (activeSequence === deferSequenceId) {
            return {
                normalizedPath,
                shouldCreateBackup: false,
                closeSequence: false,
            };
        }

        // First save of this sequence: preserve the pre-turn baseline.
        return {
            normalizedPath,
            shouldCreateBackup: true,
            beginSequence: true,
            closeSequence: false,
        };
    }

    // Closing save. Only the matching sequence may skip the redundant backup.
    if (activeSequence === deferSequenceId) {
        return {
            normalizedPath,
            shouldCreateBackup: false,
            closeSequence: true,
        };
    }

    // A closing save with no matching active sequence is an ordinary save.
    return {
        normalizedPath,
        shouldCreateBackup: true,
        closeSequence: false,
    };
}

function commitDeferredPreWriteBackupDecision(decision, deferSequenceId) {
    if (decision.beginSequence) {
        deferredPreWriteBackupSequences.set(
            decision.normalizedPath,
            deferSequenceId,
        );
    }

    if (decision.closeSequence || decision.clearActiveSequenceAfterSuccess) {
        deferredPreWriteBackupSequences.delete(decision.normalizedPath);
    }
}

function clearDeferredPreWriteBackupSequence(filePath) {
    deferredPreWriteBackupSequences.delete(
        normalizeDeferredBackupPath(filePath),
    );
}

/**
 * Gets a backup function for a user and chat.
 * Throttling is keyed per user and chat so that rapid saves in one chat cannot
 * swallow the throttled backup of another chat saved in the same window.
 * @param {string} handle User handle
 * @param {string} name The name of the chat, as passed to backupChat
 * @returns {typeof backupChat} Backup function
 */
function getBackupFunction(handle, name) {
    const key = `${handle} ${name}`;
    if (!backupFunctions.has(key)) {
        backupFunctions.set(key, _.throttle(backupChat, throttleInterval, { leading: true, trailing: true }));
    }
    return backupFunctions.get(key) || (() => { });
}

/**
 * Gets a preview message from a chat message string.
 * @param {string} [lastMessage] - The message to truncate
 * @returns {string} A truncated preview of the last message or empty string if no messages
 */
function getPreviewMessage(lastMessage) {
    const strlen = 400;

    if (!lastMessage) {
        return '';
    }

    return lastMessage.length > strlen
        ? '...' + lastMessage.substring(lastMessage.length - strlen)
        : lastMessage;
}

process.on('exit', () => {
    for (const func of backupFunctions.values()) {
        func.flush();
    }
});

/**
 * Imports a chat from Ooba's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string} Chat data
 */
function importOobaChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const arr of jsonData.data_visible) {
        if (arr[0]) {
            const userMessage = {
                name: userName,
                is_user: true,
                send_date: new Date().toISOString(),
                mes: arr[0],
                extra: {},
            };
            chat.push(userMessage);
        }
        if (arr[1]) {
            const charMessage = {
                name: characterName,
                is_user: false,
                send_date: new Date().toISOString(),
                mes: arr[1],
                extra: {},
            };
            chat.push(charMessage);
        }
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from Agnai's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Chat data
 * @returns {string} Chat data
 */
function importAgnaiChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.messages) {
        const isUser = !!message.userId;
        chat.push({
            name: isUser ? userName : characterName,
            is_user: isUser,
            send_date: new Date().toISOString(),
            mes: message.msg,
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from CAI Tools format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string[]} Converted data
 */
function importCAIChat(userName, characterName, jsonData) {
    /**
     * Converts the chat data to suitable format.
     * @param {object} history Imported chat data
     * @returns {object[]} Converted chat data
     */
    function convert(history) {
        const starter = {
            chat_metadata: {},
            user_name: 'unused',
            character_name: 'unused',
        };

        const historyData = history.msgs.map((msg) => ({
            name: msg.src.is_human ? userName : characterName,
            is_user: msg.src.is_human,
            send_date: new Date().toISOString(),
            mes: msg.text,
            extra: {},
        }));

        return [starter, ...historyData];
    }

    const newChats = (jsonData.histories.histories ?? []).map(history => newChats.push(convert(history).map(obj => JSON.stringify(obj)).join('\n')));
    return newChats;
}

/**
 * Imports a chat from Kobold Lite format.
 * @param {string} _userName User name
 * @param {string} _characterName Character name
 * @param {object} data JSON data
 * @returns {string} Chat data
 */
function importKoboldLiteChat(_userName, _characterName, data) {
    const inputToken = '{{[INPUT]}}';
    const outputToken = '{{[OUTPUT]}}';

    /** @type {function(string): object} */
    function processKoboldMessage(msg) {
        const isUser = msg.includes(inputToken);
        return {
            name: isUser ? userName : characterName,
            is_user: isUser,
            mes: msg.replaceAll(inputToken, '').replaceAll(outputToken, '').trim(),
            send_date: new Date().toISOString(),
            extra: {},
        };
    }

    // Create the header
    const userName = String(data.savedsettings.chatname);
    const characterName = String(data.savedsettings.chatopponent).split('||$||')[0];
    const header = {
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    };
    // Format messages
    const formattedMessages = data.actions.map(processKoboldMessage);
    // Add prompt if available
    if (data.prompt) {
        formattedMessages.unshift(processKoboldMessage(data.prompt));
    }
    // Combine header and messages
    const chatData = [header, ...formattedMessages];
    return chatData.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Flattens `msg` and `swipes` data from Chub Chat format.
 * Only changes enough to make it compatible with the standard chat serialization format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {string[]} lines serialised JSONL data
 * @returns {string} Converted data
 */
function flattenChubChat(userName, characterName, lines) {
    function flattenSwipe(swipe) {
        return swipe.message ? swipe.message : swipe;
    }

    function convert(line) {
        const lineData = tryParse(line);
        if (!lineData) return line;

        if (lineData.mes && lineData.mes.message) {
            lineData.mes = lineData?.mes.message;
        }

        if (lineData?.swipes && Array.isArray(lineData.swipes)) {
            lineData.swipes = lineData.swipes.map(swipe => flattenSwipe(swipe));
        }

        return JSON.stringify(lineData);
    }

    return (lines ?? []).map(convert).join('\n');
}

/**
 * Imports a chat from RisuAI format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Imported chat data
 * @returns {string} Chat data
 */
function importRisuChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.data.message) {
        const isUser = message.role === 'user';
        chat.push({
            name: message.name ?? (isUser ? userName : characterName),
            is_user: isUser,
            send_date: new Date(Number(message.time ?? Date.now())).toISOString(),
            mes: message.data ?? '',
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

function readChatFileSnapshot(filePath) {
    let initialPathStats;
    try {
        initialPathStats = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    if (!initialPathStats.isFile() && !initialPathStats.isSymbolicLink()) {
        throw Object.assign(new Error(`Chat path is not a regular file: ${filePath}`), { code: 'EINVAL' });
    }

    const fileDescriptor = fs.openSync(filePath, 'r');
    try {
        const initialDescriptorStats = fs.fstatSync(fileDescriptor, { bigint: true });
        if (!initialDescriptorStats.isFile() || initialDescriptorStats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw Object.assign(new Error(`Chat file cannot be read safely: ${filePath}`), { code: 'EINVAL' });
        }
        const data = Buffer.alloc(Number(initialDescriptorStats.size));
        let offset = 0;
        while (offset < data.byteLength) {
            const bytesRead = fs.readSync(fileDescriptor, data, offset, data.byteLength - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }

        const finalDescriptorStats = fs.fstatSync(fileDescriptor, { bigint: true });
        const finalPathStats = fs.lstatSync(filePath, { bigint: true });
        const pathChanged = finalPathStats.dev !== initialPathStats.dev || finalPathStats.ino !== initialPathStats.ino;
        const descriptorChanged = finalDescriptorStats.dev !== initialDescriptorStats.dev
            || finalDescriptorStats.ino !== initialDescriptorStats.ino
            || finalDescriptorStats.size !== initialDescriptorStats.size
            || finalDescriptorStats.mtimeNs !== initialDescriptorStats.mtimeNs
            || finalDescriptorStats.ctimeNs !== initialDescriptorStats.ctimeNs;
        const regularPathChangedTarget = initialPathStats.isFile()
            && (initialDescriptorStats.dev !== initialPathStats.dev || initialDescriptorStats.ino !== initialPathStats.ino);
        if (pathChanged || descriptorChanged || regularPathChangedTarget || offset !== data.byteLength) {
            throw Object.assign(new Error(`Chat file changed while it was being read: ${filePath}`), { code: 'ESTALE' });
        }

        return {
            data: data.toString('utf8'),
            rawBuffer: data,
            hash: computeSha256(data),
            pathStats: initialPathStats,
            descriptorStats: initialDescriptorStats,
        };
    } finally {
        fs.closeSync(fileDescriptor);
    }
}

function assertChatFileSnapshotCurrent(filePath, expectedSnapshot) {
    const currentSnapshot = readChatFileSnapshot(filePath);
    if (!currentSnapshot
        || currentSnapshot.pathStats.dev !== expectedSnapshot.pathStats.dev
        || currentSnapshot.pathStats.ino !== expectedSnapshot.pathStats.ino
        || currentSnapshot.hash !== expectedSnapshot.hash) {
        throw Object.assign(new Error(`Chat file changed after it was checked: ${filePath}`), { code: 'ESTALE' });
    }
}

function assertChatFileStatTupleCurrent(filePath, expectedStatTuple) {
    let currentStats;
    try {
        currentStats = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
        throw Object.assign(new Error(`Chat file changed after it was checked: ${filePath}`, { cause: error }), { code: 'ESTALE' });
    }
    if (!currentStats.isFile() || currentStats.isSymbolicLink() || !statTuplesEqual(extractStatTuple(currentStats), expectedStatTuple)) {
        throw Object.assign(new Error(`Chat file changed after it was checked: ${filePath}`), { code: 'ESTALE' });
    }
}

function repairRejectedChatRecoverySnapshot(recoveryTarget, rejectedSnapshotData) {
    runChatRecoveryBestEffort(() => {
        const refreshedSnapshot = seedLatestChatSnapshot(recoveryTarget);
        if (!refreshedSnapshot.seeded) {
            removeLatestChatSnapshotIfMatches(recoveryTarget, rejectedSnapshotData);
        }
    }, 'Failed to reconcile chat recovery after a rejected save.');
}

// SillyBunny: O(M*F) incremental fragment search matcher replaces quadratic matchBuffer rescans.
const INCREMENTAL_MATCHER_SYMBOL = Symbol('createIncrementalChatMatcher');

/**
 * Builds an O(M×F) fragment matcher for `/api/chats/search` using a `Set` of remaining unmatched fragments.
 * Remains callable as a standard `ChatMatchFunction` `(textArray: string[]) => boolean` for `file_id` checks.
 * @param {string[]} fragments Lowercased non-empty query fragments
 * @returns {ChatMatchFunction}
 */
export function createFragmentSearchMatcher(fragments) {
    const uniqueFragments = [...new Set(fragments)];
    const matcher = (textArray) => {
        if (uniqueFragments.length === 0) {
            return true;
        }
        const remaining = new Set(uniqueFragments);
        for (const text of textArray) {
            const lower = String(text ?? '').toLowerCase();
            for (const fragment of remaining) {
                if (lower.includes(fragment)) {
                    remaining.delete(fragment);
                    if (remaining.size === 0) {
                        return true;
                    }
                }
            }
        }
        return false;
    };
    matcher[INCREMENTAL_MATCHER_SYMBOL] = () => {
        const remaining = new Set(uniqueFragments);
        return (messageText) => {
            if (remaining.size === 0) {
                return true;
            }
            const lower = String(messageText ?? '').toLowerCase();
            for (const fragment of remaining) {
                if (lower.includes(fragment)) {
                    remaining.delete(fragment);
                    if (remaining.size === 0) {
                        return true;
                    }
                }
            }
            return false;
        };
    };
    return matcher;
}

/**
 * @typedef {Object} ChatInfo
 * @property {string} [file_id] - The name of the chat file (without extension)
 * @property {string} [file_name] - The name of the chat file (with extension)
 * @property {string} [file_size] - The size of the chat file in a human-readable format
 * @property {number} [chat_items] - The number of chat items in the file
 * @property {number} [token_estimate] - The approximate number of tokens in the chat
 * @property {string} [mes] - The last message in the chat
 * @property {number|string} [last_mes] - The timestamp of the last message
 * @property {object} [chat_metadata] - Additional chat metadata
 * @property {boolean} [match] - Whether the chat matches the search criteria
 */

/**
 * Reads the information from a chat file.
 * Uses a bounded stat-tuple cache when no search matcher is supplied, and O(M×F) incremental matching when supplied a fragment matcher.
 * @param {string} pathToFile - Path to the chat file
 * @param {object} additionalData - Additional data to include in the result
 * @param {boolean} withMetadata - Whether to read chat metadata
 * @param {ChatMatchFunction|null} matcher - Optional function to match messages
 * @returns {Promise<ChatInfo>}
 *
 * @typedef {(textArray: string[]) => boolean} ChatMatchFunction
 */
export async function getChatInfo(pathToFile, additionalData = {}, withMetadata = false, matcher = null, previewMessageLimit = 0) {
    try {
        const parsedPath = path.parse(pathToFile);
        const validatedAtNs = currentTimeNs();
        // SillyBunny: bigint stat preserves full 64-bit NTFS inode IDs for ChatInfoCache validation.
        const stats = await fs.promises.stat(pathToFile, { bigint: true });
        const fileSize = Number(stats.size);
        const mtimeMs = typeof stats.mtimeNs === 'bigint'
            ? Number(stats.mtimeNs) / 1_000_000
            : Number(stats.mtimeMs);
        const hasMatcher = (typeof matcher === 'function');
        const previewLimit = Math.max(0, Number(previewMessageLimit) || 0);

        const chatData = {
            match: false,
            file_id: parsedPath.name,
            file_name: parsedPath.base,
            file_size: formatBytes(fileSize),
            chat_items: 0,
            token_estimate: 0,
            mes: '[The chat is empty]',
            last_mes: mtimeMs,
            ...additionalData,
        };

        if (fileSize === 0) {
            return chatData;
        }

        // SillyBunny: reuse stat-verified ChatInfoCache summaries on unsearched scans.
        if (!hasMatcher) {
            const cachedInfo = chatInfoCache.getIfStatMatches(pathToFile, stats, previewLimit);
            if (cachedInfo) {
                chatData.chat_items = cachedInfo.chatItems;
                chatData.token_estimate = cachedInfo.tokenEstimate;
                chatData.mes = cachedInfo.mes;
                chatData.last_mes = cachedInfo.lastMes;
                chatData.match = true;
                if (withMetadata && cachedInfo.chatMetadataJson !== null) {
                    chatData.chat_metadata = JSON.parse(cachedInfo.chatMetadataJson);
                }
                if (previewLimit > 0 && cachedInfo.previewMessagesJson !== null) {
                    const cachedPreviews = JSON.parse(cachedInfo.previewMessagesJson);
                    chatData.preview_messages = cachedPreviews.length > previewLimit
                        ? cachedPreviews.slice(-previewLimit)
                        : cachedPreviews;
                }
                return chatData;
            }
        }

        const incrementalMatcher = hasMatcher && typeof matcher[INCREMENTAL_MATCHER_SYMBOL] === 'function'
            ? matcher[INCREMENTAL_MATCHER_SYMBOL]()
            : null;

        const fileStream = fs.createReadStream(pathToFile);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity,
        });

        return await new Promise((res, rej) => {
            let lastLine;
            let itemCounter = 0;
            let hasAnyMatch = false;
            let matchBuffer = [];
            let messageCharacters = 0;
            let capturedChatMetadata = null;
            const previewMessages = [];

            fileStream.once('error', rej);
            rl.once('error', rej);

            rl.on('line', (line) => {
                const isMessageLine = itemCounter > 0;
                let jsonData = null;

                if (!isMessageLine) {
                    jsonData = tryParse(line);
                    if (jsonData && _.isObjectLike(jsonData.chat_metadata)) {
                        capturedChatMetadata = jsonData.chat_metadata;
                        if (withMetadata) {
                            chatData.chat_metadata = jsonData.chat_metadata;
                        }
                    }
                }

                if (isMessageLine) {
                    jsonData = tryParse(line);
                    if (jsonData) {
                        // SillyBunny: nothing catches a throw in this event, and converting some objects to a string throws, so only string text counts.
                        const messageText = typeof jsonData.mes === 'string' ? jsonData.mes : '';
                        messageCharacters += messageText.length;

                        // Skip matching if any match was already found
                        if (hasMatcher && !hasAnyMatch) {
                            if (incrementalMatcher) {
                                if (incrementalMatcher(messageText)) {
                                    hasAnyMatch = true;
                                }
                            } else {
                                matchBuffer.push(messageText);
                                if (matcher(matchBuffer)) {
                                    hasAnyMatch = true;
                                    matchBuffer = [];
                                }
                            }
                        }

                        if (previewLimit > 0) {
                            previewMessages.push(jsonData);
                            if (previewMessages.length > previewLimit) {
                                previewMessages.shift();
                            }
                        }
                    }
                }
                itemCounter++;
                lastLine = line;
            });
            rl.on('close', () => {
                if (!lastLine) {
                    res(chatData);
                    return;
                }

                const jsonData = tryParse(lastLine);
                if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
                    chatData.chat_items = (itemCounter - 1);
                    // SillyBunny: expose a cheap chat length indicator for chat selectors.
                    chatData.token_estimate = Math.round(messageCharacters / 4);
                    chatData.mes = jsonData.mes || '[The message is empty]';
                    chatData.last_mes = jsonData.send_date || new Date(Math.round(mtimeMs)).toISOString();
                    chatData.match = hasMatcher ? hasAnyMatch : true;
                    if (previewLimit > 0) {
                        chatData.preview_messages = previewMessages;
                    }

                    const existingCached = chatInfoCache.getIfStatMatches(pathToFile, stats, 0);
                    if (!existingCached || previewLimit >= existingCached.previewLimitCached) {
                        chatInfoCache.set(pathToFile, stats, {
                            chatItems: chatData.chat_items,
                            tokenEstimate: chatData.token_estimate,
                            mes: chatData.mes,
                            lastMes: chatData.last_mes,
                            chatMetadataJson: capturedChatMetadata !== null ? JSON.stringify(capturedChatMetadata) : null,
                            previewLimitCached: previewLimit,
                            previewMessagesJson: previewLimit > 0 ? JSON.stringify(previewMessages) : null,
                        }, validatedAtNs);
                    }

                    res(chatData);
                } else {
                    console.warn('Found an invalid or corrupted last line in a chat file:', pathToFile);
                    chatData.chat_items = Math.max(itemCounter - 2, 0);
                    chatData.token_estimate = Math.round(messageCharacters / 4);
                    chatData.mes = '[The message is empty]';
                    chatData.match = hasMatcher ? hasAnyMatch : true;
                    if (previewLimit > 0) {
                        chatData.preview_messages = previewMessages;
                    }
                    res(chatData);
                }
            });
        });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            console.warn('Chat file was deleted while it was being scanned:', pathToFile);
            return { match: false };
        }
        console.error('Failed to read chat info:', pathToFile, error);
        return {};
    }
}

export async function getListableGroupChatInfo(chatFilePath, id) {
    const chatInfo = await getChatInfo(chatFilePath);
    const fileName = String(chatInfo?.file_name ?? '').trim();

    if (fileName) {
        return chatInfo;
    }

    const fallbackFileName = sanitize(`${id}.jsonl`);
    const fallbackFileId = path.parse(fallbackFileName).name;
    const normalizedChatInfo = chatInfo && typeof chatInfo === 'object' ? chatInfo : {};

    // SillyBunny: keep corrupted group chats visible so chat selectors do not enter empty-list retry storms.
    return {
        ...normalizedChatInfo,
        file_id: String(normalizedChatInfo.file_id ?? '').trim() || fallbackFileId,
        file_name: fallbackFileName,
    };
}

// SillyBunny: group files keep chat IDs as clients send them, so a joined chat path must stay inside the group chats folder.
/**
 * Joins a chat ID from a group's chat list into the path of its chat file.
 * @param {string} groupChatsDirectory Group chats folder
 * @param {unknown} chatId Chat ID from a group's chat list
 * @returns {string|null} Path of the chat file, or null when the ID names no file inside the group chats folder
 */
export function getGroupChatPath(groupChatsDirectory, chatId) {
    if (typeof chatId !== 'string' && typeof chatId !== 'number') {
        return null;
    }

    const chatFilePath = path.join(groupChatsDirectory, `${chatId}.jsonl`);
    return isPathUnderParent(groupChatsDirectory, chatFilePath) ? chatFilePath : null;
}

export const router = express.Router();

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
// SillyBunny: the three save errors are exported so that the conversation store can tell a refused save from a failed one.
export class IntegrityMismatchError extends Error {
    constructor(...params) {
        // Pass remaining arguments (including vendor specific ones) to parent constructor
        super(...params);
        // Maintains proper stack trace for where our error was thrown (non-standard)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, IntegrityMismatchError);
        }
        this.date = new Date();
    }
}

export class InvalidChatDataError extends Error {
    constructor(...params) {
        super(...params);
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, InvalidChatDataError);
        }
        this.date = new Date();
    }
}

// SillyBunny: a save that would destroy an existing chat is rejected unless the client forces it.
export class DestructiveChatSaveError extends Error {
    constructor(reason, ...params) {
        super(...params);
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, DestructiveChatSaveError);
        }
        this.reason = reason;
        this.date = new Date();
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidChatSavePayload(chatData) {
    return Array.isArray(chatData)
        && chatData.length > 0
        && isPlainObject(chatData[0])
        && isPlainObject(chatData[0].chat_metadata)
        && chatData.every(isPlainObject);
}

function createChatRecoveryTarget(request, isGroup, fileName) {
    if (isGroup) {
        return createGroupChatTarget({
            groupChatsDirectory: request.user.directories.groupChats,
            backupDirectory: request.user.directories.backups,
            filename: fileName,
            maxRecoveryStates: maxTotalChatBackups,
        });
    }

    return createCharacterChatTarget({
        chatsDirectory: request.user.directories.chats,
        backupDirectory: request.user.directories.backups,
        owner: String(request.body.avatar_url).replace('.png', ''),
        filename: fileName,
        maxRecoveryStates: maxTotalChatBackups,
    });
}

function sendChatLoadResponse(response, target, { allowCreate = false } = {}) {
    // SillyBunny: never let malformed JSONL fall through to the fresh-chat save path.
    const result = isBackupEnabled
        ? loadActiveChatWithRecovery(target)
        : readChatJsonlStrict(target.activePath);

    if (result.status === 'ok') {
        if (result.recovered) {
            console.warn(`Recovered chat file from its latest valid snapshot: ${target.activePath}`);
        }
        // SillyBunny: stream validated raw JSONL rows directly as a JSON array when no header fixup is needed.
        const rawRows = result[CHAT_RAW_ROWS_SYMBOL];
        const headerFixedUp = result[CHAT_HEADER_FIXED_UP_SYMBOL] === true;
        if (!headerFixedUp && Array.isArray(rawRows) && rawRows.length > 0) {
            return response.type('application/json').send(`[${rawRows.join(',')}]`);
        }
        return response.send(result.records);
    }

    if (result.status === 'missing' && allowCreate) {
        return response.send([]);
    }

    const status = result.status === 'missing' ? 404 : 422;
    return response.status(status).send({ error: result.status });
}

/**
 * Tries to save the chat data to a file, performing an integrity check if required.
 * @param {Array} chatData The chat array to save.
 * @param {string} filePath Target file path for the data.
 * @param {boolean} skipIntegrityCheck If undefined, the chat's integrity will not be checked.
 * @param {string} handle The users handle, passed to getBackupFunction.
 * @param {string} cardName Passed to backupChat.
 * @param {string} backupDirectory Passed to backupChat.
 * @param {object} [options] Additional save options.
 * @param {boolean} [options.deferBackup] Skip the regular chat backup for this save.
 * @param {object} [options.recoveryTarget] Exact chat recovery target.
 * @param {boolean} [options.allowShrink] The client is deliberately removing messages, so allow a smaller chat.
 * @param {boolean} [options.persistDerivedMetadata] Persist metadata normally ignored during load-only saves.
 * @param {string} [options.integrity] Integrity slug to write instead of a fresh one; only for restoring a chat's exact earlier state.
 */
export async function trySaveChat(chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory, options = {}) {
    if (!isValidChatSavePayload(chatData)) {
        throw new InvalidChatDataError('Invalid chat save payload. Expected a non-empty chat array with a metadata header.');
    }

    const release = acquireChatFileLock(filePath);
    try {
        return trySaveChatLocked(chatData, filePath, skipIntegrityCheck, handle, cardName, backupDirectory, options);
    } finally {
        release();
    }
}

function trySaveChatLocked(chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory, { deferBackup = false, deferSequenceId = undefined, recoveryTarget = null, allowShrink = false, persistDerivedMetadata = false, integrity = '' } = {}) {
    const doIntegrityCheck = (checkIntegrity && !skipIntegrityCheck);
    const incomingIntegrity = chatData?.[0]?.chat_metadata?.integrity;
    const chatIntegritySlug = doIntegrityCheck && typeof incomingIntegrity === 'string' ? incomingIntegrity : '';
    const ignoreDerivedMetadata = !persistDerivedMetadata;

    // SillyBunny: set when the payload represents the same loaded chat apart from the rotating
    // integrity slug and the discarded outer header envelope. The save then keeps the exact bytes
    // already on disk, so the recovery snapshot and regular backup mirror the authoritative file.
    let unchangedChatData = null;
    let unchangedIntegrity;
    let backupDecision = null;
    let preserveFileIdentity = false;
    let replaceFileOnly = false;
    let expectedFileIdentity;
    let expectedFileHash;
    let currentSnapshot = null;
    let cachedEntry = null;
    let existingFile = false;
    let currentStatTuple = null;
    let currentSha256 = null;
    let diskLines = null;
    let diskSplit = null;
    let diskRawText = null;
    let diskValidated = false;
    let diskParsedHeader = null;
    let snapshotStartedAtNs = null;

    try {
        if (recoverFileWriteSync(filePath)) {
            chatStateCache.invalidate(filePath);
        }
        existingFile = fs.existsSync(filePath);
        if (existingFile) {
            // SillyBunny: reuse validated ChatStateCache entry on exact 5-field regular-file stat match.
            const pathStats = fs.lstatSync(filePath, { bigint: true });
            if (pathStats.isFile() && !pathStats.isSymbolicLink()) {
                cachedEntry = chatStateCache.getIfStatMatches(filePath, pathStats);
            }
            if (cachedEntry) {
                preserveFileIdentity = pathStats.isFile() && pathStats.nlink === 1n;
                replaceFileOnly = !preserveFileIdentity;
                expectedFileIdentity = { dev: pathStats.dev, ino: pathStats.ino };
                expectedFileHash = cachedEntry.sha256;
                currentSha256 = cachedEntry.sha256;
                currentStatTuple = withValidationTime(extractStatTuple(pathStats), cachedEntry.validatedAtNs);
                diskLines = cachedEntry.lines;
                diskParsedHeader = cachedEntry.header;
                diskValidated = true;
            } else {
                // SillyBunny: taken before the read, because a write that lands during the read can keep the timestamps the read ends with.
                snapshotStartedAtNs = currentTimeNs();
                currentSnapshot = readChatFileSnapshot(filePath);
            }
        } else {
            chatStateCache.invalidate(filePath);
        }
    } catch (error) {
        chatStateCache.invalidate(filePath);
        if (error?.code === 'ESTALE') {
            throw new IntegrityMismatchError(`Chat changed while it was being checked: "${filePath}".`, { cause: error });
        }
        if (!skipIntegrityCheck) {
            throw new DestructiveChatSaveError('unreadable', `Refused a chat save for "${cardName}": the existing chat file could not be read, so it cannot be backed up before being replaced.`);
        }
        existingFile = fs.existsSync(filePath);
    }

    let incomingHeaderLine = null;
    let incomingHeaderParsed = null;
    let incomingMessageLines = null;

    const getIncomingHeaderLine = () => {
        if (incomingHeaderLine === null) {
            incomingHeaderLine = JSON.stringify(chatData[0]);
        }
        return incomingHeaderLine;
    };

    const getIncomingHeaderParsed = () => {
        if (incomingHeaderParsed === null) {
            incomingHeaderParsed = JSON.parse(getIncomingHeaderLine());
        }
        return incomingHeaderParsed;
    };

    const getIncomingMessageLines = () => {
        if (incomingMessageLines === null) {
            incomingMessageLines = new Array(chatData.length - 1);
            for (let index = 1; index < chatData.length; index++) {
                incomingMessageLines[index - 1] = JSON.stringify(chatData[index]);
            }
        }
        return incomingMessageLines;
    };

    const getCurrentRawText = () => {
        if (diskRawText === null && cachedEntry) {
            diskRawText = getEntryRawText(cachedEntry);
        }
        return diskRawText;
    };

    if (existingFile) {
        if (currentSnapshot) {
            const activeFileStats = currentSnapshot.pathStats;
            const descriptorMatchesPath = currentSnapshot.descriptorStats.dev === activeFileStats.dev
                && currentSnapshot.descriptorStats.ino === activeFileStats.ino;
            preserveFileIdentity = activeFileStats.isFile() && activeFileStats.nlink === 1n && descriptorMatchesPath;
            replaceFileOnly = !preserveFileIdentity;
            expectedFileIdentity = { dev: activeFileStats.dev, ino: activeFileStats.ino };
            expectedFileHash = currentSnapshot.hash;
            currentSha256 = currentSnapshot.hash;
            currentStatTuple = descriptorMatchesPath
                ? withValidationTime(extractStatTuple(currentSnapshot.descriptorStats), snapshotStartedAtNs)
                : null;
            diskRawText = currentSnapshot.data;
            diskSplit = diskRawText ? splitChatLinesForComparison(diskRawText) : { lines: [], hasBom: false, isCanonical: true };
            diskLines = diskSplit.lines;
        } else if (!cachedEntry) {
            const activeFileStats = fs.lstatSync(filePath, { bigint: true });
            replaceFileOnly = true;
            expectedFileIdentity = { dev: activeFileStats.dev, ino: activeFileStats.ino };
        }

        // An existing chat that cannot be read can be neither checked nor backed up, so never overwrite it blind.
        if (!cachedEntry && !currentSnapshot && !skipIntegrityCheck) {
            throw new DestructiveChatSaveError('unreadable', `Refused a chat save for "${cardName}": the existing chat file could not be read, so it cannot be backed up before being replaced.`);
        }

        const hasExistingNonEmptyData = Boolean(cachedEntry || (diskRawText !== null && diskRawText.length > 0));
        let existingIntegrity = '';
        let destructiveReason = '';
        const existingLineCount = hasExistingNonEmptyData ? diskLines.length : 0;

        if (hasExistingNonEmptyData) {
            // Parse only row 0 on cache miss; cache hits already hold parsed row 0.
            let integrityHeader;
            if (cachedEntry) {
                integrityHeader = cachedEntry.header;
            } else {
                const headerLine = diskLines[0] ?? '';
                integrityHeader = tryParse(headerLine.replace(/^\uFEFF/, ''));
            }

            if (doIntegrityCheck && !isPlainObject(integrityHeader)) {
                throw new IntegrityMismatchError(`Chat integrity check failed for "${filePath}": the existing header is unparseable and requires explicit overwrite confirmation.`);
            }

            const rawDiskIntegrity = integrityHeader?.chat_metadata?.integrity;
            existingIntegrity = typeof rawDiskIntegrity === 'string' && rawDiskIntegrity ? rawDiskIntegrity : '';
            destructiveReason = getDestructiveChatSaveReasonByCount(chatData.length, existingLineCount);

            // SillyBunny: classify a history-destroying save before the integrity check, so the client is
            // told what is actually wrong with it. A client that lost its slug and a client sending an
            // unloaded chat both fail the slug comparison, but only the second is destructive, and
            // reporting it as a slug mismatch sends the client into a reload loop it cannot resolve:
            // reloading never repopulates the chat it failed to send.
            // Reject before the pre-write ring runs, so a rejected save cannot evict the last good state.
            // Deliberate message deletion sets allowShrink, which is not the same confirmation as an integrity overwrite.
            if (destructiveReason && !skipIntegrityCheck && !allowShrink) {
                throw new DestructiveChatSaveError(destructiveReason, `Refused a destructive chat save for "${cardName}" (${destructiveReason}): incoming payload has ${chatData.length} JSONL rows, existing file has ${existingLineCount} rows.`);
            }

            // SillyBunny: the slug rotates on every save and only reaches the client in the response
            // body, so a dropped response leaves a remote client holding the previous slug forever.
            // Accept that retry when it merely appends to what is on disk, because a superset save
            // cannot lose history; a genuinely divergent save still fails the check.
            if (doIntegrityCheck && existingIntegrity && existingIntegrity !== chatIntegritySlug) {
                const canExtend = chatData.length >= existingLineCount && isChatSaveExtensionFast(
                    {
                        lines: [getIncomingHeaderLine(), ...getIncomingMessageLines()],
                        header: getIncomingHeaderParsed(),
                        validated: true,
                    },
                    {
                        lines: diskLines,
                        header: cachedEntry ? cachedEntry.header : null,
                        validated: diskValidated,
                        rawText: diskRawText ?? undefined,
                        getRawText: getCurrentRawText,
                    },
                    { ignoreDerivedMetadata },
                );
                if (!canExtend) {
                    throw new IntegrityMismatchError(`Chat integrity check failed for "${filePath}". The expected integrity slug was "${chatIntegritySlug}".`);
                }
            }

            // SillyBunny: compare parsed records because loading canonicalizes legacy JSONL formatting.
            // Replacing equivalent content through atomic temp-and-rename would swap the file identity
            // for no gain. Legacy chats remain slugless until their first genuine content change.
            backupDecision = getDeferredPreWriteBackupDecision({
                filePath,
                deferBackup,
                deferSequenceId,
            });

            let isUnchanged = false;
            if (chatData.length === existingLineCount) {
                const inHeaderNorm = normalizeChatHeaderForComparison(getIncomingHeaderParsed(), { ignoreDerivedMetadata });
                const diskHeaderForCompare = cachedEntry ? cachedEntry.header : parseStrictPlainJsonObject(diskLines[0] ?? '');
                const diskHeaderNorm = diskHeaderForCompare
                    ? normalizeChatHeaderForComparison(diskHeaderForCompare, { ignoreDerivedMetadata })
                    : null;
                if (inHeaderNorm && diskHeaderNorm && isDeepStrictEqual(inHeaderNorm, diskHeaderNorm)) {
                    isUnchanged = isSameChatSaveContentFast(
                        {
                            lines: [getIncomingHeaderLine(), ...getIncomingMessageLines()],
                            header: getIncomingHeaderParsed(),
                            validated: true,
                        },
                        {
                            lines: diskLines,
                            header: diskHeaderForCompare,
                            validated: diskValidated,
                        },
                        { ignoreDerivedMetadata },
                    );
                    if (isUnchanged) {
                        diskParsedHeader = diskHeaderForCompare;
                        // SillyBunny: only trust raw disk bytes on cache miss when they pass strict UTF-8 validation.
                        if (cachedEntry || (currentSnapshot?.rawBuffer && isValidUtf8Buffer(currentSnapshot.rawBuffer))) {
                            diskValidated = true;
                        }
                    }
                }
            }

            if (isUnchanged) {
                unchangedChatData = getCurrentRawText();
                unchangedIntegrity = existingIntegrity;
            } else {
                if (backupDecision.shouldCreateBackup) {
                    const prewriteHardLinkContext = (isBackupEnabled && recoveryTarget && cachedEntry?.latestEqualsActive && cachedEntry?.latestTuple)
                        ? {
                            latestPath: getChatRecoveryPaths(recoveryTarget).latestPath,
                            latestTuple: cachedEntry.latestTuple,
                            latestSha: cachedEntry.latestSha,
                        }
                        : null;
                    const prewriteResult = backupChatPreWrite(backupDirectory, cardName, getCurrentRawText, handle, {
                        normalizedHash: cachedEntry?.normalizedBackupHash ?? undefined,
                        byteLength: currentStatTuple ? Number(currentStatTuple.size) : undefined,
                        hardLinkContext: prewriteHardLinkContext,
                    });
                    // SillyBunny: fs.linkSync updates ctimeNs (and utimesSync may update mtimeNs) on the shared inode.
                    if ((prewriteResult?.linked || prewriteResult?.bumpedSourceMtime) && cachedEntry) {
                        chatStateCache.update(filePath, { latestTuple: prewriteResult.writtenTuple ?? null });
                        cachedEntry = chatStateCache.get(filePath);
                    }
                } else {
                    logBackupEvent('chat-backup-skipped', {
                        type: 'pre-write',
                        handle,
                        chat: cardName,
                        reason: backupDecision.closeSequence ? 'deferred-closed' : 'deferred-intermediate',
                    });
                }

                if (destructiveReason) {
                    console.warn(`Forced destructive chat save for "${cardName}" (${destructiveReason}): incoming payload has ${chatData.length} JSONL rows, existing file has ${existingLineCount} rows.`);
                }

                if (skipIntegrityCheck) {
                    backupChat(backupDirectory, cardName, getCurrentRawText(), CHAT_FORCED_OVERWRITE_BACKUPS_PREFIX, handle);
                }
            }
        }
    }

    // Generate nextIntegrity and assemble JSONL only after rejection & unchanged checks pass.
    let nextIntegrity;
    let nextHeaderObj = null;
    let nextLines = null;
    let jsonlData = null;
    let jsonlBuffer = null;
    let nextSha256 = null;
    let nextNormalizedBackupHash = null;

    if (unchangedChatData === null) {
        // SillyBunny: taking back a server-written reply restores the chat's earlier slug, so the save of the page that claimed it still passes.
        nextIntegrity = typeof integrity === 'string' && integrity ? integrity : uuidv4();
        nextHeaderObj = {
            ...chatData[0],
            chat_metadata: { ...(chatData[0]?.chat_metadata || {}), integrity: nextIntegrity },
        };
        const nextHeaderLine = JSON.stringify(nextHeaderObj);
        const messageLines = getIncomingMessageLines();
        nextLines = [nextHeaderLine, ...messageLines];
        jsonlData = nextLines.join('\n');
        jsonlBuffer = Buffer.from(jsonlData, 'utf8');
        nextSha256 = computeSha256(jsonlBuffer);
        nextNormalizedBackupHash = computeNormalizedBackupHashFromLines(nextHeaderObj, messageLines);
    }

    const persistedChatData = unchangedChatData ?? jsonlData;
    const persistedBuffer = unchangedChatData !== null
        ? (currentSnapshot?.rawBuffer ?? (cachedEntry ? getEntryRawBuffer(cachedEntry) : Buffer.from(unchangedChatData, 'utf8')))
        : jsonlBuffer;
    const persistedSha256 = unchangedChatData !== null ? currentSha256 : nextSha256;
    const persistedNormalizedBackupHash = unchangedChatData !== null
        ? (cachedEntry?.normalizedBackupHash ?? computeNormalizedBackupHash(unchangedChatData))
        : nextNormalizedBackupHash;

    const savedChatSizeDetails = getSerializedBackupSizeDetails(persistedBuffer, persistedBuffer.byteLength);
    logBackupEvent('chat-save', {
        handle,
        chat: cardName,
        rows: Array.isArray(chatData) ? chatData.length : undefined,
        force: Boolean(skipIntegrityCheck),
        deferBackup: Boolean(deferBackup),
        ...savedChatSizeDetails,
    });

    // SillyBunny: the regular backup still runs for an unchanged save. An agent run defers every
    // backup and closes with one non-deferred save, which can land unchanged; skipping it there would
    // leave the whole run without a backup. checkDuplicateChatBackup collapses the steady state.
    let hasRecoverySnapshot = false;
    let latestSnapshotTuple = cachedEntry?.latestTuple ?? null;
    let latestSnapshotSha = cachedEntry?.latestSha ?? null;

    if (isBackupEnabled && recoveryTarget) {
        // SillyBunny: exact snapshots are immediate and are not subject to history backup throttling.
        // Destructive payloads are rejected above, so this cannot mirror a chat-destroying write.
        try {
            const canUseTrustedSnapshot = unchangedChatData === null || diskValidated;
            let snapshot;
            if (canUseTrustedSnapshot) {
                snapshot = writeLatestChatSnapshotTrusted(recoveryTarget, persistedBuffer, {
                    dataSha: persistedSha256,
                    cachedLatestTuple: latestSnapshotTuple,
                    cachedLatestSha: latestSnapshotSha,
                });
                latestSnapshotTuple = snapshot.latestTuple;
                latestSnapshotSha = snapshot.latestSha;
            } else {
                snapshot = writeLatestChatSnapshot(recoveryTarget, persistedChatData);
            }
            hasRecoverySnapshot = snapshot.stored === true;
            maybeInjectChatIoFault('after_latest_snapshot');
        } catch (error) {
            // Recovery storage is supplementary and must not prevent the active chat save.
            console.warn('Failed to write the exact chat recovery snapshot; continuing with the active chat save.', error);
        }
    }

    // SillyBunny: a tuple that an external same-size write could have left unchanged (see `isStatTupleRacy`) proves
    // nothing about the bytes on disk, so the checks below fall back to comparing content for it.
    const settledStatTuple = (currentStatTuple && isReliableStatTuple(currentStatTuple) && !isStatTupleRacy(currentStatTuple))
        ? currentStatTuple
        : null;

    if (unchangedChatData !== null && (currentStatTuple || currentSnapshot)) {
        try {
            if (settledStatTuple) {
                assertChatFileStatTupleCurrent(filePath, settledStatTuple);
            } else if (currentSnapshot) {
                assertChatFileSnapshotCurrent(filePath, currentSnapshot);
            } else if (!confirmFileContentSync(filePath, currentSha256, currentStatTuple)) {
                throw Object.assign(new Error(`Chat file changed after it was checked: ${filePath}`), { code: 'ESTALE' });
            }
        } catch (error) {
            chatStateCache.invalidate(filePath);
            if (hasRecoverySnapshot && recoveryTarget) {
                repairRejectedChatRecoverySnapshot(recoveryTarget, persistedChatData);
            }
            throw new IntegrityMismatchError(`Chat changed after it was checked: "${filePath}".`, { cause: error });
        }
    }

    if (unchangedChatData === null) {
        let postWriteStatTuple = null;
        try {
            // SillyBunny: when a durable redo snapshot exists, write in place with Barriers #1 to #3.
            if (preserveFileIdentity && hasRecoverySnapshot) {
                postWriteStatTuple = writeChatFileInPlaceFast(filePath, jsonlBuffer, {
                    expectedFileIdentity,
                    expectedFileHash,
                    expectedStatTuple: settledStatTuple,
                    getRollbackBuffer: () => {
                        if (currentSnapshot?.rawBuffer) {
                            return currentSnapshot.rawBuffer;
                        }
                        if (cachedEntry) {
                            return getEntryRawBuffer(cachedEntry);
                        }
                        return Buffer.from(diskRawText ?? '', 'utf8');
                    },
                });
            } else {
                tryWriteFileSync(filePath, jsonlData, 'utf8', {
                    preserveFileIdentity,
                    expectedFileIdentity,
                    expectedFileHash,
                    expectedFileAbsent: !existingFile,
                    invalidateBeforeWrite: preserveFileIdentity && hasRecoverySnapshot,
                    replaceFileOnly,
                    durable: !existingFile,
                });
                try {
                    const postStats = fs.lstatSync(filePath, { bigint: true });
                    if (postStats.isFile() && !postStats.isSymbolicLink()) {
                        postWriteStatTuple = withValidationTime(extractStatTuple(postStats));
                    }
                } catch {
                    postWriteStatTuple = null;
                }
            }
        } catch (error) {
            chatStateCache.invalidate(filePath);
            chatInfoCache.invalidate(filePath);
            if (['EMLINK', 'ESTALE'].includes(error?.code)) {
                if (hasRecoverySnapshot && recoveryTarget) {
                    repairRejectedChatRecoverySnapshot(recoveryTarget, persistedChatData);
                }
                throw new IntegrityMismatchError(`Chat changed after it was checked: "${filePath}".`, { cause: error });
            }
            throw error;
        }

        chatInfoCache.invalidate(filePath);
        if (postWriteStatTuple && isReliableStatTuple(postWriteStatTuple)) {
            chatStateCache.set(filePath, {
                ...postWriteStatTuple,
                sha256: nextSha256,
                lines: nextLines,
                header: nextHeaderObj,
                headerFixedUp: false,
                isCanonical: true,
                rawBuffer: null,
                latestTuple: latestSnapshotTuple,
                latestSha: latestSnapshotSha,
                latestEqualsActive: hasRecoverySnapshot,
                normalizedBackupHash: nextNormalizedBackupHash,
            });
        } else {
            chatStateCache.invalidate(filePath);
        }

        logBackupEvent('chat-save-written', {
            handle,
            chat: cardName,
            mode: preserveFileIdentity ? 'in-place' : replaceFileOnly ? 'replace' : 'atomic',
            ...savedChatSizeDetails,
        });
    } else {
        if (cachedEntry) {
            chatStateCache.update(filePath, {
                latestTuple: latestSnapshotTuple,
                latestSha: latestSnapshotSha,
                latestEqualsActive: hasRecoverySnapshot || cachedEntry.latestEqualsActive,
                normalizedBackupHash: persistedNormalizedBackupHash,
            });
        } else if (currentStatTuple && isReliableStatTuple(currentStatTuple) && diskValidated && diskParsedHeader) {
            const isCanonical = diskSplit?.isCanonical === true;
            chatStateCache.set(filePath, {
                ...currentStatTuple,
                sha256: currentSha256,
                lines: diskLines,
                header: diskParsedHeader,
                headerFixedUp: !isPlainObject(diskParsedHeader.chat_metadata),
                isCanonical,
                rawBuffer: isCanonical ? null : (currentSnapshot?.rawBuffer ?? Buffer.from(unchangedChatData, 'utf8')),
                latestTuple: latestSnapshotTuple,
                latestSha: latestSnapshotSha,
                latestEqualsActive: hasRecoverySnapshot,
                normalizedBackupHash: persistedNormalizedBackupHash,
            });
        }
        logBackupEvent('chat-save-skipped', { handle, chat: cardName, reason: 'unchanged', force: Boolean(skipIntegrityCheck), ...savedChatSizeDetails });
    }
    // A no-op cannot open a sequence: it has not captured a pre-write snapshot yet.
    if (backupDecision && (!backupDecision.beginSequence || unchangedChatData === null)) {
        commitDeferredPreWriteBackupDecision(backupDecision, deferSequenceId);
    }
    if (!deferBackup) {
        getBackupFunction(handle, cardName)(backupDirectory, cardName, persistedChatData, CHAT_BACKUPS_PREFIX, handle, {
            normalizedHash: persistedNormalizedBackupHash,
        });
    } else {
        logBackupEvent('chat-backup-skipped', { type: 'regular', handle, chat: cardName, reason: 'deferred', ...savedChatSizeDetails });
    }
    return { integrity: unchangedIntegrity ?? nextIntegrity };
}

/**
 * SillyBunny: read-modify-write of a chat on the server's own behalf, with the same locking,
 * integrity, backup and recovery handling as a browser save. The save is checked against the slug
 * that was read, so a browser save landing in between turns this into a conflict, not an overwrite.
 * @param {{ profile: { handle: string }, directories: import('../users.js').UserDirectoryList }} user Request user
 * @param {{ avatarUrl?: string|null, groupChatId?: string|null, fileName?: string, conversationChat?: { conversationId: string, chatId: string }|null }} target Character chat (avatar + file name), group chat id, or a chat of a conversation
 * @param {(records: object[]) => ({ records: object[], integrity?: string, allowShrink?: boolean }|null)} update Receives the parsed file, header first; returns the records to save (when restoring an earlier state, also the slug that state had and whether it may be shorter), or null to leave the file alone
 * @returns {Promise<{ status: 'saved', integrity: string, previousIntegrity: string } | { status: 'unchanged'|'missing'|'conflict', reason?: string }>}
 */
export async function updateChatRecords(user, { avatarUrl = null, groupChatId = null, fileName = '', conversationChat = null }, update) {
    // SillyBunny: a chat of a conversation lives under conversations/<id>/chats/, so its location and its recovery target come from the conversation paths module.
    if (conversationChat) {
        const conversationTarget = resolveConversationChatTarget(user.directories, conversationChat, maxTotalChatBackups);
        return conversationTarget ? updateChatRecordsAt(user, conversationTarget, update) : { status: 'missing', reason: 'invalid-target' };
    }
    const isGroup = groupChatId !== null;
    const ownerName = isGroup ? String(groupChatId) : String(avatarUrl ?? '');
    if (!ownerName || (!isGroup && forbiddenRegExp.test(ownerName))) {
        return { status: 'missing', reason: 'invalid-target' };
    }
    const cardName = isGroup ? ownerName : ownerName.replace('.png', '');
    const chatFileName = sanitize(`${isGroup ? ownerName : String(fileName)}.jsonl`);
    const rootDirectory = isGroup ? user.directories.groupChats : user.directories.chats;
    const filePath = isGroup ? path.join(rootDirectory, chatFileName) : path.join(rootDirectory, cardName, chatFileName);
    if (!isPathUnderParent(rootDirectory, filePath)) {
        return { status: 'missing', reason: 'invalid-target' };
    }
    const recoveryTarget = isGroup
        ? createGroupChatTarget({ groupChatsDirectory: rootDirectory, backupDirectory: user.directories.backups, filename: chatFileName, maxRecoveryStates: maxTotalChatBackups })
        : createCharacterChatTarget({ chatsDirectory: rootDirectory, backupDirectory: user.directories.backups, owner: cardName, filename: chatFileName, maxRecoveryStates: maxTotalChatBackups });
    return updateChatRecordsAt(user, { cardName, filePath, recoveryTarget }, update);
}

async function updateChatRecordsAt(user, { cardName, filePath, recoveryTarget }, update) {
    const current = readChatJsonlStrict(filePath);
    if (current.status !== 'ok') {
        return { status: 'missing', reason: current.status };
    }
    const next = update(current.records);
    if (!next) {
        return { status: 'unchanged' };
    }
    const previousIntegrity = String(/** @type {any} */ (current.records[0])?.chat_metadata?.integrity ?? '');
    // The check compares against the file as read: a save landing in between is still a conflict.
    const [header, ...messages] = next.records;
    const records = [{ ...header, chat_metadata: { ...(/** @type {any} */ (header)?.chat_metadata ?? {}), integrity: previousIntegrity } }, ...messages];
    try {
        const result = await trySaveChat(records, filePath, false, user.profile.handle, cardName, user.directories.backups, {
            recoveryTarget,
            integrity: next.integrity,
            allowShrink: next.allowShrink === true,
        });
        return { status: 'saved', integrity: result.integrity, previousIntegrity };
    } catch (error) {
        if (error instanceof IntegrityMismatchError || error instanceof DestructiveChatSaveError || error instanceof InvalidChatDataError) {
            return { status: 'conflict', reason: error.message };
        }
        throw error;
    }
}

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatData = request.body.chat;
        const chatFileName = `${String(request.body.file_name)}.jsonl`;
        const sanitizedChatFileName = sanitize(chatFileName);
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitizedChatFileName);
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }

        if (Array.isArray(chatData)) {
            const recoveryTarget = createChatRecoveryTarget(request, false, sanitizedChatFileName);
            const saveResult = await trySaveChat(chatData, chatFilePath, request.body.force, handle, cardName, request.user.directories.backups, {
                deferBackup: request.body.deferBackup === true,
                deferSequenceId: typeof request.body.deferSequenceId === 'string' ? request.body.deferSequenceId : undefined,
                allowShrink: request.body.allowShrink === true,
                recoveryTarget,
            });
            return response.send({ ok: true, integrity: saveResult.integrity });
        } else {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            console.error(error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        if (error instanceof DestructiveChatSaveError) {
            console.error(error.message);
            return response.status(409).send({ error: 'destructive', reason: error.reason });
        }
        if (error instanceof InvalidChatDataError) {
            console.error(error.message);
            return response.status(400).send({ error: error.message });
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

/**
 * Gets the chat as an object.
 * @param {string} chatFilePath The full chat file path.
 * @returns {Array}} If the chatFilePath cannot be read, this will return [].
 */
export function getChatData(chatFilePath) {
    let chatData = [];

    const chatJSON = tryReadFileSync(chatFilePath);
    if (typeof chatJSON === 'string' && chatJSON.length > 0) {
        const lines = chatJSON.split('\n');
        // Iterate through the array of strings and parse each line as JSON
        chatData = lines.map(line => tryParse(line)).filter(x => x);
    } else if (fs.existsSync(chatFilePath)) {
        console.warn(`Chat file is empty: ${chatFilePath}.`);
    }

    return chatData;
}

router.post('/get', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const directoryPath = path.join(request.user.directories.chats, dirName);
        if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
            return response.sendStatus(400);
        }
        if (!request.body.file_name) {
            return response.send([]);
        }

        const chatFileName = `${String(request.body.file_name)}.jsonl`;
        const recoveryTarget = createChatRecoveryTarget(request, false, sanitize(chatFileName));
        return sendChatLoadResponse(response, recoveryTarget, { allowCreate: request.body.allow_create === true });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.original_file || !request.body.renamed_file) {
            return response.sendStatus(400);
        }

        const pathToFolder = request.body.is_group
            ? request.user.directories.groupChats
            : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
        if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, pathToFolder)) {
            return response.sendStatus(400);
        }
        const originalFileName = sanitize(request.body.original_file);
        const renamedFileName = sanitize(request.body.renamed_file);
        const pathToOriginalFile = path.join(pathToFolder, originalFileName);
        const pathToRenamedFile = path.join(pathToFolder, renamedFileName);
        const sanitizedFileName = path.parse(pathToRenamedFile).name;
        console.debug('Old chat name', pathToOriginalFile);
        console.debug('New chat name', pathToRenamedFile);

        const releaseRenameLocks = acquireChatFileLocks([pathToOriginalFile, pathToRenamedFile]);
        try {
            if (!fs.existsSync(pathToOriginalFile) || fs.existsSync(pathToRenamedFile)) {
                console.error('Either Source or Destination files are not available');
                return response.status(400).send({ error: true });
            }

            const sourceRecoveryTarget = createChatRecoveryTarget(request, request.body.is_group, originalFileName);
            const destinationRecoveryTarget = createChatRecoveryTarget(request, request.body.is_group, renamedFileName);
            const requestedChatIdHash = request.body.chat_id_hash;
            if (Number.isSafeInteger(requestedChatIdHash)) {
                const sourceChat = readChatJsonlStrict(pathToOriginalFile);
                const storedChatIdHash = sourceChat.records?.[0]?.chat_metadata?.chat_id_hash;
                const storedMainChat = sourceChat.records?.[0]?.chat_metadata?.main_chat;
                const hasStableMainChat = typeof storedMainChat === 'string' && storedMainChat.trim().length > 0;
                if (sourceChat.status === 'ok' && !Number.isSafeInteger(storedChatIdHash) && !hasStableMainChat) {
                    sourceChat.records[0] = {
                        ...sourceChat.records[0],
                        chat_metadata: {
                            ...(sourceChat.records[0].chat_metadata || {}),
                            chat_id_hash: requestedChatIdHash,
                        },
                    };
                    trySaveChatLocked(
                        sourceChat.records,
                        pathToOriginalFile,
                        false,
                        request.user.profile.handle,
                        path.parse(originalFileName).name,
                        request.user.directories.backups,
                        { deferBackup: true, recoveryTarget: sourceRecoveryTarget, persistDerivedMetadata: true },
                    );
                }
            }
            if (isBackupEnabled) {
                runChatRecoveryBestEffort(
                    () => seedLatestChatSnapshot(sourceRecoveryTarget),
                    'Failed to prepare chat recovery state; continuing with chat rename.',
                );
            }

            // SillyBunny: atomic renames prevent interrupted chat renames from leaving cloned files behind.
            const renameResult = renameChatFile(pathToOriginalFile, pathToRenamedFile);
            chatStateCache.invalidate(pathToOriginalFile);
            chatStateCache.invalidate(pathToRenamedFile);
            chatInfoCache.invalidate(pathToOriginalFile);
            chatInfoCache.invalidate(pathToRenamedFile);
            clearDeferredPreWriteBackupSequence(pathToOriginalFile);
            if (isBackupEnabled) {
                const rekeyResult = runChatRecoveryBestEffort(
                    () => rekeyChatRecoveryState(sourceRecoveryTarget, destinationRecoveryTarget),
                    'Failed to move chat recovery state; continuing with renamed chat.',
                );
                if (!rekeyResult.ok) {
                    runChatRecoveryBestEffort(
                        () => clearChatRecoveryState(sourceRecoveryTarget),
                        'Failed to clear source chat recovery state after rename.',
                    );
                    runChatRecoveryBestEffort(
                        () => clearChatRecoveryState(destinationRecoveryTarget),
                        'Failed to clear destination chat recovery state after rename.',
                    );
                }
            }
            console.info(`Successfully renamed chat file (${renameResult.method}).`);
            return response.send({ ok: true, sanitizedFileName });
        } finally {
            releaseRenameLocks();
        }
    } catch (error) {
        console.error('Error renaming chat file:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, function (request, response) {
    try {
        if (!path.extname(request.body.chatfile)) {
            request.body.chatfile += '.jsonl';
        }

        const dirName = String(request.body.avatar_url).replace('.png', '');
        const chatFileName = String(request.body.chatfile);
        const sanitizedChatFileName = sanitize(chatFileName);
        const chatFilePath = path.join(request.user.directories.chats, dirName, sanitizedChatFileName);
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }
        const recoveryTarget = createChatRecoveryTarget(request, false, sanitizedChatFileName);
        if (isBackupEnabled) {
            runChatRecoveryBestEffort(
                () => markChatDeleted(recoveryTarget),
                'Failed to mark chat recovery state for deletion; continuing with chat deletion.',
            );
        }

        //Return success if the file was deleted.
        let chatFileDeleted = false;
        try {
            chatFileDeleted = tryDeleteFile(chatFilePath);
        } finally {
            // SillyBunny: a chat that survived the delete must not keep a tombstone blocking its recovery.
            if (isBackupEnabled && !chatFileDeleted) {
                runChatRecoveryBestEffort(
                    () => seedLatestChatSnapshot(recoveryTarget),
                    'Failed to clear the chat recovery tombstone after a failed deletion.',
                );
            }
        }

        if (chatFileDeleted) {
            // SillyBunny: invalidate in-process chat caches on delete.
            chatStateCache.invalidate(chatFilePath);
            chatInfoCache.invalidate(chatFilePath);
            clearDeferredPreWriteBackupSequence(chatFilePath);
            runChatRecoveryBestEffort(
                () => clearChatRecoveryState(recoveryTarget),
                'Failed to clear chat recovery state after deletion.',
            );
            return response.send({ ok: true });
        } else {
            console.error('The chat file was not deleted.');
            return response.sendStatus(400);
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    // SillyBunny: Express does not catch an error that leaves an async route, so the whole handler runs inside this try block.
    try {
        if (typeof request.body.file !== 'string' || (!request.body.avatar_url && request.body.is_group === false)) {
            return response.sendStatus(400);
        }
        // SillyBunny: a name that sanitizes to an empty string names the chat folder itself.
        const chatFileName = sanitize(request.body.file);
        if (!chatFileName) {
            return response.sendStatus(400);
        }
        const pathToFolder = request.body.is_group
            ? request.user.directories.groupChats
            : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
        const filename = path.join(pathToFolder, chatFileName);
        if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, filename)) {
            return response.sendStatus(400);
        }
        let exportfilename = request.body.exportfilename;
        if (!fs.existsSync(filename)) {
            const errorMessage = {
                message: `Could not find JSONL file to export. Source chat file: ${filename}.`,
            };
            console.error(errorMessage.message);
            return response.status(404).json(errorMessage);
        }
        // Short path for JSONL files
        if (request.body.format === 'jsonl') {
            try {
                const rawFile = fs.readFileSync(filename, 'utf8');
                const successMessage = {
                    message: `Chat saved to ${exportfilename}`,
                    result: rawFile,
                };

                console.info(`Chat exported as ${exportfilename}`);
                return response.status(200).json(successMessage);
            } catch (err) {
                console.error(err);
                const errorMessage = {
                    message: `Could not read JSONL file to export. Source chat file: ${filename}.`,
                };
                console.error(errorMessage.message);
                return response.status(500).json(errorMessage);
            }
        }

        const readStream = fs.createReadStream(filename);
        const rl = readline.createInterface({
            input: readStream,
        });
        // SillyBunny: a throw in a stream event escapes this try block, so the stream settles a promise and a line that is not a chat message is skipped.
        const buffer = await new Promise((resolve, reject) => {
            let text = '';
            let skippedLines = 0;
            // readline re-emits input stream errors; without a listener the emit throws
            readStream.once('error', reject);
            rl.once('error', reject);
            rl.on('line', (line) => {
                try {
                    const data = JSON.parse(line);
                    // Skip non-printable/prompt-hidden messages
                    if (data.is_system) {
                        return;
                    }
                    if (data.mes) {
                        const name = data.name;
                        const message = (data?.extra?.display_text || data?.mes || '').replace(/\r?\n/g, '\n');
                        text += (`${name}: ${message}\n\n`);
                    }
                } catch {
                    skippedLines++;
                }
            });
            rl.on('close', () => {
                if (skippedLines > 0) {
                    console.warn(`Skipped ${skippedLines} lines that are not chat messages while exporting ${filename}.`);
                }
                resolve(text);
            });
        });
        const successMessage = {
            message: `Chat saved to ${exportfilename}`,
            result: buffer,
        };
        console.info(`Chat exported as ${exportfilename}`);
        return response.status(200).json(successMessage);
    } catch (err) {
        console.error('chat export failed.', err);
        return response.sendStatus(400);
    }
});

router.post('/group/import', function (request, response) {
    try {
        const filedata = request.file;

        if (!filedata) {
            return response.sendStatus(400);
        }

        const chatname = humanizedDateTime();
        const pathToUpload = path.join(filedata.destination, filedata.filename);
        const pathToNewFile = path.join(request.user.directories.groupChats, `${chatname}.jsonl`);
        fs.copyFileSync(pathToUpload, pathToNewFile);
        // SillyBunny: invalidate chat caches for imported group chat file.
        chatStateCache.invalidate(pathToNewFile);
        chatInfoCache.invalidate(pathToNewFile);
        fs.unlinkSync(pathToUpload);
        return response.send({ res: chatname });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/import', validateAvatarUrlMiddleware, function (request, response) {
    if (!request.body) return response.sendStatus(400);

    const format = request.body.file_type;
    const avatarUrl = (request.body.avatar_url).replace('.png', '');
    const characterName = sanitize(request.body.character_name) || 'Character';
    const userName = sanitize(request.body.user_name) || 'User';
    const fileNames = [];

    if (!request.file) {
        return response.sendStatus(400);
    }

    const directoryPath = path.join(request.user.directories.chats, avatarUrl);
    if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
        return response.sendStatus(400);
    }

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const data = fs.readFileSync(pathToUpload, 'utf8');

        if (format === 'json') {
            fs.unlinkSync(pathToUpload);
            const jsonData = JSON.parse(data);

            /** @type {function(string, string, object): string|string[]} */
            let importFunc;

            if (jsonData.savedsettings !== undefined) { // Kobold Lite format
                importFunc = importKoboldLiteChat;
            } else if (jsonData.histories !== undefined) { // CAI Tools format
                importFunc = importCAIChat;
            } else if (Array.isArray(jsonData.data_visible)) { // oobabooga's format
                importFunc = importOobaChat;
            } else if (Array.isArray(jsonData.messages)) { // Agnai's format
                importFunc = importAgnaiChat;
            } else if (jsonData.type === 'risuChat') { // RisuAI format
                importFunc = importRisuChat;
            } else { // Unknown format
                console.error('Incorrect chat format .json');
                return response.send({ error: true });
            }

            const handleChat = (chat) => {
                const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
                const filePath = path.join(directoryPath, fileName);
                fileNames.push(fileName);
                writeFileAtomicSync(filePath, chat, 'utf8');
                // SillyBunny: invalidate chat caches for imported character chat file.
                chatStateCache.invalidate(filePath);
                chatInfoCache.invalidate(filePath);
            };

            const chat = importFunc(userName, characterName, jsonData);

            if (Array.isArray(chat)) {
                chat.forEach(handleChat);
            } else {
                handleChat(chat);
            }

            return response.send({ res: true, fileNames });
        }

        if (format === 'jsonl') {
            let lines = data.split('\n');
            const header = lines[0];

            const jsonData = JSON.parse(header);

            if (!isRecognizedChatHeader(jsonData)) {
                console.error('Incorrect chat format .jsonl');
                return response.send({ error: true });
            }

            // Do a tiny bit of work to import Chub Chat data
            // Processing the entire file is so fast that it's not worth checking if it's a Chub chat first
            let flattenedChat = data;
            try {
                // flattening is unlikely to break, but it's not worth failing to
                // import normal chats in an attempt to import a Chub chat
                flattenedChat = flattenChubChat(userName, characterName, lines);
            } catch (error) {
                console.warn('Failed to flatten Chub Chat data: ', error);
            }

            const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
            const filePath = path.join(directoryPath, fileName);
            fileNames.push(fileName);
            if (flattenedChat !== data) {
                writeFileAtomicSync(filePath, flattenedChat, 'utf8');
            } else {
                fs.copyFileSync(pathToUpload, filePath);
            }
            // SillyBunny: invalidate chat caches for imported JSONL chat file.
            chatStateCache.invalidate(filePath);
            chatInfoCache.invalidate(filePath);
            fs.unlinkSync(pathToUpload);
            response.send({ res: true, fileNames });
        }
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/group/get', (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    try {
        const id = request.body.id;
        const recoveryTarget = createChatRecoveryTarget(request, true, sanitize(`${id}.jsonl`));
        return sendChatLoadResponse(response, recoveryTarget, { allowCreate: request.body.allow_create === true });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/info', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const recoveryTarget = createChatRecoveryTarget(request, true, sanitize(`${id}.jsonl`));
        const loadResult = isBackupEnabled
            ? loadActiveChatWithRecovery(recoveryTarget)
            : readChatJsonlStrict(chatFilePath);

        if (loadResult.status === 'missing') {
            return response.status(404).send({ error: 'not_found' });
        }
        if (loadResult.status === 'corrupt' && loadResult.data === null) {
            return response.status(422).send({ error: 'unsafe_chat_file' });
        }

        const chatInfo = await getListableGroupChatInfo(chatFilePath, id);
        return response.send(chatInfo);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/delete', (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const chatFileName = sanitize(`${id}.jsonl`);
        const chatFilePath = path.join(request.user.directories.groupChats, chatFileName);
        const recoveryTarget = createChatRecoveryTarget(request, true, chatFileName);

        if (isBackupEnabled) {
            runChatRecoveryBestEffort(
                () => markChatDeleted(recoveryTarget),
                'Failed to mark chat recovery state for deletion; continuing with chat deletion.',
            );
        }

        //Return success if the file was deleted.
        let chatFileDeleted = false;
        try {
            chatFileDeleted = tryDeleteFile(chatFilePath);
        } finally {
            // SillyBunny: a chat that survived the delete must not keep a tombstone blocking its recovery.
            if (isBackupEnabled && !chatFileDeleted) {
                runChatRecoveryBestEffort(
                    () => seedLatestChatSnapshot(recoveryTarget),
                    'Failed to clear the chat recovery tombstone after a failed deletion.',
                );
            }
        }

        if (chatFileDeleted) {
            // SillyBunny: invalidate in-process chat caches on delete.
            chatStateCache.invalidate(chatFilePath);
            chatInfoCache.invalidate(chatFilePath);
            clearDeferredPreWriteBackupSequence(chatFilePath);
            runChatRecoveryBestEffort(
                () => clearChatRecoveryState(recoveryTarget),
                'Failed to clear chat recovery state after deletion.',
            );
            return response.send({ ok: true });
        } else {
            console.error('The group chat file was not deleted.');
            return response.sendStatus(400);
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/save', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const handle = request.user.profile.handle;
        const chatFileName = sanitize(`${id}.jsonl`);
        const chatFilePath = path.join(request.user.directories.groupChats, chatFileName);
        const chatData = request.body.chat;

        if (Array.isArray(chatData)) {
            const recoveryTarget = createChatRecoveryTarget(request, true, chatFileName);
            const saveResult = await trySaveChat(chatData, chatFilePath, request.body.force, handle, String(id), request.user.directories.backups, {
                deferBackup: request.body.deferBackup === true,
                deferSequenceId: typeof request.body.deferSequenceId === 'string' ? request.body.deferSequenceId : undefined,
                allowShrink: request.body.allowShrink === true,
                recoveryTarget,
            });
            return response.send({ ok: true, integrity: saveResult.integrity });
        } else {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            console.error(error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        if (error instanceof DestructiveChatSaveError) {
            console.error(error.message);
            return response.status(409).send({ error: 'destructive', reason: error.reason });
        }
        if (error instanceof InvalidChatDataError) {
            console.error(error.message);
            return response.status(400).send({ error: error.message });
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/search', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { query, avatar_url, group_id } = request.body;

        /** @type {string[]} */
        let chatFiles = [];

        if (group_id) {
            // Find group's chat IDs first
            const groupDir = path.join(request.user.directories.groups);
            const groupFiles = fs.readdirSync(groupDir)
                .filter(file => path.extname(file) === '.json');

            let targetGroup;
            for (const groupFile of groupFiles) {
                try {
                    const groupData = JSON.parse(fs.readFileSync(path.join(groupDir, groupFile), 'utf8'));
                    if (groupData.id === group_id) {
                        targetGroup = groupData;
                        break;
                    }
                } catch (error) {
                    console.warn(groupFile, 'group file is corrupted:', error);
                }
            }

            if (!Array.isArray(targetGroup?.chats)) {
                return response.send([]);
            }

            // Find group chat files for given group ID
            const groupChatsDir = path.join(request.user.directories.groupChats);
            // SillyBunny: skip a chat ID that names no file inside the group chats folder, so that one stored ID cannot fail the search.
            chatFiles = targetGroup.chats
                .map(chatId => getGroupChatPath(groupChatsDir, chatId))
                .filter(fileName => fileName && fs.existsSync(fileName));
        } else {
            // Regular character chat directory
            const character_name = avatar_url.replace('.png', '');
            const directoryPath = path.join(request.user.directories.chats, character_name);

            if (!fs.existsSync(directoryPath)) {
                return response.send([]);
            }

            chatFiles = fs.readdirSync(directoryPath)
                .filter(file => path.extname(file) === '.jsonl')
                .map(fileName => path.join(directoryPath, fileName));
        }

        /**
         * @type {SearchChatResult[]}
         * @typedef {object} SearchChatResult
         * @property {string} [file_name] - The name of the chat file
         * @property {string} [file_size] - The size of the chat file in a human-readable format
         * @property {number} [message_count] - The number of messages in the chat
         * @property {number} [token_estimate] - The approximate number of tokens in the chat
         * @property {number|string} [last_mes] - The timestamp of the last message
         * @property {string} [preview_message] - A preview of the last message
         */
        const results = [];

        /** @type {string[]} */
        const fragments = query ? query.trim().toLowerCase().split(/\s+/).filter(x => x) : [];

        // SillyBunny: incremental Set matcher avoids O(M^2) rescanning across messages and skips scanning on filename match.
        /** @type {ChatMatchFunction} */
        const hasTextMatch = createFragmentSearchMatcher(fragments);

        for (const chatFile of chatFiles) {
            const fileId = path.parse(chatFile).name;
            const fileIdMatches = query ? hasTextMatch([fileId]) : false;
            const matcher = (query && !fileIdMatches) ? hasTextMatch : null;
            const chatInfo = await getChatInfo(chatFile, {}, false, matcher);
            const hasMatch = fileIdMatches || chatInfo.match;

            // Skip corrupted or invalid chat files
            if (!chatInfo.file_name) {
                continue;
            }

            // Empty chats without a file name match are skipped when searching with a query
            if (query && chatInfo.chat_items === 0 && !hasMatch) {
                continue;
            }

            // If no search query or a match was found, include the chat in results
            if (!query || hasMatch) {
                results.push({
                    file_name: chatInfo.file_id,
                    file_size: chatInfo.file_size,
                    message_count: chatInfo.chat_items,
                    token_estimate: chatInfo.token_estimate,
                    last_mes: chatInfo.last_mes,
                    preview_message: getPreviewMessage(chatInfo.mes),
                });
            }
        }

        return response.send(results);
    } catch (error) {
        console.error('Chat search error:', error);
        return response.status(500).json({ error: 'Search failed' });
    }
});

router.post('/recent', async function (request, response) {
    try {
        /** @typedef {{pngFile?: string, groupId?: string, filePath: string, mtime: number}} ChatFile */
        /** @type {ChatFile[]} */
        const allChatFiles = [];
        /** @type {import('../../public/scripts/welcome-screen.js').PinnedChat[]} */
        const pinnedChats = Array.isArray(request.body.pinned) ? request.body.pinned : [];

        const getCharacterChatFiles = async () => {
            const pngDirents = await fs.promises.readdir(request.user.directories.characters, { withFileTypes: true });
            const pngFiles = pngDirents.filter(e => e.isFile() && path.extname(e.name) === '.png').map(e => e.name);

            for (const pngFile of pngFiles) {
                const chatsDirectory = pngFile.replace('.png', '');
                const pathToChats = path.join(request.user.directories.chats, chatsDirectory);
                if (!fs.existsSync(pathToChats)) {
                    continue;
                }
                const pathStats = await fs.promises.stat(pathToChats);
                if (pathStats.isDirectory()) {
                    const chatFiles = await fs.promises.readdir(pathToChats);
                    const jsonlFiles = chatFiles.filter(file => path.extname(file) === '.jsonl');

                    for (const file of jsonlFiles) {
                        const filePath = path.join(pathToChats, file);
                        const stats = await fs.promises.stat(filePath);
                        allChatFiles.push({ pngFile, filePath, mtime: stats.mtimeMs });
                    }
                }
            }
        };

        const getGroupChatFiles = async () => {
            const groupDirents = await fs.promises.readdir(request.user.directories.groups, { withFileTypes: true });
            const groups = groupDirents.filter(e => e.isFile() && path.extname(e.name) === '.json').map(e => e.name);

            for (const group of groups) {
                try {
                    const groupPath = path.join(request.user.directories.groups, group);
                    const groupContents = await fs.promises.readFile(groupPath, 'utf8');
                    const groupData = JSON.parse(groupContents);

                    if (Array.isArray(groupData.chats)) {
                        for (const chat of groupData.chats) {
                            // SillyBunny: group files keep chat IDs as clients send them, so skip an ID that names no file inside the group chats folder.
                            const filePath = getGroupChatPath(request.user.directories.groupChats, chat);
                            if (!filePath || !fs.existsSync(filePath)) {
                                continue;
                            }
                            const stats = await fs.promises.stat(filePath);
                            allChatFiles.push({ groupId: groupData.id, filePath, mtime: stats.mtimeMs });
                        }
                    }
                } catch (error) {
                    // Skip group files that can't be read or parsed
                    continue;
                }
            }
        };

        const getRootChatFiles = async () => {
            const dirents = await fs.promises.readdir(request.user.directories.chats, { withFileTypes: true });
            const chatFiles = dirents.filter(e => e.isFile() && path.extname(e.name) === '.jsonl').map(e => e.name);

            for (const file of chatFiles) {
                const filePath = path.join(request.user.directories.chats, file);
                const stats = await fs.promises.stat(filePath);
                allChatFiles.push({ filePath, mtime: stats.mtimeMs });
            }
        };

        await Promise.allSettled([getCharacterChatFiles(), getGroupChatFiles(), getRootChatFiles()]);

        const parsedMax = parseInt(request.body.max ?? Number.MAX_SAFE_INTEGER);
        const max = (Number.isFinite(parsedMax) ? parsedMax : Number.MAX_SAFE_INTEGER) + pinnedChats.length;
        // SillyBunny: pre-index pinned chats in O(1) Sets instead of O(N*P) scans inside the sort comparator.
        const pinnedAvatarKeys = new Set();
        const pinnedGroupKeys = new Set();
        const pinnedRootNames = new Set();
        for (const pinned of pinnedChats) {
            if (!pinned || typeof pinned.file_name !== 'string') {
                continue;
            }
            if (pinned.avatar !== undefined) {
                pinnedAvatarKeys.add(`${pinned.avatar}\0${pinned.file_name}`);
            }
            if (pinned.group !== undefined) {
                pinnedGroupKeys.add(`${pinned.group}\0${pinned.file_name}`);
            }
            if (pinned.avatar === undefined && pinned.group === undefined) {
                pinnedRootNames.add(pinned.file_name);
            }
        }
        for (const chatFile of allChatFiles) {
            const baseName = path.basename(chatFile.filePath);
            chatFile.pinned = (chatFile.pngFile !== undefined && pinnedAvatarKeys.has(`${chatFile.pngFile}\0${baseName}`))
                || (chatFile.groupId !== undefined && pinnedGroupKeys.has(`${chatFile.groupId}\0${baseName}`))
                || (chatFile.pngFile === undefined && chatFile.groupId === undefined && pinnedRootNames.has(baseName));
        }
        const sortRecentChatFiles = (/** @type {ChatFile} */ a, /** @type {ChatFile} */ b) => {
            if (a.pinned !== b.pinned) {
                return a.pinned ? -1 : 1;
            }

            return b.mtime - a.mtime;
        };
        /**
         * Keeps Recent Chats filters populated when one chat category dominates the newest files.
         * @param {ChatFile[]} sortedChatFiles Chat files sorted by recency
         * @param {number} limit Maximum number of files to include per recent-chat bucket
         * @returns {ChatFile[]} Balanced recent chat files
         */
        const getBalancedRecentChatFiles = (sortedChatFiles, limit) => {
            if (limit >= sortedChatFiles.length) {
                return sortedChatFiles;
            }

            /** @type {Map<string, ChatFile>} */
            const selectedChats = new Map();
            const addChat = (/** @type {ChatFile} */ chatFile) => {
                selectedChats.set(`${chatFile.groupId || ''}\0${chatFile.pngFile || ''}\0${chatFile.filePath}`, chatFile);
            };

            sortedChatFiles.slice(0, limit).forEach(addChat);

            // SillyBunny: include the same recent depth per filter so Individual does not disappear behind a busy Groups list.
            let groupCount = 0;
            let individualCount = 0;

            for (const chatFile of sortedChatFiles) {
                if (chatFile.groupId) {
                    if (groupCount < limit) {
                        addChat(chatFile);
                        groupCount++;
                    }
                } else if (individualCount < limit) {
                    addChat(chatFile);
                    individualCount++;
                }

                if (groupCount >= limit && individualCount >= limit) {
                    break;
                }
            }

            return Array.from(selectedChats.values()).sort(sortRecentChatFiles);
        };
        const sortedChatFiles = allChatFiles.sort(sortRecentChatFiles);
        const recentChats = getBalancedRecentChatFiles(sortedChatFiles, max);
        const jsonFilesPromise = recentChats.map((file) => {
            const withMetadata = !!request.body.metadata;
            const previewMessageLimit = Math.max(0, Math.min(20, Number(request.body.previewMessages) || 0));
            return file.groupId
                ? getChatInfo(file.filePath, { group: file.groupId }, withMetadata, null, previewMessageLimit)
                : getChatInfo(file.filePath, { avatar: file.pngFile }, withMetadata, null, previewMessageLimit);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
