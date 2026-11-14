import assert from 'node:assert/strict';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCheck } from '../lib/commands.js';
import { MASTER_ROOT, readManifest } from '../lib/manifest.js';
import { REPO_ROOT } from '../test-support/pictures.js';
import { copyOfArt, writeFixtureManifest } from '../test-support/repos.js';

const codes = (run) => run.result.problems.map(({ code }) => code);

test('the art of the checkout passes every check that needs no encoding, and every figure has the rings its manifest gives', async () => {
    const run = await runCheck({ root: REPO_ROOT });

    assert.deepEqual(run.result.problems, []);
    assert.deepEqual(run.result.warnings, []);
    assert.equal(run.exitCode, 0);
    assert.equal(run.result.summary.records, run.result.summary.masters - 8);
});

test('a figure whose rings measure other widths than the manifest gives is a warning, which leaves the exit code alone', async (t) => {
    const root = copyOfArt(t, { pinned: true });
    const { manifest } = readManifest(root);
    manifest.assets['about-tewi'].rings = { rim: 3, band: 2 };
    writeFixtureManifest(root, manifest);

    const run = await runCheck({ root });

    assert.deepEqual([run.exitCode, run.result.ok, run.result.problems], [0, true, []]);
    assert.deepEqual(run.result.warnings.map(({ code, asset, path, expected, actual }) => ({ code, asset, path, expected, actual })), [
        { code: 'ring-width', asset: 'about-tewi', path: 'tewi/about-tewi.png', expected: { rim: 3, band: 2 }, actual: { rim: 2, band: 2 } },
    ]);
});

test('a missing record, a stray master, a stale record and an unlisted file are each reported', async (t) => {
    const root = copyOfArt(t);
    rmSync(join(root, MASTER_ROOT, 'reisen/gs-reisen.provenance.json'));
    writeFileSync(join(root, MASTER_ROOT, 'reisen/left-over.png'), 'x');
    copyFileSync(join(root, MASTER_ROOT, 'tewi/about-tewi.provenance.json'), join(root, MASTER_ROOT, 'tewi/extras-tewi.provenance.json'));
    writeFileSync(join(root, 'public/img/sillybunny/stray@native.webp'), 'x');

    const found = codes(await runCheck({ root }));

    for (const code of ['provenance-missing', 'master-unused', 'provenance-invalid', 'provenance-stale', 'unlisted-file']) {
        assert.ok(found.includes(code), `${code} in ${found.join(', ')}`);
    }
});
