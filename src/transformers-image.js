import { Buffer } from 'node:buffer';

// Leading bytes of each image format that the server's jimp decodes, as [offset, hex] pairs.
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

/** @type {Promise<{ Jimp: typeof import('./jimp.js').Jimp, JimpRawImage: any }>|null} */
let decoderPromise = null;

/**
 * Builds the jimp-backed RawImage class on first use.
 * SillyBunny: sillytavern-transformers and jimp load only when an image is decoded, not at server boot.
 * @returns {Promise<{ Jimp: typeof import('./jimp.js').Jimp, JimpRawImage: any }>} jimp and the RawImage subclass
 */
function loadDecoder() {
    if (!decoderPromise) {
        decoderPromise = (async () => {
            const { RawImage } = await import('sillytavern-transformers');
            const { Jimp } = await import('./jimp.js');
            /**
             * RawImage that resizes with the server's jimp. On the browser code path, which sillytavern-transformers
             * takes under Bun, RawImage.resize() needs OffscreenCanvas, which Bun lacks.
             */
            class JimpRawImage extends RawImage {
                /**
                 * @param {number} width New width
                 * @param {number} height New height
                 * @returns {Promise<RawImage>} Resized image with the same number of channels
                 */
                async resize(width, height) {
                    const rgba = this.channels === 4 ? this : this.clone().rgba();
                    const image = new Jimp({ data: Buffer.from(rgba.data), width: this.width, height: this.height });
                    image.resize({ w: width, h: height });
                    const { data, width: newWidth, height: newHeight } = image.bitmap;
                    return new JimpRawImage(new Uint8ClampedArray(data), newWidth, newHeight, 4).convert(this.channels);
                }
            }
            return { Jimp, JimpRawImage };
        })().catch((error) => {
            decoderPromise = null;
            throw error;
        });
    }
    return decoderPromise;
}

/**
 * Checks that a buffer starts with the signature of a supported image format.
 * jimp finds the format with file-type, and file-type before 21.3.1 loops forever
 * on a malformed ASF header (GHSA-5v7r-6r5c-r473), so other input must not reach jimp.
 * @param {Buffer} buffer Encoded image
 * @returns {boolean} True if the buffer has a supported image signature
 */
function hasImageSignature(buffer) {
    return IMAGE_SIGNATURES.some(parts => parts.every(({ offset, bytes }) => buffer.subarray(offset, offset + bytes.length).equals(bytes)));
}

/**
 * Decodes an encoded image for a transformers.js pipeline.
 * RawImage.fromBlob() is not used because sillytavern-transformers takes its browser code path
 * when `self` is defined, as it is under Bun, and that path needs createImageBitmap(), which Bun lacks.
 * @param {Buffer} buffer Encoded image
 * @returns {Promise<import('sillytavern-transformers').RawImage>} Decoded RGBA image
 * @throws {Error} If the buffer is not a supported image or cannot be decoded
 */
export async function decodeRawImage(buffer) {
    if (!hasImageSignature(buffer)) {
        throw new Error('Unsupported image format');
    }

    const { Jimp, JimpRawImage } = await loadDecoder();
    const image = await Jimp.fromBuffer(buffer);
    const { data, width, height } = image.bitmap;
    return new JimpRawImage(new Uint8ClampedArray(data), width, height, 4);
}
