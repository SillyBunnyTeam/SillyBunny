import { getGoogleImageModels, getOpenAIImageModels, isGoogleImageGenerationModel } from '../../../image-model-catalogs.js';
import { getGptImageApiUrl, getNanobananaApiUrl, getNanobananaAuthHeaders, isOpenAIChatCompletionsEndpoint } from './provider-adapters.js';
import { assertSafeConfigurableEndpoint, createAbortDeadline } from './network-runtime.js';
import { registerPollinationsModelMetadata } from './provider-capabilities.js';
import { readResponseJson } from './security.js';

export const QIG_MODEL_INPUTS = {
    pollinations: { id: 'qig-pollinations-model', key: 'pollinationsModel' },
    novelai: { id: 'qig-nai-model', key: 'naiModel' },
    gptimage: { id: 'qig-gpt-image-model', key: 'gptImageModel' },
    arliai: { id: 'qig-arli-model', key: 'arliModel' },
    routeway: { id: 'qig-routeway-model', key: 'routewayModel' },
    navy: { id: 'qig-navy-model', key: 'navyModel' },
    nanogpt: { id: 'qig-nanogpt-model', key: 'nanogptModel' },
    chutes: { id: 'qig-chutes-model', key: 'chutesModel' },
    civitai: { id: 'qig-civitai-model', key: 'civitaiModel' },
    nanobanana: { id: 'qig-nanobanana-model', key: 'nanobananaModel' },
    replicate: { id: 'qig-replicate-model', key: 'replicateModel' },
    fal: { id: 'qig-fal-model', key: 'falModel' },
    together: { id: 'qig-together-model', key: 'togetherModel' },
    zai: { id: 'qig-zai-model', key: 'zaiModel' },
};

export const LIVE_MODEL_PROVIDERS = new Set(['pollinations', 'gptimage', 'arliai', 'routeway', 'navy', 'nanogpt', 'nanobanana', 'fal', 'together']);

const routewayModelSizes = new Map();

export function getRoutewayModelSizes(model) {
    return routewayModelSizes.get(model);
}

function modelsUrl(endpoint, suffix) {
    const url = new URL(endpoint);
    if (!suffix.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(suffix, '/models');
    url.hash = '';
    return url.href;
}

export function getModelCatalogRequest(provider, settings) {
    const bearer = key => key ? { Authorization: `Bearer ${key}` } : {};
    let url;
    let headers = {};
    let format = provider;
    switch (provider) {
        case 'pollinations':
            url = 'https://gen.pollinations.ai/image/models';
            headers = bearer(settings.pollinationsKey);
            if (!String(settings.pollinationsKey || '').trim()) format = 'pollinations-anonymous';
            break;
        case 'gptimage':
            url = modelsUrl(getGptImageApiUrl(settings.gptImageProxyUrl), /\/images\/generations\/?$/i);
            headers = bearer(settings.gptImageProxyKey || settings.gptImageKey);
            break;
        case 'nanobanana': {
            const endpoint = getNanobananaApiUrl(settings.nanobananaProxyUrl);
            const chat = isOpenAIChatCompletionsEndpoint(endpoint);
            url = modelsUrl(endpoint, chat ? /\/chat\/completions\/?$/i : /\/models\/[^/]+:generateContent\/?$/i);
            headers = getNanobananaAuthHeaders(endpoint, settings.nanobananaProxyKey || settings.nanobananaKey);
            if (chat) format = 'gemini-openai';
            break;
        }
        case 'routeway':
            url = 'https://api.routeway.ai/v1/models';
            headers = bearer(settings.routewayKey);
            break;
        case 'navy':
            url = 'https://api.navy/v1/models';
            headers = bearer(settings.navyKey);
            break;
        case 'nanogpt':
            url = 'https://nano-gpt.com/api/v1/images/models';
            headers = bearer(settings.nanogptKey);
            break;
        case 'arliai':
            url = 'https://api.arliai.com/sdapi/v1/sd-models';
            headers = bearer(settings.arliKey);
            break;
        case 'together':
            url = 'https://api.together.ai/v1/models';
            headers = bearer(settings.togetherKey);
            break;
        case 'fal':
            url = 'https://api.fal.ai/v1/models?category=text-to-image&status=active&limit=100';
            headers = settings.falKey ? { Authorization: `Key ${settings.falKey}` } : {};
            break;
        default:
            return null;
    }
    if (!url) return null;
    assertSafeConfigurableEndpoint(url, 'Model API URL');
    return { provider, url, headers, format };
}

function requireRows(rows) {
    if (!Array.isArray(rows)) throw new Error('Invalid model list');
    return rows;
}

export function parseModelCatalog(format, data) {
    let rows;
    switch (format) {
        case 'gptimage':
            // The GPT adapter sends GPT-only options, not DALL-E or Sora payloads.
            return getOpenAIImageModels(data);
        case 'nanobanana':
            return getGoogleImageModels(data, { includeVideo: false, includeImagen: false });
        case 'gemini-openai':
            rows = requireRows(data?.data).filter(model => isGoogleImageGenerationModel(String(model?.id || '').replace(/^(?:google\/|models\/)/, '')));
            break;
        case 'pollinations':
        case 'pollinations-anonymous':
            rows = requireRows(data).filter(model => (Array.isArray(model?.output_modalities) ? model.output_modalities.includes('image') : model?.category === 'image')
                && (!model?.input_modalities || model.input_modalities.includes('text'))
                && (!model?.supported_endpoints || model.supported_endpoints.includes(format === 'pollinations' ? '/v1/images/generations' : '/image/{prompt}')));
            registerPollinationsModelMetadata(rows);
            return [{ value: '', text: 'Default (legacy anonymous endpoint)' }, ...rows.map(model => ({ value: model.name || model.id, text: `${model.title || model.name || model.id}${model.paid_only ? ' (API key required)' : ''}` }))];
        case 'routeway':
            rows = requireRows(data?.data).filter(model => model?.available !== false && model?.endpoints?.includes('/v1/images/generations'));
            for (const model of rows) {
                const sizes = model.supported_sizes?.filter(size => typeof size === 'string' && /^\d+x\d+$/.test(size));
                if (sizes?.length) routewayModelSizes.set(model.id, sizes);
            }
            break;
        case 'navy':
            rows = requireRows(data?.data).filter(model => model?.endpoint === '/v1/images/generations');
            break;
        case 'nanogpt':
            rows = requireRows(data?.data).filter(model => model?.capabilities?.image_generation === true
                && model?.capabilities?.inpainting !== true
                && !/(?:^|[/-])(?:text-to-vector|vector|svg)(?:[/-]|$)/i.test(model.id || '')
                && !model.tags?.some(tag => /^(?:text-to-vector|vector|svg)$/i.test(tag)));
            break;
        case 'arliai':
            return requireRows(data).map(model => ({ value: model.title || model.model_name, text: model.model_name || model.title }));
        case 'together':
            rows = requireRows(data).filter(model => model?.type === 'image');
            break;
        case 'fal':
            // These families accept QIG's image_size object and diffusion controls. A
            // marketplace category alone also contains adapters with incompatible inputs.
            rows = requireRows(data?.models).filter(model => model?.metadata?.category === 'text-to-image'
                && model.metadata.status !== 'deprecated'
                && /^fal-ai\/(?:flux(?:\/|$)|fast-sdxl(?:\/|$)|sdxl(?:\/|$))/.test(model.endpoint_id)
                && !/(?:^|[/-])(?:image-to-image|edit|inpaint(?:ing)?|controlnet|lora|redux|fill|upscal(?:e|ing))(?:[/-]|$)/i.test(model.endpoint_id));
            return rows.map(model => ({ value: model.endpoint_id, text: model.metadata.display_name || model.endpoint_id }));
        default:
            throw new Error('Invalid model list');
    }
    return rows.map(model => ({ value: model.id, text: model.name || model.display_name || model.id }));
}

export function modelSuggestions(models, currentValue = '') {
    const result = [];
    const seen = new Set();
    for (const model of models) {
        if (typeof model?.value !== 'string' || seen.has(model.value)) continue;
        seen.add(model.value);
        result.push({ value: model.value, text: String(model.text || model.value) });
    }
    const current = String(currentValue ?? '');
    if (current && !seen.has(current)) result.push({ value: current, text: `${current} - current custom model` });
    return result;
}

export async function fetchModelCatalog(request, signal, fetchImpl) {
    const models = [];
    const cursors = new Set();
    let cursor = '';
    do {
        const url = new URL(request.url);
        if (request.format === 'nanobanana') {
            url.searchParams.set('pageSize', '1000');
            if (cursor) url.searchParams.set('pageToken', cursor);
        } else if (request.format === 'fal' && cursor) {
            url.searchParams.set('cursor', cursor);
        }
        const response = await fetchImpl(url.href, { headers: request.headers, signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error(`Failed to fetch models: ${response.status}`);
        const data = await readResponseJson(response, 5 * 1024 * 1024);
        models.push(...parseModelCatalog(request.format, data));
        cursor = request.format === 'nanobanana' ? data.nextPageToken : request.format === 'fal' ? data.next_cursor : '';
        if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('Invalid model list');
        if (cursor) cursors.add(cursor);
    } while (cursor);
    return modelSuggestions(models);
}

export function replaceModelSuggestions(input, datalist, models) {
    const fragment = datalist.ownerDocument.createDocumentFragment();
    for (const model of modelSuggestions(models, input.value)) {
        const option = datalist.ownerDocument.createElement('option');
        option.value = model.value;
        option.label = model.text;
        fragment.append(option);
    }
    datalist.replaceChildren(fragment);
}

export function createModelCatalogRefresher({ getSettings, getTarget, fetchModels, onError }) {
    let active = null;
    const setBusy = (target, busy) => {
        target.button.disabled = busy;
        target.button.setAttribute('aria-busy', String(busy));
    };
    const cancel = () => {
        if (!active) return;
        active.controller.abort();
        setBusy(active.target, false);
        active = null;
    };
    return {
        cancel,
        async refresh(provider) {
            cancel();
            const target = getTarget(provider);
            if (!target || getSettings().provider !== provider) return false;
            let request;
            try {
                request = getModelCatalogRequest(provider, getSettings());
                if (!request) throw new Error('No models found');
            } catch (error) {
                onError(error);
                return false;
            }
            const controller = new AbortController();
            const token = { target, controller };
            active = token;
            const deadline = createAbortDeadline(controller.signal, 15_000, 'Model discovery timed out');
            const isCurrent = () => {
                if (active !== token || controller.signal.aborted || !target.input.isConnected || getSettings().provider !== provider || getTarget(provider)?.input !== target.input) return false;
                try {
                    return JSON.stringify(getModelCatalogRequest(provider, getSettings())) === JSON.stringify(request);
                } catch {
                    return false;
                }
            };
            setBusy(target, true);
            try {
                const models = await fetchModels(request, deadline.signal);
                if (deadline.signal.aborted) throw deadline.signal.reason;
                if (!isCurrent()) return false;
                if (!models.some(model => model.value)) throw new Error('No models found');
                replaceModelSuggestions(target.input, target.datalist, models);
                return true;
            } catch (error) {
                if (isCurrent()) onError(error);
                return false;
            } finally {
                deadline.dispose();
                if (active === token) {
                    setBusy(target, false);
                    active = null;
                }
            }
        },
    };
}
