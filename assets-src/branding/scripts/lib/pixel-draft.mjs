import { createRaster } from './raster.mjs';
import { fillHoles, opaqueMask } from './shape-ops.mjs';

// A cell is part of the shape when at least half of it is covered.
export const SOLID_COVERAGE = 0.5;
// A cell that touches a solid cell is also part of the shape from this much coverage, which keeps the tips of thin parts such as ears
// one cell wide. A cell with no solid neighbour never takes it, so a stray speck of coverage cannot make an orphan pixel.
export const EDGE_COVERAGE = 0.4;

const FOUR_NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** The shape's holes: background the canvas border cannot reach, such as letters cut out of it. */
export function findHoles(raster) {
    const mask = opaqueMask(raster);
    const filled = fillHoles(mask, raster.width, raster.height);
    return Uint8Array.from(filled, (value, at) => (value === 1 && mask[at] === 0 ? 1 : 0));
}

/** A copy of the picture with every hole painted in `tone`, so it reads as a solid shape. */
export function paintHoles(raster, holes, tone) {
    const data = Buffer.from(raster.data);
    holes.forEach((hole, at) => {
        if (hole === 1) {
            data.set([...tone, 255], at * 4);
        }
    });
    return { ...raster, data };
}

/**
 * The picture reduced to a `grid` by `grid` one by area coverage: each cell looks at every source pixel it holds, becomes opaque
 * when enough of them are opaque, and takes the tone that covers most of it. The result has the tones and full transparency only.
 * @param {import('./raster.mjs').Raster} raster a square picture whose opaque pixels are exactly the tones
 * @param {{ rgb: number[] }[]} tones
 * @param {number} grid
 * @param {{ solid?: number, edge?: number }} [options]
 */
export function reduceByCoverage(raster, tones, grid, { solid = SOLID_COVERAGE, edge = EDGE_COVERAGE } = {}) {
    if (raster.width !== raster.height || !Number.isInteger(grid) || grid < 1 || grid > raster.width) {
        throw new Error(`A square picture and a whole grid size no larger than it are needed; got ${raster.width}x${raster.height} and ${grid}.`);
    }
    const toneOf = new Map(tones.map((tone, index) => [(tone.rgb[0] << 16) | (tone.rgb[1] << 8) | tone.rgb[2], index]));
    const cells = grid * grid;
    const pixels = new Float64Array(cells);
    const covered = new Float64Array(cells * tones.length);
    for (let y = 0; y < raster.height; y++) {
        const row = Math.floor((y * grid) / raster.height) * grid;
        for (let x = 0; x < raster.width; x++) {
            const cell = row + Math.floor((x * grid) / raster.width);
            const at = y * raster.width + x;
            pixels[cell]++;
            if (raster.data[at * 4 + 3] >= 128) {
                const tone = toneOf.get((raster.data[at * 4] << 16) | (raster.data[at * 4 + 1] << 8) | raster.data[at * 4 + 2]);
                if (tone === undefined) {
                    throw new Error(`The picture has a colour at ${x},${y} that is not one of the tones; snap it first.`);
                }
                covered[cell * tones.length + tone]++;
            }
        }
    }

    const coverage = Float64Array.from({ length: cells }, (_, cell) => {
        let sum = 0;
        for (let tone = 0; tone < tones.length; tone++) {
            sum += covered[cell * tones.length + tone];
        }
        return sum / pixels[cell];
    });
    const isSolid = (cell) => coverage[cell] >= solid;
    const out = createRaster(grid, grid);
    for (let cell = 0; cell < cells; cell++) {
        const x = cell % grid;
        const y = (cell - x) / grid;
        const touchesSolid = FOUR_NEIGHBOURS.some(([dx, dy]) => x + dx >= 0 && x + dx < grid && y + dy >= 0 && y + dy < grid && isSolid((y + dy) * grid + x + dx));
        const inside = isSolid(cell) || (coverage[cell] >= edge && touchesSolid);
        if (!inside) {
            continue;
        }
        let best = 0;
        for (let tone = 1; tone < tones.length; tone++) {
            if (covered[cell * tones.length + tone] > covered[cell * tones.length + best]) {
                best = tone;
            }
        }
        out.data.set([...tones[best].rgb, 255], cell * 4);
    }
    return out;
}

// Letters cut out of the dome, one cell per stroke. Each is 3 cells wide and 5 tall; # is a cell that is cut away.
export const GLYPHS = {
    S: ['###', '#..', '###', '..#', '###'],
    B: ['##.', '#.#', '##.', '#.#', '##.'],
};
const GLYPH_WIDTH = 3;
const GLYPH_HEIGHT = 5;
// Two cells between the letters keeps the pair symmetric about the middle of an even grid.
const GLYPH_GAP = 2;

/**
 * Cuts the letters "SB" out of a grid picture as transparent cells, centred on the middle of the grid across and on `centreRow` down.
 * A cell that is not part of the shape is left alone, so the letters never reach outside it.
 * @param {import('./raster.mjs').Raster} grid
 * @param {number} centreRow the row (a fraction is fine) the letters are centred on
 */
export function cutLetters(grid, centreRow) {
    const size = grid.width;
    const blockWidth = GLYPH_WIDTH * 2 + GLYPH_GAP;
    if (size % 2 !== 0 || size < blockWidth + 2 || centreRow < GLYPH_HEIGHT / 2 || centreRow > size - GLYPH_HEIGHT / 2) {
        throw new Error(`The letters need an even grid at least ${blockWidth + 2} cells wide and a centre row inside it; got ${size} and ${centreRow}.`);
    }
    const out = { ...grid, data: Buffer.from(grid.data) };
    const left = (size - blockWidth) / 2;
    const top = Math.round(centreRow - GLYPH_HEIGHT / 2);
    for (const [index, letter] of ['S', 'B'].entries()) {
        const origin = left + index * (GLYPH_WIDTH + GLYPH_GAP);
        GLYPHS[letter].forEach((line, row) => {
            [...line].forEach((mark, column) => {
                if (mark === '#') {
                    out.data.set([0, 0, 0, 0], ((top + row) * size + origin + column) * 4);
                }
            });
        });
    }
    return out;
}

/** The row, in grid cells, that the middle of the holes (the letters) falls on. */
export function holesCentreRow(holes, width, grid) {
    let first = -1;
    let last = -1;
    for (let at = 0; at < holes.length; at++) {
        if (holes[at] === 1) {
            first = first < 0 ? at : first;
            last = at;
        }
    }
    if (first < 0) {
        throw new Error('The picture has no letters cut out of it, so there is no row to centre them on.');
    }
    return (((Math.floor(first / width) + Math.floor(last / width) + 1) / 2) * grid) / width;
}
