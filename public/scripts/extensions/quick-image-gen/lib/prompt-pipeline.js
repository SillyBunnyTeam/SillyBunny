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

export function getPromptPipelineResult(state) {
    const positive = cleanText(state?.positive);
    if (!positive) throw new Error("Image prompt cannot be empty");
    return {
        prompt: positive,
        negative: String(state?.negative ?? "").trim(),
        finalPromptEdited: Boolean(state?.finalPromptEdited),
    };
}
