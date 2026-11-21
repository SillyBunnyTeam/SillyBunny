import { oklabToSrgb, srgbToOklab } from './pixel-colour.mjs';

export const OPAQUE = 128;
const SOLID = 250;
// How deep into the sticker the search for white and for the rim goes, in pixels from the silhouette.
export const SEARCH_DEPTH = 16;
// A sticker drawn on a coarse pixel grid has a rim and a white band several grid cells thick, so the white band can lie deeper than
// SEARCH_DEPTH. The search then doubles its depth up to this limit. A sticker whose band is found at SEARCH_DEPTH never searches deeper.
const MAX_SEARCH_DEPTH = 256;
// The soft edge outside the silhouette that still carries the rim colour.
const HALO_REACH = 6;
export const SAMPLE_DEPTHS = [2, 3];
const MIN_SAMPLES = 50;
// A rim pixel is violet (OKLab hue in degrees), coloured and of middle lightness; the white band and skin are not.
export const RIM_HUE = { min: -120, max: -30 };
export const RIM_MIN_CHROMA = 0.04;
export const RIM_LIGHTNESS = { min: 0.55, max: 0.92 };
// Share of white pixels at which a depth counts as the white band, and how much deeper than that the rim may still reach.
const WHITE_BAND_SHARE = 0.25;
const WHITE_LIGHTNESS = 0.95;
const WHITE_MAX_CHROMA = 0.03;
// Share of white pixels a ring needs to still belong to the white band once it has started. Higher than WHITE_BAND_SHARE, which has to
// accept the half-antialiased first ring, so that white fur or pale skin just inside the band does not pull the band's end inwards.
const WHITE_BAND_SOLID_SHARE = 0.5;
const CAP_MARGIN = 1;
// A pixel is rim when at least this much of the way from white to the rim colour, and no further than this from that line.
const MIN_RIM_SHARE = 0.12;
const LINE_TOLERANCE = 0.12;
// A shift smaller than this is below what 8 bit colour can show, so the pixel keeps its bytes (which makes a second run a no-op).
const NEGLIGIBLE_SHIFT = 0.0015;
const NEIGHBOURS_4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const NEIGHBOURS_8 = [...NEIGHBOURS_4, [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** @param {string} text #rrggbb or rrggbb */
export function parseHexColour(text) {
    const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(text).trim());
    if (!match) {
        throw new Error(`Expected a hex colour such as #b99bf2, got "${text}".`);
    }
    return match.slice(1).map((pair) => parseInt(pair, 16));
}

export const chromaOf = (lab) => Math.hypot(lab[1], lab[2]);
export const hueOf = (lab) => (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
export const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Walks 4-connected rings in from the silhouette: 1 for an opaque pixel next to a transparent one. The canvas border is a cut, not an edge. */
export function insideDepths(opaque, width, height, limit) {
    const depth = new Int16Array(width * height);
    const queue = [];
    for (let at = 0; at < depth.length; at++) {
        if (opaque[at] === 0) {
            continue;
        }
        const x = at % width;
        const y = Math.floor(at / width);
        const touchesOutside = NEIGHBOURS_4.some(([dx, dy]) => {
            const nx = x + dx;
            const ny = y + dy;
            return nx >= 0 && ny >= 0 && nx < width && ny < height && opaque[ny * width + nx] === 0;
        });
        if (touchesOutside) {
            depth[at] = 1;
            queue.push(at);
        }
    }
    for (let head = 0; head < queue.length; head++) {
        const at = queue[head];
        if (depth[at] >= limit) {
            continue;
        }
        const x = at % width;
        const y = Math.floor(at / width);
        for (const [dx, dy] of NEIGHBOURS_4) {
            const nx = x + dx;
            const ny = y + dy;
            const next = ny * width + nx;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height && opaque[next] === 1 && depth[next] === 0) {
                depth[next] = depth[at] + 1;
                queue.push(next);
            }
        }
    }
    return depth;
}

/** The same walk outward from the silhouette, through transparent pixels, up to `limit`. */
function outsideDistances(opaque, width, height, limit) {
    const distance = new Int16Array(width * height);
    let ring = [];
    for (let at = 0; at < distance.length; at++) {
        if (opaque[at] === 1) {
            ring.push(at);
        }
    }
    for (let step = 1; step <= limit; step++) {
        const next = [];
        for (const at of ring) {
            const x = at % width;
            const y = Math.floor(at / width);
            for (const [dx, dy] of NEIGHBOURS_4) {
                const nx = x + dx;
                const ny = y + dy;
                const to = ny * width + nx;
                if (nx >= 0 && ny >= 0 && nx < width && ny < height && opaque[to] === 0 && distance[to] === 0) {
                    distance[to] = step;
                    next.push(to);
                }
            }
        }
        ring = next;
    }
    return distance;
}

/**
 * Finds the sticker on a generated picture: the outer lavender ring with its soft edge (`rim`, the weight of each pixel, 1 for a
 * pixel that is all rim and less for one mixed with white), the white band inside it, and the rim colour of this picture.
 * The rim is found by walking inward from the silhouette through pixels that are not white, no deeper than the white band
 * starts, so lavender hair behind the white band, and pixels along a canvas border (a cut, not an edge), are not part of it.
 */
export function locateSticker(raster) {
    const { width, height } = raster;
    const count = width * height;
    const opaque = Uint8Array.from({ length: count }, (_, at) => (raster.data[at * 4 + 3] >= OPAQUE ? 1 : 0));
    const labAt = (at) => srgbToOklab([raster.data[at * 4], raster.data[at * 4 + 1], raster.data[at * 4 + 2]]);
    const shallowDepth = insideDepths(opaque, width, height, SEARCH_DEPTH);

    const rimLab = rimReference(raster, shallowDepth, labAt);
    const whiteLab = srgbToOklab([255, 255, 255]);
    const line = rimLab.map((value, channel) => value - whiteLab[channel]);
    const lineLength = line.reduce((sum, value) => sum + value * value, 0);

    /** How much of the way from white to the rim colour a pixel is, or undefined when it is not on that line. */
    const rimShare = (lab) => {
        const share = Math.min(1, Math.max(0, lab.reduce((sum, value, channel) => sum + (value - whiteLab[channel]) * line[channel], 0) / lineLength));
        const off = Math.hypot(...lab.map((value, channel) => value - (whiteLab[channel] + share * line[channel])));
        return share >= MIN_RIM_SHARE && off <= LINE_TOLERANCE ? share : undefined;
    };

    const { depth, band } = findWhiteBand({ opaque, width, height, labAt, shallowDepth });
    const cap = band.start + CAP_MARGIN;
    const rim = new Float32Array(count);
    const queue = [];
    const visit = (at) => {
        const share = rimShare(labAt(at));
        if (share !== undefined) {
            rim[at] = share;
            queue.push(at);
        }
    };
    for (let at = 0; at < count; at++) {
        if (depth[at] === 1) {
            visit(at);
        }
    }
    for (let head = 0; head < queue.length; head++) {
        const x = queue[head] % width;
        const y = Math.floor(queue[head] / width);
        for (const [dx, dy] of NEIGHBOURS_8) {
            const nx = x + dx;
            const ny = y + dy;
            const next = ny * width + nx;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height && opaque[next] === 1 && depth[next] > 0 && depth[next] <= cap && rim[next] === 0) {
                visit(next);
            }
        }
    }
    const halo = outsideDistances(opaque, width, height, HALO_REACH);
    for (let at = 0; at < count; at++) {
        if (halo[at] > 0) {
            visit(at);
        }
    }
    return { rim, queue, rimLab, labAt, depth, band, cap };
}

/**
 * Which pixels belong to the sticker, rim and white band together (1) and which to the character or the background (0). The rim is
 * what `recolourRim` recolours, including its soft outer edge; the band is every pixel of the rings from where the white starts to
 * where it ends, so what lies inside the band is the character.
 * @param {import('./raster.mjs').Raster} raster
 * @returns {Uint8Array} one byte per pixel
 */
export function stickerMask(raster) {
    const { rim, depth, band } = locateSticker(raster);
    return Uint8Array.from(rim, (share, at) => (share > 0 || (depth[at] > 0 && depth[at] <= band.end) ? 1 : 0));
}

/**
 * Recolours the outer lavender ring of a generated sticker (the rim outside the white band) to `target`, and nothing else.
 *
 * Each rim pixel is moved by the difference between the target and the image's own median rim colour, scaled by how much of
 * the way that pixel is from white to the rim (so an antialiased pixel that is half rim and half white moves half as far).
 * The move is done in OKLab, so hue and lightness change and the variation inside the rim stays. Alpha is never changed.
 * The rim and the white band are found by `locateSticker`, searching as deep as the sticker needs, so a picture drawn on a coarse grid works.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ target: number[] }} options target colour as 0-255 RGB
 */
export function recolourRim(raster, { target }) {
    const { width, height } = raster;
    const { rim, queue, rimLab, labAt, cap } = locateSticker(raster);
    const shift = srgbToOklab(target).map((value, channel) => value - rimLab[channel]);

    const data = Buffer.from(raster.data);
    let recoloured = 0;
    for (const at of queue) {
        const delta = shift.map((value) => value * rim[at]);
        if (Math.hypot(...delta) < NEGLIGIBLE_SHIFT) {
            continue;
        }
        const moved = oklabToSrgb(labAt(at).map((value, channel) => value + delta[channel]));
        data.set(moved.map((channel) => Math.min(255, Math.max(0, Math.round(channel)))), at * 4);
        recoloured++;
    }
    return {
        raster: { width, height, data },
        stats: { recoloured, rimBefore: oklabToSrgb(rimLab).map(Math.round), rimTarget: target, depthCap: cap },
    };
}

/** The image's own rim colour: the median OKLab colour of solid violet pixels two to three rings in from the edge. */
export function rimReference(raster, depth, labAt) {
    const samples = [];
    for (let at = 0; at < depth.length; at++) {
        if (!SAMPLE_DEPTHS.includes(depth[at]) || raster.data[at * 4 + 3] < SOLID) {
            continue;
        }
        const lab = labAt(at);
        const hue = hueOf(lab);
        if (chromaOf(lab) >= RIM_MIN_CHROMA && hue >= RIM_HUE.min && hue <= RIM_HUE.max && lab[0] >= RIM_LIGHTNESS.min && lab[0] <= RIM_LIGHTNESS.max) {
            samples.push(lab);
        }
    }
    if (samples.length < MIN_SAMPLES) {
        throw new Error(`No lavender sticker rim found along the edge (${samples.length} violet pixels two to three pixels in; need ${MIN_SAMPLES}).`);
    }
    return [0, 1, 2].map((channel) => median(samples.map((lab) => lab[channel])));
}

/**
 * Looks for the white band at SEARCH_DEPTH and, only when it is not there, twice as deep and so on up to MAX_SEARCH_DEPTH.
 * The depths up to a limit are the same whatever the limit, so a picture whose band is found at SEARCH_DEPTH is read exactly as before.
 */
function findWhiteBand({ opaque, width, height, labAt, shallowDepth }) {
    for (let limit = SEARCH_DEPTH; limit <= MAX_SEARCH_DEPTH; limit *= 2) {
        const depth = limit === SEARCH_DEPTH ? shallowDepth : insideDepths(opaque, width, height, limit);
        const band = whiteBandRings(depth, labAt, limit);
        if (band) {
            return { depth, band };
        }
    }
    throw new Error(`No white band found within ${MAX_SEARCH_DEPTH} pixels of the edge, so the rim cannot be told from the character.`);
}

/**
 * The rings (depth from the silhouette) of the white band: it starts at the first ring that is at least a quarter white, which is
 * where the rim ends, and goes on while the next ring is at least half white. Undefined when no ring up to `limit` is white.
 */
function whiteBandRings(depth, labAt, limit) {
    const total = new Array(limit + 2).fill(0);
    const white = new Array(limit + 2).fill(0);
    for (let at = 0; at < depth.length; at++) {
        if (depth[at] === 0) {
            continue;
        }
        const lab = labAt(at);
        total[depth[at]]++;
        white[depth[at]] += lab[0] >= WHITE_LIGHTNESS && chromaOf(lab) <= WHITE_MAX_CHROMA ? 1 : 0;
    }
    const start = total.findIndex((ring, level) => level > 0 && ring > 0 && white[level] / ring >= WHITE_BAND_SHARE);
    if (start < 0) {
        return undefined;
    }
    let end = start;
    while (end < limit && total[end + 1] > 0 && white[end + 1] / total[end + 1] >= WHITE_BAND_SOLID_SHARE) {
        end++;
    }
    return { start, end };
}
