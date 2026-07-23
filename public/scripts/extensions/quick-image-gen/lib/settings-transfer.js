import { redactUrlCredentials } from "./security.js";

export const SETTINGS_TRANSFER_VERSION = 7;
export const MAX_SETTINGS_IMPORT_BYTES = 10 * 1024 * 1024;

const MAX_DEPTH = 16;
const MAX_NODES = 25_000;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_OBJECT_KEYS = 2_000;
const MAX_STRING_BYTES = 2 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PRIVATE_FIELD = /(?:ApiKey|Key|Token|Secret|Password|RefImages?|RefImage|ControlNetImage|LocalRefImage|ImageBase64)$/;
const KNOWN_PRIVATE_FIELD = /^(?:apiKey|key|token|secret|password|(?:proxy|nai|gptImage|pollinations|arli|routeway|navy|nanoGpt|chutes|civitai|nanobanana|stability|replicate|fal|together|zai|gemini|comfy)(?:Proxy|Api)?Key)$/i;
const DELIMITED_PRIVATE_FIELD = /^(?:api[_-]?key|access[_-]?token|auth|authorization|token|secret|password|passwd)$/i;
const TRUSTED_ENDPOINT_FIELD = /(?:Url|Endpoint)$/;
const CUSTOM_API_FIELD = /^customApi/;
const CONTEXT_MEDIA_PRIVATE_FIELD = /^(?:base64|binary|binaryData|blob|buffer|bytes?|content|data|file|fileName|filePath|href|imageData|localMediaRef|localRef|mediaData|mediaIds?|mediaRef|mime|mimeType|path|payload|serverPath|src|storageKey|uri|url)$|(?:Uri|Url)$/i;
const CONTEXT_MEDIA_PRIVATE_STRING = /(?:\b(?:blob|data|file|https?):|^(?:[A-Za-z][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9!#$&^_.+-]+$|\/|\\|\.\.?(?:\/|\\)|~(?:\/|\\)|[A-Za-z]:[\\/]))/i;

const STORE_SHAPES = Object.freeze({
    connectionProfiles: "object",
    comfyWorkflows: "array",
    generationPresets: "array",
    charSettings: "object",
    charRefImages: "object",
    contextualFilters: "array",
    filterPools: "array",
    activeFilterPoolIdsGlobal: "array",
    activeFilterPoolIdsByCard: "object",
    activeFilterPoolIdsByChar: "object",
    promptReplacements: "array",
    contextMedia: "object",
});

const EXPORTED_STORE_NAMES = Object.freeze(Object.keys(STORE_SHAPES).filter((name) =>
    name !== "charRefImages" && name !== "promptReplacements"
));

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
    return new TextEncoder().encode(value).byteLength;
}

function isPrivateField(key) {
    if (/cardkey$/i.test(key)) return false;
    return key.startsWith("_backup") || CUSTOM_API_FIELD.test(key) || PRIVATE_FIELD.test(key) || KNOWN_PRIVATE_FIELD.test(key) || DELIMITED_PRIVATE_FIELD.test(key);
}

function isLocalTrustField(key) {
    return CUSTOM_API_FIELD.test(key) || isPrivateField(key) || TRUSTED_ENDPOINT_FIELD.test(key) || key === "url" || key === "endpoint";
}

function isStructuredSettingsField(key) {
    return /workflow/i.test(key) || key === "customApiRequestTemplate";
}

function sanitizeForExport(value, key = "", seen = new WeakSet(), depth = 0) {
    if (isPrivateField(key) || depth > MAX_DEPTH) return undefined;
    if (value == null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "string") {
        if (/^(?:data:image\/|blob:)/i.test(value)) return undefined;
        if (isStructuredSettingsField(key) && /^\s*[\[{]/.test(value)) {
            try {
                const parsed = JSON.parse(value);
                const sanitized = sanitizeForExport(parsed, key, seen, depth + 1);
                return sanitized === undefined ? undefined : JSON.stringify(sanitized);
            } catch {
                if (/["'](?:api[_-]?key|access[_-]?token|auth|authorization|token|secret|password|passwd)["']\s*:/i.test(value)) {
                    return undefined;
                }
            }
        }
        return byteLength(value) <= MAX_STRING_BYTES ? redactUrlCredentials(value) : undefined;
    }
    if (typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_ITEMS)
            .map((item) => sanitizeForExport(item, key, seen, depth + 1))
            .filter((item) => item !== undefined);
    }
    if (!isPlainObject(value)) return undefined;

    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
        if (FORBIDDEN_KEYS.has(childKey)) continue;
        const sanitized = sanitizeForExport(childValue, childKey, seen, depth + 1);
        if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
}

function sanitizeContextMedia(value, key = "", depth = 0) {
    if (depth > MAX_DEPTH) return undefined;
    if (key === "chatMap") return {};
    if (key.toLowerCase() === "media") return Array.isArray(value) ? [] : undefined;
    if (CONTEXT_MEDIA_PRIVATE_FIELD.test(key)) return undefined;
    if (typeof value === "string" && CONTEXT_MEDIA_PRIVATE_STRING.test(value)) return undefined;
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeContextMedia(item, key, depth + 1))
            .filter((item) => item !== undefined);
    }
    if (!isPlainObject(value)) return value;
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
        const sanitized = sanitizeContextMedia(childValue, childKey, depth + 1);
        if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
}

function cloneValidated(value, path, state, depth = 0) {
    if (depth > MAX_DEPTH) throw new Error(`${path} is nested too deeply`);
    state.nodes += 1;
    if (state.nodes > MAX_NODES) throw new Error("Settings file contains too many values");

    if (value == null || typeof value === "boolean" || typeof value === "string") {
        if (typeof value === "string" && byteLength(value) > MAX_STRING_BYTES) {
            throw new Error(`${path} contains an oversized string`);
        }
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error(`${path} contains an invalid number`);
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY_ITEMS) throw new Error(`${path} contains too many items`);
        return value.map((item, index) => cloneValidated(item, `${path}[${index}]`, state, depth + 1));
    }
    if (!isPlainObject(value)) throw new Error(`${path} must contain JSON values only`);

    const entries = Object.entries(value);
    if (entries.length > MAX_OBJECT_KEYS) throw new Error(`${path} contains too many fields`);
    const result = {};
    for (const [childKey, childValue] of entries) {
        if (FORBIDDEN_KEYS.has(childKey)) throw new Error(`${path} contains forbidden field ${childKey}`);
        result[childKey] = cloneValidated(childValue, `${path}.${childKey}`, state, depth + 1);
    }
    return result;
}

function assertShape(value, shape, name) {
    if (shape === "array" && !Array.isArray(value)) throw new Error(`${name} must be an array`);
    if (shape === "object" && !isPlainObject(value)) throw new Error(`${name} must be an object`);
}

function createDefaultId(prefix) {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRecordIds(records, name, createId) {
    if (!Array.isArray(records)) return;
    const seen = new Set();
    for (const record of records) {
        if (!isPlainObject(record)) throw new Error(`${name} entries must be objects`);
        let id = typeof record.id === "string" ? record.id.trim() : "";
        if (!id) id = createId(name);
        if (!SAFE_ID.test(id)) throw new Error(`${name} contains an invalid ID`);
        if (seen.has(id)) throw new Error(`${name} contains duplicate ID ${id}`);
        seen.add(id);
        record.id = id;
    }
}

function validateIdList(value, path) {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    const seen = new Set();
    for (const idValue of value) {
        const id = typeof idValue === "string" ? idValue.trim() : "";
        if (!SAFE_ID.test(id)) throw new Error(`${path} contains an invalid ID`);
        if (seen.has(id)) throw new Error(`${path} contains duplicate ID ${id}`);
        seen.add(id);
    }
}

function validateIdMap(value, path) {
    if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
    for (const [scope, ids] of Object.entries(value)) validateIdList(ids, `${path}.${scope}`);
}

function removeImportedPrivateFields(value, key = "", depth = 0) {
    if (isLocalTrustField(key) || depth > MAX_DEPTH) return undefined;
    if (typeof value === "string" && /^(?:data:image\/|blob:)/i.test(value)) return undefined;
    if (typeof value === "string" && isStructuredSettingsField(key) && /^\s*[\[{]/.test(value)) {
        try {
            const parsed = JSON.parse(value);
            const sanitized = removeImportedPrivateFields(parsed, key, depth + 1);
            return sanitized === undefined ? undefined : JSON.stringify(sanitized);
        } catch {
            return undefined;
        }
    }
    if (Array.isArray(value)) {
        return value.map((item) => removeImportedPrivateFields(item, key, depth + 1))
            .filter((item) => item !== undefined);
    }
    if (!isPlainObject(value)) return value;
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
        if (childKey === "provider" && childValue === "custom") continue;
        const sanitized = removeImportedPrivateFields(childValue, childKey, depth + 1);
        if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
}

export function createSettingsExport(source, options = {}) {
    const payload = {
        version: SETTINGS_TRANSFER_VERSION,
        exportDate: (options.now || new Date()).toISOString(),
        privacy: {
            secrets: "omitted",
            privateImages: "omitted",
        },
        activeSettings: sanitizeForExport(source?.activeSettings || {}) || {},
    };
    for (const name of EXPORTED_STORE_NAMES) {
        let store = source?.[name];
        if (name === "connectionProfiles" && isPlainObject(store)) {
            store = Object.fromEntries(Object.entries(store).filter(([provider]) => provider !== "custom"));
        } else if (name === "generationPresets" && Array.isArray(store)) {
            store = store.filter(record => record?.provider !== "custom");
        }
        let sanitized = sanitizeForExport(store);
        if (name === "contextMedia" && sanitized !== undefined) sanitized = sanitizeContextMedia(sanitized);
        if (sanitized !== undefined) payload[name] = sanitized;
    }
    return payload;
}

export function parseSettingsImport(text, options = {}) {
    if (typeof text !== "string" || byteLength(text) > MAX_SETTINGS_IMPORT_BYTES) {
        throw new Error(`Settings files must be smaller than ${MAX_SETTINGS_IMPORT_BYTES / (1024 * 1024)} MiB`);
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("Settings file is not valid JSON");
    }
    if (!isPlainObject(parsed)) throw new Error("Settings file must contain an object");
    const version = Number(parsed.version);
    if (!Number.isInteger(version) || version < 5 || version > SETTINGS_TRANSFER_VERSION) {
        throw new Error(`Unsupported settings version: ${parsed.version ?? "missing"}`);
    }

    const result = {
        version: SETTINGS_TRANSFER_VERSION,
        sourceVersion: version,
        exportDate: typeof parsed.exportDate === "string" ? parsed.exportDate : null,
    };
    const state = { nodes: 0 };
    const createId = options.createId || createDefaultId;

    if (parsed.activeSettings !== undefined) {
        assertShape(parsed.activeSettings, "object", "activeSettings");
        const cloned = cloneValidated(parsed.activeSettings, "activeSettings", state);
        result.activeSettings = removeImportedPrivateFields(cloned) || {};
    }

    for (const [name, shape] of Object.entries(STORE_SHAPES)) {
        if (parsed[name] === undefined) continue;
        if (name === "charRefImages" && version >= 6) continue;
        assertShape(parsed[name], shape, name);
        let cloned = cloneValidated(parsed[name], name, state);
        if (name === "connectionProfiles" && isPlainObject(cloned)) delete cloned.custom;
        if (name === "generationPresets" && Array.isArray(cloned)) {
            cloned = cloned.filter(record => record?.provider !== "custom");
        }
        result[name] = name === "charRefImages"
            ? cloned
            : removeImportedPrivateFields(cloned) ?? (shape === "array" ? [] : {});
        if (name === "contextMedia") result[name] = sanitizeContextMedia(result[name]) || {};
    }

    normalizeRecordIds(result.comfyWorkflows, "comfyWorkflows", createId);
    normalizeRecordIds(result.generationPresets, "generationPresets", createId);
    normalizeRecordIds(result.contextualFilters, "contextualFilters", createId);
    normalizeRecordIds(result.filterPools, "filterPools", createId);
    if (result.activeFilterPoolIdsGlobal) validateIdList(result.activeFilterPoolIdsGlobal, "activeFilterPoolIdsGlobal");
    if (result.activeFilterPoolIdsByCard) validateIdMap(result.activeFilterPoolIdsByCard, "activeFilterPoolIdsByCard");
    if (result.activeFilterPoolIdsByChar) validateIdMap(result.activeFilterPoolIdsByChar, "activeFilterPoolIdsByChar");
    for (const [index, filter] of (result.contextualFilters || []).entries()) {
        if (filter.poolIds !== undefined) validateIdList(filter.poolIds, `contextualFilters[${index}].poolIds`);
    }
    return result;
}

export function mergePreservingPrivateFields(current, imported, key = "") {
    if (isLocalTrustField(key)) return current;
    if (Array.isArray(imported)) return imported.map((item) => mergePreservingPrivateFields(undefined, item, key));
    if (!isPlainObject(imported)) return imported;

    const result = {};
    for (const [childKey, childValue] of Object.entries(imported)) {
        result[childKey] = mergePreservingPrivateFields(current?.[childKey], childValue, childKey);
    }
    if (isPlainObject(current)) {
        for (const [childKey, childValue] of Object.entries(current)) {
            if (isLocalTrustField(childKey) && result[childKey] === undefined) result[childKey] = childValue;
        }
    }
    return result;
}

export function stageStorageTransaction(storage, updates) {
    const entries = updates instanceof Map ? [...updates.entries()] : Object.entries(updates || {});
    const previous = new Map(entries.map(([key]) => [key, storage.getItem(key)]));
    let active = true;

    const restore = () => {
        if (!active) return;
        const errors = [];
        for (const [key, value] of previous.entries()) {
            try {
                if (value == null) storage.removeItem(key);
                else storage.setItem(key, value);
            } catch (error) {
                errors.push(error);
                try {
                    storage.removeItem(key);
                } catch (removeError) {
                    errors.push(removeError);
                }
            }
        }
        active = false;
        if (errors.length) throw new AggregateError(errors, "Settings storage could not be fully rolled back");
    };

    try {
        for (const [key, value] of entries) storage.setItem(key, value);
    } catch (error) {
        try {
            restore();
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Settings storage failed and could not be fully rolled back");
        }
        throw new Error("Could not save imported settings. Browser storage may be full.", { cause: error });
    }

    return {
        commit() { active = false; },
        rollback: restore,
    };
}
