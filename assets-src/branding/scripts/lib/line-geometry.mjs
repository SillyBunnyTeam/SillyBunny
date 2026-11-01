import { arcCubics, circleCommands, clipByLine, loopCommands, maskOutlines, mirrorCommands, orientSubpaths } from './geometry.mjs';

/** @typedef {import('./geometry.mjs').PathCommand} PathCommand */
/** @typedef {{ cx: number, cy: number, r: number }} Circle */
/** @typedef {{ dot: Circle, towards: 1 | -1, width: number, vertices: number[][], edge: { at: number, slope: number, y0: number } }} LineFit `towards` is the side of the dot that the line and the dome are on */

const PAD = 2;

/**
 * The rectangles of a line drawn as a stroke of one width along its centre line, with square joins. Every edge is on a whole pixel when
 * the centre line is where `fitLines` puts it. The ends run on by half a width, rounded up, so the dot covers one end and the dome the other.
 * @param {LineFit} fit
 * @returns {{ x0: number, y0: number, x1: number, y1: number }[]}
 */
export function lineRects({ vertices, width }) {
    const half = width / 2;
    const end = Math.ceil(half);
    if (!Number.isInteger(width) || !vertices.flat().every((value) => Number.isInteger(value * 2))) {
        throw new Error('The line must be on half pixels (and its width a whole number of pixels) so that every edge of it is on a pixel.');
    }
    const last = vertices.length - 1;
    // A corner is covered by the half width that both pieces share; only the two free ends run on past their vertex.
    const reach = (index) => (index === 0 || index === last ? end : half);
    return vertices.slice(1).map((to, at) => {
        const from = vertices[at];
        const [startReach, endReach] = [reach(at), reach(at + 1)];
        if (from[1] === to[1]) {
            const [lowReach, highReach] = from[0] < to[0] ? [startReach, endReach] : [endReach, startReach];
            return { x0: Math.min(from[0], to[0]) - lowReach, x1: Math.max(from[0], to[0]) + highReach, y0: to[1] - half, y1: to[1] + half };
        }
        const [lowReach, highReach] = from[1] < to[1] ? [startReach, endReach] : [endReach, startReach];
        return { x0: to[0] - half, x1: to[0] + half, y0: Math.min(from[1], to[1]) - lowReach, y1: Math.max(from[1], to[1]) + highReach };
    });
}

/** A mask on whole pixels covering the rectangles, with the pixel it starts at, padded so a band shifted up or down stays inside. */
function rasterise(rects, shiftReach) {
    const x0 = Math.min(...rects.map((rect) => rect.x0)) - PAD;
    const y0 = Math.min(...rects.map((rect) => rect.y0)) - shiftReach - PAD;
    const width = Math.max(...rects.map((rect) => rect.x1)) + PAD - x0;
    const height = Math.max(...rects.map((rect) => rect.y1)) + shiftReach + PAD - y0;
    const mask = new Uint8Array(width * height);
    for (const rect of rects) {
        for (let y = rect.y0; y < rect.y1; y++) {
            for (let x = rect.x0; x < rect.x1; x++) {
                mask[(y - y0) * width + (x - x0)] = 1;
            }
        }
    }
    return { mask, x0, y0, width, height };
}

/**
 * The dark crescent along the lower edge of a dot, which is the dot less the dot moved up by `k`, as seen where it meets its line: the
 * line's own band carries on the same edge, so the crescent stops (at `cutOffset` below the centre) on the side the line comes from,
 * as it would if the line and dot were one drawn shape. Drawn for a line that comes in from the left.
 * @param {Circle} circle
 * @param {number} k band width
 * @param {number} cutOffset where the crescent starts on the line side, measured down from the dot's centre; at least -k / 2
 * @returns {PathCommand[]}
 */
function lowerCrescent({ cx, cy, r }, k, cutOffset) {
    if (cutOffset < -k / 2 || cutOffset + k >= r) {
        throw new Error(`A band of ${k} pixels does not fit a dot of radius ${r.toFixed(1)} on a line this wide.`);
    }
    const tip = Math.asin(k / 2 / r);
    const outer = { cx, cy, r };
    const inner = { cx, cy: cy - k, r };
    const leftAt = (circle, offset) => cx - Math.sqrt(circle.r ** 2 - offset ** 2);
    const outerEnd = Math.PI - Math.asin(cutOffset / r);
    const innerStart = Math.PI - Math.asin((cutOffset + k) / r);
    const rightTip = [cx + Math.sqrt(r ** 2 - (k / 2) ** 2), cy - k / 2];
    return [
        { command: 'M', points: [rightTip] },
        ...arcCubics(outer, -tip, outerEnd),
        { command: 'L', points: [[leftAt(inner, cutOffset + k), cy + cutOffset]] },
        ...arcCubics(inner, innerStart, tip),
        { command: 'Z', points: [] },
    ];
}

/**
 * The line's bands that are not on the dot: a mask of the stroke less the same stroke shifted, as outlines clipped at the dome and ending
 * in an arc of the dot where they run into it.
 */
function bandOutlines({ dark, light }, grid, fit) {
    const { dot, towards, edge } = fit;
    const endX = fit.vertices[0][0] - towards * Math.ceil(fit.width / 2);
    const clip = { at: edge.at, slope: edge.slope, y0: edge.y0, keep: towards === 1 ? 'left' : 'right' };
    const cell = (x, y) => (x < 0 || y < 0 || x >= grid.width || y >= grid.height ? 0 : grid.mask[y * grid.width + x]);
    const darkMask = new Uint8Array(grid.mask.length);
    const lightMask = new Uint8Array(grid.mask.length);
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            if (cell(x, y) === 0) {
                continue;
            }
            if (cell(x, y + dark) === 0) {
                darkMask[y * grid.width + x] = 1;
            } else if (light > 0 && cell(x, y - light) === 0) {
                lightMask[y * grid.width + x] = 1;
            }
        }
    }
    const shape = (mask) => maskOutlines(mask, grid.width, grid.height, grid.x0, grid.y0).flatMap((loop) => {
        const clipped = clipByLine(loop, clip);
        if (clipped.length < 3) {
            return [];
        }
        const arcs = new Map();
        const at = clipped.findIndex((point, index) => Math.abs(point[0] - endX) < 1e-6 && Math.abs(clipped[(index + 1) % clipped.length][0] - endX) < 1e-6);
        if (at >= 0) {
            for (const index of [at, (at + 1) % clipped.length]) {
                clipped[index] = [dot.cx + towards * Math.sqrt(dot.r ** 2 - (clipped[index][1] - dot.cy) ** 2), clipped[index][1]];
            }
            arcs.set(at, dot);
        }
        return loopCommands(clipped, arcs);
    });
    return { dark: shape(darkMask), light: shape(lightMask) };
}

/**
 * The line and its dot as exact shapes, in three layers to draw one over the other: the base tone's outline (the line's stroke with the
 * dot as a circle), the dark lower edge and the light upper edge. Edges of the stroke are on whole pixels, so its bands are exact; the dot's
 * are circles and arcs. Every subpath runs clockwise on screen.
 * @param {LineFit} fit
 * @param {{ kDark: number, kLight: number }} bands band widths in pixels; a light width of 0 gives no light edge
 * @returns {{ base: PathCommand[], dark: PathCommand[], light: PathCommand[] }}
 */
export function buildLineShapes(fit, { kDark, kLight }) {
    if (!Number.isInteger(kDark) || kDark < 1 || !Number.isInteger(kLight) || kLight < 0) {
        throw new Error(`The band widths must be whole numbers of pixels (dark 1 or more, light 0 or more); got ${kDark} and ${kLight}.`);
    }
    if (kDark > fit.width || kLight > fit.width) {
        throw new Error(`The bands (${kDark} and ${kLight} pixels) are wider than the line (${fit.width} pixels).`);
    }
    const grid = rasterise(lineRects(fit), Math.max(kDark, kLight));
    const all = Uint8Array.from(grid.mask);
    const base = maskOutlines(all, grid.width, grid.height, grid.x0, grid.y0).flatMap((loop) => loopCommands(loop));
    const { dark, light } = bandOutlines({ dark: kDark, light: kLight }, grid, fit);

    const { dot, towards, width } = fit;
    const crescents = [lowerCrescent(dot, kDark, width / 2 - kDark)];
    const lightCrescents = kLight > 0 ? [mirrorCommands(lowerCrescent(dot, kLight, width / 2 - kLight), 'y', dot.cy)] : [];
    // The crescents are built for a line from the left; a line from the right is the mirror image.
    const fromSide = (shapes) => shapes.flatMap((shape) => (towards === 1 ? mirrorCommands(shape, 'x', dot.cx) : shape));
    return {
        base: orientSubpaths([...base, ...circleCommands(dot)], true),
        dark: orientSubpaths([...dark, ...fromSide(crescents)], true),
        light: orientSubpaths([...light, ...fromSide(lightCrescents)], true),
    };
}
