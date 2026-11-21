const MICRO = 1e6;
const roundUsd = (value) => Math.round(value * MICRO) / MICRO;

function perImageBaseUsd(billing, { size, promptChars, refCount }) {
    switch (billing.kind) {
        case 'per-image':
            return billing.usdPerImage;
        case 'per-request':
            return billing.usdPerRequest;
        case 'tokens': {
            const sizeTokens = billing.outputTokensBySize[size];
            if (sizeTokens === undefined) {
                throw new Error(`No output token count for size "${size}". Priced sizes: ${Object.keys(billing.outputTokensBySize).join(', ')}.`);
            }
            // The relay bills thinking tokens as output tokens, so they count with the image tokens.
            const outputTokens = sizeTokens.candidates + sizeTokens.thoughts;
            const inputTokens = promptChars / billing.charsPerTextToken + refCount * billing.refImageTokens;
            return (inputTokens * billing.inputUsdPerMTok + outputTokens * billing.outputUsdPerMTok) / MICRO;
        }
    }
}

/**
 * Prices a batch before anything is sent.
 * @param {ReturnType<typeof import('./config.mjs').parseConfig>} config
 * @param {{ model: string, n: number, size: string, promptChars: number, refCount: number }} request
 */
export function estimateBatch(config, { model, n, size, promptChars, refCount }) {
    const priced = config.models[model];
    if (!priced) {
        throw new Error(`Model "${model}" has no price in config.json. Priced models: ${Object.keys(config.models).join(', ')}.`);
    }
    const perImageUsd = roundUsd(perImageBaseUsd(priced.billing, { size, promptChars, refCount }) * priced.groupMultiplier);
    return {
        perImageUsd,
        totalUsd: roundUsd(perImageUsd * n),
        isEstimate: priced.estimate,
        count: n,
    };
}

/**
 * Refuses a batch that would take the all-time total over the safety cap.
 * @param {{ costCapUsd: number }} config
 * @param {{ runningUsd: number, batchUsd: number }} totals
 */
export function assertWithinCap(config, { runningUsd, batchUsd }) {
    const projected = roundUsd(runningUsd + batchUsd);
    if (projected > config.costCapUsd) {
        throw new Error(`Refusing to start: logged $${runningUsd.toFixed(2)} + this batch $${batchUsd.toFixed(2)} = $${projected.toFixed(2)} passes costCapUsd $${config.costCapUsd.toFixed(2)}. Raise costCapUsd in config.json to continue.`);
    }
}
