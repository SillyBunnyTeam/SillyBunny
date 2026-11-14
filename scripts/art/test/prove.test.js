import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runDerive, runProve } from '../lib/commands.js';
import { MANIFEST_PATH, readManifest } from '../lib/manifest.js';
import { sha256 } from '../lib/raster.js';
import { encoderVersions } from '../lib/codec.js';
import { REPO_ROOT } from '../test-support/pictures.js';
import { copyOfArt, writeFixtureManifest } from '../test-support/repos.js';

const codes = (run) => run.result.problems.map(({ code }) => code);

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
