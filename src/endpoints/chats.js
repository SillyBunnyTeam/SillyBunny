import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import _ from 'lodash';

import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import { renameChatFile } from '../chat-rename.js';
import {
    clearChatRecoveryState,
    createCharacterChatTarget,
    createGroupChatTarget,
    isRecognizedChatHeader,
    loadActiveChatWithRecovery,
    markChatDeleted,
    readChatJsonlStrict,
    rekeyChatRecoveryState,
    runChatRecoveryBestEffort,
    seedLatestChatSnapshot,
    writeLatestChatSnapshot,
} from '../chat-recovery.js';
import {
    getConfigValue,
    humanizedDateTime,
    tryParse,
    generateTimestamp,
    removeOldBackups,
    formatBytes,
    color,
    tryWriteFileSync,
    tryReadFileSync,
    tryDeleteFile,
    readFirstLine,
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
 * Trims regular chat backups only. `CHAT_BACKUPS_PREFIX` is a prefix of the pre-write and
 * forced-overwrite prefixes, so a plain prefix sweep would also rotate away those recovery layers.
 * @param {string} directory The user's backup directory.
 * @param {number} limit Maximum number of regular chat backups to keep.
 */
export function removeOldRegularChatBackups(directory, limit) {
    const reservedPrefixes = [CHAT_PRE_WRITE_BACKUPS_PREFIX, CHAT_FORCED_OVERWRITE_BACKUPS_PREFIX];
    const files = fs.readdirSync(directory)
        .filter(file => file.startsWith(CHAT_BACKUPS_PREFIX) && !reservedPrefixes.some(reserved => file.startsWith(reserved)))
        .map(file => path.join(directory, file))
        .sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs);

    while (files.length > limit) {
        const oldest = files.shift();
        if (!oldest) {
            break;
        }

        fs.unlinkSync(oldest);
    }
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

function getSerializedBackupSizeDetails(data) {
    const sizeBytes = Buffer.byteLength(String(data ?? ''), 'utf8');
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

function normalizeSerializedChatForBackupComparison(data) {
    const serialized = String(data ?? '');
    const lines = serialized.split('\n');

    if (!lines[0]) {
        return serialized;
    }

    try {
        const header = JSON.parse(lines[0]);
        if (!isPlainObject(header?.chat_metadata)) {
            return serialized;
        }

        const chatMetadata = { ...header.chat_metadata };
        delete chatMetadata.integrity;
        lines[0] = JSON.stringify({ ...header, chat_metadata: chatMetadata });
        return lines.join('\n');
    } catch {
        return serialized;
    }
}

function getLatestBackupFilePath(directory, prefix) {
    const backupFiles = fs.readdirSync(directory)
        .filter(fileName => fileName.startsWith(prefix))
        .map(fileName => ({
            fileName,
            filePath: path.join(directory, fileName),
        }))
        .sort((a, b) => {
            const mtimeDifference = fs.statSync(b.filePath).mtimeMs - fs.statSync(a.filePath).mtimeMs;
            return mtimeDifference || b.fileName.localeCompare(a.fileName);
        });

    return backupFiles[0]?.filePath ?? null;
}

function isDuplicateRegularChatBackup(directory, backupPrefix, data) {
    const latestBackupFile = getLatestBackupFilePath(directory, backupPrefix);
    if (!latestBackupFile) {
        return false;
    }

    const latestBackupData = tryReadFileSync(latestBackupFile);
    return Boolean(latestBackupData)
        && normalizeSerializedChatForBackupComparison(latestBackupData) === normalizeSerializedChatForBackupComparison(data);
}

function isDuplicatePreWriteBackup(directory, backupPrefix, data) {
    const prefix = `${backupPrefix}`;
    const latestBackupFile = getLatestBackupFilePath(directory, prefix);
    if (!latestBackupFile) {
        return false;
    }

    const latestBackupData = tryReadFileSync(latestBackupFile);
    return Boolean(latestBackupData)
        && normalizeSerializedChatForBackupComparison(latestBackupData) === normalizeSerializedChatForBackupComparison(data);
}

/**
 * Saves a chat to the backups directory.
 * @param {string} directory The user's backup directory.
 * @param {string} name The name of the chat.
 * @param {string} data The serialized chat to save.
 * @param {string} backupPrefix The file prefix. Typically CHAT_BACKUPS_PREFIX.
 * @param {string} handle User handle for diagnostic logging.
 * @returns
 */
function backupChat(directory, name, data, backupPrefix = CHAT_BACKUPS_PREFIX, handle = '') {
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
        name = sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const prefix = `${backupPrefix}${name}_`;
        const sizeDetails = getSerializedBackupSizeDetails(data);

        if (backupPrefix === CHAT_BACKUPS_PREFIX && isDuplicateRegularChatBackup(directory, prefix, data)) {
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

        const backupFile = path.join(directory, `${backupPrefix}${name}_${generateTimestamp()}.jsonl`);

        tryWriteFileSync(backupFile, data);
        logBackupEvent('chat-backup-written', {
            type: backupType,
            handle,
            chat: originalName,
            sanitizedName: name,
            file: path.basename(backupFile),
            ...sizeDetails,
        });
        removeOldBackups(directory, prefix);
        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return;
        }
        if (backupPrefix === CHAT_BACKUPS_PREFIX) {
            removeOldRegularChatBackups(directory, maxTotalChatBackups);
            return;
        }
        removeOldBackups(directory, backupPrefix, maxTotalChatBackups);
    } catch (err) {
        console.error(`Could not backup chat for ${name}`, err);
    }
}

function backupChatPreWrite(directory, name, data, handle = '') {
    const originalName = name;
    try {
        if (!isBackupEnabled) {
            logBackupEvent('chat-backup-skipped', { type: 'pre-write', handle, chat: originalName, reason: 'disabled' });
            return;
        }
        if (!fs.existsSync(directory)) {
            console.error(`The chat couldn't be backed up because no directory exists at ${directory}!`);
            logBackupEvent('chat-backup-skipped', { type: 'pre-write', handle, chat: originalName, reason: 'missing-directory' });
        }
        name = sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const sizeDetails = getSerializedBackupSizeDetails(data);

        if (isDuplicatePreWriteBackup(directory, `${CHAT_PRE_WRITE_BACKUPS_PREFIX}${name}_`, data)) {
            logBackupEvent('chat-backup-skipped', {
                type: 'pre-write',
                handle,
                chat: originalName,
                sanitizedName: name,
                reason: 'duplicate',
                ...sizeDetails,
            });
            return;
        }

        const backupFile = path.join(directory, `${CHAT_PRE_WRITE_BACKUPS_PREFIX}${name}_${generateTimestamp()}_${uuidv4()}.jsonl`);

        tryWriteFileSync(backupFile, data);
        logBackupEvent('chat-backup-written', {
            type: 'pre-write',
            handle,
            chat: originalName,
            sanitizedName: name,
            file: path.basename(backupFile),
            ...sizeDetails,
        });
        removeOldBackups(directory, `${CHAT_PRE_WRITE_BACKUPS_PREFIX}${name}_`, PRE_WRITE_BACKUP_RING_SIZE);
        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return;
        }
        removeOldBackups(directory, CHAT_PRE_WRITE_BACKUPS_PREFIX, maxTotalChatBackups);
    } catch (err) {
        console.error(`Could not create pre-write chat backup for ${name}`, err);
    }
}

function countSerializedChatLines(serializedChat) {
    if (!serializedChat) {
        return 0;
    }

    return String(serializedChat).split('\n').filter(line => line.trim()).length;
}

function isSuspiciousChatShrink(newData, existingSerializedChat) {
    const existingLines = countSerializedChatLines(existingSerializedChat);
    if (existingLines <= 5) {
        return false;
    }

    return Array.isArray(newData) && newData.length < existingLines * 0.5;
}

/**
 * Classifies a save that would replace an existing chat with substantially less content.
 * A chat payload carries one metadata header, so a length below two rows has no messages at all.
 * @param {Array} newData Incoming chat array.
 * @param {string} existingSerializedChat Current serialized chat on disk.
 * @returns {''|'emptied'|'shrink'} Reason the save is destructive, or an empty string.
 */
function getDestructiveChatSaveReason(newData, existingSerializedChat) {
    const existingLines = countSerializedChatLines(existingSerializedChat);
    if (existingLines < 2 || !Array.isArray(newData)) {
        return '';
    }

    if (newData.length < 2) {
        return 'emptied';
    }

    return isSuspiciousChatShrink(newData, existingSerializedChat) ? 'shrink' : '';
}

/**
 * @type {Map<string, import('lodash').DebouncedFunc<typeof backupChat>>}
 */
const backupFunctions = new Map();

/**
 * Gets a backup function for a user.
 * @param {string} handle User handle
 * @returns {typeof backupChat} Backup function
 */
function getBackupFunction(handle) {
    if (!backupFunctions.has(handle)) {
        backupFunctions.set(handle, _.throttle(backupChat, throttleInterval, { leading: true, trailing: true }));
    }
    return backupFunctions.get(handle) || (() => { });
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

/**
 * Checks if the chat being saved has the same integrity as the one being loaded.
 * @param {string} filePath Path to the chat file
 * @param {string} integritySlug Integrity slug
 * @returns {Promise<boolean>} Whether the chat is intact
 */
async function checkChatIntegrity(filePath, integritySlug) {
    // If the chat file doesn't exist, assume it's intact
    if (!fs.existsSync(filePath)) {
        return true;
    }

    // Parse the first line of the chat file as JSON
    const firstLine = await readFirstLine(filePath);
    const jsonData = tryParse(firstLine);
    const chatIntegrity = jsonData?.chat_metadata?.integrity;

    // If the chat has no integrity metadata, assume it's intact
    if (!chatIntegrity) {
        console.debug(`File "${filePath}" does not have integrity metadata matching "${integritySlug}". The integrity validation has been skipped.`);
        return true;
    }

    // Check if the integrity matches
    return chatIntegrity === integritySlug;
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
        const stats = await fs.promises.stat(pathToFile);
        const hasMatcher = (typeof matcher === 'function');

        const chatData = {
            match: false,
            file_id: parsedPath.name,
            file_name: parsedPath.base,
            file_size: formatBytes(stats.size),
            chat_items: 0,
            token_estimate: 0,
            mes: '[The chat is empty]',
            last_mes: stats.mtimeMs,
            ...additionalData,
        };

        if (stats.size === 0) {
            return chatData;
        }

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
            const previewMessages = [];
            const previewLimit = Math.max(0, Number(previewMessageLimit) || 0);

            fileStream.once('error', rej);
            rl.once('error', rej);

            rl.on('line', (line) => {
                const isMessageLine = itemCounter > 0;
                let jsonData = null;

                if (withMetadata && !isMessageLine) {
                    jsonData = tryParse(line);
                    if (jsonData && _.isObjectLike(jsonData.chat_metadata)) {
                        chatData.chat_metadata = jsonData.chat_metadata;
                    }
                }

                if (isMessageLine) {
                    jsonData = tryParse(line);
                    if (jsonData) {
                        messageCharacters += String(jsonData.mes ?? '').length;

                        // Skip matching if any match was already found
                        if (hasMatcher && !hasAnyMatch) {
                            matchBuffer.push(jsonData.mes || '');
                            if (matcher(matchBuffer)) {
                                hasAnyMatch = true;
                                matchBuffer = [];
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
                rl.close();

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
                    chatData.last_mes = jsonData.send_date || new Date(Math.round(stats.mtimeMs)).toISOString();
                    chatData.match = hasMatcher ? hasAnyMatch : true;
                    if (previewLimit > 0) {
                        chatData.preview_messages = previewMessages;
                    }

                    res(chatData);
                } else {
                    console.warn('Found an invalid or corrupted chat file:', pathToFile);
                    res({});
                }
            });
        });
    } catch (error) {
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

export const router = express.Router();

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
class IntegrityMismatchError extends Error {
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

class InvalidChatDataError extends Error {
    constructor(...params) {
        super(...params);
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, InvalidChatDataError);
        }
        this.date = new Date();
    }
}

// SillyBunny: a save that would destroy an existing chat is rejected unless the client forces it.
class DestructiveChatSaveError extends Error {
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
 */
export async function trySaveChat(chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory, { deferBackup = false, recoveryTarget = null, allowShrink = false } = {}) {
    if (!isValidChatSavePayload(chatData)) {
        throw new InvalidChatDataError('Invalid chat save payload. Expected a non-empty chat array with a metadata header.');
    }

    const doIntegrityCheck = (checkIntegrity && !skipIntegrityCheck);
    const chatIntegritySlug = doIntegrityCheck ? chatData?.[0]?.chat_metadata?.integrity : undefined;

    if (chatIntegritySlug && !await checkChatIntegrity(filePath, chatIntegritySlug)) {
        throw new IntegrityMismatchError(`Chat integrity check failed for "${filePath}". The expected integrity slug was "${chatIntegritySlug}".`);
    }

    const nextIntegrity = uuidv4();
    const savedChatData = Array.isArray(chatData)
        ? chatData.map((message, index) => index === 0
            ? { ...message, chat_metadata: { ...(message?.chat_metadata || {}), integrity: nextIntegrity } }
            : message)
        : chatData;
    const jsonlData = savedChatData?.map(m => JSON.stringify(m)).join('\n');
    const savedChatSizeDetails = getSerializedBackupSizeDetails(jsonlData);
    logBackupEvent('chat-save', {
        handle,
        chat: cardName,
        rows: Array.isArray(savedChatData) ? savedChatData.length : undefined,
        force: Boolean(skipIntegrityCheck),
        deferBackup: Boolean(deferBackup),
        ...savedChatSizeDetails,
    });

    if (fs.existsSync(filePath)) {
        const currentChatData = tryReadFileSync(filePath);

        // SillyBunny: an existing chat that cannot be read can be neither checked nor backed up, so never overwrite it blind.
        // An empty file reads back as '' rather than null, so this only catches a genuine read failure.
        if (currentChatData === null && !skipIntegrityCheck && !allowShrink) {
            throw new DestructiveChatSaveError('unreadable', `Refused a chat save for "${cardName}": the existing chat file could not be read, so it cannot be backed up before being replaced.`);
        }

        if (currentChatData) {
            const destructiveReason = getDestructiveChatSaveReason(savedChatData, currentChatData);
            const existingLines = countSerializedChatLines(currentChatData);

            // SillyBunny: reject before the pre-write ring runs, so a rejected save cannot evict the last good state.
            // Deliberate message deletion sets allowShrink, which is not the same confirmation as an integrity overwrite.
            if (destructiveReason && !skipIntegrityCheck && !allowShrink) {
                throw new DestructiveChatSaveError(destructiveReason, `Refused a destructive chat save for "${cardName}" (${destructiveReason}): incoming payload has ${savedChatData.length} JSONL rows, existing file has ${existingLines} rows.`);
            }

            backupChatPreWrite(backupDirectory, cardName, currentChatData, handle);

            if (destructiveReason) {
                console.warn(`Forced destructive chat save for "${cardName}" (${destructiveReason}): incoming payload has ${savedChatData.length} JSONL rows, existing file has ${existingLines} rows.`);
            }

            if (skipIntegrityCheck) {
                backupChat(backupDirectory, cardName, currentChatData, CHAT_FORCED_OVERWRITE_BACKUPS_PREFIX, handle);
            }
        }
    }

    if (isBackupEnabled && recoveryTarget) {
        // SillyBunny: exact snapshots are immediate and are not subject to history backup throttling.
        // Destructive payloads are rejected above, so this cannot mirror a chat-destroying write.
        try {
            writeLatestChatSnapshot(recoveryTarget, jsonlData);
        } catch (error) {
            // Recovery storage is supplementary and must not prevent the authoritative chat write.
            console.warn('Failed to write the exact chat recovery snapshot; continuing with the active chat save.', error);
        }
    }
    tryWriteFileSync(filePath, jsonlData);
    if (!deferBackup) {
        getBackupFunction(handle)(backupDirectory, cardName, jsonlData, CHAT_BACKUPS_PREFIX, handle);
    } else {
        logBackupEvent('chat-backup-skipped', { type: 'regular', handle, chat: cardName, reason: 'deferred', ...savedChatSizeDetails });
    }
    return { integrity: nextIntegrity };
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

        if (!fs.existsSync(pathToOriginalFile) || fs.existsSync(pathToRenamedFile)) {
            console.error('Either Source or Destination files are not available');
            return response.status(400).send({ error: true });
        }

        const sourceRecoveryTarget = createChatRecoveryTarget(request, request.body.is_group, originalFileName);
        const destinationRecoveryTarget = createChatRecoveryTarget(request, request.body.is_group, renamedFileName);
        if (isBackupEnabled) {
            runChatRecoveryBestEffort(
                () => seedLatestChatSnapshot(sourceRecoveryTarget),
                'Failed to prepare chat recovery state; continuing with chat rename.',
            );
        }

        // SillyBunny: atomic renames prevent interrupted chat renames from leaving cloned files behind.
        const renameResult = renameChatFile(pathToOriginalFile, pathToRenamedFile);
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
    if (!request.body.file || (!request.body.avatar_url && request.body.is_group === false)) {
        return response.sendStatus(400);
    }
    const pathToFolder = request.body.is_group
        ? request.user.directories.groupChats
        : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
    const filename = path.join(pathToFolder, sanitize(request.body.file));
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
    try {
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
        let buffer = '';
        rl.on('line', (line) => {
            const data = JSON.parse(line);
            // Skip non-printable/prompt-hidden messages
            if (data.is_system) {
                return;
            }
            if (data.mes) {
                const name = data.name;
                const message = (data?.extra?.display_text || data?.mes || '').replace(/\r?\n/g, '\n');
                buffer += (`${name}: ${message}\n\n`);
            }
        });
        rl.on('close', () => {
            const successMessage = {
                message: `Chat saved to ${exportfilename}`,
                result: buffer,
            };
            console.info(`Chat exported as ${exportfilename}`);
            return response.status(200).json(successMessage);
        });
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
            chatFiles = targetGroup.chats
                .map(chatId => path.join(groupChatsDir, `${chatId}.jsonl`))
                .filter(fileName => fs.existsSync(fileName));
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

        /** @type {ChatMatchFunction} */
        const hasTextMatch = (textArray) => {
            if (fragments.length === 0) {
                return true;
            }
            return fragments.every(fragment => textArray.some(text => String(text ?? '').toLowerCase().includes(fragment)));
        };

        for (const chatFile of chatFiles) {
            const matcher = query ? hasTextMatch : null;
            const chatInfo = await getChatInfo(chatFile, {}, false, matcher);
            const hasMatch = chatInfo.match || hasTextMatch([chatInfo.file_id ?? '']);

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
                            const filePath = path.join(request.user.directories.groupChats, `${chat}.jsonl`);
                            if (!fs.existsSync(filePath)) {
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
        const isPinned = (/** @type {ChatFile} */ chatFile) => pinnedChats.some(p => p.file_name === path.basename(chatFile.filePath) && (p.avatar === chatFile.pngFile || p.group === chatFile.groupId));
        const sortRecentChatFiles = (/** @type {ChatFile} */ a, /** @type {ChatFile} */ b) => {
            const isAPinned = isPinned(a);
            const isBPinned = isPinned(b);

            if (isAPinned && !isBPinned) return -1;
            if (!isAPinned && isBPinned) return 1;

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
