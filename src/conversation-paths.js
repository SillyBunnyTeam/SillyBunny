/**
 * Ids and paths of the conversation storage under a user's `conversations/` folder.
 *
 * ```
 * conversations/
 *   characters.json
 *   folders.json
 *   <conversationId>/
 *     conversation.json
 *     chats/<chatId>.jsonl
 *     avatar.<ext>
 * ```
 *
 * This module is a leaf on purpose: `src/endpoints/chats.js` needs the chat location of a conversation to write a
 * reply on the server's behalf, and the store needs `chats.js` to save, so the location code cannot live in the store.
 * Every path leaves this module only after its id has matched a fixed pattern and the resolved path has been checked
 * to lie under the real `conversations/` folder.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';

import { createConversationChatTarget } from './chat-recovery.js';
import { isPathInside } from './path-containment.js';

export const CONVERSATION_ID_PATTERN = /^conv_\d{1,16}_[A-Za-z0-9]{4,32}$/;
export const CHAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const CONVERSATION_FILE_NAME = 'conversation.json';
export const CHARACTERS_FILE_NAME = 'characters.json';
export const FOLDERS_FILE_NAME = 'folders.json';
export const CHATS_DIRECTORY_NAME = 'chats';

/**
 * `code` is `invalid_id` for an id that does not match its pattern, `outside` for a path that leaves the conversations
 * folder, and `no_folder` for a user that has no conversations folder.
 */
export class ConversationPathError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ConversationPathError';
        this.code = code;
    }
}

/**
 * A value that is not a string is refused before the pattern sees it: a JSON body can carry an object whose
 * `toString` is a function that returns a valid id, and `RegExp.test` converts its argument.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isConversationId(value) {
    return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value);
}

/**
 * The pattern keeps a chat id to one path segment. `sanitize()` also refuses Windows device names, which the
 * pattern alone accepts and which would name a device, not a file, on Windows.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isChatId(value) {
    return typeof value === 'string'
        && CHAT_ID_PATTERN.test(value)
        && sanitize(`${value}.jsonl`) === `${value}.jsonl`;
}

/**
 * @param {number} [now] Milliseconds since the epoch.
 * @param {string} [random] The random part, for tests.
 * @returns {string}
 */
export function createConversationId(now = Date.now(), random = crypto.randomBytes(5).toString('hex')) {
    return `conv_${now}_${random}`;
}

/**
 * @param {number} [now] Milliseconds since the epoch.
 * @param {string} [random] The random part, for tests.
 * @returns {string}
 */
export function createChatId(now = Date.now(), random = crypto.randomBytes(6).toString('hex')) {
    return `chat_${now}_${random}`;
}

/**
 * The name under which the backups of one chat are kept in `backups/`. It names the conversation and the chat, so
 * every chat has its own backup ring and a backup file can be traced to its chat.
 * @param {string} conversationId
 * @param {string} chatId
 * @returns {string}
 */
export function getConversationBackupName(conversationId, chatId) {
    return `conversation_${conversationId}_${chatId}`;
}

function getConversationsRoot(directories) {
    const root = directories?.conversations;
    if (typeof root !== 'string' || root.trim() === '') {
        throw new ConversationPathError('no_folder', 'This user has no conversations folder.');
    }
    return path.resolve(root);
}

/**
 * Refuses a path whose existing part leads out of the real `conversations/` folder through a link. The deepest part
 * that exists is resolved, because a path that does not exist yet (a new conversation) has nothing to resolve.
 */
function assertInsideConversationsFolder(root, candidate) {
    if (!isPathInside(root, candidate, { allowEqual: true })) {
        throw new ConversationPathError('outside', `Path is outside the conversations folder: ${candidate}`);
    }

    let probe = candidate;
    for (;;) {
        try {
            fs.lstatSync(probe);
            break;
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
            if (probe === root) {
                return;
            }
            probe = path.dirname(probe);
        }
    }

    let realProbe;
    let realRoot;
    try {
        realProbe = fs.realpathSync(probe);
        realRoot = fs.realpathSync(root);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new ConversationPathError('outside', `Path is outside the conversations folder: ${candidate}`);
        }
        throw error;
    }
    if (!isPathInside(realRoot, realProbe, { allowEqual: true })) {
        throw new ConversationPathError('outside', `Path is outside the conversations folder: ${candidate}`);
    }
}

/**
 * @param {{ conversations?: string }} directories The user's directories.
 * @returns {string} `conversations/characters.json`
 */
export function getCharactersJsonPath(directories) {
    const root = getConversationsRoot(directories);
    const filePath = path.join(root, CHARACTERS_FILE_NAME);
    assertInsideConversationsFolder(root, filePath);
    return filePath;
}

/**
 * @param {{ conversations?: string }} directories The user's directories.
 * @returns {string} `conversations/folders.json`
 */
export function getFoldersJsonPath(directories) {
    const root = getConversationsRoot(directories);
    const filePath = path.join(root, FOLDERS_FILE_NAME);
    assertInsideConversationsFolder(root, filePath);
    return filePath;
}

/**
 * @param {{ conversations?: string }} directories The user's directories.
 * @param {string} conversationId
 * @returns {string} `conversations/<conversationId>`
 */
export function getConversationDirectory(directories, conversationId) {
    if (!isConversationId(conversationId)) {
        throw new ConversationPathError('invalid_id', 'Not a conversation id.');
    }
    const root = getConversationsRoot(directories);
    const directory = path.join(root, conversationId);
    assertInsideConversationsFolder(root, directory);
    return directory;
}

/**
 * @param {{ conversations?: string }} directories The user's directories.
 * @param {string} conversationId
 * @returns {string} `conversations/<conversationId>/conversation.json`
 */
export function getConversationJsonPath(directories, conversationId) {
    const root = getConversationsRoot(directories);
    const filePath = path.join(getConversationDirectory(directories, conversationId), CONVERSATION_FILE_NAME);
    assertInsideConversationsFolder(root, filePath);
    return filePath;
}

/**
 * @param {{ conversations?: string }} directories The user's directories.
 * @param {string} conversationId
 * @param {string} chatId
 * @returns {string} `conversations/<conversationId>/chats/<chatId>.jsonl`
 */
export function getChatFilePath(directories, conversationId, chatId) {
    if (!isChatId(chatId)) {
        throw new ConversationPathError('invalid_id', 'Not a chat id.');
    }
    const root = getConversationsRoot(directories);
    const filePath = path.join(getConversationDirectory(directories, conversationId), CHATS_DIRECTORY_NAME, `${chatId}.jsonl`);
    assertInsideConversationsFolder(root, filePath);
    return filePath;
}

/**
 * Where one chat lives and how its saves are backed up and recovered. Used by the store and by
 * `updateChatRecords()` in `src/endpoints/chats.js`.
 * @param {{ conversations?: string, backups?: string }} directories The user's directories.
 * @param {{ conversationId?: unknown, chatId?: unknown }|null} target
 * @param {number|null} maxRecoveryStates The most recovery states `backups/_chat_recovery` keeps for all chats.
 * @returns {{ cardName: string, fileName: string, filePath: string, recoveryTarget: ReturnType<typeof createConversationChatTarget> }|null}
 * Null when an id is not valid or the path would leave the conversations folder.
 */
export function resolveConversationChatTarget(directories, target, maxRecoveryStates) {
    if (!isConversationId(target?.conversationId) || !isChatId(target?.chatId)) {
        return null;
    }
    try {
        const filePath = getChatFilePath(directories, target.conversationId, target.chatId);
        const fileName = path.basename(filePath);
        return {
            cardName: getConversationBackupName(target.conversationId, target.chatId),
            fileName,
            filePath,
            recoveryTarget: createConversationChatTarget({
                conversationsDirectory: getConversationsRoot(directories),
                backupDirectory: directories.backups,
                owner: target.conversationId,
                filename: fileName,
                maxRecoveryStates,
            }),
        };
    } catch (error) {
        if (error instanceof ConversationPathError) {
            return null;
        }
        throw error;
    }
}
