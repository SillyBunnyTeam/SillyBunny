/**
 * Sorts object keys at every level, so that equal settings give equal JSON whatever their key order.
 * @param {unknown} value JSON data
 * @returns {unknown}
 */
function sortKeys(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
    }
    return value;
}

/**
 * Remembers the settings that the page last loaded from the server or saved to it.
 *
 * The page builds every save from objects that it keeps changing, so it remembers the JSON that it loaded or sent,
 * not those objects. A save with the remembered settings would change nothing on the server, and a page whose
 * settings are stale would only get the settings conflict prompt for it.
 * @returns {{ getFingerprint: (json: string) => string, remember: (fingerprint: string) => void, isSynced: (fingerprint: string) => boolean }}
 */
export function createSettingsSync() {
    let syncedFingerprint = null;
    return {
        getFingerprint(json) {
            const settings = JSON.parse(json);
            delete settings._version;
            return JSON.stringify(sortKeys(settings));
        },
        remember(fingerprint) {
            syncedFingerprint = fingerprint;
        },
        isSynced(fingerprint) {
            return syncedFingerprint !== null && fingerprint === syncedFingerprint;
        },
    };
}
