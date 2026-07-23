export function snapshotGenerationSettings(settings) {
    if (typeof structuredClone === "function") return structuredClone(settings || {});
    return JSON.parse(JSON.stringify(settings || {}));
}

export class GenerationRunManager {
    #nextId = 1;
    #active = null;

    get active() {
        return this.#active;
    }

    start(settings, context = {}) {
        if (this.#active) throw new Error("A generation run is already active");
        const controller = new AbortController();
        const run = Object.freeze({
            id: this.#nextId++,
            settings: snapshotGenerationSettings(settings),
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
