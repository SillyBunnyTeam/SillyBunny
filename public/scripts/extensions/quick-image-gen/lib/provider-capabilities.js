const ALL_CONTROLS = Object.freeze({
    steps: true,
    cfgScale: true,
    sampler: true,
    seed: true,
    sequentialSeeds: true,
    referenceImages: true,
});

const NO_DIFFUSION_CONTROLS = Object.freeze({
    steps: false,
    cfgScale: false,
    sampler: false,
    seed: false,
    sequentialSeeds: false,
    referenceImages: false,
});

export const PROVIDER_GENERATION_CAPABILITIES = Object.freeze({
    pollinations: Object.freeze({ ...ALL_CONTROLS, steps: false, cfgScale: false, sampler: false }),
    novelai: ALL_CONTROLS,
    gptimage: NO_DIFFUSION_CONTROLS,
    arliai: ALL_CONTROLS,
    routeway: Object.freeze({ ...ALL_CONTROLS, sampler: false }),
    navy: NO_DIFFUSION_CONTROLS,
    nanogpt: Object.freeze({ ...ALL_CONTROLS, sampler: false }),
    chutes: Object.freeze({ ...ALL_CONTROLS, sampler: false }),
    civitai: Object.freeze({ ...ALL_CONTROLS, sampler: false }),
    nanobanana: Object.freeze({ ...NO_DIFFUSION_CONTROLS, referenceImages: true }),
    stability: Object.freeze({ ...ALL_CONTROLS, sampler: false }),
    replicate: ALL_CONTROLS,
    fal: Object.freeze({ ...ALL_CONTROLS, sampler: false }),
    together: Object.freeze({ ...ALL_CONTROLS, sampler: false }),
    zai: NO_DIFFUSION_CONTROLS,
    local: ALL_CONTROLS,
    comfyui: ALL_CONTROLS,
});

export const POLLINATIONS_MODEL_CAPABILITIES = {
    gptimage: Object.freeze({ requiresAuth: true }),
    "gptimage-large": Object.freeze({ requiresAuth: true }),
    nanobanana: Object.freeze({ requiresAuth: true }),
    "nanobanana-2": Object.freeze({ requiresAuth: true }),
    "nanobanana-pro": Object.freeze({ requiresAuth: true }),
    seedream5: Object.freeze({ requiresAuth: true }),
    "wan-image-pro": Object.freeze({ requiresAuth: true }),
    "wan-image": Object.freeze({ requiresAuth: true }),
    "qwen-image": Object.freeze({ requiresAuth: true }),
    "grok-imagine": Object.freeze({ requiresAuth: true }),
    "grok-imagine-pro": Object.freeze({ requiresAuth: true }),
    "p-image": Object.freeze({ requiresAuth: true }),
    "p-image-edit": Object.freeze({ requiresAuth: true }),
    "nova-canvas": Object.freeze({ requiresAuth: true }),
};

export function registerPollinationsModelMetadata(models) {
    if (!Array.isArray(models)) return;
    for (const model of models) {
        const id = String(model?.name || model?.id || "").trim();
        if (!id) continue;
        POLLINATIONS_MODEL_CAPABILITIES[id] = Object.freeze({ requiresAuth: model.paid_only === true });
        for (const alias of model?.aliases || []) {
            const normalizedAlias = String(alias || "").trim();
            if (normalizedAlias) POLLINATIONS_MODEL_CAPABILITIES[normalizedAlias] = POLLINATIONS_MODEL_CAPABILITIES[id];
        }
    }
}

export function pollinationsModelRequiresAuth(model) {
    const id = String(model || "").trim();
    return POLLINATIONS_MODEL_CAPABILITIES[id]?.requiresAuth === true;
}

export function getNanoGptModelCapabilities(model, metadata = null) {
    const id = String(model || "").trim();
    const supported = metadata?.supported_parameters || metadata?.endpoints?.[0]?.supported_parameters || {};
    const inputModalities = metadata?.architecture?.input_modalities || metadata?.input_modalities || [];
    const capabilities = metadata?.capabilities || metadata?.endpoints?.[0]?.capabilities || {};
    const hasParameter = (...names) => names.some(name => Object.prototype.hasOwnProperty.call(supported, name));
    const isKnownDefault = id === "flux-schnell";
    return {
        steps: !isKnownDefault && hasParameter("steps", "num_inference_steps"),
        cfgScale: !isKnownDefault && hasParameter("guidance", "guidance_scale", "cfg_scale"),
        sampler: !isKnownDefault && hasParameter("sampler", "scheduler"),
        seed: isKnownDefault ? false : hasParameter("seed"),
        sequentialSeeds: isKnownDefault ? false : hasParameter("seed"),
        referenceImages: inputModalities.includes("image")
            || capabilities.image_to_image === true
            || !!metadata?.endpoints?.[0]?.input_reference_constraints
            || Number(supported.max_input_images) > 0,
    };
}

export function getNanoGptReferenceConstraints(metadata = null) {
    const endpoint = metadata?.endpoints?.[0] || {};
    const supported = metadata?.supported_parameters || endpoint.supported_parameters || {};
    const constraints = endpoint.input_reference_constraints || metadata?.input_reference_constraints || {};
    const route = constraints.route || endpoint.route || metadata?.route || {};
    const maxCandidate = constraints.max_items ?? constraints.max_images ?? constraints.max_input_images ?? supported.max_input_images;
    const providerMaxImages = Number.isSafeInteger(Number(maxCandidate)) && Number(maxCandidate) >= 0
        ? Number(maxCandidate)
        : 15;
    const maxImages = Math.min(15, providerMaxImages);
    const rawFormats = constraints.formats
        || constraints.mime_types
        || constraints.supported_mime_types
        || constraints.allowed_mime_types
        || constraints.supported_formats
        || constraints.supported_image_formats
        || supported.input_reference_formats
        || route.formats
        || [];
    const mimeTypes = [...new Set((Array.isArray(rawFormats) ? rawFormats : [rawFormats])
        .map(format => String(format || '').trim().toLowerCase())
        .filter(Boolean)
        .map(format => format.replace(/^\./, ''))
        .map(format => format.includes('/') ? format : `image/${format === 'jpg' ? 'jpeg' : format}`))];
    const routeMaxBytes = Number(route.max_bytes);
    const maxBytes = Number.isSafeInteger(routeMaxBytes) && routeMaxBytes > 0 ? routeMaxBytes : null;
    return { maxImages, mimeTypes, maxBytes };
}

export function getNanoGptResolution(width, height, metadata = null) {
    const resolutionParameter = metadata?.supported_parameters?.resolution
        || metadata?.endpoints?.[0]?.supported_parameters?.resolution;
    const advertised = resolutionParameter?.values
        || (Array.isArray(resolutionParameter) ? resolutionParameter : null)
        || metadata?.supported_parameters?.resolutions
        || metadata?.endpoints?.[0]?.supported_parameters?.resolutions;
    const advertisedValues = (Array.isArray(advertised) ? advertised : [advertised])
        .filter(value => String(value ?? "").trim());
    const supported = advertisedValues.length
        ? advertisedValues
        : ["1024x1024", "1024x768", "1024x576", "768x1024", "576x1024"];
    const targetWidth = Number(width) || 1024;
    const targetHeight = Number(height) || 1024;
    const targetRatio = targetWidth / targetHeight;
    const ratioPresets = {
        square_hd: 1,
        landscape_16_9: 16 / 9,
        portrait_16_9: 9 / 16,
    };
    const ratioCandidates = supported.map(value => {
        const normalized = String(value).trim().toLowerCase();
        const dimensions = normalized.match(/^(\d+)\s*[x*]\s*(\d+)$/i);
        const ratio = normalized.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
        const parsedRatio = dimensions
            ? Number(dimensions[1]) / Number(dimensions[2])
            : (ratio ? Number(ratio[1]) / Number(ratio[2]) : ratioPresets[normalized]);
        return Number.isFinite(parsedRatio) && parsedRatio > 0 ? { value, ratio: parsedRatio } : null;
    }).filter(Boolean);
    if (ratioCandidates.length) return ratioCandidates.reduce((best, candidate) => (
        Math.abs(Math.log(candidate.ratio / targetRatio)) < Math.abs(Math.log(best.ratio / targetRatio)) ? candidate : best
    )).value;

    const targetTier = Math.max(targetWidth, targetHeight);
    const tierCandidates = supported.map(value => {
        const match = String(value).trim().match(/^(\d+(?:\.\d+)?)k$/i);
        const size = match ? Number(match[1]) * 1024 : NaN;
        return Number.isFinite(size) && size > 0 ? { value, size } : null;
    }).filter(Boolean);
    if (tierCandidates.length) return tierCandidates.reduce((best, candidate) => (
        Math.abs(Math.log(candidate.size / targetTier)) < Math.abs(Math.log(best.size / targetTier)) ? candidate : best
    )).value;

    return supported[0];
}

export function getNanoGptEffectiveResolution(width, height, metadata = null) {
    const resolution = getNanoGptResolution(width, height, metadata);
    const match = String(resolution).trim().match(/^(\d+)\s*[x*]\s*(\d+)$/i);
    if (!match) return { resolution };
    return { resolution, width: Number(match[1]), height: Number(match[2]) };
}

export const REPLICATE_SDXL_MODEL = "stability-ai/sdxl";
export const REPLICATE_SDXL_VERSION = "39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b";

export function validateReplicateSdxlVersion(value) {
    const configured = String(value || `${REPLICATE_SDXL_MODEL}:${REPLICATE_SDXL_VERSION}`).trim();
    const supported = `${REPLICATE_SDXL_MODEL}:${REPLICATE_SDXL_VERSION}`;
    if (configured.toLowerCase() !== supported) {
        throw new Error(`Replicate currently supports only ${supported}; Flux, other model families, and unverified SDXL versions require model-specific input schemas`);
    }
    return supported;
}

export function getGlmImageResolution(width, height) {
    return getNanoGptResolution(width, height, {
        supported_parameters: {
            resolutions: ["1024x1024", "864x1152", "768x1344", "1152x864", "1344x768", "1440x720", "720x1440"],
        },
    });
}

export function getProviderGenerationCapabilities(provider, settings = {}, customCapabilities = null) {
    if (provider === "custom" && customCapabilities) {
        const seed = customCapabilities.seed !== false;
        return {
            steps: customCapabilities.steps !== false,
            cfgScale: customCapabilities.cfgScale !== false,
            sampler: customCapabilities.sampler !== false,
            seed,
            sequentialSeeds: seed,
        };
    }
    if (provider === "proxy") {
        return settings?.proxyPayloadMode === "openai_strict"
            ? NO_DIFFUSION_CONTROLS
            : ALL_CONTROLS;
    }
    if (provider === "nanogpt" && (settings?.nanogptModel || settings?.__qigNanoGptModelMetadata)) {
        return getNanoGptModelCapabilities(settings?.nanogptModel, settings?.__qigNanoGptModelMetadata);
    }
    return PROVIDER_GENERATION_CAPABILITIES[provider] || ALL_CONTROLS;
}

export function getFalEffectiveSteps(model, steps) {
    const configured = Number(steps);
    const fallback = /(?:^|\/)flux\/schnell(?:$|\/)/i.test(String(model || "")) ? 12 : 25;
    const normalized = Number.isFinite(configured) ? Math.max(1, Math.trunc(configured)) : fallback;
    return /(?:^|\/)flux\/schnell(?:$|\/)/i.test(String(model || ""))
        ? Math.min(12, normalized)
        : normalized;
}

export function getFalEffectiveGuidance(model, guidance) {
    const configured = Number(guidance);
    const normalized = Number.isFinite(configured) ? configured : 7;
    return /(?:^|\/)flux\/schnell(?:$|\/)/i.test(String(model || ""))
        ? Math.max(1, Math.min(20, normalized))
        : normalized;
}
