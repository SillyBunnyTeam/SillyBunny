import { oklabToSrgb, srgbToOklab } from './pixel-colour.mjs';

const OPAQUE = 128;
const SOLID = 250;
// How deep into the sticker the search for white and for the rim goes, in pixels from the silhouette.
const SEARCH_DEPTH = 16;
// The soft edge outside the silhouette that still carries the rim colour.
const HALO_REACH = 6;
const SAMPLE_DEPTHS = [2, 3];
const MIN_SAMPLES = 50;
// A rim pixel is violet (OKLab hue in degrees), coloured and of middle lightness; the white band and skin are not.
const RIM_HUE = { min: -120, max: -30 };
const RIM_MIN_CHROMA = 0.04;
const RIM_LIGHTNESS = { min: 0.55, max: 0.92 };
// Share of white pixels at which a depth counts as the white band, and how much deeper than that the rim may still reach.
const WHITE_BAND_SHARE = 0.25;
const WHITE_LIGHTNESS = 0.95;
const WHITE_MAX_CHROMA = 0.03;
const CAP_MARGIN = 1;
// A pixel is rim when at least this much of the way from white to the rim colour, and no further than this from that line.
const MIN_RIM_SHARE = 0.12;
const LINE_TOLERANCE = 0.12;
// A shift smaller than this is below what 8 bit colour can show, so the pixel keeps its bytes (which makes a second run a no-op).
const NEGLIGIBLE_SHIFT = 0.0015;
const NEIGHBOURS_4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEIGHBOURS_8 = [...NEIGHBOURS_4, [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** @param {string} text #rrggbb or rrggbb */
export function parseHexColour(text) {
    const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(text).trim());
    if (!match) {
        throw new Error(`Expected a hex colour such as #b99bf2, got "${text}".`);
    }
    return match.slice(1).map((pair) => parseInt(pair, 16));
}

const chromaOf = (lab) => Math.hypot(lab[1], lab[2]);
const hueOf = (lab) => (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Walks 4-connected rings in from the silhouette: 1 for an opaque pixel next to a transparent one. The canvas border is a cut, not an edge. */
function insideDepths(opaque, width, height, limit) {
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
 * Recolours the outer lavender ring of a generated sticker (the rim outside the white band) to `target`, and nothing else.
 *
 * Each rim pixel is moved by the difference between the target and the image's own median rim colour, scaled by how much of
 * the way that pixel is from white to the rim (so an antialiased pixel that is half rim and half white moves half as far).
 * The move is done in OKLab, so hue and lightness change and the variation inside the rim stays. Alpha is never changed.
 * The rim is found by walking inward from the silhouette through pixels that are not white, no deeper than the white band
 * starts, so lavender hair behind the white band, and pixels along a canvas border (a cut, not an edge), are not touched.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ target: number[] }} options target colour as 0-255 RGB
 */
export function recolourRim(raster, { target }) {
    const { width, height } = raster;
    const count = width * height;
    const opaque = Uint8Array.from({ length: count }, (_, at) => (raster.data[at * 4 + 3] >= OPAQUE ? 1 : 0));
    const depth = insideDepths(opaque, width, height, SEARCH_DEPTH);
    const labAt = (at) => srgbToOklab([raster.data[at * 4], raster.data[at * 4 + 1], raster.data[at * 4 + 2]]);

    const rimLab = rimReference(raster, depth, labAt);
    const whiteLab = srgbToOklab([255, 255, 255]);
    const line = rimLab.map((value, channel) => value - whiteLab[channel]);
    const lineLength = line.reduce((sum, value) => sum + value * value, 0);
    const shift = srgbToOklab(target).map((value, channel) => value - rimLab[channel]);

    /** How much of the way from white to the rim colour a pixel is, or undefined when it is not on that line. */
    const rimShare = (lab) => {
        const share = Math.min(1, Math.max(0, lab.reduce((sum, value, channel) => sum + (value - whiteLab[channel]) * line[channel], 0) / lineLength));
        const off = Math.hypot(...lab.map((value, channel) => value - (whiteLab[channel] + share * line[channel])));
        return share >= MIN_RIM_SHARE && off <= LINE_TOLERANCE ? share : undefined;
    };

    const cap = whiteBandDepth(depth, labAt, count) + CAP_MARGIN;
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
function rimReference(raster, depth, labAt) {
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

/** The depth at which at least a quarter of the ring is white: the rim ends just before it. */
function whiteBandDepth(depth, labAt, count) {
    const total = new Array(SEARCH_DEPTH + 1).fill(0);
    const white = new Array(SEARCH_DEPTH + 1).fill(0);
    for (let at = 0; at < count; at++) {
        if (depth[at] === 0) {
            continue;
        }
        const lab = labAt(at);
        total[depth[at]]++;
        white[depth[at]] += lab[0] >= WHITE_LIGHTNESS && chromaOf(lab) <= WHITE_MAX_CHROMA ? 1 : 0;
    }
    const found = total.findIndex((ring, level) => level > 0 && ring > 0 && white[level] / ring >= WHITE_BAND_SHARE);
    if (found < 0) {
        throw new Error(`No white band found within ${SEARCH_DEPTH} pixels of the edge, so the rim cannot be told from the character.`);
    }
    return found;
}
