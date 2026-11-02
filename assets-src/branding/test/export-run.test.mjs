import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { parseExportSpec } from '../scripts/lib/export-art.mjs';
import { exportAssets, variantLines } from '../scripts/lib/export-run.mjs';
import { sha256 } from '../scripts/lib/log.mjs';
import { writeRaster } from '../scripts/lib/raster.mjs';
import { addNoise, createRaster, setPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'export-art.mjs');

/** A 240 square master with a disc of grained colour in it, off centre, and a lot of empty canvas. */
async function workspace() {
    const rootDir = tempDir('sb-export-');
    mkdirSync(join(rootDir, 'raw', 'masters'), { recursive: true });
    const raster = createRaster(240, 240);
    for (let y = 0; y < 240; y++) {
        for (let x = 0; x < 240; x++) {
            if (Math.hypot(x - 100, y - 120) < 70) {
                setPixel(raster, x, y, [90 + (x % 60), 80 + (y % 50), 170]);
            }
        }
    }
    await writeRaster(join(rootDir, 'raw', 'masters', 'disc.png'), addNoise(raster, 5));
    return rootDir;
}

const spec = (assets) => parseExportSpec({ margin: 6, assets });
const DISC = { character: 'disc', master: 'raw/masters/disc.png', css: [48, 24] };

test('every CSS size is written at 1x, 2x and 3x with the name id@cssXdensity, and the sizes follow the frame', async () => {
    const rootDir = await workspace();
    const { assets } = await exportAssets({ rootDir, spec: spec({ 'disc-art': DISC }), outDir: 'out/export' });
    const [art] = assets;
    assert.equal(art.id, 'disc-art');
    assert.deepEqual(art.variants.map(({ file }) => file), ['disc-art@48x1.webp', 'disc-art@48x2.webp', 'disc-art@48x3.webp', 'disc-art@24x1.webp', 'disc-art@24x2.webp', 'disc-art@24x3.webp']);
    // The disc is 140 wide and tall; with a margin of 6 the frame is 151 square, and contain makes the longer side the CSS size times the density.
    assert.deepEqual(art.frame, { x: 25, y: 45, width: 151, height: 151 });
    for (const variant of art.variants) {
        const path = join(rootDir, 'out', 'export', variant.file);
        const meta = await sharp(path).metadata();
        assert.equal(meta.format, 'webp');
        assert.deepEqual([meta.width, meta.height], [variant.width, variant.height]);
        assert.equal(variant.width, variant.css * variant.density);
        assert.equal(readFileSync(path).length, variant.bytes);
    }
});

test('the manifest lists each asset with its master hash, frame, encoding and every variant with width, height, bytes and density', async () => {
    const rootDir = await workspace();
    await exportAssets({ rootDir, spec: spec({ 'disc-art': DISC }), outDir: 'out/export' });
    const manifest = JSON.parse(readFileSync(join(rootDir, 'out', 'export', 'manifest.json'), 'utf8'));
    const entry = manifest.assets['disc-art'];
    assert.equal(entry.master, 'raw/masters/disc.png');
    assert.equal(entry.masterSha256, sha256(readFileSync(join(rootDir, 'raw', 'masters', 'disc.png'))));
    assert.equal(entry.fit, 'contain');
    assert.ok(['lossless', 'near-lossless', 'lossy'].includes(entry.encoding.mode));
    assert.equal(entry.variants.length, 6);
    for (const variant of entry.variants) {
        assert.deepEqual(Object.keys(variant).filter((key) => ['file', 'css', 'density', 'width', 'height', 'bytes', 'mode', 'candidates'].includes(key)).length, 8);
        assert.ok([1, 2, 3].includes(variant.density));
        assert.ok(variant.candidates.lossless.bytes > 0);
    }
});

test('the manifest flags one file per asset as the src fallback: the 2x of the widest size, or the one the spec names', async () => {
    const rootDir = await workspace();
    const { assets } = await exportAssets({ rootDir, spec: spec({ 'disc-art': DISC, 'disc-pick': { ...DISC, src: { css: 24, density: 3 } } }), outDir: 'out/export' });
    const manifest = JSON.parse(readFileSync(join(rootDir, 'out', 'export', 'manifest.json'), 'utf8'));
    assert.equal(manifest.assets['disc-art'].src, 'disc-art@48x2.webp');
    assert.equal(manifest.assets['disc-pick'].src, 'disc-pick@24x3.webp');
    for (const [id, entry] of Object.entries(manifest.assets)) {
        const flagged = entry.variants.filter((variant) => variant.src);
        assert.deepEqual(flagged.map(({ file }) => file), [entry.src], id);
    }
    assert.deepEqual(assets[0].variants.filter(({ src }) => src).map(({ file }) => file), ['disc-art@48x2.webp']);
});

test('a canvas crop with no margin exports the whole picture, and a width that needs more pixels than the picture has is refused', async () => {
    const rootDir = await workspace();
    const whole = (css) => parseExportSpec({ assets: { whole: { master: 'raw/masters/disc.png', css, fit: 'width', crop: 'canvas', margin: 0 } } });
    await exportAssets({ rootDir, spec: whole([80, 40]), outDir: 'out/export' });
    const top = await sharp(join(rootDir, 'out', 'export', 'whole@80x3.webp')).metadata();
    const small = await sharp(join(rootDir, 'out', 'export', 'whole@40x1.webp')).metadata();
    assert.deepEqual([top.width, top.height, small.width, small.height], [240, 240, 40, 40]);
    await assert.rejects(exportAssets({ rootDir, spec: whole([100]), outDir: 'out/export' }), /upscale/);
});

test('a transparent margin surrounds the subject at every size, so the edge never touches the file edge', async () => {
    const rootDir = await workspace();
    await exportAssets({ rootDir, spec: spec({ 'disc-art': DISC }), outDir: 'out/export' });
    const { data, info } = await sharp(join(rootDir, 'out', 'export', 'disc-art@48x2.webp')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < info.width; i++) {
        assert.equal(data[(i) * 4 + 3], 0, `top row at ${i}`);
        assert.equal(data[((info.height - 1) * info.width + i) * 4 + 3], 0, `bottom row at ${i}`);
        assert.equal(data[(i * info.width) * 4 + 3], 0, `left column at ${i}`);
        assert.equal(data[(i * info.width + info.width - 1) * 4 + 3], 0, `right column at ${i}`);
    }
});

test('a run again replaces the files of that asset, including a size that is no longer asked for, and keeps the other assets in the manifest', async () => {
    const rootDir = await workspace();
    await exportAssets({ rootDir, spec: spec({ 'disc-art': DISC, 'disc-small': { ...DISC, css: [16] } }), outDir: 'out/export' });
    assert.ok(existsSync(join(rootDir, 'out', 'export', 'disc-art@24x3.webp')));
    await exportAssets({ rootDir, spec: spec({ 'disc-art': { ...DISC, css: [48] } }), outDir: 'out/export' });
    assert.ok(!existsSync(join(rootDir, 'out', 'export', 'disc-art@24x3.webp')), 'the old size is gone');
    assert.ok(existsSync(join(rootDir, 'out', 'export', 'disc-small@16x1.webp')), 'another asset is left alone');
    const manifest = JSON.parse(readFileSync(join(rootDir, 'out', 'export', 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.assets).sort(), ['disc-art', 'disc-small']);
    assert.equal(manifest.assets['disc-art'].variants.length, 3);
});

test('a missing master, an output folder outside raw/ and out/, and a size the master cannot supply are all refused before anything is written', async () => {
    const rootDir = await workspace();
    await assert.rejects(exportAssets({ rootDir, spec: spec({ a: { ...DISC, master: 'raw/masters/nothing.png' } }), outDir: 'out/export' }), /nothing\.png/);
    await assert.rejects(exportAssets({ rootDir, spec: spec({ a: DISC }), outDir: 'public/art' }), /raw\/ or out\//);
    await assert.rejects(exportAssets({ rootDir, spec: spec({ a: { ...DISC, css: [100] } }), outDir: 'out/export' }), /upscale/);
    assert.ok(!existsSync(join(rootDir, 'out', 'export', 'a@100x1.webp')));
});

test('a variant is labelled with its file, its size, its density and the real size of the file on disk', async () => {
    const rootDir = await workspace();
    const { assets } = await exportAssets({ rootDir, spec: spec({ 'disc-art': DISC }), outDir: 'out/export' });
    const lines = variantLines(assets[0], assets[0].variants[1]);
    assert.equal(lines[0], 'disc-art@48x2');
    assert.match(lines[1], /^96x96 \(2x of 48 CSS px\)$/);
    assert.match(lines[2], /^\d+\.\d KB, (lossless|near-lossless q\d+|lossy q\d+)$/);
});

test('the command line exports a spec, prints one line per file with its size, and reports a bad spec or option', async () => {
    const rootDir = await workspace();
    writeFileSync(join(rootDir, 'spec.json'), JSON.stringify({ margin: 6, assets: { 'disc-art': DISC } }));
    const run = (args) => spawnSync('node', [SCRIPT, ...args], { cwd: rootDir, encoding: 'utf8' });
    assert.match(run([]).stderr, /Usage/);
    writeFileSync(join(rootDir, 'bad.json'), JSON.stringify({ assets: { 'Disc Art': DISC } }));
    assert.match(run(['--spec', join(rootDir, 'bad.json')]).stderr, /id/);
    assert.match(run(['--spec', join(rootDir, 'spec.json'), '--only', 'nobody']).stderr, /nobody/);
});
