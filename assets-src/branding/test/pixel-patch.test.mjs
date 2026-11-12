import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPixelPatch, offPaletteColours, parsePixelPatch } from '../scripts/lib/pixel-patch.mjs';
import { applyOrphanFixes, findOrphans, orphansToPatch } from '../scripts/lib/pixelate.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const size = { width: 8, height: 6 };

test('points and rectangles parse to one shape, with hex colours and transparent', () => {
    const ops = parsePixelPatch([{ x: 1, y: 2, color: '#FF0000' }, { x: 2, y: 3, w: 3, h: 2, color: 'transparent' }], size);
    assert.deepEqual(ops, [
        { x: 1, y: 2, width: 1, height: 1, rgba: [255, 0, 0, 255] },
        { x: 2, y: 3, width: 3, height: 2, rgba: [0, 0, 0, 0] },
    ]);
});

test('every kind of mistake is an error that names the edit', () => {
    for (const [bad, message] of [
        [{}, /list of edits/],
        [[], /at least one edit/],
        [[{ x: 1, y: 1 }], /edit 1: color/],
        [[{ x: 1, y: 1, color: 'red' }], /edit 1: color "red"/],
        [[{ x: 1.5, y: 1, color: '#000000' }], /edit 1: x and y must be whole numbers/],
        [[{ x: 8, y: 0, color: '#000000' }], /edit 1: .* outside the 8x6 picture/],
        [[{ x: -1, y: 0, color: '#000000' }], /outside/],
        [[{ x: 6, y: 5, w: 3, h: 1, color: '#000000' }], /outside the 8x6 picture/],
        [[{ x: 0, y: 0, w: 0, h: 1, color: '#000000' }], /w and h must be whole numbers of 1 or more/],
        [[{ x: 0, y: 0, w: 2, color: '#000000' }], /give both w and h/],
        [[{ x: 0, y: 0, colour: '#000000', color: '#000000' }], /unknown key "colour"/],
    ]) {
        assert.throws(() => parsePixelPatch(bad, size), message);
    }
});

test('edits apply in order onto a copy, and the count says how many pixels really changed', () => {
    const raster = createRaster(8, 6, [10, 20, 30, 255]);
    const ops = parsePixelPatch([{ x: 0, y: 0, w: 3, h: 1, color: '#ff0000' }, { x: 1, y: 0, color: '#00ff00' }, { x: 7, y: 5, color: '#0a141e' }], size);
    const { raster: fixed, changed } = applyPixelPatch(raster, ops);
    assert.deepEqual(getPixel(fixed, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(getPixel(fixed, 1, 0), [0, 255, 0, 255], 'a later edit wins');
    assert.deepEqual(getPixel(fixed, 2, 0), [255, 0, 0, 255]);
    assert.deepEqual(getPixel(raster, 0, 0), [10, 20, 30, 255], 'the input is not changed');
    assert.equal(changed, 3, 'the last edit set a pixel to the colour it already had');
});

test('transparent clears a pixel to alpha 0', () => {
    const raster = createRaster(8, 6, [10, 20, 30, 255]);
    const { raster: fixed } = applyPixelPatch(raster, parsePixelPatch([{ x: 2, y: 2, color: 'transparent' }], size));
    assert.deepEqual(getPixel(fixed, 2, 2), [0, 0, 0, 0]);
});

test('colours outside the palette are listed, and transparent never counts', () => {
    const ops = parsePixelPatch([{ x: 0, y: 0, color: '#ff0000' }, { x: 1, y: 0, color: '#123456' }, { x: 2, y: 0, color: 'transparent' }, { x: 3, y: 0, color: '#123456' }], size);
    assert.deepEqual(offPaletteColours(ops, [[255, 0, 0]]), ['#123456']);
    assert.deepEqual(offPaletteColours(ops, [[255, 0, 0], [0x12, 0x34, 0x56]]), []);
});

test('the patch pixelate writes for its orphans does exactly what applying the fixes does', () => {
    const picture = createRaster(10, 10);
    for (let y = 2; y < 8; y++) {
        for (let x = 2; x < 8; x++) {
            setPixel(picture, x, y, [200, 40, 50]);
        }
    }
    setPixel(picture, 4, 4, [40, 60, 200]);
    setPixel(picture, 9, 9, [200, 40, 50]);
    const orphans = findOrphans(picture);
    const viaPatch = applyPixelPatch(picture, parsePixelPatch(orphansToPatch(orphans), picture)).raster;
    assert.deepEqual(viaPatch.data, applyOrphanFixes(picture, orphans).data);
});
