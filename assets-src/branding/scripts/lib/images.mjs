import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Identifies an image by its magic bytes. The claimed MIME type of a relay is not trusted,
 * and an HTML error page must never be saved as a PNG.
 * @param {Buffer} bytes
 */
export function sniffImage(bytes) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { mime: 'image/png', ext: 'png' };
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { mime: 'image/jpeg', ext: 'jpg' };
    }
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
        return { mime: 'image/webp', ext: 'webp' };
    }
    throw new Error('Response bytes are not a PNG, JPEG or WebP image.');
}

/**
 * True when a PNG can hold transparency: an alpha channel (grey-alpha or RGBA) or a tRNS chunk.
 * Anything else, including a JPEG, is opaque. A relay can quietly return an opaque picture to a request for a transparent one.
 * @param {Buffer} bytes
 */
export function pngHasAlpha(bytes) {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return false;
    }
    const colourType = bytes[25];
    if (colourType === 4 || colourType === 6) {
        return true;
    }
    for (let at = 8; at + 8 <= bytes.length; at += 12 + bytes.readUInt32BE(at)) {
        const type = bytes.toString('latin1', at + 4, at + 8);
        if (type === 'tRNS') {
            return true;
        }
        if (type === 'IDAT') {
            return false;
        }
    }
    return false;
}

/** Reads a reference image from disk into the shape the providers take. */
export function readReference(path) {
    const bytes = readFileSync(path);
    return { bytes, mime: sniffImage(bytes).mime, filename: basename(path) };
}

/** @param {string} value base64 or a data URL */
export function decodeBase64Image(value) {
    return Buffer.from(value.replace(/^data:[^;,]+;base64,/, ''), 'base64');
}

/**
 * Downloads an image a relay returned by URL. No credentials are sent, only https is allowed,
 * and the download aborts (not just stops reading) once it passes the size cap or the deadline.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 */
export async function downloadImage(url, fetchImpl) {
    if (!/^https:\/\//i.test(url)) {
        throw new Error('Refusing to download an image from a URL that is not https.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Image download failed with HTTP ${response.status}.`);
        }
        const chunks = [];
        let total = 0;
        for await (const chunk of response.body) {
            total += chunk.length;
            if (total > MAX_DOWNLOAD_BYTES) {
                controller.abort();
                throw new Error('Image download passed the size cap.');
            }
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    } finally {
        clearTimeout(timer);
    }
}
