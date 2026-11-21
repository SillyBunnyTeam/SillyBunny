import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { renderVariantSheet, zoomBox } from '../scripts/lib/export-sheets.mjs';
import { createRaster, setPixel } from '../test-support/synthetic.mjs';

const RED = [200, 40, 50];
const BLUE = [40, 60, 200];
const layout = { labelWidth: 100, gap: 10, zoom: 4, window: 8 };

/** A 20 by 12 picture, blue with one red pixel at (10, 6). */
function picture() {
    const raster = createRaster(20, 12, [...BLUE, 255]);
    setPixel(raster, 10, 6, RED);
    return raster;
}

const pixelOf = async (png, x, y) => {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (y * info.width + x) * 4;
    return [...data.subarray(at, at + 3)];
};

test('the zoom window is centred on the focus, kept inside the picture, and never larger than the picture', () => {
    assert.deepEqual(zoomBox(picture(), [0.5, 0.5], 8), { x: 6, y: 2, width: 8, height: 8 });
    assert.deepEqual(zoomBox(picture(), [0, 0], 8), { x: 0, y: 0, width: 8, height: 8 });
    assert.deepEqual(zoomBox(picture(), [1, 1], 8), { x: 12, y: 4, width: 8, height: 8 });
    assert.deepEqual(zoomBox(createRaster(6, 5), [0.5, 0.5], 8), { x: 1, y: 0, width: 5, height: 5 });
});

test('each row has a label, the picture at its own pixels, and its zoom, and the sheet is as big as its rows', async () => {
    const entries = [
        { lines: ['a@8x1', '20x12', '1.0 KB'], raster: picture(), focus: [0.5, 0.5] },
        { lines: ['a@8x2'], raster: createRaster(10, 40, [...RED, 255]), focus: [0.5, 0.5] },
    ];
    const sheet = await renderVariantSheet(entries, layout);
    const { width, height } = await sharp(sheet).metadata();
    // columns: gap, label 100, gap, widest picture 20, gap, widest zoom (8 x 4 = 32; the 10 wide picture's window is 8), gap
    assert.equal(width, 10 + 100 + 10 + 20 + 10 + 32 + 10);
    // rows: the first is 32 tall (its zoom), the second 40 (its picture)
    assert.equal(height, 10 + 32 + 10 + 40 + 10);
});

test('the picture is placed unscaled and the zoom is a nearest-neighbour enlargement of the window round the focus', async () => {
    const sheet = await renderVariantSheet([{ lines: ['x'], raster: picture(), focus: [0.5, 0.5] }], layout);
    const tileX = 10 + 100 + 10;
    const zoomX = tileX + 20 + 10;
    assert.deepEqual(await pixelOf(sheet, tileX + 10, 10 + 6), RED, 'the red pixel is where it is in the picture');
    assert.deepEqual(await pixelOf(sheet, tileX, 10), BLUE);
    // the window starts at (6, 2), so the red pixel (10, 6) is at (4, 4) in it, a 4 by 4 block of 16 in the zoom
    assert.deepEqual(await pixelOf(sheet, zoomX + 16, 10 + 16), RED);
    assert.deepEqual(await pixelOf(sheet, zoomX + 19, 10 + 19), RED);
    assert.deepEqual(await pixelOf(sheet, zoomX + 20, 10 + 16), BLUE);
});

test('a sheet with no rows is refused', async () => {
    await assert.rejects(renderVariantSheet([], layout), /nothing/);
});

test('a nearest-neighbour enlargement copies each pixel into a square block and refuses a factor that is not a whole number', async () => {
    const { upscaleNearest } = await import('../scripts/lib/raster.mjs');
    const big = upscaleNearest(picture(), 3);
    assert.deepEqual([big.width, big.height], [60, 36]);
    const at = (x, y) => [...big.data.subarray((y * big.width + x) * 4, (y * big.width + x) * 4 + 3)];
    assert.deepEqual([at(30, 18), at(32, 20), at(33, 18)], [RED, RED, BLUE]);
    assert.throws(() => upscaleNearest(picture(), 1.5), /whole number/);
});
