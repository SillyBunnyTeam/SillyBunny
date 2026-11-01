import assert from 'node:assert/strict';
import sharp from 'sharp';
import { test } from 'node:test';
import { drawGrid } from '../scripts/lib/grid-image.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const png = (raster) => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png().toBuffer();
const decode = async (bytes) => {
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
};

async function plain() {
    const raster = createRaster(400, 300, [240, 236, 250, 255]);
    setPixel(raster, 150, 150, [200, 30, 30]);
    return png(raster);
}

test('the gridded copy keeps the size, draws lines on the step and leaves the cells between them as they were', async () => {
    const source = await decode(await plain());
    const grid = await decode(await drawGrid(await plain(), { step: 100 }));
    assert.deepEqual([grid.width, grid.height], [400, 300]);
    const differs = (x, y) => getPixel(grid, x, y).join() !== getPixel(source, x, y).join();
    for (const x of [100, 200, 300]) {
        assert.ok(differs(x, 190), `no line at x=${x}`);
    }
    for (const y of [100, 200]) {
        assert.ok(differs(350, y), `no line at y=${y}`);
    }
    assert.ok(!differs(150, 150) && !differs(140, 230) && !differs(250, 170), 'cells between the lines are untouched');
});

test('a crop with a zoom draws the same step in source pixels and the output is the crop times the zoom', async () => {
    const zoomed = await decode(await drawGrid(await plain(), { step: 20, crop: { x: 100, y: 100, width: 100, height: 80 }, zoom: 3 }));
    assert.deepEqual([zoomed.width, zoomed.height], [300, 240]);
    // The source pixel x=120 is the first line inside the crop, so it sits at (120 - 100) * 3 in the output.
    const baseline = await decode(await sharp(await plain()).extract({ left: 100, top: 100, width: 100, height: 80 }).resize(300, 240, { kernel: 'lanczos3' }).png().toBuffer());
    assert.notDeepEqual(getPixel(zoomed, 60, 200), getPixel(baseline, 60, 200));
    assert.deepEqual(getPixel(zoomed, 100, 200), getPixel(baseline, 100, 200), 'between two lines the zoomed crop is the plain enlargement');
});

test('a bad step, zoom or crop is an error', async () => {
    const bytes = await plain();
    await assert.rejects(drawGrid(bytes, { step: 0 }), /step/);
    await assert.rejects(drawGrid(bytes, { step: 50, zoom: 0 }), /zoom/);
    await assert.rejects(drawGrid(bytes, { step: 50, crop: { x: 350, y: 0, width: 100, height: 100 } }), /outside the 400x300 image/);
});
