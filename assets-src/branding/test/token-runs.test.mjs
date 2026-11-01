import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { endRun, otherRunsDuring, startRun } from '../scripts/lib/token-runs.mjs';

const at = (minute, second = 0) => new Date(Date.UTC(2026, 10, 1, 9, minute, second));
const clock = (date) => () => date;
const alive = () => true;
const dead = () => false;

const makeRoot = () => mkdtempSync(join(tmpdir(), 'sb-runs-'));
const runsOf = (root) => readdirSync(join(root, 'log', '.runs')).sort();

/** A record another process left, as startRun and endRun write them. */
function plant(root, { provider = 'openai', pid, started, ended, name }) {
    const dir = join(root, 'log', '.runs');
    mkdirSync(dir, { recursive: true });
    const record = { provider, pid, startedAt: started.getTime(), ...(ended ? { endedAt: ended.getTime() } : {}) };
    writeFileSync(join(dir, name ?? `${provider}-${record.startedAt}-${pid}.json`), JSON.stringify(record));
}

test('a run leaves a record under log/.runs with its provider, pid and start, and no secret', () => {
    const root = makeRoot();
    const run = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 4321 });
    assert.match(runsOf(root)[0], new RegExp(`^openai-${at(10).getTime()}-4321-[0-9a-f]{6}\\.json$`));
    assert.equal(runsOf(root).length, 1);
    assert.deepEqual(JSON.parse(readFileSync(run.path, 'utf8')), { provider: 'openai', pid: 4321, startedAt: at(10).getTime() });
});

test('ending a run stamps its end on the record and keeps the record, so a later measurement can still see it', () => {
    const root = makeRoot();
    const run = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 1 });
    endRun(run, { now: clock(at(12)) });
    assert.equal(JSON.parse(readFileSync(run.path, 'utf8')).endedAt, at(12).getTime());
    assert.equal(runsOf(root).length, 1);
});

test('two runs of one process that start in the same millisecond keep separate records and see each other', () => {
    const root = makeRoot();
    const first = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 7 });
    const second = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 7 });
    assert.equal(runsOf(root).length, 2);
    assert.equal(otherRunsDuring(first, { now: clock(at(10)), isAlive: alive }).length, 1);
    assert.equal(otherRunsDuring(second, { now: clock(at(10)), isAlive: alive }).length, 1);
});

test('a run alone on the token sees nothing, and a record of its own is never its own other', () => {
    const root = makeRoot();
    const run = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 1 });
    assert.deepEqual(otherRunsDuring(run, { now: clock(at(11)), isAlive: alive }), []);
});

test('a run that is still going, a run that started and finished inside the window, and one that began before and ended inside it all count', () => {
    const root = makeRoot();
    plant(root, { pid: 11, started: at(5) });
    plant(root, { pid: 12, started: at(10, 20), ended: at(10, 40) });
    plant(root, { pid: 13, started: at(8), ended: at(10, 30) });
    const run = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 1 });
    const others = otherRunsDuring(run, { now: clock(at(11)), isAlive: alive });
    assert.deepEqual(others.map(({ pid }) => pid).sort(), [11, 12, 13]);
});

test('a run that ended before this one started, or started after the measurement, does not count', () => {
    const root = makeRoot();
    plant(root, { pid: 21, started: at(1), ended: at(9) });
    plant(root, { pid: 22, started: at(12) });
    const run = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 1 });
    assert.deepEqual(otherRunsDuring(run, { now: clock(at(11)), isAlive: alive }), []);
});

test('a run that ended at the very moment this one started does not count, which a fixed clock relies on', () => {
    const root = makeRoot();
    plant(root, { pid: 31, started: at(9), ended: at(10) });
    const run = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 1 });
    assert.deepEqual(otherRunsDuring(run, { now: clock(at(10)), isAlive: alive }), []);
});

test('a record whose process is gone and that never ended counts only at the moment it started', () => {
    const root = makeRoot();
    plant(root, { pid: 41, started: at(2) });
    plant(root, { pid: 42, started: at(10, 30) });
    const run = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 1 });
    assert.deepEqual(otherRunsDuring(run, { now: clock(at(11)), isAlive: dead }).map(({ pid }) => pid), [42]);
});

test('another provider has its own token, so its runs do not count', () => {
    const root = makeRoot();
    plant(root, { provider: 'gemini', pid: 51, started: at(9) });
    const run = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 1 });
    assert.deepEqual(otherRunsDuring(run, { now: clock(at(11)), isAlive: alive }), []);
});

test('a broken record is skipped, not trusted and not fatal', () => {
    const root = makeRoot();
    plant(root, { pid: 61, started: at(9) });
    writeFileSync(join(root, 'log', '.runs', 'openai-1-2.json'), '{not json');
    writeFileSync(join(root, 'log', '.runs', 'openai-3-4.json'), JSON.stringify({ provider: 'openai', pid: 'x' }));
    const run = startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 1 });
    assert.deepEqual(otherRunsDuring(run, { now: clock(at(11)), isAlive: alive }).map(({ pid }) => pid), [61]);
});

test('records whose last known moment is over a day old are removed when a run starts, and a recent one is kept', () => {
    const root = makeRoot();
    const longAgo = new Date(at(10).getTime() - 25 * 3_600_000);
    plant(root, { pid: 71, started: longAgo, ended: new Date(longAgo.getTime() + 1000) });
    plant(root, { pid: 72, started: new Date(at(10).getTime() - 3_600_000), ended: new Date(at(10).getTime() - 3_000_000) });
    plant(root, { pid: 73, started: longAgo });
    startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 1 });
    const left = runsOf(root).map((name) => Number(/^openai-\d+-(\d+)/.exec(name)[1]));
    assert.deepEqual(left.sort((a, b) => a - b), [1, 72]);
});

test('starting a run creates log/.runs when there is no log folder yet', () => {
    const root = makeRoot();
    startRun({ rootDir: root, provider: 'openai', now: clock(at(10)), pid: 1 });
    assert.ok(existsSync(join(root, 'log', '.runs')));
});
