import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { tryWriteFileSync } from './util.js';

export const ENTITY_LAST_CHAT_FILE = 'entity-last-chat.json';
const STORE_VERSION = 1;
const LOCK_FILENAME = `${ENTITY_LAST_CHAT_FILE}.lock`;
const LOCK_RETRY_DELAY_MS = 25;
const ASYNC_LOCK_RETRY_LIMIT = 200;
const SYNC_LOCK_MAX_WAIT_MS = 1500;
const MAX_CHAT_NAME_LENGTH = 255;
const STORE_CACHE_MAX_ENTRIES = 64;
const storeCache = new Map();
const inProcessMutexQueues = new Map();
const syncWaitArray = new Int32Array(new SharedArrayBuffer(4));

function sleepAsync(delayMs) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
    });
}

function acquireInProcessMutex(key) {
    const previous = inProcessMutexQueues.get(key) ?? Promise.resolve();
    let releaseCurrent;
    const current = new Promise(resolve => {
        releaseCurrent = resolve;
    });
    const tail = previous.then(() => current, () => current);
    inProcessMutexQueues.set(key, tail);

    return previous.then(() => {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            if (inProcessMutexQueues.get(key) === tail) {
                inProcessMutexQueues.delete(key);
            }
            releaseCurrent();
        };
    });
}

function getFileStamp(stat) {
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
}

function setCachedStore(filePath, stamp, store) {
    if (storeCache.has(filePath)) {
        storeCache.delete(filePath);
    } else if (storeCache.size >= STORE_CACHE_MAX_ENTRIES) {
        const oldestKey = storeCache.keys().next().value;
        storeCache.delete(oldestKey);
    }
    storeCache.set(filePath, { stamp, store });
}

function refreshCachedStoreAfterWrite(filePath, store) {
    try {
        const stat = fs.statSync(filePath);
        setCachedStore(filePath, getFileStamp(stat), structuredClone(store));
    } catch {
        storeCache.delete(filePath);
    }
}

export function clearEntityLastChatCache() {
    storeCache.clear();
}

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
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            storeCache.delete(filePath);
            return { filePath, store: createStore() };
        }
        throw error;
    }

    const stamp = getFileStamp(stat);
    const cached = storeCache.get(filePath);
    if (cached && cached.stamp === stamp) {
        storeCache.delete(filePath);
        storeCache.set(filePath, cached);
        return { filePath, store: structuredClone(cached.store) };
    }

    try {
        const store = normalizeStore(JSON.parse(fs.readFileSync(filePath, 'utf8')));
        setCachedStore(filePath, stamp, structuredClone(store));
        return { filePath, store };
    } catch (error) {
        storeCache.delete(filePath);
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

function readCachedStoreIfExists(userRoot) {
    if (typeof userRoot !== 'string' || !userRoot) {
        throw new TypeError('A user root is required for entity last-chat metadata.');
    }
    const filePath = path.join(userRoot, ENTITY_LAST_CHAT_FILE);
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return null;
    }
    const stamp = getFileStamp(stat);
    const cached = storeCache.get(filePath);
    if (cached && cached.stamp === stamp) {
        return cached.store;
    }
    try {
        const store = normalizeStore(JSON.parse(fs.readFileSync(filePath, 'utf8')));
        setCachedStore(filePath, stamp, store);
        return store;
    } catch {
        return null;
    }
}

function withStoreLock(userRoot, callback) {
    fs.mkdirSync(userRoot, { recursive: true });
    const filePath = path.join(userRoot, ENTITY_LAST_CHAT_FILE);
    const lockPath = path.join(userRoot, LOCK_FILENAME);
    let release;
    let waitedMs = 0;
    let nextDelayMs = 5;

    for (;;) {
        try {
            release = lockfile.lockSync(filePath, {
                lockfilePath: lockPath,
                realpath: false,
                stale: 30_000,
                update: 10_000,
            });
            break;
        } catch (error) {
            if (error?.code !== 'ELOCKED' || waitedMs >= SYNC_LOCK_MAX_WAIT_MS) {
                throw error;
            }
            const delayMs = Math.min(nextDelayMs, SYNC_LOCK_MAX_WAIT_MS - waitedMs);
            Atomics.wait(syncWaitArray, 0, 0, delayMs);
            waitedMs += delayMs;
            nextDelayMs = Math.min(LOCK_RETRY_DELAY_MS, nextDelayMs + 5);
        }
    }

    try {
        return callback();
    } finally {
        release?.();
    }
}

/**
 * Runs a callback under an in-process async FIFO mutex and non-blocking cross-process lock
 * without ever blocking the event loop with Atomics.wait.
 * @template T
 * @param {string} userRoot User data root
 * @param {() => Promise<T> | T} callback Work to execute while locked
 * @returns {Promise<T>}
 */
export async function withEntityLastChatLockAsync(userRoot, callback) {
    await fs.promises.mkdir(userRoot, { recursive: true });
    const filePath = path.join(userRoot, ENTITY_LAST_CHAT_FILE);
    const lockPath = path.join(userRoot, LOCK_FILENAME);
    const mutexKey = path.resolve(lockPath);
    const releaseInProcess = await acquireInProcessMutex(mutexKey);
    let releaseFileLock;

    try {
        for (let attempt = 0; attempt <= ASYNC_LOCK_RETRY_LIMIT; attempt++) {
            try {
                releaseFileLock = await lockfile.lock(filePath, {
                    lockfilePath: lockPath,
                    realpath: false,
                    stale: 30_000,
                    update: 10_000,
                });
                break;
            } catch (error) {
                if (error?.code !== 'ELOCKED' || attempt === ASYNC_LOCK_RETRY_LIMIT) {
                    throw error;
                }
                await sleepAsync(LOCK_RETRY_DELAY_MS);
            }
        }
        return await callback();
    } finally {
        try {
            await releaseFileLock?.();
        } finally {
            releaseInProcess();
        }
    }
}

function updateStore(userRoot, callback) {
    return withStoreLock(userRoot, () => {
        const state = readStore(userRoot);
        const before = JSON.stringify(state.store);
        const result = callback(state.store.characters);

        if (before !== JSON.stringify(state.store)) {
            tryWriteFileSync(state.filePath, `${JSON.stringify(state.store, null, 4)}\n`, 'utf8');
            refreshCachedStoreAfterWrite(state.filePath, state.store);
        }

        return result;
    });
}

async function updateStoreAsync(userRoot, callback) {
    return withEntityLastChatLockAsync(userRoot, () => {
        const state = readStore(userRoot);
        const before = JSON.stringify(state.store);
        const result = callback(state.store.characters);

        if (before !== JSON.stringify(state.store)) {
            tryWriteFileSync(state.filePath, `${JSON.stringify(state.store, null, 4)}\n`, 'utf8');
            refreshCachedStoreAfterWrite(state.filePath, state.store);
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
    const cachedStore = readCachedStoreIfExists(userRoot);
    if (cachedStore) {
        const current = cachedStore.characters.entries[id];
        if ((normalizedChatName && current === normalizedChatName) || (!normalizedChatName && current === undefined)) {
            return normalizedChatName;
        }
    }

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
 * Non-blocking async counterpart to setEntityLastChat using the in-process mutex queue.
 */
export async function setEntityLastChatAsync(userRoot, id, chatName) {
    if (typeof id !== 'string' || !id) {
        throw new TypeError('Entity last-chat metadata requires a non-empty string ID.');
    }

    const normalizedChatName = normalizeChatName(chatName);
    const cachedStore = readCachedStoreIfExists(userRoot);
    if (cachedStore) {
        const current = cachedStore.characters.entries[id];
        if ((normalizedChatName && current === normalizedChatName) || (!normalizedChatName && current === undefined)) {
            return normalizedChatName;
        }
    }

    return updateStoreAsync(userRoot, (scope) => {
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
        refreshCachedStoreAfterWrite(state.filePath, importedStore);
    });
}
