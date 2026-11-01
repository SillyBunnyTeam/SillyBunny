import { Buffer } from 'node:buffer';

import { RawImage } from 'sillytavern-transformers';

// Leading bytes of each image format that the server decodes, as [offset, hex] pairs.
const IMAGE_SIGNATURES = [
    [[0, '89504e470d0a1a0a']], // PNG and APNG
    [[0, 'ffd8ff']], // JPEG
    [[0, '47494638']], // GIF
    [[0, '424d']], // BMP
    [[0, '49492a00']], // TIFF, little-endian
    [[0, '4d4d002a']], // TIFF, big-endian
    [[0, '52494646'], [8, '57454250']], // WebP
    [[4, '6674797061766966']], // AVIF
].map(parts => parts.map(([offset, hex]) => ({ offset, bytes: Buffer.from(hex, 'hex') })));

/**
 * Checks that a buffer starts with the signature of a supported image format.
 * The decoders find the format with file-type, and file-type before 21.3.1 loops forever
 * on a malformed ASF header (GHSA-5v7r-6r5c-r473), so other input must not reach them.
 * @param {Buffer} buffer Encoded image
 * @returns {boolean} True if the buffer has a supported image signature
 */
function hasImageSignature(buffer) {
    return IMAGE_SIGNATURES.some(parts => parts.every(({ offset, bytes }) => buffer.subarray(offset, offset + bytes.length).equals(bytes)));
}

/**
 * Decodes an encoded image for a transformers.js pipeline.
 * @param {Buffer} buffer Encoded image
 * @returns {Promise<RawImage>} Decoded image
 * @throws {Error} If the buffer is not a supported image or cannot be decoded
 */
export async function decodeRawImage(buffer) {
    if (!hasImageSignature(buffer)) {
        throw new Error('Unsupported image format');
    }

    return await RawImage.fromBlob(new Blob([new Uint8Array(buffer)]));
}
