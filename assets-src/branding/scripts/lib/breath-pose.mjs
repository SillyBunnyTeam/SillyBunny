import { orphanToleranceFor, repairRings, STICKER_BAND, STICKER_RIM } from './pixel-snap.mjs';
import { findOrphans } from './pixelate.mjs';
import { createRaster, crop, hasBinaryAlpha, opaqueBox } from './raster.mjs';
import { boxOfPixels, changedPixels } from './snap-frame.mjs';

export const BLINK_VARIANTS = ['half', 'closed'];
export const VARIANTS = ['base', ...BLINK_VARIANTS];
export const POSES = ['c', 'b'];

// A blink changes the eyes only. In the breath pose the eyes are one row lower, and the rows around them were not touched, so the box of the change may only grow by this much.
const BLINK_BOX_SLACK = 3;

/**
 * The waist row: `share` of the way from the top row of the opaque box to its last row, rounded. The rows above it move down in the breath
 * pose and the rows from it down stay.
 * @param {import('./raster.mjs').Raster} base a snapped still
 * @param {number} share
 */
export function waistOf(base, share) {
    const box = opaqueBox(base, 1);
    if (!box) {
        throw new Error('The picture is empty, so there is no figure to breathe.');
    }
    const waist = box.y + Math.round((box.height - 1) * share);
    if (waist <= box.y + 1) {
        throw new Error(`A waist at row ${waist} leaves nothing above it to move (the figure starts at row ${box.y}).`);
    }
    return { box, waist };
}

const keyOf = (x, y) => `${x},${y}`;

/**
 * The rows around the waist in which the overlap can change the outline or a ring: the seam rows and as far from them as a ring pixel can be
 * from the outline. Outside them every row of the breath pose is a row of the source, moved or not, so that a sticker the source has cut
 * off at the edge of its canvas is cut off in the same way.
 */
export const seamWindow = (waist, { rimWidth, bandWidth }, height) => ({ first: Math.max(0, waist - rimWidth - bandWidth - 2), last: Math.min(height - 1, waist + rimWidth + bandWidth + 2) });

/**
 * The bumps (an opaque pixel with at most one opaque neighbour above, below, left or right) and dents (a transparent pixel with three or
 * more) of the outline in `rows`.
 * @param {import('./raster.mjs').Raster} raster
 * @param {number[]} rows
 * @returns {{ x: number, y: number, kind: 'bump' | 'dent' }[]}
 */
export function outlineDefects(raster, rows) {
    const { width, height } = raster;
    const isOpaque = (x, y) => x >= 0 && y >= 0 && x < width && y < height && raster.data[(y * width + x) * 4 + 3] !== 0;
    const defects = [];
    for (const y of rows.filter((row) => row >= 0 && row < height)) {
        for (let x = 0; x < width; x++) {
            const opaqueNeighbours = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([nx, ny]) => isOpaque(nx, ny)).length;
            if (isOpaque(x, y) && opaqueNeighbours <= 1) {
                defects.push({ x, y, kind: 'bump' });
            } else if (!isOpaque(x, y) && opaqueNeighbours >= 3) {
                defects.push({ x, y, kind: 'dent' });
            }
        }
    }
    return defects;
}

/**
 * A copy with the given outline defects mended: a bump is made transparent, a dent takes the colour of its first opaque neighbour (left,
 * right, above, below). The rings are rebuilt after, so the colour only has to be one the picture has.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ x: number, y: number, kind: 'bump' | 'dent' }[]} defects
 */
export function smoothOutline(raster, defects) {
    const { width } = raster;
    const smoothed = { ...raster, data: Buffer.from(raster.data) };
    for (const { x, y, kind } of defects) {
        const at = (y * width + x) * 4;
        if (kind === 'bump') {
            smoothed.data.fill(0, at, at + 4);
            continue;
        }
        const [nx, ny] = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].find(([cx, cy]) => raster.data[(cy * width + cx) * 4 + 3] !== 0);
        raster.data.copy(smoothed.data, at, (ny * width + nx) * 4, (ny * width + nx) * 4 + 4);
    }
    return smoothed;
}

/**
 * The rows of a picture with every row above `waist` moved down one row: the picture's own rows from the waist down, and on the waist row the
 * moved row shows only where the waist row is transparent (the lower picture is in front, as a row-by-row draw has it). The top row is left empty.
 * @param {import('./raster.mjs').Raster} raster
 * @param {number} waist
 */
export function shiftUpperRows(raster, waist) {
    const { width, height } = raster;
    const stride = width * 4;
    const moved = createRaster(width, height);
    raster.data.copy(moved.data, stride, 0, waist * stride);
    for (let x = 0; x < width; x++) {
        const at = (waist * width + x) * 4;
        if (raster.data[at + 3] !== 0) {
            raster.data.copy(moved.data, at, at, at + 4);
        }
    }
    raster.data.copy(moved.data, (waist + 1) * stride, (waist + 1) * stride);
    return moved;
}

/**
 * The breath pose of a picture: the rows above the waist one row down (`shiftUpperRows`). Where the overlap leaves a bump or a dent in the
 * outline that the picture did not already have, it is mended; then the white band and the lavender rim are rebuilt around the seam, so they
 * run on across it. Rows outside the seam window are the source's rows, as they were. `ringsChanged` counts the pixels the rebuild recoloured
 * and `outlineFixed` the defects mended.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ waist: number, rings: { rimWidth: number, bandWidth: number } }} breath
 */
export function breathe(raster, { waist, rings }) {
    const { width, height } = raster;
    const stride = width * 4;
    const moved = shiftUpperRows(raster, waist);
    const seam = [waist - 1, waist, waist + 1];
    const known = new Set(outlineDefects(raster, [waist - 2, ...seam]).flatMap(({ x, y }) => [keyOf(x, y), keyOf(x, y + 1)]));
    const fresh = outlineDefects(moved, seam).filter(({ x, y }) => !known.has(keyOf(x, y)));
    const smoothed = smoothOutline(moved, fresh);
    const { first, last } = seamWindow(waist, rings, height);
    const rebuilt = repairRings(smoothed, { ...rings, rim: STICKER_RIM, band: STICKER_BAND }).raster;
    const result = { ...smoothed, data: Buffer.from(smoothed.data) };
    rebuilt.data.copy(result.data, first * stride, first * stride, (last + 1) * stride);
    return { raster: result, ringsChanged: changedPixels(rowsOf(smoothed, first, last + 1), rowsOf(result, first, last + 1)).length, outlineFixed: fresh.length };
}

const colourKeys = (raster) => new Set(Array.from({ length: raster.width * raster.height }, (_, at) => (raster.data[at * 4 + 3] === 0 ? 'clear' : raster.data.subarray(at * 4, at * 4 + 4).join(','))));

const boxWithin = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

const padded = (box, by) => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });

const diffBox = (one, two) => boxOfPixels(changedPixels(one, two), one.width);

const boxText = (box) => `${box.width}x${box.height} at ${box.x},${box.y}`;

const rowsOf = (raster, from, to) => crop(raster, { x: 0, y: from, width: raster.width, height: to - from });

/**
 * What is wrong with the breath pose of each variant. It must: be binary alpha with no colour its source does not have; start exactly one row
 * lower than its source; have each row above the seam window equal to the source row above it; have every row below the seam window equal
 * to its source; have its rings, in the seam window, exactly as the rebuild draws them (continuous across the seam); and, for a blink variant, differ from the pose's base picture around the eyes only.
 * @param {{ sources: Record<string, import('./raster.mjs').Raster>, pose: { variants: Record<string, { raster: import('./raster.mjs').Raster }> }, waist: number, rings: { rimWidth: number, bandWidth: number } }} request
 * @returns {string[]} one sentence for each problem; empty when the pose is clean
 */
export function breathProblems({ sources, pose, waist, rings }) {
    const problems = [];
    const { first, last } = seamWindow(waist, rings, sources.base.height);
    const sourceBox = opaqueBox(sources.base, 1);
    for (const [variant, { raster }] of Object.entries(pose.variants)) {
        const source = sources[variant];
        const label = `b ${variant}`;
        if (!hasBinaryAlpha(raster)) {
            problems.push(`${label}: has translucent pixels`);
        }
        const known = colourKeys(source);
        const foreign = [...colourKeys(raster)].filter((colour) => !known.has(colour));
        if (foreign.length > 0) {
            problems.push(`${label}: ${foreign.length} colours that the source picture does not have`);
        }
        const box = opaqueBox(raster, 1);
        if (box.y !== sourceBox.y + 1) {
            problems.push(`${label}: starts at row ${box.y}, not one row below the source's row ${sourceBox.y}`);
        }
        const below = last + 1;
        if (below < raster.height && changedPixels(rowsOf(raster, below, raster.height), rowsOf(source, below, raster.height)).length > 0) {
            problems.push(`${label}: rows from ${below} down are not the source's own, so the lower body is not still`);
        }
        const above = first;
        if (above > sourceBox.y + 1 && changedPixels(rowsOf(raster, sourceBox.y + 1, above), rowsOf(source, sourceBox.y, above - 1)).length > 0) {
            problems.push(`${label}: rows ${sourceBox.y + 1} to ${above - 1} are not the source's rows one above them, so the upper body did not move by exactly one row`);
        }
        const rebuilt = repairRings(raster, { ...rings, rim: STICKER_RIM, band: STICKER_BAND }).raster;
        const loose = changedPixels(rowsOf(raster, first, last + 1), rowsOf(rebuilt, first, last + 1)).length;
        if (loose > 0) {
            problems.push(`${label}: ${loose} pixels around the waist (rows ${first} to ${last}) are not the ${rings.rimWidth}+${rings.bandWidth} sticker rings, so the band or the rim is broken at the seam`);
        }
    }
    for (const variant of BLINK_VARIANTS.filter((blink) => sources[blink])) {
        const wanted = diffBox(sources.base, sources[variant]);
        const found = diffBox(pose.variants.base.raster, pose.variants[variant].raster);
        if (wanted && !found) {
            problems.push(`b ${variant}: does not differ from b base, but the source ${variant} differs from its base in ${boxText(wanted)}, so the blink is lost`);
        }
        if (found && (!wanted || !boxWithin(found, padded(wanted, BLINK_BOX_SLACK)))) {
            problems.push(`b ${variant}: differs from b base in ${boxText(found)}, outside the eyes (${wanted ? boxText(wanted) : 'the source has no difference'} in the source)`);
        }
    }
    return problems;
}

/** How many orphans (a lone pixel, or a hole in the fill) a picture has, for judging whether the breath made the art noisier than its source was. @param {import('./raster.mjs').Raster} raster */
export const countOrphans = (raster) => findOrphans(raster, { tolerance: orphanToleranceFor(undefined) }).length;

/**
 * The two poses of a snapped still and of its blink frames: `c`, the still itself, and `b`, the breath pose. The waist is read from the base
 * picture and used for every variant, so the eyes of a blink frame are where the pose's base picture has them.
 * @param {{ variants: { base: import('./raster.mjs').Raster, half?: import('./raster.mjs').Raster, closed?: import('./raster.mjs').Raster }, waistShare: number, rings: { rimWidth: number, bandWidth: number } }} request
 */
export function buildBreath({ variants, waistShare, rings }) {
    const { box, waist } = waistOf(variants.base, waistShare);
    const sources = Object.fromEntries(Object.entries(variants).filter(([, raster]) => raster));
    const breath = Object.fromEntries(Object.entries(sources).map(([variant, raster]) => [variant, breathe(raster, { waist, rings })]));
    const poses = [
        { name: 'c', variants: Object.fromEntries(Object.entries(sources).map(([variant, raster]) => [variant, { raster }])) },
        { name: 'b', variants: breath },
    ];
    return { box, waist, rings, sources, poses, problems: breathProblems({ sources, pose: poses[1], waist, rings }) };
}
