import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approveOutputs, supersedeOutput } from '../scripts/lib/approve.mjs';
import { sha256 } from '../scripts/lib/log.mjs';

const BYTES = { a: Buffer.from('image a'), b: Buffer.from('image b'), c: Buffer.from('image c') };

function makeProject() {
    const root = mkdtempSync(join(tmpdir(), 'sb-approve-'));
    mkdirSync(join(root, 'log'));
    mkdirSync(join(root, 'raw', 's1'), { recursive: true });
    for (const [name, bytes] of Object.entries(BYTES)) {
        writeFileSync(join(root, 'raw', 's1', `${name}.png`), bytes);
    }
    const output = (name) => ({ file: `raw/s1/${name}.png`, sha256: sha256(BYTES[name]) });
    const entries = [
        { time: '2026-11-01T10:00:00.000Z', stage: 's1', model: 'm', outputs: [output('a'), output('b')], estimatedUsd: 0.4, approved: false },
        { time: '2026-11-01T11:00:00.000Z', stage: 's1', model: 'm', outputs: [output('c')], estimatedUsd: 0.2, approved: false },
    ];
    // The second line is written by hand with odd spacing to prove untouched lines are kept as they were.
    const lines = [JSON.stringify(entries[0]), JSON.stringify(entries[1]).replace('"stage"', ' "stage"')];
    writeFileSync(join(root, 'log', 'generations.jsonl'), `${lines.join('\n')}\n`);
    return { root, entries, lines };
}

const readEntries = (root) => readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('approving by file marks that output, copies it to approved/ and leaves other outputs alone', () => {
    const { root, lines } = makeProject();
    const done = approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: false });
    assert.equal(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').split('\n')[1], lines[1]);
    assert.deepEqual(done.map((item) => item.file), ['raw/s1/a.png']);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.a);
    assert.ok(!existsSync(join(root, 'refs')));
    const [first, second] = readEntries(root);
    assert.equal(first.outputs[0].approved, true);
    assert.equal(first.outputs[1].approved, undefined);
    assert.equal(first.approved, true);
    assert.equal(second.approved, false);
});

test('approving by sha256, in full or by a unique prefix, finds the output', () => {
    const { root } = makeProject();
    approveOutputs({ rootDir: root, targets: [sha256(BYTES.b), sha256(BYTES.c).slice(0, 12)], ref: false });
    assert.deepEqual(readFileSync(join(root, 'approved', 'b.png')), BYTES.b);
    assert.deepEqual(readFileSync(join(root, 'approved', 'c.png')), BYTES.c);
    const [first, second] = readEntries(root);
    assert.equal(first.outputs[1].approved, true);
    assert.equal(second.outputs[0].approved, true);
});

test('--ref also copies to refs/', () => {
    const { root } = makeProject();
    approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: true });
    assert.deepEqual(readFileSync(join(root, 'refs', 'a.png')), BYTES.a);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.a);
});

test('a file whose sha256 differs from the log is refused and nothing is written', () => {
    const { root, lines } = makeProject();
    writeFileSync(join(root, 'raw', 's1', 'b.png'), 'tampered or re-saved');
    assert.throws(() => approveOutputs({ rootDir: root, targets: ['raw/s1/a.png', 'raw/s1/b.png'], ref: true }), /sha256 does not match the log/);
    assert.ok(!existsSync(join(root, 'approved')));
    assert.ok(!existsSync(join(root, 'refs')));
    assert.equal(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8'), `${lines.join('\n')}\n`);
});

test('an unknown file, an unknown or too short hash, and a missing file all fail without touching the log', () => {
    const { root } = makeProject();
    const log = readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8');
    assert.throws(() => approveOutputs({ rootDir: root, targets: ['raw/s1/zzz.png'], ref: false }), /not in the log/);
    assert.throws(() => approveOutputs({ rootDir: root, targets: ['deadbeefdeadbeef'], ref: false }), /not in the log/);
    assert.throws(() => approveOutputs({ rootDir: root, targets: [sha256(BYTES.a).slice(0, 6)], ref: false }), /not in the log/);
    assert.throws(() => approveOutputs({ rootDir: root, targets: [''], ref: false }), /not in the log/);
    rmSync(join(root, 'raw', 's1', 'a.png'));
    assert.throws(() => approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: false }), /missing/);
    assert.equal(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8'), log);
});

test('a hash that matches two logged files is ambiguous, but either file can be approved by its path', () => {
    const { root } = makeProject();
    writeFileSync(join(root, 'raw', 's1', 'a-copy.png'), BYTES.a);
    appendFileSync(join(root, 'log', 'generations.jsonl'), `${JSON.stringify({ time: 't', outputs: [{ file: 'raw/s1/a-copy.png', sha256: sha256(BYTES.a) }], estimatedUsd: 0, approved: false })}\n`);
    assert.throws(() => approveOutputs({ rootDir: root, targets: [sha256(BYTES.a)], ref: false }), /more than one/);
    approveOutputs({ rootDir: root, targets: ['raw/s1/a-copy.png'], ref: false });
    assert.deepEqual(readFileSync(join(root, 'approved', 'a-copy.png')), BYTES.a);
});

test('approving twice is harmless, and a different file already in approved/ blocks the copy', async () => {
    const { root } = makeProject();
    approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: false });
    approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: false });
    assert.equal(readEntries(root)[0].outputs[0].approved, true);

    writeFileSync(join(root, 'approved', 'b.png'), 'someone else');
    assert.throws(() => approveOutputs({ rootDir: root, targets: ['raw/s1/b.png'], ref: false }), /already exists with different content/);
    assert.equal(readEntries(root)[0].outputs[1].approved, undefined);
});

test('a target is matched by path from the working directory or from the package root', () => {
    const { root } = makeProject();
    approveOutputs({ rootDir: root, targets: [join(root, 'raw', 's1', 'c.png')], ref: false });
    assert.equal(readEntries(root)[1].outputs[0].approved, true);
});

test('a dry run checks everything, reports the copies and writes nothing', () => {
    const { root, lines } = makeProject();
    const report = approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: true, dryRun: true });
    assert.deepEqual(report[0].copiedTo, ['approved/a.png', 'refs/a.png']);
    assert.ok(!existsSync(join(root, 'approved')));
    assert.equal(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8'), `${lines.join('\n')}\n`);
    writeFileSync(join(root, 'raw', 's1', 'a.png'), 'changed');
    assert.throws(() => approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: false, dryRun: true }), /sha256 does not match/);
});

test('approving on a checkout with no log says the file is not in the log and writes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-approve-empty-'));
    assert.throws(() => approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: true }), /is not in the log/);
    assert.ok(!existsSync(join(root, 'approved')) && !existsSync(join(root, 'log')));
});

const readLogText = (root) => readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8');

function projectWithTwoApproved() {
    const project = makeProject();
    approveOutputs({ rootDir: project.root, targets: ['raw/s1/a.png', 'raw/s1/c.png'], ref: true });
    return project;
}

test('superseding marks the old output with the new sha, removes it from approved/ and refs/, and keeps the raw file', () => {
    const { root } = projectWithTwoApproved();
    const done = supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/c.png' });
    assert.deepEqual(done.removed, ['approved/a.png', 'refs/a.png']);
    assert.deepEqual([done.old.file, done.new.file], ['raw/s1/a.png', 'raw/s1/c.png']);
    assert.ok(!existsSync(join(root, 'approved', 'a.png')) && !existsSync(join(root, 'refs', 'a.png')));
    assert.deepEqual(readFileSync(join(root, 'approved', 'c.png')), BYTES.c);
    assert.deepEqual(readFileSync(join(root, 'refs', 'c.png')), BYTES.c);
    assert.deepEqual(readFileSync(join(root, 'raw', 's1', 'a.png')), BYTES.a);
    const [first, second] = readEntries(root);
    assert.equal(first.outputs[0].superseded, sha256(BYTES.c));
    assert.equal(first.outputs[0].approved, true, 'the history keeps that it was approved once');
    assert.equal(first.outputs[1].superseded, undefined);
    assert.equal(second.outputs[0].superseded, undefined);
});

test('superseding takes files or sha256 prefixes, and leaves every other log line as it was', () => {
    const { root } = projectWithTwoApproved();
    const before = readLogText(root).split('\n');
    supersedeOutput({ rootDir: root, oldTarget: sha256(BYTES.a).slice(0, 12), newTarget: join(root, 'raw', 's1', 'c.png') });
    const after = readLogText(root).split('\n');
    assert.equal(after[1], before[1]);
    assert.notEqual(after[0], before[0]);
});

test('superseding refuses when the new file is not approved yet, and changes nothing', () => {
    const { root } = projectWithTwoApproved();
    const log = readLogText(root);
    assert.throws(() => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/b.png' }), /raw\/s1\/b\.png is not approved yet/);
    assert.equal(readLogText(root), log);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.a);
    assert.deepEqual(readFileSync(join(root, 'refs', 'a.png')), BYTES.a);
});

test('superseding refuses an old output that was never approved, the same image, a superseded replacement and a second supersede', () => {
    const { root } = projectWithTwoApproved();
    const log = readLogText(root);
    assert.throws(() => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/b.png', newTarget: 'raw/s1/c.png' }), /raw\/s1\/b\.png is not approved, so there is nothing to supersede/);
    assert.throws(() => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/a.png' }), /replace itself/);
    assert.equal(readLogText(root), log);

    supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/c.png' });
    assert.throws(() => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/c.png' }), /already superseded/);
    approveOutputs({ rootDir: root, targets: ['raw/s1/b.png'], ref: false });
    assert.throws(() => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/b.png', newTarget: 'raw/s1/a.png' }), /raw\/s1\/a\.png is superseded and cannot replace anything/);
});

test('an unknown target on either side is refused before anything changes', () => {
    const { root } = projectWithTwoApproved();
    const log = readLogText(root);
    assert.throws(() => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/zzz.png', newTarget: 'raw/s1/c.png' }), /not in the log/);
    assert.throws(() => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'deadbeefdeadbeef' }), /not in the log/);
    assert.equal(readLogText(root), log);
});

test('a copy in approved/ that is not the logged file is never deleted', () => {
    const { root } = projectWithTwoApproved();
    writeFileSync(join(root, 'refs', 'a.png'), 'a different file under the same name');
    const log = readLogText(root);
    assert.throws(() => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/c.png' }), /refs\/a\.png is not the approved file/);
    assert.equal(readLogText(root), log);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.a);
});

test('a missing copy in refs/ is fine, and a dry run reports what would be removed and writes nothing', () => {
    const { root } = makeProject();
    approveOutputs({ rootDir: root, targets: ['raw/s1/a.png', 'raw/s1/c.png'], ref: false });
    const log = readLogText(root);
    const report = supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/c.png', dryRun: true });
    assert.deepEqual(report.removed, ['approved/a.png']);
    assert.equal(readLogText(root), log);
    assert.ok(existsSync(join(root, 'approved', 'a.png')));
    supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/c.png' });
    assert.ok(!existsSync(join(root, 'approved', 'a.png')));
});

test('a superseded output cannot be approved again', () => {
    const { root } = projectWithTwoApproved();
    supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/c.png' });
    assert.throws(() => approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: true }), /superseded/);
    assert.ok(!existsSync(join(root, 'approved', 'a.png')));
});
