import { splitSubpaths } from './geometry.mjs';
import { samplePath } from './outline-fit.mjs';

/** @typedef {import('./geometry.mjs').PathCommand} PathCommand */

// Two curves that meet at a sharper angle than this (in radians) are a corner, and stay one. Potrace has already decided where the corners
// are, so this only has to tell a corner from the small turn of a rounding error.
const CORNER_ANGLE = 0.4;
// A curve is fitted again with its points moved along it, at most this many times, before it is split.
const REPARAMETERISE_ROUNDS = 12;
// A fit that is this many times the tolerance off is split at once; one closer than that is first improved by moving its points.
const REPARAMETERISE_BELOW = 3;
const SAMPLE_STEP = 0.2;

const minus = (a, b) => [a[0] - b[0], a[1] - b[1]];
const plus = (a, b) => [a[0] + b[0], a[1] + b[1]];
const times = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = (v) => {
    const length = Math.hypot(v[0], v[1]);
    return length === 0 ? undefined : [v[0] / length, v[1] / length];
};

const point = ([p0, p1, p2, p3], t) => {
    const s = 1 - t;
    return [0, 1].map((axis) => s ** 3 * p0[axis] + 3 * s * s * t * p1[axis] + 3 * s * t * t * p2[axis] + t ** 3 * p3[axis]);
};
const slope = ([p0, p1, p2, p3], t) => {
    const s = 1 - t;
    return [0, 1].map((axis) => 3 * s * s * (p1[axis] - p0[axis]) + 6 * s * t * (p2[axis] - p1[axis]) + 3 * t * t * (p3[axis] - p2[axis]));
};
const bend = ([p0, p1, p2, p3], t) => {
    const s = 1 - t;
    return [0, 1].map((axis) => 6 * s * (p2[axis] - 2 * p1[axis] + p0[axis]) + 6 * t * (p3[axis] - 2 * p2[axis] + p1[axis]));
};

/** The direction a segment leaves its start in and arrives at its end in. */
function directions(start, { command, points }) {
    const end = points[points.length - 1];
    const chord = unit(minus(end, start));
    if (command === 'L') {
        return { out: chord, into: chord };
    }
    const [first, second] = points;
    return { out: unit(minus(first, start)) ?? unit(minus(second, start)) ?? chord, into: unit(minus(end, second)) ?? unit(minus(end, first)) ?? chord };
}

const turnBetween = (into, out) => Math.acos(Math.min(1, Math.max(-1, dot(into, out))));

/** The cubic through the points that leaves in `first`'s direction and arrives in the direction opposite `last`, by least squares on the lengths of its handles. */
function fitOne(points, parameters, first, last) {
    const [start, end] = [points[0], points[points.length - 1]];
    let [c00, c01, c11, x0, x1] = [0, 0, 0, 0, 0];
    points.forEach((p, at) => {
        const t = parameters[at];
        const s = 1 - t;
        const [b0, b1, b2, b3] = [s ** 3, 3 * t * s * s, 3 * t * t * s, t ** 3];
        const [a1, a2] = [times(first, b1), times(last, b2)];
        c00 += dot(a1, a1);
        c01 += dot(a1, a2);
        c11 += dot(a2, a2);
        const rest = minus(p, plus(times(start, b0 + b1), times(end, b2 + b3)));
        x0 += dot(a1, rest);
        x1 += dot(a2, rest);
    });
    const determinant = c00 * c11 - c01 * c01;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    let [alpha1, alpha2] = determinant === 0 ? [0, 0] : [(x0 * c11 - x1 * c01) / determinant, (c00 * x1 - c01 * x0) / determinant];
    // A handle that points back, or is nothing, means the points are not one smooth curve in these directions: a third of the chord is safe.
    if (alpha1 < 1e-6 * length || alpha2 < 1e-6 * length) {
        [alpha1, alpha2] = [length / 3, length / 3];
    }
    return [start, plus(start, times(first, alpha1)), plus(end, times(last, alpha2)), end];
}

function chordParameters(points) {
    const lengths = [0];
    for (let at = 1; at < points.length; at++) {
        lengths.push(lengths[at - 1] + Math.hypot(points[at][0] - points[at - 1][0], points[at][1] - points[at - 1][1]));
    }
    return lengths.map((length) => length / lengths[lengths.length - 1]);
}

/** Moves each point's parameter along the curve to where the curve is nearest it (one Newton step). */
function moveParameters(curve, points, parameters) {
    return parameters.map((t, at) => {
        const [offset, first, second] = [minus(point(curve, t), points[at]), slope(curve, t), bend(curve, t)];
        const denominator = dot(first, first) + dot(offset, second);
        return denominator === 0 ? t : Math.min(1, Math.max(0, t - dot(offset, first) / denominator));
    });
}

function worstPoint(curve, points, parameters) {
    let [worst, at] = [0, 1];
    points.forEach((p, index) => {
        const distance = Math.hypot(...minus(point(curve, parameters[index]), p));
        if (distance > worst) {
            [worst, at] = [distance, index];
        }
    });
    return { worst, at: Math.min(points.length - 2, Math.max(1, at)) };
}

/**
 * Cubics through the points, each within `tolerance` of them, leaving the first point in the direction `first` and arriving at the last one
 * in the direction opposite `last`. Where one cubic is not enough the points are split at the worst one and each side is fitted, with the
 * same direction on both sides of the split, so the pieces join smoothly. (Schneider, "An algorithm for automatically fitting digitized
 * curves", Graphics Gems, 1990.)
 */
function fitRun(points, first, last, tolerance) {
    let parameters = chordParameters(points);
    let curve = fitOne(points, parameters, first, last);
    let { worst, at } = worstPoint(curve, points, parameters);
    if (worst <= tolerance) {
        return [curve];
    }
    for (let round = 0; round < REPARAMETERISE_ROUNDS && worst < REPARAMETERISE_BELOW * tolerance; round++) {
        parameters = moveParameters(curve, points, parameters);
        curve = fitOne(points, parameters, first, last);
        ({ worst, at } = worstPoint(curve, points, parameters));
        if (worst <= tolerance) {
            return [curve];
        }
    }
    const centre = unit(minus(points[at - 1], points[at + 1])) ?? first;
    return [...fitRun(points.slice(0, at + 1), first, centre, tolerance), ...fitRun(points.slice(at), times(centre, -1), last, tolerance)];
}

/** The same points without any that repeats the one before it. */
const withoutRepeats = (points) => points.filter((p, at) => at === 0 || Math.hypot(p[0] - points[at - 1][0], p[1] - points[at - 1][1]) > 1e-9);

function refitSubpath(subpath, tolerance) {
    const start = subpath[0].points[0];
    const body = subpath.filter(({ command }) => command === 'L' || command === 'C');
    if (body.length < 2) {
        return subpath;
    }
    const segments = [...body];
    const lastEnd = body[body.length - 1].points[body[body.length - 1].points.length - 1];
    if (Math.hypot(lastEnd[0] - start[0], lastEnd[1] - start[1]) > 1e-6) {
        segments.push({ command: 'L', points: [start] });
    }
    const starts = segments.map((_, at) => (at === 0 ? start : segments[at - 1].points[segments[at - 1].points.length - 1]));
    const ways = segments.map((segment, at) => directions(starts[at], segment));
    const count = segments.length;
    // A join is a break when a corner is there, or a straight line meets a curve; a line is kept as it is and a curve is fitted between breaks.
    const isBreak = segments.map((segment, at) => {
        const before = (at + count - 1) % count;
        return segment.command === 'L' || segments[before].command === 'L' || turnBetween(ways[before].into, ways[at].out) > CORNER_ANGLE;
    });
    if (!isBreak.includes(true)) {
        isBreak[0] = true;
        isBreak[Math.floor(count / 2)] = true;
    }
    const first = isBreak.indexOf(true);
    const order = Array.from({ length: count }, (_, at) => (first + at) % count);
    const groups = [];
    for (const at of order) {
        if (isBreak[at] || groups.length === 0) {
            groups.push([]);
        }
        groups[groups.length - 1].push(at);
    }
    const commands = [{ command: 'M', points: [starts[first]] }];
    for (const group of groups) {
        const firstSegment = group[0];
        const lastSegment = group[group.length - 1];
        const isLine = segments[firstSegment].command === 'L';
        if (isLine) {
            commands.push(...group.map((at) => segments[at]));
            continue;
        }
        const run = withoutRepeats(samplePath([{ command: 'M', points: [starts[firstSegment]] }, ...group.map((at) => segments[at])], SAMPLE_STEP));
        const pieces = fitRun(run, ways[firstSegment].out, times(ways[lastSegment].into, -1), tolerance);
        commands.push(...pieces.map(([, one, two, end]) => ({ command: 'C', points: [one, two, end] })));
    }
    return [...commands, { command: 'Z', points: [] }];
}

/**
 * Closed outlines redrawn in as few cubics as will stay within `tolerance` pixels of them. Straight lines stay as they are, corners stay
 * corners, and curves that joined smoothly still do, so the shape is the same and the path is shorter.
 * @param {PathCommand[]} commands
 * @param {{ tolerance: number }} options
 * @returns {PathCommand[]}
 */
export function refitOutlines(commands, { tolerance }) {
    if (!(tolerance > 0)) {
        throw new Error(`The tolerance must be more than 0, got ${tolerance}.`);
    }
    return splitSubpaths(commands).flatMap((subpath) => refitSubpath(subpath, tolerance));
}
