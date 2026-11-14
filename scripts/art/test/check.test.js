import assert from 'node:assert/strict';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCheck } from '../lib/commands.js';
import { MASTER_ROOT } from '../lib/manifest.js';
import { REPO_ROOT } from '../test-support/pictures.js';
import { copyOfArt } from '../test-support/repos.js';

const codes = (run) => run.result.problems.map(({ code }) => code);

test('the art of the checkout passes every check that needs no encoding', async () => {
    const run = await runCheck({ root: REPO_ROOT });

    assert.deepEqual(run.result.problems, []);
    assert.equal(run.exitCode, 0);
    assert.equal(run.result.summary.records, run.result.summary.masters - 8);
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
