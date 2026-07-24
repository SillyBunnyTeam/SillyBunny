import { redactUrlCredentials, sanitizeReproducibleModel } from "./security.js";
import { getCustomBackendCapabilities } from "./custom-backend.js";
import { getFalEffectiveSteps, getProviderGenerationCapabilities } from "./provider-capabilities.js";

const MAX_SNAPSHOT_STRING = 16_384;
const MAX_REPRODUCIBLE_SNAPSHOT_BYTES = 16 * 1024;

const COMMON_REPRODUCIBLE_FIELDS = Object.freeze([
    "provider", "model", "width", "height", "steps", "cfgScale", "sampler", "seed",
    "batchCount", "sequentialSeeds",
]);

const PROVIDER_REPRODUCIBLE_FIELDS = Object.freeze({
    pollinations: ["pollinationsModel"],
    novelai: ["naiModel"],
    gptimage: ["gptImageModel", "gptImageQuality", "gptImageFormat", "gptImageBackground", "gptImageModeration"],
    arliai: ["arliModel"],
    routeway: ["routewayModel"],
    navy: ["navyModel"],
    nanogpt: ["nanogptModel", "nanogptStrength"],
    chutes: ["chutesModel"],
    civitai: ["civitaiModel", "civitaiScheduler", "civitaiLoras"],
    nanobanana: [
        "nanobananaModel", "nanobananaNbpMode", "nanobananaNbpPreset", "nanobananaNbpUseNegative",
        "nanobananaNbpCustomDirector", "nanobananaNbpCustomPrompt", "nanobananaExtraInstructions",
    ],
    stability: [],
    replicate: ["replicateModel"],
    fal: ["falModel"],
    together: ["togetherModel"],
    zai: ["zaiModel", "zaiQuality"],
    local: [
        "localType", "localModel", "localDenoise",
        "a1111Model", "a1111ClipSkip", "a1111Scheduler", "a1111RestoreFaces", "a1111Tiling",
        "a1111Subseed", "a1111SubseedStrength", "a1111Adetailer", "a1111AdetailerModel",
        "a1111AdetailerPrompt", "a1111AdetailerNegative", "a1111AdetailerDenoise",
        "a1111AdetailerConfidence", "a1111AdetailerMaskBlur", "a1111AdetailerDilateErode",
        "a1111AdetailerInpaintOnlyMasked", "a1111AdetailerInpaintPadding", "a1111Adetailer2",
        "a1111Adetailer2Model", "a1111Adetailer2Prompt", "a1111Adetailer2Negative",
        "a1111Adetailer2Denoise", "a1111Adetailer2Confidence", "a1111Adetailer2MaskBlur",
        "a1111Adetailer2DilateErode", "a1111Adetailer2InpaintOnlyMasked", "a1111Adetailer2InpaintPadding",
        "a1111Loras", "a1111Vae", "a1111HiresFix", "a1111HiresUpscaler", "a1111HiresScale",
        "a1111HiresSteps", "a1111HiresDenoise", "a1111HiresSampler", "a1111HiresScheduler",
        "a1111HiresPrompt", "a1111HiresNegative", "a1111HiresResizeX", "a1111HiresResizeY",
        "a1111SaveToWebUI", "a1111IpAdapter", "a1111IpAdapterMode", "a1111IpAdapterWeight",
        "a1111IpAdapterPixelPerfect", "a1111IpAdapterResizeMode", "a1111IpAdapterControlMode",
        "a1111IpAdapterStartStep", "a1111IpAdapterEndStep", "a1111ControlNet", "a1111ControlNetModel",
        "a1111ControlNetModule", "a1111ControlNetWeight", "a1111ControlNetResizeMode",
        "a1111ControlNetControlMode", "a1111ControlNetPixelPerfect", "a1111ControlNetGuidanceStart",
        "a1111ControlNetGuidanceEnd", "comfyModelLoader", "comfyClipSkip", "comfyDenoise",
        "comfyScheduler", "comfyTimeout", "comfyUpscale", "comfyUpscaleModel", "comfyLoras",
        "comfyOutputNodeIds", "comfyOutputImageIndex", "comfySkipNegativePrompt",
        "comfyFluxClipModel1", "comfyFluxClipModel2", "comfyFluxVaeModel", "comfyFluxClipType",
    ],
    proxy: [
        "proxyModel", "proxyLoras", "proxyFacefix", "proxySteps", "proxyCfg", "proxySampler", "proxySeed",
        "proxyExtraInstructions", "proxyEndpointMode", "proxyPayloadMode", "proxyRefImageMode", "proxySse",
        "proxyTimeout", "proxyComfyMode", "proxyComfyTimeout", "proxyComfyNodeId",
        "proxyChatImageMode", "proxyChatImageAllowImagesEndpoint", "proxyChatImageSystemPrompt",
        "proxyChatImageIncludePersonality", "proxyChatImageMaxTokens",
    ],
    // Custom API endpoints, authentication, models, mappings, and templates are local trust configuration.
    custom: [],
});

const EXECUTABLE_OR_PRIVATE_FIELD = /(?:api.?key|key$|token|secret|password|credential|authorization|ref.*image|image.*ref|control.*image|imagebase64|url$|endpoint$|workflow|allowlegacyinterrupt|requesttemplate)/i;
const EFFECTIVE_PARAMETER_FIELDS = Object.freeze([
    "model", "width", "height", "steps", "cfgScale", "sampler", "seed", "schedule",
    "aspectRatio", "imageSize", "outputNode", "outputImageIndex",
]);
const textEncoder = new TextEncoder();

function sanitizeEffectiveParameter(key, value, provider) {
    const numericBounds = {
        width: [256, 2048, true],
        height: [256, 2048, true],
        steps: [1, 150, true],
        cfgScale: [provider === "proxy" ? 0 : 1, 30, false],
        seed: [0, 0xffffffff, true],
        outputImageIndex: [-1, 10_000, true],
    };
    if (numericBounds[key]) {
        if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
        const [min, max, integer] = numericBounds[key];
        const bounded = Math.min(max, Math.max(min, value));
        return integer ? Math.trunc(bounded) : bounded;
    }
    if (key === "model" && provider === "custom") return undefined;
    if (value === null && key === "model") return null;
    if (typeof value !== "string") return undefined;
    const bounded = value.slice(0, 200);
    return key === "model" ? sanitizeReproducibleModel(bounded, provider) : bounded;
}

function sanitizeValue(value, key = "", seen = new WeakSet(), depth = 0) {
    if (key.startsWith("_") || /^customApi/i.test(key) || EXECUTABLE_OR_PRIVATE_FIELD.test(key) || depth > 8) return undefined;
    if (value == null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "string") {
        if (value.length > MAX_SNAPSHOT_STRING) return undefined;
        return /model$/i.test(key) ? sanitizeReproducibleModel(value) : redactUrlCredentials(value);
    }
    if (typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, 100).map((item) => sanitizeValue(item, key, seen, depth + 1)).filter((item) => item !== undefined);
    }

    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 200)) {
        const sanitized = sanitizeValue(childValue, childKey, seen, depth + 1);
        if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
}

export function sanitizeReproducibleSettings(settings, options = {}) {
    const source = settings && typeof settings === "object" ? settings : {};
    const requestedProvider = String(
        Object.prototype.hasOwnProperty.call(options, "provider") ? options.provider || "" : source.provider || "",
    ).toLowerCase();
    const provider = Object.prototype.hasOwnProperty.call(PROVIDER_REPRODUCIBLE_FIELDS, requestedProvider)
        ? requestedProvider
        : "";
    const allowedFields = new Set([
        ...COMMON_REPRODUCIBLE_FIELDS,
        ...(PROVIDER_REPRODUCIBLE_FIELDS[provider] || []),
    ]);
    const result = {};
    for (const key of allowedFields) {
        if (key === "provider") continue;
        if (provider === "custom" && key === "model") continue;
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const sanitized = sanitizeValue(source[key], key);
        if (sanitized === undefined) continue;
        const candidate = { ...result, [key]: sanitized };
        if (textEncoder.encode(JSON.stringify(candidate)).byteLength <= MAX_REPRODUCIBLE_SNAPSHOT_BYTES) {
            result[key] = sanitized;
        }
    }
    if (provider) result.provider = provider;
    return result;
}

export function sanitizeEffectiveRequest(request) {
    const source = request && typeof request === "object" && !Array.isArray(request) ? request : {};
    const requestedProvider = String(source.provider || "").toLowerCase();
    const provider = Object.prototype.hasOwnProperty.call(PROVIDER_REPRODUCIBLE_FIELDS, requestedProvider)
        ? requestedProvider
        : "";
    const sourceParameters = source.parameters && typeof source.parameters === "object" && !Array.isArray(source.parameters)
        ? source.parameters
        : {};
    const parameters = {};
    for (const key of EFFECTIVE_PARAMETER_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(sourceParameters, key)) continue;
        const value = sanitizeEffectiveParameter(key, sourceParameters[key], provider);
        if (value !== undefined) parameters[key] = value;
    }
    return {
        version: 1,
        provider,
        parameters,
        settings: sanitizeReproducibleSettings(source.settings || {}, { provider }),
    };
}

function customCapabilities(settings) {
    if (settings?.provider !== "custom") return null;
    try {
        return getCustomBackendCapabilities(settings.customApiRequestTemplate);
    } catch {
        return null;
    }
}

function mappedSize(provider, settings, capabilities = null) {
    const width = Number(settings.width) || 1024;
    const height = Number(settings.height) || 1024;
    if (provider === "gptimage") {
        if (width === height) return { width: 1024, height: 1024 };
        return width > height ? { width: 1536, height: 1024 } : { width: 1024, height: 1536 };
    }
    if (provider === "nanobanana") return {};
    if (provider === "custom" && capabilities) {
        return {
            ...(capabilities.width ? { width } : {}),
            ...(capabilities.height ? { height } : {}),
        };
    }
    return { width, height };
}

export function createEffectiveRequest(settings, options = {}) {
    const provider = String(options.provider || settings?.provider || "");
    const capabilities = customCapabilities({ ...(settings || {}), provider });
    const providerCapabilities = getProviderGenerationCapabilities(provider, settings, capabilities);
    const size = mappedSize(provider, settings || {}, capabilities);
    const noSteps = !providerCapabilities.steps;
    const noCfg = !providerCapabilities.cfgScale;
    const noSampler = !providerCapabilities.sampler;
    const noSeed = !providerCapabilities.seed;
    let steps = noSteps ? undefined : Number(settings?.steps);
    if (provider === "proxy" && providerCapabilities.steps) steps = Number(settings?.proxySteps ?? settings?.steps);
    if (provider === "stability" && Number.isFinite(steps)) steps = Math.min(50, Math.max(10, steps));
    if (provider === "together" && Number.isFinite(steps)) steps = Math.min(50, steps);
    if (provider === "fal") steps = getFalEffectiveSteps(options.model ?? settings?.falModel, steps);

    const configuredSeed = provider === "proxy" ? settings?.proxySeed : settings?.seed;
    const resolvedSeed = Number.isFinite(options.resolvedSeed)
        ? options.resolvedSeed
        : (Number.isFinite(configuredSeed) && configuredSeed >= 0 ? configuredSeed : undefined);
    const parameters = {
        model: provider === "custom" && capabilities && !capabilities.model ? undefined : (options.model ?? null),
        width: size.width,
        height: size.height,
        steps: Number.isFinite(steps) ? steps : undefined,
        cfgScale: noCfg ? undefined : Number(provider === "proxy" ? (settings?.proxyCfg ?? settings?.cfgScale) : settings?.cfgScale),
        sampler: noSampler ? undefined : (provider === "proxy" ? (settings?.proxySampler || settings?.sampler) : settings?.sampler),
        seed: noSeed ? undefined : resolvedSeed,
        ...(options.parameters || {}),
    };

    for (const [key, value] of Object.entries(parameters)) {
        if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) delete parameters[key];
    }

    return sanitizeEffectiveRequest({
        version: 1,
        provider,
        parameters,
        settings: sanitizeReproducibleSettings(settings, { provider }),
    });
}

function normalizeSingleProviderResult(result, settings, options = {}, inheritedRequest = {}) {
    if (result && typeof result === "object" && typeof result.url === "string") {
        const supplied = {
            ...inheritedRequest,
            ...(result.effectiveRequest || {}),
            parameters: {
                ...(inheritedRequest.parameters || {}),
                ...(result.effectiveRequest?.parameters || {}),
            },
        };
        return {
            url: result.url,
            effectiveRequest: createEffectiveRequest(settings, {
                ...options,
                ...(supplied.provider ? { provider: supplied.provider } : {}),
                parameters: { ...(options.parameters || {}), ...(supplied.parameters || {}) },
            }),
        };
    }
    return {
        url: result,
        effectiveRequest: createEffectiveRequest(settings, {
            ...options,
            ...(inheritedRequest.provider ? { provider: inheritedRequest.provider } : {}),
            parameters: { ...(options.parameters || {}), ...(inheritedRequest.parameters || {}) },
        }),
    };
}

export function normalizeProviderResult(result, settings, options = {}) {
    if (result && typeof result === "object" && Array.isArray(result.images)) {
        const inheritedRequest = result.effectiveRequest || {};
        return result.images.map(image => normalizeSingleProviderResult(image, settings, options, inheritedRequest));
    }
    return normalizeSingleProviderResult(result, settings, options);
}
