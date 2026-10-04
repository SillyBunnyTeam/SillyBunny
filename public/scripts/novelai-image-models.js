export const NOVELAI_IMAGE_MODELS = [
    { value: 'nai-diffusion-5-full', text: 'NAI Diffusion Anime V5 (Full)' },
    { value: 'nai-diffusion-5-curated', text: 'NAI Diffusion Anime V5 (Curated)' },
    { value: 'nai-diffusion-4-5-full', text: 'NAI Diffusion Anime V4.5 (Full)' },
    { value: 'nai-diffusion-4-5-curated', text: 'NAI Diffusion Anime V4.5 (Curated)' },
    { value: 'nai-diffusion-4-full', text: 'NAI Diffusion Anime V4 (Full)' },
    { value: 'nai-diffusion-4-curated-preview', text: 'NAI Diffusion Anime V4 (Curated)' },
    { value: 'nai-diffusion-3', text: 'NAI Diffusion Anime V3' },
    { value: 'nai-diffusion-furry-3', text: 'NAI Diffusion Furry V3' },
];

const V5_SAMPLERS = new Set([
    'k_euler_ancestral',
    'k_euler',
    'k_dpmpp_2s_ancestral',
    'k_dpmpp_2m_sde',
    'k_dpmpp_2m',
    'k_dpmpp_sde',
]);

export function isNovelAIV5Model(model) {
    return /^nai-diffusion-5-(?:full|curated)(?:-inpainting)?$/.test(model);
}

/**
 * Mutates and returns provider parameters; callers construct prompts and choose seeds first.
 * Other models, including custom IDs, retain their existing request behavior.
 * @param {string} model NovelAI model ID
 * @param {object} parameters Provider request parameters
 * @returns {object} The same parameters object
 */
export function normalizeNovelAIImageParameters(model, parameters) {
    if (!isNovelAIV5Model(model)) {
        return parameters;
    }

    // Match the V5 capabilities and request builder in the first-party NovelAI image client.
    parameters.params_version = 4;
    parameters.noise_schedule = 'karras';
    parameters.dynamic_thresholding = false;
    delete parameters.sm;
    delete parameters.sm_dyn;
    delete parameters.skip_cfg_above_sigma;

    if (!V5_SAMPLERS.has(parameters.sampler)) {
        parameters.sampler = 'k_euler_ancestral';
    }
    if (parameters.sampler === 'k_euler_ancestral') {
        parameters.deliberate_euler_ancestral_bug = false;
        parameters.prefer_brownian = true;
    }

    return parameters;
}
