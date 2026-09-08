import { createAbortDeadline } from "./network-runtime.js";
import { readResponseJson } from "./security.js";

// ST 1.14 saves resolve undefined even on failure. Read the persisted target,
// never a global event or the in-memory settings, to confirm those saves.
async function readHostPersistenceJson(url, body, {
    fetchImpl = null,
    getRequestHeaders = null,
    timeoutMs = 5000,
    maxBytes,
}) {
    if (typeof fetchImpl !== "function") return null;
    const deadline = createAbortDeadline(null, timeoutMs);
    try {
        const headers = typeof getRequestHeaders === "function" ? getRequestHeaders() : {};
        const response = await fetchImpl(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            cache: "no-store",
            signal: deadline.signal,
        });
        if (!response?.ok) return null;
        return await readResponseJson(response, maxBytes);
    } catch {
        return null;
    } finally {
        deadline.dispose();
    }
}

export async function confirmSettingsValues({ settingsKey, expectedValues, ...options }) {
    if (!settingsKey || !expectedValues || !Object.keys(expectedValues).length) return false;
    const payload = await readHostPersistenceJson("/api/settings/get", {}, options);
    try {
        const settings = typeof payload?.settings === "string" ? JSON.parse(payload.settings) : payload?.settings;
        const entry = settings?.extension_settings?.[settingsKey];
        return !!entry && Object.entries(expectedValues).every(([key, value]) =>
            JSON.stringify(entry[key]) === JSON.stringify(value));
    } catch {
        return false;
    }
}

export function confirmSettingsSyncCacheId({ expectedSyncCacheId, ...options }) {
    if (typeof expectedSyncCacheId !== "string" || !expectedSyncCacheId) return Promise.resolve(false);
    return confirmSettingsValues({ ...options, expectedValues: { _syncCacheId: expectedSyncCacheId } });
}

export function createChatSaveConfirmer({ context, metadataOnly = false, ...options }) {
    const chatId = context?.chatId ?? context?.getCurrentChatId?.();
    const groupId = context?.groupId;
    const character = context?.characters?.[context?.characterId];
    const avatar = character?.avatar;
    const name = character?.name;
    // SillyBunny divergence: both chat types use headers; exclude only the
    // host's rotating top-level integrity token when confirming metadata.
    const serializeMetadata = value => value && typeof value === "object" && !Array.isArray(value)
        ? JSON.stringify({ ...value, integrity: undefined })
        : null;
    const expected = metadataOnly ? serializeMetadata(context?.chatMetadata) : JSON.stringify(context?.chat);
    if (typeof chatId !== "string" || !chatId || !expected || (!groupId && !avatar)) return async () => false;
    const contents = metadataOnly ? JSON.stringify(context?.chat) : expected;
    const metadata = JSON.stringify(context?.chatMetadata);
    const encoder = new TextEncoder();
    const readOptions = {
        ...options,
        // One MiB of header/envelope slack, not a provider-response size limit.
        maxBytes: encoder.encode(contents || "").byteLength + encoder.encode(metadata || "").byteLength + 1024 * 1024,
    };

    return async () => {
        const payload = await readHostPersistenceJson(
            groupId ? "/api/chats/group/get" : "/api/chats/get",
            groupId ? { id: chatId } : { ch_name: name, file_name: chatId, avatar_url: avatar },
            readOptions,
        );
        if (!Array.isArray(payload)) return false;
        const savedMetadata = serializeMetadata(payload[0]?.chat_metadata);
        if (!savedMetadata) return false;
        return (metadataOnly ? savedMetadata : JSON.stringify(payload.slice(1))) === expected;
    };
}

export function createSettingsSaveEventConfirmer({ eventSource = null, eventTypes = null, confirm = null, timeoutMs = 2500 }) {
    return () => {
        let cancel = () => {};
        const confirmation = new Promise((resolve) => {
            const type = eventTypes?.SETTINGS_UPDATED;
            if (!eventSource || typeof eventSource.on !== "function" || !type || typeof confirm !== "function") {
                resolve(null);
                return;
            }

            let settled = false;
            let unsubscribe = null;
            let timer = null;

            const off = () => {
                try {
                    if (typeof unsubscribe === "function") unsubscribe();
                    else if (typeof eventSource.off === "function") eventSource.off(type, handler);
                    else if (typeof eventSource.removeListener === "function") eventSource.removeListener(type, handler);
                } catch { /* host teardown may already have removed the listener */ }
            };
            const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                off();
                resolve(value);
            };
            const handler = () => {
                // SETTINGS_UPDATED has no payload and may belong to another save.
                void Promise.resolve().then(() => settled ? false : confirm()).then(value => {
                    if (value === true) finish(true);
                }, () => {});
            };
            cancel = () => finish(false);
            timer = setTimeout(() => finish(false), timeoutMs);

            try {
                unsubscribe = eventSource.on(type, handler);
            } catch {
                finish(null);
            }
        });
        confirmation.cancel = () => cancel();
        confirmation.confirmAfterSave = async () => {
            cancel();
            // A slow save can outlast observation, and early evidence can become stale.
            return typeof confirm === "function" && await confirm() === true;
        };
        return confirmation;
    };
}
