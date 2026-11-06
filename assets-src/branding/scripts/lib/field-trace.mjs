import { refitOutlines } from './curve-refit.mjs';
import { curveAt } from './dome-edge.mjs';
import { OUTLINE_FACTOR, boxOf, softField } from './outline-fit.mjs';
import { traceBitmap } from './potrace.mjs';
import { dilateMask, fillHoles, openMask } from './shape-ops.mjs';

/** @typedef {import('./geometry.mjs').PathCommand} PathCommand */

// The shape's edge is traced from its coverage, enlarged and blurred by this many source pixels, then cut at one half. A bigger blur
// gives longer curves and a smaller file, and rounds a sharp corner by about the same distance.
export const FIELD_SIGMA = 0.5;
// The luma that decides which tone a pixel has is blurred less, only enough to take out the grain of the picture's shading.
export const TONE_SIGMA = 0.3;
// Potrace's corner threshold and how far (in enlarged pixels) it may move a curve to join two.
export const FIELD_ALPHAMAX = 1.0;
export const FIELD_TOLERANCE = 0.6;
// The letters are cut out of the shape and traced on their own with a lower corner threshold, which keeps the straight sides of a stem and the
// corners of a counter. The same threshold on the long arcs of the ears and the dome leaves visible facets, so those use `FIELD_ALPHAMAX`.
export const LETTER_ALPHAMAX = 0.8;
// Potrace's curves are fitted again with as few cubics as stay within this many source pixels of them. At the enlarged scale potrace
// keeps a segment every few pixels along a long arc, which is a file several times the size for no visible gain.
export const REFIT_TOLERANCE = 0.3;

// Coverage is read from the picture's alpha this many pixels from the body, which holds the soft edge of the shape.
const REACH = 2;
// Where a side is drawn from its curve, this far outside the curve and this far inside it. Outside has to reach the stubs a cut line leaves;
// inside only has to hold the edge pixel, so a letter close to the side is not filled.
const WINDOW_OUT = 12;
const WINDOW_IN = 3;
// Above and below the rows of a curve, its weight falls to nothing over this many rows.
const RAMP = 14;
// In those rows the curve is used only where the shape's side is within this many pixels of it. Further off, the picture has turned away
// from the curve (at the bottom corner of the dome, say), and drawing the curve on would cut or add a piece of the corner.
const RAMP_REACH = 2;
// A band is drawn this many source pixels past the shape's edge where it touches it. The shape and the band are traced one at a time, so
// their edges differ by a fraction of a pixel, and where the band's is inside the shape's the base tone shows as a thin line beside it.
// With the band reaching past, the band's edge is the one that shows.
export const BAND_OVERHANG = 0.25;
// Only the parts of a band at least this many source pixels wide reach past the shape. A band narrows to a point where it leaves the edge, and
// there reaching past would draw a small hook of the band's colour beyond the point.
const OVERHANG_MIN_WIDTH = 2;
// What is kept around the shape so that the blur and the cut have room.
const MARGIN = 8;
// The luma of the picture goes on outwards this many pixels past the body, which lets a band's edge reach the edge of the shape.
const OUTWARD = 4;

/** Rec. 709 luma of a colour, 0 to 255. */
export const lumaOf = (red, green, blue) => 0.2126 * red + 0.7152 * green + 0.0722 * blue;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Where the body's side is on row `y`, as the pixel boundary, looking only in columns `first` to `last`; infinity when the row has none there. */
function bodyEdge(body, width, y, side, first, last) {
    if (side === 'left') {
        for (let x = first; x <= last; x++) {
            if (body[y * width + x] === 1) {
                return x;
            }
        }
        return Infinity;
    }
    for (let x = last; x >= first; x--) {
        if (body[y * width + x] === 1) {
            return x + 1;
        }
    }
    return Infinity;
}

/**
 * How much of each pixel the shape covers, 0 to 1. Beside the body it is the picture's alpha, which holds where the edge is inside the
 * pixel. In `rows`, each side is drawn from its curve instead, so the steps a cut line left are not in it; the curve takes over over a
 * few rows at each end, and only where the side is still near it.
 * @param {{ alpha: Uint8Array, body: Uint8Array, width: number, height: number, curves?: { left: import('./dome-edge.mjs').EdgeCurve, right: import('./dome-edge.mjs').EdgeCurve }, rows?: number[] }} request
 * `body` is 1 for the pixels of the shape, with the lines taken out
 * @returns {Float32Array}
 */
export function silhouetteCoverage({ alpha, body, width, height, curves, rows }) {
    const near = dilateMask(body, width, height, REACH);
    const coverage = Float32Array.from(alpha, (value, at) => (near[at] === 1 ? value / 255 : 0));
    if (!curves) {
        return coverage;
    }
    const [from, to] = rows;
    for (let y = Math.max(0, from - RAMP); y < Math.min(height, to + RAMP); y++) {
        const weight = y < from ? 1 - (from - y) / RAMP : y >= to ? 1 - (y - to + 1) / RAMP : 1;
        if (weight <= 0) {
            continue;
        }
        for (const side of ['left', 'right']) {
            const edge = curveAt(curves[side], y + 0.5);
            const whole = side === 'left' ? [Math.floor(edge) - WINDOW_OUT, Math.floor(edge) + WINDOW_IN] : [Math.floor(edge) - WINDOW_IN, Math.floor(edge) + WINDOW_OUT];
            const [firstColumn, lastColumn] = [Math.max(0, whole[0]), Math.min(width - 1, whole[1])];
            const reach = [Math.max(0, Math.floor(edge) - WINDOW_OUT), Math.min(width - 1, Math.floor(edge) + WINDOW_OUT)];
            if (weight < 1 && Math.abs(bodyEdge(body, width, y, side, ...reach) - edge) > RAMP_REACH) {
                continue;
            }
            for (let x = firstColumn; x <= lastColumn; x++) {
                const covered = clamp01(side === 'left' ? x + 1 - edge : edge - x);
                coverage[y * width + x] = (1 - weight) * coverage[y * width + x] + weight * covered;
            }
        }
    }
    return coverage;
}

/**
 * The luma of each pixel for deciding which tone it has. Where the pixel is as it was in the master, that is the master's own luma, which
 * holds where a band's edge is inside the pixel. Where it was redrawn, it is the luma of its tone. The luma goes on a few pixels outwards from
 * the shape and is the `fallback` tone's further away, so an edge pixel is not pulled towards the transparent colour.
 * @param {{ rgba: Uint8Array, width: number, height: number, index: Int8Array, original: Int8Array, lumas: number[], fallback: number }} request
 * `index` and `original` are the tone of each pixel (negative for none) after and before the pixels were redrawn
 * @returns {Float32Array}
 */
export function toneLumaField({ rgba, width, height, index, original, lumas, fallback }) {
    const luma = new Float32Array(width * height);
    const known = new Uint8Array(width * height);
    index.forEach((tone, at) => {
        if (tone < 0) {
            return;
        }
        known[at] = 1;
        luma[at] = tone === original[at] ? lumaOf(rgba[at * 4], rgba[at * 4 + 1], rgba[at * 4 + 2]) : lumas[tone];
    });
    for (let round = 0; round < OUTWARD; round++) {
        const added = [];
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const at = y * width + x;
                if (known[at] === 1) {
                    continue;
                }
                let [sum, count] = [0, 0];
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const neighbour = at + dy * width + dx;
                        if (known[neighbour] === 1) {
                            sum += luma[neighbour];
                            count++;
                        }
                    }
                }
                if (count > 0) {
                    added.push([at, sum / count]);
                }
            }
        }
        for (const [at, value] of added) {
            [luma[at], known[at]] = [value, 1];
        }
    }
    known.forEach((isKnown, at) => {
        if (isKnown === 0) {
            luma[at] = lumas[fallback];
        }
    });
    return luma;
}

/**
 * The shape and its two bands as path commands, all from fields at the same scale so that a band ends on the shape's edge and not beside it.
 * The shape is where the blurred coverage is at least one half. A band is where the blurred luma is past the middle between its tone and
 * the base tone, and inside the shape, reaching `overhang` past it. Each is traced with potrace.
 * @param {{ coverage: Float32Array, luma: Float32Array, width: number, height: number, levels: { dark: number, base: number, light: number } }} fields
 * `levels` is the luma of each tone
 * @param {{ potrace: string, directory: string, factor?: number, sigma?: number, toneSigma?: number, alphamax?: number, letterAlphamax?: number, opttolerance?: number, refitTolerance?: number, overhang?: number }} options
 * @returns {Promise<{ base: PathCommand[], letters: PathCommand[], dark: PathCommand[], light: PathCommand[] }>} in source pixels, y down. `base` is the
 * whole outline with no letters in it; `letters` are the letters as shapes, to be cut out of it (empty when the picture has none)
 */
export async function traceTones({ coverage, luma, width, height, levels }, { potrace, directory, factor = OUTLINE_FACTOR, sigma = FIELD_SIGMA, toneSigma = TONE_SIGMA, alphamax = FIELD_ALPHAMAX, letterAlphamax = LETTER_ALPHAMAX, opttolerance = FIELD_TOLERANCE, refitTolerance = REFIT_TOLERANCE, overhang = BAND_OVERHANG }) {
    const box = boxOf(Uint8Array.from(coverage, (value) => (value > 0 ? 1 : 0)), width, height);
    if (!box) {
        throw new Error('The coverage is empty, so there is nothing to trace.');
    }
    const [x0, y0] = [Math.max(0, box.left - MARGIN), Math.max(0, box.top - MARGIN)];
    const [cropWidth, cropHeight] = [Math.min(width, box.right + MARGIN) - x0, Math.min(height, box.bottom + MARGIN) - y0];
    const crop = (values, scale) => {
        const out = Buffer.alloc(cropWidth * cropHeight);
        for (let y = 0; y < cropHeight; y++) {
            for (let x = 0; x < cropWidth; x++) {
                out[y * cropWidth + x] = Math.round(values[(y + y0) * width + x + x0] * scale);
            }
        }
        return out;
    };
    const [shape, tone] = await Promise.all([softField(crop(coverage, 255), cropWidth, cropHeight, factor, sigma), softField(crop(luma, 1), cropWidth, cropHeight, factor, toneSigma)]);
    const inside = Uint8Array.from(shape, (value) => (value >= 128 ? 1 : 0));
    const [enlargedWidth, enlargedHeight] = [cropWidth * factor, cropHeight * factor];
    // The letters are the holes the outside cannot reach. The shape is traced with them filled in, and they are traced as shapes of their own.
    const whole = fillHoles(inside, enlargedWidth, enlargedHeight);
    const middles = { dark: (levels.dark + levels.base) / 2, light: (levels.base + levels.light) / 2 };
    const reachPast = (band) => {
        const broad = openMask(band, enlargedWidth, enlargedHeight, Math.round((OVERHANG_MIN_WIDTH * factor) / 2));
        const wide = dilateMask(broad, enlargedWidth, enlargedHeight, Math.round(overhang * factor));
        return band.map((value, at) => (value === 1 || (wide[at] === 1 && whole[at] === 0) ? 1 : 0));
    };
    const bitmaps = [
        { name: 'base', data: whole, alphamax, tolerance: refitTolerance },
        { name: 'letters', data: whole.map((value, at) => (value === 1 && inside[at] === 0 ? 1 : 0)), alphamax: letterAlphamax, tolerance: refitTolerance },
        { name: 'dark', data: reachPast(inside.map((value, at) => (value === 1 && tone[at] < middles.dark ? 1 : 0))), alphamax, tolerance: refitTolerance },
        { name: 'light', data: reachPast(inside.map((value, at) => (value === 1 && tone[at] > middles.light ? 1 : 0))), alphamax, tolerance: refitTolerance },
    ];
    const layers = {};
    for (const { name, data, alphamax: corner, tolerance } of bitmaps) {
        if (data.every((value) => value === 0)) {
            if (name !== 'letters') {
                throw new Error(`There is no pixel of the ${name} tone in the picture, so there is nothing to trace for it.`);
            }
            layers.letters = [];
            continue;
        }
        const traced = traceBitmap({ width: enlargedWidth, height: enlargedHeight, data }, { potrace, directory, alphamax: corner, opttolerance });
        const inSource = traced.map(({ command, points }) => ({ command, points: points.map(([x, y]) => [x0 + x / factor, y0 + y / factor]) }));
        layers[name] = refitOutlines(inSource, { tolerance });
    }
    return layers;
}
