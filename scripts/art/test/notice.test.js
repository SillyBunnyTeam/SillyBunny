import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCheck, runNotice } from '../lib/commands.js';
import { MASTER_ROOT } from '../lib/manifest.js';
import { NOTICE_PATH, applyGeneratedRegion, renderNoticeRegion } from '../lib/notice.js';
import { REPO_ROOT } from '../test-support/pictures.js';
import { sampleManifest, sampleRecord } from '../test-support/manifests.js';
import { copyOfArt } from '../test-support/repos.js';

const codes = (run) => run.result.problems.map(({ code }) => code);

test('the generated region lists every master, the incomplete records, the models, the pinned files and the encoder', () => {
    const complete = { master: 'reisen/gs-reisen.png', record: sampleRecord() };
    const incomplete = { master: 'tewi/about-tewi.png', record: { ...sampleRecord(), characters: ['tewi'], handEdits: true, incomplete: 'One source is not logged.' } };

    const region = renderNoticeRegion([complete, incomplete], sampleManifest());

    assert.match(region, /\| reisen\/gs-reisen\.png \| reisen \| openai gpt-image-2\.5-sunburst-h \| rim-recolour, pixel-snap \| no \| d{16} \|/);
    assert.match(region, /### Incomplete records\n\n\| Master \| Reason \|\n\|---\|---\|\n\| tewi\/about-tewi\.png \| One source is not logged\. \|/);
    assert.match(region, /\| openai \| gpt-image-2\.5-sunburst-h \| 2 \| 2026-11-01 \| 2026-11-01 \|/);
    assert.match(region, /\| greeting-reisen \| 2 \|/);
    assert.match(region, /\| sharp \| 0\.35\.5 \|/);
    assert.equal(renderNoticeRegion([complete, incomplete], sampleManifest()), region);
});

test('only the region between the markers is replaced, and a notice without them is refused', () => {
    const text = '# Hand-written\n\nKept.\n\n<!-- generated:begin -->\nold\n<!-- generated:end -->\n\nAlso kept.\n';

    assert.equal(applyGeneratedRegion(text, 'new'), '# Hand-written\n\nKept.\n\n<!-- generated:begin -->\nnew\n<!-- generated:end -->\n\nAlso kept.\n');
    assert.throws(() => applyGeneratedRegion('# No markers\n', 'new'), /needs the markers/);
});

test('the notice of the checkout is what its records give', async () => {
    const run = await runNotice({ root: REPO_ROOT });

    assert.deepEqual([run.result.stale, run.result.problems], [false, []]);
});

test('a changed record makes the notice stale until it is written again', async (t) => {
    const root = copyOfArt(t);
    const recordPath = join(root, MASTER_ROOT, 'tewi/about-tewi.provenance.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    writeFileSync(recordPath, `${JSON.stringify({ ...record, handEdits: !record.handEdits }, null, 4)}\n`);
    assert.ok(codes(await runCheck({ root })).includes('notice-stale'));

    const run = await runNotice({ root, write: true });

    assert.deepEqual([run.result.written, run.result.problems], [true, []]);
    assert.deepEqual(codes(await runNotice({ root })), []);
    assert.match(readFileSync(join(root, NOTICE_PATH), 'utf8'), /^# /);
});
