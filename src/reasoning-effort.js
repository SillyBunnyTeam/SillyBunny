/**
 * SillyBunny: canonical reasoning-effort vocabulary and request normalization.
 *
 * Deliberately import-free. Every per-provider lookup table in the codebase is keyed on the
 * exact lowercase strings below, so a value that reaches a provider with different casing
 * misses every table silently. Keeping this a leaf module lets both prompt-converters.js and
 * the chat-completions backend share it without any risk of an import cycle.
 */

export const REASONING_EFFORT = {
    // 'auto' kept for backward-compat: backend may receive it from non-migrated external callers
    auto: 'auto',
    none: 'none',
    low: 'low',
    medium: 'medium',
    high: 'high',
    min: 'min',
    max: 'max',
    xhigh: 'xhigh',
};

/**
 * Normalizes a reasoning effort value to the casing every provider table expects.
 * Only canonical values are case-folded. An unrecognized value belongs to a custom endpoint
 * whose vocabulary this fork does not own, and JSON enums are case-sensitive, so it is passed
 * on with its original casing rather than lowercased into something the provider may reject.
 * @param {unknown} value Raw reasoning effort.
 * @returns {string} Normalized value, or an empty string when there is nothing usable.
 */
export function normalizeReasoningEffort(value) {
    if (typeof value !== 'string') {
        return '';
    }

    const trimmed = value.trim();

    if (!trimmed) {
        return '';
    }

    const canonical = trimmed.toLowerCase();

    return isKnownReasoningEffort(canonical) ? canonical : trimmed;
}

/**
 * Reports whether a normalized value is one this fork knows about.
 * @param {string} value Normalized reasoning effort.
 * @returns {boolean} True when the value is a canonical effort.
 */
export function isKnownReasoningEffort(value) {
    // Object.hasOwn, not a bare index: 'constructor' and 'toString' would otherwise resolve
    // through the prototype and report as known.
    return Object.hasOwn(REASONING_EFFORT, value);
}

/**
 * Normalizes `reasoning_effort` on an outgoing chat completion request body, in place.
 * Never adds the field when it is absent, and never touches a non-string value.
 * @param {any} requestBody Chat completion request body.
 * @returns {void}
 */
export function applyReasoningEffortNormalization(requestBody) {
    if (!requestBody || typeof requestBody !== 'object') {
        return;
    }

    if (typeof requestBody.reasoning_effort !== 'string') {
        return;
    }

    const original = requestBody.reasoning_effort;
    const normalized = normalizeReasoningEffort(original);

    if (!normalized) {
        // Several provider branches assign this key unconditionally, so an empty string would
        // ship as `"reasoning_effort": ""`. Removing it lets those branches omit the field.
        delete requestBody.reasoning_effort;
        return;
    }

    if (normalized !== original) {
        console.debug(`[ReasoningEffort] normalized ${JSON.stringify(original)} to ${JSON.stringify(normalized)}`);
    }

    if (!isKnownReasoningEffort(normalized)) {
        console.warn(`[ReasoningEffort] forwarding unrecognized value ${JSON.stringify(normalized)}; provider may reject it.`);
    }

    requestBody.reasoning_effort = normalized;
}
