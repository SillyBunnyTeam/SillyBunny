import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRaster, crop, hasBinaryAlpha, isOpaque, opaqueBox, paste, samePixels, upscaleNearest } from '../lib/raster.js';
import { paint, pixelAt } from '../test-support/pictures.js';

const RED = [200, 10, 10, 255];
const CLEAR = [0, 0, 0, 0];

test('the opaque box holds every pixel at or above the alpha, and there is none in an empty picture', () => {
    const picture = paint(6, 5, (x, y) => ((x === 2 && y === 1) || (x === 4 && y === 3) ? RED : CLEAR));

    assert.deepEqual(opaqueBox(picture), { x: 2, y: 1, width: 3, height: 3 });
    assert.equal(opaqueBox(createRaster(3, 3)), undefined);
});

test('a paste skips transparent source pixels and pixels outside the target', () => {
    const target = paint(3, 3, () => [1, 2, 3, 255]);
    const source = paint(2, 2, (x) => (x === 0 ? RED : CLEAR));

    paste(target, source, 2, 0);

    assert.deepEqual(pixelAt(target, 2, 0), RED);
    assert.deepEqual(pixelAt(target, 2, 1), RED);
    assert.deepEqual(pixelAt(target, 1, 0), [1, 2, 3, 255]);
});

test('a crop keeps the channel count of its picture', () => {
    const picture = paint(4, 4, (x, y) => [x, y, 0, 255], 3);

    const cut = crop(picture, { x: 1, y: 2, width: 2, height: 2 });

    assert.equal(cut.channels, 3);
    assert.deepEqual(pixelAt(cut, 1, 1), [2, 3, 0, 255]);
});

test('a nearest enlargement copies each pixel into a whole block and refuses a fraction', () => {
    const picture = paint(2, 1, (x) => (x === 0 ? RED : CLEAR));

    const big = upscaleNearest(picture, 3);

    assert.deepEqual([big.width, big.height], [6, 3]);
    assert.deepEqual(pixelAt(big, 2, 2), RED);
    assert.deepEqual(pixelAt(big, 3, 0), CLEAR);
    assert.throws(() => upscaleNearest(picture, 1.5), /whole number/);
});

test('binary alpha and opacity are told apart', () => {
    assert.equal(hasBinaryAlpha(paint(2, 2, (x) => (x ? RED : CLEAR))), true);
    assert.equal(hasBinaryAlpha(paint(2, 2, () => [9, 9, 9, 128])), false);
    assert.equal(isOpaque(paint(2, 2, () => RED)), true);
    assert.equal(isOpaque(paint(2, 2, (x) => (x ? RED : CLEAR))), false);
});

test('the same pixels ignore the colour under a transparent pixel and nothing else', () => {
    const one = paint(2, 1, (x) => (x ? RED : [5, 5, 5, 0]));
    const two = paint(2, 1, (x) => (x ? RED : [9, 9, 9, 0]));
    const three = paint(2, 1, (x) => (x ? [200, 10, 11, 255] : CLEAR));

    assert.equal(samePixels(one, two), true);
    assert.equal(samePixels(one, three), false);
    assert.equal(samePixels(one, paint(1, 2, () => RED)), false);
});
