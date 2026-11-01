import { chromaOf, hueOf } from './rim-recolour.mjs';
import { srgbToOklab } from './pixel-colour.mjs';
import { opaqueBox } from './raster.mjs';
import { erodeMask, opaqueMask } from './shape-ops.mjs';

// The sticker (white outline and lavender rim) is about this wide at 1024 pixels; it is cut away before the head is looked for.
export const STICKER_WIDTH = 18;
// A row belongs to the head once it has a run of head coloured pixels this wide, which skips a strand of hair and a bell.
const MIN_HEAD_RUN = 40;
const FUR = { lightness: 0.88, chroma: 0.035 };
// The pink of an inner ear, in OKLab hue degrees.
const PINK = { min: -10, max: 45, chroma: 0.05, lightness: 0.6 };

/** True for the colours of a rabbit ear: white fur and pink inside. Hair, skin, bells and clothes are not. */
export function isEarColour(rgb) {
    const lab = srgbToOklab(rgb);
    const chroma = chromaOf(lab);
    if (lab[0] >= FUR.lightness && chroma < FUR.chroma) {
        return true;
    }
    const hue = hueOf(lab);
    return chroma >= PINK.chroma && lab[0] >= PINK.lightness && hue >= PINK.min && hue <= PINK.max;
}

/**
 * How tall a figure is, from the feet to the top of the head, with the ears left out where they can be told apart.
 * The head top is the first row, inside the sticker, that has a wide enough run of pixels that are not ear coloured (hair, in
 * practice). When there is none, the whole box is used instead and `method` says so. `xRange` limits the search to one
 * figure when two share a picture.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ xRange?: [number, number], stickerWidth?: number }} [options] `xRange` is [first, last] pixel column
 * @returns {{ box: import('./logo-frame.mjs').Box, headTop: number, feet: number, figureHeight: number, boxHeight: number, method: 'head' | 'box' }}
 */
export function measureFigure(raster, { xRange = [0, raster.width - 1], stickerWidth = STICKER_WIDTH } = {}) {
    const [first, last] = xRange;
    if (!(first >= 0 && last < raster.width && first <= last)) {
        throw new Error(`The x range ${first}..${last} is not inside the ${raster.width} pixel wide picture.`);
    }
    const windowed = { ...raster, data: Buffer.from(raster.data) };
    for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
            if (x < first || x > last) {
                windowed.data[(y * raster.width + x) * 4 + 3] = 0;
            }
        }
    }
    const box = opaqueBox(windowed, 128);
    if (!box) {
        throw new Error(`There is no figure in columns ${first}..${last}.`);
    }
    const feet = box.y + box.height;
    const inside = erodeMask(opaqueMask(windowed), raster.width, raster.height, stickerWidth);
    for (let y = box.y; y < feet; y++) {
        let run = 0;
        for (let x = first; x <= last + 1; x++) {
            const at = y * raster.width + x;
            const isHead = x <= last && inside[at] === 1 && !isEarColour([raster.data[at * 4], raster.data[at * 4 + 1], raster.data[at * 4 + 2]]);
            run = isHead ? run + 1 : 0;
            if (run >= MIN_HEAD_RUN) {
                return { box, headTop: y, feet, figureHeight: feet - y, boxHeight: box.height, method: 'head' };
            }
        }
    }
    return { box, headTop: box.y, feet, figureHeight: box.height, boxHeight: box.height, method: 'box' };
}
