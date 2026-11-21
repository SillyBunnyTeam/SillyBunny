import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * A picture in memory: RGBA, 4 bytes per pixel, row by row. `channels` is 3 for a picture read from a file with no
 * alpha channel, because its outputs are written without one too.
 * @typedef {{ width: number, height: number, data: Buffer, channels: 3 | 4 }} Raster
 */

/** @typedef {{ x: number, y: number, width: number, height: number }} Box */

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * @param {string | Buffer} input A path or the bytes of a picture.
 * @returns {Promise<Raster>}
 */
export async function readRaster(input) {
    const { hasAlpha } = await sharp(input).metadata();
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data, channels: hasAlpha ? 4 : 3 };
}

/**
 * @param {number} width
 * @param {number} height
 * @param {3 | 4} [channels]
 * @returns {Raster} Fully transparent.
 */
export function createRaster(width, height, channels = 4) {
    return { width, height, data: Buffer.alloc(width * height * 4), channels };
}

/**
 * @param {Raster} raster
 * @param {Box} box Inside the picture.
 * @returns {Raster}
 */
export function crop(raster, box) {
    const out = createRaster(box.width, box.height, raster.channels);
    for (let y = 0; y < box.height; y++) {
        const from = ((box.y + y) * raster.width + box.x) * 4;
        raster.data.copy(out.data, y * box.width * 4, from, from + box.width * 4);
    }
    return out;
}

/**
 * Copies `source` onto `target` at (left, top). Pixels outside the target and fully transparent source pixels are
 * skipped, so the colour under a transparent pixel of the target stays as it was.
 * @param {Raster} target
 * @param {Raster} source
 * @param {number} left
 * @param {number} top
 * @returns {Raster} The target.
 */
export function paste(target, source, left, top) {
    for (let y = 0; y < source.height; y++) {
        for (let x = 0; x < source.width; x++) {
            const tx = left + x;
            const ty = top + y;
            const from = (y * source.width + x) * 4;
            if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height || source.data[from + 3] === 0) {
                continue;
            }
            source.data.copy(target.data, (ty * target.width + tx) * 4, from, from + 4);
        }
    }
    return target;
}

/**
 * @param {Raster} raster
 * @param {number} [minAlpha]
 * @returns {Box | undefined} The smallest box that holds every pixel with at least `minAlpha`, or undefined when there is none.
 */
export function opaqueBox(raster, minAlpha = 1) {
    const { width, height, data } = raster;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] >= minAlpha) {
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = y;
            }
        }
    }
    return right < 0 ? undefined : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** True when every pixel is fully transparent or fully opaque, which is what a native-grid master of a figure is. */
export const hasBinaryAlpha = (raster) => raster.data.every((value, at) => at % 4 !== 3 || value === 0 || value === 255);

/** True when no pixel is even partly transparent. */
export const isOpaque = (raster) => raster.data.every((value, at) => at % 4 !== 3 || value === 255);

/**
 * A whole-number enlargement by copying pixels, so no colour is made up.
 * @param {Raster} raster
 * @param {number} factor
 * @returns {Raster}
 */
export function upscaleNearest(raster, factor) {
    if (!Number.isInteger(factor) || factor < 1) {
        throw new Error(`An enlargement must be a whole number of 1 or more, got ${factor}.`);
    }
    const out = createRaster(raster.width * factor, raster.height * factor, raster.channels);
    for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) {
            const from = (Math.floor(y / factor) * raster.width + Math.floor(x / factor)) * 4;
            raster.data.copy(out.data, (y * out.width + x) * 4, from, from + 4);
        }
    }
    return out;
}

/**
 * Whether two pictures show the same pixels. The colour under a fully transparent pixel is never seen, and the WebP
 * encoder may change it, so it is not compared.
 * @param {Raster} one
 * @param {Raster} two
 */
export function samePixels(one, two) {
    if (one.width !== two.width || one.height !== two.height) {
        return false;
    }
    for (let at = 0; at < one.data.length; at += 4) {
        const alpha = one.data[at + 3];
        if (alpha !== two.data[at + 3]) {
            return false;
        }
        if (alpha !== 0 && (one.data[at] !== two.data[at] || one.data[at + 1] !== two.data[at + 1] || one.data[at + 2] !== two.data[at + 2])) {
            return false;
        }
    }
    return true;
}
