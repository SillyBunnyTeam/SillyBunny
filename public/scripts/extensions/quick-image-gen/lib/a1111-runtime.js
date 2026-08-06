import { detectImageFormat } from "./image-metadata.js";
import { MAX_IMAGE_BYTES, normalizeImageSource } from "./security.js";

export const A1111_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function toNumber(value) {
    if (value == null || (typeof value === "string" && !value.trim())) return NaN;
    return Number(value);
}

export function parseFiniteFloat(value, fallback, min = -Infinity, max = Infinity) {
    const parsed = toNumber(value);
    const finiteValue = Number.isFinite(parsed) ? parsed : toNumber(fallback);
    if (!Number.isFinite(finiteValue)) return fallback;
    return Math.max(min, Math.min(max, finiteValue));
}

export function parseFiniteInt(value, fallback, min = -Infinity, max = Infinity) {
    return Math.trunc(parseFiniteFloat(value, fallback, min, max));
}

export function normalizeA1111BaseUrl(value) {
    return String(value || "").replace(/\/+$/, "");
}

function decodeBase64(value) {
    const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
    if (typeof globalThis.atob === "function") {
        const binary = globalThis.atob(padded);
        return Uint8Array.from(binary, character => character.charCodeAt(0));
    }
    if (typeof globalThis.Buffer !== "undefined") return new Uint8Array(globalThis.Buffer.from(padded, "base64"));
    throw new Error("No base64 decoder is available");
}

function encodeBase64(bytes) {
    if (typeof globalThis.Buffer !== "undefined") return globalThis.Buffer.from(bytes).toString("base64");
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return globalThis.btoa(binary);
}

export async function materializeA1111ReferenceBase64(source, {
    signal,
    readImage,
    maxBytes = MAX_IMAGE_BYTES,
    baseUrl = globalThis.location?.href || "http://localhost/",
} = {}) {
    const normalized = normalizeImageSource(source, {
        baseUrl,
        allowHttp: true,
        allowRelative: true,
        maxInlineBytes: maxBytes,
    });
    if (!normalized || (!normalized.startsWith("data:") && !/^https?:/i.test(normalized))) {
        throw new Error("Reference image must be a valid image data URL or HTTP URL");
    }

    let bytes;
    if (normalized.startsWith("data:")) {
        const encoded = normalized.match(/^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/i)?.[1];
        if (!encoded) throw new Error("Reference image contains malformed base64 data");
        try {
            bytes = decodeBase64(encoded);
        } catch (error) {
            throw new Error(`Reference image contains malformed base64 data: ${error.message}`);
        }
    } else {
        if (typeof readImage !== "function") throw new Error("Reference image retrieval is unavailable");
        const result = await readImage(normalized, { signal, maxBytes });
        const buffer = result instanceof ArrayBuffer || ArrayBuffer.isView(result) ? result : result?.buffer;
        if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
            throw new Error("Reference image retrieval returned invalid bytes");
        }
        bytes = buffer instanceof Uint8Array
            ? buffer
            : new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
    }

    if (bytes.byteLength > maxBytes) throw new Error("Reference image exceeds the configured size limit");
    if (!detectImageFormat(bytes)) throw new Error("Reference image is not a supported image format");
    return encodeBase64(bytes);
}

export function isCurrentA1111ModelRefresh({ requestId, latestRequestId, baseUrl, settings }) {
    return requestId === latestRequestId
        && settings?.localType === "a1111"
        && normalizeA1111BaseUrl(settings?.localUrl) === normalizeA1111BaseUrl(baseUrl);
}

export function buildA1111ADetailerUnit({
    model,
    prompt,
    negativePrompt,
    denoise,
    confidence,
    maskBlur,
    dilateErode,
    inpaintOnlyMasked,
    inpaintPadding,
}) {
    return {
        ad_model: model,
        ad_prompt: prompt || "",
        ad_negative_prompt: negativePrompt || "",
        ad_denoising_strength: parseFiniteFloat(denoise, 0.4, 0, 1),
        ad_confidence: parseFiniteFloat(confidence, 0.3, 0, 1),
        ad_mask_blur: parseFiniteInt(maskBlur, 4, 0, 64),
        ad_dilate_erode: parseFiniteInt(dilateErode, 4, -128, 128),
        ad_inpaint_only_masked: inpaintOnlyMasked ?? true,
        ad_inpaint_only_masked_padding: parseFiniteInt(inpaintPadding, 32, 0, 256),
    };
}
