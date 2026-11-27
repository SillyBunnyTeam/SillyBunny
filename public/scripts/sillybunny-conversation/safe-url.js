/**
 * Pure URL scheme validation for conversation attachments and media. Imports nothing so prompt, timeline and details
 * callers can share it without pulling extra modules into their graphs.
 */

const SAFE_ATTACHMENT_SCHEMES = new Set(['http:', 'https:', 'blob:']);
const SAFE_DATA_IMAGE_PREFIX_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp);base64,/i;

function hasControlChar(text) {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) {
            return true;
        }
    }
    return false;
}

function isBase64Payload(text, start) {
    if (start >= text.length) {
        return false;
    }
    let seenPadding = false;
    for (let index = start; index < text.length; index++) {
        const code = text.charCodeAt(index);
        const isAlphaNum = (code >= 0x41 && code <= 0x5a)
            || (code >= 0x61 && code <= 0x7a)
            || (code >= 0x30 && code <= 0x39)
            || code === 0x2b
            || code === 0x2f;
        if (isAlphaNum) {
            if (seenPadding) {
                return false;
            }
            continue;
        }
        if (code === 0x3d) {
            seenPadding = true;
            continue;
        }
        return false;
    }
    return true;
}

/**
 * Returns the trimmed URL when it uses an allowed scheme (`http:`, `https:`, `blob:`, or a relative URL resolving to
 * `http:`/`https:`), or `null` for unsafe schemes (`javascript:`, `vbscript:`, `data:`) and control characters.
 * Pass `{ allowDataImage: true }` only for non-navigable image sources that may legitimately carry raster data URIs.
 * @param {unknown} value
 * @param {{ allowDataImage?: boolean }} [options]
 * @returns {string|null}
 */
export function toSafeAttachmentUrl(value, { allowDataImage = false } = {}) {
    if (typeof value !== 'string' || hasControlChar(value)) {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    if (allowDataImage) {
        const prefix = SAFE_DATA_IMAGE_PREFIX_RE.exec(trimmed);
        if (prefix && isBase64Payload(trimmed, prefix[0].length)) {
            return trimmed;
        }
    }
    const base = typeof globalThis.location?.href === 'string' && /^https?:/i.test(globalThis.location.href)
        ? globalThis.location.href
        : 'http://localhost/';
    try {
        const parsed = new URL(trimmed, base);
        if (!SAFE_ATTACHMENT_SCHEMES.has(parsed.protocol)) {
            return null;
        }
        if (parsed.protocol === 'blob:' && !/^(?:https?:\/\/|null\/|nodedata:)/i.test(parsed.pathname)) {
            return null;
        }
        return trimmed;
    } catch {
        return null;
    }
}

/**
 * @param {unknown} value
 * @param {{ allowDataImage?: boolean }} [options]
 * @returns {boolean}
 */
export function isSafeAttachmentUrl(value, options) {
    return toSafeAttachmentUrl(value, options) !== null;
}
