import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decode, encoderVersions } from '../lib/codec.js';
import { runDerive, runProve } from '../lib/commands.js';
import { readIco } from '../lib/ico.js';
import { MANIFEST_PATH } from '../lib/manifest.js';
import { samePixels } from '../lib/raster.js';
import { fakeSha } from '../test-support/manifests.js';
import { paint } from '../test-support/pictures.js';
import { fixtureRepo, writeFixtureManifest } from '../test-support/repos.js';

const CLEAR = [0, 0, 0, 0];
const SHIP = 'public/img/sillybunny';

/** A canvas with one opaque block of `colour` at `box`. */
const block = (width, height, [x, y, w, h], colour = [200, 120, 220, 255]) => paint(width, height, (px, py) => (px >= x && px < x + w && py >= y && py < y + h ? colour : CLEAR));

function stillAsset(extra = {}) {
    return {
        type: 'still',
        key: 'home',
        master: 'fig/fig.png',
        ratio: '1',
        frame: { mode: 'subject', margin: 2 },
        grid: [10, 12],
        rings: null,
        outputs: [{ path: `${SHIP}/fig@native.webp`, encoding: 'webp-lossless', sha256: fakeSha('0') }],
        ...extra,
    };
}

const manifestOf = (assets) => ({ format: 1, encoder: encoderVersions(), assets });
const codes = (run) => run.result.problems.map(({ code }) => code);

async function repoWith(t, assets, masters) {
    const files = Object.fromEntries(Object.entries(masters).map(([path, content]) => [`assets-src/art/master/${path}`, content]));
    const root = await fixtureRepo(t, files);
    writeFixtureManifest(root, manifestOf(assets));
    return root;
}

test('a still is framed by its subject, written once, recorded in the manifest, and then proven', async (t) => {
    const root = await repoWith(t, { fig: stillAsset() }, { 'fig/fig.png': block(14, 14, [3, 2, 6, 8]) });

    const first = await runDerive({ root, write: true });
    assert.deepEqual(codes(first), []);
    assert.deepEqual(first.result.written, [`${SHIP}/fig@native.webp`]);
    assert.equal(first.result.manifestChanged, true);
    const shipped = await decode(readFileSync(join(root, SHIP, 'fig@native.webp')));
    assert.equal(samePixels(shipped, block(10, 12, [2, 2, 6, 8])), true);

    const again = await runDerive({ root, write: true });
    assert.deepEqual([again.result.changed, again.result.written, again.result.manifestChanged], [[], [], false]);
    assert.equal((await runProve({ root })).exitCode, 0);
});

test('a dry run reports the change and writes nothing', async (t) => {
    const root = await repoWith(t, { fig: stillAsset() }, { 'fig/fig.png': block(14, 14, [3, 2, 6, 8]) });

    const run = await runDerive({ root });

    assert.equal(run.result.changed.length, 1);
    assert.deepEqual(run.result.manifestStale, [`${SHIP}/fig@native.webp`]);
    assert.equal(existsSync(join(root, SHIP, 'fig@native.webp')), false);
});

test('a master that does not fit its placement, is translucent or is missing writes nothing', async (t) => {
    const cases = [
        [stillAsset({ grid: [9, 12] }), block(14, 14, [3, 2, 6, 8]), 'grid-mismatch'],
        [stillAsset(), paint(14, 14, (x, y) => (x === 5 && y === 5 ? [9, 9, 9, 128] : x > 3 && x < 9 && y > 2 && y < 10 ? [1, 2, 3, 255] : CLEAR)), 'master-not-native'],
        [stillAsset({ master: 'fig/other.png' }), block(14, 14, [3, 2, 6, 8]), 'master-missing'],
        [stillAsset({ ratio: '3/2' }), block(14, 14, [3, 2, 6, 8]), 'ratio-unsupported'],
    ];
    for (const [asset, master, code] of cases) {
        const root = await repoWith(t, { fig: asset }, { 'fig/fig.png': master });
        const run = await runDerive({ root, write: true });
        assert.deepEqual([codes(run), run.exitCode], [[code], 1], code);
        assert.equal(existsSync(join(root, SHIP, 'fig@native.webp')), false, code);
        assert.equal(readFileSync(join(root, MANIFEST_PATH), 'utf8').includes(fakeSha('0')), true, code);
    }
});

test('a frame is cut with the base box, may move inside it, and may not reach past it or have another canvas', async (t) => {
    const frames = { breath: { master: 'fig/fig--breath.png', outputs: [{ path: `${SHIP}/fig--breath@native.webp`, encoding: 'webp-lossless', sha256: fakeSha('1') }] } };
    const withFrame = (frame) => repoWith(t, { fig: stillAsset({ frames }) }, { 'fig/fig.png': block(14, 14, [3, 2, 6, 8]), 'fig/fig--breath.png': frame });

    const root = await withFrame(block(14, 14, [3, 3, 6, 7], [90, 40, 40, 255]));
    assert.deepEqual(codes(await runDerive({ root, write: true })), []);
    assert.equal(samePixels(await decode(readFileSync(join(root, SHIP, 'fig--breath@native.webp'))), block(10, 12, [2, 3, 6, 7], [90, 40, 40, 255])), true);

    assert.deepEqual(codes(await runDerive({ root: await withFrame(block(14, 14, [6, 2, 6, 8])) })), ['frame-box']);
    assert.deepEqual(codes(await runDerive({ root: await withFrame(block(10, 12, [2, 2, 6, 8])) })), ['frame-size']);
});

test('a still with no master of its own repeats a frame, and its motion may name only its own files', async (t) => {
    const asset = {
        type: 'still',
        key: 'splash',
        ratio: '1',
        frame: { mode: 'canvas' },
        grid: [10, 12],
        rings: null,
        frames: { idle: { master: 'fig/fig--idle.png', outputs: [{ path: `${SHIP}/fig--idle@native.webp`, encoding: 'webp-lossless', sha256: fakeSha('1') }] } },
        outputs: [{ path: `${SHIP}/fig@native.webp`, encoding: 'webp-lossless', from: 'idle', sha256: fakeSha('2') }],
        motion: { master: 'fig/fig--anim.json', output: `${SHIP}/fig--anim.json`, sha256: fakeSha('3') },
    };
    const motion = { grid: { width: 10, height: 12 }, layers: [{ id: 'fig', left: 0, top: 0, width: 10, height: 12, frames: { idle: 'fig--idle@native.webp' } }] };
    const root = await repoWith(t, { fig: asset }, { 'fig/fig--idle.png': block(10, 12, [2, 2, 6, 8]), 'fig/fig--anim.json': motion });

    assert.deepEqual(codes(await runDerive({ root, write: true })), []);
    assert.deepEqual(readFileSync(join(root, SHIP, 'fig@native.webp')), readFileSync(join(root, SHIP, 'fig--idle@native.webp')));
    assert.deepEqual(readFileSync(join(root, SHIP, 'fig--anim.json')), readFileSync(join(root, 'assets-src/art/master/fig/fig--anim.json')));

    for (const broken of [
        { ...motion, layers: [{ ...motion.layers[0], frames: { idle: 'other@native.webp' } }] },
        { ...motion, grid: { width: 11, height: 12 } },
        { ...motion, layers: [{ ...motion.layers[0], left: 1 }] },
    ]) {
        const brokenRoot = await repoWith(t, { fig: asset }, { 'fig/fig--idle.png': block(10, 12, [2, 2, 6, 8]), 'fig/fig--anim.json': broken });
        assert.deepEqual(codes(await runDerive({ root: brokenRoot })), ['motion-invalid']);
    }
});

test('a scene must give its still back from the backdrop and the composing pictures of its layers', async (t) => {
    const still = paint(8, 6, (x, y) => (y === 5 ? [30, 30, 90, 255] : x >= 2 && x < 5 && y >= 1 && y < 5 ? [240, 200, 180, 255] : CLEAR));
    const scene = {
        type: 'scene',
        key: 'home',
        master: 'duo/duo.png',
        ratio: '1',
        frame: { mode: 'canvas' },
        grid: [8, 6],
        outputs: [{ path: `${SHIP}/duo@native.webp`, encoding: 'webp-lossless', sha256: fakeSha('1') }],
        backdrop: { master: 'duo/duo--backdrop.png', outputs: [{ path: `${SHIP}/duo--backdrop@native.webp`, encoding: 'webp-lossless', sha256: fakeSha('2') }] },
        layers: { fig: { box: [2, 1, 3, 4], pictures: { 'breath-c': { master: 'duo/duo--fig--breath-c.png', outputs: [{ path: `${SHIP}/duo--fig--breath-c@native.webp`, encoding: 'webp-lossless', sha256: fakeSha('3') }] } } } },
        compose: { pose: 'breath-c' },
        motion: { master: 'duo/duo--breath.json', output: `${SHIP}/duo--breath.json`, sha256: fakeSha('4') },
    };
    const files = {
        'duo/duo.png': still,
        'duo/duo--backdrop.png': paint(8, 6, (x, y) => (y === 5 ? [30, 30, 90, 255] : CLEAR)),
        'duo/duo--fig--breath-c.png': paint(3, 4, () => [240, 200, 180, 255]),
        'duo/duo--breath.json': { grid: { width: 8, height: 6 }, backdrop: 'duo--backdrop@native.webp', layers: [{ id: 'fig', left: 2, top: 1, width: 3, height: 4, images: { c: { base: 'duo--fig--breath-c@native.webp' } } }] },
    };
    assert.deepEqual(codes(await runDerive({ root: await repoWith(t, { duo: scene }, files), write: true })), []);

    const stale = await repoWith(t, { duo: scene }, { ...files, 'duo/duo--fig--breath-c.png': paint(3, 4, () => [240, 200, 181, 255]) });
    assert.deepEqual(codes(await runDerive({ root: stale })), ['composition-mismatch']);
    const tooBig = await repoWith(t, { duo: { ...scene, layers: { fig: { ...scene.layers.fig, box: [6, 1, 3, 4] } } } }, files);
    assert.deepEqual(codes(await runDerive({ root: tooBig })), ['layer-box']);
    const otherCanvas = await repoWith(t, { duo: scene }, { ...files, 'duo/duo--backdrop.png': paint(8, 7, () => [30, 30, 90, 255]) });
    assert.deepEqual(codes(await runDerive({ root: otherCanvas })), ['backdrop-size']);
});

test('a backdrop drawn on the scene master canvas is cut with the still box', async (t) => {
    const master = paint(12, 9, (x, y) => (y === 7 && x >= 2 && x < 10 ? [30, 30, 90, 255] : x >= 4 && x < 7 && y >= 3 && y < 7 ? [240, 200, 180, 255] : CLEAR));
    const scene = {
        type: 'scene',
        key: 'home',
        master: 'duo/duo.png',
        ratio: '1',
        frame: { mode: 'subject', margin: 1 },
        grid: [10, 7],
        outputs: [{ path: `${SHIP}/duo@native.webp`, encoding: 'webp-lossless', sha256: fakeSha('1') }],
        backdrop: { master: 'duo/duo--backdrop.png', outputs: [{ path: `${SHIP}/duo--backdrop@native.webp`, encoding: 'webp-lossless', sha256: fakeSha('2') }] },
        layers: { fig: { box: [3, 1, 3, 4], pictures: { 'breath-c': { master: 'duo/duo--fig--breath-c.png', outputs: [{ path: `${SHIP}/duo--fig--breath-c@native.webp`, encoding: 'webp-lossless', sha256: fakeSha('3') }] } } } },
        compose: { pose: 'breath-c' },
        motion: { master: 'duo/duo--breath.json', output: `${SHIP}/duo--breath.json`, sha256: fakeSha('4') },
    };
    const root = await repoWith(t, { duo: scene }, {
        'duo/duo.png': master,
        'duo/duo--backdrop.png': paint(12, 9, (x, y) => (y === 7 && x >= 2 && x < 10 ? [30, 30, 90, 255] : CLEAR)),
        'duo/duo--fig--breath-c.png': paint(3, 4, () => [240, 200, 180, 255]),
        'duo/duo--breath.json': { grid: { width: 10, height: 7 }, backdrop: 'duo--backdrop@native.webp', layers: [{ id: 'fig', left: 3, top: 1, width: 3, height: 4, images: { c: { base: 'duo--fig--breath-c@native.webp' } } }] },
    });

    assert.deepEqual(codes(await runDerive({ root, write: true })), []);
    const backdrop = await decode(readFileSync(join(root, SHIP, 'duo--backdrop@native.webp')));
    assert.equal(samePixels(backdrop, paint(10, 7, (x, y) => (y === 5 && x >= 1 && x < 9 ? [30, 30, 90, 255] : CLEAR))), true);
});

test('an icon keeps its channels and size, an ICO packs its icons, and a copy ships its master byte for byte', async (t) => {
    const plate = paint(4, 4, (x, y) => (x === 0 && y === 0 ? CLEAR : [120, 90, 200, 255]));
    const platform = paint(4, 4, () => [120, 90, 200, 255], 3);
    const assets = {
        'icon-4': { type: 'icon', key: null, master: 'logo/logo-4.png', grid: [4, 4], outputs: [{ path: 'public/img/icon-4x4.png', encoding: 'png', sha256: fakeSha('1') }] },
        'platform-4': { type: 'icon', key: null, master: 'logo/platform-4.png', grid: [4, 4], outputs: [{ path: 'public/img/apple-icon-4x4.png', encoding: 'png', sha256: fakeSha('2') }] },
        favicon: { type: 'ico', key: null, entries: ['icon-4'], outputs: [{ path: 'public/favicon.ico', sha256: fakeSha('3') }] },
        'logo-svg': { type: 'copy', key: null, master: 'logo/logo.svg', outputs: [{ path: `${SHIP}/logo.svg`, sha256: fakeSha('4') }] },
    };
    const root = await repoWith(t, assets, { 'logo/logo-4.png': plate, 'logo/platform-4.png': platform, 'logo/logo.svg': '<svg/>' });

    assert.deepEqual(codes(await runDerive({ root, write: true })), []);
    const pngColourType = (path) => readFileSync(join(root, path))[25];
    assert.deepEqual([pngColourType('public/img/icon-4x4.png'), pngColourType('public/img/apple-icon-4x4.png')], [6, 2]);
    assert.deepEqual(readIco(readFileSync(join(root, 'public/favicon.ico'))), [readFileSync(join(root, 'public/img/icon-4x4.png'))]);
    assert.equal(readFileSync(join(root, SHIP, 'logo.svg'), 'utf8'), '<svg/>');
    assert.equal((await runProve({ root, pixels: true })).exitCode, 0);

    const wrong = await repoWith(t, { 'icon-4': { ...assets['icon-4'], grid: [5, 5] } }, { 'logo/logo-4.png': plate });
    assert.deepEqual(codes(await runDerive({ root: wrong })), ['grid-mismatch']);
});
