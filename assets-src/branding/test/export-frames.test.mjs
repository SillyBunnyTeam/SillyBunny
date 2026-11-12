import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeNative, parseExportSpec } from '../scripts/lib/export-art.mjs';
import { exportAssets, variantLines } from '../scripts/lib/export-run.mjs';
import { sha256 } from '../scripts/lib/log.mjs';
import { readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { renderExportSheets } from '../scripts/lib/export-sheets.mjs';
import { createRaster, getPixel, nativeSprite, setPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const COLOURS = [[200, 40, 50], [40, 60, 200], [230, 210, 90], [60, 160, 90], [250, 250, 250]];
const BLINK = [{ id: 'blink', master: 'approved/pixel/hero--blink.png' }];
const HERO = { character: 'reisen', master: 'approved/pixel/hero.png', pixel: true, frames: BLINK };

const spec = (assets) => parseExportSpec({ assets });
const withPixel = (raster, x, y, colour) => {
    const copy = { ...raster, data: Buffer.from(raster.data) };
    setPixel(copy, x, y, colour);
    return copy;
};

/** A package with a snapped still `hero` (60 x 70 art pixels, a 48 x 58 body in a 6 pixel margin), and the same picture with one pixel changed as `hero--blink` and `hero--twitch`. */
async function workspace() {
    const rootDir = tempDir('sb-frames-');
    mkdirSync(join(rootDir, 'approved', 'pixel'), { recursive: true });
    const base = nativeSprite(60, 70, COLOURS, { seed: 9, margin: 6 });
    await writeRaster(join(rootDir, 'approved', 'pixel', 'hero.png'), base);
    await writeRaster(join(rootDir, 'approved', 'pixel', 'hero--blink.png'), withPixel(base, 30, 40, [1, 2, 3, 255]));
    await writeRaster(join(rootDir, 'approved', 'pixel', 'hero--twitch.png'), withPixel(base, 20, 15, [4, 5, 6, 255]));
    return { rootDir, base };
}

const readManifest = (rootDir) => JSON.parse(readFileSync(join(rootDir, 'out', 'export', 'manifest.json'), 'utf8'));

test('a pixel asset lists its frames after the base, each with an id and the still it is, and a smooth asset takes none', () => {
    const [asset] = spec({ hero: { ...HERO, frames: [...BLINK, { id: 'ear-twitch', master: 'approved/pixel/hero--twitch.png' }] } }).assets;
    assert.deepEqual(asset.frames, [{ id: 'blink', master: 'approved/pixel/hero--blink.png' }, { id: 'ear-twitch', master: 'approved/pixel/hero--twitch.png' }]);
    assert.deepEqual(spec({ hero: { ...HERO, frames: undefined } }).assets[0].frames, [], 'no frames is an empty list');
    const bad = (frames, message) => assert.throws(() => spec({ hero: { ...HERO, frames } }), message);
    bad([], /frames must be a list of/);
    bad('blink', /frames must be a list of/);
    bad([{ master: 'a.png' }], /frames\[0\]: id must be lowercase letters, digits and hyphens/);
    bad([{ id: 'Blink', master: 'a.png' }], /frames\[0\]: id must be lowercase/);
    bad([{ id: 'blink' }], /frames\[0\] \("blink"\): master must be the path/);
    bad([{ id: 'blink', master: 'a.png', extra: 1 }], /frames\[0\]: unknown key "extra"/);
    bad([{ id: 'blink', master: 'a.png' }, { id: 'blink', master: 'b.png' }], /frames\[1\]: two frames are called "blink"/);
    assert.throws(() => spec({ smooth: { master: 'a.png', css: [64], frames: BLINK } }), /asset "smooth": frames apply to a pixel placement only/);
});

test('every frame is shipped at the native size with the base\'s framing, so the files line up pixel for pixel', async () => {
    const { rootDir, base } = await workspace();
    const { assets } = await exportAssets({ rootDir, spec: spec({ hero: { ...HERO, frames: [...BLINK, { id: 'twitch', master: 'approved/pixel/hero--twitch.png' }] } }), outDir: 'out/export' });
    const [hero] = assets;
    assert.deepEqual(hero.frames.map(({ id }) => id), ['hero--blink', 'hero--twitch']);
    assert.equal(hero.variants.length, 1, 'the base is still the one variant of the asset');
    const format = hero.variants[0].format;
    const out = join(rootDir, 'out', 'export');
    const blink = await readRaster(join(out, `hero--blink@native.${format}`));
    const twitch = await readRaster(join(out, `hero--twitch@native.${format}`));
    const shippedBase = await readRaster(join(out, hero.variants[0].file));
    for (const shipped of [blink, twitch, shippedBase]) {
        assert.deepEqual([shipped.width, shipped.height], [52, 62], 'the base\'s frame, 2 art pixels around the body');
    }
    // The frame starts at 4,4 in the still, so the changed pixel 30,40 lies at 26,36.
    assert.deepEqual(getPixel(blink, 26, 36), [1, 2, 3, 255]);
    assert.deepEqual(getPixel(shippedBase, 26, 36), getPixel(base, 30, 40));
    assert.deepEqual(getPixel(twitch, 16, 11), [4, 5, 6, 255]);
    const different = [];
    for (let at = 0; at < blink.data.length; at += 4) {
        if (!blink.data.subarray(at, at + 4).equals(shippedBase.data.subarray(at, at + 4))) {
            different.push(at / 4);
        }
    }
    assert.deepEqual(different, [36 * 52 + 26], 'the blink differs from the base in its one pixel');
    assert.equal(hero.frames[0].variant.bytes, readFileSync(join(out, hero.frames[0].variant.file)).length);
});

test('the frames take the format of the base, whichever is smaller for them alone', async () => {
    const { base } = await workspace();
    for (const format of ['png', 'webp']) {
        const forced = await encodeNative(base, { format });
        assert.equal(forced.format, format);
        assert.ok(forced.buffer.length > 0);
    }
    assert.ok(['png', 'webp'].includes((await encodeNative(base)).format));
});

test('the manifest lists the base first and then the frames in order, with their ids and files, and keeps every key it had', async () => {
    const { rootDir } = await workspace();
    await exportAssets({ rootDir, spec: spec({ hero: { ...HERO, frames: [...BLINK, { id: 'twitch', master: 'approved/pixel/hero--twitch.png' }] } }), outDir: 'out/export' });
    const entry = readManifest(rootDir).assets.hero;
    const format = entry.encoding.format;
    assert.deepEqual(entry.frames.map(({ id, file }) => [id, file]), [['hero', `hero@native.${format}`], ['hero--blink', `hero--blink@native.${format}`], ['hero--twitch', `hero--twitch@native.${format}`]]);
    assert.deepEqual(entry.frames.map(({ master }) => master), ['approved/pixel/hero.png', 'approved/pixel/hero--blink.png', 'approved/pixel/hero--twitch.png']);
    assert.equal(entry.frames[1].masterSha256, sha256(readFileSync(join(rootDir, 'approved', 'pixel', 'hero--blink.png'))));
    assert.ok(entry.frames.every(({ bytes, format: kind }) => bytes > 0 && kind === format));
    assert.equal(entry.src, `hero@native.${format}`, 'src is still the base');
    assert.equal(entry.pixel, true);
    assert.deepEqual(entry.native, { width: 52, height: 62 });
    assert.equal(entry.variants.length, 1);
    assert.equal(entry.master, 'approved/pixel/hero.png');
});

test('an asset without frames has no frames key in the manifest, as before', async () => {
    const { rootDir } = await workspace();
    await exportAssets({ rootDir, spec: spec({ hero: { ...HERO, frames: undefined } }), outDir: 'out/export' });
    assert.equal(readManifest(rootDir).assets.hero.frames, undefined);
});

test('a frame of another size, with the figure somewhere else, not snapped or missing is refused with its name, and nothing is written', async () => {
    const { rootDir, base } = await workspace();
    const refuse = async (picture, message) => {
        await writeRaster(join(rootDir, 'approved', 'pixel', 'hero--blink.png'), picture);
        await assert.rejects(exportAssets({ rootDir, spec: spec({ hero: HERO }), outDir: 'out/export' }), message);
        assert.equal(existsSync(join(rootDir, 'out')), false);
    };
    await refuse(nativeSprite(61, 70, COLOURS, { seed: 9, margin: 6 }), /hero--blink: the frame picture approved\/pixel\/hero--blink\.png is 61x70 art pixels and the base approved\/pixel\/hero\.png is 60x70/);
    await refuse(withPixel(base, 1, 1, [9, 9, 9, 255]), /hero--blink: the figure of approved\/pixel\/hero--blink\.png is at 53x63 at 1,1 and the base's is at 48x58 at 6,6/);
    await refuse(withPixel(createRaster(60, 70), 30, 30, [10, 10, 10, 120]), /hero--blink: the frame picture approved\/pixel\/hero--blink\.png has translucent pixels, so it is not a snapped still/);
    await assert.rejects(exportAssets({ rootDir, spec: spec({ hero: { ...HERO, frames: [{ id: 'gone', master: 'approved/pixel/none.png' }] } }), outDir: 'out/export' }), /hero--gone: the frame picture approved\/pixel\/none\.png does not exist/);
});

test('exporting again with fewer frames removes the frame files of the earlier run and leaves other assets alone', async () => {
    const { rootDir } = await workspace();
    const out = join(rootDir, 'out', 'export');
    await exportAssets({ rootDir, spec: spec({ hero: { ...HERO, frames: [...BLINK, { id: 'twitch', master: 'approved/pixel/hero--twitch.png' }] } }), outDir: 'out/export' });
    writeFileSync(join(out, 'other@native.png'), 'other');
    writeFileSync(join(out, 'hero-extra@native.png'), 'a different asset whose name starts with the same letters');
    assert.equal(readdirSync(out).filter((name) => name.startsWith('hero--')).length, 2);
    await exportAssets({ rootDir, spec: spec({ hero: HERO }), outDir: 'out/export' });
    const names = readdirSync(out);
    assert.equal(names.filter((name) => name.startsWith('hero--twitch')).length, 0);
    assert.equal(names.filter((name) => name.startsWith('hero--blink')).length, 1);
    assert.ok(names.includes('other@native.png') && names.includes('hero-extra@native.png'));
    await exportAssets({ rootDir, spec: spec({ hero: { ...HERO, frames: undefined } }), outDir: 'out/export' });
    assert.equal(readdirSync(out).filter((name) => name.startsWith('hero--')).length, 0);
    assert.equal(readManifest(rootDir).assets.hero.frames, undefined);
});

test('the sheet shows every frame by its own name, as the file ships', async () => {
    const { rootDir } = await workspace();
    const { assets, outDir } = await exportAssets({ rootDir, spec: spec({ hero: HERO }), outDir: 'out/export' });
    assert.equal(variantLines(assets[0], assets[0].variants[0])[0], 'hero@native');
    assert.equal(variantLines(assets[0], assets[0].frames[0].variant)[0], 'hero--blink@native');
    const [sheet] = await renderExportSheets(assets, join(outDir, 'sheets'));
    assert.ok(existsSync(sheet));
});
