import { detectImageFormat } from './image-metadata.js';
import {
    MAX_IMAGE_BYTES,
    normalizeImageSource,
    readResponseArrayBuffer,
    readResponseText,
} from './security.js';

function arrayBufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (typeof globalThis.Buffer !== 'undefined') return globalThis.Buffer.from(bytes).toString('base64');
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return globalThis.btoa(binary);
}

function base64ToBytes(base64) {
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    if (typeof globalThis.atob === 'function') {
        const binary = globalThis.atob(padded);
        return Uint8Array.from(binary, character => character.charCodeAt(0));
    }
    if (typeof globalThis.Buffer !== 'undefined') return new Uint8Array(globalThis.Buffer.from(padded, 'base64'));
    throw new Error('No base64 decoder is available');
}

function imageBytesToDataUrl(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const format = detectImageFormat(bytes);
    if (!format) throw new Error('Provider returned image with unknown or corrupted file format');
    return `data:${format.mime};base64,${arrayBufferToBase64(bytes)}`;
}

function validateInlineImage(source, materializeBytes = imageBytesToDataUrl) {
    const normalized = normalizeImageSource(source, {
        allowHttp: false,
        allowRelative: false,
        maxInlineBytes: MAX_IMAGE_BYTES,
    });
    if (!normalized) throw new Error('Provider returned malformed or oversized image data');
    const match = normalized.match(/^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) throw new Error('Provider returned malformed image data URL');

    let bytes;
    try {
        bytes = base64ToBytes(match[1]);
    } catch (error) {
        throw new Error(`Provider returned malformed image base64: ${error?.message || 'decode failed'}`);
    }
    if (bytes.byteLength < 32) throw new Error('Provider returned empty or incomplete image payload');
    return materializeBytes(bytes);
}

function getUrlPath(value) {
    try {
        return new URL(value).pathname.replace(/\/$/, '');
    } catch {
        return String(value || '').split(/[?#]/, 1)[0].replace(/\/$/, '');
    }
}

function editUrlPath(value, editPath) {
    const raw = String(value || '').trim();
    try {
        const absolute = new URL(raw);
        absolute.pathname = editPath(absolute.pathname);
        return absolute.toString();
    } catch {
        const match = raw.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/s);
        const path = match?.[1] || '';
        return `${editPath(path)}${match?.[2] || ''}${match?.[3] || ''}`;
    }
}

function removeUrlQueryParameter(value, name) {
    try {
        const url = new URL(value);
        url.searchParams.delete(name);
        return url.toString();
    } catch {
        return value;
    }
}

export function isOpenAIChatCompletionsEndpoint(value) {
    return /\/chat\/completions$/i.test(getUrlPath(value));
}

export function isNovelAICompatibleProxyUrl(value) {
    const path = getUrlPath(value);
    if (/\/generate$/i.test(path)) return false;
    return /\/v1$/i.test(path) || /\/chat\/completions$/i.test(path);
}

export function getGptImageApiUrl(proxyUrl = '') {
    const endpoint = String(proxyUrl || '').trim();
    if (!endpoint) return 'https://api.openai.com/v1/images/generations';

    const normalizedPath = getUrlPath(endpoint);
    if (/\/images\/generations$/i.test(normalizedPath)) return endpoint;
    if (/\/chat\/completions$/i.test(normalizedPath)) return editUrlPath(endpoint, path => path.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '/images/generations'));
    if (/\/images$/i.test(normalizedPath)) return editUrlPath(endpoint, path => `${path.replace(/\/+$/, '')}/generations`);
    if (/\/v1$/i.test(normalizedPath)) return editUrlPath(endpoint, path => `${path.replace(/\/+$/, '')}/images/generations`);
    return endpoint;
}

export function getOpenAICompatibleApiUrl(value, endpointMode = 'images_generations') {
    const endpoint = String(value || '').trim();
    if (!endpoint) return '';
    const path = getUrlPath(endpoint);
    if (endpointMode === 'chat_completions') {
        if (/\/chat\/completions$/i.test(path)) return endpoint;
        if (/\/images\/generations$/i.test(path)) return editUrlPath(endpoint, current => current.replace(/\/+$/, '').replace(/\/images\/generations$/i, '/chat/completions'));
        if (/\/images$/i.test(path)) return editUrlPath(endpoint, current => current.replace(/\/+$/, '').replace(/\/images$/i, '/chat/completions'));
        return editUrlPath(endpoint, current => `${current.replace(/\/+$/, '')}/chat/completions`);
    }
    if (/\/images\/generations$/i.test(path)) return endpoint;
    if (/\/chat\/completions$/i.test(path)) return editUrlPath(endpoint, current => current.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '/images/generations'));
    if (/\/images$/i.test(path)) return editUrlPath(endpoint, current => `${current.replace(/\/+$/, '')}/generations`);
    if (/\/v1$/i.test(path)) return editUrlPath(endpoint, current => `${current.replace(/\/+$/, '')}/images/generations`);
    return endpoint;
}

export function extractProviderErrorMessage(data) {
    const candidates = [
        data?.error?.message,
        data?.error,
        data?.detail,
        data?.message,
        data?.choices?.[0]?.message?.content,
    ];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const message = candidate.trim();
        if (message) return message.slice(0, 1000);
    }
    return '';
}

export async function readProviderErrorResponse(response, maxBytes = 1024 * 1024) {
    const text = await readResponseText(response, maxBytes);
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = null;
        }
    }
    const message = extractProviderErrorMessage(data)
        || text.replace(/\s+/g, ' ').trim().slice(0, 1000)
        || response?.statusText
        || '';
    return { data, text, message };
}

export function getGptImageRouteRetryUrl(endpoint, responseData) {
    const message = extractProviderErrorMessage(responseData);
    if (!/proxy error\s*\(\s*http\s+404\s+not found\s*\)/i.test(message)
        || !/requested proxy endpoint does not exist/i.test(message)) {
        return '';
    }

    const value = String(endpoint || '').trim();
    if (!value) return '';
    const normalizedPath = getUrlPath(value);
    if (!normalizedPath || /\/images\/generations$/i.test(normalizedPath)) return '';
    return editUrlPath(value, path => `${path.replace(/\/+$/, '')}/images/generations`);
}

function isGptImageRequestError(result) {
    if (!result || typeof result !== 'object') return false;
    const status = Number(result.status);
    return result.ok === false
        || (Number.isFinite(status) && status >= 400)
        || result.error != null;
}

function throwGptImageRequestError(result) {
    if (result.error instanceof Error) throw result.error;

    const status = Number(result.status);
    const detail = extractProviderErrorMessage(result.data)
        || (typeof result.error === 'string' ? result.error.trim().slice(0, 1000) : '');
    const label = Number.isFinite(status) ? `GPT Image error ${status}` : 'GPT Image request failed';
    const error = new Error(detail ? `${label}: ${detail}` : label);
    if (Number.isFinite(status)) error.status = status;
    error.data = result.data;
    throw error;
}

export async function requestGptImageWithRouteRetry(endpoint, request, onRetry = () => {}) {
    const firstResult = await request(endpoint);
    if (firstResult?.image || firstResult?.source) return firstResult;
    if (!isGptImageRequestError(firstResult)) return firstResult;

    const retryUrl = Number(firstResult.status) === 404
        ? getGptImageRouteRetryUrl(endpoint, firstResult.data)
        : '';
    if (!retryUrl) throwGptImageRequestError(firstResult);

    onRetry(retryUrl);
    const retryResult = await request(retryUrl);
    if (retryResult?.image || retryResult?.source || !isGptImageRequestError(retryResult)) return retryResult;
    throwGptImageRequestError(retryResult);
}

export function getNanobananaApiUrl(proxyUrl = '', model = 'gemini-3-pro-image', apiKey = '') {
    const trimmedProxy = String(proxyUrl || '').trim();
    if (!trimmedProxy) {
        return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    }
    if (isOpenAIChatCompletionsEndpoint(trimmedProxy)) return trimmedProxy;
    if (getUrlPath(trimmedProxy).includes(':generateContent')) return removeUrlQueryParameter(trimmedProxy, 'key');
    const endpoint = editUrlPath(trimmedProxy, path => {
        const base = path.replace(/\/+$/, '');
        const versioned = /\/v1beta$/i.test(base) ? base : `${base}/v1beta`;
        return `${versioned}/models/${model}:generateContent`;
    });
    return endpoint;
}

export function getNanobananaAuthHeaders(endpointUrl, apiKey = '') {
    const key = String(apiKey || '');
    if (!key) return {};
    return isOpenAIChatCompletionsEndpoint(endpointUrl)
        ? { Authorization: `Bearer ${key}` }
        : { 'x-goog-api-key': key };
}

export function buildGptImagePayload({
    model,
    prompt,
    negative = '',
    size,
    quality = 'auto',
    outputFormat = 'png',
    background = 'auto',
    moderation = 'auto',
}) {
    const payload = {
        model,
        prompt: negative ? `${prompt}\n\nAvoid in the image: ${negative}` : prompt,
        size,
        n: 1,
    };
    if (quality !== 'auto') payload.quality = quality;
    if (outputFormat !== 'png') payload.output_format = outputFormat;
    const supportsBackground = /^gpt-image-(?:1(?:\.5)?|2)(?:$|-)/i.test(String(model || ''));
    if (supportsBackground && background !== 'auto' && !(background === 'transparent' && outputFormat === 'jpeg')) {
        payload.background = background;
    }
    if (moderation !== 'auto') payload.moderation = moderation;
    return payload;
}

export function buildNanobananaPayload({ endpointUrl, model, parts, generationConfig, safetySettings }) {
    if (!isOpenAIChatCompletionsEndpoint(endpointUrl)) {
        return {
            contents: [{ role: 'user', parts }],
            generationConfig,
            safetySettings,
        };
    }

    const content = [];
    for (const part of parts || []) {
        if (part?.inlineData?.data) {
            content.push({
                type: 'image_url',
                image_url: { url: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}` },
            });
        } else if (part?.text) {
            content.push({ type: 'text', text: part.text });
        }
    }

    const hasImage = content.some(part => part.type === 'image_url');
    const messageContent = hasImage
        ? content
        : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const payload = {
        model,
        messages: [{ role: 'user', content: messageContent }],
        modalities: ['text', 'image'],
    };
    if (generationConfig?.imageConfig) {
        payload.image_config = {
            aspect_ratio: generationConfig.imageConfig.aspectRatio,
            ...(generationConfig.imageConfig.imageSize ? { image_size: generationConfig.imageConfig.imageSize } : {}),
        };
    }
    return payload;
}

function extractImageFromString(value, defaultMime) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return null;
    if (/^data:image\/[^;]+;base64,[A-Za-z0-9+/=_\-\s]+$/i.test(text)) return text;
    if (/^https?:\/\/\S+$/i.test(text)) return text;

    const markdown = text.match(/!\[.*?\]\((https?:\/\/[^\s)]+|data:image\/[^;]+;base64,[^\s)]+)\)/i);
    if (markdown) return markdown[1];
    const dataUrl = text.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=_\-]+/i);
    if (dataUrl) return dataUrl[0];
    const imageUrl = text.match(/https?:\/\/[^\s)]+\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s)]*)?/i);
    if (imageUrl) return imageUrl[0];
    if (/^[A-Za-z0-9+/]{100,}={0,2}$/.test(text)) return `data:${defaultMime};base64,${text}`;
    return null;
}

function extractImageValue(candidate, defaultMime) {
    if (!candidate) return null;
    if (Array.isArray(candidate)) {
        for (const item of candidate) {
            const source = extractImageValue(item, defaultMime);
            if (source) return source;
        }
        return null;
    }
    if (typeof candidate === 'string') return extractImageFromString(candidate, defaultMime);
    if (typeof candidate !== 'object') return null;
    if (typeof candidate.image_url === 'string') return candidate.image_url;
    if (candidate.image_url?.url) return candidate.image_url.url;
    if (candidate.url) return candidate.url;
    if (candidate.fileData?.fileUri) return candidate.fileData.fileUri;
    if (candidate.file_data?.file_uri) return candidate.file_data.file_uri;
    if (candidate.b64_json) return `data:${defaultMime};base64,${candidate.b64_json}`;
    if (candidate.base64) return `data:${defaultMime};base64,${candidate.base64}`;
    if (candidate.source?.data) return `data:${candidate.source.media_type || defaultMime};base64,${candidate.source.data}`;
    if (candidate.inline_data?.data) return `data:${candidate.inline_data.mime_type || defaultMime};base64,${candidate.inline_data.data}`;
    if (candidate.inlineData?.data) return `data:${candidate.inlineData.mimeType || defaultMime};base64,${candidate.inlineData.data}`;
    return extractImageFromString(candidate.image, defaultMime);
}

export function extractProviderImageSource(data, { defaultMime = 'image/png', includeGeminiCandidates = true } = {}) {
    const directCandidates = [
        data?.data,
        data?.output,
        data?.images,
        data?.artifacts,
        { url: data?.url },
        { image_url: data?.image_url },
        { url: data?.imageUrl },
        { b64_json: data?.b64_json || data?.image_base64 || data?.imageBase64 },
        { base64: data?.base64 },
        data?.image,
    ];
    for (const candidate of directCandidates) {
        const source = extractImageValue(candidate, defaultMime);
        if (source) return source;
    }

    const message = data?.choices?.[0]?.message;
    for (const collection of [message?.images, message?.content, message?.parts]) {
        if (Array.isArray(collection)) {
            for (const candidate of collection) {
                const source = extractImageValue(candidate, defaultMime);
                if (source) return source;
            }
        } else {
            const source = extractImageValue(collection, defaultMime);
            if (source) return source;
        }
    }

    if (includeGeminiCandidates) {
        for (const candidate of data?.candidates || []) {
            for (const part of candidate?.content?.parts || []) {
                const source = extractImageValue(part, defaultMime);
                if (source) return source;
            }
            const source = extractImageValue(candidate, defaultMime);
            if (source) return source;
        }
    }
    return null;
}

export async function imageResponseToDataUrl(response) {
    const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
    const mime = contentType.split(';', 1)[0].trim();
    if (!mime.startsWith('image/') && mime !== 'application/octet-stream') {
        throw new Error(`Provider returned ${contentType || 'an unknown content type'} instead of an image`);
    }
    return imageBytesToDataUrl(await readResponseArrayBuffer(response, MAX_IMAGE_BYTES));
}

function getCredentialHeaders(headers) {
    const credentials = {};
    const entries = typeof headers?.entries === 'function' ? headers.entries() : Object.entries(headers || {});
    for (const [name, value] of entries) {
        const normalizedName = String(name).toLowerCase();
        if (normalizedName === 'authorization') credentials.Authorization = value;
        if (normalizedName === 'x-goog-api-key') credentials['x-goog-api-key'] = value;
    }
    return credentials;
}

export function describeProviderImageSource(source, baseUrl = globalThis.location?.href || 'http://localhost/') {
    const value = String(source || '').trim();
    if (value.startsWith('data:')) return 'inline image data';
    try {
        const parsed = new URL(value, baseUrl);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return 'provider image URL';
    }
}

export async function materializeProviderImageSource(source, {
    requestUrl,
    responseUrl = '',
    headers = {},
    signal,
    fetchImpl = globalThis.fetch,
    allowBrowserFallback = true,
    forceFetch = false,
    allowedHostSuffixes = [],
    credentialHostSuffixes = [],
    credentialOrigins = [],
    materializeBytes = imageBytesToDataUrl,
} = {}) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Provider returned an empty or invalid image source');
    if (source.trim().startsWith('data:')) return validateInlineImage(source.trim(), materializeBytes);

    const environmentBaseUrl = globalThis.location?.href || responseUrl || 'http://localhost/';
    let request;
    let result;
    try {
        request = new URL(requestUrl, environmentBaseUrl);
        result = new URL(source, responseUrl || request.href);
    } catch {
        throw new Error('Provider returned an invalid image URL');
    }

    const hostMatches = (suffixes) => suffixes.some(suffix => {
        const host = result.hostname.toLowerCase().replace(/\.$/, '');
        const normalizedSuffix = String(suffix || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
        return normalizedSuffix && (host === normalizedSuffix || host.endsWith(`.${normalizedSuffix}`));
    });
    const isTrustedOrigin = result.origin === request.origin;
    const isAllowedOutputHost = isTrustedOrigin || hostMatches(allowedHostSuffixes);
    const normalized = normalizeImageSource(result.href, {
        allowHttp: isTrustedOrigin,
        allowRelative: false,
        blockPrivateHosts: !isTrustedOrigin,
    });
    if (!normalized) throw new Error('Provider returned an unsafe or unsupported image URL');
    if (forceFetch && !isAllowedOutputHost) throw new Error('Provider returned an image URL from an untrusted host');
    if (!forceFetch && !isTrustedOrigin) return normalized;
    const allowedCredentialOrigins = new Set(credentialOrigins.map(origin => {
        try { return new URL(origin).origin; } catch { return ""; }
    }).filter(Boolean));
    const credentialHeaders = isTrustedOrigin || allowedCredentialOrigins.has(result.origin) || hostMatches(credentialHostSuffixes)
        ? getCredentialHeaders(headers)
        : {};
    if (!forceFetch && !Object.keys(credentialHeaders).length) return normalized;
    if (typeof fetchImpl !== 'function') throw new Error('Image fetch is unavailable');

    let response;
    try {
        response = await fetchImpl(normalized, {
            method: 'GET',
            headers: credentialHeaders,
            redirect: 'error',
            signal,
        });
    } catch (error) {
        if (error instanceof TypeError && !signal?.aborted && allowBrowserFallback) return normalized;
        const sourceDescription = describeProviderImageSource(normalized);
        const detail = String(error?.message || 'request failed').split(normalized).join(sourceDescription);
        throw new Error(`Could not retrieve generated image from ${sourceDescription}: ${detail}`);
    }
    if (!response.ok) {
        throw new Error(`Generated image URL returned HTTP ${response.status}`);
    }

    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    const mime = contentType.split(';', 1)[0].trim();
    if (mime && !mime.startsWith('image/') && mime !== 'application/octet-stream') {
        const detail = await readResponseText(response, 64 * 1024).catch(() => '');
        const preview = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
        throw new Error(`Generated image URL returned ${contentType}${preview ? `: ${preview}` : ''}`);
    }
    const buffer = await readResponseArrayBuffer(response, MAX_IMAGE_BYTES);
    return materializeBytes(buffer);
}
