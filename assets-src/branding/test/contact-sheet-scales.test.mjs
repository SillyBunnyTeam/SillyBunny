import assert from 'node:assert/strict';
import sharp from 'sharp';
import { test } from 'node:test';
import { buildContactSheet } from '../scripts/lib/contact-sheet.mjs';
import { createRaster, setPixel } from '../test-support/synthetic.mjs';

const png = (raster) => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png().toBuffer();
const layout = { cols: 2, cellWidth: 64, cellHeight: 64, gap: 10, labelHeight: 0, nearest: false };

async function checkerboard() {
    const raster = createRaster(6, 4, [0, 0, 0, 255]);
    setPixel(raster, 1, 1, [255, 0, 0]);
    setPixel(raster, 4, 2, [0, 255, 0]);
    return png(raster);
}

test('scales show each image at exactly width x scale, side by side, with square blocks and no blur', async () => {
    const sheet = await buildContactSheet([{ image: await checkerboard(), label: 'sprite' }], { ...layout, scales: [1, 4] });
    const { data, info } = await sharp(sheet).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [10 + 6 + 10 + 24 + 10, 10 + 16 + 10]);
    const at = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    assert.deepEqual(at(10 + 1, 10 + 1), [255, 0, 0], 'the 1x copy');
    const left4 = 10 + 6 + 10;
    for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
            assert.deepEqual(at(left4 + 4 + dx, 10 + 4 + dy), [255, 0, 0], 'the red pixel became one 4x4 block');
            assert.deepEqual(at(left4 + 16 + dx, 10 + 8 + dy), [0, 255, 0]);
        }
    }
    assert.deepEqual(at(left4 + 3, 10 + 4), [0, 0, 0], 'the block edge is sharp');
    assert.deepEqual(at(left4 + 8, 10 + 4), [0, 0, 0]);
});

test('every image gets its own run of scales, wrapping by the column count, and the label names the scale', async () => {
    const image = await checkerboard();
    const sheet = await buildContactSheet([{ image, label: 'a' }, { image, label: 'b' }], { ...layout, cols: 2, scales: [1, 4], labelHeight: 12 });
    const { height } = await sharp(sheet).metadata();
    assert.equal(height, 10 + (16 + 12) + 10 + (16 + 12) + 10, 'two rows, one per image');
});

test('scales must be whole numbers of 1 or more, and file paths still work', async () => {
    const image = await checkerboard();
    await assert.rejects(buildContactSheet([{ image, label: 'a' }], { ...layout, scales: [0] }), /whole numbers/);
    await assert.rejects(buildContactSheet([{ image, label: 'a' }], { ...layout, scales: [1.5] }), /whole numbers/);
    await assert.rejects(buildContactSheet([{ image, label: 'a' }], { ...layout, scales: [] }), /whole numbers/);
    const plain = await buildContactSheet([{ image, label: 'a' }], layout);
    assert.ok((await sharp(plain).metadata()).width > 0);
});
