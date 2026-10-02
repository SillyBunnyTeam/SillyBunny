// SillyBunny: discovery lists must match the generation protocol, not image-input support.
function catalogEntries(data, field) {
    if (!data || !Array.isArray(data[field])) {
        throw new Error(`Invalid model catalog: ${field} must be an array.`);
    }
    return data[field];
}

function modelOptions(models, getId, supports) {
    const options = new Map();
    for (const model of models) {
        const id = getId(model);
        if (typeof id !== 'string' || !id.trim()) {
            throw new Error('Invalid model catalog: model identifier is missing.');
        }
        if (supports(model, id) && !options.has(id)) {
            options.set(id, { value: id, text: model.displayName || id });
        }
    }
    return [...options.values()];
}

/**
 * OpenAI's models API has no capability metadata. Only GPT Image uses our Images API payload.
 * DALL-E and the Sora Videos API are retired; chatgpt-image-latest is not a generations model.
 * @param {object} data OpenAI /v1/models response
 * @returns {{value: string, text: string}[]} Compatible model options
 */
export function getOpenAIImageModels(data) {
    return modelOptions(catalogEntries(data, 'data'), model => model?.id, (_model, id) =>
        /^gpt-image-\d+(?:\.\d+)?(?:-[a-z0-9.-]+)?$/.test(id)
        && !/(?:^|-)(?:edit|edits|inpaint|upscale|vision|embedding)(?:-|$)/.test(id));
}

/**
 * @param {string} id Model identifier, without a resource prefix
 * @returns {boolean} Whether the model uses Gemini's image-output generateContent protocol
 */
export function isGoogleImageGenerationModel(id) {
    return /^gemini-\d+(?:\.\d+)?-[a-z0-9.-]+-image(?:-[a-z0-9.-]+)?$/.test(id)
        && !/^gemini-2\.0-/.test(id)
        && !/(?:^|-)(?:edit|edits|inpaint|upscale|embedding)(?:-|$)/.test(id);
}

/**
 * @param {object} data Google models.list or publishers.models.list response
 * @param {object} [options] Adapter capabilities
 * @param {boolean} [options.includeVideo=true] Include Veo predictLongRunning models
 * @param {boolean} [options.includeImagen=true] Include compatible Imagen predict models
 * @param {boolean} [options.vertex=false] Whether the catalog is Vertex Model Garden
 * @returns {{value: string, text: string}[]} Compatible model options
 */
export function getGoogleImageModels(data, { includeVideo = true, includeImagen = true, vertex = false } = {}) {
    return modelOptions(catalogEntries(data, vertex ? 'publisherModels' : 'models'), model => {
        const name = model?.name;
        if (typeof name !== 'string') return name;
        return name.replace(vertex ? /^publishers\/google\/models\// : /^models\//, '');
    }, (model, id) => {
        if (['gemini-2.5-flash-image-preview', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview'].includes(id)) return false;
        const supportsMethod = method => vertex || model.supportedGenerationMethods?.includes(method);
        if (isGoogleImageGenerationModel(id)) return supportsMethod('generateContent');
        // Imagen 1–4 and Veo 2/3.0 have been retired. Keep the protocol for future compatible IDs.
        if (includeImagen && /^imagen-\d+(?:\.\d+)?-(?:(?:fast|ultra)-)?generate-[a-z0-9-]+$/.test(id)
            && !/^imagen-[1-4](?:\.|-)/.test(id)) {
            return supportsMethod('predict');
        }
        return includeVideo && /^veo-\d+(?:\.\d+)?-(?:(?:fast|lite)-)?generate-[a-z0-9-]+$/.test(id)
            && !/^veo-(?:2\.|3\.0-)/.test(id) && supportsMethod('predictLongRunning');
    });
}

/**
 * The dedicated endpoint is authoritative even when optional modality fields are absent.
 * @param {object} data xAI /v1/image-generation-models response
 * @returns {{value: string, text: string}[]} Compatible model options
 */
export function getXAIImageModels(data) {
    return modelOptions(catalogEntries(data, 'models'), model => model?.id, model =>
        (!model.input_modalities || model.input_modalities.includes('text'))
        && (!model.output_modalities || model.output_modalities.includes('image')));
}

/**
 * @param {object[]} data Pollinations /image/models response (also contains video models)
 * @returns {{value: string, text: string}[]} Models usable by the text-to-image GET adapter
 */
export function getPollinationsImageModels(data) {
    if (!Array.isArray(data)) throw new Error('Invalid model catalog: expected an array.');
    return modelOptions(data, model => model?.name, model =>
        (Array.isArray(model.output_modalities) ? model.output_modalities.includes('image') : model.category === 'image')
        && (!model.input_modalities || model.input_modalities.includes('text'))
        && (!model.supported_endpoints || model.supported_endpoints.includes('/image/{prompt}')));
}
