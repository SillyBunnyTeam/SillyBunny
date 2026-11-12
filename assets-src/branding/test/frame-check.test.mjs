import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artBoxInside, artMaskOf, checkMaskedFrame } from '../scripts/lib/frame-check.mjs';
import { createRaster, setPixel } from '../test-support/synthetic.mjs';

const GRID = { cell: 4, offset: { x: 2, y: 2 } };
const ART = { width: 20, height: 20 };
const MASTER_WIDTH = 82;

/** A master-pixel mask with one rectangle in it. */
function maskOf(x0, y0, x1, y1) {
    const mask = new Uint8Array(MASTER_WIDTH * 82);
    for (let y = y0; y < y1; y++) {
        mask.fill(1, y * MASTER_WIDTH + x0, y * MASTER_WIDTH + x1);
    }
    return mask;
}

const picture = () => {
    const raster = createRaster(ART.width, ART.height);
    for (let y = 0; y < ART.height; y++) {
        for (let x = 0; x < ART.width; x++) {
            setPixel(raster, x, y, [30, 60, 90, 255]);
        }
    }
    return raster;
};

test('an art pixel is in the mask when its cell on the grid holds a pixel of the mask, and a box counts only the art pixels that are wholly in it', () => {
    const marked = artMaskOf(maskOf(10, 10, 12, 12), MASTER_WIDTH, GRID, ART);
    assert.equal(marked.reduce((total, value) => total + value, 0), 1);
    assert.equal(marked[2 * ART.width + 2], 1, 'master pixel 10,10 is in the cell 2,2 (pixels 10 to 13)');
    assert.deepEqual(artBoxInside({ x: 10, y: 10, width: 20, height: 12 }, GRID, ART), { x: 2, y: 2, width: 5, height: 3 });
    assert.equal(artBoxInside({ x: 10, y: 10, width: 3, height: 3 }, GRID, ART), undefined, 'a box smaller than a cell holds none');
});

test('a frame that changed only inside the mask passes and says what changed, as a box, and how the kept parts fared', () => {
    const base = picture();
    const frame = picture();
    setPixel(frame, 5, 5, [200, 0, 0, 255]);
    setPixel(frame, 6, 5, [200, 0, 0, 255]);
    const result = checkMaskedFrame({ base, frame, cut: maskOf(18, 18, 30, 30), masterWidth: MASTER_WIDTH, grid: GRID, keep: [{ name: 'legs', box: { x: 50, y: 50, width: 28, height: 28 } }], margin: 1 });
    assert.equal(result.changed, 2);
    assert.deepEqual(result.box, { x: 5, y: 5, width: 2, height: 1 });
    assert.deepEqual(result.masterBox, { x: 22, y: 22, width: 8, height: 4 });
    assert.deepEqual(result.keep, [{ name: 'legs', box: { x: 12, y: 12, width: 7, height: 7 }, pixels: 49, changed: 0 }]);
});

test('a change outside the mask grown by the margin is refused with where it is, and a change inside a kept part is refused with its name', () => {
    const base = picture();
    const frame = picture();
    setPixel(frame, 5, 5, [200, 0, 0, 255]);
    setPixel(frame, 15, 15, [200, 0, 0, 255]);
    assert.throws(() => checkMaskedFrame({ base, frame, cut: maskOf(18, 18, 30, 30), masterWidth: MASTER_WIDTH, grid: GRID, keep: [], margin: 1 }), /1 of the 2 art pixels that changed lie outside the mask grown by 1 art px: they are in 1x1 at 15,15/);
    const legs = [{ name: 'legs', box: { x: 50, y: 50, width: 28, height: 28 } }];
    assert.throws(() => checkMaskedFrame({ base, frame, cut: maskOf(18, 18, 30, 30), masterWidth: MASTER_WIDTH, grid: GRID, keep: legs, margin: 13 }), /the kept part "legs" changed in 1 of its 49 art px/);
    setPixel(frame, 15, 15, [30, 60, 90, 255]);
    setPixel(frame, 12, 12, [200, 0, 0, 255]);
    assert.throws(() => checkMaskedFrame({ base, frame, cut: maskOf(18, 18, 30, 30), masterWidth: MASTER_WIDTH, grid: GRID, keep: legs, margin: 13 }), /kept part "legs" changed in 1 of its 49/, 'the first pixel of the box counts');
});

test('a frame that changed nothing is refused', () => {
    assert.throws(() => checkMaskedFrame({ base: picture(), frame: picture(), cut: maskOf(18, 18, 30, 30), masterWidth: MASTER_WIDTH, grid: GRID, keep: [], margin: 1 }), /no art pixel changed/);
});
