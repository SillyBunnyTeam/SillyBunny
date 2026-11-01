import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { buildContactSheet } from '../scripts/lib/contact-sheet.mjs';
import { keyBackgroundFile, parseHexColour } from '../scripts/lib/key.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'sb-img-'));

async function writePng(path, width, height, pixels) {
    const data = Buffer.alloc(width * height * 4);
    pixels.forEach((rgba, i) => Buffer.from(rgba).copy(data, i * 4));
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(path);
}

async function readPixels(path) {
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, info, at: (i) => [...data.subarray(i * 4, i * 4 + 4)] };
}

test('key-bg makes the key colour transparent and leaves the figure alone', async () => {
    const dir = scratch();
    const green = [0, 255, 0, 255];
    const red = [200, 30, 30, 255];
    await writePng(join(dir, 'in.png'), 4, 1, [green, green, red, red]);
    await keyBackgroundFile(join(dir, 'in.png'), join(dir, 'out.png'), { key: parseHexColour('#00FF00'), tolerance: 60, softness: 60 });
    const { at } = await readPixels(join(dir, 'out.png'));
    assert.equal(at(0)[3], 0);
    assert.equal(at(1)[3], 0);
    assert.deepEqual(at(2), red);
    assert.deepEqual(at(3), red);
});

test('key-bg feathers a green-tinted edge pixel and removes the green spill from it', async () => {
    const dir = scratch();
    await writePng(join(dir, 'in.png'), 1, 1, [[60, 200, 60, 255]]);
    await keyBackgroundFile(join(dir, 'in.png'), join(dir, 'out.png'), { key: parseHexColour('00ff00'), tolerance: 60, softness: 60 });
    const [r, g, b, a] = (await readPixels(join(dir, 'out.png'))).at(0);
    assert.ok(a > 0 && a < 255, `alpha ${a} should be partial`);
    assert.ok(g <= Math.max(r, b), `green ${g} should be clamped to ${Math.max(r, b)}`);
});

test('key-bg keeps existing transparency and rejects a bad colour', async () => {
    const dir = scratch();
    await writePng(join(dir, 'in.png'), 1, 1, [[10, 10, 10, 0]]);
    await keyBackgroundFile(join(dir, 'in.png'), join(dir, 'out.png'), { key: parseHexColour('#00FF00'), tolerance: 60, softness: 0 });
    assert.equal((await readPixels(join(dir, 'out.png'))).at(0)[3], 0);
    assert.throws(() => parseHexColour('green'), /hex/);
});

async function solidPng(dir, name, width, height, colour = '#c0a0e0') {
    const path = join(dir, name);
    await sharp({ create: { width, height, channels: 3, background: colour } }).png().toFile(path);
    return path;
}

test('the contact sheet fits each image to its own aspect inside the cell box', async () => {
    const dir = scratch();
    const items = [];
    for (const [index, [width, height]] of [[40, 80], [80, 40], [64, 64], [10, 10], [30, 90]].entries()) {
        items.push({ path: await solidPng(dir, `i${index}.png`, width, height), label: `image ${index + 1}` });
    }
    const layout = { cols: 3, cellWidth: 100, cellHeight: 100, gap: 10, labelHeight: 24, nearest: false };
    const meta = await sharp(await buildContactSheet(items, layout)).metadata();
    // Row 1 holds 50x100, 100x50 and 100x100; row 2 holds 100x100 and 33x100.
    assert.equal(meta.width, 10 + (50 + 10) + (100 + 10) + (100 + 10));
    assert.equal(meta.height, 10 + (100 + 24 + 10) + (100 + 24 + 10));
    assert.equal(meta.format, 'png');
});

test('a landscape image is not padded to a square cell', async () => {
    const dir = scratch();
    const items = [{ path: await solidPng(dir, 'wide.png', 300, 200), label: 'wide' }];
    const meta = await sharp(await buildContactSheet(items, { cols: 1, cellWidth: 600, cellHeight: 600, gap: 0, labelHeight: 0, nearest: false })).metadata();
    assert.deepEqual([meta.width, meta.height], [600, 400]);
});

test('separate cell width and height bound the fit independently', async () => {
    const dir = scratch();
    const items = [{ path: await solidPng(dir, 'wide.png', 300, 200), label: 'wide' }];
    const meta = await sharp(await buildContactSheet(items, { cols: 1, cellWidth: 640, cellHeight: 100, gap: 0, labelHeight: 0, nearest: false })).metadata();
    assert.deepEqual([meta.width, meta.height], [150, 100]);
});

test('the contact sheet refuses an empty list', async () => {
    await assert.rejects(buildContactSheet([], { cols: 3, cellWidth: 100, cellHeight: 100, gap: 10, labelHeight: 24, nearest: false }), /no images/i);
});

test('nearest-neighbour scaling keeps pixel art crisp when enlarged', async () => {
    const dir = scratch();
    await writePng(join(dir, 'px.png'), 2, 1, [[255, 0, 0, 255], [0, 0, 255, 255]]);
    const sheet = await buildContactSheet([{ path: join(dir, 'px.png'), label: 'px' }], { cols: 1, cellWidth: 40, cellHeight: 40, gap: 0, labelHeight: 0, nearest: true });
    const { data, info } = await sharp(sheet).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [40, 20]);
    const row = info.height / 2 | 0;
    const pixel = (x) => [...data.subarray((row * info.width + x) * 3, (row * info.width + x) * 3 + 3)];
    assert.deepEqual(pixel(5), [255, 0, 0]);
    assert.deepEqual(pixel(34), [0, 0, 255]);
    for (let x = 0; x < info.width; x++) {
        const [r, , b] = pixel(x);
        assert.ok(!(r > 0 && r < 255 && b > 0 && b < 255), `blended pixel at x=${x}`);
    }
});

const FIGURE = { left: 60, top: 50, right: 140, bottom: 150 };
const distanceOutsideFigure = (x, y) => Math.max(FIGURE.left - x, x - (FIGURE.right - 1), FIGURE.top - y, y - (FIGURE.bottom - 1), 0);

/** A plum figure with a lighter patch on a #00FF00 field, softened at the edge, saved as a PNG or as a JPEG like the Gemini output. */
async function writeGreenField(path, jpegOptions) {
    const [width, height] = [200, 200];
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            raw.set(distanceOutsideFigure(x, y) === 0 ? (x < 100 ? [200, 170, 215] : [90, 40, 70]) : [0, 255, 0], (y * width + x) * 3);
        }
    }
    const image = sharp(raw, { raw: { width, height, channels: 3 } }).blur(1.2);
    await (jpegOptions ? image.jpeg(jpegOptions) : image.png()).toFile(path);
}

async function keyedField(dir, name, jpegOptions) {
    await writeGreenField(join(dir, name), jpegOptions);
    await keyBackgroundFile(join(dir, name), join(dir, `${name}.keyed.png`), { key: parseHexColour('#00FF00'), tolerance: 80, softness: 40 });
    const { data, info } = await readPixels(join(dir, `${name}.keyed.png`));
    return { at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)], width: info.width, height: info.height };
}

for (const [quality, chromaSubsampling] of [[90, '4:4:4'], [75, '4:2:0'], [50, '4:2:0']]) {
    test(`key-bg copes with JPEG artefacts on a green field (quality ${quality}, ${chromaSubsampling})`, async () => {
        const dir = scratch();
        const clean = await keyedField(dir, 'clean.png');
        const jpeg = await keyedField(dir, 'field.jpg', { quality, chromaSubsampling });

        let haloClean = 0;
        let haloJpeg = 0;
        for (let y = 0; y < jpeg.height; y++) {
            for (let x = 0; x < jpeg.width; x++) {
                const [r, g, b, a] = jpeg.at(x, y);
                const outside = distanceOutsideFigure(x, y);
                if (outside >= 5) {
                    assert.equal(a, 0, `background pixel (${x},${y}) kept alpha ${a}`);
                }
                if (a > 0) {
                    assert.ok(g <= Math.max(r, b) + 10, `green fringe at (${x},${y}): ${[r, g, b]}`);
                }
                if (outside >= 1 && outside < 5) {
                    haloClean += clean.at(x, y)[3] > 0 ? 1 : 0;
                    haloJpeg += a > 0 ? 1 : 0;
                }
            }
        }
        // The blurred edge itself keeps some pixels visible. JPEG noise may add only a little to that.
        assert.ok(haloJpeg <= haloClean * 1.15 + 10, `${haloJpeg} halo pixels after JPEG against ${haloClean} without it`);

        for (const [x, y, expected] of [[80, 100, [200, 170, 215]], [120, 100, [90, 40, 70]]]) {
            const [r, g, b, a] = jpeg.at(x, y);
            assert.equal(a, 255);
            assert.ok([r, g, b].every((channel, i) => Math.abs(channel - expected[i]) < 30), `figure colour moved at (${x},${y}): ${[r, g, b]}`);
        }
    });
}
