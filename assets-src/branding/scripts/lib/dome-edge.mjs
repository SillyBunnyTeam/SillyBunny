// The dome's left and right edges as one smooth curve each. Cutting a line away leaves steps in the edge where its stub and fillet were,
// so the edge is read well above and below those rows, fitted, and the pixels between the old edge and the curve are redrawn.

export const DOME_DEGREE = 4;
// A row is on the edge's curve when its edge is within this many pixels of it. The edge is read at whole pixels, so a rounding error of
// half a pixel is expected on a perfect curve.
const FIT_TOLERANCE = 0.8;
const FIT_ROUNDS = 10;
// Before points are dropped, the curve is found with weights that fall off with a point's distance from it (Cauchy), so that a run of
// rows at the end of the range, where a plain fit has most leverage, cannot pull it onto themselves.
const WEIGHT_ROUNDS = 15;
const WEIGHT_SCALE = 0.5;
// Fewer rows than this on the curve means the edge was not found, not that it is rough.
const MIN_INLIER_SHARE = 0.75;
const MIN_ROWS = 12;

/** @typedef {{ coefficients: number[], centre: number, scale: number }} EdgeCurve x as a polynomial of u = (y - centre) / scale */

/** Where the curve is on row `y` (the row's centre is at y + 0.5, so pass that). */
export const curveAt = ({ coefficients, centre, scale }, y) => {
    const u = (y - centre) / scale;
    return coefficients.reduceRight((sum, coefficient) => sum * u + coefficient, 0);
};

/** How fast the curve moves sideways per pixel down, on row `y`. */
export const slopeAt = ({ coefficients, centre, scale }, y) => {
    const u = (y - centre) / scale;
    return coefficients.reduceRight((sum, coefficient, power) => (power === 0 ? sum : sum * u + power * coefficient), 0) / scale;
};

/** Solves the square system `matrix` x = `rhs` by Gauss-Jordan with the biggest pivot first, or returns undefined when it is singular. */
function solve(matrix, rhs) {
    const size = rhs.length;
    const rows = matrix.map((row, at) => [...row, rhs[at]]);
    for (let column = 0; column < size; column++) {
        let pivot = column;
        for (let row = column + 1; row < size; row++) {
            pivot = Math.abs(rows[row][column]) > Math.abs(rows[pivot][column]) ? row : pivot;
        }
        if (Math.abs(rows[pivot][column]) < 1e-12) {
            return undefined;
        }
        [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
        for (let row = 0; row < size; row++) {
            if (row === column) {
                continue;
            }
            const factor = rows[row][column] / rows[column][column];
            for (let at = column; at <= size; at++) {
                rows[row][at] -= factor * rows[column][at];
            }
        }
    }
    return rows.map((row, at) => row[size] / row[at]);
}

function leastSquares(points, degree, centre, scale, weights = points.map(() => 1)) {
    const size = degree + 1;
    const matrix = Array.from({ length: size }, () => Array(size).fill(0));
    const rhs = Array(size).fill(0);
    points.forEach(([y, x], at) => {
        const u = (y - centre) / scale;
        const powers = Array.from({ length: size }, (_, power) => u ** power);
        for (let row = 0; row < size; row++) {
            for (let column = 0; column < size; column++) {
                matrix[row][column] += weights[at] * powers[row] * powers[column];
            }
            rhs[row] += weights[at] * powers[row] * x;
        }
    });
    const coefficients = solve(matrix, rhs);
    return coefficients && { coefficients, centre, scale };
}

/**
 * A polynomial through points `[y, x]` that ignores outliers: it is fitted, the points further than the tolerance from it are dropped,
 * and it is fitted again to the rest, until the same points stay.
 * @param {number[][]} points
 * @param {number} degree
 * @returns {{ curve: EdgeCurve, used: number[][], maxResidual: number, rms: number } | undefined} undefined when no curve fits enough of the points
 */
export function fitEdgeCurve(points, degree = DOME_DEGREE) {
    if (points.length < Math.max(MIN_ROWS, degree + 2)) {
        return undefined;
    }
    const rows = points.map(([y]) => y);
    const centre = (Math.min(...rows) + Math.max(...rows)) / 2;
    const scale = Math.max(1, (Math.max(...rows) - Math.min(...rows)) / 2);
    let weights = points.map(() => 1);
    let curve;
    for (let round = 0; round < WEIGHT_ROUNDS; round++) {
        curve = leastSquares(points, degree, centre, scale, weights);
        if (!curve) {
            return undefined;
        }
        weights = points.map(([y, x]) => 1 / (1 + ((curveAt(curve, y) - x) / WEIGHT_SCALE) ** 2));
    }
    let used = points.filter(([y, x]) => Math.abs(curveAt(curve, y) - x) <= FIT_TOLERANCE);
    for (let round = 0; round < FIT_ROUNDS; round++) {
        curve = leastSquares(used, degree, centre, scale);
        if (!curve) {
            return undefined;
        }
        const kept = points.filter(([y, x]) => Math.abs(curveAt(curve, y) - x) <= FIT_TOLERANCE);
        if (kept.length === used.length && kept.every((point, at) => point === used[at])) {
            break;
        }
        if (kept.length < degree + 2) {
            return undefined;
        }
        used = kept;
    }
    if (used.length < MIN_INLIER_SHARE * points.length) {
        return undefined;
    }
    const residuals = used.map(([y, x]) => Math.abs(curveAt(curve, y) - x));
    return { curve, used, maxResidual: Math.max(...residuals), rms: Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length) };
}

/**
 * Where the shape's edge is on row `y`, as the pixel boundary: the first opaque column on the left, and one past the last opaque one on
 * the right, looking only in columns `[from, to)`. -1 when the row has no opaque pixel there.
 * @param {Int8Array} index tone index per pixel, negative for transparent
 */
export function edgeBoundary(index, width, y, side, [from, to]) {
    if (side === 'left') {
        for (let x = from; x < to; x++) {
            if (index[y * width + x] >= 0) {
                return x;
            }
        }
        return -1;
    }
    for (let x = to - 1; x >= from; x--) {
        if (index[y * width + x] >= 0) {
            return x + 1;
        }
    }
    return -1;
}

/**
 * The row where a side of the shape is furthest in between rows `from` and `to`: the notch between an ear and the dome, below which the
 * dome's own edge starts. When several rows are equally far in, the lowest is taken.
 * @returns {number}
 */
export function findCrease({ index, width, from, to, side, search }) {
    let [furthest, row] = [-Infinity, -1];
    for (let y = from; y < to; y++) {
        const boundary = edgeBoundary(index, width, y, side, search);
        const depth = side === 'left' ? boundary : -boundary;
        if (boundary >= 0 && depth >= furthest) {
            [furthest, row] = [depth, y];
        }
    }
    if (row < 0) {
        throw new Error(`There is no ${side} edge between rows ${from} and ${to} to find the notch under the ear in.`);
    }
    return row;
}

/**
 * Reads the dome's two sides and fits a curve to each from the rows `from` to `to` (not including `to`). The rows where a line was cut
 * away are a small share of them and are further from the curve than the tolerance, so the fit leaves them out by itself.
 * @param {{ index: Int8Array, width: number, from: number, to: number, search: { left: number[], right: number[] }, degree?: number }} request
 * `search` is the columns to look in on each side, so that a charm or a line further out is not taken for the edge
 */
export function fitDomeSides({ index, width, from, to, search, degree = DOME_DEGREE }) {
    const sides = {};
    for (const side of ['left', 'right']) {
        const points = [];
        for (let y = from; y < to; y++) {
            const boundary = edgeBoundary(index, width, y, side, search[side]);
            if (boundary >= 0) {
                points.push([y + 0.5, boundary]);
            }
        }
        const fit = fitEdgeCurve(points, degree);
        if (!fit) {
            throw new Error(`The dome's ${side} edge could not be read as one smooth curve between rows ${from} and ${to}; ${points.length} rows were usable.`);
        }
        sides[side] = { ...fit, rows: points.length };
    }
    return sides;
}

/**
 * The picture with the dome's sides drawn on their curves between rows `from` and `to`. On each row, the pixels between the old edge and
 * the curve are filled with the tone of the old edge pixel, or cleared when the old edge is outside the curve, so bands and the base
 * tone carry on to the new edge. A pixel is on the shape when its centre is.
 * @param {{ index: Int8Array, width: number, from: number, to: number, search: { left: number[], right: number[] }, curves: { left: EdgeCurve, right: EdgeCurve } }} request
 * @returns {{ index: Int8Array, changed: number, farthest: number, farthestRow: number }} the new picture, the pixels changed, and the biggest move of an edge in pixels
 */
export function healDomeSides({ index, width, from, to, search, curves }) {
    const healed = Int8Array.from(index);
    let changed = 0;
    let farthest = 0;
    let farthestRow = from;
    for (let y = from; y < to; y++) {
        for (const side of ['left', 'right']) {
            const boundary = edgeBoundary(index, width, y, side, search[side]);
            if (boundary < 0) {
                continue;
            }
            const wanted = side === 'left' ? Math.ceil(curveAt(curves.left, y + 0.5) - 0.5) : Math.floor(curveAt(curves.right, y + 0.5) + 0.5);
            const move = Math.abs(wanted - boundary);
            if (move === 0) {
                continue;
            }
            const outwards = side === 'left' ? wanted < boundary : wanted > boundary;
            const [first, last] = wanted < boundary ? [wanted, boundary - 1] : [boundary, wanted - 1];
            const tone = index[y * width + (side === 'left' ? boundary : boundary - 1)];
            for (let x = first; x <= last; x++) {
                healed[y * width + x] = outwards ? tone : -1;
            }
            changed += move;
            if (move > farthest) {
                [farthest, farthestRow] = [move, y];
            }
        }
    }
    return { index: healed, changed, farthest, farthestRow };
}
