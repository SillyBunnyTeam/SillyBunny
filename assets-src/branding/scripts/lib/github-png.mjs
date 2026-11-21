import sharp from 'sharp';
import { isOpaque, readRaster } from './raster.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */

const MAX_PALETTE = 256;

/** How many different colours (alpha included) the raster uses, counting up to `limit + 1`. */
export function countColours(raster, limit = MAX_PALETTE) {
    const seen = new Set();
    const words = new Uint32Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength / 4);
    for (const word of words) {
        seen.add(word);
        if (seen.size > limit) {
            break;
        }
    }
    return seen.size;
}

/** True when the PNG decodes to a picture of the raster's size with exactly the raster's pixels. */
export async function isLossless(png, raster) {
    const decoded = await readRaster(png);
    return decoded.width === raster.width && decoded.height === raster.height && Buffer.compare(Buffer.from(decoded.data), Buffer.from(raster.data)) === 0;
}

/**
 * The smallest lossless PNG of a picture: the same pixels as a truecolour file (with no alpha channel when every pixel is opaque),
 * and as a palette file when there are 256 colours or fewer, whichever is smaller. A palette is never made by reducing colours.
 *
 * sharp turns on palette mode for any of `effort`, `colours`, `quality` and `dither`, and a palette of a picture with more colours
 * than that is a lossy one, so the truecolour file is made with `compressionLevel` and `adaptiveFiltering` alone. Every candidate is
 * decoded and compared before it is allowed to win.
 * @param {Raster} raster
 * @returns {Promise<Buffer>}
 */
export async function optimisePng(raster) {
    const source = () => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } });
    const truecolour = { compressionLevel: 9, adaptiveFiltering: true };
    const candidates = [await (isOpaque(raster) ? source().removeAlpha() : source()).png(truecolour).toBuffer()];
    if (countColours(raster) <= MAX_PALETTE) {
        candidates.push(await source().png({ ...truecolour, palette: true, effort: 10, colours: MAX_PALETTE, dither: 0 }).toBuffer());
    }
    const lossless = [];
    for (const candidate of candidates) {
        if (await isLossless(candidate, raster)) {
            lossless.push(candidate);
        }
    }
    if (lossless.length === 0) {
        throw new Error('The PNG encoder changed the picture, so no file was made.');
    }
    return lossless.reduce((best, candidate) => (candidate.length < best.length ? candidate : best));
}
