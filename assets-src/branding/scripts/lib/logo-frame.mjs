import { createRaster, opaqueBox } from './raster.mjs';
import { fillHoles, labelComponents, opaqueMask, openMask } from './shape-ops.mjs';

// The base is the thick body at the bottom of the emblem; lines, dots and charms are thinner than this share of the emblem's height.
const BODY_THICKNESS = 0.05;
// The row where the base is measured, a little above its lowest point so that the rounded bottom edge does not narrow the run.
const BASE_ROW_ABOVE_BOTTOM = 0.06;
// The empty border around the emblem, as a share of its longer side.
const MARGIN = 0.04;

/** @typedef {{ x: number, y: number, width: number, height: number }} Box */

/**
 * Where the base of the emblem sits: the dome that the ears rise from. It is found as the lowest thick body, so that the lines
 * with dots and the charms, which are thin, do not pull on it however far they reach, and the ears are not mixed in because the
 * measuring row is near the bottom. The base's centre is the middle of that piece on the row.
 * @param {import('./raster.mjs').Raster} raster the emblem, opaque where it is drawn
 * @returns {{ centreX: number, left: number, right: number, row: number }}
 */
export function findBase(raster) {
    const { width } = raster;
    const box = opaqueBox(raster, 128);
    if (!box) {
        throw new Error('The picture has no emblem in it.');
    }
    const radius = Math.max(2, Math.round((box.height * BODY_THICKNESS) / 2));
    // Holes are filled first: letters cut out of the dome leave strips thinner than the opening, which would split the dome into pieces.
    const body = openMask(fillHoles(opaqueMask(raster), width, raster.height), width, raster.height, radius);
    const { labels } = labelComponents(body, width, raster.height);
    let lowest = -1;
    for (let at = body.length - 1; at >= 0 && lowest < 0; at--) {
        lowest = body[at] === 1 ? at : -1;
    }
    if (lowest < 0) {
        throw new Error(`Nothing in the picture is thicker than ${2 * radius + 1} pixels, so there is no base to centre on.`);
    }
    const row = Math.max(0, Math.floor(lowest / width) - Math.round(box.height * BASE_ROW_ABOVE_BOTTOM));
    // The piece that holds the lowest point, from its leftmost to its rightmost pixel on the row.
    let left = width;
    let right = -1;
    for (let x = 0; x < width; x++) {
        if (labels[row * width + x] === labels[lowest]) {
            left = Math.min(left, x);
            right = x;
        }
    }
    if (right < 0) {
        throw new Error(`The base is not on row ${row}, which is ${BASE_ROW_ABOVE_BOTTOM * 100}% above its lowest point.`);
    }
    return { centreX: (left + right + 1) / 2, left, right: right + 1, row };
}

/**
 * A square canvas for the emblem with equal margins above and below it.
 * `base` puts the middle of the base on the canvas' vertical axis and makes the canvas wide enough for the side that reaches
 * furthest; `bbox` puts the middle of the whole emblem's box on the axis.
 * @param {Box} box the emblem's box in the source picture
 * @param {number} baseX the base's centre in the source picture
 * @param {'base' | 'bbox'} mode
 * @returns {{ side: number, offsetX: number, offsetY: number, margin: number }} add the offsets to a source coordinate to get a canvas coordinate
 */
export function frameEmblem(box, baseX, mode) {
    const margin = Math.round(Math.max(box.width, box.height) * MARGIN);
    if (mode === 'bbox') {
        const side = Math.max(box.width, box.height) + 2 * margin;
        return { side, offsetX: (side - box.width) / 2 - box.x, offsetY: (side - box.height) / 2 - box.y, margin };
    }
    if (mode !== 'base') {
        throw new Error(`Unknown centring "${mode}"; use base or bbox.`);
    }
    const reach = Math.max(baseX - box.x, box.x + box.width - baseX);
    const side = Math.max(2 * reach, box.height) + 2 * margin;
    return { side, offsetX: side / 2 - baseX, offsetY: (side - box.height) / 2 - box.y, margin };
}

/** The picture on a transparent square canvas, moved by the frame's whole-pixel offsets. */
export function placeInFrame(raster, { side, offsetX, offsetY }) {
    const out = createRaster(side, side);
    const shiftX = Math.round(offsetX);
    const shiftY = Math.round(offsetY);
    for (let y = 0; y < raster.height; y++) {
        const ty = y + shiftY;
        if (ty < 0 || ty >= side) {
            continue;
        }
        for (let x = 0; x < raster.width; x++) {
            const tx = x + shiftX;
            if (tx >= 0 && tx < side) {
                out.data.set(raster.data.subarray((y * raster.width + x) * 4, (y * raster.width + x) * 4 + 4), (ty * side + tx) * 4);
            }
        }
    }
    return out;
}

/** The centre of mass of the opaque pixels, in x, for reporting how far a picture's weight sits from its axis. */
export function centreOfMassX(raster) {
    let sum = 0;
    let count = 0;
    for (let at = 0; at < raster.width * raster.height; at++) {
        if (raster.data[at * 4 + 3] >= 128) {
            sum += (at % raster.width) + 0.5;
            count++;
        }
    }
    return count === 0 ? undefined : sum / count;
}
