/**
 * Positive acknowledgement for SillyTavern host persistence.
 *
 * The host's `saveSettings()` / `saveChat()` promises fulfill with `undefined`
 * on both HTTP success and common failures (errors are caught internally), so
 * resolving the promise is not a commit acknowledgement. These helpers give
 * QIG the smallest positive signals the host actually offers:
 *
 * - `confirmSettingsSyncCacheId`: bounded readback of `/api/settings/get`
 *   (SillyTavern >= 1.14.0) to prove a generated account identity reached the
 *   server.
 * - `createSettingsSaveEventConfirmer`: one-shot correlation with the host's
 *   `SETTINGS_UPDATED` event, which the host emits only after an HTTP 2xx save.
 */

export async function confirmSettingsSyncCacheId({
    fetchImpl = null,
    getRequestHeaders = null,
    settingsKey,
    expectedSyncCacheId,
    timeoutMs = 5000,
}) {
    if (typeof expectedSyncCacheId !== "string" || !expectedSyncCacheId) return false;
    if (typeof fetchImpl !== "function") return false;
    try {
        const headers = typeof getRequestHeaders === "function" ? getRequestHeaders() : {};
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl("/api/settings/get", {
                method: "GET",
                headers,
                signal: controller.signal,
            });
            if (!response?.ok) return false;
            const payload = await response.json();
            const candidates = [payload?.settings, payload];
            for (const candidate of candidates) {
                if (!candidate || typeof candidate !== "object") continue;
                const entry = candidate[settingsKey];
                if (entry && typeof entry === "object" && entry._syncCacheId === expectedSyncCacheId) {
                    return true;
                }
            }
            return JSON.stringify(payload ?? "").includes(expectedSyncCacheId);
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return false;
    }
}

export function createSettingsSaveEventConfirmer({ eventSource = null, eventTypes = null, timeoutMs = 2500 }) {
    return () => new Promise((resolve) => {
        const type = eventTypes?.SETTINGS_UPDATED;
        if (!eventSource || typeof eventSource.on !== "function" || !type) {
            resolve(null);
            return;
        }

        let settled = false;
        let unsubscribe = null;
        let timer = null;

        const off = () => {
            if (typeof unsubscribe === "function") unsubscribe();
            else if (typeof eventSource.off === "function") eventSource.off(type, handler);
            else if (typeof eventSource.removeListener === "function") eventSource.removeListener(type, handler);
        };
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            off();
            resolve(value);
        };
        const handler = () => finish(true);
        timer = setTimeout(() => finish(false), timeoutMs);

        try {
            unsubscribe = eventSource.on(type, handler);
        } catch {
            off();
            finish(null);
        }
    });
}
