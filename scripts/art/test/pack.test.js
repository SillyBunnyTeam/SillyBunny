import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decode, encode } from '../lib/codec.js';
import { runBump, runCheck, runDerive, runProve } from '../lib/commands.js';
import { managedItemsOf } from '../lib/managed.js';
import { MASTER_ROOT, readManifest, validateManifest } from '../lib/manifest.js';
import { samePixels, upscaleNearest } from '../lib/raster.js';
import { PACK_GRID, PACK_STEP, REISEN_PACK_FOLDER, copyWithPack, packMasterOf, packSprite } from '../test-support/pack-copy.js';
import { paint } from '../test-support/pictures.js';

const MANAGED = 'default/content/sillybunny-managed.json';
const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const codes = (run) => run.result.problems.map(({ code }) => code);
const packOf = (root) => readManifest(root).manifest.assets['expressions-reisen'];
const problemsOf = (root, pack) => {
    const { manifest } = readManifest(root);
    return validateManifest({ ...manifest, assets: { ...manifest.assets, 'expressions-reisen': pack } }).map(({ message }) => message);
};

test('a pack entry that follows the rules is a valid manifest entry', async (t) => {
    const { root } = await copyWithPack(t);

    assert.deepEqual(validateManifest(readManifest(root).manifest), []);
});

test('a pack ships each sprite at one whole step, in lossless WebP, as one file per expression in one folder', async (t) => {
    const { root } = await copyWithPack(t);
    const pack = packOf(root);
    const [first, second] = Object.keys(pack.frames);
    const mutate = (change) => {
        const copy = structuredClone(pack);
        change(copy);
        return problemsOf(root, copy);
    };

    assert.match(mutate((entry) => { entry.key = 'home'; }).join('\n'), /key must be null/);
    assert.match(mutate((entry) => { entry.frames[second].outputs[0].scale = PACK_STEP + 1; }).join('\n'), /one step/);
    assert.match(mutate((entry) => { entry.frames[first].outputs[0].encoding = 'png'; }).join('\n'), /webp-lossless/);
    assert.match(mutate((entry) => { entry.frames[first].outputs.push({ ...entry.frames[first].outputs[0], path: 'default/content/Assistant Reisen/other.webp' }); }).join('\n'), /exactly one file/);
    assert.match(mutate((entry) => { entry.frames[first].outputs[0].path = `default/content/Assistant Reisen/${second}.webp`; }).join('\n'), /named after/);
    assert.match(mutate((entry) => { entry.frames[second].outputs[0].path = `default/content/Assistant Tewi/${second}.webp`; }).join('\n'), /one folder/);
    assert.match(mutate((entry) => { entry.frames[first].outputs[0].from = second; }).join('\n'), /unknown key "from"/);
    assert.match(mutate((entry) => { entry.frames = {}; }).join('\n'), /at least one expression/);
    assert.match(mutate((entry) => { entry.grid = [8.5, 12]; }).join('\n'), /grid must be/);
});

test('the derive enlarges each master by the step and by nothing else, and the proof and the check pass', async (t) => {
    const { root, names } = await copyWithPack(t);

    const derived = await runDerive({ root, write: true, only: ['expressions-reisen'] });

    assert.deepEqual(codes(derived), []);
    assert.equal(derived.result.summary.outputs, names.length);
    for (const [at, name] of names.entries()) {
        const shipped = await decode(readFileSync(join(root, REISEN_PACK_FOLDER, `${name}.webp`)));
        assert.ok(samePixels(shipped, upscaleNearest(packSprite(at), PACK_STEP)), `${name} is its master with every pixel drawn ${PACK_STEP} by ${PACK_STEP}`);
    }
    assert.equal((await runProve({ root, only: ['expressions-reisen'] })).exitCode, 0);
    assert.equal((await runProve({ root, only: ['expressions-reisen'], pixels: true })).exitCode, 0);
    assert.deepEqual((await runDerive({ root, write: true, only: ['expressions-reisen'] })).result.written, [], 'a second derive writes nothing');
});

test('the derive refuses a master of another grid and a master with a soft edge', async (t) => {
    const { root, names } = await copyWithPack(t);
    const [name] = names;
    writeFileSync(join(root, MASTER_ROOT, packMasterOf(name)), await encode(paint(PACK_GRID[0] + 1, PACK_GRID[1], () => [10, 10, 10, 255]), 'png'));

    const wrongGrid = await runDerive({ root, only: ['expressions-reisen'] });

    assert.deepEqual(codes(wrongGrid), ['grid-mismatch']);
    assert.match(wrongGrid.result.problems[0].message, new RegExp(`${PACK_GRID[0] + 1}x${PACK_GRID[1]} art pixels, but its placement grid is ${PACK_GRID.join('x')}`));

    writeFileSync(join(root, MASTER_ROOT, packMasterOf(name)), await encode(paint(...PACK_GRID, () => [10, 10, 10, 128]), 'png'));
    assert.deepEqual(codes(await runDerive({ root, only: ['expressions-reisen'] })), ['master-not-native']);
});

test('check wants a provenance record for each sprite and lists a file of the folder that the pack does not ship', async (t) => {
    const { root, names } = await copyWithPack(t);
    assert.deepEqual(codes(await runCheck({ root })).filter((code) => code !== 'notice-stale'), []);

    writeFileSync(join(root, MASTER_ROOT, packMasterOf(names[0]).replace(/\.png$/, '.provenance.json')), '{}\n');
    writeFileSync(join(root, REISEN_PACK_FOLDER, 'extra.webp'), 'x');
    const found = codes(await runCheck({ root }));

    assert.ok(found.includes('provenance-invalid'));
    assert.ok(found.includes('unlisted-file'));
});

test('a changed pack is a problem for check, and bump --write raises the version of its sprites item and keeps the earlier hashes', async (t) => {
    const { root, names } = await copyWithPack(t);
    const before = readJson(root, MANAGED);
    const managedCodes = async () => codes(await runCheck({ root })).filter((code) => code.startsWith('managed-'));
    assert.deepEqual(await managedCodes(), [], 'the files are still the shipped ones');
    assert.deepEqual(managedItemsOf(readManifest(root).manifest).map(({ type, filename, asset }) => [type, filename, asset]), [['sprites', 'Assistant Reisen', 'expressions-reisen']]);

    await runDerive({ root, write: true, only: ['expressions-reisen'] });

    const stale = (await runCheck({ root })).result.problems.filter(({ code }) => code.startsWith('managed-'));
    assert.deepEqual(stale.map(({ code, asset, path }) => [code, asset, path]), [['managed-stale', 'expressions-reisen', REISEN_PACK_FOLDER]]);
    assert.match(stale[0].message, /records version 1 of Assistant Reisen .* raises it to version 2\.$/);
    const planned = await runBump({ root });
    assert.deepEqual([codes(planned), planned.result.managed], [[], [{ asset: 'expressions-reisen', item: 'Assistant Reisen', type: 'sprites', from: 1, to: 2 }]]);
    assert.deepEqual(readJson(root, MANAGED), before, 'a bump without --write writes nothing');

    const bumped = await runBump({ root, write: true });

    assert.deepEqual([codes(bumped), bumped.result.written], [[], [MANAGED]]);
    const after = readJson(root, MANAGED);
    const [was, now] = [before, after].map((managed) => managed.items.find((item) => item.filename === 'Assistant Reisen'));
    assert.equal(now.version, 2);
    for (const file of now.files) {
        const earlier = was.files.find(({ name }) => name === file.name);
        assert.deepEqual(file.previous, [earlier.sha256, ...earlier.previous], `${file.name} keeps its earlier hash, so an untouched copy of version 1 is updated`);
    }
    assert.equal(now.files.length, names.length);
    assert.deepEqual(after.items.filter(({ filename }) => filename !== 'Assistant Reisen'), before.items.filter(({ filename }) => filename !== 'Assistant Reisen'));
    assert.deepEqual(await managedCodes(), []);
    assert.deepEqual((await runBump({ root })).result.managed, [], 'a second bump has nothing to raise');
});

test('a pack whose sprites item the managed manifest does not hold is a problem that names the command that adds it', async (t) => {
    const { root } = await copyWithPack(t);
    const managed = readJson(root, MANAGED);
    writeFileSync(join(root, MANAGED), `${JSON.stringify({ ...managed, items: managed.items.filter(({ filename }) => filename !== 'Assistant Reisen') }, null, 4)}\n`);

    const missing = (await runCheck({ root })).result.problems.filter(({ code }) => code === 'managed-missing');

    assert.equal(missing.length, 1);
    assert.match(missing[0].message, /node scripts\/build-managed-manifest\.js default\/content sprites:Assistant Reisen/);
});

test('bump --write refuses when a sprites folder that the art manifest does not ship changed too', async (t) => {
    const { root } = await copyWithPack(t);
    await runDerive({ root, write: true, only: ['expressions-reisen'] });
    writeFileSync(join(root, 'default/content/Assistant Tewi/joy.webp'), 'changed');

    const bumped = await runBump({ root, write: true });

    assert.deepEqual(codes(bumped), ['managed-unrelated']);
});
