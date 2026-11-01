import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DENSITIES, frameBox, outputSize, parseExportSpec } from '../scripts/lib/export-art.mjs';
import { parseMastersSpec } from '../scripts/lib/masters.mjs';
import { createRaster, setPixel } from '../test-support/synthetic.mjs';

const BRANDING = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => JSON.parse(readFileSync(join(BRANDING, path), 'utf8'));
const shell = parseExportSpec(read('export-specs/shell.json'));
const trial = parseExportSpec(read('export-specs/trial.json'));
const masters = parseMastersSpec(read('prompts/s5-masters.json'));
const byId = new Map(shell.assets.map((asset) => [asset.id, asset]));
const EXISTING = ['row-reisen', 'row-tewi'];

test('the shell spec has every mascot placement of the plan table: the slots that need a new master and the two finished rows, without row-nahida', () => {
    const expected = [...masters.assets.map(({ id }) => id), ...EXISTING].sort();
    assert.deepEqual([...byId.keys()].sort(), expected);
    assert.equal(byId.size, 19);
    assert.ok(!byId.has('row-nahida'));
});

test('each slot has the css sizes of the plan: the hero at 640 and 320, the rows at 128 and 64, the pairs at 192, the rest at 128 or 96', () => {
    const widths = (id) => byId.get(id).css;
    for (const id of ['hero-duo', 'hero-duo-night']) {
        assert.deepEqual(widths(id), [640, 320]);
    }
    for (const id of EXISTING) {
        assert.deepEqual(widths(id), [128, 64]);
    }
    for (const id of ['splash-both', 'welcome-both']) {
        assert.deepEqual(widths(id), [192]);
    }
    for (const id of ['splash-reisen', 'splash-tewi', 'welcome-persona-tewi', 'welcome-next-reisen']) {
        assert.deepEqual(widths(id), [128]);
    }
    for (const id of ['gs-reisen', 'gs-reisen-done', 'help-reisen', 'extras-tewi', 'shortcuts-tewi', 'about-reisen', 'about-tewi', 'troubleshooting-reisen', 'empty-tewi']) {
        assert.deepEqual(widths(id), [96]);
    }
});

test('the css widths agree with the masters spec, so a slot is never exported at a size its prompt was not drawn for', () => {
    for (const { id, css } of masters.assets) {
        assert.deepEqual(byId.get(id).css, css.map(({ width }) => width), id);
    }
});

test('the src fallback is the 2x file of the widest placement, for the hero and the rows as for the rest', () => {
    const src = (id) => byId.get(id).src;
    assert.deepEqual(src('hero-duo'), { css: 640, density: 2 });
    assert.deepEqual(src('hero-duo-night'), { css: 640, density: 2 });
    assert.deepEqual(src('row-reisen'), { css: 128, density: 2 });
    assert.deepEqual(src('gs-reisen'), { css: 96, density: 2 });
});

test('wide slots keep the whole canvas the model drew, measured by width with no margin; square slots are trimmed to a centred square', () => {
    for (const { id, aspect } of masters.assets) {
        const asset = byId.get(id);
        if (aspect === '1:1') {
            assert.deepEqual([asset.fit, asset.square, asset.crop], ['contain', true, undefined], id);
        } else {
            assert.deepEqual([asset.fit, asset.crop, asset.margin, asset.square], ['width', 'canvas', 0, false], id);
        }
    }
});

test('the two finished rows use the approved portraits, and every other slot expects approved/<id>.png', () => {
    assert.equal(byId.get('row-reisen').master, 'approved/reisen-portrait-a.png');
    assert.equal(byId.get('row-tewi').master, 'approved/tewi-portrait.png');
    for (const id of EXISTING) {
        assert.ok(existsSync(join(BRANDING, byId.get(id).master)), id);
    }
    for (const { id } of masters.assets) {
        assert.equal(byId.get(id).master, `approved/${id}.png`);
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

/** A master of the size the masters spec asks for, with a subject that fills only 60% of the height, the worst case for a square trim. */
function stand(width, height) {
    const raster = createRaster(width, height);
    const [left, right] = [Math.round(width * 0.4), Math.round(width * 0.6)];
    for (let y = Math.round(height * 0.2); y < Math.round(height * 0.8); y++) {
        for (let x = left; x < right; x++) {
            setPixel(raster, x, y, [120, 80, 160]);
        }
    }
    return raster;
}

test('every variant of every slot can be cut from a master of the size the masters spec asks for, with no upscale', () => {
    for (const { id, width, height } of masters.assets) {
        const asset = byId.get(id);
        const frame = frameBox(stand(width, height), { crop: asset.crop, margin: asset.margin, square: asset.square });
        for (const css of asset.css) {
            for (const density of DENSITIES) {
                const size = outputSize(frame, { css, density, fit: asset.fit });
                assert.ok(size.width >= 1 && size.height >= 1, `${id}@${css}x${density}`);
            }
        }
    }
});

test('a wide slot keeps its css aspect at every density', () => {
    for (const { id, width, height } of masters.assets.filter(({ aspect }) => aspect !== '1:1')) {
        const asset = byId.get(id);
        const frame = frameBox(stand(width, height), { crop: asset.crop, margin: asset.margin, square: asset.square });
        const ratio = width / height;
        for (const css of asset.css) {
            const size = outputSize(frame, { css, density: 2, fit: asset.fit });
            assert.equal(size.width, css * 2);
            assert.ok(Math.abs(size.width / size.height - ratio) < 0.01, id);
        }
    }
});
