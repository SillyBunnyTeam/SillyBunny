import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsRecord, recordPathOf, validateRecord } from '../lib/provenance.js';
import { fakeSha, sampleRecord } from '../test-support/manifests.js';

const MASTER = { file: 'gs-reisen.png', sha256: fakeSha('d') };
const codes = (record) => validateRecord(record, MASTER).map(({ code }) => code);
const messages = (record) => validateRecord(record, MASTER).map(({ message }) => message).join(' | ');

test('a full record passes', () => {
    assert.deepEqual(validateRecord(sampleRecord(), MASTER), []);
});

test('a record lives beside its picture master, and a motion description has none', () => {
    assert.equal(recordPathOf('reisen/gs-reisen.png'), 'reisen/gs-reisen.provenance.json');
    assert.equal(recordPathOf('logo/logo.svg'), 'logo/logo.provenance.json');
    assert.equal(needsRecord('reisen/gs-reisen.png'), true);
    assert.equal(needsRecord('reisen/splash-reisen--anim.json'), false);
});

test('a key outside the allowlist is refused, so private data has nowhere to go', () => {
    for (const key of ['prompt', 'chargedUsd', 'estimatedUsd', 'vars', 'refs', 'note']) {
        assert.match(messages({ ...sampleRecord(), [key]: 'x' }), new RegExp(`"${key}", which a public record may not hold`), key);
    }
});

test('a record for other bytes is stale', () => {
    assert.deepEqual(codes({ ...sampleRecord(), sha256: fakeSha('0') }), ['provenance-stale']);
});

test('a record without its private log lines must say why it is incomplete', () => {
    const withoutLog = sampleRecord();
    delete withoutLog.record;

    assert.match(messages(withoutLog), /must say why it is incomplete/);
    assert.deepEqual(validateRecord({ ...withoutLog, incomplete: 'Decoded from the shipped file.' }, MASTER), []);
    assert.match(messages({ ...sampleRecord(), incomplete: 'x'.repeat(201) }), /reason of 1 to 200 characters/);
});

test('every required field and value is checked', () => {
    const cases = [
        [{ characters: ['marisa'] }, 'characters must list'],
        [{ licence: 'CC-BY-4.0' }, 'licence must be'],
        [{ models: [{ provider: 'openai', model: 'x', uses: ['paint'], first: '2026-11-01', last: '2026-11-01' }] }, 'models must list'],
        [{ references: 'third-party' }, 'references must be'],
        [{ steps: ['Pixel Snap'] }, 'steps must list'],
        [{ handEdits: 'no' }, 'handEdits must be'],
        [{ made: '1 November' }, 'made must be a day'],
        [{ file: 'help-reisen.png' }, 'but the master is gs-reisen.png'],
    ];
    for (const [change, expected] of cases) {
        assert.match(messages({ ...sampleRecord(), ...change }), new RegExp(expected), expected);
    }
    const withoutSteps = sampleRecord();
    delete withoutSteps.steps;
    assert.match(messages(withoutSteps), /needs "steps"/);
});
