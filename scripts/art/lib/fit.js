import { ArtProblem } from './problem.js';
import { createRaster } from './raster.js';

/**
 * The most master pixels a fit puts into one placement pixel. Past it a cell holds three or more master pixels a side,
 * so one-pixel lines and the 2+2 rings break up; such a placement needs a smaller master drawn at ratio 1.
 */
export const LARGEST_FIT = 2;

/**
 * How a master reaches its placement grid at `p` master pixels per `q` placement pixels: as it is, enlarged by a whole
 * factor, or fitted to a grid of fewer pixels.
 * @param {{ p: number, q: number }} ratio In lowest terms.
 * @param {string} id The asset, for a refusal.
 * @returns {{ step: 'native' } | { step: 'enlarge', factor: number } | { step: 'fit' }}
 * @throws {ArtProblem} `ratio-too-large` past `LARGEST_FIT`, and `fractional-enlargement` for an enlargement by a factor
 *   that is not whole.
 */
export function placementStep({ p, q }, id) {
    if (p === q) {
        return { step: 'native' };
    }
    if (p > LARGEST_FIT * q) {
        throw new ArtProblem('ratio-too-large', `${id} is placed at ${p}/${q} master pixels per placement pixel, but a fit takes at most ${LARGEST_FIT}. Draw its master at the placement size.`, { asset: id });
    }
    if (p > q) {
        return { step: 'fit' };
    }
    if (p === 1) {
        return { step: 'enlarge', factor: q };
    }
    throw new ArtProblem('fractional-enlargement', `${id} would enlarge its master by ${q}/${p}, but an enlargement must be a whole factor. Change the master's grid or the placement.`, { asset: id });
}

/**
 * Fits a master to a grid of fewer pixels without making up a colour. Cells start at the canvas origin, and each master
 * pixel belongs to the cell its centre lies in, so up to a ratio of 2 a cell holds one to four master pixels. A cell is
 * opaque when at least half of its pixels are, and it takes the exact colour that most of its opaque pixels have.
 * @param {import('./raster.js').Raster} raster With alpha 0 or 255 only.
 * @param {{ p: number, q: number }} ratio More than 1 and at most `LARGEST_FIT`, in lowest terms.
 * @returns {import('./raster.js').Raster} With alpha 0 or 255 only, and the colour under alpha 0 zero.
 */
export function fitToGrid(raster, { p, q }) {
    // The centre of pixel x lies at x + 1/2, in cell floor((x + 1/2) * q / p); this is the same in whole numbers.
    const cellOf = (x) => Math.floor(((2 * x + 1) * q) / (2 * p));
    const columns = spans(raster.width, cellOf);
    const rows = spans(raster.height, cellOf);
    const fitted = createRaster(columns.length, rows.length, raster.channels);
    for (let row = 0; row < rows.length; row++) {
        for (let column = 0; column < columns.length; column++) {
            const colour = cellColour(raster, columns[column], rows[row], { column, row, p, q });
            if (colour !== null) {
                const at = (row * fitted.width + column) * 4;
                fitted.data.writeUIntBE(colour, at, 3);
                fitted.data[at + 3] = 255;
            }
        }
    }
    return fitted;
}

/** The first master pixel of each cell along one side, and the one after its last. */
function spans(length, cellOf) {
    const found = [];
    for (let x = 0; x < length; x++) {
        const cell = cellOf(x);
        if (cell === found.length) {
            found.push([x, x + 1]);
        } else {
            found[cell][1] = x + 1;
        }
    }
    return found;
}

/**
 * The colour of one cell as a 24-bit number, or null for a transparent cell. A tie between colours goes to the pixel
 * nearest the cell centre, and a tie between pixels as near to the first of them in reading order.
 */
function cellColour(raster, [left, right], [top, bottom], { column, row, p, q }) {
    const counts = new Map();
    let opaque = 0;
    for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
            const at = (y * raster.width + x) * 4;
            if (raster.data[at + 3] !== 0) {
                const key = raster.data.readUIntBE(at, 3);
                counts.set(key, (counts.get(key) ?? 0) + 1);
                opaque++;
            }
        }
    }
    if (opaque * 2 < (right - left) * (bottom - top)) {
        return null;
    }
    const most = Math.max(...counts.values());
    let chosen = null;
    let nearest = Infinity;
    for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
            const at = (y * raster.width + x) * 4;
            const key = raster.data.readUIntBE(at, 3);
            if (raster.data[at + 3] === 0 || counts.get(key) !== most) {
                continue;
            }
            // Measured in steps of 1/(2q) master pixels, so the distance stays a whole number.
            const across = q * (2 * x + 1) - p * (2 * column + 1);
            const down = q * (2 * y + 1) - p * (2 * row + 1);
            const distance = across * across + down * down;
            if (distance < nearest) {
                nearest = distance;
                chosen = key;
            }
        }
    }
    return chosen;
}
