import sharp from 'sharp';
import { readRaster } from './raster.js';

/**
 * The encoder settings behind each encoding name in the manifest. A changed setting changes the bytes of every file
 * that uses the name, and the byte proof then fails until the art is derived again.
 */
const ENCODINGS = Object.freeze({
    'webp-lossless': (image) => image.webp({ lossless: true, effort: 6 }),
    png: (image) => image.png({ compressionLevel: 9 }),
    // Adaptive filtering suits a smooth gradient with a sprite on it. sharp quantises to a palette from effort 10, so the
    // palette stays off to keep every pixel.
    'png-card': (image) => image.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }),
});

export const ENCODING_NAMES = Object.freeze(Object.keys(ENCODINGS));

/** The libraries whose versions decide the bytes of an encoded file. */
export const ENCODER_LIBRARIES = Object.freeze(['sharp', 'vips', 'webp', 'png', 'zlib-ng']);

/**
 * @param {import('./raster.js').Raster} raster
 * @param {string} encoding One of `ENCODING_NAMES`.
 * @returns {Promise<Buffer>} A picture with an alpha channel only when the raster has one.
 */
export async function encode(raster, encoding) {
    const make = ENCODINGS[encoding];
    if (!make) {
        throw new Error(`There is no encoding named "${encoding}". Known encodings: ${ENCODING_NAMES.join(', ')}.`);
    }
    const channels = raster.channels === 3 ? 3 : 4;
    const data = channels === 3 ? dropAlpha(raster) : raster.data;
    return make(sharp(data, { raw: { width: raster.width, height: raster.height, channels } })).toBuffer();
}

/**
 * @param {Buffer} bytes
 * @returns {Promise<import('./raster.js').Raster>}
 */
export const decode = (bytes) => readRaster(bytes);

function dropAlpha({ width, height, data }) {
    const rgb = Buffer.alloc(width * height * 3);
    for (let from = 0, to = 0; from < data.length; from += 4, to += 3) {
        data.copy(rgb, to, from, from + 3);
    }
    return rgb;
}

/** @returns {Record<string, string>} The version of each library in `ENCODER_LIBRARIES` that this install loads. */
export function encoderVersions() {
    return Object.fromEntries(ENCODER_LIBRARIES.map((name) => [name, sharp.versions[name] ?? 'missing']));
}

/**
 * @param {Record<string, string>} expected The versions the shipped bytes were made with.
 * @returns {{ library: string, expected: string, actual: string }[]}
 */
export function encoderMismatches(expected) {
    const actual = encoderVersions();
    return ENCODER_LIBRARIES
        .filter((library) => expected[library] !== actual[library])
        .map((library) => ({ library, expected: expected[library], actual: actual[library] }));
}
