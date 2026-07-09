export const LINKAPI_ENDPOINT = {
    GLOBAL: 'global',
    US: 'us',
    HK: 'hk',
};

const LINKAPI_BASE_URLS = {
    [LINKAPI_ENDPOINT.GLOBAL]: 'https://linkapi.ai',
    [LINKAPI_ENDPOINT.US]: 'https://api.linkapi.ai',
    [LINKAPI_ENDPOINT.HK]: 'https://hk.linkapi.ai',
};

/**
 * Gets the LinkAPI base URL for a region endpoint value.
 * @param {string} [endpoint] Region endpoint value (LINKAPI_ENDPOINT)
 * @returns {string} Base URL without a trailing slash or API version suffix
 */
export function getLinkApiBaseUrl(endpoint) {
    return LINKAPI_BASE_URLS[endpoint] ?? LINKAPI_BASE_URLS[LINKAPI_ENDPOINT.GLOBAL];
}

/**
 * Picks the upstream wire format for a LinkAPI model id.
 * Claude models use the Anthropic-native relay and Gemini models the Google-native
 * relay; everything else (including gemma/learnlm) goes through the
 * OpenAI-compatible endpoint. Bracket-tagged ids (e.g. '[SP]claude-...', '[次]claude-...')
 * are flat-rate per-request channels that only relay through the OpenAI-compatible
 * endpoint, regardless of the underlying model family.
 * @param {string} model LinkAPI model id
 * @returns {'anthropic'|'google'|'openai'} Wire format for the request
 */
export function getLinkApiRequestFormat(model) {
    const raw = String(model ?? '').trim();

    if (raw.startsWith('[')) {
        return 'openai';
    }

    const id = raw.toLowerCase().replace(/^.*\//, '');

    if (id.includes('claude')) {
        return 'anthropic';
    }

    if (id.includes('gemini')) {
        return 'google';
    }

    return 'openai';
}
