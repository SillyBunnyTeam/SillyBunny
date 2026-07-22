import { redactUrlCredentials } from "./security.js";
import { getCustomBackendCapabilities } from "./custom-backend.js";

const PRIVATE_FIELD = /(?:ApiKey|Key|Token|Secret|Password|RefImages?|RefImage|ControlNetImage|LocalRefImage|ImageBase64|Url|Endpoint)$/;
const KNOWN_PRIVATE_FIELD = /^(?:apiKey|key|token|secret|password|(?:proxy|nai|gptImage|pollinations|arli|routeway|navy|nanoGpt|chutes|civitai|nanobanana|stability|replicate|fal|together|zai|gemini|comfy)(?:Api)?Key|url|endpoint)$/i;
const MAX_SNAPSHOT_STRING = 16_384;

function sanitizeValue(value, key = "", seen = new WeakSet()) {
    if (/^customApi/.test(key) || PRIVATE_FIELD.test(key) || KNOWN_PRIVATE_FIELD.test(key)) return undefined;
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
        if (value.length > MAX_SNAPSHOT_STRING) return undefined;
        return redactUrlCredentials(value);
    }
    if (typeof value !== "object") return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, 100).map((item) => sanitizeValue(item, key, seen)).filter((item) => item !== undefined);
    }

    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
        if (childKey.startsWith("__")) continue;
        const sanitized = sanitizeValue(childValue, childKey, seen);
        if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
}

export function sanitizeReproducibleSettings(settings) {
    return sanitizeValue(settings || {}) || {};
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
    const size = mappedSize(provider, settings || {}, capabilities);
    const proxyStrict = provider === "proxy" && settings?.proxyPayloadMode === "openai_strict";
    const noSteps = ["gptimage", "nanobanana", "nanogpt", "pollinations", "routeway", "navy", "zai"].includes(provider) || proxyStrict || (capabilities && !capabilities.steps);
    const noCfg = ["gptimage", "nanobanana", "nanogpt", "pollinations", "routeway", "navy", "zai"].includes(provider) || proxyStrict || (capabilities && !capabilities.cfgScale);
    const noSampler = ["chutes", "civitai", "fal", "gptimage", "nanobanana", "nanogpt", "pollinations", "routeway", "navy", "stability", "together", "zai"].includes(provider) || proxyStrict || (capabilities && !capabilities.sampler);
    const noSeed = ["gptimage", "nanobanana", "nanogpt", "routeway", "navy", "zai"].includes(provider) || proxyStrict || (capabilities && !capabilities.seed);
    let steps = noSteps ? undefined : Number(settings?.steps);
    if (provider === "proxy" && !proxyStrict) steps = Number(settings?.proxySteps ?? settings?.steps);
    if (provider === "stability" && Number.isFinite(steps)) steps = Math.min(50, Math.max(10, steps));
    if (provider === "together" && Number.isFinite(steps)) steps = Math.min(50, steps);

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

    return {
        version: 1,
        provider,
        parameters,
        settings: sanitizeReproducibleSettings(settings),
    };
}

export function normalizeProviderResult(result, settings, options = {}) {
    if (result && typeof result === "object" && typeof result.url === "string") {
        const supplied = result.effectiveRequest || {};
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
        effectiveRequest: createEffectiveRequest(settings, options),
    };
}
