import { oklabToSrgb, srgbToOklab } from './pixel-colour.mjs';
import { stickerMask } from './rim-recolour.mjs';

/**
 * Moves the colour of a picture toward a tint, in OKLab: each pixel goes `amount` of the way toward the target's a and b (its hue
 * and chroma, so grey and white pick up the tint and a strong colour is only nudged) and its lightness changes by `lightness`,
 * kept between 0 and 1. Alpha is never changed, and a fully transparent pixel keeps its bytes. With `keepSticker` the white band
 * and the lavender rim found by `stickerMask` are left as they are, so the shared rim colour is the same in all art.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ toward: number[], amount: number, lightness: number, keepSticker: boolean }} grade toward as 0-255 RGB
 * @returns {import('./raster.mjs').Raster} a new picture; the input is not changed
 */
export function gradeRaster(raster, { toward, amount, lightness, keepSticker }) {
    const data = Buffer.from(raster.data);
    if (amount === 0 && lightness === 0) {
        return { ...raster, data };
    }
    const [, targetA, targetB] = srgbToOklab(toward);
    const kept = keepSticker ? stickerMask(raster) : undefined;
    const graded = new Map();
    for (let at = 0; at < raster.width * raster.height; at++) {
        if (raster.data[at * 4 + 3] === 0 || kept?.[at] === 1) {
            continue;
        }
        const rgb = [raster.data[at * 4], raster.data[at * 4 + 1], raster.data[at * 4 + 2]];
        const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
        if (!graded.has(key)) {
            const [l, a, b] = srgbToOklab(rgb);
            const moved = oklabToSrgb([Math.min(1, Math.max(0, l + lightness)), a + (targetA - a) * amount, b + (targetB - b) * amount]);
            graded.set(key, moved.map((channel) => Math.min(255, Math.max(0, Math.round(channel)))));
        }
        data.set(graded.get(key), at * 4);
    }
    return { ...raster, data };
}
