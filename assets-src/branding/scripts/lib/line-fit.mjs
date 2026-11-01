import { dilateMask, labelComponents, runLengths } from './shape-ops.mjs';

// A dot is found among pixels this far from the biggest inscribed circle's edge, so the line that leaves it barely counts.
const DOT_RING_LOW = 0.9;
const DOT_RING_HIGH = 1.12;
// A boundary sample is part of the circle when it is within this many pixels of it.
const CIRCLE_TOLERANCE = 1;
const CIRCLE_ROUNDS = 6;
const MIN_CIRCLE_SAMPLES = 24;
// What the line fit takes away around the dot, beyond its radius, so the dot's own edge is not read as line.
const DOT_CLEARANCE = 2.5;
// A stretch of line is a horizontal or a vertical piece when its run is this many times the line's thickness.
const RUN_FACTOR = 1.5;
const MIN_COVERAGE = 0.9;
// How far into the dome the line runs on, under the dome, so no gap can open where the two meet.
export const DOME_OVERLAP = 10;
// The dome's edge is read this far above and below the line, and within this many pixels of where the line meets it.
const EDGE_ROWS = 45;
const EDGE_REACH = 35;
const EDGE_TOLERANCE = 1.5;
const MIN_PIECE_AREA = 200;

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Where the boundary of a mask is: the middle of every edge between a pixel in it and one that is not, in pixel corner coordinates. */
function boundarySamples(mask, width, height) {
    const samples = [];
    const filled = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (mask[y * width + x] !== 1) {
                continue;
            }
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                if (!filled(x + dx, y + dy)) {
                    samples.push([x + 0.5 + dx * 0.5, y + 0.5 + dy * 0.5]);
                }
            }
        }
    }
    return samples;
}

/** Least squares circle through points (Kasa), or undefined when the points are on a line. */
export function leastSquaresCircle(points) {
    let [sx, sy, sxx, syy, sxy, sz, sxz, syz] = [0, 0, 0, 0, 0, 0, 0, 0];
    for (const [x, y] of points) {
        const z = x * x + y * y;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
        sz += z;
        sxz += x * z;
        syz += y * z;
    }
    const n = points.length;
    // Normal equations for x^2 + y^2 = 2 a x + 2 b y + c, solved by Cramer's rule.
    const m = [[2 * sxx, 2 * sxy, sx], [2 * sxy, 2 * syy, sy], [2 * sx, 2 * sy, n]];
    const rhs = [sxz, syz, sz];
    const det3 = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const d = det3(m);
    if (Math.abs(d) < 1e-9) {
        return undefined;
    }
    const solve = (column) => det3(m.map((row, at) => row.map((value, index) => (index === column ? rhs[at] : value)))) / d;
    const [cx, cy, c] = [solve(0), solve(1), solve(2)];
    return { cx, cy, r: Math.sqrt(c + cx * cx + cy * cy) };
}

/**
 * The dot at the end of a line as an exact circle. Its place is first read from the biggest circle that fits inside the piece (the
 * line is too thin to hold one that size), then a circle is fitted to the piece's boundary, ignoring the stretch where the line joins.
 * @param {Uint8Array} piece mask of one line with its dot
 * @returns {{ cx: number, cy: number, r: number, rms: number, samples: number }}
 */
export function fitDot(piece, width, height) {
    const samples = boundarySamples(piece, width, height);
    let best = 0;
    const inside = [];
    for (let at = 0; at < piece.length; at++) {
        if (piece[at] !== 1) {
            continue;
        }
        const [x, y] = [(at % width) + 0.5, Math.floor(at / width) + 0.5];
        let nearest = Infinity;
        for (const [sx, sy] of samples) {
            nearest = Math.min(nearest, Math.hypot(sx - x, sy - y));
        }
        inside.push([x, y, nearest]);
        best = Math.max(best, nearest);
    }
    const core = inside.filter(([, , distance]) => distance >= best - 0.75);
    const start = { cx: core.reduce((sum, [x]) => sum + x, 0) / core.length, cy: core.reduce((sum, [, y]) => sum + y, 0) / core.length, r: best };
    let circle = start;
    let used = samples.filter(([x, y]) => {
        const distance = Math.hypot(x - start.cx, y - start.cy);
        return distance >= DOT_RING_LOW * start.r && distance <= DOT_RING_HIGH * start.r;
    });
    for (let round = 0; round < CIRCLE_ROUNDS; round++) {
        const fitted = used.length >= MIN_CIRCLE_SAMPLES ? leastSquaresCircle(used) : undefined;
        if (!fitted) {
            throw new Error(`No round dot was found in a piece of ${samples.length} boundary points, so the line cannot be redrawn.`);
        }
        circle = fitted;
        used = samples.filter(([x, y]) => Math.abs(Math.hypot(x - circle.cx, y - circle.cy) - circle.r) <= CIRCLE_TOLERANCE);
    }
    const residuals = used.map(([x, y]) => Math.hypot(x - circle.cx, y - circle.cy) - circle.r);
    return { ...circle, rms: Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length), samples: used.length };
}

/** The horizontal and vertical pieces of a line mask, each as a rectangle with its centre line, width and extent. */
function findSegments(line, width, height, thickness) {
    const horizontal = runLengths(line, width, height, true);
    const vertical = runLengths(line, width, height, false);
    const longRun = Math.round(RUN_FACTOR * thickness);
    const segments = [];
    let covered = 0;
    for (const direction of ['H', 'V']) {
        const runs = direction === 'H' ? horizontal : vertical;
        const across = direction === 'H' ? vertical : horizontal;
        const mask = Uint8Array.from(line, (value, at) => (value === 1 && runs[at] >= longRun ? 1 : 0));
        const { labels, areas } = labelComponents(mask, width, height);
        covered += mask.reduce((sum, value) => sum + value, 0);
        areas.forEach((area, index) => {
            const pixels = [];
            labels.forEach((label, at) => {
                if (label === index + 1) {
                    pixels.push(at);
                }
            });
            // Along: where the piece runs from and to. Edges: the two sides, read where the piece is not crossed by another one.
            const along = (at) => (direction === 'H' ? at % width : Math.floor(at / width));
            const side = (at) => (direction === 'H' ? Math.floor(at / width) : at % width);
            const lines = new Map();
            for (const at of pixels) {
                const entry = lines.get(along(at)) ?? { low: Infinity, high: -Infinity, crossed: false };
                entry.low = Math.min(entry.low, side(at));
                entry.high = Math.max(entry.high, side(at) + 1);
                entry.crossed = entry.crossed || across[at] >= longRun;
                lines.set(along(at), entry);
            }
            const clean = [...lines.values()].filter(({ crossed }) => !crossed);
            if (clean.length < 3) {
                throw new Error(`A ${direction === 'H' ? 'horizontal' : 'vertical'} piece of ${area} pixels is crossed along its whole length, so its width cannot be read.`);
            }
            const positions = pixels.map(along);
            segments.push({
                direction,
                from: Math.min(...positions),
                to: Math.max(...positions) + 1,
                low: median(clean.map(({ low }) => low)),
                high: median(clean.map(({ high }) => high)),
            });
        });
    }
    const total = line.reduce((sum, value) => sum + value, 0);
    if (covered / total < MIN_COVERAGE) {
        throw new Error(`Only ${(100 * covered / total).toFixed(0)}% of a line is in straight horizontal or vertical pieces, so it is not a right-angled line.`);
    }
    return segments;
}

/** Whether two segments' rectangles touch or overlap, give or take `slack` pixels. */
function touches(a, b, slack) {
    const rect = (s) => (s.direction === 'H' ? { x0: s.from, x1: s.to, y0: s.low, y1: s.high } : { x0: s.low, x1: s.high, y0: s.from, y1: s.to });
    const [p, q] = [rect(a), rect(b)];
    return p.x0 <= q.x1 + slack && q.x0 <= p.x1 + slack && p.y0 <= q.y1 + slack && q.y0 <= p.y1 + slack;
}

/**
 * Where the dome's edge runs beside a line, as a curve x = at + slope * (y - y0) + bend * (y - y0)^2 read from the rows above and below the
 * line (the rows that have a line on them are skipped). The curve is what the dome's edge looks like where the line joins it.
 * @param {{ silhouette: Uint8Array, zone: Uint8Array, width: number, height: number, row: number, near: number, towards: 1 | -1 }} request
 * `towards` is the side the dome is on, seen from the dot
 */
export function fitDomeEdge({ silhouette, zone, width, height, row, near, towards }) {
    const points = [];
    const lowest = Math.max(0, near - EDGE_REACH);
    const highest = Math.min(width - 1, near + EDGE_REACH);
    for (let y = Math.max(0, Math.round(row) - EDGE_ROWS); y <= Math.min(height - 1, Math.round(row) + EDGE_ROWS); y++) {
        let hasLine = false;
        let edge;
        for (let x = lowest; x <= highest; x++) {
            hasLine = hasLine || zone[y * width + x] === 1;
            if (silhouette[y * width + x] === 1) {
                edge = towards === 1 ? (edge ?? x) : x + 1;
            }
        }
        if (!hasLine && edge !== undefined) {
            points.push([y + 0.5 - row, edge]);
        }
    }
    let kept = points;
    let curve;
    for (let round = 0; round < CIRCLE_ROUNDS; round++) {
        curve = kept.length >= 8 ? fitQuadratic(kept) : undefined;
        if (!curve) {
            throw new Error(`The dome's edge could not be read beside the line at row ${Math.round(row)}: only ${kept.length} clear rows.`);
        }
        kept = points.filter(([u, x]) => Math.abs(curve.at + curve.slope * u + curve.bend * u * u - x) <= EDGE_TOLERANCE);
    }
    return { at: curve.at, slope: curve.slope, bend: curve.bend, y0: row, rows: kept.length };
}

/** Where the dome's edge is on pixel row `y`, from a fit of it. */
export const edgeAt = ({ at, slope, bend, y0 }, y) => at + slope * (y + 0.5 - y0) + bend * (y + 0.5 - y0) ** 2;

function fitQuadratic(points) {
    // Normal equations for x = a + b u + c u^2.
    const sums = [0, 0, 0, 0, 0];
    const moments = [0, 0, 0];
    for (const [u, x] of points) {
        for (let power = 0; power <= 4; power++) {
            sums[power] += u ** power;
        }
        for (let power = 0; power <= 2; power++) {
            moments[power] += x * u ** power;
        }
    }
    const m = [[sums[0], sums[1], sums[2]], [sums[1], sums[2], sums[3]], [sums[2], sums[3], sums[4]]];
    const det3 = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const d = det3(m);
    if (Math.abs(d) < 1e-9) {
        return undefined;
    }
    const solve = (column) => det3(m.map((row, at) => row.map((value, index) => (index === column ? moments[at] : value)))) / d;
    return { at: solve(0), slope: solve(1), bend: solve(2) };
}

/**
 * Reads each line with its dot as exact geometry: a circle for the dot and a centre line of horizontal and vertical pieces with one
 * constant width, ending on the dome. Nothing is guessed: a piece that is not a round dot on a right-angled line is an error.
 * @param {{ silhouette: Uint8Array, lines: Uint8Array, zone: Uint8Array, width: number, height: number, thickness: number }} picture
 * `lines` are the pixels of the lines and dots, `zone` those plus the first pixels of each line at the dome, `thickness` the measured line thickness
 */
export function fitLines({ silhouette, lines, zone, width, height, thickness }) {
    const { labels, areas } = labelComponents(lines, width, height);
    const stubs = Uint8Array.from(zone, (value, at) => (value === 1 && lines[at] === 0 ? 1 : 0));
    const fits = [];
    areas.forEach((area, index) => {
        if (area < MIN_PIECE_AREA) {
            return;
        }
        const piece = Uint8Array.from(labels, (label) => (label === index + 1 ? 1 : 0));
        const dot = fitDot(piece, width, height);
        const near = dilateMask(piece, width, height, 2);
        const line = Uint8Array.from(piece, (value, at) => {
            const [x, y] = [(at % width) + 0.5, Math.floor(at / width) + 0.5];
            const outsideDot = Math.hypot(x - dot.cx, y - dot.cy) > dot.r + DOT_CLEARANCE;
            return outsideDot && (value === 1 || (stubs[at] === 1 && near[at] === 1)) ? 1 : 0;
        });
        let [sumX, count] = [0, 0];
        line.forEach((value, at) => {
            if (value === 1) {
                sumX += (at % width) + 0.5;
                count++;
            }
        });
        const towards = sumX / count > dot.cx ? 1 : -1;
        const segments = findSegments(line, width, height, thickness);
        fits.push({ dot, towards, segments, piece, line, area });
    });
    if (fits.length === 0) {
        throw new Error('No lines with dots were found to redraw.');
    }
    // All lines are drawn with one width and all dots with one radius, the middle of what was measured, so the redrawn logo is consistent.
    const chains = fits.map((fit) => orderSegments(fit));
    const lineWidth = Math.round(median(chains.flatMap((chain) => chain.map(({ low, high }) => high - low))));
    const dotRadius = median(fits.map(({ dot }) => dot.r));
    return fits.map((fit, at) => buildFit(fit, chains[at], { silhouette, zone, width, height, lineWidth, dotRadius }));
}

/** The pieces of a line in order from its dot to the dome, or an error if they are not one right-angled chain ending on the dome. */
function orderSegments({ dot, segments }) {
    const dotEnd = segments.filter(({ direction }) => direction === 'H').sort((a, b) => distanceToSegment(dot, a) - distanceToSegment(dot, b))[0];
    if (!dotEnd) {
        throw new Error('The line has no horizontal piece at its dot.');
    }
    const chain = [dotEnd];
    const following = () => segments.find((segment) => !chain.includes(segment) && touches(chain[chain.length - 1], segment, 2));
    for (let next = following(); next; next = following()) {
        chain.push(next);
    }
    if (chain.length !== segments.length) {
        throw new Error(`The line's ${segments.length} pieces do not form one chain from its dot (${chain.length} do).`);
    }
    if (chain.some(({ direction }, at) => at > 0 && direction === chain[at - 1].direction)) {
        throw new Error('Two pieces of a line run the same way one after the other, so it has no right angle between them.');
    }
    if (chain[chain.length - 1].direction !== 'H') {
        throw new Error('A line must end on the dome with a horizontal piece.');
    }
    return chain;
}

function buildFit({ dot, towards, piece, line }, chain, { silhouette, zone, width, height, lineWidth, dotRadius }) {
    const widths = chain.map(({ low, high }) => high - low);
    // The centre line sits where a stroke of this width has whole-pixel edges, which also keeps every edge of the outline on a pixel.
    const centre = ({ low, high }) => Math.round((low + high) / 2 - lineWidth / 2) + lineWidth / 2;
    const centres = chain.map(centre);
    const row = centres[centres.length - 1];
    const edge = fitDomeEdge({ silhouette, zone, width, height, row, near: reachOf(line, width, towards), towards });
    const farX = Math.round(edge.at + towards * DOME_OVERLAP);

    const vertices = [[Math.round(dot.cx), centres[0]]];
    for (let at = 1; at < chain.length; at++) {
        const [vertical, horizontal] = chain[at].direction === 'V' ? [centres[at], centres[at - 1]] : [centres[at - 1], centres[at]];
        vertices.push([vertical, horizontal]);
    }
    vertices.push([farX, row]);
    return {
        dot: { cx: dot.cx, cy: centres[0], r: dotRadius },
        towards,
        width: lineWidth,
        vertices,
        edge,
        measured: {
            dot: { cx: dot.cx, cy: dot.cy, r: dot.r, rms: dot.rms },
            widths,
            lineMedian: median(widths),
            segments: chain.map((segment, at) => ({ direction: segment.direction, centre: (segment.low + segment.high) / 2, snapped: centres[at], width: widths[at] })),
        },
        piece,
    };
}

/** The column where the line reaches furthest towards the dome. */
function reachOf(line, width, towards) {
    let reach = towards === 1 ? -1 : Infinity;
    line.forEach((value, at) => {
        if (value === 1) {
            reach = towards === 1 ? Math.max(reach, at % width) : Math.min(reach, at % width);
        }
    });
    return reach;
}

function distanceToSegment(dot, { direction, from, to, low, high }) {
    const [x0, x1, y0, y1] = direction === 'H' ? [from, to, low, high] : [low, high, from, to];
    return Math.hypot(Math.max(x0 - dot.cx, 0, dot.cx - x1), Math.max(y0 - dot.cy, 0, dot.cy - y1));
}
