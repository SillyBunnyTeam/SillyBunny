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
 * @param {{ xRange?: [number, number], stickerWidth?: number, minHeadRun?: number }} [options] `xRange` is [first, last] pixel column; `stickerWidth` and `minHeadRun` are in the picture's own pixels, so a snapped still needs them in art pixels
 * @returns {{ box: import('./logo-frame.mjs').Box, headTop: number, feet: number, figureHeight: number, boxHeight: number, method: 'head' | 'box' }}
 */
export function measureFigure(raster, { xRange = [0, raster.width - 1], stickerWidth = STICKER_WIDTH, minHeadRun = MIN_HEAD_RUN } = {}) {
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
            if (run >= minHeadRun) {
                return { box, headTop: y, feet, figureHeight: feet - y, boxHeight: box.height, method: 'head' };
            }
        }
    }
    return { box, headTop: box.y, feet, figureHeight: box.height, boxHeight: box.height, method: 'box' };
}

// The height of the opaque box of a typical 1024 pixel master, which STICKER_WIDTH and MIN_HEAD_RUN were tuned for.
const REFERENCE_BOX_HEIGHT = 1010;

/**
 * `measureFigure` for a picture that is not at the size of a master: the sticker width and the head run are scaled by how tall the
 * picture's own box is against a typical master's, so a snapped still (a third of the pixels) and a master are measured by the same rule.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ xRange?: [number, number] }} [options]
 */
export function measureFigureScaled(raster, options = {}) {
    const box = opaqueBox(raster, 128);
    if (!box) {
        throw new Error('There is no figure to measure: nothing in the picture is opaque.');
    }
    const scale = box.height / REFERENCE_BOX_HEIGHT;
    return measureFigure(raster, { ...options, stickerWidth: Math.max(1, Math.round(STICKER_WIDTH * scale)), minHeadRun: Math.max(3, Math.round(MIN_HEAD_RUN * scale)) });
}

// Skin in OKLab: light, a little chroma, hue (degrees) in the yellow-orange band. Hair, the two characters', is purple or dark.
const SKIN = { lightness: 0.8, chroma: 0.03, hueMin: 35, hueMax: 80 };
// Rows below the head top row that are read to see what the head top is made of.
const HEAD_ROWS = 5;
// More than this share of the head top rows being skin means a hand or arm was taken for the head.
const SKIN_SHARE_LIMIT = 0.5;

const isSkinColour = (rgb) => {
    const lab = srgbToOklab(rgb);
    const hue = hueOf(lab);
    return lab[0] >= SKIN.lightness && chromaOf(lab) >= SKIN.chroma && hue >= SKIN.hueMin && hue <= SKIN.hueMax;
};

/**
 * What looks wrong with a head top and feet found by `measureFigure`: the head top was not found, the pixels that made the head top are
 * mostly skin (a raised hand or arm taken for the head), or the feet reach the bottom edge of the canvas (they may be cut off).
 * @param {import('./raster.mjs').Raster} raster
 * @param {ReturnType<typeof measureFigure>} measured
 * @returns {string[]} one sentence per problem; empty when nothing looks wrong
 */
export function figureProblems(raster, measured) {
    const problems = [];
    if (measured.method !== 'head') {
        problems.push('the head top was not found, so the whole box was measured');
        return problems;
    }
    let skin = 0;
    let counted = 0;
    for (let y = measured.headTop; y < Math.min(raster.height, measured.headTop + HEAD_ROWS); y++) {
        for (let x = measured.box.x; x < measured.box.x + measured.box.width; x++) {
            const at = (y * raster.width + x) * 4;
            const rgb = [raster.data[at], raster.data[at + 1], raster.data[at + 2]];
            if (raster.data[at + 3] > 200 && !isEarColour(rgb)) {
                counted++;
                skin += isSkinColour(rgb) ? 1 : 0;
            }
        }
    }
    if (counted > 0 && skin / counted > SKIN_SHARE_LIMIT) {
        problems.push(`the head top (row ${measured.headTop}) is ${Math.round((skin / counted) * 100)}% skin coloured: a hand or arm may have been taken for the head`);
    }
    if (measured.feet >= raster.height - 1) {
        problems.push(`the feet reach the bottom edge (row ${measured.feet} of ${raster.height}), so they may be cut off`);
    }
    return problems;
}
