function cleanPromptPart(value) {
    return typeof value === "string" ? value.trim().replace(/^,\s*|\s*,$/g, "") : "";
}

function joinPromptParts(...values) {
    return values.map(cleanPromptPart).filter(Boolean).join(", ");
}

function getMappedPrompt(map, key, property = null) {
    if (!map || !key) return "";
    const value = map[key];
    if (typeof value === "string") return cleanPromptPart(value);
    if (property && value && typeof value === "object") return cleanPromptPart(value[property]);
    return "";
}

export function resolveSTStyleSettings(sdSettings, context = {}) {
    const result = {
        prefix: cleanPromptPart(sdSettings?.prompt_prefix),
        negative: cleanPromptPart(sdSettings?.negative_prompt),
        charPositive: "",
        charNegative: "",
    };
    if (!sdSettings || context?.groupId != null || context?.characterId == null) return result;

    const character = context?.characters?.[context.characterId];
    if (!character) return result;

    const avatar = typeof character.avatar === "string" ? character.avatar : "";
    const avatarStem = avatar.replace(/\.[^/.]+$/, "");
    const displayName = String(character.name || context?.name2 || "").trim();
    const shared = character?.data?.extensions?.sd_character_prompt;

    result.charPositive = getMappedPrompt(sdSettings.character_prompts, avatarStem, "positive");
    result.charNegative = getMappedPrompt(sdSettings.character_negative_prompts, avatarStem);

    if (!result.charNegative) {
        result.charNegative = getMappedPrompt(sdSettings.character_prompts, avatarStem, "negative");
    }
    if (!result.charPositive) result.charPositive = cleanPromptPart(shared?.positive);
    if (!result.charNegative) result.charNegative = cleanPromptPart(shared?.negative);

    // Older QIG versions looked up ST-owned maps by display name rather than avatar stem.
    if (!result.charPositive) {
        result.charPositive = getMappedPrompt(sdSettings.character_prompts, displayName, "positive");
    }
    if (!result.charNegative) {
        result.charNegative = getMappedPrompt(sdSettings.character_negative_prompts, displayName)
            || getMappedPrompt(sdSettings.character_prompts, displayName, "negative");
    }

    return result;
}

export function mergeSTStylePrompts(prompt, negative, style, resolveMacros = value => value) {
    const positivePrefix = joinPromptParts(style?.prefix, style?.charPositive);
    const generatedPrompt = cleanPromptPart(prompt);
    let mergedPrompt;
    if (positivePrefix.includes("{prompt}")) {
        mergedPrompt = positivePrefix.replace("{prompt}", generatedPrompt);
    } else {
        mergedPrompt = joinPromptParts(positivePrefix, generatedPrompt);
    }

    const negativePrefix = joinPromptParts(style?.negative, style?.charNegative);
    const mergedNegative = joinPromptParts(negative, negativePrefix);
    return {
        prompt: cleanPromptPart(resolveMacros(mergedPrompt)),
        negative: cleanPromptPart(resolveMacros(mergedNegative)),
    };
}
