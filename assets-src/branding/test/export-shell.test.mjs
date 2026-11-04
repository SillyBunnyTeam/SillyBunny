import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getPixelArt, listPixelArtIds } from '../../../public/scripts/sillybunny-home/art-sources.js';
import { DENSITIES, frameBox, outputSize, parseExportSpec } from '../scripts/lib/export-art.mjs';
import { parseMastersSpec } from '../scripts/lib/masters.mjs';
import { readRaster } from '../scripts/lib/raster.mjs';

const BRANDING = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => JSON.parse(readFileSync(join(BRANDING, path), 'utf8'));
const shell = parseExportSpec(read('export-specs/shell.json'));
const trial = parseExportSpec(read('export-specs/trial.json'));
const masters = parseMastersSpec(read('prompts/s5-masters.json'));
const byId = new Map(shell.assets.map((asset) => [asset.id, asset]));
const EXISTING = ['row-reisen', 'row-tewi'];
const pixelAssets = shell.assets.filter((asset) => asset.pixel);
const smoothAssets = shell.assets.filter((asset) => !asset.pixel);
// The boot splash keeps its own table in public/scripts/sillybunny-splash.js, checked by tests/unit/sillybunny-splash.test.js.
const isSplash = ({ id }) => id.startsWith('splash-');

test('the shell spec has every mascot placement of the plan table: the slots that need a new master and the two finished rows, without row-nahida', () => {
    const expected = [...masters.assets.map(({ id }) => id), ...EXISTING].sort();
    assert.deepEqual([...byId.keys()].sort(), expected);
    assert.equal(byId.size, 19);
    assert.ok(!byId.has('row-nahida'));
});

test('only the two finished rows are smooth pictures; every other slot is a pixel placement', () => {
    assert.deepEqual(smoothAssets.map(({ id }) => id).sort(), EXISTING);
});

test('the rows are smooth: css 128 and 64, the whole portrait trimmed to a centred square, with the 2x file of the widest size as the src fallback', () => {
    for (const id of EXISTING) {
        const row = byId.get(id);
        assert.deepEqual(row.css, [128, 64], id);
        assert.deepEqual([row.fit, row.square, row.crop], ['contain', true, undefined], id);
        assert.deepEqual(row.src, { css: 128, density: 2 }, id);
    }
});

test('a pixel slot carries none of the keys that choose sizes and encoders, because it ships at the snapped picture\'s own size', () => {
    for (const asset of pixelAssets) {
        for (const key of ['css', 'fit', 'src', 'webp']) {
            assert.equal(asset[key], undefined, `${asset.id}.${key}`);
        }
    }
});

test('the two finished rows use the approved portraits, and every pixel slot is the snapped approved/pixel/<id>.png', () => {
    assert.equal(byId.get('row-reisen').master, 'approved/reisen-portrait-a.png');
    assert.equal(byId.get('row-tewi').master, 'approved/tewi-portrait.png');
    for (const { id } of masters.assets) {
        assert.equal(byId.get(id).master, `approved/pixel/${id}.png`);
    }
    for (const asset of shell.assets) {
        assert.ok(existsSync(join(BRANDING, asset.master)), asset.master);
    }
});

test('no export spec points at raw/, which is git-ignored and missing on a fresh checkout, and every trial master exists', () => {
    for (const asset of [...shell.assets, ...trial.assets]) {
        assert.ok(asset.master.startsWith('approved/'), `${asset.id}: ${asset.master}`);
    }
    for (const asset of trial.assets) {
        assert.ok(existsSync(join(BRANDING, asset.master)), asset.master);
    }
});

test('every row variant can be cut from its approved portrait with no upscale', async () => {
    for (const asset of smoothAssets) {
        const frame = frameBox(await readRaster(join(BRANDING, asset.master)), { crop: asset.crop, margin: asset.margin, square: asset.square });
        for (const css of asset.css) {
            for (const density of DENSITIES) {
                const size = outputSize(frame, { css, density, fit: asset.fit });
                assert.ok(size.width >= 1 && size.height >= 1, `${asset.id}@${css}x${density}`);
            }
        }
    }
});

test('the home art table lists exactly the pixel slots that are not the boot splash, each at the native size of its framed master', async () => {
    const homeAssets = pixelAssets.filter((asset) => !isSplash(asset));
    assert.deepEqual(listPixelArtIds().sort(), homeAssets.map(({ id }) => id).sort());
    for (const asset of homeAssets) {
        const frame = frameBox(await readRaster(join(BRANDING, asset.master)), { crop: asset.crop, margin: asset.margin, square: asset.square });
        const { width, height } = getPixelArt(asset.id);
        assert.deepEqual({ width: frame.width, height: frame.height }, { width, height }, asset.id);
    }
});

test('the frames of a pixel slot are snapped stills of the same size as its base picture', async () => {
    for (const asset of pixelAssets) {
        const base = await readRaster(join(BRANDING, asset.master));
        for (const { id, master } of asset.frames) {
            assert.ok(master.startsWith('approved/pixel/'), `${asset.id}--${id}: ${master}`);
            const picture = await readRaster(join(BRANDING, master));
            assert.deepEqual([picture.width, picture.height], [base.width, base.height], `${asset.id}--${id}`);
        }
    }
});
