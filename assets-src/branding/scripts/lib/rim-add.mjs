import { srgbToOklab } from './pixel-colour.mjs';
import {
    NEIGHBOURS_8,
    OPAQUE,
    RIM_HUE,
    RIM_LIGHTNESS,
    RIM_MIN_CHROMA,
    SAMPLE_DEPTHS,
    SEARCH_DEPTH,
    chromaOf,
    hueOf,
    insideDepths,
    median,
    rimReference,
} from './rim-recolour.mjs';

const OPAQUE_ALPHA = 255;
const WHITE_LAB_LIGHTNESS = 1;
const INFINITE = 1e20;

/** True for a colour that could be the lavender rim: violet, coloured and of middle lightness. White and skin are not. */
const isRimColour = (lab) => {
    const hue = hueOf(lab);
    return chromaOf(lab) >= RIM_MIN_CHROMA && hue >= RIM_HUE.min && hue <= RIM_HUE.max && lab[0] >= RIM_LIGHTNESS.min && lab[0] <= RIM_LIGHTNESS.max;
};

const opaqueMask = (raster) => Uint8Array.from({ length: raster.width * raster.height }, (_, at) => (raster.data[at * 4 + 3] >= OPAQUE ? 1 : 0));
const labAt = (raster) => (at) => srgbToOklab([raster.data[at * 4], raster.data[at * 4 + 1], raster.data[at * 4 + 2]]);

/**
 * How far a sticker's lavender rim reaches in from the silhouette, in source pixels: the distance at which the colour has gone
 * half way from the rim's own lightness to white, found between the median lightness of each ring of pixels.
 * @param {import('./raster.mjs').Raster} raster
 */
export function measureRimWidth(raster) {
    const { width, height } = raster;
    const opaque = opaqueMask(raster);
    const depth = insideDepths(opaque, width, height, SEARCH_DEPTH);
    const lab = labAt(raster);
    const rings = Array.from({ length: SEARCH_DEPTH + 1 }, () => []);
    for (let at = 0; at < depth.length; at++) {
        if (depth[at] > 0) {
            rings[depth[at]].push(lab(at)[0]);
        }
    }
    const rimLightness = median(SAMPLE_DEPTHS.flatMap((level) => rings[level]));
    if (!Number.isFinite(rimLightness) || rimLightness > RIM_LIGHTNESS.max) {
        throw new Error('No lavender rim found along the edge, so there is no rim width to measure.');
    }
    const halfWay = (rimLightness + WHITE_LAB_LIGHTNESS) / 2;
    const ringLightness = rings.map((values) => (values.length > 0 ? median(values) : undefined));
    const crossing = ringLightness.findIndex((value, level) => level > 1 && value !== undefined && value >= halfWay);
    if (crossing < 0) {
        throw new Error(`No white band found within ${SEARCH_DEPTH} pixels of the edge, so the rim width cannot be measured.`);
    }
    // Ring k has its pixel centres k - 0.5 pixels in from the silhouette edge.
    const share = (halfWay - ringLightness[crossing - 1]) / (ringLightness[crossing] - ringLightness[crossing - 1]);
    return crossing - 1.5 + share;
}

/** Squared Euclidean distance to the nearest mask pixel along one line, by the lower envelope of parabolas (Felzenszwalb and Huttenlocher). */
function distanceLine(values, length) {
    const nearest = new Int32Array(length);
    const boundary = new Float64Array(length + 1);
    const out = new Float64Array(length);
    let last = 0;
    boundary[0] = -INFINITE;
    boundary[1] = INFINITE;
    for (let at = 1; at < length; at++) {
        let cross;
        do {
            const base = nearest[last];
            cross = (values[at] + at * at - (values[base] + base * base)) / (2 * at - 2 * base);
        } while (cross <= boundary[last] && last-- > 0);
        last++;
        nearest[last] = at;
        boundary[last] = cross;
        boundary[last + 1] = INFINITE;
    }
    last = 0;
    for (let at = 0; at < length; at++) {
        while (boundary[last + 1] < at) {
            last++;
        }
        out[at] = (at - nearest[last]) ** 2 + values[nearest[last]];
    }
    return out;
}

/** The distance in pixels from each pixel centre to the nearest pixel centre of the mask (0 inside it). */
export function distanceToMask(mask, width, height) {
    const squared = new Float64Array(width * height);
    for (let at = 0; at < squared.length; at++) {
        squared[at] = mask[at] === 1 ? 0 : INFINITE;
    }
    const column = new Float64Array(height);
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            column[y] = squared[y * width + x];
        }
        distanceLine(column, height).forEach((value, y) => {
            squared[y * width + x] = value;
        });
    }
    for (let y = 0; y < height; y++) {
        distanceLine(squared.subarray(y * width, (y + 1) * width), width).forEach((value, x) => {
            squared[y * width + x] = value;
        });
    }
    return squared.map(Math.sqrt);
}

/**
 * The translucent lavender fringe some models draw outside the white band instead of a solid rim: pixels of rim colour that can be
 * reached from the outside through rim coloured pixels, and so are not the band or the character. It starts at the pixels that are
 * at least half opaque and goes on outward through the fainter ones.
 */
function findFringe(raster, opaque, depth) {
    const { width, height } = raster;
    const lab = labAt(raster);
    const fringe = new Uint8Array(width * height);
    const queue = [];
    const consider = (at) => {
        if (opaque[at] === 1 && fringe[at] === 0 && isRimColour(lab(at))) {
            fringe[at] = 1;
            queue.push(at);
        }
    };
    for (let at = 0; at < depth.length; at++) {
        if (depth[at] === 1) {
            consider(at);
        }
    }
    for (let head = 0; head < queue.length; head++) {
        const x = queue[head] % width;
        const y = Math.floor(queue[head] / width);
        for (const [dx, dy] of NEIGHBOURS_8) {
            const nx = x + dx;
            const ny = y + dy;
            const next = ny * width + nx;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height && depth[next] > 0 && depth[next] <= SEARCH_DEPTH) {
                consider(next);
            }
        }
    }
    for (let head = 0; head < queue.length; head++) {
        const x = queue[head] % width;
        const y = Math.floor(queue[head] / width);
        for (const [dx, dy] of NEIGHBOURS_8) {
            const nx = x + dx;
            const ny = y + dy;
            const next = ny * width + nx;
            const isFaint = nx >= 0 && ny >= 0 && nx < width && ny < height && opaque[next] === 0 && raster.data[next * 4 + 3] > 0;
            if (isFaint && fringe[next] === 0 && isRimColour(lab(next))) {
                fringe[next] = 1;
                queue.push(next);
            }
        }
    }
    return fringe;
}

const hasSolidRim = (raster, depth) => {
    try {
        rimReference(raster, depth, labAt(raster));
        return true;
    } catch {
        return false;
    }
};

/**
 * Draws a sticker rim for a picture whose white band has none: the opaque silhouette (the band and everything inside it) is grown
 * outward by `width` pixels and the new ring is filled with `target`, with an antialiased outer edge.
 * The band and the character are never touched: only pixels outside them change. A faint pixel there (the antialiased edge of the
 * band) is kept and shown over the ring, and a translucent lavender fringe the model drew outside the band is replaced by the ring
 * where the ring is stronger. A picture that already has a solid rim is refused, so a rim is never drawn twice.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ target: number[], width: number }} options target colour as 0-255 RGB; width in source pixels, may be fractional
 */
export function addRim(raster, { target, width: rimWidth }) {
    if (!Number.isFinite(rimWidth) || rimWidth <= 0) {
        throw new Error(`The rim width must be a positive number of pixels, got ${rimWidth}.`);
    }
    const { width, height } = raster;
    const opaque = opaqueMask(raster);
    if (!opaque.includes(1)) {
        throw new Error('The picture has nothing in it to grow a rim around.');
    }
    const depth = insideDepths(opaque, width, height, SEARCH_DEPTH);
    if (hasSolidRim(raster, depth)) {
        throw new Error('This picture already has a lavender rim; recolour it without --add-rim.');
    }
    const fringe = findFringe(raster, opaque, depth);
    const band = Uint8Array.from(opaque, (value, at) => (value === 1 && fringe[at] === 0 ? 1 : 0));
    if (!band.includes(1)) {
        throw new Error('The picture has no white band or character to grow a rim from.');
    }

    const distance = distanceToMask(band, width, height);
    const data = Buffer.from(raster.data);
    let added = 0;
    let replaced = 0;
    for (let at = 0; at < band.length; at++) {
        // A pixel whose centre is d away from the nearest band centre is covered by a ring of `rimWidth` from the band edge by this much.
        const coverage = Math.min(1, Math.max(0, rimWidth - distance[at] + 1));
        if (band[at] === 1) {
            continue;
        }
        const ringAlpha = coverage * OPAQUE_ALPHA;
        const existingAlpha = raster.data[at * 4 + 3];
        if (fringe[at] === 1) {
            // The old fringe goes whole: the ring's own edge replaces it, and what lies past the ring is cleared.
            data.set(coverage > 0 ? [...target, Math.round(ringAlpha)] : [raster.data[at * 4], raster.data[at * 4 + 1], raster.data[at * 4 + 2], 0], at * 4);
            replaced++;
        } else if (coverage === 0) {
            continue;
        } else {
            // The ring lies behind the pixel, so only the part of the pixel that is see-through shows it.
            const behind = coverage * (OPAQUE_ALPHA - existingAlpha);
            const alpha = existingAlpha + behind;
            const channels = target.map((channel, index) => (raster.data[at * 4 + index] * existingAlpha + channel * behind) / alpha);
            data.set([...channels.map((value) => Math.round(value)), Math.round(alpha)], at * 4);
        }
        added++;
    }
    return { raster: { width, height, data }, stats: { added, replaced, width: rimWidth, target } };
}

const SEARCH_STEPS = 14;
const SMALLEST_DRAWN_WIDTH = 0.5;
const LARGEST_DRAWN_WIDTH = SEARCH_DEPTH - 2;
const WIDTH_TOLERANCE = 0.3;

/**
 * `addRim` with the width given as `measureRimWidth` reads it on the finished picture, which is how the approved masters are
 * measured. The width of the ring itself differs from that by what the band's antialiased edge and any old fringe add, so the ring
 * width is searched (bisection; the measured width grows with it) until the result measures `measuredWidth`, to within a third of a pixel.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ target: number[], measuredWidth: number }} options
 */
export function addRimMeasured(raster, { target, measuredWidth }) {
    if (!Number.isFinite(measuredWidth) || measuredWidth <= 0 || measuredWidth > LARGEST_DRAWN_WIDTH) {
        throw new Error(`The measured width must be between 0 and ${LARGEST_DRAWN_WIDTH} pixels, got ${measuredWidth}.`);
    }
    let [low, high] = [SMALLEST_DRAWN_WIDTH, LARGEST_DRAWN_WIDTH];
    let best;
    for (let step = 0; step < SEARCH_STEPS; step++) {
        const drawn = (low + high) / 2;
        const result = addRim(raster, { target, width: drawn });
        let got;
        try {
            got = measureRimWidth(result.raster);
        } catch {
            got = Infinity;
        }
        if (best === undefined || Math.abs(got - measuredWidth) < best.error) {
            best = { result, error: Math.abs(got - measuredWidth), drawn };
        }
        if (got < measuredWidth) {
            low = drawn;
        } else {
            high = drawn;
        }
    }
    if (best.error > WIDTH_TOLERANCE) {
        throw new Error(`No ring gives a measured width of ${measuredWidth}; the closest is ${best.error.toFixed(2)} pixels off.`);
    }
    return { raster: best.result.raster, stats: { ...best.result.stats, width: best.drawn, measuredWidth } };
}
