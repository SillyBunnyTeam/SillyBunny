'use strict';

function getTokenCount(item) {
    const tokenCount = Number(item?.getTokens?.() ?? 0);
    return Number.isFinite(tokenCount) ? tokenCount : 0;
}

function getCollection(item) {
    const collection = item?.getCollection?.();
    return Array.isArray(collection) ? collection : null;
}

function addCount(counts, identifier, tokens) {
    if (!identifier) {
        return;
    }

    const tokenCount = Number(tokens);
    if (!Number.isFinite(tokenCount)) {
        return;
    }

    counts[identifier] = (counts[identifier] ?? 0) + tokenCount;
}

function getPromptContent(prompt) {
    return typeof prompt?.content === 'string' ? prompt.content : '';
}

function collectDirectMessageCounts(item, counts) {
    const collection = getCollection(item);
    if (collection) {
        for (const child of collection) {
            collectDirectMessageCounts(child, counts);
        }
        return;
    }

    addCount(counts, item?.identifier, getTokenCount(item));
}

export function getPromptDisplayTokenCounts(messages) {
    const rootCollection = getCollection(messages) ?? [];
    const aggregateCounts = {};
    const directCounts = {};

    for (const item of rootCollection) {
        addCount(aggregateCounts, item?.identifier, getTokenCount(item));
        collectDirectMessageCounts(item, directCounts);
    }

    return { ...aggregateCounts, ...directCounts };
}

export function mergePromptTokenCounts(sourceCounts, runtimeCounts) {
    const counts = { ...(sourceCounts ?? {}) };

    for (const [identifier, tokens] of Object.entries(runtimeCounts ?? {})) {
        const tokenCount = Number(tokens);
        // A runtime zero means the prompt never made it into the message tree under
        // its own identifier; keep the source estimate instead of clobbering it.
        if (Number.isFinite(tokenCount) && tokenCount > 0) {
            counts[identifier] = tokenCount;
        }
    }

    return counts;
}

export async function getPromptSourceTokenCounts(prompts, countPromptTokens) {
    const counts = {};

    if (!Array.isArray(prompts) || typeof countPromptTokens !== 'function') {
        return counts;
    }

    for (const prompt of prompts) {
        const content = getPromptContent(prompt);
        if (!prompt?.identifier || prompt?.marker || !content) {
            continue;
        }

        const tokens = await countPromptTokens({ role: prompt.role || 'system', content });
        addCount(counts, prompt.identifier, tokens);
    }

    return counts;
}
