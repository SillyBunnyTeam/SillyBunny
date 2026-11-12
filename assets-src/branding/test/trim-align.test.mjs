import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trimAlign } from '../scripts/lib/trim-align.mjs';
import { opaqueBox } from '../scripts/lib/raster.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

/** A 20x20 frame with a w x h block of one colour whose top-left is at (x, y). */
function frame(x, y, w, h, colour = [200, 40, 50]) {
    const raster = createRaster(20, 20);
    for (let row = y; row < y + h; row++) {
        for (let column = x; column < x + w; column++) {
            setPixel(raster, column, row, colour);
        }
    }
    return raster;
}

const canvas = { width: 32, height: 32 };

test('every image is trimmed and placed on the canvas with its feet on one baseline and its box centred', async () => {
    const results = await trimAlign([frame(3, 2, 6, 10), frame(5, 4, 8, 14), frame(0, 0, 4, 4)], { canvas, baseline: 2 });
    assert.equal(results.length, 3);
    for (const { raster, placement } of results) {
        assert.deepEqual([raster.width, raster.height], [32, 32]);
        const box = opaqueBox(raster);
        assert.equal(box.y + box.height, 32 - 2, 'the bottom edge is on the baseline');
        assert.equal(box.x, Math.floor((32 - box.width) / 2));
        assert.deepEqual({ x: placement.x, y: placement.y }, { x: box.x, y: box.y });
    }
    assert.deepEqual(results.map(({ placement }) => [placement.width, placement.height]), [[6, 10], [8, 14], [4, 4]]);
    assert.deepEqual(getPixel(results[0].raster, results[0].placement.x, results[0].placement.y), [200, 40, 50, 255], 'the pixels are copied, not resampled');
});

test('padding keeps the sprite away from every canvas edge, and the baseline defaults to the padding', async () => {
    const [{ raster }] = await trimAlign([frame(2, 2, 6, 10)], { canvas, pad: 4 });
    const box = opaqueBox(raster);
    assert.equal(box.y + box.height, 32 - 4);
    await assert.rejects(trimAlign([frame(0, 0, 20, 20)], { canvas: { width: 26, height: 26 }, pad: 4 }), /does not fit/);
});

test('centroid alignment centres the weight of the sprite, not its box', async () => {
    const lopsided = createRaster(20, 20);
    for (let y = 2; y < 12; y++) {
        for (let x = 2; x < 12; x++) {
            setPixel(lopsided, x, y, x < 4 || y > 3 ? [200, 40, 50] : [0, 0, 0, 0]);
        }
    }
    setPixel(lopsided, 13, 2, [200, 40, 50]);
    const [bbox] = await trimAlign([lopsided], { canvas, alignX: 'bbox' });
    const [centroid] = await trimAlign([lopsided], { canvas, alignX: 'centroid' });
    assert.notEqual(bbox.placement.x, centroid.placement.x);
    assert.ok(centroid.placement.x > bbox.placement.x, 'the thin right-hand tip widens the box but holds no weight, so centring the weight moves the box right');
});

test('locking to the first image keeps how the frames sit relative to each other, such as an ear that moves', async () => {
    const [first, second] = await trimAlign([frame(5, 6, 6, 10), frame(8, 4, 6, 12)], { canvas, lock: 'first' });
    assert.equal(second.placement.x - first.placement.x, 3);
    assert.equal(second.placement.y - first.placement.y, -2);
    assert.equal(first.placement.y + first.placement.height, 32);
    const [lonely] = await trimAlign([frame(5, 6, 6, 10)], { canvas, lock: 'first', baseline: 2 });
    assert.equal(lonely.placement.y + lonely.placement.height, 30);
});

test('scale fit magnifies every image by one common factor so their relative sizes stay, and nearest keeps pixels sharp', async () => {
    const small = frame(0, 0, 4, 6, [10, 200, 10]);
    const tall = frame(0, 0, 4, 12, [200, 10, 10]);
    const results = await trimAlign([small, tall], { canvas: { width: 40, height: 40 }, scale: 'fit', nearest: true });
    assert.deepEqual(results.map(({ scale }) => scale), [3, 3]);
    assert.deepEqual(results.map(({ placement }) => [placement.width, placement.height]), [[12, 18], [12, 36]]);
    const box = opaqueBox(results[1].raster);
    assert.deepEqual(getPixel(results[1].raster, box.x + 5, box.y + 5), [200, 10, 10, 255], 'a block of pixels is one colour with nearest-neighbour scaling');
});

test('no scale option means no resampling: an image that is too big is an error that says so', async () => {
    await assert.rejects(trimAlign([frame(0, 0, 20, 20)], { canvas: { width: 16, height: 16 } }), /20x20.*does not fit the 16x16 canvas.*scale fit/);
});

test('an image with nothing opaque is an error naming its position', async () => {
    await assert.rejects(trimAlign([frame(1, 1, 3, 3), createRaster(20, 20)], { canvas }), /image 2 has nothing opaque/);
});

test('bad options are errors', async () => {
    await assert.rejects(trimAlign([], { canvas }), /no images/);
    await assert.rejects(trimAlign([frame(1, 1, 3, 3)], { canvas, alignX: 'left' }), /alignX/);
    await assert.rejects(trimAlign([frame(1, 1, 3, 3)], { canvas, lock: 'last' }), /lock/);
    await assert.rejects(trimAlign([frame(1, 1, 3, 3)], { canvas, scale: 'double' }), /scale/);
});
