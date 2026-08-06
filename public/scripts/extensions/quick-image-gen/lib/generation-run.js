export function snapshotGenerationSettings(settings) {
    if (typeof structuredClone === "function") return structuredClone(settings || {});
    return JSON.parse(JSON.stringify(settings || {}));
}

const NON_GENERATION_SETTING_KEYS = new Set(["_syncCacheId", "_charSettingsBaseState"]);

export function snapshotGenerationRunSettings(settings) {
    const source = settings && typeof settings === "object" ? settings : {};
    const generationSettings = {};
    for (const key of Object.keys(source)) {
        if (key.startsWith("_backup") || NON_GENERATION_SETTING_KEYS.has(key)) continue;
        generationSettings[key] = source[key];
    }
    return snapshotGenerationSettings(generationSettings);
}

export class OwnedTransientValue {
    #current = null;

    get current() {
        return this.#current;
    }

    set(value) {
        const owned = Object.freeze({ value });
        this.#current = owned;
        return owned;
    }

    clear(expected = null) {
        if (expected && this.#current !== expected) return false;
        this.#current = null;
        return true;
    }

    async withValue(value, task) {
        const previous = this.#current;
        const owned = this.set(value);
        try {
            return await task(value);
        } finally {
            if (this.#current === owned) this.#current = previous;
        }
    }
}

export class GenerationRunManager {
    #nextId = 1;
    #active = null;

    get active() {
        return this.#active;
    }

    start(settings, context = {}, { settingsSnapshot = false } = {}) {
        if (this.#active) throw new Error("A generation run is already active");
        const controller = new AbortController();
        const run = Object.freeze({
            id: this.#nextId++,
            settings: settingsSnapshot ? settings : snapshotGenerationSettings(settings),
            controller,
            signal: controller.signal,
            context: Object.freeze({ ...context }),
        });
        this.#active = run;
        return run;
    }

    cancel(reason = "Generation cancelled") {
        const run = this.#active;
        if (!run || run.signal.aborted) return false;
        run.controller.abort(new DOMException(reason, "AbortError"));
        return true;
    }

    cancelAndRelease(reason = "Generation cancelled") {
        const run = this.#active;
        if (!run) return null;
        this.#active = null;
        if (!run.signal.aborted) run.controller.abort(new DOMException(reason, "AbortError"));
        return run;
    }

    finish(run) {
        if (!run || this.#active !== run) return false;
        this.#active = null;
        return true;
    }

    assertActive(run) {
        if (!run || this.#active !== run || run.signal.aborted) {
            const reason = run?.signal?.reason;
            if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
            throw new DOMException("Generation run is no longer active", "AbortError");
        }
    }
}
