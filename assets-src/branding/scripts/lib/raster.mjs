import sharp from 'sharp';

/** @typedef {{ width: number, height: number, data: Uint8Array }} Raster RGBA, 4 bytes per pixel, row by row */

/** Reads a picture from a file path or from its bytes. */
export async function readRaster(path) {
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
}

/**
 * Writes a PNG. `indexed` stores a palette PNG, which is smaller for pixel art and lossless as long as the picture
 * has 256 colours or fewer (libimagequant keeps every colour when it does not need to reduce any).
 * @param {string} path
 * @param {Raster} raster
 * @param {{ indexed?: boolean }} [options]
 */
export async function writeRaster(path, raster, { indexed = false } = {}) {
    const image = sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } });
    await (indexed ? image.png({ palette: true, colours: 256, dither: 0, compressionLevel: 9 }) : image.png({ compressionLevel: 9 })).toFile(path);
}

/** The PNG bytes of a raster, lossless. */
export const encodePng = (raster) => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();

/** The smallest box around boxes. @param {{ x: number, y: number, width: number, height: number }[]} boxes */
export function unionBox(boxes) {
    const left = Math.min(...boxes.map(({ x }) => x));
    const top = Math.min(...boxes.map(({ y }) => y));
    const right = Math.max(...boxes.map(({ x, width }) => x + width));
    const bottom = Math.max(...boxes.map(({ y, height }) => y + height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

export function createRaster(width, height) {
    return { width, height, data: Buffer.alloc(width * height * 4) };
}

/** Smallest box holding every pixel with at least `minAlpha`, or undefined when there is none. */
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

/** True when every pixel is either fully transparent or fully opaque, which is what a snapped still is. */
export const hasBinaryAlpha = (raster) => raster.data.every((value, at) => at % 4 !== 3 || value === 0 || value === 255);

export function crop(raster, box) {
    const out = createRaster(box.width, box.height);
    for (let y = 0; y < box.height; y++) {
        const from = ((box.y + y) * raster.width + box.x) * 4;
        out.data.set(raster.data.subarray(from, from + box.width * 4), y * box.width * 4);
    }
    return out;
}

/** Copies `source` onto `target` at (left, top); pixels that fall outside the target are dropped. Transparent source pixels are skipped. */
export function paste(target, source, left, top) {
    for (let y = 0; y < source.height; y++) {
        for (let x = 0; x < source.width; x++) {
            const tx = left + x;
            const ty = top + y;
            const from = (y * source.width + x) * 4;
            if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height || source.data[from + 3] === 0) {
                continue;
            }
            target.data.set(source.data.subarray(from, from + 4), (ty * target.width + tx) * 4);
        }
    }
    return target;
}

/** @param {string} text like 128x128 @param {string} flag used in the error message */
export function parseSize(text, flag) {
    const match = /^(\d+)x(\d+)$/.exec(text ?? '');
    if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) {
        throw new Error(`${flag} must be WIDTHxHEIGHT such as 128x128, got "${text}".`);
    }
    return { width: Number(match[1]), height: Number(match[2]) };
}

/** A whole-number enlargement by copying pixels, so no colour is made up. */
export function upscaleNearest(raster, factor) {
    if (!Number.isInteger(factor) || factor < 1) {
        throw new Error(`The enlargement must be a whole number of 1 or more, got ${factor}.`);
    }
    const out = createRaster(raster.width * factor, raster.height * factor);
    for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) {
            const from = (Math.floor(y / factor) * raster.width + Math.floor(x / factor)) * 4;
            out.data.set(raster.data.subarray(from, from + 4), (y * out.width + x) * 4);
        }
    }
    return out;
}
