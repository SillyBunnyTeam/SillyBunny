import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitToGrid, placementStep } from '../lib/fit.js';
import { upscaleNearest } from '../lib/raster.js';
import { paint, pixelAt } from '../test-support/pictures.js';

const CLEAR = [0, 0, 0, 0];
const RED = [220, 40, 40, 255];
const BLUE = [40, 60, 200, 255];
const GREEN = [40, 180, 90, 255];
const THREE_HALVES = { p: 3, q: 2 };
const TWO = { p: 2, q: 1 };

/** The cell a master pixel belongs to at ratio p/q, worked out in fractions rather than by the code under test. */
const cellAt = (x, { p, q }) => Math.floor((x + 0.5) / (p / q));

/** A master in which every pixel has the colour of its cell in `truth`, so a fit must give `truth` back. */
function stretched(truth, ratio, size) {
    return paint(size[0], size[1], (x, y) => pixelAt(truth, cellAt(x, ratio), cellAt(y, ratio)));
}

/** A small deterministic sequence, so a picture of many colours is the same on every run. */
function sequence(seed) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

const coloursOf = (raster) => {
    const found = new Set();
    for (let at = 0; at < raster.data.length; at += 4) {
        if (raster.data[at + 3] !== 0) {
            found.add(raster.data.readUIntBE(at, 3));
        }
    }
    return found;
};

test('each master pixel belongs to the cell its centre lies in', () => {
    const truth = paint(6, 4, (x, y) => [x * 40, y * 60, (x + y) * 20, (x + y) % 3 === 0 ? 0 : 255]);
    const cleared = paint(6, 4, (x, y) => (pixelAt(truth, x, y)[3] === 0 ? CLEAR : pixelAt(truth, x, y)));

    assert.deepEqual(fitToGrid(stretched(cleared, THREE_HALVES, [9, 6]), THREE_HALVES), cleared);
    assert.deepEqual(fitToGrid(upscaleNearest(cleared, 2), TWO), cleared);
});

test('a canvas that ends inside a cell gives that cell from the pixels it has', () => {
    const fitted = fitToGrid(paint(5, 1, (x) => (x === 4 ? BLUE : RED)), TWO);

    assert.deepEqual([fitted.width, fitted.height], [3, 1]);
    assert.deepEqual(pixelAt(fitted, 2, 0), BLUE);
});

test('a cell is opaque when at least half of its pixels are', () => {
    const rows = [
        [RED, CLEAR, CLEAR, CLEAR],
        [RED, RED, CLEAR, CLEAR],
        [CLEAR, RED, RED, RED],
    ];
    const fitted = (row) => pixelAt(fitToGrid(paint(2, 2, (x, y) => row[y * 2 + x]), TWO), 0, 0);

    assert.deepEqual(rows.map(fitted), [CLEAR, RED, RED]);
    const halves = fitToGrid(paint(3, 1, (x) => (x === 2 ? RED : CLEAR)), THREE_HALVES);
    assert.deepEqual([pixelAt(halves, 0, 0), pixelAt(halves, 1, 0)], [CLEAR, RED], 'one of two pixels is half the cell');
});

test('a cell takes the colour most of its opaque pixels have, and a tie goes to the pixel nearest its centre', () => {
    const most = fitToGrid(paint(2, 2, (x, y) => (x === 1 && y === 1 ? BLUE : RED)), TWO);
    assert.deepEqual(pixelAt(most, 0, 0), RED);

    // At 3/2 the second cell holds master pixels 1 and 2; its centre lies at 2.25, nearer to pixel 2 (centre 2.5).
    const tie = fitToGrid(paint(3, 1, (x) => [GREEN, RED, BLUE][x]), THREE_HALVES);
    assert.deepEqual(pixelAt(tie, 1, 0), BLUE);
    const swapped = fitToGrid(paint(3, 1, (x) => [GREEN, BLUE, RED][x]), THREE_HALVES);
    assert.deepEqual(pixelAt(swapped, 1, 0), RED);

    // At 2 every pixel of a cell is as near its centre, so the first in reading order decides.
    const even = fitToGrid(paint(2, 2, (x, y) => (y === 0 ? [BLUE, RED][x] : [RED, BLUE][x])), TWO);
    assert.deepEqual(pixelAt(even, 0, 0), BLUE);
});

test('a fit makes up no colour and keeps alpha binary', () => {
    const palette = [RED, BLUE, GREEN, [250, 250, 250, 255], [20, 20, 30, 255]];
    const next = sequence(7);
    const master = paint(45, 36, () => (next() < 0.2 ? CLEAR : palette[Math.floor(next() * palette.length)]));

    for (const ratio of [THREE_HALVES, TWO]) {
        const fitted = fitToGrid(master, ratio);
        assert.deepEqual([...coloursOf(fitted)].filter((colour) => !coloursOf(master).has(colour)), [], `${ratio.p}/${ratio.q}`);
        assert.equal(fitted.data.every((value, at) => at % 4 !== 3 || value === 0 || value === 255), true);
    }
});

test('a ratio of 1 keeps the master, a whole enlargement is nearest, and the rest is a fit or refused', () => {
    assert.deepEqual(placementStep({ p: 1, q: 1 }, 'fig'), { step: 'native' });
    assert.deepEqual(placementStep({ p: 1, q: 3 }, 'fig'), { step: 'enlarge', factor: 3 });
    assert.deepEqual(placementStep({ p: 3, q: 2 }, 'fig'), { step: 'fit' });
    assert.deepEqual(placementStep({ p: 2, q: 1 }, 'fig'), { step: 'fit' });
    assert.throws(() => placementStep({ p: 5, q: 2 }, 'fig'), { code: 'ratio-too-large' });
    assert.throws(() => placementStep({ p: 3, q: 1 }, 'fig'), { code: 'ratio-too-large' });
    assert.throws(() => placementStep({ p: 2, q: 3 }, 'fig'), { code: 'fractional-enlargement' });
});
