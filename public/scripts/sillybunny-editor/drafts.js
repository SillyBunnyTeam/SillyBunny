// SillyBunny: shared draft storage for explicit-save editors. Owns the
// localStorage envelope ({ v: 1, ts, snapshot }) and its parsing; timing,
// recovery UI, and key strategy belong to the session and each editor.

/**
 * @typedef {object} EditorDraft
 * @property {number} v  Envelope version
 * @property {number} ts  Unix timestamp (ms) when the draft was written
 * @property {Record<string, unknown>} snapshot  Editor snapshot
 */

/**
 * @param {object} config
 * @param {(entityId: string) => string} config.keyFor  Storage key for an entity.
 * @param {Storage} [config.storage]  Defaults to localStorage, resolved per call:
 *     merely reading window.localStorage throws when storage is denied.
 * @param {() => number} [config.now]
 */
export function createEditorDraftStore(config) {
    const { keyFor, now = Date.now } = config;
    const getStorage = () => config.storage ?? globalThis.localStorage;

    /**
     * @param {string} entityId
     * @returns {EditorDraft|null}  null when absent, unreadable, or malformed
     */
    function read(entityId) {
        let draft;
        try {
            const raw = getStorage().getItem(keyFor(entityId));
            if (!raw) return null;
            draft = JSON.parse(raw);
        } catch {
            return null;
        }
        if (!draft?.v) return null;
        const { snapshot } = draft;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
        return draft;
    }

    /**
     * @param {string} entityId
     * @param {object} snapshot
     */
    function write(entityId, snapshot) {
        try {
            getStorage().setItem(keyFor(entityId), JSON.stringify({ v: 1, ts: now(), snapshot }));
        } catch (error) {
            console.warn('[sb-editor] Failed to write draft', error);
        }
    }

    /** @param {string} entityId */
    function remove(entityId) {
        try {
            getStorage().removeItem(keyFor(entityId));
        } catch (error) {
            console.warn('[sb-editor] Failed to remove draft', error);
        }
    }

    return { read, write, remove };
}
