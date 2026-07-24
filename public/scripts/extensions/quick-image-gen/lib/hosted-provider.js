import { MAX_PROVIDER_RESPONSE_BYTES, normalizeImageSource } from "./security.js";

export const HOSTED_PROVIDER_IDS = new Set([
    "pollinations", "novelai", "gptimage", "arliai", "routeway", "navy", "nanogpt",
    "chutes", "civitai", "nanobanana", "stability", "replicate", "fal", "together", "zai",
]);

export const PROVIDER_OUTPUT_HOST_SUFFIXES = Object.freeze({
    pollinations: ["pollinations.ai"],
    novelai: ["novelai.net"],
    gptimage: ["openai.com"],
    arliai: ["arliai.com"],
    routeway: ["routeway.ai"],
    navy: ["api.navy", "navy.ai"],
    nanogpt: ["nano-gpt.com"],
    chutes: ["chutes.ai"],
    civitai: ["civitai.com", "civitai.green", "civitai.red"],
    nanobanana: ["googleapis.com", "googleusercontent.com"],
    stability: ["stability.ai"],
    replicate: ["replicate.com", "replicate.delivery"],
    fal: ["fal.ai", "fal.run", "fal.media"],
    together: ["together.ai", "together.xyz"],
    zai: ["z.ai", "sfile.chatglm.cn", "cdn.bigmodel.cn"],
});

function hostMatchesSuffix(hostname, suffix) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    const normalizedSuffix = String(suffix || "").toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    return !!host && !!normalizedSuffix && (host === normalizedSuffix || host.endsWith(`.${normalizedSuffix}`));
}

export function isTrustedProviderOutputUrl(provider, value, requestUrl = "", {
    trustedOutputOrigins = [],
    allowRequestSubdomains = false,
} = {}) {
    try {
        const request = requestUrl ? new URL(requestUrl, globalThis.location?.href || "http://localhost/") : null;
        const output = new URL(value, request?.href || globalThis.location?.href || "http://localhost/");
        if (output.username || output.password || !["http:", "https:"].includes(output.protocol)) return false;
        if (request && output.origin === request.origin) return true;
        const normalized = normalizeImageSource(output.href, {
            allowHttp: false,
            allowRelative: false,
            blockPrivateHosts: true,
        });
        if (!normalized) return false;
        const explicitOrigins = new Set(trustedOutputOrigins.map(origin => {
            try { return new URL(origin).origin; } catch { return ""; }
        }).filter(Boolean));
        if (explicitOrigins.has(output.origin)) return true;
        if (allowRequestSubdomains && request?.protocol === "https:") {
            const requestHost = request.hostname.toLowerCase().replace(/\.$/, "");
            const outputHost = output.hostname.toLowerCase().replace(/\.$/, "");
            const requestLabels = requestHost.split(".");
            const outputLabels = outputHost.split(".");
            if (requestLabels.length >= 3
                && outputLabels.length === requestLabels.length + 1
                && outputHost.endsWith(`.${requestHost}`)) {
                return true;
            }
        }
        return (PROVIDER_OUTPUT_HOST_SUFFIXES[provider] || []).some(suffix => hostMatchesSuffix(output.hostname, suffix));
    } catch {
        return false;
    }
}

export function createHostedProviderDeadline(parentSignal, timeoutSeconds, providerName = "Provider") {
    const numeric = Number(timeoutSeconds);
    const seconds = Math.max(30, Math.min(1800, Number.isFinite(numeric) ? numeric : 300));
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException(`${providerName} timed out`, "TimeoutError"));
    }, seconds * 1000);

    return {
        signal: controller.signal,
        deadline: Date.now() + seconds * 1000,
        seconds,
        didTimeOut: () => timedOut,
        timeoutError() {
            const error = new Error(`${providerName} timed out after ${seconds} seconds`);
            error.code = "PROVIDER_DEADLINE_TIMEOUT";
            return error;
        },
        dispose() {
            clearTimeout(timeoutId);
            parentSignal?.removeEventListener("abort", abortFromParent);
        },
    };
}

export function abortableSleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Generation cancelled", "AbortError"));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(finish, Math.max(0, Number(ms) || 0));
        function finish() {
            signal?.removeEventListener("abort", abort);
            resolve();
        }
        function abort() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(signal.reason instanceof Error ? signal.reason : new DOMException("Generation cancelled", "AbortError"));
        }
        signal?.addEventListener("abort", abort, { once: true });
    });
}

export function isTransientProviderStatus(status) {
    const code = Number(status);
    return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

export function getRetryAfterMs(response, fallbackMs = 1500) {
    const value = String(response?.headers?.get?.("retry-after") || "").trim();
    if (!value) return fallbackMs;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(30_000, seconds * 1000));
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, Math.min(30_000, date - Date.now())) : fallbackMs;
}

export function mapCivitaiSdcppSampler(value) {
    const label = String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    if (label === "euler") return { sampleMethod: "euler", schedule: "discrete" };
    if (label === "euler a" || label === "eulera" || label === "euler ancestral") {
        return { sampleMethod: "euler_a", schedule: "discrete" };
    }
    if (label === "dpm++ 2m" || label === "dpmpp 2m" || label === "dpm++ 2m karras" || label === "dpmpp 2m karras") {
        return { sampleMethod: "dpm++2m", schedule: label.includes("karras") ? "karras" : "discrete" };
    }
    if (label === "ddim") return { sampleMethod: "ddim_trailing", schedule: "discrete" };
    throw new Error(`Unsupported CivitAI sampler: ${String(value || "(empty)")}`);
}

export function inferCivitaiEcosystem(air) {
    const ecosystem = String(air || "").match(/^urn:air:([^:]+):/i)?.[1]?.toLowerCase();
    if (ecosystem === "sd1" || ecosystem === "sdxl") return ecosystem;
    throw new Error(`Unsupported CivitAI AIR ecosystem: ${ecosystem || "unknown"}`);
}

export function extractCivitaiFailureReason(workflow) {
    const candidates = [
        workflow?.blockedReason,
        workflow?.reason,
        workflow?.error?.message,
        workflow?.error,
        workflow?.message,
    ];
    for (const step of workflow?.steps || []) {
        candidates.push(step?.blockedReason, step?.reason, step?.error?.message, step?.error, step?.message);
        for (const job of step?.jobs || step?.output?.jobs || []) {
            candidates.push(job?.blockedReason, job?.reason, job?.error?.message, job?.error, job?.message);
        }
    }
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 1000);
    }
    return "";
}

export function buildNovelAIProxyRequestUrl(value, mode = "generate") {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
        const url = new URL(raw);
        const path = url.pathname.replace(/\/+$/, "");
        if (mode === "chat") {
            if (/\/chat\/completions$/i.test(path)) url.pathname = path;
            else if (/\/generate$/i.test(path)) url.pathname = path.replace(/\/generate$/i, "/chat/completions");
            else url.pathname = `${path}/chat/completions`;
        } else if (/\/generate$/i.test(path)) {
            url.pathname = path;
        } else if (/\/chat\/completions$/i.test(path)) {
            url.pathname = path.replace(/\/chat\/completions$/i, "/generate");
        } else if (/\/v1$/i.test(path)) {
            url.pathname = path.replace(/\/v1$/i, "/generate");
        } else {
            url.pathname = `${path}/generate`;
        }
        return url.toString();
    } catch {
        return "";
    }
}

export function looksLikeSsePayload(value) {
    const text = String(value || "").trim();
    if (/^https?:\/\/\S+$/i.test(text) || /^data:image\//i.test(text)) return false;
    return /(?:^|\r\n|\r|\n)(?:data|event|id|retry):(?: |[^\r\n])*/.test(text);
}

export function parseCivitaiLoras(value) {
    const loras = {};
    for (const entry of String(value || "").split(",")) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const lastColon = trimmed.lastIndexOf(":");
        const strengthText = trimmed.slice(lastColon + 1).trim();
        const hasStrength = lastColon > 0 && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(strengthText);
        const parsedStrength = hasStrength ? Number(strengthText) : 1;
        const air = (hasStrength ? trimmed.slice(0, lastColon) : trimmed).trim();
        if (air) loras[air] = hasStrength ? parsedStrength : 1;
    }
    return loras;
}

export function buildCivitaiWorkflowBody({
    model,
    prompt,
    negativePrompt,
    sampler,
    steps,
    cfgScale,
    width,
    height,
    seed,
    loras,
}) {
    const { sampleMethod, schedule } = mapCivitaiSdcppSampler(sampler);
    return {
        steps: [{
            $type: "imageGen",
            input: {
                engine: "sdcpp",
                ecosystem: inferCivitaiEcosystem(model),
                operation: "createImage",
                model,
                prompt,
                negativePrompt,
                sampleMethod,
                schedule,
                steps,
                cfgScale,
                width,
                height,
                seed,
                loras: loras || {},
                quantity: 1,
            },
        }],
    };
}

export function getCivitaiWorkflowImageUrls(response) {
    const urls = [];
    for (const step of response?.steps || []) {
        for (const image of step?.output?.images || []) {
            if (typeof image?.url === "string" && image.url.trim()) urls.push(image.url.trim());
        }
    }
    return urls;
}

export async function fetchCivitaiOutput(url, apiKey, {
    fetchImpl = globalThis.fetch,
    signal,
} = {}) {
    const orchestrationOrigin = "https://orchestration.civitai.com";
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error("CivitAI returned an invalid output URL");
    }
    if (!isTrustedProviderOutputUrl("civitai", parsed.href, orchestrationOrigin)) {
        throw new Error("CivitAI returned an untrusted output URL");
    }

    const isOrchestrationOutput = parsed.origin === orchestrationOrigin;
    const response = await fetchImpl(parsed.href, {
        method: "GET",
        headers: isOrchestrationOutput ? { Authorization: `Bearer ${apiKey}` } : {},
        redirect: isOrchestrationOutput ? "manual" : "error",
        signal,
    });
    if (response.type === "opaqueredirect") {
        throw new Error("CivitAI returned a browser-opaque output redirect; the relay must expose and validate the 308 Location before downloading without credentials");
    }
    if (response.status !== 308) return response;
    if (!isOrchestrationOutput) throw new Error("CivitAI output host returned an unexpected redirect");

    const location = response.headers.get("location");
    let destination;
    try {
        destination = new URL(location, parsed.href);
    } catch {
        throw new Error("CivitAI output redirect did not include a valid Location");
    }
    if (destination.origin === orchestrationOrigin
        || !isTrustedProviderOutputUrl("civitai", destination.href, orchestrationOrigin)) {
        throw new Error("CivitAI output redirected to an untrusted host");
    }
    return fetchImpl(destination.href, {
        method: "GET",
        headers: {},
        redirect: "error",
        signal,
    });
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function hasPngSignature(bytes, offset) {
    return PNG_SIGNATURE.every((value, index) => bytes[offset + index] === value);
}

export function findEmbeddedPngRange(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
    for (let start = 0; start <= bytes.length - PNG_SIGNATURE.length; start++) {
        if (!hasPngSignature(bytes, start)) continue;
        let offset = start + PNG_SIGNATURE.length;
        let chunkIndex = 0;
        while (offset <= bytes.length - 12) {
            const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
            const chunkEnd = offset + 12 + length;
            if (chunkEnd > bytes.length) break;
            const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
            if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) break;
            if (type === "IEND") {
                if (length === 0) return { start, end: chunkEnd };
                break;
            }
            offset = chunkEnd;
            chunkIndex += 1;
        }
    }
    return null;
}

export async function readSseDataStream(response, onEvent, {
    maxBytes = MAX_PROVIDER_RESPONSE_BYTES,
    signal,
} = {}) {
    if (!response?.body?.getReader) throw new Error("SSE response body is not streamable");
    const reader = response.body.getReader();
    const abort = () => reader.cancel(signal?.reason || "SSE request aborted").catch(() => {});
    if (signal?.aborted) {
        await abort();
        reader.releaseLock();
        throw signal.reason instanceof Error ? signal.reason : new DOMException("Generation cancelled", "AbortError");
    }
    signal?.addEventListener("abort", abort, { once: true });
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines = [];
    let total = 0;
    let lastValue;
    let sawProvisionalValue = false;
    let eventCount = 0;

    async function dispatch() {
        if (!dataLines.length) return false;
        const data = dataLines.join("\n");
        dataLines = [];
        eventCount += 1;
        if (data.trim() === "[DONE]") return true;
        const result = await onEvent(data);
        if (result && Object.prototype.hasOwnProperty.call(result, "value") && result.value != null) {
            if (result.provisional === true) sawProvisionalValue = true;
            else lastValue = result.value;
        }
        return result?.terminal === true;
    }

    async function consumeLine(line) {
        const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!normalized) return dispatch();
        if (normalized.startsWith(":")) return false;
        if (normalized === "data") dataLines.push("");
        else if (normalized.startsWith("data:")) dataLines.push(normalized.slice(5).replace(/^ /, ""));
        return false;
    }

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel("SSE response is too large");
                throw new Error("SSE response is too large");
            }
            buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.search(/[\r\n]/)) >= 0) {
                if (buffer[newline] === "\r" && newline === buffer.length - 1) break;
                const line = buffer.slice(0, newline);
                const delimiterLength = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
                buffer = buffer.slice(newline + delimiterLength);
                if (await consumeLine(line)) {
                    await reader.cancel("SSE stream completed").catch(() => {});
                    return { value: lastValue, eventCount, provisionalOnly: lastValue == null && sawProvisionalValue };
                }
            }
        }
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new DOMException("Generation cancelled", "AbortError");
        }
        buffer += decoder.decode();
        if (buffer && await consumeLine(buffer)) {
            return { value: lastValue, eventCount, provisionalOnly: lastValue == null && sawProvisionalValue };
        }
        await dispatch();
        return { value: lastValue, eventCount, provisionalOnly: lastValue == null && sawProvisionalValue };
    } finally {
        signal?.removeEventListener("abort", abort);
        reader.releaseLock();
    }
}
