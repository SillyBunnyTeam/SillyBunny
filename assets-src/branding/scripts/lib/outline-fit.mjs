import sharp from 'sharp';
import { commandLoops, maskOutlines, reverseSubpath, signedArea, splitSubpaths } from './geometry.mjs';

/** @typedef {import('./geometry.mjs').PathCommand} PathCommand */

// The coverage field is made at this many times the picture's size, so potrace's polygon steps are a fraction of a source pixel.
export const OUTLINE_FACTOR = 4;
const SAMPLE_STEP = 0.25;
const cubicPoint = ([p0, p1, p2, p3], t) => {
    const [a, b, c, d] = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
    return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
};

/** Points along every segment of the commands, including the line that closes each subpath, at most `step` apart. */
export function samplePath(commands, step = SAMPLE_STEP) {
    const samples = [];
    let current;
    let start;
    const along = (from, to) => {
        const pieces = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / step));
        for (let piece = 1; piece <= pieces; piece++) {
            samples.push([from[0] + ((to[0] - from[0]) * piece) / pieces, from[1] + ((to[1] - from[1]) * piece) / pieces]);
        }
    };
    for (const { command, points } of commands) {
        if (command === 'M') {
            [current] = points;
            start = current;
            samples.push(current);
        } else if (command === 'Z') {
            along(current, start);
            current = start;
        } else if (command === 'L') {
            along(current, points[0]);
            [current] = points;
        } else {
            const curve = [current, ...points];
            const length = curve.slice(1).reduce((sum, point, at) => sum + Math.hypot(point[0] - curve[at][0], point[1] - curve[at][1]), 0);
            const pieces = Math.max(1, Math.ceil(length / step));
            for (let piece = 1; piece <= pieces; piece++) {
                samples.push(cubicPoint(curve, piece / pieces));
            }
            current = points[points.length - 1];
        }
    }
    return samples;
}

const distanceToSegment = ([px, py], [ax, ay], [bx, by]) => {
    const [dx, dy] = [bx - ax, by - ay];
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/**
 * How far a drawn outline is from the edge of a snapped picture, both ways, in pixels: from the outline to the nearest pixel edge, and from
 * the pixel edges (their corners and points along them) to the nearest point of the outline. A smooth curve through a staircase cannot
 * be closer than about half a pixel to its corners, so that is the floor.
 * @param {PathCommand[]} commands
 * @param {Uint8Array} mask 1 for the shape
 * @returns {{ toRaster: number, fromRaster: number }}
 */
export function boundaryDeviation(commands, mask, width, height) {
    const edges = maskOutlines(mask, width, height).flatMap((loop) => loop.map((point, at) => [point, loop[(at + 1) % loop.length]]));
    const curve = samplePath(commands);
    let toRaster = 0;
    for (const point of curve) {
        let nearest = Infinity;
        for (const [a, b] of edges) {
            nearest = Math.min(nearest, distanceToSegment(point, a, b));
        }
        toRaster = Math.max(toRaster, nearest);
    }
    // The curve's points are looked up in a grid of cells one pixel wide, so each pixel edge only meets the curve near it.
    const cells = new Map();
    for (const point of curve) {
        const key = `${Math.floor(point[0])},${Math.floor(point[1])}`;
        cells.set(key, [...(cells.get(key) ?? []), point]);
    }
    let fromRaster = 0;
    for (const [a, b] of edges) {
        const pieces = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
        for (let piece = 0; piece <= pieces; piece++) {
            const point = [a[0] + ((b[0] - a[0]) * piece) / pieces, a[1] + ((b[1] - a[1]) * piece) / pieces];
            let nearest = Infinity;
            for (let radius = 1; radius <= 6 && nearest > radius - 1; radius++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        for (const sample of cells.get(`${Math.floor(point[0]) + dx},${Math.floor(point[1]) + dy}`) ?? []) {
                            nearest = Math.min(nearest, Math.hypot(sample[0] - point[0], sample[1] - point[1]));
                        }
                    }
                }
            }
            fromRaster = Math.max(fromRaster, nearest);
        }
    }
    return { toRaster, fromRaster };
}

/**
 * Every subpath turned so that the outsides run `outerClockwise` and the shapes inside them (a letter's counters) the other way. An outside
 * is a subpath that runs the same way as the biggest one, which is always an outside.
 * @param {PathCommand[]} commands
 * @param {boolean} outerClockwise
 * @returns {PathCommand[]}
 */
export function orientOutlines(commands, outerClockwise) {
    const subpaths = splitSubpaths(commands);
    if (subpaths.length === 0) {
        return [];
    }
    const areas = subpaths.map((subpath) => signedArea(commandLoops(subpath)[0]));
    const biggest = areas.reduce((best, area, at) => (Math.abs(area) > Math.abs(areas[best]) ? at : best), 0);
    return subpaths.flatMap((subpath, at) => {
        const isOuter = Math.sign(areas[at]) === Math.sign(areas[biggest]);
        const clockwise = isOuter ? outerClockwise : !outerClockwise;
        return (areas[at] > 0) === clockwise ? subpath : reverseSubpath(subpath);
    });
}


/**
 * The values enlarged by linear interpolation between pixel centres. Sharp's own resize puts its result half an output pixel off the
 * input's, which is a tenth of a source pixel at 4 times and shows as a lean in a straight edge.
 */
function enlarge(values, width, height, factor) {
    const out = Buffer.alloc(width * factor * height * factor);
    const at = (x, y) => values[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
    for (let j = 0; j < height * factor; j++) {
        const sy = (j + 0.5) / factor - 0.5;
        const [y, v] = [Math.floor(sy), sy - Math.floor(sy)];
        for (let i = 0; i < width * factor; i++) {
            const sx = (i + 0.5) / factor - 0.5;
            const [x, u] = [Math.floor(sx), sx - Math.floor(sx)];
            out[j * width * factor + i] = Math.round((1 - v) * ((1 - u) * at(x, y) + u * at(x + 1, y)) + v * ((1 - u) * at(x, y + 1) + u * at(x + 1, y + 1)));
        }
    }
    return out;
}

/**
 * Values (0 to 255 per pixel) enlarged `factor` times and blurred by `sigma` source pixels, so that a cut at one half puts a smooth edge
 * at the sub-pixel position the values describe.
 * @returns {Promise<Buffer>} one byte per enlarged pixel
 */
export async function softField(values, width, height, factor, sigma) {
    return sharp(enlarge(values, width, height, factor), { raw: { width: width * factor, height: height * factor, channels: 1 } })
        .blur(Math.max(0.3, sigma * factor))
        // The blur turns a single channel into three equal ones, which would read as a picture three times as wide.
        .toColourspace('b-w')
        .raw()
        .toBuffer();
}

/** The smallest box around the pixels set in `mask`, or undefined when none is. */
export const boxOf = (mask, width, height) => {
    let [left, top, right, bottom] = [width, height, -1, -1];
    mask.forEach((value, at) => {
        if (value === 1) {
            const [x, y] = [at % width, Math.floor(at / width)];
            [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)];
        }
    });
    return right < 0 ? undefined : { left, top, right: right + 1, bottom: bottom + 1 };
};
