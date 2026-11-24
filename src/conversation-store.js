/**
 * Server storage of conversation mode: one folder per conversation under the user's `conversations/` folder.
 *
 * ```
 * conversations/
 *   characters.json                  per-character state: routine, status override
 *   <conversationId>/
 *     conversation.json              metadata, the list of chats and their state
 *     chats/<chatId>.jsonl           one chat, in the roleplay chat format
 *     avatar.<ext>                   the avatar of a group, when one is uploaded
 * ```
 *
 * Every function takes the request's `user` (`{ profile: { handle }, directories }`), checks its ids against fixed
 * patterns before they reach a path, and throws a `ConversationStoreError` that carries a `code`. Metadata files are
 * written atomically under a lock; chat files are written by `trySaveChat()`, so that a save gets the same lock, stale
 * tab check, shrink guard, backups, recovery snapshot and atomic write as a roleplay chat save. All of it is
 * synchronous apart from `saveChat()`, because the locks are held for the length of one call.
 *
 * A chat file is written before the metadata that lists it, and a chat is unlisted before its file is removed, so
 * that a crash leaves a stray file and never a listed chat without one.
 */

import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';

import { acquireChatFileLock } from './chat-file-lock.js';
import {
    clearChatRecoveryState,
    loadActiveChatWithRecovery,
    markChatDeleted,
    readChatJsonlStrict,
    runChatRecoveryBestEffort,
} from './chat-recovery.js';
import {
    ConversationPathError,
    createChatId,
    createConversationId,
    getCharactersJsonPath,
    getChatFilePath,
    getConversationDirectory,
    getConversationJsonPath,
    isChatId,
    isConversationId,
    resolveConversationChatTarget,
    CHATS_DIRECTORY_NAME,
} from './conversation-paths.js';
import {
    applyCharacterPatch,
    applyUpdatePatch,
    AVATAR_FILE_NAMES,
    buildConversation,
    ConversationStoreError,
    getAvatarContentType,
    MAX_AVATAR_IMAGE_BYTES,
    normalizeStoredCharacterState,
    normalizeStoredConversation,
    parseChatInput,
    parseChatRecords,
    parseCharacterAvatar,
    parseCreateInput,
    sniffImageType,
    summarizeChatRecords,
} from './conversation-schema.js';
import { DestructiveChatSaveError, IntegrityMismatchError, InvalidChatDataError, trySaveChat } from './endpoints/chats.js';
import { getConfigValue, tryWriteFileSync } from './util.js';

export { ConversationStoreError, summarizeChatRecords };

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxRecoveryStates = Number(getConfigValue('backups.chat.maxTotalBackups', 25, 'number'));
const CONVERSATION_ID_ATTEMPTS = 5;

/**
 * @typedef {{ profile: { handle: string }, directories: Record<string, string> }} StoreUser
 */

// ---------------------------------------------------------------------------------------------------------------------
// Plumbing

/** Runs `work`, and turns what the path module and the file system say into a store error. */
function guard(work) {
    try {
        return work();
    } catch (error) {
        throw toStoreError(error);
    }
}

function toStoreError(error) {
    if (error instanceof ConversationStoreError) {
        return error;
    }
    if (error instanceof ConversationPathError) {
        // The message of a path error names a path on the server, so it stays out of what a route sends.
        return error.code === 'no_folder'
            ? new ConversationStoreError('unavailable', 'Conversation storage is not available.')
            : new ConversationStoreError('invalid_id', 'Not a valid conversation or chat id.');
    }
    return error;
}

function conversationDirectory(user, id) {
    return guard(() => getConversationDirectory(user.directories, id));
}

function directoryExists(directory) {
    try {
        return fs.lstatSync(directory).isDirectory();
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function notFound(what) {
    return new ConversationStoreError('not_found', `${what} does not exist.`);
}

/**
 * The lock subject is the conversation's folder, so that its lock file sits next to the folder and not inside it:
 * deleting the folder must not delete the lock that its deleter holds.
 */
function withConversationLock(user, id, work) {
    const directory = conversationDirectory(user, id);
    const release = acquireChatFileLock(directory);
    try {
        return work(directory);
    } finally {
        release();
    }
}

function writeJson(filePath, value, { create = false } = {}) {
    tryWriteFileSync(filePath, JSON.stringify(value, null, 4), 'utf8', { durable: true, expectedFileAbsent: create });
}

function readJsonFile(filePath) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { missing: true };
        }
        throw error;
    }
    try {
        return { value: JSON.parse(text) };
    } catch {
        return { corrupt: true };
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Conversations

/**
 * @param {StoreUser} user
 * @param {string} id
 * @returns {Record<string, any>} The conversation's metadata.
 * @throws {ConversationStoreError} `invalid_id`, `not_found` or `corrupt`.
 */
export function readConversation(user, id) {
    const filePath = guard(() => getConversationJsonPath(user.directories, id));
    const result = readJsonFile(filePath);
    if (result.missing) {
        throw notFound('The conversation');
    }
    if (result.corrupt) {
        throw new ConversationStoreError('corrupt', 'conversation.json is not valid JSON.');
    }
    return normalizeStoredConversation(result.value, id);
}

function readChatForSummary(user, conversationId, chatId) {
    const result = readChatJsonlStrict(guard(() => getChatFilePath(user.directories, conversationId, chatId)));
    return result.status === 'ok' ? result.records : null;
}

function summarizeConversation(user, conversation) {
    const chats = conversation.chats.map((entry) => {
        const records = readChatForSummary(user, conversation.id, entry.id);
        return { ...entry, ...(records ? summarizeChatRecords(records, entry.readThrough) : { messageCount: 0, lastMessageAt: 0, preview: '', unread: 0 }) };
    });
    const latest = chats.reduce((best, entry) => (entry.lastMessageAt > best.lastMessageAt ? entry : best), { lastMessageAt: 0, preview: '' });
    return {
        ...conversation,
        chats,
        messageCount: chats.reduce((sum, entry) => sum + entry.messageCount, 0),
        unread: chats.reduce((sum, entry) => sum + entry.unread, 0),
        lastMessageAt: latest.lastMessageAt,
        preview: latest.preview,
    };
}

/**
 * Reads every conversation folder. A folder that holds an id and no readable conversation is reported in `problems`,
 * so that nothing disappears silently.
 */
function scanConversations(user) {
    const root = user.directories?.conversations;
    const conversations = [];
    const problems = [];
    if (typeof root !== 'string' || !directoryExists(root)) {
        return { conversations, problems };
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !isConversationId(entry.name)) {
            continue;
        }
        try {
            conversations.push(readConversation(user, entry.name));
        } catch (error) {
            if (!(error instanceof ConversationStoreError)) {
                throw error;
            }
            problems.push({ id: entry.name, error: error.code });
        }
    }
    problems.sort((left, right) => left.id.localeCompare(right.id));
    return { conversations, problems };
}

/**
 * Every conversation, newest message first, with the counts of each chat. Built by reading the files; an index can
 * answer the same question without that.
 * @param {StoreUser} user
 * @returns {{ conversations: Record<string, any>[], problems: { id: string, error: string }[] }}
 * `problems` names each folder that holds an id and no readable conversation.
 */
export function listConversations(user) {
    const { conversations, problems } = scanConversations(user);
    const summaries = conversations.map(conversation => summarizeConversation(user, conversation));
    summaries.sort((left, right) => right.lastMessageAt - left.lastMessageAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id));
    return { conversations: summaries, problems };
}

/**
 * @param {StoreUser} user
 * @param {string} personaId
 * @param {string} avatar The character's avatar file name.
 * @returns {Record<string, any>|null} The direct conversation of that persona and character.
 */
export function findDirectConversation(user, personaId, avatar) {
    return scanConversations(user).conversations.find(conversation => (
        conversation.kind === 'direct' && conversation.personaId === personaId && conversation.characters[0] === avatar
    )) ?? null;
}

function writeNewChatFile(user, conversationId, entry, records) {
    const filePath = guard(() => getChatFilePath(user.directories, conversationId, entry.id));
    const serialized = (records ?? [{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }]).map(record => JSON.stringify(record)).join('\n');
    try {
        tryWriteFileSync(filePath, serialized, 'utf8', { expectedFileAbsent: true, durable: true });
    } catch (error) {
        // tryWriteFileSync reports a file that was there already as ESTALE, with the EEXIST as its cause.
        if (error?.code === 'ESTALE' && error.cause?.code === 'EEXIST') {
            throw new ConversationStoreError('exists', `A file for the chat "${entry.id}" is already there.`);
        }
        throw error;
    }
}

/**
 * Creates a conversation with its chats. A direct conversation is unique for a persona and a character: asking for
 * a second one returns the first, unless the caller names the id.
 * @param {StoreUser} user
 * @param {object} input `kind`, `personaId` and `characters` are needed. `id`, `chats` (each with optional `records`),
 * `settings`, `reminders` and the like let the migration write what it read; a route passes none of them.
 * @returns {{ conversation: Record<string, any>, created: boolean }}
 */
export function createConversation(user, input) {
    const spec = guard(() => parseCreateInput(input, { now: Date.now() }));
    if (spec.kind === 'direct' && !spec.id) {
        const existing = findDirectConversation(user, spec.personaId, spec.characters[0]);
        if (existing) {
            return { conversation: existing, created: false };
        }
    }

    const id = spec.id || chooseConversationId(user);
    const conversation = buildConversation(spec, id);
    const directory = conversationDirectory(user, id);
    const release = acquireChatFileLock(directory);
    let madeDirectory = false;
    try {
        if (fs.existsSync(directory)) {
            throw new ConversationStoreError('exists', 'A conversation with this id already exists.');
        }
        fs.mkdirSync(path.join(directory, CHATS_DIRECTORY_NAME), { recursive: true });
        madeDirectory = true;
        for (const { entry, records } of spec.chats) {
            writeNewChatFile(user, id, entry, records);
        }
        writeJson(guard(() => getConversationJsonPath(user.directories, id)), conversation, { create: true });
        return { conversation, created: true };
    } catch (error) {
        if (madeDirectory) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
        throw error;
    } finally {
        release();
    }
}

function chooseConversationId(user) {
    for (let attempt = 0; attempt < CONVERSATION_ID_ATTEMPTS; attempt++) {
        const id = createConversationId();
        if (!fs.existsSync(conversationDirectory(user, id))) {
            return id;
        }
    }
    throw new ConversationStoreError('unavailable', 'No free conversation id was found.');
}

/**
 * @param {StoreUser} user
 * @param {string} id
 * @param {object} patch See `applyUpdatePatch()`: `name`, `description`, `favorite`, `activeChatId`, `settings`
 * (a null value removes a key), `extras` (removal only), `characters` (groups), `reminders` and `chats` (the state of
 * one or more chats by id).
 * @returns {Record<string, any>} The conversation after the change.
 */
export function updateConversation(user, id, patch) {
    return mutateConversation(user, id, current => guard(() => applyUpdatePatch(current, patch, { now: Date.now() })));
}

/**
 * Reads the conversation under its lock, lets `change` return the next metadata, and writes it when it differs.
 */
function mutateConversation(user, id, change) {
    const directory = conversationDirectory(user, id);
    if (!directoryExists(directory)) {
        throw notFound('The conversation');
    }
    return withConversationLock(user, id, () => {
        const current = readConversation(user, id);
        const next = change(current);
        if (next !== current) {
            writeJson(getConversationJsonPath(user.directories, id), next);
        }
        return next;
    });
}

function listedChatIds(user, id) {
    try {
        return readConversation(user, id).chats.map(chat => chat.id);
    } catch (error) {
        if (!(error instanceof ConversationStoreError)) {
            throw error;
        }
    }
    const chatsDirectory = path.join(conversationDirectory(user, id), CHATS_DIRECTORY_NAME);
    try {
        return fs.readdirSync(chatsDirectory).filter(name => name.endsWith('.jsonl') && isChatId(name.slice(0, -'.jsonl'.length))).map(name => name.slice(0, -'.jsonl'.length));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

function forgetChatRecoveryState(user, conversationId, chatId) {
    if (!isBackupEnabled) {
        return;
    }
    const target = resolveConversationChatTarget(user.directories, { conversationId, chatId }, maxRecoveryStates);
    if (!target) {
        return;
    }
    runChatRecoveryBestEffort(() => markChatDeleted(target.recoveryTarget), 'Failed to mark chat recovery state for deletion; continuing with the deletion.');
}

function clearChatRecoveryStateAfterDelete(user, conversationId, chatId) {
    if (!isBackupEnabled) {
        return;
    }
    const target = resolveConversationChatTarget(user.directories, { conversationId, chatId }, maxRecoveryStates);
    if (target) {
        runChatRecoveryBestEffort(() => clearChatRecoveryState(target.recoveryTarget), 'Failed to clear chat recovery state after deletion.');
    }
}

/**
 * Removes a conversation with all its chats. The backups of its chats in `backups/` stay.
 * @param {StoreUser} user
 * @param {string} id
 */
export function deleteConversation(user, id) {
    const directory = conversationDirectory(user, id);
    if (!directoryExists(directory)) {
        throw notFound('The conversation');
    }
    withConversationLock(user, id, () => {
        const chatIds = listedChatIds(user, id);
        for (const chatId of chatIds) {
            forgetChatRecoveryState(user, id, chatId);
        }
        fs.rmSync(directory, { recursive: true, force: true });
        for (const chatId of chatIds) {
            clearChatRecoveryStateAfterDelete(user, id, chatId);
        }
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// Group avatar

function removeAvatarFiles(directory, { except = '' } = {}) {
    for (const fileName of AVATAR_FILE_NAMES) {
        if (fileName !== except) {
            fs.rmSync(path.join(directory, fileName), { force: true });
        }
    }
}

/**
 * @param {StoreUser} user
 * @param {string} id
 * @param {Buffer} data A PNG, JPEG, GIF or WebP file of at most 5 MiB. The type is read from the bytes.
 * @returns {Record<string, any>} The conversation with its new `avatar`.
 */
export function setConversationAvatar(user, id, data) {
    const type = Buffer.isBuffer(data) && data.length <= MAX_AVATAR_IMAGE_BYTES ? sniffImageType(data) : null;
    const next = mutateConversation(user, id, (current) => {
        if (current.kind !== 'group') {
            throw new ConversationStoreError('invalid_input', 'Only a group has an avatar of its own.');
        }
        if (!type) {
            throw new ConversationStoreError('invalid_input', 'The avatar must be a PNG, JPEG, GIF or WebP image of at most 5 MiB.');
        }
        const fileName = `avatar.${type.extension}`;
        tryWriteFileSync(path.join(conversationDirectory(user, id), fileName), data, undefined, { durable: true });
        return { ...current, avatar: fileName, updatedAt: Math.max(Date.now(), current.updatedAt) };
    });
    // The old picture goes after the new one is listed, so that a crash leaves an unused file and never a listed avatar without one.
    removeAvatarFiles(conversationDirectory(user, id), { except: next.avatar });
    return next;
}

/**
 * @param {StoreUser} user
 * @param {string} id
 * @returns {Record<string, any>} The conversation with an empty `avatar`.
 */
export function removeConversationAvatar(user, id) {
    const next = mutateConversation(user, id, current => (
        current.avatar ? { ...current, avatar: '', updatedAt: Math.max(Date.now(), current.updatedAt) } : current
    ));
    removeAvatarFiles(conversationDirectory(user, id));
    return next;
}

/**
 * @param {StoreUser} user
 * @param {string} id
 * @returns {{ filePath: string, contentType: string }|null} The avatar picture of a group, or null when it has none.
 */
export function getConversationAvatarFile(user, id) {
    const conversation = readConversation(user, id);
    const contentType = getAvatarContentType(conversation.avatar);
    if (!contentType) {
        return null;
    }
    const filePath = path.join(conversationDirectory(user, id), conversation.avatar);
    try {
        const stats = fs.lstatSync(filePath);
        return stats.isFile() ? { filePath, contentType } : null;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Chats

function requireListedChat(conversation, chatId) {
    if (!isChatId(chatId)) {
        throw new ConversationStoreError('invalid_id', 'Not a chat id.');
    }
    const entry = conversation.chats.find(chat => chat.id === chatId);
    if (!entry) {
        throw notFound('The chat');
    }
    return entry;
}

/**
 * Adds a chat to a conversation. The chat file is written first and the list second.
 * @param {StoreUser} user
 * @param {string} conversationId
 * @param {object} [input] `name`, and for a branch or the migration `id`, `records`, `createdAt`, `readThrough` and
 * the other state of a chat. `activate` also makes the new chat the active one.
 * @returns {{ conversation: Record<string, any>, chat: Record<string, any> }}
 */
export function createChat(user, conversationId, input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new ConversationStoreError('invalid_input', 'The chat must be an object.');
    }
    const { activate = false, ...chatInput } = input;
    const { entry: parsedEntry, records } = guard(() => parseChatInput(chatInput, { now: Date.now() }));
    if (typeof activate !== 'boolean') {
        throw new ConversationStoreError('invalid_input', 'activate must be true or false.');
    }

    let chat;
    const conversation = mutateConversation(user, conversationId, (current) => {
        chat = { ...parsedEntry, id: parsedEntry.id || createChatId() };
        if (current.chats.some(item => item.id === chat.id)) {
            throw new ConversationStoreError('exists', `The chat "${chat.id}" already exists.`);
        }
        writeNewChatFile(user, conversationId, chat, records);
        return {
            ...current,
            chats: [...current.chats, chat],
            activeChatId: activate ? chat.id : current.activeChatId,
            updatedAt: Math.max(Date.now(), current.updatedAt),
        };
    });
    return { conversation, chat };
}

/**
 * @param {StoreUser} user
 * @param {string} conversationId
 * @param {string} chatId
 * @returns {object[]} The records of the chat, header first. A chat file that is gone or damaged is restored from the
 * copy that the last load or save left, when there is one.
 * @throws {ConversationStoreError} `not_found` when the conversation does not list the chat or the file is gone, `corrupt` when it cannot be read.
 */
export function loadChat(user, conversationId, chatId) {
    requireListedChat(readConversation(user, conversationId), chatId);
    const target = guard(() => resolveConversationChatTarget(user.directories, { conversationId, chatId }, maxRecoveryStates));
    if (!target) {
        throw new ConversationStoreError('invalid_id', 'Not a chat of this conversation.');
    }
    const result = isBackupEnabled ? loadActiveChatWithRecovery(target.recoveryTarget) : readChatJsonlStrict(target.filePath);
    if (result.status === 'ok') {
        return result.records;
    }
    if (result.status === 'missing') {
        throw notFound('The chat file');
    }
    throw new ConversationStoreError('corrupt', 'The chat file cannot be read.', { reason: result.reason });
}

/**
 * Saves a whole chat through `trySaveChat()`.
 * @param {StoreUser} user
 * @param {string} conversationId
 * @param {string} chatId
 * @param {object[]} records `[header, ...messages]`. The header carries the integrity slug of the load or the last save.
 * @param {{ allowShrink?: boolean, deferBackup?: boolean, deferSequenceId?: string }} [options] `allowShrink` says that
 * the caller deletes messages on purpose.
 * @returns {Promise<{ integrity: string }>} The slug that the file now carries.
 * @throws {ConversationStoreError} `integrity` for a slug that is not the file's, `destructive` for a save that would
 * drop most of the chat, `invalid_input` for records that are not a chat.
 */
export async function saveChat(user, conversationId, chatId, records, { allowShrink = false, deferBackup = false, deferSequenceId = undefined } = {}) {
    const conversation = readConversation(user, conversationId);
    requireListedChat(conversation, chatId);
    const target = guard(() => resolveConversationChatTarget(user.directories, { conversationId, chatId }, maxRecoveryStates));
    if (!target) {
        throw new ConversationStoreError('invalid_id', 'Not a chat of this conversation.');
    }
    guard(() => parseChatRecords(records));
    try {
        const result = await trySaveChat(records, target.filePath, false, user.profile.handle, target.cardName, user.directories.backups, {
            recoveryTarget: target.recoveryTarget,
            allowShrink: allowShrink === true,
            deferBackup: deferBackup === true,
            deferSequenceId: typeof deferSequenceId === 'string' ? deferSequenceId : undefined,
        });
        return { integrity: result.integrity };
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            throw new ConversationStoreError('integrity', 'The chat changed since it was loaded.');
        }
        if (error instanceof DestructiveChatSaveError) {
            throw new ConversationStoreError('destructive', 'The save would remove most of the chat.', { reason: error.reason });
        }
        if (error instanceof InvalidChatDataError) {
            throw new ConversationStoreError('invalid_input', error.message);
        }
        throw error;
    }
}

/**
 * @param {StoreUser} user
 * @param {string} conversationId
 * @param {string} chatId
 * @param {string} name The new name of the chat. A chat has no file name of its own to change.
 * @returns {Record<string, any>} The conversation after the change.
 */
export function renameChat(user, conversationId, chatId, name) {
    return mutateConversation(user, conversationId, (current) => {
        requireListedChat(current, chatId);
        return guard(() => applyUpdatePatch(current, { chats: { [chatId]: { name } } }, { now: Date.now() }));
    });
}

/**
 * Removes a chat from the list and then its file. Deleting the last chat leaves one empty chat, and deleting the active
 * chat makes the newest of the others the active one.
 * @param {StoreUser} user
 * @param {string} conversationId
 * @param {string} chatId
 * @returns {Record<string, any>} The conversation after the change.
 */
export function deleteChat(user, conversationId, chatId) {
    return mutateConversation(user, conversationId, (current) => {
        requireListedChat(current, chatId);
        const remaining = current.chats.filter(chat => chat.id !== chatId);
        let activeChatId = current.activeChatId;
        if (remaining.length === 0) {
            const replacement = { ...parseChatInput({}, { now: Date.now() }).entry, id: createChatId() };
            writeNewChatFile(user, conversationId, replacement, null);
            remaining.push(replacement);
        }
        if (activeChatId === chatId || !remaining.some(chat => chat.id === activeChatId)) {
            activeChatId = remaining.reduce((newest, chat) => (chat.createdAt >= newest.createdAt ? chat : newest)).id;
        }
        const next = { ...current, chats: remaining, activeChatId, updatedAt: Math.max(Date.now(), current.updatedAt) };
        writeJson(getConversationJsonPath(user.directories, conversationId), next);
        removeChatFile(user, conversationId, chatId);
        return next;
    });
}

function removeChatFile(user, conversationId, chatId) {
    const filePath = guard(() => getChatFilePath(user.directories, conversationId, chatId));
    forgetChatRecoveryState(user, conversationId, chatId);
    const release = acquireChatFileLock(filePath);
    try {
        fs.rmSync(filePath, { force: true });
    } finally {
        release();
    }
    clearChatRecoveryStateAfterDelete(user, conversationId, chatId);
}

/**
 * @param {StoreUser} user
 * @param {string} conversationId
 * @param {string} chatId
 * @returns {{ fileName: string, data: string }} The chat file as stored, and a file name made from the chat's name.
 */
export function exportChat(user, conversationId, chatId) {
    const entry = requireListedChat(readConversation(user, conversationId), chatId);
    const result = readChatJsonlStrict(guard(() => getChatFilePath(user.directories, conversationId, chatId)));
    if (result.status === 'missing') {
        throw notFound('The chat file');
    }
    if (result.status !== 'ok') {
        throw new ConversationStoreError('corrupt', 'The chat file cannot be read.', { reason: result.reason });
    }
    const baseName = sanitize(entry.name).trim() || entry.id;
    return { fileName: `${baseName}.jsonl`, data: Buffer.from(result.data).toString('utf8') };
}

// ---------------------------------------------------------------------------------------------------------------------
// Characters

function readCharacterFile(user) {
    const filePath = guard(() => getCharactersJsonPath(user.directories));
    const result = readJsonFile(filePath);
    if (result.corrupt) {
        const setAside = `${filePath}.corrupt-${Date.now()}-${process.pid}`;
        fs.renameSync(filePath, setAside);
        console.warn(`characters.json could not be read and was set aside as ${setAside}; the character state starts empty.`);
        return normalizeStoredCharacterState(null);
    }
    return normalizeStoredCharacterState(result.missing ? null : result.value);
}

/**
 * @param {StoreUser} user
 * @returns {{ version: number, characters: Record<string, { routine?: object, statusOverride?: string }> }}
 * A `characters.json` that cannot be read is set aside, and the state starts empty.
 */
export function readCharacterState(user) {
    return readCharacterFile(user);
}

/**
 * @param {StoreUser} user
 * @param {string} avatar The character's avatar file name.
 * @param {{ routine?: object|null, statusOverride?: string|null }} patch `routine` merges its fields; a null clears.
 * @returns {Record<string, any>} The new state of that character.
 */
export function updateCharacterState(user, avatar, patch) {
    const name = guard(() => parseCharacterAvatar(avatar));
    const filePath = guard(() => getCharactersJsonPath(user.directories));
    const release = acquireChatFileLock(filePath);
    try {
        const state = readCharacterFile(user);
        const next = guard(() => applyCharacterPatch(state.characters[name] ?? {}, patch));
        const characters = { ...state.characters };
        if (Object.keys(next).length > 0) {
            characters[name] = next;
        } else {
            delete characters[name];
        }
        writeJson(filePath, { version: state.version, characters });
        return next;
    } finally {
        release();
    }
}
