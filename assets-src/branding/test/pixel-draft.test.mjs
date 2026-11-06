import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLYPHS, cutLetters, findHoles, holesCentreRow, paintHoles, reduceByCoverage } from '../scripts/lib/pixel-draft.mjs';
import { labelComponents, dropThinParts } from '../scripts/lib/shape-ops.mjs';
import { DARK, LIGHT, MID, ellipse, rect } from '../test-support/emblem.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const TONES = [{ rgb: MID }, { rgb: DARK }, { rgb: LIGHT }];
const CELL = 4;

// Fills the first `count` pixels of a cell, in reading order, so the cell's coverage is count / 16.
function fillCell(raster, cellX, cellY, count, colour, from = 0) {
    for (let k = from; k < from + count; k++) {
        setPixel(raster, cellX * CELL + (k % CELL), cellY * CELL + Math.floor(k / CELL), colour);
    }
}

const isOpaque = (raster, x, y) => getPixel(raster, x, y)[3] === 255;

function cellPicture() {
    const raster = createRaster(16, 16);
    fillCell(raster, 0, 0, 16, MID);
    fillCell(raster, 1, 0, 7, DARK);
    fillCell(raster, 0, 1, 6, LIGHT);
    fillCell(raster, 3, 3, 7, DARK);
    fillCell(raster, 2, 1, 4, DARK);
    fillCell(raster, 2, 1, 5, LIGHT, 4);
    return raster;
}

test('a cell is opaque from half coverage, or from 40% when it touches a solid cell, and a lone speck of coverage is not a pixel', () => {
    const grid = reduceByCoverage(cellPicture(), TONES, 4);
    assert.ok(isOpaque(grid, 0, 0), 'a full cell');
    assert.ok(isOpaque(grid, 2, 1), 'a cell that is 9/16 covered is solid on its own');
    assert.ok(isOpaque(grid, 1, 0), '7/16 beside a solid cell is taken as an edge');
    assert.ok(!isOpaque(grid, 0, 1), '6/16 is under the edge threshold even beside a solid cell');
    assert.ok(!isOpaque(grid, 3, 3), '7/16 with no solid neighbour is left out, so there is no orphan');
});

test('a cell takes the tone that covers most of it, and the picture holds only the tones and full transparency', () => {
    const grid = reduceByCoverage(cellPicture(), TONES, 4);
    assert.deepEqual(getPixel(grid, 2, 1).slice(0, 3), LIGHT, '5 light pixels beat 4 dark ones, whichever comes first');
    assert.deepEqual(getPixel(grid, 1, 0).slice(0, 3), DARK);
    for (let at = 0; at < grid.data.length; at += 4) {
        assert.ok(grid.data[at + 3] === 0 || grid.data[at + 3] === 255);
    }
});

test('the thresholds can be set, and they apply to the same coverage', () => {
    const strict = reduceByCoverage(cellPicture(), TONES, 4, { solid: 0.6, edge: 0.45 });
    assert.ok(!isOpaque(strict, 2, 1), '9/16 is under 0.6');
    assert.ok(!isOpaque(strict, 1, 0), '7/16 is under 0.45');
    assert.ok(isOpaque(strict, 0, 0));
});

test('a colour that is not one of the tones is refused rather than guessed, and so are a picture that is not square and a grid that does not fit', () => {
    const raster = createRaster(8, 8);
    setPixel(raster, 1, 1, [1, 2, 3]);
    assert.throws(() => reduceByCoverage(raster, TONES, 4), /not one of the tones/);
    assert.throws(() => reduceByCoverage(createRaster(8, 4), TONES, 4), /square picture/);
    assert.throws(() => reduceByCoverage(createRaster(8, 8), TONES, 3.5), /whole grid size/);
    assert.throws(() => reduceByCoverage(createRaster(8, 8), TONES, 16), /no larger/);
});

// Two ears standing on a dome that has two letter holes, with a line and a dot beside it that the pixel draft must leave out.
function earsAndDome() {
    const raster = createRaster(256, 256);
    const draw = (inside, colour) => {
        for (let y = 0; y < 256; y++) {
            for (let x = 0; x < 256; x++) {
                if (inside(x + 0.5, y + 0.5)) {
                    setPixel(raster, x, y, colour);
                }
            }
        }
    };
    draw(ellipse(100, 100, 16, 80), MID);
    draw(ellipse(160, 110, 16, 70), MID);
    draw((x, y) => ellipse(128, 200, 70, 50)(x, y) && y <= 200, MID);
    draw((x, y) => ellipse(128, 200, 70, 50)(x, y) && y <= 200 && y > 191, DARK);
    draw(rect(100, 170, 115, 190), [0, 0, 0, 0]);
    draw(rect(135, 170, 150, 190), [0, 0, 0, 0]);
    draw(rect(20, 185, 56, 191), MID);
    draw(ellipse(18, 188, 9, 9), MID);
    return raster;
}

test('the ears and dome reduce to one 4-connected piece at 16 and 32, with no orphan cells and without the line and its dot', () => {
    const source = earsAndDome();
    const body = dropThinParts(source, { thinWidth: 11 });
    const solid = paintHoles(body, findHoles(body), MID);
    for (const size of [16, 32]) {
        const grid = reduceByCoverage(solid, TONES, size);
        const mask = Uint8Array.from({ length: size * size }, (_, at) => (grid.data[at * 4 + 3] === 255 ? 1 : 0));
        const { areas } = labelComponents(mask, size, size, 4);
        assert.equal(areas.length, 1, `${size}: ${areas}`);
        assert.ok(areas[0] > size, `${size}: ${areas[0]} cells`);
        const leftmost = mask.findIndex((value, at) => value === 1 && at % size < size / 8);
        assert.equal(leftmost, -1, `${size}: nothing where the line and its dot were`);
    }
});

test('holes are the background that the border cannot reach, a notch open to the border is not one, and painting fills only the holes', () => {
    const ring = createRaster(12, 12);
    for (let y = 1; y < 11; y++) {
        for (let x = 1; x < 11; x++) {
            setPixel(ring, x, y, MID);
        }
    }
    for (let y = 4; y < 7; y++) {
        for (let x = 4; x < 8; x++) {
            setPixel(ring, x, y, [0, 0, 0, 0]);
        }
    }
    // A notch cut from the ring's edge to the border is open, so it is not a hole.
    for (let x = 0; x < 4; x++) {
        setPixel(ring, x, 9, [0, 0, 0, 0]);
    }
    const notch = createRaster(12, 12, [...MID, 255]);
    for (let x = 0; x < 6; x++) {
        setPixel(notch, x, 5, [0, 0, 0, 0]);
    }
    const holes = findHoles(ring);
    assert.equal(holes.reduce((total, value) => total + value, 0), 12, 'the 4 by 3 hole and nothing else');
    assert.equal(holes[5 * 12 + 5], 1);
    assert.equal(findHoles(notch).reduce((total, value) => total + value, 0), 0, 'a notch from the border is open');
    const painted = paintHoles(ring, holes, DARK);
    assert.deepEqual(getPixel(painted, 5, 5), [...DARK, 255]);
    assert.deepEqual(getPixel(painted, 0, 0), [0, 0, 0, 0], 'outside stays transparent');
    assert.deepEqual(getPixel(ring, 5, 5), [0, 0, 0, 0], 'the original is not changed');
});

function solidGrid(size) {
    return createRaster(size, size, [...MID, 255]);
}

test('the letters are cut as one cell strokes, centred on the middle of the grid, and nothing else is touched', () => {
    const cut = cutLetters(solidGrid(32), 16);
    const transparent = [];
    for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
            if (!isOpaque(cut, x, y)) {
                transparent.push([x, y]);
            }
        }
    }
    const marks = (letter) => GLYPHS[letter].join('').replaceAll('.', '').length;
    assert.equal(transparent.length, marks('S') + marks('B'));
    // 5 rows centred on 16 start at 14 (13.5 rounded), and the two letters and their 2 cell gap span 12 to 19.
    assert.deepEqual([Math.min(...transparent.map(([x]) => x)), Math.max(...transparent.map(([x]) => x))], [12, 19]);
    assert.deepEqual([Math.min(...transparent.map(([, y]) => y)), Math.max(...transparent.map(([, y]) => y))], [14, 18]);
    assert.ok(!isOpaque(cut, 12, 14) && !isOpaque(cut, 12, 15) && isOpaque(cut, 13, 15), 'the S turns at its second row');
    assert.ok(!isOpaque(cut, 17, 15) && isOpaque(cut, 18, 15) && !isOpaque(cut, 19, 15), 'the B has a counter in its second row');
    assert.ok(isOpaque(solidGrid(32), 12, 14), 'the input grid is not changed');
});

test('the letters are refused on an odd grid, on a grid too small for them and on a centre row outside the grid', () => {
    assert.throws(() => cutLetters(solidGrid(31), 15), /even grid/);
    assert.throws(() => cutLetters(solidGrid(8), 4), /even grid/);
    assert.throws(() => cutLetters(solidGrid(32), 1), /centre row/);
    assert.throws(() => cutLetters(solidGrid(32), 31), /centre row/);
});

test('the letters centre on the middle row of the holes, in grid cells', () => {
    const holes = new Uint8Array(64 * 64);
    for (let y = 20; y < 28; y++) {
        holes[y * 64 + 30] = 1;
    }
    assert.equal(holesCentreRow(holes, 64, 32), 12, 'rows 20 to 27 are centred on 24 of 64, which is 12 of 32');
    assert.throws(() => holesCentreRow(new Uint8Array(64 * 64), 64, 32), /no letters/);
});
