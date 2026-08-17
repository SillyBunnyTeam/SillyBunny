function cleanText(value) {
    return String(value ?? "").trim();
}

export function appendWorldInfoToRequest(request, worldInfoText) {
    const base = cleanText(request);
    const lore = cleanText(worldInfoText);
    if (!lore) return base;
    return [
        base,
        "QIG MATCHED WORLD INFO (editable context; use only when relevant):",
        lore,
    ].filter(Boolean).join("\n\n");
}

export function createPromptPipelineState({
    sourceText = "",
    worldInfoText = "",
    negative = "",
} = {}) {
    return {
        sourceText: cleanText(sourceText),
        worldInfoText: cleanText(worldInfoText),
        summaryRequest: "",
        summaryResult: "",
        promptRequest: "",
        promptResult: "",
        positive: "",
        negative: cleanText(negative),
        finalPromptEdited: false,
    };
}

export function updatePromptPipelineState(state, patch = {}) {
    const current = state && typeof state === "object" ? state : createPromptPipelineState();
    const next = { ...current };
    for (const key of [
        "sourceText",
        "worldInfoText",
        "summaryRequest",
        "summaryResult",
        "promptRequest",
        "promptResult",
        "positive",
        "negative",
    ]) {
        if (Object.hasOwn(patch, key)) next[key] = String(patch[key] ?? "");
    }
    if (Object.hasOwn(patch, "finalPromptEdited")) {
        next.finalPromptEdited = Boolean(patch.finalPromptEdited);
    }
    return next;
}

export function setAuthoritativeFinalPrompt(state, { positive, negative } = {}) {
    const nextPositive = cleanText(positive);
    if (!nextPositive) throw new Error("Image prompt cannot be empty");
    return updatePromptPipelineState(state, {
        positive: nextPositive,
        negative: String(negative ?? "").trim(),
        finalPromptEdited: true,
    });
}

// Style prompts, quality tags, ST Style, and the user's own lists overlap heavily; exact
// repeats waste tokens and skew tag weighting, so keep only the first occurrence of each
// comma-separated segment. Weighted variants like "(masterpiece:1.2)" are distinct and kept.
//
// Only tag-like segments are deduplicated. A tag is a short noun phrase; built-in tags run to
// three words. Longer segments are clauses of prose (a description, or the user's own scene
// text) where a repeat may be deliberate, so those pass through in place. Multi-line prompts
// are left entirely alone: re-joining would flatten the author's line breaks.
const MAX_TAG_SEGMENT_WORDS = 4;
const PROSE_CLAUSE_START = /^(?:a|an|the|she|he|it|they|we|i|you|her|his|him|my|our|their|your|this|that|those|these)\b/i;

export function isTagSegment(segment) {
    const part = String(segment ?? "").trim();
    if (part.length === 0 || part.split(/\s+/).length > MAX_TAG_SEGMENT_WORDS) return false;
    // Short clauses that begin like prose ("A bell rings", "She turns") are sentences,
    // not tags; repeating them may be deliberate and must never be deduplicated.
    return !PROSE_CLAUSE_START.test(part);
}

export function looksLikeTagList(text) {
    const value = String(text ?? "");
    if (!value.trim() || value.includes("\n")) return false;
    const segments = value.split(",").map(part => part.trim()).filter(Boolean);
    return segments.length > 1 && segments.every(isTagSegment);
}

export function dedupePromptTags(text) {
    const value = String(text ?? "");
    if (!value.trim() || value.includes("\n")) return value;
    const segments = value.split(",").map(part => part.trim()).filter(Boolean);
    if (segments.length < 2) return value;
    const seen = new Set();
    const parts = [];
    for (const part of segments) {
        if (isTagSegment(part)) {
            const key = part.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
        }
        parts.push(part);
    }
    return parts.join(", ");
}

export function getPromptPipelineResult(state) {
    const positive = cleanText(state?.positive);
    if (!positive) throw new Error("Image prompt cannot be empty");
    return {
        prompt: positive,
        negative: String(state?.negative ?? "").trim(),
        finalPromptEdited: Boolean(state?.finalPromptEdited),
    };
}
