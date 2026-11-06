import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KIND } from '../scripts/lib/ear-remnants.mjs';
import { OUTLINE, outlineCrop, renderPatchOverlay } from '../scripts/lib/patch-overlay.mjs';
import { parsePatchSpec } from '../scripts/lib/patch.mjs';
import { readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'patch-overlay.mjs');

/** 100x80 page whose pixel colour depends on its position, so any shift or blur shows. */
function page() {
    const raster = createRaster(100, 80, [240, 236, 250, 255]);
    for (let y = 0; y < 80; y++) {
        for (let x = 0; x < 100; x++) {
            setPixel(raster, x, y, [(x * 5) % 200, (y * 7) % 200, 90]);
        }
    }
    return raster;
}

const png = (raster) => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png().toBuffer();
const decode = async (bytes) => {
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
};

const patch = (crop, composite) => parsePatchSpec([{ crop, composite }], { width: 100, height: 80 })[0];

test('the outlined crop is the crop at 2x with nearest-neighbour blocks and a one pixel outline just inside each rect', async () => {
    const source = page();
    const view = await decode(await outlineCrop(await png(source), patch([10, 20, 40, 30], [[15, 25, 10, 8]]), 2));
    assert.deepEqual([view.width, view.height], [80, 60]);
    const [r, g, b] = OUTLINE;
    // The rect starts at crop-relative (5, 5), so at 2x its outline begins at (10, 10) and ends at (29, 25).
    for (const [x, y] of [[10, 10], [29, 10], [10, 25], [29, 25], [19, 10], [19, 25], [10, 17], [29, 17]]) {
        assert.deepEqual(getPixel(view, x, y).slice(0, 3), [r, g, b], `outline at ${x},${y}`);
    }
    for (const [x, y] of [[0, 0], [79, 59], [9, 9], [30, 26], [19, 17], [12, 12]]) {
        const sourcePixel = getPixel(source, 10 + (x >> 1), 20 + (y >> 1));
        assert.deepEqual(getPixel(view, x, y), sourcePixel, `pixel ${x},${y} should be the enlarged source, untouched`);
    }
});

test('every rect is drawn, and a patch with no composite outlines its whole crop', async () => {
    const two = await decode(await outlineCrop(await png(page()), patch([0, 0, 60, 40], [[2, 2, 6, 6], [30, 20, 10, 10]]), 2));
    assert.deepEqual(getPixel(two, 4, 4).slice(0, 3), [...OUTLINE]);
    assert.deepEqual(getPixel(two, 60, 40).slice(0, 3), [...OUTLINE]);
    const whole = await decode(await outlineCrop(await png(page()), parsePatchSpec([{ crop: [0, 0, 60, 40] }], { width: 100, height: 80 })[0], 2));
    assert.deepEqual(getPixel(whole, 0, 0).slice(0, 3), [...OUTLINE]);
    assert.deepEqual(getPixel(whole, 119, 79).slice(0, 3), [...OUTLINE]);
});

test('the overlay sheet holds every crop at its own size, in the requested number of columns, with a label under each', async () => {
    const patches = parsePatchSpec([
        { crop: [0, 0, 40, 30], composite: [[5, 5, 10, 10]] },
        { crop: [50, 0, 40, 30], composite: [[55, 5, 10, 10]] },
        { crop: [0, 40, 60, 30], composite: [[5, 45, 10, 10]] },
    ], { width: 100, height: 80 });
    const sheet = await decode(await renderPatchOverlay(await png(page()), patches, { scale: 2, columns: 2 }));
    const gap = 12;
    const label = 24;
    assert.equal(sheet.width, gap + 80 + gap + 80 + gap);
    assert.equal(sheet.height, gap + 60 + label + gap + 60 + label + gap);
    await assert.rejects(renderPatchOverlay(await png(page()), patches, { scale: 0 }), /scale/);
    await assert.rejects(renderPatchOverlay(await png(page()), patches, { columns: 0 }), /columns/);
});

test('flags inside the crop are tinted at their enlarged position, flags outside it are ignored, and the outline stays on top', async () => {
    const source = page();
    const flags = [[12, 22, KIND.skin], [14, 22, KIND.warm], [90, 70, KIND.skin]];
    const view = await decode(await outlineCrop(await png(source), patch([10, 20, 40, 30], [[11, 21, 6, 6]]), 2, flags));
    const [r, g, b] = getPixel(view, 5, 5);
    assert.ok(r > 180 && g < 120 && b < 120, `skin flag should read red, got ${[r, g, b]}`);
    const [wr, wg, wb] = getPixel(view, 9, 5);
    assert.ok(wr > 180 && wg > 150 && wb < 100, `warm flag should read yellow, got ${[wr, wg, wb]}`);
    assert.deepEqual(getPixel(view, 30, 30), getPixel(source, 25, 35), 'an unflagged pixel is the enlarged source');
    // The rect starts at crop-relative (1, 1), so its outline is at (2, 2) and passes over the flag at crop-relative (2, 2).
    assert.deepEqual(getPixel(view, 2, 2).slice(0, 3), [...OUTLINE]);
});

test('the script takes a flags file and draws it on every crop', async () => {
    const cwd = tempDir('sb-overlay-flags-');
    await writeRaster(join(cwd, 'page.png'), page());
    writeFileSync(join(cwd, 'spec.json'), JSON.stringify([{ crop: [10, 20, 40, 30], composite: [[15, 25, 10, 8]] }]));
    writeFileSync(join(cwd, 'flags.json'), JSON.stringify([[30, 40, 1]]));
    const result = spawnSync('node', [SCRIPT, '--image', 'page.png', '--spec', 'spec.json', '--flags', 'flags.json', '--scale', '4', '--cols', '1'], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const sheet = await readRaster(join(cwd, 'out', 'patches', 'spec-overlay.png'));
    const gap = 12;
    const [r, g, b] = getPixel(sheet, gap + (30 - 10) * 4 + 1, gap + (40 - 20) * 4 + 1);
    assert.ok(r > 180 && g < 120 && b < 120, `the flag should read red, got ${[r, g, b]}`);
    writeFileSync(join(cwd, 'bad.json'), JSON.stringify([[1, 2]]));
    const bad = spawnSync('node', [SCRIPT, '--image', 'page.png', '--spec', 'spec.json', '--flags', 'bad.json'], { cwd, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /flags/);
});

test('the script writes the sheet to out/patches named after the spec and refuses a bad spec before writing anything', async () => {
    const cwd = tempDir('sb-overlay-');
    await writeRaster(join(cwd, 'page.png'), page());
    writeFileSync(join(cwd, 'spec.json'), JSON.stringify([{ crop: [10, 20, 40, 30], composite: [[15, 25, 10, 8]] }]));
    const result = spawnSync('node', [SCRIPT, '--image', 'page.png', '--spec', 'spec.json'], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const sheet = await readRaster(join(cwd, 'out', 'patches', 'spec-overlay.png'));
    assert.ok(sheet.width >= 80 && sheet.height >= 60);
    assert.match(result.stdout, /spec-overlay\.png/);

    writeFileSync(join(cwd, 'bad.json'), JSON.stringify([{ crop: [10, 20, 400, 30] }]));
    const bad = spawnSync('node', [SCRIPT, '--image', 'page.png', '--spec', 'bad.json', '--out', 'out/bad.png'], { cwd, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /outside the 100x80 image/);
    assert.match(spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' }).stderr, /^error: Usage/);
});
