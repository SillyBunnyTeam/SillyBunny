/**
 * The sticker around a figure: a rim along its silhouette and a white band inside the rim, in the colours of the
 * shipped art.
 */
export const STICKER = Object.freeze({ rim: Object.freeze([185, 155, 242]), band: Object.freeze([255, 255, 255]) });

// measureRings stops looking past this many art pixels, which is wider than any ring the art draws.
const WIDEST_RING = 16;
// A depth is the square root of a whole number, so one that should equal a whole width may come out a hair over it.
const EPSILON = 1e-6;
const FAR = 1e20;

/**
 * How deep each pixel lies in its figure: the distance from its centre to the centre of the nearest transparent pixel,
 * and 0 for a transparent one. Only transparent pixels of the canvas count, so a figure cut by the canvas border has no
 * edge along the cut.
 * @param {import('./raster.js').Raster} raster
 * @returns {Float64Array}
 */
export function depthInFigure(raster) {
    const { width, height, data } = raster;
    const clear = Uint8Array.from({ length: width * height }, (_, at) => (data[at * 4 + 3] === 0 ? 1 : 0));
    return distanceToMask(clear, width, height);
}

/**
 * Paints the sticker again from the silhouette in: every opaque pixel within `rim` art pixels of transparent space takes
 * the rim colour, and every one within the next `band` takes the band colour. A fit leaves the rings ragged, because a
 * cell on the edge takes the colour most of its master pixels have, which may be the art or the band.
 * @param {import('./raster.js').Raster} raster With alpha 0 or 255 only.
 * @param {{ rim: number, band: number }} widths In art pixels.
 * @param {{ rim: readonly number[], band: readonly number[] }} [colours]
 * @returns {{ raster: import('./raster.js').Raster, changed: number }} `changed` counts the pixels that took a new colour.
 */
export function rebuildRings(raster, { rim, band }, colours = STICKER) {
    const depth = depthInFigure(raster);
    const rebuilt = { ...raster, data: Buffer.from(raster.data) };
    let changed = 0;
    for (let at = 0; at < depth.length; at++) {
        if (raster.data[at * 4 + 3] === 0) {
            continue;
        }
        const colour = depth[at] <= rim + EPSILON ? colours.rim : depth[at] <= rim + band + EPSILON ? colours.band : null;
        if (colour && colour.some((channel, index) => rebuilt.data[at * 4 + index] !== channel)) {
            rebuilt.data.set(colour, at * 4);
            changed++;
        }
    }
    return { raster: rebuilt, changed };
}

/**
 * The widths the rings of a picture really have. The rim is the widest whole number of art pixels within which every
 * opaque pixel has the rim colour, and the band is the same for the pixels after it in the band colour, so a gap or a
 * thin stretch shows as a smaller width. Band-coloured art further in, such as white fur, is not counted.
 * @param {import('./raster.js').Raster} raster
 * @param {{ rim: readonly number[], band: readonly number[] }} [colours]
 * @returns {{ rim: number, band: number }}
 */
export function measureRings(raster, colours = STICKER) {
    const depth = depthInFigure(raster);
    const opaque = [];
    for (let at = 0; at < depth.length; at++) {
        if (raster.data[at * 4 + 3] !== 0) {
            opaque.push(at);
        }
    }
    const hasColour = (at, colour) => colour.every((channel, index) => raster.data[at * 4 + index] === channel);
    const reach = (from, colour) => {
        let widest = 0;
        while (widest < WIDEST_RING && opaque.every((at) => depth[at] > from + widest + 1 + EPSILON || depth[at] <= from + EPSILON || hasColour(at, colour))) {
            widest++;
        }
        return widest;
    };
    const rim = reach(0, colours.rim);
    return { rim, band: reach(rim, colours.band) };
}

/**
 * The distance from each pixel centre to the nearest pixel centre of the mask, and 0 inside it.
 * @param {Uint8Array} mask 1 for a pixel of the mask.
 * @param {number} width
 * @param {number} height
 * @returns {Float64Array}
 */
export function distanceToMask(mask, width, height) {
    const squared = new Float64Array(width * height);
    for (let at = 0; at < squared.length; at++) {
        squared[at] = mask[at] === 1 ? 0 : FAR;
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

/** The squared distance to the nearest mask pixel along one line, by the lower envelope of parabolas (Felzenszwalb and Huttenlocher). */
function distanceLine(values, length) {
    const nearest = new Int32Array(length);
    const boundary = new Float64Array(length + 1);
    const out = new Float64Array(length);
    let last = 0;
    boundary[0] = -FAR;
    boundary[1] = FAR;
    for (let at = 1; at < length; at++) {
        let cross;
        do {
            const base = nearest[last];
            cross = (values[at] + at * at - (values[base] + base * base)) / (2 * at - 2 * base);
        } while (cross <= boundary[last] && last-- > 0);
        last++;
        nearest[last] = at;
        boundary[last] = cross;
        boundary[last + 1] = FAR;
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
