import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { capInflatedCharges } from '../scripts/lib/log-fix.mjs';
import { activeRuns } from '../scripts/lib/token-runs.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fix-charged.mjs');
const FROM = '2026-11-01T09:10:00.000Z';
const priceOf = (model) => (model === 'priced' ? 0.2 : undefined);

const line = (time, n, charged, extra = {}) => JSON.stringify({ time, stage: 's4', provider: 'openai', model: 'priced', template: 'edit', vars: { a: 1 }, refs: ['x'], size: '1024x1024', n, outputs: [], estimatedUsd: 0.2 * n, ...(charged === undefined ? {} : { chargedUsd: charged }), approved: false, ...extra });
const fix = (lines) => capInflatedCharges(`${lines.join('\n')}\n`, { from: FROM, priceOf });

test('a charge of more than the price times the images, from the cut-off on, is set to the price times the images', () => {
    const { text, changes } = fix([line('2026-11-01T09:23:00.000Z', 1, 0.4), line('2026-11-01T09:30:00.000Z', 2, 1.2)]);
    const [first, second] = text.trim().split('\n').map((entry) => JSON.parse(entry));
    assert.deepEqual([first.chargedUsd, second.chargedUsd], [0.2, 0.4]);
    assert.deepEqual(changes.map(({ line: at, n, from, to }) => [at, n, from, to]), [[1, 1, 0.4, 0.2], [2, 2, 1.2, 0.4]]);
});

test('a line before the cut-off is never touched, even with an inflated charge, which keeps the earlier necklace line as it is', () => {
    const before = line('2026-11-01T07:30:00.000Z', 1, 0.4);
    const { text, changes } = fix([before]);
    assert.equal(text, `${before}\n`);
    assert.deepEqual(changes, []);
});

test('a charge at or under the price, a line with no charge, a free derived line and a line of an unpriced model are left alone', () => {
    const lines = [
        line('2026-11-01T09:20:00.000Z', 1, 0.2),
        line('2026-11-01T09:21:00.000Z', 8, 1.6),
        line('2026-11-01T09:22:00.000Z', 2),
        line('2026-11-01T09:23:00.000Z', 1, 0, { template: 'rim-recolour', estimatedUsd: 0 }),
        line('2026-11-01T09:24:00.000Z', 1, 0.9, { model: 'unknown' }),
    ];
    const { text, changes } = fix(lines);
    assert.equal(text, `${lines.join('\n')}\n`);
    assert.deepEqual(changes, []);
});

test('only the number changes: every other byte of a changed line, and every other line, stays exactly as it was', () => {
    const odd = '{"time":"2026-11-01T09:25:00.000Z","model":"priced","n":1,"vars":{"k":  "spaced"},"chargedUsd": 0.4,"estimatedUsd":0.2}';
    const untouched = line('2026-11-01T09:26:00.000Z', 1, 0.2);
    const { text } = fix([odd, '', untouched]);
    assert.equal(text, `${odd.replace('0.4', '0.2')}\n\n${untouched}\n`);
});

test('a line that is not JSON is kept as it is, and a missing final newline stays missing', () => {
    const broken = 'not json {';
    const { text } = capInflatedCharges(`${broken}\n${line('2026-11-01T09:25:00.000Z', 1, 0.4)}`, { from: FROM, priceOf });
    assert.equal(text.split('\n')[0], broken);
    assert.ok(!text.endsWith('\n'));
    assert.equal(JSON.parse(text.split('\n')[1]).chargedUsd, 0.2);
});

test('fixing the fixed text changes nothing, so a second run is harmless', () => {
    const once = fix([line('2026-11-01T09:23:00.000Z', 1, 0.4)]);
    assert.deepEqual(capInflatedCharges(once.text, { from: FROM, priceOf }).changes, []);
});

test('a time that is not a date is refused', () => {
    assert.throws(() => capInflatedCharges('', { from: 'yesterday', priceOf }), /from/);
});

test('active runs are the records with no end whose process is alive', () => {
    const root = tempDir('sb-active-');
    const dir = join(root, 'log', '.runs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'openai-1-10-aa.json'), JSON.stringify({ provider: 'openai', pid: 10, startedAt: 1 }));
    writeFileSync(join(dir, 'openai-2-11-bb.json'), JSON.stringify({ provider: 'openai', pid: 11, startedAt: 2, endedAt: 3 }));
    writeFileSync(join(dir, 'openai-4-12-cc.json'), JSON.stringify({ provider: 'openai', pid: 12, startedAt: 4 }));
    assert.deepEqual(activeRuns(root, { isAlive: (pid) => pid === 10 }).map(({ pid }) => pid), [10]);
    assert.deepEqual(activeRuns(tempDir('sb-none-'), { isAlive: () => true }), []);
});

function workspace(lines, extra = {}) {
    const root = tempDir('sb-fixcli-');
    mkdirSync(join(root, 'log'), { recursive: true });
    writeFileSync(join(root, 'log', 'generations.jsonl'), `${lines.join('\n')}\n`);
    return { root, ...extra };
}

test('the command line shows the changes and writes nothing without --write, then writes them with it', () => {
    const entry = line('2026-11-01T09:23:00.000Z', 1, 0.4, { model: 'gpt-image-2.5-sunburst-h' });
    const { root } = workspace([entry]);
    const run = (args) => spawnSync('node', [SCRIPT, '--root', root, '--from', FROM, ...args], { encoding: 'utf8' });
    const preview = run([]);
    assert.equal(preview.status, 0);
    assert.match(preview.stdout, /line 1: 0\.4 -> 0\.2/);
    assert.match(preview.stdout, /nothing was written/);
    assert.equal(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8'), `${entry}\n`);
    const written = run(['--write']);
    assert.equal(written.status, 0);
    assert.equal(JSON.parse(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').trim()).chargedUsd, 0.2);
});

test('the command line refuses to write while a run is going, and needs --from', () => {
    const { root } = workspace([line('2026-11-01T09:23:00.000Z', 1, 0.4, { model: 'gpt-image-2.5-sunburst-h' })]);
    mkdirSync(join(root, 'log', '.runs'), { recursive: true });
    writeFileSync(join(root, 'log', '.runs', 'openai-1-1-aa.json'), JSON.stringify({ provider: 'openai', pid: process.pid, startedAt: 1 }));
    const blocked = spawnSync('node', [SCRIPT, '--root', root, '--from', FROM, '--write'], { encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /still running/);
    assert.equal(JSON.parse(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').trim()).chargedUsd, 0.4);
    assert.match(spawnSync('node', [SCRIPT, '--root', root], { encoding: 'utf8' }).stderr, /--from/);
});
