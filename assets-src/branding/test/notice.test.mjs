import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGeneratedRegion, detectTools, renderGeneratedRegion } from '../scripts/lib/notice.mjs';

const entry = (overrides) => ({
    time: '2026-11-01T10:00:00.000Z',
    stage: 's1',
    provider: 'openai',
    model: 'gpt-image-2.5-sunburst-h',
    template: 'design-sheet-illustrated',
    vars: {},
    refs: [],
    size: '1024x1024',
    n: 2,
    outputs: [{ file: 'raw/s1/a.png', sha256: 'a' }, { file: 'raw/s1/b.png', sha256: 'b' }],
    estimatedUsd: 0.4,
    approved: false,
    ...overrides,
});

test('the generation table groups the log by model with counts, dates and approvals', () => {
    const text = renderGeneratedRegion({
        entries: [
            entry({}),
            entry({ time: '2026-11-03T10:00:00.000Z', n: 1, outputs: [{ file: 'raw/s1/c.png', sha256: 'c', approved: true }], estimatedUsd: 0.2, approved: true, refs: ['r1', 'r2'] }),
            entry({ provider: 'gemini', model: 'gemini-3-pro-image-preview', estimatedUsd: 0.7 }),
        ],
        tools: [],
        checkedOn: '2026-11-01',
    });
    assert.match(text, /\| openai \| gpt-image-2\.5-sunburst-h \| 3 \| 2026-11-01 \| 2026-11-03 \| 1 \| - \| \$0\.60 \|/);
    assert.match(text, /\| gemini \| gemini-3-pro-image-preview \| 2 \| 2026-11-01 \| 2026-11-01 \| 0 \| - \| \$0\.70 \|/);
    assert.match(text, /Reference images attached \| 2/);
});

test('the cost columns show the charged amount where it is known and the estimate for the rest', () => {
    const text = renderGeneratedRegion({
        entries: [
            entry({ estimatedUsd: 0.2, chargedUsd: 0.4 }),
            entry({ estimatedUsd: 0.2 }),
            entry({ provider: 'gemini', model: 'gemini-3-pro-image-preview', estimatedUsd: 0.35, chargedUsd: 0.35 }),
        ],
        tools: [],
        checkedOn: '2026-11-01',
    });
    assert.match(text, /\| Charged \| Estimated only \|/);
    assert.match(text, /\| openai \| gpt-image-2\.5-sunburst-h \| 4 \| 2026-11-01 \| 2026-11-01 \| 0 \| \$0\.40 \| \$0\.20 \|/);
    assert.match(text, /\| gemini \| gemini-3-pro-image-preview \| 2 \| 2026-11-01 \| 2026-11-01 \| 0 \| \$0\.35 \| - \|/);
    assert.match(text, /Total charged \| \$0\.75/);
    assert.match(text, /Total estimated, not yet measured \| \$0\.20/);
});

const sheet = (name, sha, extra = {}) => ({ file: `raw/s2/${name}.png`, sha256: sha, approved: true, ...extra });

test('only current approvals are listed, and the Approved column counts only those', () => {
    const text = renderGeneratedRegion({
        entries: [
            entry({ outputs: [sheet('old', 'a'.repeat(64), { superseded: 'b'.repeat(64) }), sheet('b', 'c'.repeat(64))] }),
            entry({ outputs: [sheet('new', 'b'.repeat(64))] }),
        ],
        tools: [],
        checkedOn: '2026-11-01',
    });
    assert.match(text, /### Current approvals/);
    assert.match(text, /\| new\.png \| gpt-image-2\.5-sunburst-h \| bbbbbbbbbbbbbbbb \|/);
    assert.match(text, /\| b\.png \| gpt-image-2\.5-sunburst-h \| cccccccccccccccc \|/);
    assert.ok(!/\| old\.png/.test(text), 'a superseded file is not in the table');
    assert.match(text, /\| openai \| gpt-image-2\.5-sunburst-h \| 3 \| 2026-11-01 \| 2026-11-01 \| 2 \|/);
});

test('superseded approvals get one short history line and nothing when there are none', () => {
    const none = renderGeneratedRegion({ entries: [entry({ outputs: [sheet('a', 'a'.repeat(64))] })], tools: [], checkedOn: '2026-11-01' });
    assert.ok(!/Superseded/.test(none));
    const text = renderGeneratedRegion({
        entries: [entry({ outputs: [sheet('x', 'a'.repeat(64), { superseded: 'b'.repeat(64) }), sheet('y', 'c'.repeat(64), { superseded: 'd'.repeat(64) }), sheet('z', 'b'.repeat(64)), sheet('w', 'd'.repeat(64))] })],
        tools: [],
        checkedOn: '2026-11-01',
    });
    assert.match(text, /Superseded approvals \(history\): 2 \(aaaaaaaa -> bbbbbbbb, cccccccc -> dddddddd\)/);
});

test('with no approvals the table says so', () => {
    assert.match(renderGeneratedRegion({ entries: [entry({})], tools: [], checkedOn: '2026-11-01' }), /No approved art yet/);
});

test('an empty log says so instead of printing an empty table', () => {
    const text = renderGeneratedRegion({ entries: [], tools: [], checkedOn: '2026-11-01' });
    assert.match(text, /No generations logged yet/);
});

test('the tool table lists versions and marks a missing tool', () => {
    const runner = (command) => {
        if (command === 'potrace') {
            throw new Error('ENOENT');
        }
        return { magick: 'Version: ImageMagick 7.1.2-34 Q16-HDRI x86_64\nCopyright', cwebp: '1.6.0\nlibsharpyuv: 0.4.2', python3: 'Python 3.15.0', vtracer: 'vtracer 0.6.4' }[command];
    };
    const tools = detectTools(runner, { sharp: '0.35.5', node: 'v26.10.0' });
    const text = renderGeneratedRegion({ entries: [], tools, checkedOn: '2026-11-01' });
    assert.match(text, /\| ImageMagick \| 7\.1\.2-34 \|/);
    assert.match(text, /\| cwebp \| 1\.6\.0 \|/);
    assert.match(text, /\| potrace \| not installed \|/);
    assert.match(text, /\| vtracer \| 0\.6\.4 \|/);
    assert.match(text, /\| python3 \| 3\.15\.0 \|/);
    assert.match(text, /\| sharp \| 0\.35\.5 \|/);
    assert.match(text, /\| Node\.js \| v26\.10\.0 \|/);
});

test('potrace prints its version before a full stop, which is not part of the number', () => {
    const tools = detectTools((command) => {
        if (command === 'potrace') {
            return 'potrace 1.16. Copyright (C) 2001-2019 Peter Selinger.';
        }
        throw new Error('ENOENT');
    }, { sharp: '0', node: 'v0' });
    assert.deepEqual(tools.find((tool) => tool.label === 'potrace'), { label: 'potrace', version: '1.16' });
});

test('only the text between the markers is replaced', () => {
    const before = 'keep this\n<!-- generated:begin -->\nold\n<!-- generated:end -->\nand this\n';
    const after = applyGeneratedRegion(before, 'new table');
    assert.equal(after, 'keep this\n<!-- generated:begin -->\nnew table\n<!-- generated:end -->\nand this\n');
    assert.equal(applyGeneratedRegion(after, 'new table'), after);
});

test('a NOTICE without markers is an error, not an overwrite', () => {
    assert.throws(() => applyGeneratedRegion('no markers here', 'x'), /generated:begin/);
});

test('an output approved in place is listed under the name it took over, with its own sha', () => {
    const text = renderGeneratedRegion({
        entries: [
            entry({ outputs: [sheet('gs-reisen-done', 'a'.repeat(64), { superseded: 'b'.repeat(64) })] }),
            entry({ outputs: [sheet('20261101T125043Z-patch-1', 'b'.repeat(64), { approvedAs: 'gs-reisen-done.png' })] }),
        ],
        tools: [],
        checkedOn: '2026-11-01',
    });
    assert.match(text, /\| gs-reisen-done\.png \| gpt-image-2\.5-sunburst-h \| bbbbbbbbbbbbbbbb \|/);
    assert.ok(!text.includes('20261101T125043Z-patch-1.png'), 'the timestamped name is not listed');
    assert.equal(text.match(/gs-reisen-done\.png/g).length, 1, 'the superseded copy of that name is not listed');
    assert.match(text, /Superseded approvals \(history\): 1 \(aaaaaaaa -> bbbbbbbb\)/);
});
