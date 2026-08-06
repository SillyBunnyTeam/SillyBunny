import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { tryWriteFileSync } from './util.js';

export const ENTITY_DATE_ADDED_FILE = 'entity-date-added.json';
const STORE_VERSION = 1;
const ENTITY_TYPES = new Set(['characters', 'groups']);
const LOCK_FILENAME = `${ENTITY_DATE_ADDED_FILE}.lock`;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RETRY_LIMIT = 200;

function createScope() {
    return {
        initialized: false,
        entries: {},
        deleted: {},
    };
}

function createStore() {
    return {
        version: STORE_VERSION,
        characters: createScope(),
        groups: createScope(),
    };
}

function isValidTimestamp(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeTimestamp(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getScope(store, entityType) {
    if (!ENTITY_TYPES.has(entityType)) {
        throw new TypeError(`Unsupported entity date-added type: ${entityType}`);
    }

    return store[entityType];
}

function normalizeStore(value) {
    if (!value || typeof value !== 'object' || value.version !== STORE_VERSION) {
        throw new Error('Unsupported entity date-added metadata format.');
    }

    const store = createStore();
    for (const entityType of ENTITY_TYPES) {
        const sourceScope = value[entityType];
        if (!sourceScope || typeof sourceScope !== 'object') {
            continue;
        }

        store[entityType].initialized = sourceScope.initialized === true;
        if (!sourceScope.entries || typeof sourceScope.entries !== 'object' || Array.isArray(sourceScope.entries)) {
            continue;
        }

        for (const [id, timestamp] of Object.entries(sourceScope.entries)) {
            const normalizedTimestamp = Number(timestamp);
            if (id && Number.isFinite(normalizedTimestamp) && normalizedTimestamp > 0) {
                store[entityType].entries[id] = normalizedTimestamp;
            }
        }

        if (!sourceScope.deleted || typeof sourceScope.deleted !== 'object' || Array.isArray(sourceScope.deleted)) {
            continue;
        }

        for (const [id, timestamp] of Object.entries(sourceScope.deleted)) {
            const normalizedTimestamp = Number(timestamp);
            if (id && !Object.hasOwn(store[entityType].entries, id) && Number.isFinite(normalizedTimestamp) && normalizedTimestamp > 0) {
                store[entityType].deleted[id] = normalizedTimestamp;
            }
        }
    }

    return store;
}

function readStore(userRoot) {
    if (typeof userRoot !== 'string' || !userRoot) {
        throw new TypeError('A user root is required for entity date-added metadata.');
    }

    const filePath = path.join(userRoot, ENTITY_DATE_ADDED_FILE);
    if (!fs.existsSync(filePath)) {
        return { filePath, store: createStore(), writable: true };
    }

    try {
        const store = normalizeStore(JSON.parse(fs.readFileSync(filePath, 'utf8')));
        return { filePath, store, writable: true };
    } catch (error) {
        const corruptPath = `${filePath}.corrupt-${Date.now()}-${process.pid}`;
        try {
            fs.renameSync(filePath, corruptPath);
            console.error(`Could not read entity date-added metadata at ${filePath}. The corrupt file was moved to ${corruptPath}.`, error);
            return { filePath, store: createStore(), writable: true };
        } catch (backupError) {
            throw new Error(`Could not preserve corrupt entity date-added metadata at ${filePath}.`, { cause: backupError });
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

function updateStore(userRoot, entityType, callback) {
    return withStoreLock(userRoot, () => {
        const state = readStore(userRoot);
        const scope = getScope(state.store, entityType);
        const before = JSON.stringify(state.store);
        const result = callback(scope);

        if (state.writable && before !== JSON.stringify(state.store)) {
            tryWriteFileSync(state.filePath, `${JSON.stringify(state.store, null, 4)}\n`, 'utf8', { durable: true });
        }

        return result;
    });
}

/**
 * Reconciles persisted date-added metadata with the entities currently on disk.
 * The first reconciliation migrates filesystem timestamps; later discoveries use discovery time.
 * @param {string} userRoot User data root.
 * @param {'characters'|'groups'} entityType Entity collection to reconcile.
 * @param {{id: string, fallback: number}[]} entities Current entity IDs and migration timestamps.
 * @param {number} [now] Discovery timestamp.
 * @returns {Map<string, number>} Date-added timestamps keyed by entity ID.
 */
export function reconcileEntityDateAdded(userRoot, entityType, entities, now = Date.now()) {
    if (!Array.isArray(entities)) {
        throw new TypeError('Entity date-added reconciliation requires an entity array.');
    }

    const discoveredAt = normalizeTimestamp(now, Date.now());
    return updateStore(userRoot, entityType, (scope) => {
        const result = new Map();
        const isMigration = !scope.initialized;

        for (const entity of entities) {
            if (!entity || typeof entity.id !== 'string' || !entity.id) {
                throw new TypeError('Entity date-added reconciliation requires non-empty string IDs.');
            }

            let timestamp = scope.entries[entity.id];
            if (!isValidTimestamp(timestamp)) {
                const deletedAt = scope.deleted[entity.id];
                const fallback = normalizeTimestamp(entity.fallback, 0);
                if (isValidTimestamp(deletedAt) && fallback <= deletedAt) {
                    continue;
                }

                delete scope.deleted[entity.id];
                timestamp = isMigration
                    ? normalizeTimestamp(fallback, discoveredAt)
                    : discoveredAt;
                scope.entries[entity.id] = timestamp;
            }
            result.set(entity.id, timestamp);
        }

        scope.initialized = true;
        return result;
    });
}

/**
 * Gets or assigns an immutable local date-added timestamp for an entity.
 * @param {string} userRoot User data root.
 * @param {'characters'|'groups'} entityType Entity collection.
 * @param {string} id Entity ID.
 * @param {number} fallback Filesystem timestamp used during initial migration.
 * @param {number} [now] Timestamp used for entities discovered after migration.
 * @returns {number} Persisted date-added timestamp.
 */
export function ensureEntityDateAdded(userRoot, entityType, id, fallback, now = Date.now()) {
    if (typeof id !== 'string' || !id) {
        throw new TypeError('Entity date-added metadata requires a non-empty string ID.');
    }

    const discoveredAt = normalizeTimestamp(now, Date.now());
    return updateStore(userRoot, entityType, (scope) => {
        let timestamp = scope.entries[id];
        if (!isValidTimestamp(timestamp)) {
            timestamp = scope.initialized
                ? discoveredAt
                : normalizeTimestamp(fallback, discoveredAt);
            scope.entries[id] = timestamp;
        }
        delete scope.deleted[id];
        return timestamp;
    });
}

/**
 * Assigns a new immutable date-added timestamp after an entity file is created.
 * @param {string} userRoot User data root.
 * @param {'characters'|'groups'} entityType Entity collection.
 * @param {string} id Entity ID.
 * @param {number} [now] Creation timestamp.
 * @returns {number} Persisted date-added timestamp.
 */
export function createEntityDateAdded(userRoot, entityType, id, now = Date.now()) {
    if (typeof id !== 'string' || !id) {
        throw new TypeError('Entity date-added metadata requires a non-empty string ID.');
    }

    const timestamp = normalizeTimestamp(now, Date.now());
    return updateStore(userRoot, entityType, (scope) => {
        scope.entries[id] = timestamp;
        delete scope.deleted[id];
        return timestamp;
    });
}

/**
 * Prepares a rename by assigning the original date-added timestamp to the new ID.
 * @param {string} userRoot User data root.
 * @param {'characters'|'groups'} entityType Entity collection.
 * @param {string} oldId Previous entity ID.
 * @param {string} newId New entity ID.
 * @param {number} fallback Filesystem timestamp used if the old ID was not indexed.
 * @param {number} [now] Discovery timestamp used after migration.
 * @returns {number} Date-added timestamp assigned to the new ID.
 */
export function prepareEntityDateAddedMove(userRoot, entityType, oldId, newId, fallback, now = Date.now()) {
    if (typeof oldId !== 'string' || !oldId || typeof newId !== 'string' || !newId) {
        throw new TypeError('Entity date-added moves require non-empty string IDs.');
    }

    const discoveredAt = normalizeTimestamp(now, Date.now());
    return updateStore(userRoot, entityType, (scope) => {
        const timestamp = isValidTimestamp(scope.entries[oldId])
            ? scope.entries[oldId]
            : normalizeTimestamp(fallback, discoveredAt);

        scope.entries[newId] = timestamp;
        delete scope.deleted[newId];
        return timestamp;
    });
}

/**
 * Removes an entity's persisted date-added timestamp.
 * @param {string} userRoot User data root.
 * @param {'characters'|'groups'} entityType Entity collection.
 * @param {string} id Entity ID.
 * @param {number} [now] Deletion timestamp.
 * @returns {number|undefined} Removed date-added timestamp.
 */
export function removeEntityDateAdded(userRoot, entityType, id, now = Date.now()) {
    if (typeof id !== 'string' || !id) {
        throw new TypeError('Entity date-added removal requires a non-empty string ID.');
    }

    const deletedAt = normalizeTimestamp(now, Date.now());
    return updateStore(userRoot, entityType, (scope) => {
        const timestamp = scope.entries[id];
        delete scope.entries[id];
        scope.deleted[id] = deletedAt;
        return isValidTimestamp(timestamp) ? timestamp : undefined;
    });
}

/**
 * Merges metadata from an account import without dropping concurrent local additions.
 * @param {string} userRoot User data root.
 * @param {string|Buffer|object} value Imported metadata.
 */
export function importEntityDateAdded(userRoot, value) {
    const parsed = typeof value === 'string' || Buffer.isBuffer(value)
        ? JSON.parse(value.toString())
        : value;
    const importedStore = normalizeStore(parsed);

    withStoreLock(userRoot, () => {
        const state = readStore(userRoot);
        for (const entityType of ENTITY_TYPES) {
            const currentScope = state.store[entityType];
            const importedScope = importedStore[entityType];

            for (const [id, timestamp] of Object.entries(currentScope.entries)) {
                if (!Object.hasOwn(importedScope.entries, id)) {
                    importedScope.entries[id] = timestamp;
                    delete importedScope.deleted[id];
                }
            }
            for (const [id, timestamp] of Object.entries(currentScope.deleted)) {
                if (!Object.hasOwn(importedScope.entries, id) && !Object.hasOwn(importedScope.deleted, id)) {
                    importedScope.deleted[id] = timestamp;
                }
            }
            importedScope.initialized ||= currentScope.initialized;
        }

        tryWriteFileSync(state.filePath, `${JSON.stringify(importedStore, null, 4)}\n`, 'utf8', { durable: true });
    });
}
