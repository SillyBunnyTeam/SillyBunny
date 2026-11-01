import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMask, opaqueMask, runLengths, splitThinParts } from '../scripts/lib/shape-ops.mjs';
import { MID } from '../test-support/emblem.mjs';
import { createRaster, setPixel } from '../test-support/synthetic.mjs';

const WIDTH = 160;
const HEIGHT = 100;

function draw(boxes) {
    const raster = createRaster(WIDTH, HEIGHT);
    for (const [x0, y0, x1, y1, colour] of boxes) {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                setPixel(raster, x, y, colour ?? MID);
            }
        }
    }
    return raster;
}

const at = (x, y) => y * WIDTH + x;
const count = (mask) => mask.reduce((total, value) => total + value, 0);

// A big block with a thin line, a blob thicker than the window but small, a small square, and a single pixel speck.
const PARTS = [
    [60, 10, 110, 90],
    [20, 40, 60, 46],
    [5, 33, 25, 53],
    [120, 80, 136, 96],
    [150, 5, 151, 6],
];

test('the picture splits into a body and what hangs off it, with every drawn pixel in exactly one of them', () => {
    const raster = draw(PARTS);
    const { mask, core, body, thin, radius } = splitThinParts(raster, { thinWidth: 11 });
    assert.equal(radius, 5);
    assert.equal(count(mask), count(opaqueMask(raster)));
    for (let pixel = 0; pixel < mask.length; pixel++) {
        assert.equal(body[pixel] + thin[pixel], mask[pixel], `pixel ${pixel} is in the body or in thin, not both`);
        assert.ok(core[pixel] <= body[pixel], 'the core is inside the body');
    }
    assert.equal(thin[at(35, 43)], 1, 'the line');
    assert.equal(thin[at(10, 43)], 1, 'a blob thicker than the window but small is not the body');
    assert.equal(thin[at(128, 88)], 1, 'a small thick piece is not the body either');
    assert.equal(body[at(85, 50)], 1);
    assert.equal(thin[at(150, 5)], 1, 'a speck');
});

test('a piece that is at least the keep share of the biggest stays in the body', () => {
    const raster = draw([[10, 10, 70, 90], [100, 30, 140, 70]]);
    const kept = splitThinParts(raster, { thinWidth: 11, keepShare: 0.15 });
    assert.equal(kept.body[at(120, 50)], 1);
    const dropped = splitThinParts(raster, { thinWidth: 11, keepShare: 0.5 });
    assert.equal(dropped.body[at(120, 50)], 0);
    assert.equal(dropped.thin[at(120, 50)], 1);
});

test('the pixels the opening rounds off are put back into the body, and the stub of a line is no longer than the window radius', () => {
    const raster = draw([[60, 10, 110, 90], [20, 40, 60, 46]]);
    const { body, core, thin } = splitThinParts(raster, { thinWidth: 11 });
    assert.equal(core[at(58, 43)], 0);
    assert.equal(body[at(58, 43)], 1, 'two pixels from the block is a stub');
    assert.equal(body[at(55, 43)], 1, 'five pixels from the block is still a stub');
    assert.equal(body[at(54, 43)], 0);
    assert.equal(thin[at(54, 43)], 1);
});

test('letters cut out of the body do not make the strips between them thin parts', () => {
    // The strip between the two holes is 5 pixels wide, thinner than the 11 pixel window, so an opening on the raw picture would cut it away.
    const raster = draw([[40, 10, 120, 90]]);
    for (const [x0, x1] of [[60, 72], [77, 90]]) {
        for (let y = 30; y < 70; y++) {
            for (let x = x0; x < x1; x++) {
                setPixel(raster, x, y, [0, 0, 0, 0]);
            }
        }
    }
    const raw = openMask(opaqueMask(raster), WIDTH, HEIGHT, 5);
    assert.equal(raw[at(74, 50)], 0, 'the plain opening does lose the strip');
    const { core, body, thin, mask } = splitThinParts(raster, { thinWidth: 11 });
    assert.equal(core[at(74, 50)], 1);
    assert.equal(body[at(74, 50)], 1);
    assert.equal(thin[at(74, 50)], 0);
    assert.equal(mask[at(65, 50)], 0, 'the holes themselves stay transparent');
    assert.equal(body[at(65, 50)], 0);
    assert.equal(count(thin), 0, 'nothing of the block is taken for a line');
});

test('a thin width that is not a whole number of 3 or more, or a picture with nothing thick, is refused', () => {
    assert.throws(() => splitThinParts(draw(PARTS), { thinWidth: 2.5 }), /whole number/);
    assert.throws(() => splitThinParts(draw(PARTS), { thinWidth: 2 }), /whole number/);
    assert.throws(() => splitThinParts(draw([[0, 10, 160, 14]]), { thinWidth: 9 }), /Nothing is thicker/);
});

test('each pixel gets the length of the unbroken stretch of shape through it along its row or its column', () => {
    // ##.###
    // #..#..
    const mask = Uint8Array.from([1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0]);
    assert.deepEqual([...runLengths(mask, 6, 2, true)], [2, 2, 0, 3, 3, 3, 1, 0, 0, 1, 0, 0]);
    assert.deepEqual([...runLengths(mask, 6, 2, false)], [2, 1, 0, 2, 1, 1, 2, 0, 0, 2, 0, 0]);
});
