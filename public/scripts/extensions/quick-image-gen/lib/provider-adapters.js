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

function validateInlineImage(source) {
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
    return imageBytesToDataUrl(bytes);
}

function getUrlPath(value) {
    try {
        return new URL(value).pathname.replace(/\/$/, '');
    } catch {
        return String(value || '').split(/[?#]/, 1)[0].replace(/\/$/, '');
    }
}

function splitUrlSuffix(value) {
    const match = String(value || '').match(/^([^?#]*)([?#].*)?$/s);
    return { path: match?.[1] || '', suffix: match?.[2] || '' };
}

export function isOpenAIChatCompletionsEndpoint(value) {
    return /\/chat\/completions$/i.test(getUrlPath(value));
}

export function getGptImageApiUrl(proxyUrl = '') {
    const endpoint = String(proxyUrl || '').trim();
    if (!endpoint) return 'https://api.openai.com/v1/images/generations';

    const { path, suffix } = splitUrlSuffix(endpoint);
    const normalizedPath = path.replace(/\/+$/, '');
    if (/\/images\/generations$/i.test(normalizedPath)) return `${normalizedPath}${suffix}`;
    if (/\/chat\/completions$/i.test(normalizedPath)) {
        return `${normalizedPath.replace(/\/chat\/completions$/i, '/images/generations')}${suffix}`;
    }
    if (/\/images$/i.test(normalizedPath)) return `${normalizedPath}/generations${suffix}`;
    if (/\/v1$/i.test(normalizedPath)) return `${normalizedPath}/images/generations${suffix}`;
    return endpoint;
}

export function getNanobananaApiUrl(proxyUrl = '', model = 'gemini-3-pro-image', apiKey = '') {
    const trimmedProxy = String(proxyUrl || '').trim().replace(/\/$/, '');
    if (!trimmedProxy) {
        return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    }
    if (isOpenAIChatCompletionsEndpoint(trimmedProxy)) return trimmedProxy;
    if (trimmedProxy.includes(':generateContent')) {
        if (!apiKey || /[?&]key=/i.test(trimmedProxy)) return trimmedProxy;
        return `${trimmedProxy}${trimmedProxy.includes('?') ? '&' : '?'}key=${apiKey}`;
    }
    const path = trimmedProxy.endsWith('/v1beta') ? trimmedProxy : `${trimmedProxy}/v1beta`;
    return `${path}/models/${model}:generateContent${apiKey ? `?key=${apiKey}` : ''}`;
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
    if (background !== 'auto' && !(background === 'transparent' && outputFormat === 'jpeg')) {
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
    if (typeof candidate === 'string') return extractImageFromString(candidate, defaultMime);
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
        data?.data?.[0],
        data?.output?.[0],
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
} = {}) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Provider returned an empty or invalid image source');
    if (source.trim().startsWith('data:')) return validateInlineImage(source.trim());

    const environmentBaseUrl = globalThis.location?.href || responseUrl || 'http://localhost/';
    let request;
    let result;
    try {
        request = new URL(requestUrl, environmentBaseUrl);
        result = new URL(source, responseUrl || request.href);
    } catch {
        throw new Error('Provider returned an invalid image URL');
    }

    const isTrustedOrigin = result.origin === request.origin;
    const normalized = normalizeImageSource(result.href, {
        allowHttp: isTrustedOrigin,
        allowRelative: false,
        blockPrivateHosts: !isTrustedOrigin,
    });
    if (!normalized) throw new Error('Provider returned an unsafe or unsupported image URL');
    if (!isTrustedOrigin) return normalized;
    const credentialHeaders = getCredentialHeaders(headers);
    if (!Object.keys(credentialHeaders).length) return normalized;
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
    return imageBytesToDataUrl(await readResponseArrayBuffer(response, MAX_IMAGE_BYTES));
}
