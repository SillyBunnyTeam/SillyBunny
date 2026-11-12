import sharp from 'sharp';
import { createRaster, crop, opaqueBox, paste } from './raster.mjs';

const ALIGN_X = ['bbox', 'centroid'];
const LOCKS = ['each', 'first'];
const SCALES = ['none', 'fit'];

async function scaleRaster(raster, factor, nearest) {
    if (factor === 1) {
        return raster;
    }
    const width = Math.round(raster.width * factor);
    const height = Math.round(raster.height * factor);
    const { data } = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } })
        .resize(width, height, { kernel: nearest ? 'nearest' : 'lanczos3', fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { width, height, data };
}

function centroidX(raster) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
            if (raster.data[(y * raster.width + x) * 4 + 3] > 0) {
                sum += x + 0.5;
                count++;
            }
        }
    }
    return sum / count;
}

/**
 * Trims each image to its opaque box and places it on a shared canvas with the feet on one baseline and the figure on one centre line.
 * Pixels are copied, never resampled, unless `scale: 'fit'` asks for one common magnification (a whole number when `nearest`).
 * @param {import('./raster.mjs').Raster[]} rasters
 * @param {{ canvas: { width: number, height: number }, pad?: number, baseline?: number, alignX?: 'bbox' | 'centroid',
 *   lock?: 'each' | 'first', scale?: 'none' | 'fit', nearest?: boolean, minAlpha?: number }} options
 *   `pad` keeps the figure that far from every edge; `baseline` is the gap under the feet (default: pad). With `lock: 'first'`
 *   every later image keeps its offset from the first one, so frames of one animation keep their relative motion.
 */
export async function trimAlign(rasters, { canvas, pad = 0, baseline = pad, alignX = 'bbox', lock = 'each', scale = 'none', nearest = false, minAlpha = 1 }) {
    if (rasters.length === 0) {
        throw new Error('There are no images to align.');
    }
    for (const [name, value, allowed] of [['alignX', alignX, ALIGN_X], ['lock', lock, LOCKS], ['scale', scale, SCALES]]) {
        if (!allowed.includes(value)) {
            throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${value}".`);
        }
    }
    const boxes = rasters.map((raster, index) => {
        const box = opaqueBox(raster, minAlpha);
        if (!box) {
            throw new Error(`image ${index + 1} has nothing opaque (alpha ${minAlpha} or more).`);
        }
        return box;
    });

    const room = { width: canvas.width - 2 * pad, height: canvas.height - pad - baseline };
    let factor = 1;
    if (scale === 'fit') {
        factor = Math.min(...boxes.map((box) => Math.min(room.width / box.width, room.height / box.height)));
        factor = nearest ? Math.max(1, Math.floor(factor)) : factor;
    }
    const trimmed = [];
    for (const [index, raster] of rasters.entries()) {
        trimmed.push(await scaleRaster(crop(raster, boxes[index]), factor, nearest));
    }

    const placeOwn = (piece) => ({
        x: alignX === 'centroid' ? Math.round(canvas.width / 2 - centroidX(piece)) : Math.floor((canvas.width - piece.width) / 2),
        y: canvas.height - baseline - piece.height,
    });
    const anchor = placeOwn(trimmed[0]);
    return trimmed.map((piece, index) => {
        const own = lock === 'first' ? {
            x: anchor.x + Math.round((boxes[index].x - boxes[0].x) * factor),
            y: anchor.y + Math.round((boxes[index].y - boxes[0].y) * factor),
        } : placeOwn(piece);
        const fits = own.x >= pad && own.y >= pad && own.x + piece.width <= canvas.width - pad && own.y + piece.height <= canvas.height - baseline;
        if (!fits) {
            throw new Error(`image ${index + 1} is ${piece.width}x${piece.height} after trimming and does not fit the ${canvas.width}x${canvas.height} canvas with pad ${pad} and baseline ${baseline}. Pass --scale fit, a larger canvas or less padding.`);
        }
        return {
            raster: paste(createRaster(canvas.width, canvas.height), piece, own.x, own.y),
            placement: { x: own.x, y: own.y, width: piece.width, height: piece.height },
            scale: factor,
        };
    });
}
