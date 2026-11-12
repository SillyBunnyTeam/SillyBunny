import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectGrid } from '../scripts/lib/pixel-grid.mjs';
import { addNoise, blur, createRaster, nativeSprite, setPixel, upscale } from '../test-support/synthetic.mjs';

const COLOURS = [[200, 40, 50], [40, 60, 200], [230, 210, 90], [60, 160, 90], [250, 250, 250]];
const sprite = nativeSprite(24, 24, COLOURS);
const wholeBox = (raster) => ({ x: 0, y: 0, width: raster.width, height: raster.height });

test('a clean 8x enlargement is detected as an 8 pixel cell with the grid at the origin', () => {
    const big = upscale(sprite, 8);
    const found = detectGrid(big, wholeBox(big), { minCell: 3, maxCell: 40 });
    assert.ok(Math.abs(found.cell - 8) < 0.05, `cell ${found.cell}`);
    assert.ok(Math.min(found.offsetX, 8 - found.offsetX) < 0.6 && Math.min(found.offsetY, 8 - found.offsetY) < 0.6);
    assert.ok(found.strength > 0.4, `strength ${found.strength}`);
});

test('a grid that starts mid-image (the picture is shifted by 3 pixels) gets that offset back', () => {
    const big = upscale(sprite, 8, { offsetX: 3, offsetY: 5 });
    const found = detectGrid(big, wholeBox(big), { minCell: 3, maxCell: 40 });
    assert.ok(Math.abs(found.cell - 8) < 0.05);
    assert.ok(Math.abs(found.offsetX - 3) < 0.6, `offsetX ${found.offsetX}`);
    assert.ok(Math.abs(found.offsetY - 5) < 0.6, `offsetY ${found.offsetY}`);
});

test('a fractional cell (10.24 pixels per cell, as a model that resamples its canvas leaves) is found', () => {
    const big = upscale(sprite, 10.24);
    const found = detectGrid(big, wholeBox(big), { minCell: 6, maxCell: 16 });
    assert.ok(Math.abs(found.cell - 10.24) < 0.04, `cell ${found.cell}`);
});

test('noise and softened edges lower the strength but keep the cell', () => {
    const clean = upscale(sprite, 8);
    const messy = blur(addNoise(clean, 10));
    const cleanFound = detectGrid(clean, wholeBox(clean), { minCell: 3, maxCell: 40 });
    const found = detectGrid(messy, wholeBox(messy), { minCell: 3, maxCell: 40 });
    assert.ok(Math.abs(found.cell - 8) < 0.06, `cell ${found.cell}`);
    assert.ok(found.strength < cleanFound.strength && found.strength > 0.25);
});

test('the search window decides between a cell and its multiples: only that range is searched', () => {
    const big = upscale(sprite, 8);
    const found = detectGrid(big, wholeBox(big), { minCell: 14, maxCell: 18 });
    assert.ok(Math.abs(found.cell - 16) < 0.1 || found.strength < 0.45, 'a window with no 8 pixel cell cannot return one');
    assert.ok(found.cell >= 14 && found.cell <= 18);
    assert.ok(found.strength < 0.45, 'and it is not mistaken for a clean grid');
});

test('a flat picture or smooth gradient has no grid: the strength is near zero', () => {
    const flat = createRaster(200, 200, [120, 130, 140, 255]);
    assert.equal(detectGrid(flat, wholeBox(flat), { minCell: 4, maxCell: 20 }).strength, 0);
    const gradient = createRaster(200, 200);
    for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 200; x++) {
            setPixel(gradient, x, y, [x, y, 128]);
        }
    }
    assert.ok(detectGrid(gradient, wholeBox(gradient), { minCell: 4, maxCell: 20 }).strength < 0.25);
});

test('transparent padding around a sprite does not matter when the box is its bounds', () => {
    const framed = upscale(sprite, 8, { offsetX: 100, offsetY: 60, canvas: { width: 500, height: 400 } });
    const found = detectGrid(framed, { x: 100, y: 60, width: 24 * 8, height: 24 * 8 }, { minCell: 3, maxCell: 40 });
    assert.ok(Math.abs(found.cell - 8) < 0.05);
    assert.ok(Math.min(found.offsetX, 8 - found.offsetX) < 0.6, 'offsets are relative to the box');
});

test('a bad search window is an error', () => {
    const big = upscale(sprite, 8);
    assert.throws(() => detectGrid(big, wholeBox(big), { minCell: 20, maxCell: 10 }), /minCell/);
    assert.throws(() => detectGrid(big, { x: 0, y: 0, width: 0, height: 5 }, { minCell: 3, maxCell: 8 }), /empty/);
});
