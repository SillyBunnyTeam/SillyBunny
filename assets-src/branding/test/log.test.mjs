import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendLogEntry, makeLogEntry, readLog, runningTotalUsd } from '../scripts/lib/log.mjs';

const base = { time: 't', stage: 's', provider: 'openai', model: 'm', template: 'x', vars: {}, refHashes: [], size: '1024x1024', outputs: [{ file: 'a', sha256: 'b' }], estimatedUsd: 0.2 };

test('the running total uses chargedUsd where a line has it and estimatedUsd where it does not', () => {
    assert.equal(runningTotalUsd([{ estimatedUsd: 0.2 }, { estimatedUsd: 0.2, chargedUsd: 0.4 }, { estimatedUsd: 0.17, chargedUsd: 0.4 }, { estimatedUsd: 0.35 }]), 1.35);
    assert.equal(runningTotalUsd([{ estimatedUsd: 0.5, chargedUsd: 0 }]), 0);
    assert.equal(runningTotalUsd([]), 0);
});

test('chargedUsd sits after estimatedUsd and only appears when it is measured', () => {
    assert.deepEqual(Object.keys(makeLogEntry(base)).slice(-3), ['outputs', 'estimatedUsd', 'approved']);
    const charged = makeLogEntry({ ...base, chargedUsd: 0.4 });
    assert.deepEqual(Object.keys(charged).slice(-3), ['estimatedUsd', 'chargedUsd', 'approved']);
    assert.equal(charged.chargedUsd, 0.4);
});

test('the first log line creates log/ on a checkout that has no log yet', () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'sb-log-')), 'log', 'generations.jsonl');
    assert.ok(!existsSync(logPath));
    assert.deepEqual(readLog(logPath), []);
    appendLogEntry(logPath, makeLogEntry(base));
    assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 1);
    assert.equal(readLog(logPath)[0].estimatedUsd, 0.2);
});
