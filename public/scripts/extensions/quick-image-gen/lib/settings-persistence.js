function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

const persistenceQueues = new WeakMap();

export const PENDING_SYNC_MARKER_PREFIX = "qig_sync_pending:";

export function cloneSynchronizedValue(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

export function isValidSynchronizedStore(value, expectedType) {
    if (expectedType === "array") return Array.isArray(value);
    if (expectedType === "object") return isPlainObject(value);
    throw new Error(`Unsupported synchronized store type: ${expectedType}`);
}

export function reconcileSynchronizedStore({ serverValue, localValue, fallback, expectedType }) {
    if (!isValidSynchronizedStore(fallback, expectedType)) {
        throw new Error(`Fallback must be a valid ${expectedType}`);
    }

    if (isValidSynchronizedStore(serverValue, expectedType)) {
        return {
            value: cloneSynchronizedValue(serverValue),
            source: "server",
            serverNeedsUpdate: false,
        };
    }

    const source = isValidSynchronizedStore(localValue, expectedType) ? "local" : "default";
    return {
        value: cloneSynchronizedValue(source === "local" ? localValue : fallback),
        source,
        serverNeedsUpdate: true,
    };
}

export function canSeedSynchronizedStoreFromLocal({ serverCacheId, localCacheId }) {
    const serverId = String(serverCacheId || "");
    const localId = String(localCacheId || "");
    return Boolean(serverId && localId && serverId === localId);
}

function restoreStorageValue(storage, key, previousValue) {
    if (previousValue == null) storage.removeItem(key);
    else storage.setItem(key, previousValue);
}

async function persistSynchronizedStoresNow({
    storage,
    settings,
    stores,
    save,
    acknowledge = null,
}) {
    if (!storage || !settings || !Array.isArray(stores) || !stores.length || typeof save !== "function") {
        throw new Error("Synchronized store persistence is unavailable");
    }

    const records = stores.map(({ localKey, backupKey, value }) => {
        if (!localKey || !backupKey) throw new Error("Synchronized store persistence is unavailable");
        const hadBackup = Object.prototype.hasOwnProperty.call(settings, backupKey);
        return {
            localKey,
            backupKey,
            value: cloneSynchronizedValue(value),
            hadBackup,
            previousBackup: hadBackup ? cloneSynchronizedValue(settings[backupKey]) : undefined,
            previousLocal: null,
            cacheWritten: false,
            cacheError: null,
        };
    });

    for (const record of records) {
        try {
            record.previousLocal = storage.getItem(record.localKey);
            storage.setItem(record.localKey, JSON.stringify(record.value));
            record.cacheWritten = true;
        } catch (error) {
            record.cacheError = error;
        }
        settings[record.backupKey] = cloneSynchronizedValue(record.value);
    }

    let confirmed = true;
    let confirmationError = null;
    try {
        await save();
        if (typeof acknowledge === "function") {
            try {
                const result = await acknowledge();
                if (result === false) confirmed = false;
            } catch (error) {
                confirmed = false;
                confirmationError = error;
            }
        }
    } catch (error) {
        const rollbackErrors = [];
        for (const record of records) {
            if (record.hadBackup) settings[record.backupKey] = record.previousBackup;
            else delete settings[record.backupKey];
            if (record.cacheWritten) {
                try {
                    restoreStorageValue(storage, record.localKey, record.previousLocal);
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
        }
        // The remote commit may have succeeded before the rejection (lost response);
        // persist the restored state so the server cannot remain ahead of local data.
        try {
            await save();
        } catch (compensationError) {
            rollbackErrors.push(compensationError);
        }
        if (rollbackErrors.length) {
            throw new AggregateError(
                [error, ...rollbackErrors],
                `Server synchronization failed: ${String(error?.message || error)}; the rollback could not be fully persisted`,
            );
        }
        throw error;
    }

    // The save resolved but was not positively confirmed: the server copy may
    // still hold the old value, so mark the local cache authoritative for the
    // next reconciliation instead of letting a stale server value win.
    if (!confirmed) {
        for (const record of records) {
            if (!record.cacheWritten) continue;
            try {
                storage.setItem(`${PENDING_SYNC_MARKER_PREFIX}${record.localKey}`, "1");
            } catch { /* best effort */ }
        }
    } else {
        for (const record of records) {
            try {
                storage.removeItem(`${PENDING_SYNC_MARKER_PREFIX}${record.localKey}`);
            } catch { /* best effort */ }
        }
    }

    return {
        values: records.map(record => cloneSynchronizedValue(record.value)),
        cacheSaved: records.every(record => !record.cacheError),
        cacheErrors: records
            .filter(record => record.cacheError)
            .map(record => ({ localKey: record.localKey, error: record.cacheError })),
        confirmed,
        confirmationError,
    };
}

export function persistSynchronizedStores(options) {
    const { settings } = options;
    if (!settings || (typeof settings !== "object" && typeof settings !== "function")) {
        return Promise.reject(new Error("Synchronized store persistence is unavailable"));
    }

    const previous = persistenceQueues.get(settings) || Promise.resolve();
    const operation = previous
        .catch(() => {})
        .then(() => persistSynchronizedStoresNow(options));
    persistenceQueues.set(settings, operation);
    return operation.finally(() => {
        if (persistenceQueues.get(settings) === operation) persistenceQueues.delete(settings);
    });
}

export async function persistSynchronizedStore(options) {
    const result = await persistSynchronizedStores({
        storage: options.storage,
        settings: options.settings,
        stores: [{
            localKey: options.localKey,
            backupKey: options.backupKey,
            value: options.value,
        }],
        save: options.save,
        acknowledge: options.acknowledge,
    });
    return {
        value: result.values[0],
        cacheSaved: result.cacheSaved,
        cacheError: result.cacheErrors[0]?.error || null,
        confirmed: result.confirmed,
        confirmationError: result.confirmationError,
    };
}
