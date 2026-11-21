import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findOrphans } from '../scripts/lib/pixelate.mjs';
import { readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { addNoise, blur, countMatches, createRaster, getPixel, nativeSprite, setPixel, upscale } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const PALETTE = [[200, 40, 50], [40, 60, 200], [230, 210, 90], [60, 160, 90], [250, 250, 250], [40, 20, 50]];
const hex = (rgb) => rgb.map((c) => c.toString(16).padStart(2, '0')).join('');

const run = (script, args, cwd) => spawnSync('node', [join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8' });

async function workspace() {
    const cwd = tempDir('sb-pixelcli-');
    writeFileSync(join(cwd, 'palette.hex'), `${PALETTE.map(hex).join('\n')}\n`);
    const native = nativeSprite(64, 60, PALETTE, { seed: 11, margin: 14 });
    const messy = blur(addNoise(upscale(native, 8), 8));
    await writeRaster(join(cwd, 'messy.png'), messy);
    await writeRaster(join(cwd, 'native.png'), native);
    return { cwd, native };
}

test('pixelate writes the native PNG, a report and a readable summary, and leaves orphans alone unless asked', async () => {
    const { cwd, native } = await workspace();
    const result = run('pixelate.mjs', ['--in', 'messy.png', '--grid', '64x60', '--palette', 'palette.hex', '--out', 'out/p.png', '--orphans-patch', 'out/orphans.json'], cwd);
    assert.equal(result.status, 0, result.stderr);
    const picture = await readRaster(join(cwd, 'out', 'p.png'));
    assert.deepEqual([picture.width, picture.height], [64, 60]);
    assert.ok(countMatches(picture, native) > 0.99);
    const report = JSON.parse(readFileSync(join(cwd, 'out', 'p.report.json'), 'utf8'));
    assert.equal(report.orphansFixed, false);
    assert.equal(report.orphans.length, findOrphans(picture).length);
    assert.match(result.stdout, /grid 64x60 {2}cell 8\.0\d \(detected, strength/);
    assert.match(result.stdout, /palette 6 colours, \d used/);
    assert.match(result.stdout, /orphans: \d+ found, NOT changed/);
    assert.match(result.stdout, /WARNING: The palette has 6 colours; the style guide asks for 24 to 32/);
    assert.equal(JSON.parse(readFileSync(join(cwd, 'out', 'orphans.json'), 'utf8')).length, report.orphans.length);

    const fixed = run('pixelate.mjs', ['--in', 'messy.png', '--grid', '64x60', '--palette', 'palette.hex', '--out', 'out/fixed.png', '--fix-orphans', '--indexed'], cwd);
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.equal(findOrphans(await readRaster(join(cwd, 'out', 'fixed.png'))).length, 0);
    assert.match(fixed.stdout, /found and FIXED/);
    assert.equal(JSON.parse(readFileSync(join(cwd, 'out', 'fixed.report.json'), 'utf8')).orphansRemaining, 0);
});

test('pixelate refuses what it cannot do: a palette over 32 colours, the input as output, bad numbers', async () => {
    const { cwd } = await workspace();
    const many = Array.from({ length: 33 }, (_, i) => hex([i * 7, 255 - i * 7, i * 3])).join('\n');
    writeFileSync(join(cwd, 'many.hex'), many);
    const base = ['--in', 'messy.png', '--grid', '64x60'];
    assert.match(run('pixelate.mjs', [...base, '--palette', 'many.hex'], cwd).stderr, /33 colours.*at most 32/);
    assert.match(run('pixelate.mjs', [...base, '--palette', 'palette.hex', '--out', 'messy.png'], cwd).stderr, /different file/);
    assert.match(run('pixelate.mjs', [...base, '--palette', 'palette.hex', '--cell', 'abc'], cwd).stderr, /--cell/);
    assert.match(run('pixelate.mjs', ['--in', 'messy.png', '--grid', '64', '--palette', 'palette.hex'], cwd).stderr, /WIDTHxHEIGHT/);
    assert.match(run('pixelate.mjs', [], cwd).stderr, /Usage/);
    assert.match(run('pixelate.mjs', [...base, '--palette', 'nobody'], cwd).stderr, /No palette "nobody"/);
});

test('pixel-fix applies a patch to a copy, counts the change and can hold the patch to the palette', async () => {
    const { cwd } = await workspace();
    writeFileSync(join(cwd, 'patch.json'), JSON.stringify([{ x: 20, y: 20, color: '#c82832' }, { x: 21, y: 20, w: 2, h: 2, color: 'transparent' }]));
    const ok = run('pixel-fix.mjs', ['--in', 'native.png', '--patch', 'patch.json', '--palette', 'palette.hex', '--out', 'out/fixed.png'], cwd);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /2 edits, \d pixels? changed/);
    const fixed = await readRaster(join(cwd, 'out', 'fixed.png'));
    assert.deepEqual(getPixel(fixed, 21, 21), [0, 0, 0, 0]);
    assert.deepEqual(getPixel(await readRaster(join(cwd, 'native.png')), 21, 21).length, 4);

    writeFileSync(join(cwd, 'off.json'), JSON.stringify([{ x: 1, y: 1, color: '#123456' }]));
    assert.match(run('pixel-fix.mjs', ['--in', 'native.png', '--patch', 'off.json', '--palette', 'palette.hex'], cwd).stderr, /not in the palette: #123456/);
    assert.equal(run('pixel-fix.mjs', ['--in', 'native.png', '--patch', 'off.json', '--palette', 'palette.hex', '--allow-off-palette', '--out', 'out/off.png'], cwd).status, 0);
    assert.match(run('pixel-fix.mjs', ['--in', 'native.png', '--patch', 'patch.json', '--out', 'native.png'], cwd).stderr, /different file/);
    writeFileSync(join(cwd, 'bad.json'), '[{"x":');
    assert.match(run('pixel-fix.mjs', ['--in', 'native.png', '--patch', 'bad.json'], cwd).stderr, /bad\.json is not valid JSON/);
});

test('trim-align writes every frame on the shared canvas with the feet on one line', async () => {
    const cwd = tempDir('sb-trimcli-');
    for (const [name, x, y, w, h] of [['a', 3, 2, 6, 10], ['b', 5, 4, 8, 14]]) {
        const frame = createRaster(20, 20);
        for (let row = y; row < y + h; row++) {
            for (let column = x; column < x + w; column++) {
                setPixel(frame, column, row, [200, 40, 50]);
            }
        }
        await writeRaster(join(cwd, `${name}.png`), frame);
    }
    const result = run('trim-align.mjs', ['--canvas', '32x32', '--baseline', '2', '--out-dir', 'out/aligned', 'a.png', 'b.png'], cwd);
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['a', 'b']) {
        const aligned = await readRaster(join(cwd, 'out', 'aligned', `${name}.png`));
        assert.deepEqual([aligned.width, aligned.height], [32, 32]);
        assert.deepEqual(getPixel(aligned, 16, 29).slice(3), [255], 'the last row of the sprite is row 29');
        assert.deepEqual(getPixel(aligned, 16, 30).slice(3), [0]);
    }
    assert.match(run('trim-align.mjs', ['--canvas', '8x8', 'a.png'], cwd).stderr, /does not fit/);
    assert.match(run('trim-align.mjs', ['a.png'], cwd).stderr, /Usage/);
});

test('palette-extract writes a draft .hex, .gpl and preview and says it is a draft', async () => {
    const cwd = tempDir('sb-palcli-');
    const sheet = createRaster(300, 300, [244, 241, 251, 255]);
    const hues = [[170, 150, 210], [200, 40, 60], [50, 30, 40], [240, 200, 170], [60, 160, 90], [230, 190, 40], [40, 90, 200], [230, 120, 40], [120, 70, 40], [30, 170, 190]];
    hues.forEach((colour, index) => {
        for (let y = 0; y < 40; y++) {
            for (let x = 0; x < 40; x++) {
                setPixel(sheet, 10 + (index % 5) * 55 + x, 10 + Math.floor(index / 5) * 60 + y, colour);
            }
        }
    });
    await writeRaster(join(cwd, 'sheet.png'), sheet);
    const result = run('palette-extract.mjs', ['--in', 'sheet.png', '--name', 'reisen', '--colours', '28'], cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(cwd, 'out', 'palettes', 'reisen-draft.hex'), 'utf8').trim().split('\n').length, 28);
    assert.ok(existsSync(join(cwd, 'out', 'palettes', 'reisen-draft.gpl')) && existsSync(join(cwd, 'out', 'palettes', 'reisen-draft.preview.png')));
    assert.match(result.stdout, /This is a DRAFT/);
    assert.match(run('palette-extract.mjs', ['--in', 'sheet.png', '--name', 'Reisen'], cwd).stderr, /--name/);
    assert.match(run('palette-extract.mjs', ['--in', 'sheet.png', '--name', 'reisen', '--colours', '10'], cwd).stderr, /24 to 32/);
});

test('every script prints a usage line and exits with 1 when given nothing', () => {
    const cwd = tempDir('sb-usage-');
    for (const script of ['pixelate.mjs', 'pixel-fix.mjs', 'trim-align.mjs', 'palette-extract.mjs', 'grid-image.mjs']) {
        const real = run(script, [], cwd);
        assert.equal(real.status, 1, script);
        assert.match(real.stderr, /^error: Usage/, script);
    }
});
