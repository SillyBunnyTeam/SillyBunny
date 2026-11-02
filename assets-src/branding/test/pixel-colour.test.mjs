import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findPalettePath, formatHex, oklabToSrgb, paletteIndexFinder, parsePalette, srgbToOklab } from '../scripts/lib/pixel-colour.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

test('sRGB converts to OKLab and back without drifting', () => {
    for (const rgb of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [12, 200, 90], [133, 71, 220], [240, 241, 251]]) {
        const back = oklabToSrgb(srgbToOklab(rgb)).map(Math.round);
        assert.deepEqual(back, rgb);
    }
    const [lightness, a, b] = srgbToOklab([255, 255, 255]);
    assert.ok(Math.abs(lightness - 1) < 1e-3 && Math.abs(a) < 1e-3 && Math.abs(b) < 1e-3);
});

test('hex formatting is lowercase and padded', () => {
    assert.equal(formatHex([255, 0, 10]), '#ff000a');
});

test('a .hex palette is one colour per line with an optional # and no duplicates', () => {
    assert.deepEqual(parsePalette('#FF0000\n00ff00\n\n0000ff\n', 'p.hex'), [[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
    assert.throws(() => parsePalette('ff0000\nFF0000\n', 'p.hex'), /duplicate colour #ff0000/);
    assert.throws(() => parsePalette('ff0000\nnot a colour\n', 'p.hex'), /p\.hex line 2/);
    assert.throws(() => parsePalette('\n\n', 'p.hex'), /no colours/);
});

test('a GIMP .gpl palette reads its colour lines and skips the header, comments and names', () => {
    const gpl = 'GIMP Palette\nName: Reisen\nColumns: 4\n# a comment\n255   0   0 outline\n  0 255 128\tgrass\n';
    assert.deepEqual(parsePalette(gpl, 'p.gpl'), [[255, 0, 0], [0, 255, 128]]);
    assert.throws(() => parsePalette('GIMP Palette\n300 0 0 bad\n', 'p.gpl'), /p\.gpl line 2/);
});

test('the nearest palette colour is found in OKLab and is cached', () => {
    const find = paletteIndexFinder([[0, 0, 0], [255, 255, 255], [200, 30, 30], [30, 30, 200]]);
    assert.equal(find(10, 10, 10), 0);
    assert.equal(find(250, 245, 250), 1);
    assert.equal(find(190, 50, 40), 2);
    assert.equal(find(40, 40, 160), 3);
    assert.equal(find(190, 50, 40), 2);
});

test('a palette name resolves from the working directory, then from palettes/ in the package, with .hex or .gpl', () => {
    const root = tempDir('sb-pal-');
    mkdirSync(join(root, 'palettes'));
    writeFileSync(join(root, 'palettes', 'reisen.hex'), 'ffffff\n');
    writeFileSync(join(root, 'palettes', 'tewi.gpl'), 'GIMP Palette\n1 2 3 x\n');
    assert.equal(findPalettePath(root, 'reisen'), join(root, 'palettes', 'reisen.hex'));
    assert.equal(findPalettePath(root, 'palettes/tewi'), join(root, 'palettes', 'tewi.gpl'));
    assert.equal(findPalettePath(root, join(root, 'palettes', 'reisen.hex')), join(root, 'palettes', 'reisen.hex'));
    assert.throws(() => findPalettePath(root, 'nobody'), /No palette "nobody"/);
});
