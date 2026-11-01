import assert from 'node:assert/strict';
import sharp from 'sharp';
import { test } from 'node:test';
import { buildPatchRequest, chooseRequestSize, compositeOnto, differenceReport, extractPatchResult, parsePatchSpec, sampleBorderColour } from '../scripts/lib/patch.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const BACKGROUND = [240, 236, 250];

/** 300x200 lavender page with a skin-coloured block, hair, and a red marker the tests move around. */
function page() {
    const raster = createRaster(300, 200, [...BACKGROUND, 255]);
    for (let y = 40; y < 160; y++) {
        for (let x = 90; x < 210; x++) {
            setPixel(raster, x, y, (x + y) % 11 < 5 ? [250, 220, 200] : [60, 40, 90]);
        }
    }
    for (let y = 90; y < 100; y++) {
        for (let x = 100; x < 110; x++) {
            setPixel(raster, x, y, [220, 30, 30]);
        }
    }
    return raster;
}

const decode = async (bytes) => {
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
};
const centroidOf = (raster, test) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
            if (test(getPixel(raster, x, y))) {
                sx += x;
                sy += y;
                n++;
            }
        }
    }
    return { x: sx / n, y: sy / n, n };
};
const isRed = ([r, g, b]) => r > 180 && g < 90 && b < 90;

test('the request size is whichever of the three supported sizes magnifies the crop most', () => {
    assert.deepEqual(chooseRequestSize(100, 100), { size: '1024x1024', width: 1024, height: 1024, scale: 10.24, tooSmall: false });
    assert.equal(chooseRequestSize(300, 200).size, '1536x1024');
    assert.equal(chooseRequestSize(200, 300).size, '1024x1536');
    assert.equal(chooseRequestSize(1000, 1000).size, '1024x1024');
    const big = chooseRequestSize(3000, 1000);
    assert.equal(big.size, '1536x1024');
    assert.ok(big.scale < 1, 'a crop bigger than the request is scaled down to fit');
    assert.equal(chooseRequestSize(60, 60).tooSmall, true);
    assert.equal(chooseRequestSize(120, 120).tooSmall, false);
});

test('the border colour is the median of the crop\'s outer ring, so a stray mark on the border does not move it', () => {
    const raster = page();
    for (let x = 100; x < 104; x++) {
        setPixel(raster, x, 20, [0, 0, 0]);
    }
    assert.deepEqual(sampleBorderColour(raster, { x: 80, y: 20, width: 140, height: 160 }), BACKGROUND);
    assert.deepEqual(sampleBorderColour(raster, { x: 0, y: 0, width: 300, height: 200 }), BACKGROUND);
});

test('the request image is the Lanczos-scaled crop centred on a canvas padded with the border colour', async () => {
    const raster = page();
    const crop = { x: 80, y: 30, width: 140, height: 120 };
    const request = await buildPatchRequest(raster, crop);
    assert.equal(request.size, '1536x1024');
    const image = await decode(request.png);
    assert.deepEqual([image.width, image.height], [1536, 1024]);
    const { left, top, width, height } = request.placement;
    assert.equal(width, Math.round(140 * request.scale));
    assert.equal(height, Math.round(120 * request.scale));
    assert.equal(left, Math.floor((1536 - width) / 2));
    assert.equal(top, Math.floor((1024 - height) / 2));
    assert.deepEqual(getPixel(image, 2, 2).slice(0, 3), BACKGROUND);
    assert.deepEqual(getPixel(image, 1533, 1021).slice(0, 3), BACKGROUND);
    assert.deepEqual(request.background, BACKGROUND);
});

test('an unchanged result scales back to the crop with the marker on the same pixel, for centre and edge crops alike', async () => {
    const raster = page();
    for (const crop of [{ x: 80, y: 30, width: 140, height: 120 }, { x: 0, y: 0, width: 130, height: 110 }, { x: 170, y: 80, width: 130, height: 120 }]) {
        const request = await buildPatchRequest(raster, crop);
        const back = await extractPatchResult(request.png, request, crop);
        assert.deepEqual([back.raster.width, back.raster.height], [crop.width, crop.height]);
        assert.deepEqual(back.warnings, []);
        const inCrop = (x, y) => x >= crop.x && y >= crop.y && x < crop.x + crop.width && y < crop.y + crop.height;
        if (inCrop(105, 95)) {
            const marker = centroidOf(back.raster, isRed);
            assert.ok(Math.abs(marker.x + crop.x - 104.5) < 0.6 && Math.abs(marker.y + crop.y - 94.5) < 0.6, `marker at ${marker.x + crop.x}, ${marker.y + crop.y}`);
        }
        const report = differenceReport(await extractCrop(raster, crop), back.raster, []);
        assert.ok(report.inside < 12, `round trip difference ${report.inside}`);
    }
});

async function extractCrop(raster, crop) {
    const { data, info } = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
}

test('a result of the wrong size is scaled to the request size first, with a warning; a wrong shape is an error', async () => {
    const raster = page();
    const crop = { x: 80, y: 30, width: 140, height: 120 };
    const request = await buildPatchRequest(raster, crop);
    const half = await sharp(request.png).resize(768, 512).png().toBuffer();
    const back = await extractPatchResult(half, request, crop);
    assert.deepEqual([back.raster.width, back.raster.height], [140, 120]);
    assert.match(back.warnings[0], /768x512 instead of 1536x1024/);
    const square = await sharp(request.png).resize(1024, 1024, { fit: 'fill' }).png().toBuffer();
    await assert.rejects(extractPatchResult(square, request, crop), /shape/);
});

test('compositing changes only the composite rects: outside them every byte equals the source, inside the middle is the new pixels', () => {
    const source = page();
    const original = Buffer.from(source.data);
    const patchRaster = createRaster(140, 120, [10, 200, 10, 255]);
    const crop = { x: 80, y: 30, width: 140, height: 120 };
    const target = { ...source, data: Buffer.from(source.data) };
    compositeOnto(target, patchRaster, crop, [{ x: 100, y: 50, width: 40, height: 30 }, { x: 160, y: 100, width: 20, height: 20 }], 6);
    const inRects = (x, y) => (x >= 100 && x < 140 && y >= 50 && y < 80) || (x >= 160 && x < 180 && y >= 100 && y < 120);
    for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 300; x++) {
            if (!inRects(x, y)) {
                assert.deepEqual(getPixel(target, x, y), getPixel({ ...source, data: original }, x, y), `pixel ${x},${y} outside the rects changed`);
            }
        }
    }
    assert.deepEqual(getPixel(target, 120, 65), [10, 200, 10, 255]);
    const sourceAt = (x) => getPixel({ ...source, data: original }, x, 65);
    for (let depth = 0; depth <= 6; depth++) {
        const weight = (depth + 1) / 7;
        const expected = [0, 1, 2].map((c) => Math.round(sourceAt(100 + depth)[c] * (1 - weight) + [10, 200, 10][c] * weight));
        assert.deepEqual(getPixel(target, 100 + depth, 65).slice(0, 3), expected, `feather ramp at depth ${depth}`);
    }
});

test('feather 0 gives hard edges, and no composite rects means the whole crop', () => {
    const source = page();
    const patchRaster = createRaster(140, 120, [10, 200, 10, 255]);
    const crop = { x: 80, y: 30, width: 140, height: 120 };
    const hard = { ...source, data: Buffer.from(source.data) };
    compositeOnto(hard, patchRaster, crop, [{ x: 100, y: 50, width: 40, height: 30 }], 0);
    assert.deepEqual(getPixel(hard, 100, 50), [10, 200, 10, 255]);
    assert.deepEqual(getPixel(hard, 99, 50), getPixel(source, 99, 50));
    const whole = { ...source, data: Buffer.from(source.data) };
    compositeOnto(whole, patchRaster, crop, [crop], 0);
    assert.deepEqual(getPixel(whole, 80, 30), [10, 200, 10, 255]);
    assert.deepEqual(getPixel(whole, 219, 149), [10, 200, 10, 255]);
    assert.deepEqual(getPixel(whole, 220, 150), getPixel(source, 220, 150));
});

test('the difference report separates the composite rects from the rest of the crop', () => {
    const before = createRaster(40, 40, [100, 100, 100, 255]);
    const after = { ...before, data: Buffer.from(before.data) };
    for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 10; x++) {
            setPixel(after, x, y, [130, 100, 70]);
        }
    }
    const report = differenceReport(before, after, [{ x: 0, y: 0, width: 10, height: 10 }]);
    assert.equal(report.inside, 20);
    assert.equal(report.outside, 0);
    assert.equal(differenceReport(before, after, []).outside, undefined);
});

test('the spec is checked: crops inside the image, composite rects inside their crop, whole numbers, known keys', () => {
    const size = { width: 300, height: 200 };
    const ok = parsePatchSpec([{ crop: [80, 30, 140, 120], composite: [[100, 50, 40, 30]], instruction: 'x' }, { crop: [0, 0, 300, 200] }], size);
    assert.deepEqual(ok[0].composite, [{ x: 100, y: 50, width: 40, height: 30 }]);
    assert.deepEqual(ok[1].composite, [{ x: 0, y: 0, width: 300, height: 200 }], 'no composite means the whole crop');
    assert.equal(ok[1].instruction, undefined);
    for (const [bad, message] of [
        [[], /at least one patch/],
        [{ crop: [0, 0, 1, 1] }, /list/],
        [[{ crop: [0, 0, 301, 10] }], /outside the 300x200 image/],
        [[{ crop: [-1, 0, 10, 10] }], /outside/],
        [[{ crop: [0, 0, 1.5, 10] }], /whole numbers/],
        [[{ crop: [0, 0, 0, 10] }], /at least 1/],
        [[{ crop: [0, 0, 10] }], /four numbers/],
        [[{ crop: [0, 0, 100, 100], composite: [[90, 90, 20, 20]] }], /not inside its crop/],
        [[{ crop: [0, 0, 100, 100], composite: [] }], /composite/],
        [[{ crop: [0, 0, 100, 100], instructions: 'typo' }], /unknown key "instructions"/],
        [[{ crop: [0, 0, 100, 100], instruction: 5 }], /instruction/],
    ]) {
        assert.throws(() => parsePatchSpec(bad, size), message);
    }
});
