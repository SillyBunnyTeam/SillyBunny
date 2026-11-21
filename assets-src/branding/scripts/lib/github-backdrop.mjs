import { detectAxes } from './pixel-grid.mjs';
import { createRaster, isOpaque, readRaster } from './raster.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */
/** @typedef {{ cell: number, offset: number, strength: number }} Axis */

/**
 * A snapped backdrop picture: it must be opaque, because it is the ground that everything else is set on.
 * @param {Raster} picture
 * @param {string} name what the picture is called in an error: its path
 * @returns {Raster}
 */
export function parseBackdrop(picture, name) {
    if (!isOpaque(picture)) {
        throw new Error(`${name} has transparent pixels, but a backdrop is the ground of the banner and must be opaque.`);
    }
    return picture;
}

/** @param {string} path @returns {Promise<Raster>} */
export async function loadBackdrop(path) {
    return parseBackdrop(await readRaster(path), path);
}

/**
 * Finds the pixel grid that a generated plate was drawn on. The two axes are searched apart because a model does not always draw
 * square pixels: a plate may be 3.2 master pixels across a cell and 4.0 down it.
 * @param {Raster} master
 * @param {{ x: number, y: number, width: number, height: number }} box the area to analyse, which should hold the detail
 * @param {{ across: [number, number], down: [number, number] }} windows the cell sizes to try on each axis, in master pixels
 * @returns {{ across: Axis, down: Axis }} grid line k of an axis is at offset + k * cell, in master pixels
 */
export function detectPlateGrid(master, box, windows) {
    const found = detectAxes(master, box, { minCell: windows.across[0], maxCell: windows.across[1] });
    const down = detectAxes(master, box, { minCell: windows.down[0], maxCell: windows.down[1] });
    return { across: found.across, down: down.down };
}

/** The mean colour of the middle half of one cell of the plate's own grid, which is clear of the blur where two cells meet. */
function cellColour(master, grid, cellX, cellY) {
    const left = grid.across.offset + (cellX + 0.25) * grid.across.cell;
    const top = grid.down.offset + (cellY + 0.25) * grid.down.cell;
    const fromX = Math.max(0, Math.min(master.width - 1, Math.floor(left)));
    const fromY = Math.max(0, Math.min(master.height - 1, Math.floor(top)));
    const toX = Math.max(fromX, Math.min(master.width - 1, Math.ceil(left + 0.5 * grid.across.cell) - 1));
    const toY = Math.max(fromY, Math.min(master.height - 1, Math.ceil(top + 0.5 * grid.down.cell) - 1));
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = fromY; y <= toY; y++) {
        for (let x = fromX; x <= toX; x++) {
            const at = (y * master.width + x) * 4;
            sum[0] += master.data[at];
            sum[1] += master.data[at + 1];
            sum[2] += master.data[at + 2];
            count += 1;
        }
    }
    return sum.map((channel) => Math.round(channel / count));
}

/**
 * Snaps a window of a plate to square art pixels. Every art pixel looks up the cell of the plate's own grid under its middle and takes that
 * cell's colour, so the result has the plate's own pixels in it and nothing blended from two of them. Where the art pixel is finer than the
 * plate's cell the same cell is taken for several art pixels, and where it is coarser some cells are skipped.
 * @param {Raster} master
 * @param {{ across: Axis, down: Axis }} grid the plate's grid, from detectPlateGrid
 * @param {{ cell: number, x: number, y: number, columns: number, rows: number }} window `cell` is the size of an art pixel in master pixels;
 * x and y the master pixel where the first art pixel starts
 * @returns {Raster} opaque, `columns` by `rows` art pixels
 */
export function snapBackdrop(master, grid, { cell, x, y, columns, rows }) {
    if (!(cell > 0) || !Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) {
        throw new Error(`A backdrop window needs a cell above 0 and a whole number of columns and rows, got cell ${cell}, ${columns}x${rows}.`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`A backdrop window needs the master pixel where it starts, as numbers x and y, got ${x}, ${y}.`);
    }
    if (x < 0 || y < 0 || x + columns * cell > master.width + 1e-6 || y + rows * cell > master.height + 1e-6) {
        throw new Error(`The window ${columns}x${rows} art pixels of ${cell} master pixels from ${x},${y} is not inside the ${master.width}x${master.height} plate.`);
    }
    const picture = createRaster(columns, rows);
    const cache = new Map();
    for (let row = 0; row < rows; row++) {
        const cellY = Math.floor((y + (row + 0.5) * cell - grid.down.offset) / grid.down.cell);
        for (let column = 0; column < columns; column++) {
            const cellX = Math.floor((x + (column + 0.5) * cell - grid.across.offset) / grid.across.cell);
            const key = `${cellX},${cellY}`;
            if (!cache.has(key)) {
                cache.set(key, cellColour(master, grid, cellX, cellY));
            }
            picture.data.set([...cache.get(key), 255], (row * columns + column) * 4);
        }
    }
    return picture;
}

const lumaAt = (picture, x, y) => {
    const at = (y * picture.width + x) * 4;
    return 0.2126 * picture.data[at] + 0.7152 * picture.data[at + 1] + 0.0722 * picture.data[at + 2];
};

/** The strongest `share` of the colour changes inside a box, as a mask: 1 where the picture has an edge. */
function edgeMask(picture, box, share) {
    const magnitudes = new Float32Array(box.width * box.height);
    for (let y = 0; y < box.height; y++) {
        for (let x = 0; x < box.width; x++) {
            const here = lumaAt(picture, box.x + x, box.y + y);
            const right = box.x + x + 1 < picture.width ? lumaAt(picture, box.x + x + 1, box.y + y) : here;
            const below = box.y + y + 1 < picture.height ? lumaAt(picture, box.x + x, box.y + y + 1) : here;
            magnitudes[y * box.width + x] = Math.abs(right - here) + Math.abs(below - here);
        }
    }
    const limit = [...magnitudes].sort((one, two) => two - one)[Math.floor(share * magnitudes.length)];
    return Uint8Array.from(magnitudes, (value) => (value > 0 && value >= limit ? 1 : 0));
}

/**
 * How far one plate is shifted against another in a region, found from where their edges lie: the strongest edges of each are compared
 * at every shift of up to `maxShift` pixels, and the shift where most of them coincide is the answer. A plate that is an edit of the
 * other keeps its edges where they were, so the answer is 0,0 and the overlap at 0,0 is high.
 * @param {Raster} reference
 * @param {Raster} edited
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {{ maxShift?: number, share?: number }} [options]
 * @returns {{ dx: number, dy: number, overlap: number, overlapAtZero: number }} the overlap is the share of the edge pixels of either picture that both have
 */
export function findPlateShift(reference, edited, box, { maxShift = 8, share = 0.15 } = {}) {
    const wide = { x: box.x - maxShift, y: box.y - maxShift, width: box.width + 2 * maxShift, height: box.height + 2 * maxShift };
    const fixed = edgeMask(reference, box, share);
    const moving = edgeMask(edited, wide, share);
    let best = { dx: 0, dy: 0, overlap: -1 };
    let atZero = 0;
    for (let dy = -maxShift; dy <= maxShift; dy++) {
        for (let dx = -maxShift; dx <= maxShift; dx++) {
            let both = 0;
            let either = 0;
            for (let y = 0; y < box.height; y++) {
                for (let x = 0; x < box.width; x++) {
                    const one = fixed[y * box.width + x];
                    const two = moving[(y + maxShift + dy) * wide.width + (x + maxShift + dx)];
                    both += one & two;
                    either += one | two;
                }
            }
            const overlap = both / either;
            atZero = dx === 0 && dy === 0 ? overlap : atZero;
            best = overlap > best.overlap ? { dx, dy, overlap } : best;
        }
    }
    return { ...best, overlapAtZero: atZero };
}

const RING_POINTS = 120;

/**
 * Fits the circle of the moon's rim in a box that holds the moon: for every centre and radius tried, the colour change across the circle
 * (the pixel 2 outside it against the pixel 2 inside it) is averaged round the ring, and the circle with the strongest change is the rim.
 * A halo round the moon does not move the fit, because the strongest edge is the rim itself.
 * @param {Raster} picture
 * @param {{ x: number, y: number, width: number, height: number }} box the centres to try
 * @param {{ min: number, max: number }} radii the radii to try, in pixels
 * @returns {{ x: number, y: number, radius: number, strength: number }}
 */
export function fitMoon(picture, box, radii = { min: 55, max: 85 }) {
    const directions = Array.from({ length: RING_POINTS }, (_, at) => [Math.cos((2 * Math.PI * at) / RING_POINTS), Math.sin((2 * Math.PI * at) / RING_POINTS)]);
    const luma = (x, y) => lumaAt(picture, Math.max(0, Math.min(picture.width - 1, Math.round(x))), Math.max(0, Math.min(picture.height - 1, Math.round(y))));
    let best = { x: 0, y: 0, radius: 0, strength: -1 };
    for (let centreY = box.y; centreY < box.y + box.height; centreY++) {
        for (let centreX = box.x; centreX < box.x + box.width; centreX++) {
            for (let radius = radii.min; radius <= radii.max; radius++) {
                let strength = 0;
                for (const [cos, sin] of directions) {
                    strength += Math.abs(luma(centreX + cos * (radius + 2), centreY + sin * (radius + 2)) - luma(centreX + cos * (radius - 2), centreY + sin * (radius - 2)));
                }
                strength /= RING_POINTS;
                best = strength > best.strength ? { x: centreX, y: centreY, radius, strength } : best;
            }
        }
    }
    return best;
}
