// Exact 2D shapes for the logo's lines and dots: outlines of masks that sit on whole pixels, clipping by a line, and circles and
// arcs as cubic curves. Paths here use the same M, L, C and Z commands as vector-path.mjs, in y-down screen coordinates.

/** @typedef {{ command: 'M' | 'L' | 'C' | 'Z', points: number[][] }} PathCommand */
/** @typedef {{ cx: number, cy: number, r: number }} Circle */

/** Shoelace area of a loop. In y-down coordinates a loop that runs clockwise on screen has a positive area. */
export function signedArea(loop) {
    let sum = 0;
    for (let at = 0; at < loop.length; at++) {
        const [x1, y1] = loop[at];
        const [x2, y2] = loop[(at + 1) % loop.length];
        sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
}

const isCollinear = ([x1, y1], [x2, y2], [x3, y3]) => (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2) === 0;

/** The loop without vertices that lie on the straight line between their neighbours. */
export function dropCollinear(loop) {
    const kept = loop.filter((point, at) => !isCollinear(loop[(at + loop.length - 1) % loop.length], point, loop[(at + 1) % loop.length]));
    return kept.length === loop.length ? loop : dropCollinear(kept);
}

/**
 * The outlines of the filled cells of a mask whose cells are whole pixels, as loops of corner points with no collinear vertices.
 * An outer outline runs clockwise on screen and a hole counter-clockwise. Cells that touch only at a corner are not joined.
 * @param {Uint8Array} mask 1 = filled
 * @param {number} width
 * @param {number} height
 * @param {number} [originX] added to every x, so a mask cut from a bigger picture keeps its place
 * @param {number} [originY]
 * @returns {number[][][]}
 */
export function maskOutlines(mask, width, height, originX = 0, originY = 0) {
    const filled = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
    const stride = width + 1;
    const edges = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!filled(x, y)) {
                continue;
            }
            const corner = (cx, cy) => cy * stride + cx;
            if (!filled(x, y - 1)) {
                edges.push([corner(x, y), corner(x + 1, y)]);
            }
            if (!filled(x + 1, y)) {
                edges.push([corner(x + 1, y), corner(x + 1, y + 1)]);
            }
            if (!filled(x, y + 1)) {
                edges.push([corner(x + 1, y + 1), corner(x, y + 1)]);
            }
            if (!filled(x - 1, y)) {
                edges.push([corner(x, y + 1), corner(x, y)]);
            }
        }
    }
    const outgoing = new Map();
    edges.forEach((edge, index) => outgoing.set(edge[0], [...(outgoing.get(edge[0]) ?? []), index]));
    const used = new Uint8Array(edges.length);
    const pointOf = (corner) => [(corner % stride) + originX, Math.floor(corner / stride) + originY];
    const loops = [];
    for (let first = 0; first < edges.length; first++) {
        if (used[first] === 1) {
            continue;
        }
        const loop = [];
        let current = first;
        while (used[current] === 0) {
            used[current] = 1;
            const [from, to] = edges[current];
            loop.push(pointOf(from));
            const candidates = (outgoing.get(to) ?? []).filter((index) => used[index] === 0);
            if (candidates.length === 0) {
                break;
            }
            // Where two outlines meet at a corner, turning right keeps the cells that only touch diagonally apart.
            const [dx, dy] = [(to % stride) - (from % stride), Math.floor(to / stride) - Math.floor(from / stride)];
            const turn = (index) => {
                const [nextFrom, nextTo] = edges[index];
                const [nx, ny] = [(nextTo % stride) - (nextFrom % stride), Math.floor(nextTo / stride) - Math.floor(nextFrom / stride)];
                return dx * ny - dy * nx;
            };
            current = candidates.sort((a, b) => turn(b) - turn(a))[0];
        }
        loops.push(dropCollinear(loop));
    }
    return loops;
}

/**
 * Clips a loop to one side of the line x = at + slope * (y - y0) (Sutherland and Hodgman against a single edge), which is exact for
 * straight edges.
 * @param {number[][]} loop
 * @param {{ at: number, slope: number, y0: number, keep: 'left' | 'right' }} line `keep` is the side that stays, as seen on screen
 */
export function clipByLine(loop, { at, slope, y0, keep }) {
    const sign = keep === 'left' ? 1 : -1;
    // Positive on the side that stays.
    const inside = ([x, y]) => sign * (at + slope * (y - y0) - x);
    const out = [];
    loop.forEach((point, index) => {
        const next = loop[(index + 1) % loop.length];
        const [a, b] = [inside(point), inside(next)];
        if (a >= 0) {
            out.push(point);
        }
        if ((a > 0 && b < 0) || (a < 0 && b > 0)) {
            const t = a / (a - b);
            out.push([point[0] + (next[0] - point[0]) * t, point[1] + (next[1] - point[1]) * t]);
        }
    });
    return out;
}

/** Cubic curves for the arc of a circle from angle `from` to angle `to` (radians, y down, so angles grow clockwise on screen). */
export function arcCubics({ cx, cy, r }, from, to) {
    const pieces = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 2) - 1e-9));
    const step = (to - from) / pieces;
    const handle = (4 / 3) * Math.tan(step / 4) * r;
    const curves = [];
    for (let piece = 0; piece < pieces; piece++) {
        const a = from + piece * step;
        const b = a + step;
        curves.push({
            command: 'C',
            points: [
                [cx + r * Math.cos(a) - handle * Math.sin(a), cy + r * Math.sin(a) + handle * Math.cos(a)],
                [cx + r * Math.cos(b) + handle * Math.sin(b), cy + r * Math.sin(b) - handle * Math.cos(b)],
                [cx + r * Math.cos(b), cy + r * Math.sin(b)],
            ],
        });
    }
    return curves;
}

/** A full circle as one closed subpath, clockwise on screen unless `clockwise` is false. */
export function circleCommands(circle, clockwise = true) {
    return [{ command: 'M', points: [[circle.cx + circle.r, circle.cy]] }, ...arcCubics(circle, 0, clockwise ? 2 * Math.PI : -2 * Math.PI), { command: 'Z', points: [] }];
}

/** The angle of a point as seen from a circle's centre. */
export const angleOf = ({ cx, cy }, [x, y]) => Math.atan2(y - cy, x - cx);

/** The way round from one angle to another that is shorter than half a turn. */
export function shortSpan(from, to) {
    const turn = to - from;
    return turn - 2 * Math.PI * Math.round(turn / (2 * Math.PI));
}

/**
 * A closed polygon as path commands. An edge listed in `arcs` (by the index of its first vertex) is drawn as the short arc of that
 * circle between its two vertices, which must lie on it.
 * @param {number[][]} loop
 * @param {Map<number, Circle>} [arcs]
 * @returns {PathCommand[]}
 */
export function loopCommands(loop, arcs = new Map()) {
    const commands = [{ command: 'M', points: [loop[0]] }];
    for (let at = 0; at < loop.length; at++) {
        const next = loop[(at + 1) % loop.length];
        const circle = arcs.get(at);
        if (circle) {
            const from = angleOf(circle, loop[at]);
            const curves = arcCubics(circle, from, from + shortSpan(from, angleOf(circle, next)));
            // The last point is the vertex itself, so rounding in the arc never leaves a gap to the next edge.
            curves[curves.length - 1].points[2] = next;
            commands.push(...curves);
        } else if (at < loop.length - 1) {
            commands.push({ command: 'L', points: [next] });
        }
    }
    commands.push({ command: 'Z', points: [] });
    return commands;
}

/** The same shape with every point moved by `dx`, `dy` after being scaled by `scale` about the origin. */
export const transformCommands = (commands, scale, dx, dy) => commands.map(({ command, points }) => ({ command, points: points.map(([x, y]) => [x * scale + dx, y * scale + dy]) }));

/** The commands of one or more shapes as polygons through their control points, close enough to a curve to tell its orientation and box. */
export function commandLoops(commands) {
    const loops = [];
    for (const { command, points } of commands) {
        if (command === 'M') {
            loops.push([points[0]]);
        } else if (command !== 'Z') {
            loops[loops.length - 1].push(...points);
        }
    }
    return loops;
}

/** Whether the biggest subpath, which is the outside of a shape, runs clockwise on screen. */
export function outerRunsClockwise(commands) {
    const loops = commandLoops(commands);
    if (loops.length === 0) {
        throw new Error('There is no shape to take an orientation from.');
    }
    const areas = loops.map(signedArea);
    return areas[areas.reduce((best, area, at) => (Math.abs(area) > Math.abs(areas[best]) ? at : best), 0)] > 0;
}

/** The loop run the other way. */
export const reverseLoop = (loop) => [...loop].reverse();

/** One closed subpath (M, then L and C, then Z) drawn the other way round. */
export function reverseSubpath(commands) {
    const [start, ...rest] = commands;
    const body = rest.filter(({ command }) => command !== 'Z');
    const ends = [start.points[0], ...body.map(({ points }) => points[points.length - 1])];
    const reversed = body.map(({ command, points }, at) => {
        const previous = ends[at];
        return command === 'C' ? { command, points: [points[1], points[0], previous] } : { command, points: [previous] };
    }).reverse();
    return [{ command: 'M', points: [ends[ends.length - 1]] }, ...reversed, { command: 'Z', points: [] }];
}

/** The subpaths of a command list, each as its own list. */
export function splitSubpaths(commands) {
    const subpaths = [];
    for (const item of commands) {
        if (item.command === 'M') {
            subpaths.push([item]);
        } else {
            subpaths[subpaths.length - 1].push(item);
        }
    }
    return subpaths;
}

/** Every subpath of the commands turned to run clockwise (or counter-clockwise) on screen, judged by its end points. */
export function orientSubpaths(commands, clockwise) {
    return splitSubpaths(commands).flatMap((subpath) => {
        const [loop] = commandLoops(subpath);
        return (signedArea(loop) > 0) === clockwise ? subpath : reverseSubpath(subpath);
    });
}

/** The commands reflected about the vertical line x = `at` (`axis` x) or the horizontal line y = `at` (`axis` y). */
export const mirrorCommands = (commands, axis, at) => commands.map(({ command, points }) => ({ command, points: points.map(([x, y]) => (axis === 'x' ? [2 * at - x, y] : [x, 2 * at - y])) }));
