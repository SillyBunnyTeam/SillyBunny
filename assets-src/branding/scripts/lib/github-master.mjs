import { ringWidths } from './pixel-snap.mjs';
import { createRaster, opaqueBox } from './raster.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */

/** Transparent rows added where a master is clipped, in master pixels: more than the widest sticker rim, so the rim is drawn whole. */
export const MASTER_PAD = 48;
const VISIBLE = 128;
// How far, in master pixels, a pixel of the band or the rim may be from something that is not the same: the band is about 6 pixels wide and
// the rim about 9 at 1024, so a pixel with more room than this around it is the inside of a sock or of hair, not a ring.
const MAX_BAND_DEPTH = 9;
const MAX_RIM_DEPTH = 13;

const EDGES = Object.freeze({
    top: { pixels: (raster) => Array.from({ length: raster.width }, (_, x) => [x, 0]) },
    bottom: { pixels: (raster) => Array.from({ length: raster.width }, (_, x) => [x, raster.height - 1]) },
    left: { pixels: (raster) => Array.from({ length: raster.height }, (_, y) => [0, y]) },
    right: { pixels: (raster) => Array.from({ length: raster.height }, (_, y) => [raster.width - 1, y]) },
});

const pixelAt = (raster, x, y) => {
    const at = (y * raster.width + x) * 4;
    return [raster.data[at], raster.data[at + 1], raster.data[at + 2], raster.data[at + 3]];
};

const isVisible = ([, , , alpha]) => alpha >= VISIBLE;
/** The white band of a sticker, including the pixels where it fades into the rim: pale, with little colour in it. */
const isBandColour = ([r, g, b]) => Math.min(r, g, b) >= 200 && Math.max(r, g, b) - Math.min(r, g, b) <= 50;
/** The lavender rim of a sticker: a purple with blue well above green, and light. */
const isRimColour = ([r, g, b]) => b - g >= 35 && b - r >= 15 && r >= 140 && g >= 120;

const classOf = (pixel) => (isBandColour(pixel) ? 'band' : isRimColour(pixel) ? 'rim' : 'art');

/** True when a pixel that is not opaque, or is of another class, is within `depth` pixels of (x, y). */
function hasOtherWithin(raster, x, y, kind, depth) {
    for (let dy = -depth; dy <= depth; dy++) {
        for (let dx = -depth; dx <= depth; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (dx * dx + dy * dy > depth * depth || nx < 0 || ny < 0 || nx >= raster.width || ny >= raster.height) {
                continue;
            }
            const pixel = pixelAt(raster, nx, ny);
            if (!isVisible(pixel) || classOf(pixel) !== kind) {
                return true;
            }
        }
    }
    return false;
}

/** The raster with transparent rows and columns added on each side by `pad`, its pixels as they were. */
function padRaster(raster, pad) {
    const padded = createRaster(raster.width + pad.left + pad.right, raster.height + pad.top + pad.bottom);
    for (let y = 0; y < raster.height; y++) {
        padded.data.set(raster.data.subarray(y * raster.width * 4, (y + 1) * raster.width * 4), ((y + pad.top) * padded.width + pad.left) * 4);
    }
    return padded;
}

/**
 * The opaque pixels on one edge of a master, each with what it is: the sticker's rim, its white band, or anything else (art).
 * @param {Raster} raster
 * @param {keyof typeof EDGES} edge
 */
function edgePixels(raster, edge) {
    return EDGES[edge].pixels(raster)
        .map(([x, y]) => ({ x, y, pixel: pixelAt(raster, x, y) }))
        .filter(({ pixel }) => isVisible(pixel))
        .map((entry) => ({ ...entry, kind: classOf(entry.pixel) }));
}

/**
 * Why an edge's opaque pixels are not just the cut end of the sticker's rings, or undefined when they are: every one must be rim or band
 * coloured, and a band or rim pixel with room all round it is the inside of a sock, a cuff or hair that the canvas edge cut, not a ring.
 */
function findCutProblem(raster, edge, pixels) {
    for (const { x, y, kind, pixel } of pixels) {
        if (kind === 'art') {
            return `the ${edge} edge is cut through the drawing itself (pixel ${x},${y} is rgb ${pixel.slice(0, 3)})`;
        }
        if (!hasOtherWithin(raster, x, y, kind, kind === 'band' ? MAX_BAND_DEPTH : MAX_RIM_DEPTH)) {
            return `the ${edge} edge is cut through something ${kind === 'band' ? 'white' : 'lavender'} that is thicker than the sticker's ${kind} (pixel ${x},${y}), such as a sock or hair`;
        }
    }
    return undefined;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];

/** The colour of the rim, from the rim pixels on the clipped edges; and the master's own rim width. */
function rimOf(raster, clipped) {
    const samples = clipped.flatMap(({ pixels }) => pixels.filter(({ kind }) => kind === 'rim').map(({ pixel }) => pixel));
    const colour = samples.length > 0 ? [0, 1, 2].map((channel) => median(samples.map((pixel) => pixel[channel]))) : undefined;
    return { colour, width: ringWidths(raster, 1).rimMaster };
}

/**
 * A master whose sticker is cut by the canvas edge only where the rings meet it, padded with transparent rows and given the rim that the
 * cut took. This is what happens when a figure's prop touches the picture edge: the white band is there whole, and the rim above it is not.
 * The rim is drawn as the pixels within the master's own rim width of the band's edge pixels, in the rim colour of the clipped pixels.
 * A master with no opaque pixel on an edge comes back as it is. One whose edge pixels are anything but the sticker's rim or band, or
 * whose white or lavender run goes deeper than a ring is thick, is refused: that is the drawing cut off, and padding would hide it.
 * @param {Raster} master
 * @returns {{ raster: Raster, padded: { edge: string, rows: number, pixels: number }[] }}
 */
export function padClippedRim(master) {
    const clipped = Object.keys(EDGES).map((edge) => ({ edge, pixels: edgePixels(master, edge) })).filter(({ pixels }) => pixels.length > 0);
    if (clipped.length === 0) {
        return { raster: master, padded: [] };
    }
    for (const { edge, pixels } of clipped) {
        const problem = findCutProblem(master, edge, pixels);
        if (problem) {
            throw new Error(`The master is clipped, and not only in the sticker's rings: ${problem}. Generate it again with a margin.`);
        }
    }
    const pad = Object.fromEntries(Object.keys(EDGES).map((edge) => [edge, clipped.some((entry) => entry.edge === edge) ? MASTER_PAD : 0]));
    const padded = padRaster(master, pad);
    const { colour, width: rimWidth } = rimOf(master, clipped);
    if (!colour) {
        throw new Error('The master is clipped at a ring, but no rim pixel is left on the cut edge to take the rim colour from.');
    }
    const bandPixels = clipped.flatMap(({ pixels }) => pixels.filter(({ kind }) => kind === 'band')).map(({ x, y }) => [x + pad.left, y + pad.top]);
    const reach = Math.ceil(rimWidth);
    const isPad = (x, y) => x < pad.left || y < pad.top || x >= padded.width - pad.right || y >= padded.height - pad.bottom;
    for (const [bandX, bandY] of bandPixels) {
        for (let dy = -reach; dy <= reach; dy++) {
            for (let dx = -reach; dx <= reach; dx++) {
                const x = bandX + dx;
                const y = bandY + dy;
                if (x >= 0 && y >= 0 && x < padded.width && y < padded.height && isPad(x, y) && dx * dx + dy * dy <= rimWidth * rimWidth) {
                    padded.data.set([...colour, 255], (y * padded.width + x) * 4);
                }
            }
        }
    }
    return { raster: padded, padded: clipped.map(({ edge, pixels }) => ({ edge, rows: MASTER_PAD, pixels: pixels.length })) };
}

/** The least transparent margin a master keeps round its sticker, in master pixels: more than two cells of the smallest snap, so the grid never lands on the sticker's first row. */
export const MIN_MASTER_MARGIN = 6;

/**
 * A master with at least `MIN_MASTER_MARGIN` transparent pixels on every side of its sticker: a side with less is given transparent rows
 * up to that margin. A master that is cut by the edge is not handled here (see `padClippedRim`); this is for a sticker that is whole
 * but close enough to the edge that the snap grid can start on its first row and read it as touching.
 * @param {Raster} master
 * @returns {{ raster: Raster, added: { left: number, top: number, right: number, bottom: number } }}
 */
export function ensureMargin(master) {
    const box = opaqueBox(master, VISIBLE);
    if (!box) {
        throw new Error('The master has nothing opaque.');
    }
    const margins = { left: box.x, top: box.y, right: master.width - box.x - box.width, bottom: master.height - box.y - box.height };
    const added = Object.fromEntries(Object.entries(margins).map(([side, margin]) => [side, Math.max(0, MIN_MASTER_MARGIN - margin)]));
    if (Object.values(added).every((rows) => rows === 0)) {
        return { raster: master, added };
    }
    return { raster: padRaster(master, added), added };
}
