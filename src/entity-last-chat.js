import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { tryWriteFileSync } from './util.js';

export const ENTITY_LAST_CHAT_FILE = 'entity-last-chat.json';
const STORE_VERSION = 1;
const LOCK_FILENAME = `${ENTITY_LAST_CHAT_FILE}.lock`;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RETRY_LIMIT = 200;
const MAX_CHAT_NAME_LENGTH = 255;

// SillyBunny: upstream keeps the last opened chat inside the character card, so
// every chat switch re-encodes the PNG. This sidecar holds it instead. Groups are
// absent on purpose: their active chat already lives in the group file.

function createStore() {
    return {
        version: STORE_VERSION,
        characters: { entries: {} },
    };
}

function normalizeChatName(value) {
    if (typeof value !== 'string') {
        return '';
    }

    const trimmed = value.trim();
    return trimmed.length > MAX_CHAT_NAME_LENGTH ? '' : trimmed;
}

function normalizeStore(value) {
    if (!value || typeof value !== 'object' || value.version !== STORE_VERSION) {
        throw new Error('Unsupported entity last-chat metadata format.');
    }

    const store = createStore();
    const sourceScope = value.characters;
    if (!sourceScope || typeof sourceScope !== 'object') {
        return store;
    }

    if (!sourceScope.entries || typeof sourceScope.entries !== 'object' || Array.isArray(sourceScope.entries)) {
        return store;
    }

    for (const [id, chatName] of Object.entries(sourceScope.entries)) {
        const normalizedChatName = normalizeChatName(chatName);
        if (id && normalizedChatName) {
            store.characters.entries[id] = normalizedChatName;
        }
    }

    return store;
}

function readStore(userRoot) {
    if (typeof userRoot !== 'string' || !userRoot) {
        throw new TypeError('A user root is required for entity last-chat metadata.');
    }

    const filePath = path.join(userRoot, ENTITY_LAST_CHAT_FILE);
    if (!fs.existsSync(filePath)) {
        return { filePath, store: createStore() };
    }

    try {
        return { filePath, store: normalizeStore(JSON.parse(fs.readFileSync(filePath, 'utf8'))) };
    } catch (error) {
        const corruptPath = `${filePath}.corrupt-${Date.now()}-${process.pid}`;
        try {
            fs.renameSync(filePath, corruptPath);
            console.error(`Could not read entity last-chat metadata at ${filePath}. The corrupt file was moved to ${corruptPath}.`, error);
            return { filePath, store: createStore() };
        } catch (backupError) {
            throw new Error(`Could not preserve corrupt entity last-chat metadata at ${filePath}.`, { cause: backupError });
        }
    }
}

function withStoreLock(userRoot, callback) {
    fs.mkdirSync(userRoot, { recursive: true });
    const lockPath = path.join(userRoot, LOCK_FILENAME);
    let release;

    for (let attempt = 0; attempt <= LOCK_RETRY_LIMIT; attempt++) {
        try {
            release = lockfile.lockSync(userRoot, {
                lockfilePath: lockPath,
                realpath: false,
                stale: 30_000,
                update: 10_000,
            });
            break;
        } catch (error) {
            if (error?.code !== 'ELOCKED' || attempt === LOCK_RETRY_LIMIT) {
                throw error;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_DELAY_MS);
        }
    }

    try {
        return callback();
    } finally {
        release?.();
    }
}

function updateStore(userRoot, callback) {
    return withStoreLock(userRoot, () => {
        const state = readStore(userRoot);
        const before = JSON.stringify(state.store);
        const result = callback(state.store.characters);

        if (before !== JSON.stringify(state.store)) {
            tryWriteFileSync(state.filePath, `${JSON.stringify(state.store, null, 4)}\n`, 'utf8');
        }

        return result;
    });
}

/**
 * Reads every persisted last-opened chat name.
 * Lock-free: writes land atomically, so a reader never observes a partial file.
 * @param {string} userRoot User data root.
 * @returns {Map<string, string>} Chat names keyed by avatar filename.
 */
export function readEntityLastChats(userRoot) {
    const { store } = readStore(userRoot);
    return new Map(Object.entries(store.characters.entries));
}

/**
 * Reads one character's persisted last-opened chat name.
 * @param {string} userRoot User data root.
 * @param {string} id Avatar filename.
 * @returns {string|undefined} Persisted chat name.
 */
export function getEntityLastChat(userRoot, id) {
    if (typeof id !== 'string' || !id) {
        throw new TypeError('Entity last-chat metadata requires a non-empty string ID.');
    }

    return readStore(userRoot).store.characters.entries[id];
}

/**
 * Records the chat a character most recently had open.
 * @param {string} userRoot User data root.
 * @param {string} id Avatar filename.
 * @param {string} chatName Chat filename without its extension.
 * @returns {string} Persisted chat name.
 */
export function setEntityLastChat(userRoot, id, chatName) {
    if (typeof id !== 'string' || !id) {
        throw new TypeError('Entity last-chat metadata requires a non-empty string ID.');
    }

    const normalizedChatName = normalizeChatName(chatName);
    return updateStore(userRoot, (scope) => {
        if (normalizedChatName) {
            scope.entries[id] = normalizedChatName;
        } else {
            delete scope.entries[id];
        }
        return normalizedChatName;
    });
}

/**
 * Carries a character's last-opened chat across a rename.
 * @param {string} userRoot User data root.
 * @param {string} oldId Previous avatar filename.
 * @param {string} newId New avatar filename.
 * @param {string} [fallback] Chat name to adopt when the old ID was not indexed.
 * @returns {string|undefined} Chat name assigned to the new ID.
 */
export function prepareEntityLastChatMove(userRoot, oldId, newId, fallback) {
    if (typeof oldId !== 'string' || !oldId || typeof newId !== 'string' || !newId) {
        throw new TypeError('Entity last-chat moves require non-empty string IDs.');
    }

    return updateStore(userRoot, (scope) => {
        const chatName = normalizeChatName(scope.entries[oldId]) || normalizeChatName(fallback);
        delete scope.entries[oldId];
        if (chatName) {
            scope.entries[newId] = chatName;
        }
        return chatName || undefined;
    });
}

/**
 * Drops a character's persisted last-opened chat.
 * @param {string} userRoot User data root.
 * @param {string} id Avatar filename.
 * @returns {string|undefined} Removed chat name.
 */
export function removeEntityLastChat(userRoot, id) {
    if (typeof id !== 'string' || !id) {
        throw new TypeError('Entity last-chat removal requires a non-empty string ID.');
    }

    return updateStore(userRoot, (scope) => {
        const chatName = scope.entries[id];
        delete scope.entries[id];
        return chatName;
    });
}

/**
 * Merges metadata from an account import without dropping concurrent local writes.
 * @param {string} userRoot User data root.
 * @param {string|Buffer|object} value Imported metadata.
 */
export function importEntityLastChat(userRoot, value) {
    const parsed = typeof value === 'string' || Buffer.isBuffer(value)
        ? JSON.parse(value.toString())
        : value;
    const importedStore = normalizeStore(parsed);

    withStoreLock(userRoot, () => {
        const state = readStore(userRoot);
        for (const [id, chatName] of Object.entries(state.store.characters.entries)) {
            if (!Object.hasOwn(importedStore.characters.entries, id)) {
                importedStore.characters.entries[id] = chatName;
            }
        }

        tryWriteFileSync(state.filePath, `${JSON.stringify(importedStore, null, 4)}\n`, 'utf8');
    });
}
