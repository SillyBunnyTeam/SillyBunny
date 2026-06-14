/**
 * Builds a Chat Completion preset body from live settings and the OpenAI settings map.
 * The default preserves legacy behavior by including connection fields.
 *
 * @param {Record<string, any>} settings Live OpenAI settings
 * @param {Record<string, [string, string, boolean, boolean, boolean]>} settingsMap OpenAI preset setting map
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
 * @param {Record<string, [string, string, boolean, boolean]>} settingsMap OpenAI preset setting map
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
 * @param {Record<string, [string, string, boolean, boolean, boolean]>} settingsMap OpenAI preset setting map
 * @returns {string[]} Preset keys that should be treated as sampling fields
 */
export function getChatCompletionSamplingPresetKeys(settingsMap) {
    return Object.entries(settingsMap ?? {})
        .filter(([, [, , , , isSampling]]) => isSampling)
        .map(([presetKey]) => presetKey);
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
    return settings?.bind_preset_to_sampling !== false;
}

/**
 * Builds a Chat Completion preset body using the current linked-preset mode.
 *
 * @param {Record<string, any>} settings Live OpenAI settings
 * @param {Record<string, [string, string, boolean, boolean, boolean]>} settingsMap OpenAI preset setting map
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
