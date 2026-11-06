import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { chooseEncoding, frameBox, outputSize, parseExportSpec, perceptualDifference, renderFrame, resizeFrame } from '../scripts/lib/export-art.mjs';
import { addNoise, createRaster, getPixel, seeded, setPixel } from '../test-support/synthetic.mjs';

const BODY = [120, 80, 160];
const RIM = [185, 155, 242];

/** A 100 by 100 canvas with a 30 wide, 60 tall subject at (30, 20), and a stray faint pixel in the corner. */
function canvas() {
    const raster = createRaster(100, 100);
    for (let y = 20; y < 80; y++) {
        for (let x = 30; x < 60; x++) {
            setPixel(raster, x, y, BODY);
        }
    }
    setPixel(raster, 2, 2, [...RIM, 3]);
    return raster;
}

const spec = (assets, extra = {}) => parseExportSpec({ margin: 4, assets, ...extra });
const asset = (overrides = {}) => ({ character: 'reisen', master: 'raw/m.png', css: [32], ...overrides });

test('an export spec is checked: known keys, ids, whole number CSS sizes, a fit, a crop, a webp mode', () => {
    for (const [bad, message] of [
        [{ 'Row Reisen': asset() }, /id/],
        [{ a: asset({ css: [] }) }, /css/],
        [{ a: asset({ css: [32, 32] }) }, /duplicate/],
        [{ a: asset({ css: [1.5] }) }, /css/],
        [{ a: asset({ fit: 'cover' }) }, /fit/],
        [{ a: asset({ crop: [1, 2, 3] }) }, /crop/],
        [{ a: asset({ crop: 'full' }) }, /crop/],
        [{ a: asset({ src: { css: 64, density: 2 } }) }, /src/],
        [{ a: asset({ src: { css: 32, density: 4 } }) }, /src/],
        [{ a: asset({ src: 2 }) }, /src/],
        [{ a: asset({ webp: 'png' }) }, /webp/],
        [{ a: asset({ webp: 120 }) }, /webp/],
        [{ a: asset({ webp: { mode: 'lossy', quality: 0 } }) }, /webp/],
        [{ a: asset({ webp: { mode: 'png', quality: 50 } }) }, /webp/],
        [{ a: asset({ extra: 1 }) }, /unknown key "extra"/],
        [{ a: asset({ master: '' }) }, /master/],
        [{ a: asset({ focus: [2, 0.5] }) }, /focus/],
        [{}, /at least one/],
    ]) {
        assert.throws(() => spec(bad), message);
    }
    assert.throws(() => parseExportSpec({ margin: -1, assets: { a: asset() } }), /margin/);
    assert.throws(() => parseExportSpec({ assets: { a: asset() }, other: 1 }), /unknown key "other"/);
});

test('a parsed spec has defaults filled in: contain fit, the spec margin, auto webp, no square', () => {
    const [parsed] = spec({ a: asset() }).assets;
    assert.deepEqual([parsed.id, parsed.fit, parsed.margin, parsed.webp, parsed.square], ['a', 'contain', 4, 'auto', false]);
    const [own] = spec({ a: asset({ margin: 9, fit: 'width', webp: 'lossless', square: true }) }).assets;
    assert.deepEqual(spec({ a: asset({ webp: { mode: 'lossy', quality: 80 } }) }).assets[0].webp, { mode: 'lossy', quality: 80 });
    assert.deepEqual([own.margin, own.fit, own.webp, own.square], [9, 'width', 'lossless', true]);
});

test('the frame is the subject trimmed to its box, ignoring specks too faint to see, plus the margin on every side', () => {
    assert.deepEqual(frameBox(canvas(), { margin: 4, square: false }), { x: 26, y: 16, width: 38, height: 68 });
});

test('a margin that runs past the canvas gives a frame that does too, so the edge of the sticker never touches the canvas edge', () => {
    const raster = createRaster(50, 50);
    for (let y = 30; y < 50; y++) {
        for (let x = 10; x < 40; x++) {
            setPixel(raster, x, y, BODY);
        }
    }
    const frame = frameBox(raster, { margin: 6, square: false });
    assert.deepEqual(frame, { x: 4, y: 24, width: 42, height: 32 });
    const framed = renderFrame(raster, frame);
    assert.deepEqual([framed.width, framed.height], [42, 32]);
    assert.equal(getPixel(framed, 20, 31)[3], 0, 'the extra margin is transparent');
    assert.deepEqual(getPixel(framed, 6, 6), [...BODY, 255], 'the subject is where the margin puts it');
    assert.equal(getPixel(framed, 6, 5)[3], 0);
});

test('a crop box replaces the trim, with the margin still added, and must lie inside the canvas', () => {
    assert.deepEqual(frameBox(canvas(), { crop: [20, 10, 50, 80], margin: 5, square: false }), { x: 15, y: 5, width: 60, height: 90 });
    assert.throws(() => frameBox(canvas(), { crop: [80, 80, 40, 40], margin: 0, square: false }), /crop/);
});

test('crop "canvas" frames the whole picture, so the layout the model drew is kept, and the margin is still added', () => {
    assert.deepEqual(frameBox(canvas(), { crop: 'canvas', margin: 0, square: false }), { x: 0, y: 0, width: 100, height: 100 });
    assert.deepEqual(frameBox(canvas(), { crop: 'canvas', margin: 5, square: false }), { x: -5, y: -5, width: 110, height: 110 });
    assert.equal(spec({ a: asset({ crop: 'canvas' }) }).assets[0].crop, 'canvas');
});

test('the src fallback is the 2x file of the widest css size unless the spec names another', () => {
    assert.deepEqual(spec({ a: asset({ css: [64, 128, 32] }) }).assets[0].src, { css: 128, density: 2 });
    assert.deepEqual(spec({ a: asset({ css: [32] }) }).assets[0].src, { css: 32, density: 2 });
    assert.deepEqual(spec({ a: asset({ css: [64, 32], src: { css: 32, density: 3 } }) }).assets[0].src, { css: 32, density: 3 });
});

test('square pads the shorter side so the subject stays centred in a square frame', () => {
    const frame = frameBox(canvas(), { margin: 4, square: true });
    assert.deepEqual([frame.width, frame.height], [68, 68]);
    assert.equal(frame.x, 26 - 15);
    assert.equal(frame.y, 16);
});

test('a picture with nothing visible in it is refused', () => {
    assert.throws(() => frameBox(createRaster(20, 20), { margin: 2, square: false }), /subject/);
});

test('each size is the CSS size times the density, with the longer side exact for contain, the width for width and the height for height', () => {
    const frame = { x: 0, y: 0, width: 400, height: 800 };
    assert.deepEqual(outputSize(frame, { css: 128, density: 1, fit: 'contain' }), { width: 64, height: 128 });
    assert.deepEqual(outputSize(frame, { css: 128, density: 3, fit: 'contain' }), { width: 192, height: 384 });
    assert.deepEqual(outputSize(frame, { css: 128, density: 2, fit: 'width' }), { width: 256, height: 512 });
    assert.deepEqual(outputSize(frame, { css: 128, density: 2, fit: 'height' }), { width: 128, height: 256 });
    assert.throws(() => outputSize(frame, { css: 300, density: 3, fit: 'contain' }), /upscale/);
});

test('the resize is Lanczos with premultiplied alpha: a bright colour under a transparent pixel does not fringe the edge', async () => {
    const raster = createRaster(16, 4);
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 16; x++) {
            setPixel(raster, x, y, x < 8 ? [0, 0, 255, 255] : [255, 0, 0, 0]);
        }
    }
    const small = await resizeFrame(raster, { width: 5, height: 2 });
    for (let x = 0; x < 5; x++) {
        const [red, , , alpha] = getPixel(small, x, 0);
        assert.ok(alpha === 0 || red <= 2, `pixel ${x} has red ${red} at alpha ${alpha}`);
    }
    assert.deepEqual([small.width, small.height], [5, 2]);
});

test('the perceptual difference is zero for equal pictures, grows with a colour change, and counts only the pixels that show', () => {
    const one = createRaster(20, 20, [...BODY, 255]);
    const same = perceptualDifference(one, createRaster(20, 20, [...BODY, 255]));
    assert.deepEqual([same.mean, same.p99, same.max], [0, 0, 0]);
    const shifted = perceptualDifference(one, createRaster(20, 20, [130, 90, 160, 255]));
    assert.ok(shifted.mean > 0.5 && shifted.mean < 10, `mean ${shifted.mean}`);
    const mostlyEmpty = createRaster(20, 20);
    setPixel(mostlyEmpty, 3, 3, [...BODY, 255]);
    const moved = createRaster(20, 20);
    setPixel(moved, 3, 3, [130, 90, 160, 255]);
    const result = perceptualDifference(mostlyEmpty, moved);
    assert.equal(result.covered, 1);
    assert.ok(result.mean > 0.5, 'empty pixels do not dilute the mean');
    assert.throws(() => perceptualDifference(one, createRaster(10, 10)), /same size/);
});

/** A shaded disc with a little grain, like a rendered picture: smooth enough to round, not so smooth that lossless is already tiny. */
function smooth(size = 64) {
    const raster = createRaster(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (Math.hypot(x - size / 2, y - size / 2) < size * 0.4) {
                setPixel(raster, x, y, [100 + Math.round(x * 1.5), 90 + Math.round(y), 180]);
            }
        }
    }
    return addNoise(raster, 6);
}

/** Hard random noise, which lossy WebP cannot keep within the limits. */
function harsh(size = 64) {
    const random = seeded(5);
    const raster = createRaster(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            setPixel(raster, x, y, [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)]);
        }
    }
    return raster;
}

const MODES = ['lossless', 'near-lossless', 'lossy'];
const decodeRaw = async (buffer) => {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
};

test('auto encoding takes the smallest of the encodings that stay inside the limits for every size, and keeps the figures of all three', async () => {
    const pictures = [smooth(64), smooth(96)];
    const result = await chooseEncoding(pictures, { webp: 'auto' });
    assert.ok(MODES.includes(result.mode));
    assert.equal(result.files.length, 2);
    const passing = MODES.filter((mode) => mode === 'lossless' || result.files.every((file) => file.candidates[mode].passes));
    assert.ok(passing.includes(result.mode));
    for (const mode of passing) {
        assert.ok(result.totals[result.mode] <= result.totals[mode], `${result.mode} is not larger than ${mode}`);
    }
    for (const [index, file] of result.files.entries()) {
        assert.equal((await sharp(file.buffer).metadata()).format, 'webp');
        assert.equal(file.bytes, file.buffer.length);
        assert.deepEqual(Object.keys(file.candidates).sort(), [...MODES].sort());
        if (result.mode !== 'lossless') {
            const difference = perceptualDifference(pictures[index], await decodeRaw(file.buffer));
            assert.ok(difference.mean <= 0.4 && difference.p99 <= 1.5, `the chosen file is inside the limits (${difference.mean}, ${difference.p99})`);
        }
    }
});

test('near-lossless is smaller than lossless on a smooth picture and passes the limits, where plain lossy does not', async () => {
    const result = await chooseEncoding([smooth(96)], { webp: 'auto' });
    const { candidates } = result.files[0];
    assert.ok(candidates['near-lossless'].passes);
    assert.ok(candidates['near-lossless'].bytes < candidates.lossless.bytes);
    assert.equal(candidates.lossless.mean, 0);
    assert.equal(candidates.lossy.passes, false);
});

test('noise that no lossy encoding can keep inside the limits is never stored lossy', async () => {
    const result = await chooseEncoding([harsh(48)], { webp: 'auto' });
    assert.notEqual(result.mode, 'lossy');
    assert.equal(result.files[0].candidates.lossy.passes, false);
});

test('webp can be forced: lossless comes back exactly, and one mode and quality is used whatever the figures say', async () => {
    const lossless = await chooseEncoding([harsh(48)], { webp: 'lossless' });
    assert.equal(lossless.mode, 'lossless');
    assert.ok(Buffer.from((await decodeRaw(lossless.files[0].buffer)).data).equals(harsh(48).data), 'lossless means every byte comes back');
    assert.equal(lossless.files[0].candidates.lossy.passes, false, 'the figures of the others are still kept');
    const forced = await chooseEncoding([addNoise(smooth(64), 20)], { webp: { mode: 'lossy', quality: 40 } });
    assert.deepEqual([forced.mode, forced.quality], ['lossy', 40]);
    assert.ok(forced.files[0].candidates.lossy.mean > 0);
    assert.equal(forced.files[0].candidates['near-lossless'], undefined);
});

test('alpha survives lossy and near-lossless encoding: the transparent corners stay transparent', async () => {
    for (const mode of ['lossy', 'near-lossless']) {
        const result = await chooseEncoding([smooth(64)], { webp: { mode, quality: 80 } });
        const { data } = await decodeRaw(result.files[0].buffer);
        assert.equal(data[3], 0);
        assert.equal(data[(32 * 64 + 32) * 4 + 3], 255);
    }
});
