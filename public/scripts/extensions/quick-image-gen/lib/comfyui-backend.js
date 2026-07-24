import { readResponseText } from "./security.js";

const MAX_WORKFLOW_BYTES = 1024 * 1024;
const MAX_WORKFLOW_DEPTH = 32;
const MAX_WORKFLOW_NODES = 1_000;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_POLL_ATTEMPTS = 10_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const PLACEHOLDER = /%[A-Za-z][A-Za-z0-9_]*%/g;
const EXACT_PLACEHOLDER = /^%([A-Za-z][A-Za-z0-9_]*)%$/;
const NUMBERED_REFERENCE = /^reference_image_([1-9]\d*)$/;
const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429]);
const TOKEN_NAMES = [
    "prompt",
    "negative",
    "seed",
    "width",
    "height",
    "steps",
    "cfg",
    "denoise",
    "clip_skip",
    "clip_stop_at_layer",
    "sampler",
    "scheduler",
    "model",
    "reference_image",
    "batch_index",
    "batch_count",
    "client_id",
    "filename_prefix",
];
const TOKEN_NAME_SET = new Set(TOKEN_NAMES);
const TOKEN_ALIASES = {
    negative: ["negativePrompt"],
    cfg: ["cfgScale"],
    clip_skip: ["clipSkip"],
    clip_stop_at_layer: ["clipStopAtLayer"],
    sampler: ["samplerName"],
    scheduler: ["schedulerName"],
    model: ["modelName"],
    reference_image: ["referenceImage"],
    batch_index: ["batchIndex"],
    batch_count: ["batchCount"],
    client_id: ["clientId"],
    filename_prefix: ["filenamePrefix"],
};

export function normalizeComfyModelLoader(value, legacySettings = {}) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "checkpoint" || normalized === "unet") return normalized;
    return legacySettings?.comfySkipNegativePrompt
        && String(legacySettings?.comfyFluxClipModel1 || "").trim()
        ? "unet"
        : "checkpoint";
}

export function normalizeComfySettings(settings = {}) {
    const source = isRecord(settings) ? settings : {};
    const originalLoader = String(source.comfyModelLoader || "").trim().toLowerCase();
    const hasExplicitLoader = originalLoader === "checkpoint" || originalLoader === "unet";
    const comfyModelLoader = normalizeComfyModelLoader(source.comfyModelLoader, source);
    const needsLegacyVae = !hasExplicitLoader
        && comfyModelLoader === "unet"
        && !String(source.comfyFluxVaeModel || "").trim();
    return {
        ...source,
        comfyModelLoader,
        ...(needsLegacyVae ? { comfyFluxVaeModel: "ae.safetensors" } : {}),
    };
}

export function selectComfyModelList(catalogs, modelLoader) {
    const loader = normalizeComfyModelLoader(modelLoader);
    const models = loader === "unet" ? catalogs?.unets : catalogs?.checkpoints;
    return Array.isArray(models) ? models : [];
}

export function buildComfyBuiltinWorkflow(options = {}) {
    const modelLoader = normalizeComfyModelLoader(options.modelLoader);
    const modelName = String(options.modelName || "model.safetensors").trim();
    const clipSkip = Math.max(1, Number(options.clipSkip) || 1);
    const skipNegativePrompt = options.skipNegativePrompt === true;
    const modelRef = modelLoader === "unet" ? ["11", 0] : ["4", 0];
    const clipLoaderRef = modelLoader === "unet" ? ["12", 0] : ["4", 1];
    const vaeRef = modelLoader === "unet" ? ["13", 0] : ["4", 2];
    const clipRef = clipSkip > 1 ? ["10", 0] : clipLoaderRef;
    const workflow = {
        "3": {
            class_type: "KSampler",
            inputs: {
                seed: options.seed,
                steps: options.steps,
                cfg: options.cfgScale,
                sampler_name: options.samplerName,
                scheduler: options.schedulerName,
                denoise: options.denoise,
                model: modelRef,
                positive: ["6", 0],
                negative: skipNegativePrompt ? ["6", 0] : ["7", 0],
                latent_image: ["5", 0],
            },
        },
        "5": {
            class_type: "EmptyLatentImage",
            inputs: { width: options.width, height: options.height, batch_size: 1 },
        },
        "6": { class_type: "CLIPTextEncode", inputs: { text: options.prompt, clip: clipRef } },
        "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: vaeRef } },
        "9": { class_type: "SaveImage", inputs: { filename_prefix: "qig", images: ["8", 0] } },
    };

    if (!skipNegativePrompt) {
        workflow["7"] = {
            class_type: "CLIPTextEncode",
            inputs: { text: options.negativePrompt, clip: clipRef },
        };
    }
    if (clipSkip > 1) {
        workflow["10"] = {
            class_type: "CLIPSetLastLayer",
            inputs: { stop_at_clip_layer: -clipSkip, clip: clipLoaderRef },
        };
    }

    if (modelLoader === "unet") {
        const clipModel1 = String(options.clipModel1 || "").trim();
        const clipModel2 = String(options.clipModel2 || "").trim();
        const vaeModel = String(options.vaeModel || "").trim();
        const clipType = String(options.clipType || "flux").trim() || "flux";
        if (!clipModel1) {
            throw new Error("ComfyUI Diffusion/UNET mode requires CLIP Model 1");
        }
        if (!vaeModel) {
            throw new Error("ComfyUI Diffusion/UNET mode requires a VAE Model");
        }
        workflow["11"] = {
            class_type: "UNETLoader",
            inputs: { unet_name: modelName, weight_dtype: "default" },
        };
        workflow["12"] = clipModel2
            ? {
                class_type: "DualCLIPLoader",
                inputs: { clip_name1: clipModel1, clip_name2: clipModel2, type: clipType },
            }
            : { class_type: "CLIPLoader", inputs: { clip_name: clipModel1, type: clipType } };
        workflow["13"] = { class_type: "VAELoader", inputs: { vae_name: vaeModel } };
    } else {
        workflow["4"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: modelName } };
    }

    return {
        workflow,
        modelLoader,
        hasDualClip: modelLoader === "unet" && !!String(options.clipModel2 || "").trim(),
        refs: { model: modelRef, clip: clipLoaderRef, vae: vaeRef },
    };
}

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function byteLength(value) {
    return new TextEncoder().encode(value).byteLength;
}

function cloneJsonInput(value) {
    if (typeof value === "string") {
        if (byteLength(value) > MAX_WORKFLOW_BYTES) throw new Error("ComfyUI workflow JSON is too large");
        const source = value.trim();
        if (!source) throw new Error("ComfyUI workflow JSON is required");
        try {
            return JSON.parse(source);
        } catch {
            throw new Error("ComfyUI workflow must be valid JSON");
        }
    }

    let source;
    try {
        source = JSON.stringify(value);
    } catch {
        throw new Error("ComfyUI workflow must be JSON-serializable");
    }
    if (typeof source !== "string") throw new Error("ComfyUI workflow must contain a JSON object");
    if (byteLength(source) > MAX_WORKFLOW_BYTES) throw new Error("ComfyUI workflow JSON is too large");
    return JSON.parse(source);
}

function assertBoundedDepth(value, depth = 0) {
    if (depth > MAX_WORKFLOW_DEPTH) throw new Error("ComfyUI workflow is nested too deeply");
    if (Array.isArray(value)) {
        for (const item of value) assertBoundedDepth(item, depth + 1);
    } else if (isRecord(value)) {
        for (const item of Object.values(value)) assertBoundedDepth(item, depth + 1);
    }
}

function isNodeDefinition(value) {
    return isRecord(value) && typeof value.class_type === "string" && hasOwn(value, "inputs");
}

function getPromptNodes(value) {
    if (hasOwn(value, "prompt") && isRecord(value.prompt) && !isNodeDefinition(value.prompt)) return value.prompt;
    return value;
}

function validateNodeMap(nodes) {
    if (!isRecord(nodes)) throw new Error("ComfyUI prompt must be an API-format node map object");
    const entries = Object.entries(nodes);
    if (!entries.length) throw new Error("ComfyUI prompt node map must not be empty");
    if (entries.length > MAX_WORKFLOW_NODES) {
        throw new Error(`ComfyUI workflow contains more than ${MAX_WORKFLOW_NODES} nodes`);
    }

    for (const [nodeId, node] of entries) {
        if (!nodeId.trim()) throw new Error("ComfyUI workflow contains an empty node ID");
        if (!isRecord(node)) throw new Error(`ComfyUI node "${nodeId}" must be an object`);
        if (typeof node.class_type !== "string" || !node.class_type.trim()) {
            throw new Error(`ComfyUI node "${nodeId}" must have a non-empty class_type`);
        }
        if (!isRecord(node.inputs)) throw new Error(`ComfyUI node "${nodeId}" must have an inputs object`);
    }
}

export function parseComfyWorkflow(value) {
    const parsed = cloneJsonInput(value);
    if (Array.isArray(parsed)) throw new Error("ComfyUI workflow must be an object, not an array");
    if (!isRecord(parsed)) throw new Error("ComfyUI workflow must contain a JSON object");
    const promptNodes = getPromptNodes(parsed);
    if (Array.isArray(parsed.nodes) || Array.isArray(parsed.links)
        || Array.isArray(promptNodes.nodes) || Array.isArray(promptNodes.links)) {
        throw new Error("ComfyUI visual workflow export detected; export and use API format instead");
    }
    assertBoundedDepth(parsed);
    validateNodeMap(promptNodes);
    return parsed;
}

function findTokenValue(values, name) {
    for (const key of [`%${name}%`, name, ...(TOKEN_ALIASES[name] || [])]) {
        if (hasOwn(values, key)) return { found: true, value: values[key] };
    }
    return { found: false, value: undefined };
}

function getReferenceImages(values) {
    const candidate = hasOwn(values, "reference_images")
        ? values.reference_images
        : values.referenceImages;
    return Array.isArray(candidate) ? candidate : null;
}

function resolveToken(values, name) {
    if (!TOKEN_NAME_SET.has(name) && !NUMBERED_REFERENCE.test(name)) {
        return { found: false, value: undefined };
    }
    const direct = findTokenValue(values, name);
    if (direct.found) return direct;

    const numbered = name.match(NUMBERED_REFERENCE);
    if (numbered) {
        const references = getReferenceImages(values);
        if (references) return { found: true, value: references[Number(numbered[1]) - 1] ?? "" };
        return { found: false, value: undefined };
    }

    if (name === "reference_image") {
        const references = getReferenceImages(values);
        if (references) return { found: true, value: references[0] ?? "" };
    }

    if (name === "clip_stop_at_layer") {
        const clipSkip = findTokenValue(values, "clip_skip");
        const numeric = Number(clipSkip.value);
        if (clipSkip.found && Number.isFinite(numeric)) {
            return { found: true, value: -Math.abs(numeric) };
        }
    }

    return { found: false, value: undefined };
}

function replacementText(value) {
    if (value == null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

function renderString(value, tokenValues) {
    const exact = value.match(EXACT_PLACEHOLDER);
    if (exact) {
        const replacement = resolveToken(tokenValues, exact[1]);
        return replacement.found ? replacement.value : value;
    }
    return value.replace(PLACEHOLDER, (placeholder) => {
        const replacement = resolveToken(tokenValues, placeholder.slice(1, -1));
        return replacement.found ? replacementText(replacement.value) : placeholder;
    });
}

function renderValue(value, tokenValues) {
    if (typeof value === "string") return renderString(value, tokenValues);
    if (Array.isArray(value)) return value.map(item => renderValue(item, tokenValues));
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, tokenValues)]));
    }
    return value;
}

export function renderComfyWorkflow(workflow, tokenValues = {}) {
    if (!isRecord(tokenValues)) throw new Error("ComfyUI placeholder values must be an object");
    return renderValue(parseComfyWorkflow(workflow), tokenValues);
}

export function buildComfyPromptRequest(workflow, tokenValues = {}) {
    const rendered = renderComfyWorkflow(workflow, tokenValues);
    return getPromptNodes(rendered) === rendered ? { prompt: rendered } : rendered;
}

function collectTokens(value, tokens = new Set()) {
    if (typeof value === "string") {
        for (const placeholder of value.match(PLACEHOLDER) || []) {
            const name = placeholder.slice(1, -1);
            if (TOKEN_NAME_SET.has(name) || NUMBERED_REFERENCE.test(name)) tokens.add(name);
        }
    } else if (Array.isArray(value)) {
        for (const item of value) collectTokens(item, tokens);
    } else if (isRecord(value)) {
        for (const item of Object.values(value)) collectTokens(item, tokens);
    }
    return tokens;
}

export function getComfyWorkflowCapabilities(workflow) {
    const tokens = collectTokens(parseComfyWorkflow(workflow));
    const has = name => tokens.has(name);
    const referenceImages = has("reference_image") || [...tokens].some(name => NUMBERED_REFERENCE.test(name));
    return {
        tokens: [...tokens].sort(),
        prompt: has("prompt"),
        negative: has("negative"),
        seed: has("seed"),
        width: has("width"),
        height: has("height"),
        steps: has("steps"),
        cfgScale: has("cfg"),
        denoise: has("denoise"),
        clipSkip: has("clip_skip") || has("clip_stop_at_layer"),
        sampler: has("sampler"),
        scheduler: has("scheduler"),
        model: has("model"),
        referenceImages,
        batch: has("batch_index") || has("batch_count"),
        clientId: has("client_id"),
        filenamePrefix: has("filename_prefix"),
    };
}

export function parseComfyPromptResponse(value) {
    if (!isRecord(value)) throw new Error("ComfyUI prompt response must be a JSON object");
    if (typeof value.prompt_id !== "string" || !value.prompt_id.trim()) {
        throw new Error("ComfyUI prompt response is missing a non-empty prompt_id");
    }
    return {
        prompt_id: value.prompt_id,
        ...(hasOwn(value, "number") ? { number: value.number } : {}),
        ...(hasOwn(value, "node_errors") ? { node_errors: value.node_errors } : {}),
    };
}

function parseBaseUrl(value) {
    let parsed;
    try {
        parsed = new URL(String(value || "").trim());
    } catch {
        throw new Error("ComfyUI base URL must be an absolute HTTP or HTTPS URL");
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("ComfyUI base URL must use HTTP or HTTPS without embedded credentials");
    }
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed;
}

function buildEndpoint(baseUrl, path) {
    const endpoint = parseBaseUrl(baseUrl);
    const basePath = endpoint.pathname.replace(/\/+$/, "");
    endpoint.pathname = `${basePath}${path}`;
    return endpoint;
}

export function buildComfyViewUrl(baseUrl, image) {
    if (!isRecord(image) || typeof image.filename !== "string" || !image.filename.trim()) {
        throw new Error("ComfyUI output image must have a non-empty filename");
    }
    const url = buildEndpoint(baseUrl, "/view");
    url.searchParams.set("filename", image.filename);
    url.searchParams.set("subfolder", typeof image.subfolder === "string" ? image.subfolder : "");
    url.searchParams.set("type", typeof image.type === "string" && image.type ? image.type : "output");
    return url.href;
}

function normalizeOutputNodeIds(value) {
    if (value == null) return null;
    const ids = Array.isArray(value) ? value : [value];
    return [...new Set(ids.map(id => String(id)))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function terminalMessage(messages, type) {
    for (const message of messages) {
        if (Array.isArray(message) && message[0] === type) return message[1];
        if (isRecord(message) && message.type === type) return message.data;
    }
    return undefined;
}

function messageText(value, fallback) {
    if (typeof value === "string" && value.trim()) return value;
    if (isRecord(value)) {
        for (const key of ["exception_message", "message", "error", "details"]) {
            if (typeof value[key] === "string" && value[key].trim()) return value[key];
        }
    }
    return fallback;
}

function enumerateOutputImages(outputs, options) {
    if (!isRecord(outputs)) {
        if (outputs == null) return [];
        throw new Error("ComfyUI history outputs must be an object");
    }
    const selectedIds = normalizeOutputNodeIds(options.outputNodeIds);
    const nodeIds = (selectedIds || Object.keys(outputs)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const imageIndex = options.imageIndex;
    if (imageIndex != null && (!Number.isInteger(imageIndex) || imageIndex < 0)) {
        throw new Error("ComfyUI output image index must be a non-negative integer");
    }

    const result = [];
    for (const nodeId of nodeIds) {
        if (!hasOwn(outputs, nodeId)) continue;
        const output = outputs[nodeId];
        if (!isRecord(output)) throw new Error(`ComfyUI history output for node "${nodeId}" must be an object`);
        if (!hasOwn(output, "images")) continue;
        if (!Array.isArray(output.images)) throw new Error(`ComfyUI history images for node "${nodeId}" must be an array`);
        const indexes = imageIndex == null ? output.images.map((_image, index) => index) : [imageIndex];
        for (const index of indexes) {
            const image = output.images[index];
            if (image == null && imageIndex != null) continue;
            if (!isRecord(image) || typeof image.filename !== "string" || !image.filename.trim()) {
                throw new Error(`ComfyUI history image ${index} for node "${nodeId}" is missing a filename`);
            }
            if (image.subfolder != null && typeof image.subfolder !== "string") {
                throw new Error(`ComfyUI history image ${index} for node "${nodeId}" has an invalid subfolder`);
            }
            if (image.type != null && typeof image.type !== "string") {
                throw new Error(`ComfyUI history image ${index} for node "${nodeId}" has an invalid type`);
            }
            const normalized = {
                nodeId,
                imageIndex: index,
                filename: image.filename,
                subfolder: image.subfolder || "",
                type: image.type || "output",
            };
            if (options.baseUrl) normalized.url = buildComfyViewUrl(options.baseUrl, normalized);
            result.push(normalized);
        }
    }
    return result;
}

export function parseComfyHistoryEntry(entry, options = {}) {
    if (entry == null) return { state: "pending", terminal: false, messages: [], images: [] };
    if (!isRecord(entry)) throw new Error("ComfyUI history entry must be an object");
    const status = isRecord(entry.status) ? entry.status : {};
    const messages = Array.isArray(status.messages) ? status.messages : [];
    const statusName = String(status.status_str || status.status || "").trim().toLowerCase();
    const executionError = terminalMessage(messages, "execution_error");
    const executionInterrupted = terminalMessage(messages, "execution_interrupted");

    if (executionError !== undefined) {
        return {
            state: "error",
            terminal: true,
            messages,
            images: [],
            error: executionError,
            message: messageText(executionError, "ComfyUI execution failed"),
        };
    }
    if (executionInterrupted !== undefined) {
        return {
            state: "interrupted",
            terminal: true,
            messages,
            images: [],
            error: executionInterrupted,
            message: messageText(executionInterrupted, "ComfyUI execution was interrupted"),
        };
    }
    if (["error", "failed", "failure"].includes(statusName)) {
        return {
            state: "error",
            terminal: true,
            messages,
            images: [],
            message: messageText(status, "ComfyUI execution failed"),
        };
    }
    if (["interrupted", "cancelled", "canceled"].includes(statusName)) {
        return {
            state: "interrupted",
            terminal: true,
            messages,
            images: [],
            message: messageText(status, "ComfyUI execution was interrupted"),
        };
    }

    const images = enumerateOutputImages(entry.outputs, options);
    const terminal = status.completed === true
        || ["success", "completed", "complete"].includes(statusName)
        || terminalMessage(messages, "execution_success") !== undefined
        || (hasOwn(entry, "outputs") && !["pending", "queued", "running", "in_progress"].includes(statusName));
    if (terminal && images.length) return { state: "success", terminal: true, messages, images };
    if (terminal) return { state: "completed_no_images", terminal: true, messages, images: [] };
    return { state: "pending", terminal: false, messages, images };
}

function parseWebSocketEnvelope(message) {
    let value = message;
    if (isRecord(message) && (message.type === "message" || typeof message.type !== "string")) value = message.data;
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    return isRecord(value) ? value : null;
}

export function parseComfyWebSocketMessage(message, promptId) {
    const envelope = parseWebSocketEnvelope(message);
    if (!envelope || typeof envelope.type !== "string" || !isRecord(envelope.data)) return null;
    const data = envelope.data;
    const eventPromptId = data.prompt_id ?? data.promptId;
    if (typeof eventPromptId !== "string" || eventPromptId !== promptId) return null;

    if (envelope.type === "progress") {
        return { type: "progress", promptId, value: data.value, max: data.max, node: data.node ?? null };
    }
    if (envelope.type === "executing") {
        if (data.node === null) return { type: "success", promptId, terminal: true, legacy: true };
        if (data.node != null) return { type: "current_node", promptId, node: String(data.node), terminal: false };
        return null;
    }
    if (envelope.type === "execution_success") {
        return { type: "success", promptId, terminal: true, data };
    }
    if (envelope.type === "execution_error") {
        return {
            type: "error",
            promptId,
            terminal: true,
            message: messageText(data, "ComfyUI execution failed"),
            data,
        };
    }
    if (envelope.type === "execution_interrupted") {
        return {
            type: "interrupted",
            promptId,
            terminal: true,
            message: messageText(data, "ComfyUI execution was interrupted"),
            data,
        };
    }
    return null;
}

function abortError(message = "The operation was aborted") {
    return new DOMException(message, "AbortError");
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function wait(ms, signal, sleep) {
    if (sleep) return withAbort(Promise.resolve().then(() => sleep(ms, signal)), signal);
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : abortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : abortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function withAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : abortError());
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(promise).then(
            value => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

async function readBoundedJson(response, maxBytes, label) {
    let text;
    try {
        text = await readResponseText(response, maxBytes);
    } catch (error) {
        if (/too large|exceeds/i.test(String(error?.message || error))) {
            throw new Error(`${label} exceeds the configured response size limit`);
        }
        throw error;
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${label} contains malformed JSON`);
    }
}

async function httpError(response, label) {
    const detail = await readResponseText(response, MAX_ERROR_BYTES).catch(() => "");
    const suffix = detail.replace(/\s+/g, " ").trim().slice(0, 500);
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    return new Error(`${label} failed with HTTP ${status}${suffix ? `: ${suffix}` : ""}`);
}

function isTransientStatus(status) {
    return TRANSIENT_HTTP_STATUS.has(status) || (status >= 500 && status <= 599);
}

async function disposeResponseBody(response) {
    if (!response?.body) return;
    try {
        if (typeof response.body.cancel === "function" && !response.body.locked) {
            await response.body.cancel("Transient ComfyUI history response will not be consumed");
            return;
        }
        if (typeof response.body.getReader === "function" && !response.body.locked) {
            const reader = response.body.getReader();
            try {
                await reader.cancel("Transient ComfyUI history response will not be consumed");
            } finally {
                reader.releaseLock();
            }
        }
    } catch {
        // Body disposal is best effort; the retry policy remains authoritative.
    }
}

function historyTimeoutError(timeoutMs) {
    const error = new Error(`ComfyUI history polling timed out after ${timeoutMs} ms`);
    error.code = "COMFY_HISTORY_TIMEOUT";
    return error;
}

export async function pollComfyHistory(promptId, options = {}) {
    if (typeof promptId !== "string" || !promptId.trim()) throw new Error("ComfyUI prompt ID is required for polling");
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable");
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Number(options.timeoutMs) || 300_000));
    const pollIntervalMs = Math.min(MAX_POLL_INTERVAL_MS, Math.max(1, Number(options.pollIntervalMs) || 1_000));
    const maxResponseBytes = Math.min(MAX_HISTORY_BYTES, Math.max(1, Number(options.maxResponseBytes) || MAX_HISTORY_BYTES));
    const maxAttempts = Math.min(MAX_POLL_ATTEMPTS, Math.ceil(timeoutMs / pollIntervalMs) + 1);
    const historyUrl = buildEndpoint(options.baseUrl, `/history/${encodeURIComponent(promptId)}`).href;
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const abortFromParent = () => controller.abort(options.signal.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            throwIfAborted(controller.signal);
            let response;
            try {
                response = await withAbort(fetchImpl(historyUrl, {
                    method: "GET",
                    headers: { Accept: "application/json" },
                    signal: controller.signal,
                    redirect: "error",
                }), controller.signal);
            } catch (error) {
                if (error?.name === "AbortError" && timedOut && !options.signal?.aborted) break;
                throw error;
            }

            if (!response.ok) {
                if (!isTransientStatus(response.status)) {
                    throw await withAbort(httpError(response, "ComfyUI history request"), controller.signal);
                }
                await withAbort(disposeResponseBody(response), controller.signal);
            } else {
                const history = await withAbort(
                    readBoundedJson(response, maxResponseBytes, "ComfyUI history response"),
                    controller.signal,
                );
                if (!isRecord(history)) throw new Error("ComfyUI history response must be a JSON object");
                const keys = Object.keys(history);
                if (keys.length) {
                    if (!hasOwn(history, promptId)) {
                        throw new Error(`ComfyUI history response is missing entry for prompt ${promptId}`);
                    }
                    const result = parseComfyHistoryEntry(history[promptId], options);
                    if (result.state === "success") return result;
                    if (result.state === "error") throw new Error(`ComfyUI execution error: ${result.message}`);
                    if (result.state === "interrupted") throw new Error(`ComfyUI execution interrupted: ${result.message}`);
                    if (result.state === "completed_no_images") {
                        throw new Error("ComfyUI completed without images matching the requested output selection");
                    }
                }
            }

            if (attempt + 1 >= maxAttempts) break;
            await wait(pollIntervalMs, controller.signal, options.sleep);
            throwIfAborted(controller.signal);
        }
        if (options.signal?.aborted) throwIfAborted(options.signal);
        throw historyTimeoutError(timeoutMs);
    } catch (error) {
        if (error?.name === "AbortError" && timedOut && !options.signal?.aborted) {
            throw historyTimeoutError(timeoutMs);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
        options.signal?.removeEventListener("abort", abortFromParent);
    }
}

export function supportsComfyJobsCancel(features) {
    if (!isRecord(features)) return false;
    return features.supports_jobs_cancel === true
        || features.jobs_api === true
        || features.jobs?.cancel === true
        || features.api?.jobs?.cancel === true;
}

async function postCancellation(url, body, options, label, expectJson = false) {
    const response = await withAbort(options.fetchImpl(url, {
        method: "POST",
        headers: body === undefined ? { Accept: "application/json" } : {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: options.signal,
        redirect: "error",
    }), options.signal);
    if (!response.ok) throw await withAbort(httpError(response, label), options.signal);
    if (!expectJson) return null;
    return withAbort(readBoundedJson(response, MAX_ERROR_BYTES, `${label} response`), options.signal);
}

async function tryJobsCancellation(promptId, options) {
    const url = buildEndpoint(options.baseUrl, `/api/jobs/${encodeURIComponent(promptId)}/cancel`).href;
    const response = await withAbort(options.fetchImpl(url, {
        method: "POST",
        headers: { Accept: "application/json" },
        signal: options.signal,
        redirect: "error",
    }), options.signal);
    if (response.status === 404 || response.status === 405) return null;
    if (!response.ok) throw await withAbort(httpError(response, "ComfyUI jobs cancellation"), options.signal);
    const result = await withAbort(readBoundedJson(response, MAX_ERROR_BYTES, "ComfyUI jobs cancellation response"), options.signal);
    return { strategy: "jobs-api", cancelled: result?.cancelled !== false, result };
}

function getCancellationState(options) {
    const suppliedState = String(options.promptState ?? options.state ?? "").trim().toLowerCase();
    if (suppliedState === "queued" || suppliedState === "running") return suppliedState;
    if (options.pending === true) return "queued";
    if (options.pending === false) return "running";
    return "unknown";
}

export async function cancelComfyPrompt(promptId, options = {}) {
    if (typeof promptId !== "string" || !promptId.trim()) throw new Error("ComfyUI prompt ID is required for cancellation");
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable");
    throwIfAborted(options.signal);

    if (typeof options.cancelJob === "function") {
        const result = await options.cancelJob(promptId, {
            baseUrl: options.baseUrl,
            fetchImpl,
            signal: options.signal,
        });
        return {
            strategy: "supplied-jobs-cancel",
            cancelled: isRecord(result) && hasOwn(result, "cancelled") ? Boolean(result.cancelled) : result !== false,
            result,
        };
    }

    let jobsCancelSupported = options.jobsCancelSupported === true || supportsComfyJobsCancel(options.features);
    if (!jobsCancelSupported && typeof options.detectJobsCancel === "function") {
        jobsCancelSupported = await options.detectJobsCancel({ baseUrl: options.baseUrl, fetchImpl, signal: options.signal }) === true;
    }
    const requestOptions = { baseUrl: options.baseUrl, fetchImpl, signal: options.signal };
    if (jobsCancelSupported) {
        const url = buildEndpoint(options.baseUrl, `/api/jobs/${encodeURIComponent(promptId)}/cancel`).href;
        const result = await postCancellation(url, undefined, requestOptions, "ComfyUI jobs cancellation", true);
        return { strategy: "jobs-api", cancelled: result?.cancelled !== false, result };
    }
    if (options.tryJobsCancel === true) {
        const jobsResult = await tryJobsCancellation(promptId, requestOptions);
        if (jobsResult) return jobsResult;
    }

    const promptState = getCancellationState(options);
    if (options.allowLegacyInterrupt && promptState === "running") {
        const url = buildEndpoint(options.baseUrl, "/interrupt").href;
        await postCancellation(url, { prompt_id: promptId }, requestOptions, "ComfyUI legacy interruption");
        return { strategy: "legacy-interrupt", cancelled: true, targeted: true };
    }

    if (promptState === "running") {
        return { strategy: "none", cancelled: false, reason: "Running work cannot be safely cancelled without targeted jobs support" };
    }
    const url = buildEndpoint(options.baseUrl, "/queue").href;
    await postCancellation(url, { delete: [promptId] }, requestOptions, "ComfyUI queue cancellation");
    if (promptState === "queued") return { strategy: "queue-delete", cancelled: true };
    return {
        strategy: "queue-delete",
        cancelled: false,
        reason: "Queue deletion was requested, but the prompt state was unknown and the request may have been a no-op",
    };
}
