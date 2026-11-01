import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOrphanFixes, findOrphans, orphansToPatch, pixelateRaster } from '../scripts/lib/pixelate.mjs';
import { createRaster, opaqueBox } from '../scripts/lib/raster.mjs';
import { addNoise, blur, countMatches, getPixel, nativeSprite, setPixel, upscale } from '../test-support/synthetic.mjs';

const PALETTE = [[200, 40, 50], [40, 60, 200], [230, 210, 90], [60, 160, 90], [250, 250, 250], [40, 20, 50]];
const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

// The native canvas is 64x60 cells with a 36x32 sprite in it. It is enlarged 8x onto a canvas that is 8 pixels wider
// and taller, with the grid starting at (4, 6), then roughened the way a model's picture is: speckle noise and softened edges.
const native = nativeSprite(64, 60, PALETTE, { seed: 11, margin: 14 });
const messy = blur(addNoise(upscale(native, 8, { offsetX: 4, offsetY: 6, canvas: { width: 520, height: 488 } }), 8));
const options = { grid: { width: 64, height: 60 }, palette: PALETTE };

test('a roughened 8x picture comes back as the original native canvas, snapped to the palette', () => {
    const { raster, report } = pixelateRaster(messy, options);
    assert.deepEqual([raster.width, raster.height], [64, 60]);
    assert.ok(Math.abs(report.cell - 8) < 0.1, `cell ${report.cell}`);
    assert.equal(report.cellSource, 'detected');
    assert.ok(countMatches(raster, native) > 0.99);
    for (let at = 0; at < raster.data.length; at += 4) {
        if (raster.data[at + 3] === 0) {
            continue;
        }
        assert.equal(raster.data[at + 3], 255);
        assert.ok(PALETTE.some((c) => c[0] === raster.data[at] && c[1] === raster.data[at + 1] && c[2] === raster.data[at + 2]), 'every pixel is a palette colour');
    }
    assert.equal(report.paletteSize, 6);
    assert.ok(report.coloursUsed <= 6);
    assert.deepEqual(report.sprite, opaqueBox(native));
    assert.deepEqual(report.warnings, []);
});

test('the search window is around source size divided by grid size, so a 10.24 pixel cell on a 2048 pixel canvas is found', () => {
    const small = nativeSprite(40, 40, PALETTE, { seed: 5, margin: 6 });
    const big = upscale(small, 10.24, { canvas: { width: 410, height: 410 } });
    const { report } = pixelateRaster(big, { grid: { width: 40, height: 40 }, palette: PALETTE });
    assert.ok(Math.abs(report.cell - 10.24) < 0.06, `cell ${report.cell}`);
});

test('a given cell skips the cell search but still finds where the grid starts, and centre sampling gives the same picture', () => {
    const manual = pixelateRaster(messy, { ...options, cell: 8, sample: 'centre' });
    assert.equal(manual.report.cellSource, 'manual');
    assert.equal(manual.report.cell, 8);
    assert.ok(manual.report.strength > 0.2);
    assert.deepEqual(manual.report.offset, { x: 4, y: 6 });
    assert.equal(manual.report.sprite.width, 36);
    assert.ok(countMatches(manual.raster, native) > 0.97);
});

test('alpha is binary: a semi-transparent edge is kept or dropped by the threshold, never left half-clear', () => {
    const soft = createRaster(160, 160);
    for (let y = 16; y < 144; y++) {
        for (let x = 16; x < 144; x++) {
            setPixel(soft, x, y, [200, 40, 50, x < 24 ? 100 : 255]);
        }
    }
    const grid = { width: 20, height: 20 };
    const strict = pixelateRaster(soft, { grid, palette: [[200, 40, 50]], cell: 8, alphaThreshold: 128 });
    const loose = pixelateRaster(soft, { grid, palette: [[200, 40, 50]], cell: 8, alphaThreshold: 90 });
    assert.equal(strict.report.sprite.width, 15);
    assert.equal(loose.report.sprite.width, 16);
    for (const result of [strict, loose]) {
        assert.ok([...result.raster.data].filter((_, at) => at % 4 === 3).every((alpha) => alpha === 0 || alpha === 255));
    }
});

test('a picture with no clear grid is still converted, with a warning that names the weak detection', () => {
    const smooth = createRaster(512, 480);
    for (let y = 0; y < 480; y++) {
        for (let x = 0; x < 512; x++) {
            setPixel(smooth, x, y, [Math.round(128 + 100 * Math.sin(x / 37)), Math.round(128 + 100 * Math.sin(y / 29)), Math.round(128 + 90 * Math.sin((x + y) / 53))]);
        }
    }
    const { report } = pixelateRaster(smooth, options);
    assert.ok(report.strength < 0.2, `strength ${report.strength}`);
    assert.ok(report.warnings.some((warning) => /grid is weak/.test(warning)));
});

test('a sprite that touches the canvas edge is warned about, because the snap may have cut it', () => {
    const full = createRaster(64, 60);
    for (let y = 0; y < 60; y++) {
        for (let x = 0; x < 64; x++) {
            setPixel(full, x, y, PALETTE[(x + y) % 3]);
        }
    }
    const { report } = pixelateRaster(full, options);
    assert.ok(report.warnings.some((warning) => /touches the canvas edge/.test(warning)));
});

test('a picture that is already native size is taken one cell per pixel', () => {
    const { raster, report } = pixelateRaster(native, options);
    assert.equal(report.cell, 1);
    assert.ok(report.warnings.some((warning) => /already close to the native size/.test(warning)));
    assert.ok(countMatches(raster, native) > 0.999);
});

test('an empty picture, a source that does not match the grid shape, and a bad sample are all errors', () => {
    assert.throws(() => pixelateRaster(createRaster(512, 480), options), /nothing opaque/);
    assert.throws(() => pixelateRaster(upscale(native, 8, { canvas: { width: 700, height: 480 } }), options), /shape/);
    assert.throws(() => pixelateRaster(messy, { ...options, sample: 'median' }), /sample/);
    assert.throws(() => pixelateRaster(messy, { ...options, palette: [] }), /palette/);
});

function orphanPicture() {
    const picture = createRaster(10, 10);
    for (let y = 2; y < 8; y++) {
        for (let x = 2; x < 8; x++) {
            setPixel(picture, x, y, [200, 40, 50]);
        }
    }
    setPixel(picture, 4, 4, [40, 60, 200]);
    setPixel(picture, 6, 5, [0, 0, 0, 0]);
    setPixel(picture, 9, 9, [200, 40, 50]);
    setPixel(picture, 2, 2, [250, 250, 250]);
    setPixel(picture, 3, 2, [250, 250, 250]);
    return picture;
}

test('with a colour tolerance, a pixel a shade off its neighbours is not an orphan, and a pixel of another colour still is', () => {
    const picture = createRaster(10, 10);
    for (let y = 2; y < 8; y++) {
        for (let x = 2; x < 8; x++) {
            setPixel(picture, x, y, [200, 30 + y * 6 + x, 50]);
        }
    }
    setPixel(picture, 4, 4, [40, 60, 200]);
    assert.ok(findOrphans(picture).length > 1, 'by exact colour, a speckled area is full of orphans');
    assert.deepEqual(findOrphans(picture, { tolerance: 0.03 }).map(({ x, y }) => [x, y]), [[4, 4]]);
    assert.deepEqual(findOrphans(picture, { tolerance: 0 }), findOrphans(picture));
});

test('orphans are found and described: a lone colour pixel, a one-pixel hole and a speck away from the sprite', () => {
    const found = findOrphans(orphanPicture());
    assert.deepEqual(found.map(({ x, y, kind }) => [x, y, kind]), [[4, 4, 'pixel'], [6, 5, 'hole'], [9, 9, 'pixel']]);
    assert.equal(found[0].colour, hex([40, 60, 200]));
    assert.equal(found[0].suggest, hex([200, 40, 50]));
    assert.equal(found[1].suggest, hex([200, 40, 50]));
    assert.equal(found[2].suggest, 'transparent');
});

test('a pair of pixels of one colour is a cluster, not an orphan', () => {
    assert.ok(!findOrphans(orphanPicture()).some(({ x, y }) => (x === 2 || x === 3) && y === 2));
});

test('orphans are reported and left alone unless the fix is asked for', () => {
    const picture = orphanPicture();
    const kept = pixelateRaster(upscale(picture, 8), { grid: { width: 10, height: 10 }, palette: [[200, 40, 50], [40, 60, 200], [250, 250, 250]], cell: 8 });
    assert.equal(kept.report.orphansFixed, false);
    assert.ok(kept.report.orphans.length >= 2);
    assert.ok(findOrphans(kept.raster).length >= 2, 'the orphans are still in the picture');

    const fixed = pixelateRaster(upscale(picture, 8), { grid: { width: 10, height: 10 }, palette: [[200, 40, 50], [40, 60, 200], [250, 250, 250]], cell: 8, fixOrphans: true });
    assert.equal(fixed.report.orphansFixed, true);
    assert.ok(fixed.report.fixPasses >= 1 && fixed.report.orphansRemaining === 0);
    assert.equal(findOrphans(fixed.raster).length, 0);
    assert.ok(fixed.report.orphans.length >= 2, 'the report still lists what was fixed');
});

test('the suggested fixes can be applied by hand or written out as a pixel-fix patch', () => {
    const picture = orphanPicture();
    const orphans = findOrphans(picture);
    const fixed = applyOrphanFixes(picture, orphans);
    assert.deepEqual(getPixel(fixed, 4, 4), [200, 40, 50, 255]);
    assert.deepEqual(getPixel(fixed, 6, 5), [200, 40, 50, 255]);
    assert.equal(getPixel(fixed, 9, 9)[3], 0);
    assert.deepEqual(getPixel(picture, 4, 4), [40, 60, 200, 255], 'the input is not changed');
    assert.deepEqual(orphansToPatch(orphans), [
        { x: 4, y: 4, color: hex([200, 40, 50]) },
        { x: 6, y: 5, color: hex([200, 40, 50]) },
        { x: 9, y: 9, color: 'transparent' },
    ]);
});
