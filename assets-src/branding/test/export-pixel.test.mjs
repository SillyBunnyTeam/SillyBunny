import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { assertSnapped, encodeNative, parseExportSpec } from '../scripts/lib/export-art.mjs';
import { exportAssets, variantLines } from '../scripts/lib/export-run.mjs';
import { sha256 } from '../scripts/lib/log.mjs';
import { readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { renderExportSheets } from '../scripts/lib/export-sheets.mjs';
import { createRaster, getPixel, nativeSprite, setPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'export-art.mjs');
const COLOURS = [[200, 40, 50], [40, 60, 200], [230, 210, 90], [60, 160, 90], [250, 250, 250]];

/** A package with a snapped still (60 x 70 art pixels, 6 empty around a 48 x 58 body) and a smooth master with soft edges. */
async function workspace() {
    const rootDir = tempDir('sb-pixel-export-');
    mkdirSync(join(rootDir, 'approved', 'pixel'), { recursive: true });
    const snapped = nativeSprite(60, 70, COLOURS, { seed: 9, margin: 6 });
    await writeRaster(join(rootDir, 'approved', 'pixel', 'hero.png'), snapped);
    const soft = createRaster(60, 70);
    setPixel(soft, 30, 30, [10, 10, 10, 120]);
    await writeRaster(join(rootDir, 'approved', 'soft.png'), soft);
    return { rootDir, snapped };
}

const spec = (assets, extra = {}) => parseExportSpec({ margin: 24, ...extra, assets });
const HERO = { character: 'reisen', master: 'approved/pixel/hero.png', pixel: true };

test('a pixel asset needs no css sizes, takes its margin and crop in art pixels, and defaults the margin to 2', () => {
    const [asset] = spec({ hero: HERO }).assets;
    assert.equal(asset.pixel, true);
    assert.equal(asset.margin, 2, 'the spec-wide margin of 24 is in source pixels and does not apply');
    assert.equal(asset.css, undefined);
    assert.deepEqual(asset.focus, [0.5, 0.3]);
    assert.equal(spec({ hero: { ...HERO, margin: 0, crop: [1, 2, 30, 40], square: true } }).assets[0].margin, 0);
    assert.equal(spec({ mixed: { master: 'a.png', css: [64] }, hero: HERO }).assets[0].pixel, undefined, 'the smooth path is unchanged');
});

test('a pixel asset refuses the keys that choose sizes and encoders, and a pixel flag that is not true or false', () => {
    for (const key of [['css', [64]], ['fit', 'width'], ['src', { css: 64, density: 2 }], ['webp', 'lossless']]) {
        assert.throws(() => spec({ hero: { ...HERO, [key[0]]: key[1] } }), new RegExp(`asset "hero": ${key[0]} does not apply to a pixel placement`));
    }
    assert.throws(() => spec({ hero: { ...HERO, pixel: 'yes' } }), /pixel must be true or false/);
    assert.throws(() => spec({ hero: { ...HERO, crop: [1, 2, 3] } }), /whole art pixels/);
    assert.throws(() => spec({ hero: { ...HERO, margin: -1 } }), /margin must be a whole number of 0 or more \(art pixels\)/);
});

test('the snapped picture is shipped at its own size, framed in art pixels, with every pixel as it was', async () => {
    const { rootDir, snapped } = await workspace();
    const { assets } = await exportAssets({ rootDir, spec: spec({ hero: HERO }), outDir: 'out/export' });
    const [hero] = assets;
    // The body is 48 x 58 art pixels inside a 6 pixel margin; the frame adds the default 2.
    assert.deepEqual(hero.frame, { x: 4, y: 4, width: 52, height: 62 });
    assert.deepEqual(hero.native, { width: 52, height: 62 });
    assert.equal(hero.variants.length, 1);
    const [variant] = hero.variants;
    assert.deepEqual([variant.width, variant.height, variant.native, variant.src], [52, 62, true, true]);
    assert.match(variant.file, /^hero@native\.(png|webp)$/);
    const path = join(rootDir, 'out', 'export', variant.file);
    const shipped = await readRaster(path);
    assert.deepEqual([shipped.width, shipped.height], [52, 62]);
    for (const [x, y] of [[2, 2], [10, 20], [30, 40], [49, 59]]) {
        assert.deepEqual(getPixel(shipped, x, y), getPixel(snapped, x + 4, y + 4), `pixel ${x},${y} is the still's own`);
    }
    assert.equal(getPixel(shipped, 0, 0)[3], 0, 'the margin is transparent');
    assert.equal(readFileSync(path).length, variant.bytes);
    assert.equal(sha256(readFileSync(path)).length, 64);
});

test('it keeps the smaller of the lossless PNG and the lossless WebP, and the PNG when they are the same size', async () => {
    const { snapped } = await workspace();
    const encoded = await encodeNative(snapped);
    assert.equal(encoded.buffer.length, Math.min(encoded.candidates.png.bytes, encoded.candidates.webp.bytes));
    assert.equal(encoded.format, encoded.candidates.webp.bytes < encoded.candidates.png.bytes ? 'webp' : 'png');
    const decoded = await sharp(encoded.buffer).ensureAlpha().raw().toBuffer();
    assert.ok(decoded.equals(snapped.data), 'both encodings are lossless');
    const flat = createRaster(8, 8, [10, 20, 30, 255]);
    const flatEncoded = await encodeNative(flat);
    assert.ok(['png', 'webp'].includes(flatEncoded.format));
    assert.ok(flatEncoded.candidates.png.bytes > 0 && flatEncoded.candidates.webp.bytes > 0);
});

test('the manifest records the native size, the format and the pixel flag, and has no css or density to choose from', async () => {
    const { rootDir } = await workspace();
    await exportAssets({ rootDir, spec: spec({ hero: HERO }), outDir: 'out/export' });
    const manifest = JSON.parse(readFileSync(join(rootDir, 'out', 'export', 'manifest.json'), 'utf8'));
    const entry = manifest.assets.hero;
    assert.equal(entry.pixel, true);
    assert.deepEqual(entry.native, { width: 52, height: 62 });
    assert.equal(entry.master, 'approved/pixel/hero.png');
    assert.equal(entry.masterSha256, sha256(readFileSync(join(rootDir, 'approved', 'pixel', 'hero.png'))));
    assert.equal(entry.fit, undefined);
    assert.match(entry.src, /^hero@native\.(png|webp)$/);
    assert.equal(entry.encoding.mode, 'lossless');
    assert.match(entry.encoding.format, /^(png|webp)$/);
    const [variant] = entry.variants;
    assert.equal(variant.native, true);
    assert.equal(variant.css, undefined);
    assert.equal(variant.density, undefined);
    assert.equal(variant.buffer, undefined);
});

test('smooth and pixel assets share one run and one manifest, and a smooth asset still has its sizes', async () => {
    const { rootDir } = await workspace();
    const big = createRaster(200, 200);
    for (let y = 40; y < 160; y++) {
        for (let x = 40; x < 160; x++) {
            setPixel(big, x, y, [90 + (x % 50), 80, 170]);
        }
    }
    await writeRaster(join(rootDir, 'approved', 'smooth.png'), big);
    const { assets } = await exportAssets({ rootDir, spec: spec({ hero: HERO, smooth: { master: 'approved/smooth.png', css: [50] } }), outDir: 'out/export' });
    assert.deepEqual(assets.map(({ id, pixel }) => [id, pixel ?? false]), [['hero', true], ['smooth', false]]);
    assert.deepEqual(assets[1].variants.map(({ file }) => file), ['smooth@50x1.webp', 'smooth@50x2.webp', 'smooth@50x3.webp']);
    const manifest = JSON.parse(readFileSync(join(rootDir, 'out', 'export', 'manifest.json'), 'utf8'));
    assert.equal(manifest.assets.smooth.pixel, undefined);
    assert.equal(manifest.assets.smooth.fit, 'contain');
});

test('files of an earlier export of the asset are removed, whichever extension they had, and other assets are kept', async () => {
    const { rootDir } = await workspace();
    const out = join(rootDir, 'out', 'export');
    mkdirSync(out, { recursive: true });
    for (const stale of ['hero@native.png', 'hero@native.webp', 'hero@64x1.webp', 'other@native.png']) {
        writeFileSync(join(out, stale), 'old');
    }
    await exportAssets({ rootDir, spec: spec({ hero: HERO }), outDir: 'out/export' });
    const names = readdirSync(out).sort();
    assert.equal(names.filter((name) => name.startsWith('hero@')).length, 1);
    assert.ok(names.includes('other@native.png'));
});

test('a master that is not a snapped still is refused with the way out, and nothing is written', async () => {
    const { rootDir } = await workspace();
    await assert.rejects(exportAssets({ rootDir, spec: spec({ soft: { master: 'approved/soft.png', pixel: true } }), outDir: 'out/export' }), /soft: the master approved\/soft\.png has translucent pixels, so it is not a snapped still/);
    assert.equal(existsSync(join(rootDir, 'out', 'export')), false);
    assert.doesNotThrow(() => assertSnapped(createRaster(2, 2, [1, 2, 3, 255]), 'x'), 'a picture with only opaque and transparent pixels is a snapped still');
});

test('a crop in art pixels and a square frame work as they do for smooth assets', async () => {
    const { rootDir } = await workspace();
    const { assets } = await exportAssets({ rootDir, spec: spec({ hero: { ...HERO, crop: [6, 6, 20, 30], margin: 0, square: true } }), outDir: 'out/export' });
    assert.deepEqual(assets[0].native, { width: 30, height: 30 });
});

test('the label of a native variant says it is native and lossless, and the sheet shows the file as it ships', async () => {
    const { rootDir } = await workspace();
    const { assets, outDir } = await exportAssets({ rootDir, spec: spec({ hero: HERO }), outDir: 'out/export' });
    const lines = variantLines(assets[0], assets[0].variants[0]);
    assert.equal(lines[0], 'hero@native');
    assert.match(lines[1], /^52x62 native/);
    assert.match(lines[2], /lossless (png|webp)$/);
    const [sheet] = await renderExportSheets(assets, join(outDir, 'sheets'));
    assert.ok(existsSync(sheet));
});

test('export-art.mjs accepts a pixel spec and names the asset whose master is missing', async () => {
    const { rootDir } = await workspace();
    const specPath = join(rootDir, 'spec.json');
    writeFileSync(specPath, JSON.stringify({ assets: { hero: { ...HERO, master: 'approved/pixel/no-such-picture-for-this-test.png' } } }));
    // The script reads masters from the real package, which has no such picture, so nothing is written there.
    const result = spawnSync('node', [SCRIPT, '--spec', specPath, '--out-dir', 'out/export-pixel-test'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hero: the master approved\/pixel\/no-such-picture-for-this-test\.png does not exist/);
});
