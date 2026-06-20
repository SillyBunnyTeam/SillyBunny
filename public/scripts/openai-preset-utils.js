/**
 * Builds a Chat Completion preset body from live settings and the OpenAI settings map.
 * The default preserves legacy behavior by including connection fields.
 *
 * @param {Record<string, any>} settings Live OpenAI settings
 * @param {Record<string, [string, string, boolean, boolean, boolean?]>} settingsMap OpenAI preset setting map
 * @param {object} [options] Build options
 * @param {boolean} [options.includeConnection=true] Whether to include provider/model/API fields
 * @param {boolean} [options.includeSampling=true] Whether to include sampling/temperature/penalty fields
 * @returns {Record<string, any>} Preset body
 */
export function buildChatCompletionPreset(settings, settingsMap, { includeConnection = true, includeSampling = true } = {}) {
    const presetBody = {};

    for (const [presetKey, [, settingsKey, , isConnection, isSampling]] of Object.entries(settingsMap ?? {})) {
        if (isConnection && !includeConnection) {
            continue;
        }

        if (isSampling && !includeSampling) {
            continue;
        }

        presetBody[presetKey] = settings?.[settingsKey];
    }

    return structuredClone(presetBody);
}

/**
 * Lists preset keys that represent provider/model/API connection state.
 *
 * @param {Record<string, [string, string, boolean, boolean, boolean?]>} settingsMap OpenAI preset setting map
 * @returns {string[]} Preset keys that should be treated as connection fields
 */
export function getChatCompletionConnectionPresetKeys(settingsMap) {
    return Object.entries(settingsMap ?? {})
        .filter(([, [, , , isConnection]]) => isConnection)
        .map(([presetKey]) => presetKey);
}

/**
 * Lists preset keys that represent sampling/temperature/penalty settings.
 *
 * @param {Record<string, [string, string, boolean, boolean, boolean?]>} settingsMap OpenAI preset setting map
 * @returns {string[]} Preset keys that should be treated as sampling fields
 */
export function getChatCompletionSamplingPresetKeys(settingsMap) {
    return Object.entries(settingsMap ?? {})
        .filter(([, [, , , , isSampling]]) => isSampling)
        .map(([presetKey]) => presetKey);
}

/**
 * Lists settings keys that represent sampling/temperature/penalty settings.
 *
 * @param {Record<string, [string, string, boolean, boolean, boolean?]>} settingsMap OpenAI preset setting map
 * @returns {string[]} Settings keys that should be stored in model sampling profiles
 */
export function getChatCompletionSamplingSettingsKeys(settingsMap) {
    return Object.entries(settingsMap ?? {})
        .filter(([, [, , , , isSampling]]) => isSampling)
        .map(([, [, settingsKey]]) => settingsKey);
}

/**
 * Builds a model sampling profile snapshot from live settings.
 *
 * @param {Record<string, any>} settings Live OpenAI settings
 * @param {Record<string, [string, string, boolean, boolean, boolean?]>} settingsMap OpenAI preset setting map
 * @returns {Record<string, any>} Sampling settings snapshot
 */
export function buildChatCompletionSamplingSettingsSnapshot(settings, settingsMap) {
    const snapshot = {};

    for (const settingsKey of getChatCompletionSamplingSettingsKeys(settingsMap)) {
        snapshot[settingsKey] = settings?.[settingsKey];
    }

    return structuredClone(snapshot);
}

const OPENAI_SAMPLING_PROFILE_SOURCE = 'openai';
const OPENAI_SAMPLING_PROFILE_SOURCES = new Set([
    'openai',
    'openai_responses',
    'azure_openai',
]);
const OPENAI_MODEL_PROVIDER_SEGMENTS = new Set([
    'openai',
    'openai-responses',
    'azure-openai',
]);

function normalizeSamplingProfileSource(source) {
    return String(source ?? '').trim().toLowerCase();
}

function normalizeSamplingProfileModel(model) {
    return String(model ?? '')
        .trim()
        .toLowerCase()
        .replace(/\\/g, '/')
        .replace(/:+/g, '/')
        .replace(/[\s_]+/g, '-')
        .replace(/\/+/g, '/')
        .replace(/-+/g, '-')
        .replace(/^[-/]+|[-/]+$/g, '');
}

function stripOpenAIModelProviderPrefix(model) {
    let normalizedModel = normalizeSamplingProfileModel(model).replace(/^(?:models\/)+/, '');
    const slashSegments = normalizedModel.split('/');
    const openAiSegmentIndex = slashSegments.findIndex(segment => OPENAI_MODEL_PROVIDER_SEGMENTS.has(segment));

    if (openAiSegmentIndex >= 0 && slashSegments[openAiSegmentIndex + 1]) {
        return slashSegments.slice(openAiSegmentIndex + 1).join('-');
    }

    return normalizedModel.replace(/^(?:openai|openai-responses|azure-openai)[-/]+/, '');
}

function normalizeOpenAIModelForSamplingProfile(model) {
    let normalizedModel = stripOpenAIModelProviderPrefix(model)
        .replace(/^chatgpt(?=\d)/, 'chatgpt-')
        .replace(/^chatgpt-/, 'gpt-')
        .replace(/^gpt(?=\d)/, 'gpt-')
        .replace(/^(o[134])(?=[a-z])/, '$1-');

    normalizedModel = normalizedModel
        .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '')
        .replace(/-latest$/, '');

    return normalizedModel;
}

function isOpenAIModelForSamplingProfile(model) {
    const normalizedModel = normalizeSamplingProfileModel(model);
    const normalizedOpenAIModel = normalizeOpenAIModelForSamplingProfile(model);

    return Boolean(normalizedOpenAIModel) && (
        normalizedModel.split('/').some(segment => OPENAI_MODEL_PROVIDER_SEGMENTS.has(segment))
        || /^(?:gpt(?:-|\d)|codex(?:-|$)|omni(?:-|$)|o[134](?:-|\d|$))/.test(normalizedOpenAIModel)
    );
}

/**
 * Builds a canonical key for model sampling profiles.
 *
 * @param {string} source Chat Completion source
 * @param {string} model Chat Completion model
 * @returns {string|null} Canonical model sampling profile key
 */
export function buildChatCompletionSamplingProfileKey(source, model) {
    const normalizedSource = normalizeSamplingProfileSource(source);
    const normalizedModel = normalizeSamplingProfileModel(model);

    if (!normalizedSource || !normalizedModel) {
        return null;
    }

    const isOpenAIProfile = OPENAI_SAMPLING_PROFILE_SOURCES.has(normalizedSource)
        || (normalizedSource === 'custom' && isOpenAIModelForSamplingProfile(normalizedModel));

    const profileSource = isOpenAIProfile ? OPENAI_SAMPLING_PROFILE_SOURCE : normalizedSource;
    const profileModel = isOpenAIProfile ? normalizeOpenAIModelForSamplingProfile(normalizedModel) : normalizedModel;

    if (!profileModel) {
        return null;
    }

    return `${profileSource}:${profileModel}`;
}

/**
 * Lists profile keys to try when loading/clearing model sampling profiles.
 * The legacy exact key keeps saved profiles from earlier SillyBunny builds usable.
 *
 * @param {string} source Chat Completion source
 * @param {string} model Chat Completion model
 * @returns {string[]} Canonical key followed by legacy fallback keys
 */
export function getChatCompletionSamplingProfileLookupKeys(source, model) {
    const legacyKey = source && model ? `${source}:${model}` : null;

    return [
        buildChatCompletionSamplingProfileKey(source, model),
        legacyKey,
    ].filter((key, index, keys) => key && keys.indexOf(key) === index);
}

/**
 * Returns whether OpenAI preset saves should include provider/model/API fields.
 *
 * @param {Record<string, any>} settings Live OpenAI settings
 * @returns {boolean} True when linked preset mode is enabled
 */
export function shouldIncludeConnectionFieldsInPreset(settings) {
    return Boolean(settings?.bind_preset_to_connection);
}

/**
 * Returns whether OpenAI preset saves should include sampling/temperature/penalty fields.
 *
 * @param {Record<string, any>} settings Live OpenAI settings
 * @returns {boolean} True when sampling fields should be included in presets
 */
export function shouldIncludeSamplingFieldsInPreset(settings) {
    // Legacy settings that predate this toggle should keep saving sampling fields.
    return settings?.bind_preset_to_sampling !== false;
}

/**
 * Builds a Chat Completion preset body using the current linked-preset mode.
 *
 * @param {Record<string, any>} settings Live OpenAI settings
 * @param {Record<string, [string, string, boolean, boolean, boolean?]>} settingsMap OpenAI preset setting map
 * @returns {Record<string, any>} Preset body
 */
export function buildChatCompletionPresetForSave(settings, settingsMap) {
    return buildChatCompletionPreset(settings, settingsMap, {
        includeConnection: shouldIncludeConnectionFieldsInPreset(settings),
        includeSampling: shouldIncludeSamplingFieldsInPreset(settings),
    });
}

/**
 * Normalizes a reverse proxy preset while preserving legacy presets that do not
 * yet have a source binding.
 *
 * @param {Record<string, any>} preset Reverse proxy preset
 * @param {object} [options] Normalize options
 * @param {string[]} [options.supportedSources=[]] Chat Completion sources that can use reverse proxies
 * @returns {{name: string, url: string, password: string, source: string}}
 */
export function normalizeReverseProxyPreset(preset, { supportedSources = [] } = {}) {
    const name = String(preset?.name ?? 'None');
    const source = String(preset?.source ?? '');

    return {
        name,
        url: String(preset?.url ?? ''),
        password: String(preset?.password ?? ''),
        source: name === 'None' || !supportedSources.includes(source) ? '' : source,
    };
}

/**
 * Builds a reverse proxy preset from the current proxy form and backend source.
 *
 * @param {Record<string, any>} preset Reverse proxy preset data
 * @param {object} [options] Build options
 * @param {string[]} [options.supportedSources=[]] Chat Completion sources that can use reverse proxies
 * @returns {{name: string, url: string, password: string, source: string}}
 */
export function buildReverseProxyPresetForSave(preset, { supportedSources = [] } = {}) {
    return normalizeReverseProxyPreset(preset, { supportedSources });
}

/**
 * Normalizes a Custom OpenAI-compatible endpoint profile.
 *
 * @param {Record<string, any>} preset Custom endpoint profile
 * @returns {{name: string, url: string, key: string, model: string}}
 */
export function normalizeCustomEndpointPreset(preset) {
    const name = String(preset?.name ?? 'None');

    if (name === 'None') {
        return {
            name,
            url: '',
            key: '',
            model: '',
        };
    }

    return {
        name,
        url: String(preset?.url ?? ''),
        key: String(preset?.key ?? ''),
        model: String(preset?.model ?? ''),
    };
}

/**
 * Builds a Custom OpenAI-compatible endpoint profile from the current form.
 *
 * @param {Record<string, any>} preset Custom endpoint profile data
 * @returns {{name: string, url: string, key: string, model: string}}
 */
export function buildCustomEndpointPresetForSave(preset) {
    return normalizeCustomEndpointPreset(preset);
}

/**
 * Builds the storage key for model favorites, scoping Custom endpoint favorites by URL.
 *
 * @param {string} source Chat Completion source
 * @param {string} url Custom OpenAI-compatible endpoint URL
 * @returns {string} Model favorites storage key
 */
export function getCustomEndpointFavoritesKey(source, url) {
    const normalizedSource = String(source ?? '');

    if (normalizedSource !== 'custom') {
        return normalizedSource;
    }

    const normalizedUrl = String(url ?? '').trim().replace(/\/+$/, '');
    return normalizedUrl ? `${normalizedSource}::${normalizedUrl}` : normalizedSource;
}
