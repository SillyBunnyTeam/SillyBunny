import path from 'node:path';

import { isPathInside } from './path-containment.js';
import { SqliteCache, getFileKey, getFileStamp, hasNulCharacter } from './sqlite-cache.js';

// Raise the version when the stored summary of an unchanged chat file changes, for example after a change to how a
// preview or the last message time is worked out. An index file with another version is deleted and built again.
const SCHEMA_VERSION = 2;

// A row describes one chat file. `read_through` is part of the key because the unread count comes from the chat's
// read marker in conversation.json, not from the file, so a row is only good for the marker it was worked out with.
const SCHEMA = `CREATE TABLE chats (
    directory TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    read_through TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL,
    preview TEXT NOT NULL,
    unread INTEGER NOT NULL,
    last_message_role TEXT NOT NULL,
    has_user_message INTEGER NOT NULL,
    PRIMARY KEY (directory, file_name)
)`;

const STATEMENTS = {
    get: `SELECT message_count AS messageCount, last_message_at AS lastMessageAt, preview, unread,
        last_message_role AS lastMessageRole, has_user_message AS hasUserMessage FROM chats
        WHERE directory = ? AND file_name = ? AND size = ? AND mtime = ? AND read_through = ?`,
    set: `INSERT OR REPLACE INTO chats (directory, file_name, size, mtime, read_through, message_count, last_message_at, preview, unread,
        last_message_role, has_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    delete: 'DELETE FROM chats WHERE directory = ? AND file_name = ?',
    deleteFolder: 'DELETE FROM chats WHERE directory = ?',
    listAll: 'SELECT directory, file_name FROM chats',
};

const MESSAGES = {
    nodeTooOld: 'The conversation index needs Node.js 22.13 or newer, so the conversation list is built from the files.',
    failed: 'Conversation index error. The conversation list is built from the files until the server restarts:',
    closeFailed: 'Could not close the conversation index:',
};

/**
 * @typedef {object} ChatSummary
 * @property {number} messageCount
 * @property {number} lastMessageAt
 * @property {string} preview
 * @property {number} unread
 * @property {string} lastMessageRole
 * @property {boolean} hasUserMessage
 */

/**
 * Keeps what the conversation list shows for each chat (message count, last message time, preview, unread count, role of the last message, whether the user wrote) in a
 * SQLite file, so that the list does not read every chat file.
 * The chat files stay the source of truth: a row is used only while its file has the same size and modification time as
 * when the row was worked out, and the chat has the same read marker. The database file can be deleted at any time,
 * and the list is then built from the files, as it is when the index is off or fails.
 */
export class ConversationIndex {
    #cache;

    /**
     * @param {object} options Index options
     * @param {boolean} options.enabled False keeps the index off, so every call answers as if it had no rows
     */
    constructor({ enabled }) {
        this.#cache = new SqliteCache({
            fileName: 'conversations.sqlite',
            enabled,
            schemaVersion: SCHEMA_VERSION,
            schema: SCHEMA,
            statements: STATEMENTS,
            messages: MESSAGES,
        });
    }

    /**
     * @returns {string}
     */
    get filePath() {
        return this.#cache.filePath;
    }

    /**
     * @param {string} chatFilePath Path of the chat file
     * @param {{ size: number, mtimeMs: number }} fileStat Metadata of the chat file, read before the file
     * @param {string} readThrough The chat's read marker, which is a message id or empty
     * @returns {ChatSummary|undefined} Undefined if the index is off or has no row for this file and marker
     */
    get(chatFilePath, fileStat, readThrough) {
        return this.#cache.use((statements) => {
            const row = statements.get.get(...getFileKey(chatFilePath), ...getFileStamp(fileStat), readThrough);
            return row ? { ...row, hasUserMessage: row.hasUserMessage === 1 } : undefined;
        });
    }

    /**
     * @param {string} chatFilePath Path of the chat file
     * @param {{ size: number, mtimeMs: number }} fileStat Metadata of the chat file, read before the data that the
     * summary was worked out from. Metadata read after the data can belong to a newer version of the file, and the
     * index would then return the old summary for it.
     * @param {string} readThrough The chat's read marker, which is a message id or empty
     * @param {ChatSummary} summary
     */
    set(chatFilePath, fileStat, readThrough, summary) {
        // Node.js 22 returns a stored TEXT value only up to its first NUL character, so a row with one in a text
        // column would return a cut-off value. Without a row, the list reads the file.
        if (hasNulCharacter(summary.preview) || hasNulCharacter(readThrough)) {
            return;
        }

        this.#cache.use((statements) => {
            statements.set.run(
                ...getFileKey(chatFilePath),
                ...getFileStamp(fileStat),
                readThrough,
                summary.messageCount,
                summary.lastMessageAt,
                summary.preview,
                summary.unread,
                summary.lastMessageRole,
                summary.hasUserMessage ? 1 : 0,
            );
        });
    }

    /**
     * @param {string} chatFilePath Path of the chat file
     */
    delete(chatFilePath) {
        this.#cache.use((statements) => {
            statements.delete.run(...getFileKey(chatFilePath));
        });
    }

    /**
     * Forgets every chat of a conversation.
     * @param {string} chatsDirectory The `chats` folder of the conversation
     */
    deleteFolder(chatsDirectory) {
        this.#cache.use((statements) => {
            statements.deleteFolder.run(path.resolve(chatsDirectory));
        });
    }

    /**
     * Forgets the rows under a folder whose chat file is not in the list, which are the chats and conversations that
     * were removed without the store, for example by hand. Rows outside the folder belong to other users.
     * @param {string} rootDirectory A user's `conversations` folder
     * @param {string[]} chatFilePaths The chat files that exist under it
     */
    retain(rootDirectory, chatFilePaths) {
        this.#cache.use((statements) => {
            const root = path.resolve(rootDirectory);
            const keep = new Set(chatFilePaths.map(filePath => path.join(...getFileKey(filePath))));
            for (const { directory, file_name: fileName } of statements.listAll.all()) {
                if (isPathInside(root, directory) && !keep.has(path.join(directory, fileName))) {
                    statements.delete.run(directory, fileName);
                }
            }
        });
    }

    /**
     * While the index is on, the next call that uses it opens the database file again.
     */
    close() {
        this.#cache.close();
    }
}

/**
 * The index that the conversation store uses. It is on without a setting: it turns itself off on any error, and on
 * Node.js older than 22.13, and the list is then built by reading the files.
 */
export const conversationIndex = new ConversationIndex({ enabled: true });
