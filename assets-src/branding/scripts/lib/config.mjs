import { readFileSync } from 'node:fs';

export const PROVIDER_NAMES = ['openai', 'gemini'];
const BILLING_FIELDS = {
    'per-image': ['usdPerImage'],
    'per-request': ['usdPerRequest'],
    tokens: ['inputUsdPerMTok', 'outputUsdPerMTok', 'outputTokensBySize', 'refImageTokens', 'charsPerTextToken'],
};

const isPositiveNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Parses config.json into a trusted shape. Everything downstream may assume it is valid.
 * @param {any} raw
 */
export function parseConfig(raw) {
    if (!isPositiveNumber(raw?.costCapUsd)) {
        throw new Error('config.json: costCapUsd must be a positive number.');
    }
    if (!isPositiveNumber(raw.pricing?.unitsPerUsd)) {
        throw new Error('config.json: pricing.unitsPerUsd must be a positive number.');
    }
    const models = raw.models ?? {};
    for (const [name, model] of Object.entries(models)) {
        if (!PROVIDER_NAMES.includes(model.provider)) {
            throw new Error(`config.json: model "${name}" has unknown provider "${model.provider}".`);
        }
        const fields = BILLING_FIELDS[model.billing?.kind];
        if (!fields || fields.some((field) => model.billing[field] === undefined)) {
            throw new Error(`config.json: model "${name}" has an incomplete billing block.`);
        }
        if (model.billing.kind === 'tokens') {
            const sizes = Object.entries(model.billing.outputTokensBySize);
            if (sizes.length === 0 || sizes.some(([, tokens]) => !isPositiveNumber(tokens.candidates) || !(tokens.thoughts >= 0))) {
                throw new Error(`config.json: model "${name}" needs candidates and thoughts token counts for every size.`);
            }
        }
        if (!isPositiveNumber(model.groupMultiplier)) {
            throw new Error(`config.json: model "${name}" needs a positive groupMultiplier.`);
        }
    }
    if (raw.lockedModel !== null && !(raw.lockedModel in models)) {
        throw new Error(`config.json: lockedModel "${raw.lockedModel}" is not a priced model.`);
    }
    return { ...raw, models };
}

/** @param {string} path */
export function loadConfig(path) {
    return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}
