import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runDerive, runProve } from '../lib/commands.js';
import { MANIFEST_PATH, readManifest } from '../lib/manifest.js';
import { sha256, upscaleNearest } from '../lib/raster.js';
import { encode, encoderVersions } from '../lib/codec.js';
import { paint, REPO_ROOT } from '../test-support/pictures.js';
import { copyOfArt, fixtureRepo, writeFixtureManifest } from '../test-support/repos.js';

const codes = (run) => run.result.problems.map(({ code }) => code);

/** A checkout whose only asset is a pinned pair: a small picture, and `twice` of it as the second file. */
async function pinnedPair(t, twice) {
    const one = paint(3, 2, (x, y) => [x * 80, y * 100, 50, 255]);
    const bytes = [await encode(one, 'webp-lossless'), await encode(twice(one), 'webp-lossless')];
    const paths = ['public/img/sillybunny/pic.webp', 'public/img/sillybunny/pic@2x.webp'];
    const root = await fixtureRepo(t, Object.fromEntries(paths.map((path, index) => [path, bytes[index]])));
    const outputs = paths.map((path, index) => ({ path, sha256: sha256(bytes[index]) }));
    writeFixtureManifest(root, { format: 1, encoder: encoderVersions(), assets: { pic: { type: 'pinned', key: null, reason: 'No master yet.', checks: ['nearest-pair'], outputs } } });
    return root;
}

test('the shipped art is what its masters give, byte for byte', async () => {
    const run = await runProve({ root: REPO_ROOT });

    assert.deepEqual(run.result.problems, []);
    assert.equal(run.exitCode, 0);
    assert.equal(run.result.mode, 'bytes');
    assert.equal(run.result.summary.proven, run.result.summary.outputs);
});

test('a pixel proof says that it skipped the byte comparison of encoded pictures', async () => {
    const run = await runProve({ root: REPO_ROOT, pixels: true });

    assert.deepEqual(run.result.problems, []);
    assert.equal(run.result.mode, 'pixels');
    assert.match(run.result.byteComparison, /^skipped/);
});

test('deriving the adopted masters again changes no shipped file and no manifest byte', async (t) => {
    const root = copyOfArt(t);
    const manifestBefore = readFileSync(join(root, MANIFEST_PATH));

    const run = await runDerive({ root, write: true });

    assert.deepEqual(run.result.problems, []);
    assert.deepEqual(run.result.changed, []);
    assert.deepEqual(run.result.written, []);
    assert.equal(run.result.manifestChanged, false);
    assert.ok(run.result.summary.outputs > 0);
    assert.deepEqual(readFileSync(join(root, MANIFEST_PATH)), manifestBefore);
});

test('a changed shipped file and a stale manifest hash are told apart', async (t) => {
    const root = copyOfArt(t);
    const shipped = join(root, 'public/img/sillybunny/gs-reisen@native.webp');
    writeFileSync(shipped, Buffer.concat([readFileSync(shipped), Buffer.from([0])]));
    assert.deepEqual(codes(await runProve({ root, only: ['gs-reisen'] })), ['output-stale']);

    const fixed = copyOfArt(t);
    const { manifest } = readManifest(fixed);
    manifest.assets['about-tewi'].outputs[0].sha256 = sha256(Buffer.from('another file'));
    writeFixtureManifest(fixed, manifest);
    assert.deepEqual(codes(await runProve({ root: fixed, only: ['about-tewi'] })), ['manifest-stale']);
    assert.deepEqual((await runDerive({ root: fixed, write: true })).result.written, []);
    assert.deepEqual(codes(await runProve({ root: fixed, only: ['about-tewi'] })), []);
});

test('a pinned pair must be a picture and the same picture with every pixel drawn as 2 by 2', async (t) => {
    assert.deepEqual(codes(await runProve({ root: await pinnedPair(t, (one) => upscaleNearest(one, 2)) })), []);
    assert.deepEqual(codes(await runProve({ root: await pinnedPair(t, () => paint(6, 4, () => [1, 2, 3, 255])) })), ['pair-mismatch']);
});

test('another encoder version stops a byte proof and a write with exit 3, and a pixel proof still runs', async (t) => {
    const root = copyOfArt(t);
    const { manifest } = readManifest(root);
    manifest.encoder = { ...encoderVersions(), webp: '0.0.1' };
    writeFixtureManifest(root, manifest);

    const bytes = await runProve({ root, only: ['about-tewi'] });
    assert.deepEqual([codes(bytes), bytes.exitCode], [['encoder-mismatch'], 3]);
    assert.deepEqual(codes(await runDerive({ root, write: true })), ['encoder-mismatch']);
    assert.deepEqual(codes(await runProve({ root, only: ['about-tewi'], pixels: true })), []);
});
