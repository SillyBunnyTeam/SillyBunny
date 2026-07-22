import {
    MAX_IMAGE_BYTES,
    MAX_PROVIDER_RESPONSE_BYTES,
    normalizeImageSource,
    readResponseArrayBuffer,
    readResponseJson,
    readResponseText,
} from "./security.js";
import { detectImageFormat } from "./image-metadata.js";

const MAX_TEMPLATE_LENGTH = 64 * 1024;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_TEMPLATE_DEPTH = 24;
const MAX_TEMPLATE_NODES = 5_000;
const MAX_REFERENCE_BYTES = MAX_IMAGE_BYTES;
const TEMPLATE_TOKEN = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;
const POLL_JOB_ID_SENTINEL = "qig-job-id-placeholder-6f7c1e";
const FORBIDDEN_TEMPLATE_KEY = /(?:^|[_-])(?:__proto__|prototype|constructor|api[_-]?key|access[_-]?token|authorization|auth(?:[_-]?token)?|token|secret|password|passwd|credentials?|session(?:[_-]?id)?)(?:$|[_-])/i;
const SAFE_REFERENCE_MIME = new Set(["image/avif", "image/bmp", "image/gif", "image/jpeg", "image/png", "image/tiff", "image/webp"]);
const ALLOWED_TOKENS = new Set([
    "prompt", "negative", "model", "width", "height", "size", "steps",
    "cfgScale", "sampler", "seed", "referenceImages", "firstReferenceImage",
]);

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function parseList(value, fallback = []) {
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    const items = String(value || "").split(",").map(item => item.trim()).filter(Boolean);
    return items.length ? items : fallback;
}

function parseHttpUrl(value, label) {
    let parsed;
    try {
        parsed = new URL(String(value || "").trim());
    } catch {
        throw new Error(`${label} must be an absolute HTTP or HTTPS URL`);
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error(`${label} must be an HTTP or HTTPS URL without embedded credentials`);
    }
    return parsed;
}

function normalizePointer(pointer, label, { required = false } = {}) {
    const value = String(pointer || "").trim();
    if (!value && !required) return "";
    if (!value.startsWith("/")) throw new Error(`${label} must be an RFC 6901 JSON Pointer beginning with /`);
    if (value.length > 512) throw new Error(`${label} is too long`);
    return value;
}

export function resolveJsonPointer(value, pointer) {
    const normalized = String(pointer || "").trim();
    if (!normalized) return value;
    if (!normalized.startsWith("/")) return undefined;
    return normalized.slice(1).split("/").reduce((current, segment) => {
        if (current == null) return undefined;
        const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
        return Object.prototype.hasOwnProperty.call(Object(current), key) ? current[key] : undefined;
    }, value);
}

function validateTemplateTokens(value, depth = 0, state = { nodes: 0 }) {
    if (depth > MAX_TEMPLATE_DEPTH) throw new Error("Request template is nested too deeply");
    state.nodes += 1;
    if (state.nodes > MAX_TEMPLATE_NODES) throw new Error("Request template contains too many values");
    if (typeof value === "string") {
        for (const match of value.matchAll(TEMPLATE_TOKEN)) {
            if (!ALLOWED_TOKENS.has(match[1])) throw new Error(`Unsupported request token: {{${match[1]}}}`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(item => validateTemplateTokens(item, depth + 1, state));
        return;
    }
    if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            if (FORBIDDEN_TEMPLATE_KEY.test(key)) {
                throw new Error(`Request template field is reserved for authentication: ${key}`);
            }
            validateTemplateTokens(item, depth + 1, state);
        }
    }
}

export function parseCustomRequestTemplate(template) {
    const source = String(template || "").trim();
    if (!source) throw new Error("Request JSON template is required");
    if (source.length > MAX_TEMPLATE_LENGTH) throw new Error("Request JSON template is too large");
    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch {
        throw new Error("Request template must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Request template must contain a JSON object");
    }
    validateTemplateTokens(parsed);
    return parsed;
}

function collectTemplateTokens(value, tokens = new Set()) {
    if (typeof value === "string") {
        for (const match of value.matchAll(TEMPLATE_TOKEN)) tokens.add(match[1]);
    } else if (Array.isArray(value)) {
        value.forEach(item => collectTemplateTokens(item, tokens));
    } else if (value && typeof value === "object") {
        Object.values(value).forEach(item => collectTemplateTokens(item, tokens));
    }
    return tokens;
}

export function getCustomBackendCapabilities(template) {
    const tokens = collectTemplateTokens(parseCustomRequestTemplate(template));
    return {
        model: tokens.has("model"),
        width: tokens.has("width") || tokens.has("size"),
        height: tokens.has("height") || tokens.has("size"),
        size: tokens.has("size") || tokens.has("width") || tokens.has("height"),
        steps: tokens.has("steps"),
        cfgScale: tokens.has("cfgScale"),
        sampler: tokens.has("sampler"),
        seed: tokens.has("seed"),
        referenceImages: tokens.has("referenceImages") || tokens.has("firstReferenceImage"),
    };
}

function renderString(value, tokens) {
    const exact = value.match(/^\{\{([A-Za-z][A-Za-z0-9]*)\}\}$/);
    if (exact) return tokens[exact[1]];
    return value.replace(TEMPLATE_TOKEN, (_match, key) => {
        const token = tokens[key];
        if (token == null) return "";
        return typeof token === "object" ? JSON.stringify(token) : String(token);
    });
}

export function renderCustomTemplate(value, tokens) {
    if (typeof value === "string") return renderString(value, tokens);
    if (Array.isArray(value)) return value.map(item => renderCustomTemplate(item, tokens));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderCustomTemplate(item, tokens)]));
    }
    return value;
}

function dataUrlToBlob(value) {
    const match = String(value || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i);
    if (!match) return null;
    const mime = match[1].toLowerCase();
    if (!SAFE_REFERENCE_MIME.has(mime)) throw new Error("Reference image has an unsupported MIME type");
    const estimatedBytes = Math.floor(match[2].length * 3 / 4);
    if (estimatedBytes > MAX_IMAGE_BYTES) throw new Error("Reference image exceeds the configured size limit");
    const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Reference image exceeds the configured size limit");
    const format = detectImageFormat(bytes);
    if (!format || format.mime !== mime) throw new Error("Reference image data does not match its declared image type");
    return new Blob([bytes], { type: mime });
}

function appendMultipartValue(form, key, value) {
    if (value == null) return;
    if (Array.isArray(value)) {
        value.forEach(item => appendMultipartValue(form, key, item));
        return;
    }
    if (typeof value === "string") {
        const blob = dataUrlToBlob(value);
        if (blob) {
            form.append(key, blob, `reference.${blob.type.split("/")[1] || "png"}`);
            return;
        }
        form.append(key, value);
        return;
    }
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
}

function buildAuth(config, url, headers) {
    const key = String(config.apiKey || "");
    const authType = config.authType || "none";
    const authName = String(config.authName || "").trim();
    if (authType === "none" || !key) return;
    if (authType === "bearer") headers.Authorization = `Bearer ${key}`;
    else if (authType === "header") {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(authName)) throw new Error("API key header name is invalid");
        headers[authName] = key;
    } else if (authType === "query") {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(authName)) throw new Error("API key query parameter is invalid");
        url.searchParams.set(authName, key);
    } else if (authType === "basic") {
        headers.Authorization = `Basic ${btoa(key)}`;
    } else {
        throw new Error(`Unsupported authentication mode: ${authType}`);
    }
}

function isLoopbackUrl(url) {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
}

function assertSafeAuthDestination(url, authType, apiKey, label) {
    if (authType === "none" || !apiKey || url.protocol === "https:") return;
    if (url.protocol === "http:" && isLoopbackUrl(url)) return;
    throw new Error(`${label} must use HTTPS when authentication is enabled`);
}

export function normalizeCustomBackendConfig(config = {}) {
    const mode = ["json", "async"].includes(config.mode) ? config.mode : "json";
    const requestType = config.requestType === "multipart" ? "multipart" : "json";
    const method = String(config.method || "POST").toUpperCase();
    if (!["POST", "PUT", "PATCH"].includes(method)) throw new Error("Request method must be POST, PUT, or PATCH");
    const requestUrl = parseHttpUrl(config.url, "Request URL");
    const authType = ["none", "bearer", "header", "query", "basic"].includes(config.authType) ? config.authType : "none";
    const apiKey = String(config.apiKey || "");
    assertSafeAuthDestination(requestUrl, authType, apiKey, "Request URL");
    const normalized = {
        mode,
        url: requestUrl.href,
        method,
        requestType,
        authType,
        authName: String(config.authName || "X-API-Key").trim(),
        apiKey,
        requestTemplate: parseCustomRequestTemplate(config.requestTemplate),
        responsePath: normalizePointer(config.responsePath, "Image response path"),
        responseType: ["auto", "url", "base64"].includes(config.responseType) ? config.responseType : "auto",
        timeoutMs: clampInteger(config.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 120_000),
    };
    if (mode === "async") {
        normalized.jobIdPath = normalizePointer(config.jobIdPath, "Job ID path", { required: true });
        normalized.pollUrl = String(config.pollUrl || "").trim();
        if (!normalized.pollUrl.includes("{{jobId}}")) throw new Error("Polling URL must include {{jobId}}");
        if (normalized.pollUrl.includes(POLL_JOB_ID_SENTINEL)) throw new Error("Polling URL contains a reserved value");
        const probePollUrl = normalized.pollUrl.replaceAll("{{jobId}}", POLL_JOB_ID_SENTINEL);
        const pollUrl = parseHttpUrl(probePollUrl, "Polling URL");
        if (pollUrl.host.includes(POLL_JOB_ID_SENTINEL)) {
            throw new Error("Polling URL must keep {{jobId}} outside the scheme and authority");
        }
        assertSafeAuthDestination(pollUrl, authType, apiKey, "Polling URL");
        if (authType !== "none" && apiKey && pollUrl.origin !== requestUrl.origin) {
            throw new Error("Authenticated polling must use the same origin as the request URL");
        }
        normalized.pollUrl = pollUrl.href
            .replaceAll(POLL_JOB_ID_SENTINEL, "{{jobId}}");
        normalized.pollOrigin = pollUrl.origin;
        normalized.pollMethod = String(config.pollMethod || "GET").toUpperCase();
        if (!["GET", "POST"].includes(normalized.pollMethod)) throw new Error("Polling method must be GET or POST");
        normalized.statusPath = normalizePointer(config.statusPath, "Status path", { required: true });
        normalized.successValues = parseList(config.successValues, ["succeeded", "completed", "success"]);
        normalized.failureValues = parseList(config.failureValues, ["failed", "error", "cancelled", "canceled"]);
        normalized.pollIntervalMs = clampInteger(config.pollIntervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, 1_000);
    }
    return normalized;
}

function createTokens(input = {}) {
    const references = Array.isArray(input.referenceImages) ? input.referenceImages.filter(value => typeof value === "string" && value) : [];
    const referenceBytes = references.reduce((total, value) => {
        const match = value.match(/^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/i);
        return total + (match ? Math.floor(match[1].length * 3 / 4) : 0);
    }, 0);
    if (referenceBytes > MAX_REFERENCE_BYTES) throw new Error("Reference images exceed the 25 MB total request limit");
    return {
        prompt: String(input.prompt || ""),
        negative: String(input.negative || ""),
        model: String(input.model || ""),
        width: Number(input.width),
        height: Number(input.height),
        size: `${Number(input.width)}x${Number(input.height)}`,
        steps: Number(input.steps),
        cfgScale: Number(input.cfgScale),
        sampler: String(input.sampler || ""),
        seed: Number(input.seed),
        referenceImages: references,
        firstReferenceImage: references[0] || "",
    };
}

export function buildCustomBackendRequest(config, input = {}) {
    const normalized = normalizeCustomBackendConfig(config);
    const url = new URL(normalized.url);
    const headers = { Accept: "application/json, image/*" };
    buildAuth(normalized, url, headers);
    const rendered = renderCustomTemplate(normalized.requestTemplate, createTokens(input));
    let body;
    if (normalized.requestType === "multipart") {
        body = new FormData();
        Object.entries(rendered).forEach(([key, value]) => appendMultipartValue(body, key, value));
    } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(rendered);
    }
    return { config: normalized, url: url.href, method: normalized.method, headers, body };
}

function imageFromValue(value, responseType = "auto") {
    if (value == null) return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const image = imageFromValue(item, responseType);
            if (image) return image;
        }
        return null;
    }
    if (typeof value === "object") {
        return imageFromValue(
            value.url ?? value.image_url?.url ?? value.imageUrl ?? value.b64_json ?? value.base64
                ?? value.image_base64 ?? value.imageBase64 ?? value.inline_data?.data ?? value.inlineData?.data
                ?? value.source?.data ?? value.data ?? value.content ?? value.parts,
            responseType,
        );
    }
    const text = String(value).trim();
    if (!text) return null;
    if (responseType === "url") return text;
    if (responseType === "base64") return text.startsWith("data:image/") ? text : `data:image/png;base64,${text}`;
    if (/^(?:https?:|data:image\/|\/|\.\.?(?:\/|$))/i.test(text)) return text;
    if (/^[A-Za-z0-9+/]{100,}={0,2}$/.test(text)) return `data:image/png;base64,${text}`;
    return null;
}

export function extractCustomBackendImage(data, responsePath = "", responseType = "auto") {
    if (responsePath) return imageFromValue(resolveJsonPointer(data, responsePath), responseType);
    const candidates = [
        data?.data?.[0], data?.output?.[0], data?.result?.image, data?.result?.url,
        data?.image, data?.url, data?.image_url, data?.imageUrl,
        data?.b64_json, data?.base64, data?.image_base64, data?.imageBase64,
        data?.choices?.[0]?.message?.images?.[0], data?.choices?.[0]?.message?.content,
    ];
    for (const candidate of candidates) {
        const image = imageFromValue(candidate, responseType);
        if (image) return image;
    }
    return null;
}

async function readCustomResponse(response, config, fallbackUrl) {
    if (!response.ok) {
        const detail = await readResponseText(response, 1024 * 1024).catch(() => "");
        throw new Error(`Custom API error ${response.status}: ${detail.replace(/\s+/g, " ").trim().slice(0, 500) || response.statusText}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.startsWith("image/")) {
        const buffer = await readResponseArrayBuffer(response, MAX_IMAGE_BYTES);
        const format = detectImageFormat(buffer);
        if (!format) throw new Error("Custom API response is not a supported image format");
        return { buffer, contentType: format.mime };
    }
    return { data: await readResponseJson(response, MAX_PROVIDER_RESPONSE_BYTES), responseUrl: response.url || fallbackUrl };
}

async function materializeImage(image, baseUrl, fetchImpl, signal) {
    const source = normalizeImageSource(image, {
        baseUrl,
        allowHttp: true,
        allowRelative: true,
        blockPrivateHosts: false,
    });
    if (!source) throw new Error("Custom API returned an invalid image source");
    if (source.startsWith("data:")) {
        const response = await fetchImpl(source, { signal });
        const buffer = await readResponseArrayBuffer(response, MAX_IMAGE_BYTES);
        const format = detectImageFormat(buffer);
        if (!format) throw new Error("Custom API output is not a supported image format");
        return { buffer, contentType: format.mime };
    }
    const parsed = new URL(source);
    if (parsed.username || parsed.password) throw new Error("Custom API image URL must not contain credentials");
    const apiUrl = new URL(baseUrl);
    const safePublicSource = normalizeImageSource(source, {
        allowHttp: false,
        allowRelative: false,
        blockPrivateHosts: true,
    });
    if (parsed.origin !== apiUrl.origin && !safePublicSource) {
        throw new Error("Custom API image URL is not a safe public HTTPS URL");
    }
    const response = await fetchImpl(source, {
        headers: { Accept: "image/*" },
        signal,
        redirect: "error",
    });
    if (!response.ok) throw new Error(`Failed to fetch Custom API image (${response.status})`);
    const buffer = await readResponseArrayBuffer(response, MAX_IMAGE_BYTES);
    const format = detectImageFormat(buffer);
    if (!format) throw new Error("Custom API output is not a supported image format");
    return { buffer, contentType: format.mime };
}

function waitForPoll(ms, signal, sleep) {
    if (sleep) return sleep(ms, signal);
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export async function executeCustomBackend(config, input, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable");
    const request = buildCustomBackendRequest(config, input);
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, request.config.timeoutMs);
    const abortFromParent = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
        const response = await fetchImpl(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: controller.signal,
            redirect: "error",
        });
        const submitted = await readCustomResponse(response, request.config, request.url);
        if (submitted.buffer) return submitted;
        if (request.config.mode === "json") {
            const image = extractCustomBackendImage(submitted.data, request.config.responsePath, request.config.responseType);
            if (!image) throw new Error("No image found at the configured response path");
            return await materializeImage(image, submitted.responseUrl, fetchImpl, controller.signal);
        }

        const jobId = resolveJsonPointer(submitted.data, request.config.jobIdPath);
        if (jobId == null || String(jobId).trim() === "") throw new Error("Async API response did not contain a job ID");
        const success = new Set(request.config.successValues.map(value => value.toLowerCase()));
        const failure = new Set(request.config.failureValues.map(value => value.toLowerCase()));
        while (true) {
            await waitForPoll(request.config.pollIntervalMs, controller.signal, options.sleep);
            const pollUrl = new URL(request.config.pollUrl.replaceAll("{{jobId}}", encodeURIComponent(String(jobId))));
            if (pollUrl.origin !== request.config.pollOrigin) {
                throw new Error("Polling URL origin changed after inserting the job ID");
            }
            const headers = { Accept: "application/json, image/*" };
            buildAuth(request.config, pollUrl, headers);
            const pollResponse = await fetchImpl(pollUrl.href, {
                method: request.config.pollMethod,
                headers,
                signal: controller.signal,
                redirect: "error",
            });
            const polled = await readCustomResponse(pollResponse, request.config, pollUrl.href);
            if (polled.buffer) return polled;
            const status = String(resolveJsonPointer(polled.data, request.config.statusPath) ?? "").trim().toLowerCase();
            if (failure.has(status)) throw new Error(`Custom API job failed with status: ${status}`);
            if (!success.has(status)) continue;
            const image = extractCustomBackendImage(polled.data, request.config.responsePath, request.config.responseType);
            if (!image) throw new Error("Completed custom API job did not contain an image");
            return await materializeImage(image, polled.responseUrl, fetchImpl, controller.signal);
        }
    } catch (error) {
        if (error?.name === "AbortError" && timedOut && !options.signal?.aborted) {
            throw new Error(`Custom API timed out after ${Math.round(request.config.timeoutMs / 1000)} seconds`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
        options.signal?.removeEventListener("abort", abortFromParent);
    }
}
