/**
 * Server storage of conversation mode: one folder per conversation under the user's `conversations/` folder.
 *
 * ```
 * conversations/
 *   characters.json                  per-character state: routine, status override
 *   folders.json                     the folders of each persona and the conversations filed in them
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
import { chooseChatId, nameChatAfterGroup } from './conversation-conversion-rules.js';
import { conversationIndex } from './conversation-index.js';
import {
    ConversationPathError,
    createChatId,
    createConversationId,
    getCharactersJsonPath,
    getChatFilePath,
    getConversationDirectory,
    getConversationJsonPath,
    getFoldersJsonPath,
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
    isSafeName,
    MAX_AVATAR_IMAGE_BYTES,
    MAX_REMINDERS,
    normalizeStoredCharacterState,
    normalizeStoredConversation,
    parseChatInput,
    parseChatRecords,
    parseCharacterAvatar,
    parseCreateInput,
    parseMemberAvatars,
    parsePersonaId,
    parseNewChatMessages,
    parseNewChatMetadata,
    sniffImageType,
    summarizeChatRecords,
} from './conversation-schema.js';
import {
    FolderInputError,
    applyFolderOps,
    getPersonaFolders,
    normalizeFolderFile,
    parseFolderOps,
    withConvertedGroup,
    withoutConversation,
    withoutPersona,
    withPersonaFolders,
} from '../public/scripts/sillybunny-conversation/folder-model.js';
import { DestructiveChatSaveError, IntegrityMismatchError, InvalidChatDataError, trySaveChat } from './endpoints/chats.js';
import { getConfigValue, tryWriteFileSync } from './util.js';

export { ConversationStoreError, summarizeChatRecords };

/**
 * The settings that a group made by Add Member starts with. The page writes the same literal for a conversation that it
 * makes (`NEW_CONVERSATION_SETTINGS` in `public/scripts/sillybunny-conversation/constants.js`); the server cannot import
 * from `public/`, and a test holds the two equal.
 */
export const NEW_CONVERSATION_SETTINGS = Object.freeze({ characters_react: true });

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
    if (error instanceof FolderInputError) {
        return new ConversationStoreError(error.code, error.message);
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

const EMPTY_SUMMARY = Object.freeze({ messageCount: 0, lastMessageAt: 0, preview: '', unread: 0, lastMessageRole: '', hasUserMessage: false });

/**
 * What the list shows for one chat. The index answers while the chat file has the size and modification time it had
 * when its row was written; otherwise the file is read and the row is replaced. The file metadata is read before the
 * file, so that a write in between can only make the row look stale, never make an old summary look current.
 */
function summarizeChatFile(user, conversationId, entry, index, existingFiles) {
    const filePath = guard(() => getChatFilePath(user.directories, conversationId, entry.id));
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return EMPTY_SUMMARY;
        }
        throw error;
    }
    existingFiles.push(filePath);
    const cached = index.get(filePath, stat, entry.readThrough);
    if (cached) {
        return cached;
    }
    const result = readChatJsonlStrict(filePath);
    if (result.status !== 'ok') {
        return EMPTY_SUMMARY;
    }
    const summary = summarizeChatRecords(result.records, entry.readThrough);
    index.set(filePath, stat, entry.readThrough, summary);
    return summary;
}

function summarizeConversation(user, conversation, index, existingFiles) {
    const chats = conversation.chats.map(entry => ({ ...entry, ...summarizeChatFile(user, conversation.id, entry, index, existingFiles) }));
    const latest = chats.reduce((best, entry) => (entry.lastMessageAt > best.lastMessageAt ? entry : best), { lastMessageAt: 0, preview: '', lastMessageRole: '' });
    return {
        ...conversation,
        chats,
        messageCount: chats.reduce((sum, entry) => sum + entry.messageCount, 0),
        unread: chats.reduce((sum, entry) => sum + entry.unread, 0),
        lastMessageAt: latest.lastMessageAt,
        preview: latest.preview,
        lastMessageRole: latest.lastMessageRole,
        hasUserMessage: chats.some(entry => entry.hasUserMessage),
    };
}

/**
 * Reads the `conversation.json` of every conversation folder, and no chat file. A folder that holds an id and no
 * readable conversation is reported in `problems`, so that nothing disappears silently.
 * @param {StoreUser} user
 * @returns {{ conversations: Record<string, any>[], problems: { id: string, error: string }[] }}
 */
export function scanConversations(user) {
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
 * Every conversation, newest message first, with the counts of each chat. The index answers for a chat whose file did
 * not change; with the index off or failing, every chat file is read.
 * @param {StoreUser} user
 * @param {{ index?: import('./conversation-index.js').ConversationIndex }} [options] `index` replaces the shared index, for tests.
 * @returns {{ conversations: Record<string, any>[], problems: { id: string, error: string }[] }}
 * `problems` names each folder that holds an id and no readable conversation.
 */
export function listConversations(user, { index = conversationIndex } = {}) {
    const { conversations, problems } = scanConversations(user);
    const existingFiles = [];
    const summaries = conversations.map(conversation => summarizeConversation(user, conversation, index, existingFiles));
    summaries.sort((left, right) => right.lastMessageAt - left.lastMessageAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id));
    // A chat or conversation that was removed without the store leaves a row that nothing would ask for again.
    const root = user.directories?.conversations;
    if (typeof root === 'string') {
        index.retain(root, existingFiles);
    }
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
            writeJson(guard(() => getConversationJsonPath(user.directories, id)), next);
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
        conversationIndex.deleteFolder(path.join(directory, CHATS_DIRECTORY_NAME));
        for (const chatId of chatIds) {
            clearChatRecoveryStateAfterDelete(user, id, chatId);
        }
    });
    // The folders lock is taken after the conversation's lock is released, and never the other way round.
    runBestEffort(() => rewriteFolderFile(user, file => withoutConversation(file, id)), `Could not take the deleted conversation ${id} out of its folder.`);
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
    const directory = conversationDirectory(user, id);
    if (!directoryExists(directory)) {
        throw notFound('The conversation');
    }
    return withConversationLock(user, id, () => {
        const current = readConversation(user, id);
        if (current.kind !== 'group') {
            throw new ConversationStoreError('invalid_input', 'Only a group has an avatar of its own.');
        }
        if (!type) {
            throw new ConversationStoreError('invalid_input', 'The avatar must be a PNG, JPEG, GIF or WebP image of at most 5 MiB.');
        }
        const fileName = `avatar.${type.extension}`;
        tryWriteFileSync(path.join(directory, fileName), data, undefined, { durable: true });
        const next = { ...current, avatar: fileName, updatedAt: Math.max(Date.now(), current.updatedAt) };
        writeJson(guard(() => getConversationJsonPath(user.directories, id)), next);
        // The old picture goes after the new one is listed, under the lock and best-effort so locked files cannot fail a committed upload.
        runBestEffort(() => removeAvatarFiles(directory, { except: next.avatar }), `Could not remove the old avatar file of conversation ${id}.`);
        return next;
    });
}

/**
 * @param {StoreUser} user
 * @param {string} id
 * @returns {Record<string, any>} The conversation with an empty `avatar`.
 */
export function removeConversationAvatar(user, id) {
    const directory = conversationDirectory(user, id);
    if (!directoryExists(directory)) {
        throw notFound('The conversation');
    }
    return withConversationLock(user, id, () => {
        const current = readConversation(user, id);
        const next = current.avatar ? { ...current, avatar: '', updatedAt: Math.max(Date.now(), current.updatedAt) } : current;
        if (next !== current) {
            writeJson(guard(() => getConversationJsonPath(user.directories, id)), next);
        }
        runBestEffort(() => removeAvatarFiles(directory), `Could not remove the avatar file of conversation ${id}.`);
        return next;
    });
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
 * @throws {ConversationStoreError} `exists` when the chat is listed already or its file is there.
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
 * Adds a chat that starts with messages, such as a branch of another chat. The messages are written by
 * `trySaveChat()`, as the first save of the chat, so that they get the slug, the backups and the recovery copy of any
 * save. The file is written before the chat is listed, so that a crash leaves an unlisted file and never a listed chat
 * with nothing in it.
 *
 * The write is awaited, so no lock is held across it: the id is checked under the lock before the write and again when
 * the chat is listed.
 * @param {StoreUser} user
 * @param {string} conversationId
 * @param {object} input `messages` (rows without a header) is needed. `id`, `name`, `readThrough`, `activate`, and
 * `chatMetadata` (`{ sb_conversation }`, the memory summary of the source chat) are optional.
 * @returns {Promise<{ conversation: Record<string, any>, chat: Record<string, any>, integrity: string }>} `integrity`
 * is the slug that the file carries; the first save of the browser has to send it.
 * @throws {ConversationStoreError} `exists` when the chat is listed already or its file is there.
 */
export async function createChatFromMessages(user, conversationId, input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new ConversationStoreError('invalid_input', 'The chat must be an object.');
    }
    const { activate = false, messages, chatMetadata, records, ...chatInput } = input;
    if (records !== undefined) {
        throw new ConversationStoreError('invalid_input', 'records is for createChat(); this takes messages.');
    }
    if (typeof activate !== 'boolean') {
        throw new ConversationStoreError('invalid_input', 'activate must be true or false.');
    }
    const { entry: parsedEntry } = guard(() => parseChatInput(chatInput, { now: Date.now() }));
    const savedRecords = [
        { chat_metadata: guard(() => parseNewChatMetadata(chatMetadata)), user_name: 'unused', character_name: 'unused' },
        ...guard(() => parseNewChatMessages(messages)),
    ];
    const entry = { ...parsedEntry, id: parsedEntry.id || createChatId() };
    const target = guard(() => resolveConversationChatTarget(user.directories, { conversationId, chatId: entry.id }, maxRecoveryStates));
    if (!target) {
        throw new ConversationStoreError('invalid_id', 'Not a chat of this conversation.');
    }
    if (!directoryExists(conversationDirectory(user, conversationId))) {
        throw notFound('The conversation');
    }

    withConversationLock(user, conversationId, () => {
        if (readConversation(user, conversationId).chats.some(item => item.id === entry.id) || fs.existsSync(target.filePath)) {
            throw new ConversationStoreError('exists', `The chat "${entry.id}" already exists.`);
        }
    });

    let integrity;
    try {
        ({ integrity } = await trySaveChat(savedRecords, target.filePath, false, user.profile.handle, target.cardName, user.directories.backups, { recoveryTarget: target.recoveryTarget }));
    } catch (error) {
        // A file that appeared since the check above is another writer's chat of the same id, so it stays.
        throw error instanceof IntegrityMismatchError ? new ConversationStoreError('exists', `The chat "${entry.id}" already exists.`) : translateSaveError(error);
    }

    try {
        const conversation = mutateConversation(user, conversationId, (current) => {
            if (current.chats.some(item => item.id === entry.id)) {
                throw new ConversationStoreError('exists', `The chat "${entry.id}" already exists.`);
            }
            return {
                ...current,
                chats: [...current.chats, entry],
                activeChatId: activate ? entry.id : current.activeChatId,
                updatedAt: Math.max(Date.now(), current.updatedAt),
            };
        });
        recordChatSummary(user, conversationId, entry, savedRecords, integrity);
        return { conversation, chat: entry, integrity };
    } catch (error) {
        discardUnlistedChat(user, conversationId, entry.id);
        throw error;
    }
}

/** Takes back a chat file that was written and then not listed, with its recovery copy. A conversation that is gone took the file with it. */
function discardUnlistedChat(user, conversationId, chatId) {
    try {
        forgetChatRecoveryState(user, conversationId, chatId);
        if (directoryExists(conversationDirectory(user, conversationId))) {
            const filePath = guard(() => getChatFilePath(user.directories, conversationId, chatId));
            fs.rmSync(filePath, { force: true });
            conversationIndex.delete(filePath);
        }
        clearChatRecoveryStateAfterDelete(user, conversationId, chatId);
    } catch (cleanupError) {
        console.warn(`Could not take back the unlisted chat "${chatId}" of a conversation.`, cleanupError);
    }
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
    const entry = requireListedChat(readConversation(user, conversationId), chatId);
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
        recordChatSummary(user, conversationId, entry, records, result.integrity);
        return { integrity: result.integrity };
    } catch (error) {
        throw translateSaveError(error);
    }
}

/** What `trySaveChat()` refuses becomes a store error; anything else is returned as it is. */
function translateSaveError(error) {
    if (error instanceof IntegrityMismatchError) {
        return new ConversationStoreError('integrity', 'The chat changed since it was loaded.');
    }
    if (error instanceof DestructiveChatSaveError) {
        return new ConversationStoreError('destructive', 'The save would remove most of the chat.', { reason: error.reason });
    }
    if (error instanceof InvalidChatDataError) {
        return new ConversationStoreError('invalid_input', error.message);
    }
    return error;
}

const MAX_HEADER_BYTES = 1024 * 1024;

/**
 * @param {string} filePath A chat file.
 * @returns {string} The integrity slug in the first line, or an empty string when the line is missing, too long or not a header.
 */
function readHeaderIntegrity(filePath) {
    const descriptor = fs.openSync(filePath, 'r');
    try {
        const chunk = Buffer.alloc(64 * 1024);
        const parts = [];
        let length = 0;
        for (;;) {
            const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, length);
            const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
            const end = newline < 0 ? bytesRead : newline;
            parts.push(Buffer.from(chunk.subarray(0, end)));
            length += end;
            if (newline >= 0 || bytesRead === 0) {
                break;
            }
            if (length > MAX_HEADER_BYTES) {
                return '';
            }
        }
        const integrity = JSON.parse(Buffer.concat(parts).toString('utf8'))?.chat_metadata?.integrity;
        return typeof integrity === 'string' ? integrity : '';
    } catch {
        return '';
    } finally {
        fs.closeSync(descriptor);
    }
}

/**
 * Writes the index row of a chat that was just saved, from the records that were saved. The row carries the metadata
 * of the file as it is now, so it is written only if the file still has the slug of that save: another writer that
 * replaced the file in between leaves a different slug, and its own row is the one that counts. The index is an
 * optional speed-up, so nothing here may fail the save that it follows.
 * Also for a writer that saves a chat on the server's behalf with `updateChatRecords()`.
 * @param {StoreUser} user
 * @param {string} conversationId
 * @param {{ id: string, readThrough: string }} entry The chat's entry in `conversation.json`.
 * @param {object[]} records `[header, ...messages]` as saved.
 * @param {string} integrity The slug that the save returned.
 * @param {import('./conversation-index.js').ConversationIndex} [index]
 */
export function recordChatSummary(user, conversationId, entry, records, integrity, index = conversationIndex) {
    try {
        const filePath = getChatFilePath(user.directories, conversationId, entry.id);
        const stat = fs.statSync(filePath);
        if (integrity && readHeaderIntegrity(filePath) === integrity) {
            index.set(filePath, stat, entry.readThrough, summarizeChatRecords(records, entry.readThrough));
        }
    } catch {
        // The next list reads the file and writes the row.
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
    const directory = conversationDirectory(user, conversationId);
    if (!directoryExists(directory)) {
        throw notFound('The conversation');
    }
    return withConversationLock(user, conversationId, () => {
        const current = readConversation(user, conversationId);
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
        writeJson(guard(() => getConversationJsonPath(user.directories, conversationId)), next);
        removeChatFile(user, conversationId, chatId);
        return next;
    });
}

function removeChatFile(user, conversationId, chatId) {
    const filePath = guard(() => getChatFilePath(user.directories, conversationId, chatId));
    forgetChatRecoveryState(user, conversationId, chatId);
    // The chat is already unlisted, so file removal is best-effort while index and recovery cleanup still run.
    runBestEffort(() => {
        const release = acquireChatFileLock(filePath);
        try {
            fs.rmSync(filePath, { force: true });
        } finally {
            release();
        }
    }, `Could not remove the file of deleted chat "${chatId}" of conversation ${conversationId}.`);
    runBestEffort(() => conversationIndex.delete(filePath), `Could not drop the index row of deleted chat "${chatId}" of conversation ${conversationId}.`);
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
// Members, extras and the conversion of a group

/** A character is a card in the user's characters folder. Only its name is kept, so a link in the folder is not followed for anything. */
function requireCharacterCards(user, avatars) {
    const folder = user.directories?.characters;
    if (typeof folder !== 'string') {
        throw new ConversationStoreError('unavailable', 'Characters are not available.');
    }
    for (const avatar of avatars) {
        const isCard = path.extname(avatar).toLowerCase() === '.png' && fs.statSync(path.join(folder, avatar), { throwIfNoEntry: false })?.isFile() === true;
        if (!isCard) {
            throw new ConversationStoreError('invalid_input', 'characters must name character cards that exist.');
        }
    }
}

/**
 * Adds characters to a group, which then read the history as it is: nothing is written to the chats. On a direct
 * conversation it starts a new group of that conversation's character and the chosen ones, and leaves the direct
 * conversation as it is.
 * @param {StoreUser} user
 * @param {string} id
 * @param {string[]} avatars Avatar file names of cards that exist, none twice, none that is a member already.
 * @returns {{ conversation: Record<string, any>, created: boolean }} The group, and whether it is a new one.
 */
export function addMembers(user, id, avatars) {
    const chosen = guard(() => parseMemberAvatars(avatars));
    requireCharacterCards(user, chosen);
    const current = readConversation(user, id);
    if (current.kind === 'direct') {
        const { conversation } = createConversation(user, { kind: 'group', personaId: current.personaId, characters: [current.characters[0], ...chosen], settings: NEW_CONVERSATION_SETTINGS });
        return { conversation, created: true };
    }
    const conversation = mutateConversation(user, id, latest => guard(() => applyUpdatePatch(latest, { characters: [...latest.characters, ...chosen] }, { now: Date.now() })));
    return { conversation, created: false };
}

/**
 * Takes a member out of a group. The past messages stay. A group that keeps at least two members is changed in place;
 * a group that falls to one member is converted: its chats go to the direct conversation of the member that is left,
 * and the group is deleted (`convertGroupToDirect()`).
 * @param {StoreUser} user
 * @param {string} id
 * @param {string} avatar
 * @returns {{ conversation: Record<string, any>, converted: boolean, removedId?: string }} `conversation` is the group, or
 * after a conversion the direct conversation that the user is to be shown, and `removedId` is the id of the deleted group.
 * @throws {ConversationStoreError} `not_found` when the character is not a member, `invalid_input` for a direct conversation
 * or the last member, `conversion_failed` when the conversion failed and the group is as it was.
 */
export function removeMember(user, id, avatar) {
    const name = guard(() => parseCharacterAvatar(avatar));
    const current = readConversation(user, id);
    if (current.kind !== 'group') {
        throw new ConversationStoreError('invalid_input', 'A direct conversation has no members to remove.');
    }
    if (!current.characters.includes(name)) {
        throw notFound('The member');
    }
    const remaining = current.characters.filter(member => member !== name);
    if (remaining.length === 0) {
        throw new ConversationStoreError('invalid_input', 'The last member cannot be removed. Delete the conversation instead.');
    }
    if (remaining.length === 1) {
        return convertGroupToDirect(user, id, remaining[0]);
    }
    const conversation = mutateConversation(user, id, (latest) => {
        const nextCharacters = latest.characters.filter(member => member !== name);
        // Group reminders carry the group anchor avatar; reassign any targeting the removed member to the new anchor so they stay deliverable.
        const reminders = nextCharacters.length > 0 && latest.reminders.some(reminder => reminder.avatar === name)
            ? latest.reminders.map(reminder => (reminder.avatar === name ? { ...reminder, avatar: nextCharacters[0] } : reminder))
            : undefined;
        return guard(() => applyUpdatePatch(latest, {
            characters: nextCharacters,
            ...(reminders ? { reminders } : {}),
        }, { now: Date.now() }));
    });
    return { conversation, converted: false };
}

/**
 * Takes an extra, a character that the old store listed beside the one of a direct conversation, off the list. There is
 * no way to add one. The messages of that character stay.
 * @param {StoreUser} user
 * @param {string} id
 * @param {string} avatar
 * @returns {{ conversation: Record<string, any> }}
 */
export function removeExtra(user, id, avatar) {
    const name = guard(() => parseCharacterAvatar(avatar));
    const current = readConversation(user, id);
    if (current.kind !== 'direct') {
        throw new ConversationStoreError('invalid_input', 'Only a direct conversation has extras.');
    }
    if (!current.extras.includes(name)) {
        throw notFound('The extra');
    }
    const conversation = mutateConversation(user, id, latest => guard(() => applyUpdatePatch(latest, { extras: latest.extras.filter(extra => extra !== name) }, { now: Date.now() })));
    return { conversation };
}

const CONVERSION_FAILED = 'The group could not be converted, and it is as it was.';

function withoutSlug(records) {
    const metadata = { ...records[0].chat_metadata };
    delete metadata.integrity;
    return [{ ...records[0], chat_metadata: metadata }, ...records.slice(1)];
}

/** A chat of the group as the conversion copies it: its records without the slug, so that the first save of the copy assigns one. A listed chat whose file is gone is carried as a blank chat. */
function readChatForConversion(user, groupId, chatId) {
    try {
        return withoutSlug(loadChat(user, groupId, chatId));
    } catch (error) {
        if (error instanceof ConversationStoreError && error.code === 'not_found') {
            return [{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }];
        }
        throw error;
    }
}

function verifyCopies(user, conversationId, copies) {
    for (const { entry, records } of copies) {
        const result = readChatJsonlStrict(getChatFilePath(user.directories, conversationId, entry.id));
        if (result.status !== 'ok' || JSON.stringify(result.records) !== JSON.stringify(records)) {
            throw new Error(`The copy of the chat "${entry.id}" does not match the original.`);
        }
    }
}

function removeWrittenCopies(user, conversationId, chatIds) {
    for (const chatId of chatIds) {
        const filePath = getChatFilePath(user.directories, conversationId, chatId);
        fs.rmSync(filePath, { force: true });
        conversationIndex.delete(filePath);
    }
}

/**
 * Plans the chats that the direct conversation takes in: the id and name of each, the markers and reminders that name
 * a chat, and the chat that the user is to land in.
 * @param {Record<string, any>} group
 * @param {string[]} taken The chat ids that the direct conversation has, listed or not.
 * @param {object[]} existingReminders The reminders that the direct conversation has.
 * @param {string} remaining The avatar of the surviving direct conversation character.
 */
function planConvertedChats(group, taken, existingReminders, remaining) {
    const used = new Set(taken);
    const ordered = group.chats.map((entry, index) => ({ entry, index })).sort((left, right) => left.entry.createdAt - right.entry.createdAt || left.index - right.index);
    const idMap = new Map(ordered.map(({ entry }) => [entry.id, chooseChatId(entry.id, entry.createdAt, used)]));
    const chats = ordered.map(({ entry }) => ({
        sourceId: entry.id,
        entry: {
            id: idMap.get(entry.id),
            name: nameChatAfterGroup(entry.name, group.name),
            createdAt: entry.createdAt,
            readThrough: entry.readThrough,
            followupCount: entry.followupCount,
            lastAutoMessageAt: entry.lastAutoMessageAt,
            lastActivity: entry.lastActivity,
            sessionMarkers: Object.fromEntries(Object.entries(entry.sessionMarkers).map(([key, value]) => [key, key === 'memory_copied_from' && idMap.has(value) ? idMap.get(value) : value])),
            legacyId: `${group.id}/${entry.id}`,
        },
    }));
    const knownReminders = new Set(existingReminders.map(reminder => reminder.id));
    // Reassign migrated reminders to the surviving member so delivery never targets the removed character.
    const reminders = group.reminders
        .filter(reminder => !knownReminders.has(reminder.id))
        .map(reminder => ({
            ...reminder,
            ...(reminder.chatId && idMap.has(reminder.chatId) ? { chatId: idMap.get(reminder.chatId) } : {}),
            avatar: remaining,
        }));
    return { chats, reminders, activeChatId: idMap.get(group.activeChatId) ?? chats[0].entry.id };
}

/**
 * Converts a group that is left with one member into the direct conversation of that member (plan S4). Its chats are
 * appended to the direct conversation that the member has with the group's persona, each named after the group; the
 * direct conversation is created when there is none. The reminders of the group go with the chats, and a new direct
 * conversation also takes the group's settings and favourite.
 *
 * The group is never half deleted. The copies are written and read back first. Only then is the group's folder
 * renamed out of the id namespace, which is the one step that cannot be taken back, and the renamed folder is removed
 * after it. A failure before the rename restores the direct conversation (or removes the one that was created) and
 * leaves the group untouched, and `conversion_failed` is thrown. A crash between the two steps leaves the copies and
 * the group, and the next conversion of the group replaces the copies, which carry `<groupId>/<chatId>` as their
 * `legacyId`, so that none is repeated.
 *
 * Everything runs inside one synchronous section with the folder locks of the group and of the direct conversation.
 * The backups of the group's chats stay in `backups/`; the copies get theirs at their first save.
 * @param {StoreUser} user
 * @param {string} groupId
 * @param {string} remaining The avatar of the member that is left.
 * @returns {{ conversation: Record<string, any>, converted: true, removedId: string }}
 */
function convertGroupToDirect(user, groupId, remaining) {
    const groupDirectory = conversationDirectory(user, groupId);
    const release = acquireChatFileLock(groupDirectory);
    let group;
    let outcome;
    try {
        group = readConversation(user, groupId);
        if (group.kind !== 'group' || group.characters.length !== 2 || !group.characters.includes(remaining)) {
            throw new ConversationStoreError('invalid_input', 'The group has changed.');
        }
        const recordsBySource = new Map(group.chats.map(entry => [entry.id, readChatForConversion(user, groupId, entry.id)]));
        const target = findDirectConversation(user, group.personaId, remaining);
        try {
            outcome = target
                ? appendCopiesAndRetire(user, group, groupDirectory, target, remaining, recordsBySource)
                : createDirectAndRetire(user, group, groupDirectory, remaining, recordsBySource);
        } catch (error) {
            console.error(`Converting the group ${groupId} failed; the group was left as it was.`, error);
            throw new ConversationStoreError('conversion_failed', CONVERSION_FAILED);
        }
        finishRetiredGroup(user, groupId, group.chats.map(entry => entry.id), groupDirectory, outcome.retiredPath);
    } finally {
        release();
    }
    // The folders lock is taken after the conversation's lock is released, matching deleteConversation().
    // A direct conversation that the conversion made takes the group's folder, as it takes its favourite; one that existed keeps its own.
    runBestEffort(() => rewriteFolderFile(user, file => withConvertedGroup(file, group.personaId, groupId, outcome.createdDirect ? outcome.conversation.id : '')), `Could not move the folder of the converted group ${groupId}.`);
    return { conversation: outcome.conversation, converted: true, removedId: groupId };
}

/**
 * Renames the folder of a group to a name that is no conversation id, so that no list, id or path finds it. This is
 * the commit of a conversion.
 * @returns {string} Where the folder is now.
 */
function retireGroup(groupDirectory) {
    const retiredPath = path.join(path.dirname(groupDirectory), `.${path.basename(groupDirectory)}.deleted-${process.pid}-${Date.now()}`);
    fs.renameSync(groupDirectory, retiredPath);
    return retiredPath;
}

/** What follows the commit of a conversion. None of it can undo the conversion, so a failure is logged and the rest goes on. */
function finishRetiredGroup(user, groupId, chatIds, groupDirectory, retiredPath) {
    for (const chatId of chatIds) {
        forgetChatRecoveryState(user, groupId, chatId);
    }
    runBestEffort(() => fs.rmSync(retiredPath, { recursive: true, force: true }), `The converted group ${groupId} could not be removed from disk and was left as ${path.basename(retiredPath)}.`);
    runBestEffort(() => conversationIndex.deleteFolder(path.join(groupDirectory, CHATS_DIRECTORY_NAME)), `The index rows of the converted group ${groupId} were not dropped.`);
    for (const chatId of chatIds) {
        clearChatRecoveryStateAfterDelete(user, groupId, chatId);
    }
}

function chatFileIds(user, conversationId) {
    try {
        return fs.readdirSync(path.join(conversationDirectory(user, conversationId), CHATS_DIRECTORY_NAME)).filter(name => name.endsWith('.jsonl')).map(name => name.slice(0, -'.jsonl'.length));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

function attachRecords(plan, recordsBySource) {
    return plan.chats.map(({ sourceId, entry }) => ({ entry, records: recordsBySource.get(sourceId) }));
}

function appendCopiesAndRetire(user, group, groupDirectory, target, remaining, recordsBySource) {
    return withConversationLock(user, target.id, () => {
        const jsonPath = guard(() => getConversationJsonPath(user.directories, target.id));
        const previousText = fs.readFileSync(jsonPath, 'utf8');
        const current = readConversation(user, target.id);
        const earlierCopies = current.chats.filter(chat => chat.legacyId?.startsWith(`${group.id}/`));
        const plan = planConvertedChats(group, [...current.chats.map(chat => chat.id), ...chatFileIds(user, target.id)], current.reminders, remaining);
        const copies = attachRecords(plan, recordsBySource);
        const next = {
            ...current,
            chats: [...current.chats.filter(chat => !earlierCopies.includes(chat)), ...plan.chats.map(({ entry }) => entry)],
            activeChatId: plan.activeChatId,
            reminders: [...current.reminders, ...plan.reminders].slice(0, MAX_REMINDERS),
            updatedAt: Math.max(Date.now(), current.updatedAt),
        };
        const written = [];
        let listed = false;
        let retiredPath;
        try {
            for (const copy of copies) {
                writeNewChatFile(user, target.id, copy.entry, copy.records);
                written.push(copy.entry.id);
            }
            verifyCopies(user, target.id, copies);
            writeJson(jsonPath, next);
            listed = true;
            retiredPath = retireGroup(groupDirectory);
        } catch (error) {
            runBestEffort(() => {
                if (listed) {
                    tryWriteFileSync(jsonPath, previousText, 'utf8', { durable: true });
                }
                removeWrittenCopies(user, target.id, written);
            }, `Could not restore the conversation ${target.id} after a failed conversion.`);
            throw error;
        }
        // `retireGroup()` committed the conversion, so cleanup of older copies runs outside the rollback catch.
        runBestEffort(() => removeWrittenCopies(user, target.id, earlierCopies.map(chat => chat.id)), 'Could not remove the copies that an earlier conversion left.');
        return { conversation: next, retiredPath, createdDirect: false };
    });
}

function createDirectAndRetire(user, group, groupDirectory, remaining, recordsBySource) {
    const plan = planConvertedChats(group, [], [], remaining);
    const copies = attachRecords(plan, recordsBySource);
    const { conversation, created } = createConversation(user, {
        kind: 'direct',
        personaId: group.personaId,
        characters: [remaining],
        favorite: group.favorite,
        settings: group.settings,
        reminders: plan.reminders.slice(0, MAX_REMINDERS),
        createdAt: group.createdAt,
        updatedAt: Math.max(Date.now(), group.updatedAt),
        activeChatId: plan.activeChatId,
        chats: copies.map(({ entry, records }) => ({ ...entry, records })),
    });
    if (!created) {
        // A direct conversation appeared concurrently before createConversation(); append into it instead of deleting it on rollback.
        return appendCopiesAndRetire(user, group, groupDirectory, conversation, remaining, recordsBySource);
    }
    try {
        verifyCopies(user, conversation.id, copies);
        return { conversation, retiredPath: retireGroup(groupDirectory), createdDirect: true };
    } catch (error) {
        runBestEffort(() => {
            const directory = conversationDirectory(user, conversation.id);
            fs.rmSync(directory, { recursive: true, force: true });
            conversationIndex.deleteFolder(path.join(directory, CHATS_DIRECTORY_NAME));
        }, `Could not remove the conversation ${conversation.id} after a failed conversion.`);
        throw error;
    }
}

function runBestEffort(work, message) {
    try {
        work();
    } catch (error) {
        console.error(message, error);
    }
}

/**
 * Changes the avatar file name of a character in the lists of one conversation: its members or extras, and the
 * reminders that name it. The lines of its chats are not touched here.
 * @param {StoreUser} user
 * @param {string} id
 * @param {string} from
 * @param {string} to
 * @returns {boolean} Whether the conversation named the character.
 */
export function renameAvatarInConversation(user, id, from, to) {
    const oldName = guard(() => parseCharacterAvatar(from));
    const newName = guard(() => parseCharacterAvatar(to));
    let changed = false;
    let convertTo = '';
    mutateConversation(user, id, (current) => {
        const swap = names => [...new Set(names.map(name => (name === oldName ? newName : name)))];
        const characters = swap(current.characters);
        if (current.kind === 'group' && characters.length === 1 && current.characters.length === 2) {
            convertTo = characters[0];
            return current;
        }
        const extras = swap(current.extras).filter(extra => current.kind !== 'direct' || extra !== characters[0]);
        const next = {
            ...current,
            characters,
            extras,
            reminders: current.reminders.map(reminder => (reminder.avatar === oldName ? { ...reminder, avatar: newName } : reminder)),
        };
        changed = JSON.stringify(next) !== JSON.stringify(current);
        return changed ? { ...next, updatedAt: Math.max(Date.now(), current.updatedAt) } : current;
    });
    if (convertTo) {
        // Collapsing a two-member group onto one avatar converts it so no invalid one-member group remains.
        convertGroupToDirect(user, id, convertTo);
        return true;
    }
    return changed;
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

/**
 * Moves the routine and the status override of a character to its new avatar file name. A state that the new name had
 * already, from an earlier card of that name, is replaced: the renamed character's own state is the one that counts.
 * @param {StoreUser} user
 * @param {string} from
 * @param {string} to
 * @returns {boolean} Whether the character had a state. `characters.json` is not written when it had none.
 */
export function renameCharacterState(user, from, to) {
    const oldName = guard(() => parseCharacterAvatar(from));
    const newName = guard(() => parseCharacterAvatar(to));
    const filePath = guard(() => getCharactersJsonPath(user.directories));
    const release = acquireChatFileLock(filePath);
    try {
        const state = readCharacterFile(user);
        if (!state.characters[oldName]) {
            return false;
        }
        const { [oldName]: moved, ...rest } = state.characters;
        writeJson(filePath, { version: state.version, characters: { ...rest, [newName]: moved } });
        return true;
    } finally {
        release();
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Folders

function readFolderFile(user) {
    const filePath = guard(() => getFoldersJsonPath(user.directories));
    const result = readJsonFile(filePath);
    if (result.corrupt) {
        const setAside = `${filePath}.corrupt-${Date.now()}-${process.pid}`;
        fs.renameSync(filePath, setAside);
        console.warn(`folders.json could not be read and was set aside as ${setAside}; the folders start empty.`);
        return normalizeFolderFile(null);
    }
    return normalizeFolderFile(result.missing ? null : result.value, { isPersonaKey: isSafeName });
}

/**
 * @param {StoreUser} user
 * @returns {{ version: number, personas: Record<string, { favoritesExpanded?: boolean, folders: object[], members: Record<string, string> }> }}
 * The folders of every persona. A `folders.json` that cannot be read is set aside, and the folders start empty.
 */
export function readConversationFolders(user) {
    return readFolderFile(user);
}

/** A conversation that is filed has to exist and to belong to the persona whose folders are changed. */
function requireFilableConversations(user, personaId, ops) {
    for (const op of ops) {
        if (op.op !== 'setMembers' || op.folderId === null) {
            continue;
        }
        for (const id of op.ids) {
            if (readConversation(user, id).personaId !== personaId) {
                throw new ConversationStoreError('invalid_input', 'A conversation can only be filed in the folders of its own persona.');
            }
        }
    }
}

/**
 * Applies the operations of a request to the folders of one persona (see `folder-model.js` for the operations). The
 * request is all or nothing, and nothing is written when it changes nothing.
 * @param {StoreUser} user
 * @param {unknown} personaId
 * @param {unknown} input
 * @returns {{ favoritesExpanded: boolean, folders: object[], members: Record<string, string> }} The persona's record after the change.
 * @throws {ConversationStoreError} `invalid_id`, `invalid_input`, `not_found` or `exists`.
 */
export function updateConversationFolders(user, personaId, input) {
    const persona = parsePersonaId(personaId);
    const ops = guard(() => parseFolderOps(input));
    requireFilableConversations(user, persona, ops);
    const filePath = guard(() => getFoldersJsonPath(user.directories));
    const release = acquireChatFileLock(filePath);
    try {
        const file = readFolderFile(user);
        const next = guard(() => applyFolderOps(getPersonaFolders(file, persona), ops));
        const nextFile = withPersonaFolders(file, persona, next);
        if (JSON.stringify(nextFile) !== JSON.stringify(file)) {
            writeJson(filePath, nextFile);
        }
        return getPersonaFolders(nextFile, persona);
    } finally {
        release();
    }
}

/**
 * Rewrites `folders.json` through `change`, which gets the file and returns the next one, or the same object when it
 * changes nothing. A user with no `folders.json` has nothing to change, so no lock is taken for them.
 * @returns {boolean} Whether the file was written.
 */
function rewriteFolderFile(user, change) {
    const filePath = guard(() => getFoldersJsonPath(user.directories));
    if (!fs.existsSync(filePath)) {
        return false;
    }
    const release = acquireChatFileLock(filePath);
    try {
        const file = readFolderFile(user);
        const next = change(file);
        if (next === file) {
            return false;
        }
        writeJson(filePath, next);
        return true;
    } finally {
        release();
    }
}

/**
 * Removes the folders of a persona that was deleted, with the conversations filed in them (which are deleted with the
 * persona by their own route of the store).
 * @param {StoreUser} user
 * @param {string} personaId
 * @returns {boolean} Whether the persona had folders.
 */
export function forgetPersonaFolders(user, personaId) {
    const persona = parsePersonaId(personaId);
    return rewriteFolderFile(user, file => withoutPersona(file, persona));
}
