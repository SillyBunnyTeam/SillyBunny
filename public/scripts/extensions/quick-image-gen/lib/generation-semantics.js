const REFERENCE_ARRAY_FIELDS = Object.freeze({
    proxy: "proxyRefImages",
    custom: "customApiRefImages",
    nanobanana: "nanobananaRefImages",
    nanogpt: "nanogptRefImages",
});

export const DEFAULT_REGENERATION_REFERENCE_RESULT_LIMIT = 50;
export const DEFAULT_REGENERATION_REFERENCE_CHAR_LIMIT = 96 * 1024 * 1024;

function copyStringArray(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

export function captureRegenerationReferences(settings = {}, runtimeOptions = {}) {
    const provider = typeof settings?.provider === "string" ? settings.provider : "";
    const referenceSettings = {};
    const referenceRuntimeOptions = {};
    const arrayField = REFERENCE_ARRAY_FIELDS[provider];

    if (arrayField) referenceSettings[arrayField] = copyStringArray(settings[arrayField]);
    if (provider === "proxy") {
        referenceRuntimeOptions.proxyRefImages = copyStringArray(runtimeOptions?.proxyRefImages);
    } else if (provider === "local") {
        referenceSettings.localRefImage = typeof settings.localRefImage === "string" ? settings.localRefImage : "";
        referenceSettings.a1111ControlNetImage = typeof settings.a1111ControlNetImage === "string"
            ? settings.a1111ControlNetImage
            : "";
    }

    return {
        provider,
        settings: referenceSettings,
        runtimeOptions: referenceRuntimeOptions,
    };
}

function cloneReferenceSnapshot(snapshot) {
    return captureRegenerationReferences({
        provider: snapshot?.provider,
        ...(snapshot?.settings || {}),
    }, snapshot?.runtimeOptions || {});
}

function countReferenceChars(snapshot) {
    let count = 0;
    for (const value of Object.values(snapshot?.settings || {})) {
        if (typeof value === "string") count += value.length;
        else if (Array.isArray(value)) count += value.reduce((total, item) => total + item.length, 0);
    }
    for (const value of Object.values(snapshot?.runtimeOptions || {})) {
        if (typeof value === "string") count += value.length;
        else if (Array.isArray(value)) count += value.reduce((total, item) => total + item.length, 0);
    }
    return count;
}

function getResultIdentity(entry) {
    return JSON.stringify([
        entry?.provider || "",
        entry?.sourceChatId || "",
        Number.isSafeInteger(entry?.sourceMessageIndex) ? entry.sourceMessageIndex : null,
        entry?.sourceMessageId || "",
        entry?.sourceMessageSignature || "",
    ]);
}

export class RegenerationReferenceStore {
    #maxResults;
    #maxReferenceChars;
    #groups = new Map();
    #entries = new Map();
    #entryOrder = new Map();
    #totalReferenceChars = 0;
    #nextGroupId = 1;
    #activeGroupKey = "";

    constructor({
        maxResults = DEFAULT_REGENERATION_REFERENCE_RESULT_LIMIT,
        maxReferenceChars = DEFAULT_REGENERATION_REFERENCE_CHAR_LIMIT,
    } = {}) {
        this.#maxResults = Number.isSafeInteger(maxResults) && maxResults > 0
            ? maxResults
            : DEFAULT_REGENERATION_REFERENCE_RESULT_LIMIT;
        this.#maxReferenceChars = Number.isSafeInteger(maxReferenceChars) && maxReferenceChars >= 0
            ? maxReferenceChars
            : DEFAULT_REGENERATION_REFERENCE_CHAR_LIMIT;
    }

    get size() {
        return this.#entries.size;
    }

    remember(entries, references, { scopeId = "", groupId } = {}) {
        const results = (Array.isArray(entries) ? entries : [entries])
            .filter(entry => entry && typeof entry.id === "string" && entry.id);
        if (!results.length) return { remembered: false, referencesRetained: false };

        const normalizedScopeId = String(scopeId || "");
        const normalizedGroupId = groupId == null ? `auto-${this.#nextGroupId++}` : String(groupId);
        const key = `${normalizedScopeId}\u0000${normalizedGroupId}`;
        if (this.#activeGroupKey && this.#activeGroupKey !== key) this.clear();
        this.#activeGroupKey = key;
        let record = this.#groups.get(key);
        if (!record) {
            const snapshot = cloneReferenceSnapshot(references);
            const referenceChars = countReferenceChars(snapshot);
            const referencesRetained = referenceChars <= this.#maxReferenceChars;
            record = {
                key,
                scopeId: normalizedScopeId,
                references: referencesRetained ? snapshot : null,
                referencesRetained,
                referenceChars: referencesRetained ? referenceChars : 0,
                entryIds: new Set(),
            };
            this.#groups.set(key, record);
            this.#totalReferenceChars += record.referenceChars;
        }

        for (const entry of results) {
            const existing = this.#entries.get(entry.id);
            if (existing?.record === record) {
                record.entryIds.delete(entry.id);
                this.#entryOrder.delete(entry.id);
            } else {
                this.#removeEntry(entry.id);
            }
            record.entryIds.add(entry.id);
            this.#entries.set(entry.id, {
                record,
                identity: getResultIdentity(entry),
            });
            this.#entryOrder.set(entry.id, true);
        }
        this.#enforceBounds();
        return {
            remembered: results.some(entry => this.#entries.has(entry.id)),
            referencesRetained: record.referencesRetained,
        };
    }

    lookup(entry, { scopeId = "" } = {}) {
        const link = this.#getLink(entry, scopeId);
        if (!link) {
            return { found: false, referencesRetained: false, references: null };
        }
        return {
            found: true,
            referencesRetained: link.record.referencesRetained,
            references: link.record.references ? cloneReferenceSnapshot(link.record.references) : null,
        };
    }

    activate(entry, { scopeId = "" } = {}) {
        if (this.#getLink(entry, scopeId)) return true;
        this.clear();
        return false;
    }

    clear() {
        this.#groups.clear();
        this.#entries.clear();
        this.#entryOrder.clear();
        this.#totalReferenceChars = 0;
        this.#activeGroupKey = "";
    }

    #getLink(entry, scopeId) {
        const id = typeof entry?.id === "string" ? entry.id : "";
        const link = id ? this.#entries.get(id) : null;
        return link
            && link.record.scopeId === String(scopeId || "")
            && link.identity === getResultIdentity(entry)
            ? link
            : null;
    }

    #removeEntry(id) {
        const link = this.#entries.get(id);
        if (!link) return;
        this.#entries.delete(id);
        this.#entryOrder.delete(id);
        link.record.entryIds.delete(id);
        if (!link.record.entryIds.size) this.#removeGroup(link.record);
    }

    #removeGroup(record) {
        if (!this.#groups.delete(record.key)) return;
        if (this.#activeGroupKey === record.key) this.#activeGroupKey = "";
        this.#totalReferenceChars -= record.referenceChars;
        for (const id of record.entryIds) {
            const link = this.#entries.get(id);
            if (link?.record === record) {
                this.#entries.delete(id);
                this.#entryOrder.delete(id);
            }
        }
        record.entryIds.clear();
    }

    #enforceBounds() {
        while (this.#entries.size > this.#maxResults) {
            const oldestId = this.#entryOrder.keys().next().value;
            if (!oldestId) break;
            this.#removeEntry(oldestId);
        }
        while (this.#totalReferenceChars > this.#maxReferenceChars) {
            const oldestRetained = [...this.#groups.values()].find(record => record.referenceChars > 0);
            if (!oldestRetained) break;
            this.#removeGroup(oldestRetained);
        }
    }
}

export function parseContextualFilterSelection(value, filterCount) {
    const count = Number(filterCount);
    if (!Number.isSafeInteger(count) || count < 0 || typeof value !== "string") return null;
    const response = value.trim();
    if (/^none$/i.test(response)) return [];
    if (!/^\d+(?:\s*,\s*\d+)*$/.test(response)) return null;

    const selected = response.split(",").map(part => Number(part.trim()));
    const unique = new Set(selected);
    if (unique.size !== selected.length || selected.some(index => index < 1 || index > count)) return null;
    return selected;
}

export function normalizeInjectInsertMode(value) {
    return value === "new" ? "new" : "replace";
}

export function shouldCleanInjectSourceTags(insertMode, autoClean) {
    return normalizeInjectInsertMode(insertMode) === "replace" || autoClean !== false;
}
