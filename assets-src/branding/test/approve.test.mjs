import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approveOutputs, revertSupersede, supersedeOutput } from '../scripts/lib/approve.mjs';
import { sha256 } from '../scripts/lib/log.mjs';
import { renderGeneratedRegion } from '../scripts/lib/notice.mjs';

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

const inPlace = (root, overrides = {}) => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/b.png', inPlace: true, ...overrides });
const outputOf = (root, file) => readEntries(root).flatMap((entry) => entry.outputs).find((output) => output.file === file);

/** a is approved in approved/ and refs/; b is logged but not approved. */
function projectWithSlot({ ref = true } = {}) {
    const project = makeProject();
    approveOutputs({ rootDir: project.root, targets: ['raw/s1/a.png'], ref });
    return project;
}

test('--in-place approves the new output, writes its bytes under the old names in approved/ and refs/, and records the name', () => {
    const { root } = projectWithSlot();
    const report = inPlace(root);
    assert.deepEqual([report.written, report.removed, report.approvedNew], [['approved/a.png', 'refs/a.png'], [], true]);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.b);
    assert.deepEqual(readFileSync(join(root, 'refs', 'a.png')), BYTES.b);
    assert.ok(!existsSync(join(root, 'approved', 'b.png')) && !existsSync(join(root, 'refs', 'b.png')), 'nothing lands under the new name');
    assert.ok(!existsSync(join(root, 'approved', 'a.png.tmp')));
    const old = outputOf(root, 'raw/s1/a.png');
    const replacement = outputOf(root, 'raw/s1/b.png');
    assert.equal(old.superseded, sha256(BYTES.b));
    assert.deepEqual([replacement.approved, replacement.approvedAs, replacement.superseded], [true, 'a.png', undefined]);
    assert.deepEqual(readFileSync(join(root, 'raw', 's1', 'a.png')), BYTES.a, 'the old raw file stays');
    assert.equal(readEntries(root)[0].approved, true);
});

test('--in-place without a copy in refs/ writes none there', () => {
    const { root } = projectWithSlot({ ref: false });
    const report = inPlace(root);
    assert.deepEqual(report.written, ['approved/a.png']);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.b);
    assert.ok(!existsSync(join(root, 'refs')));
});

test('--in-place keeps the other log lines as they were', () => {
    const { root } = projectWithSlot();
    const before = readLogText(root).split('\n');
    inPlace(root);
    assert.equal(readLogText(root).split('\n')[1], before[1]);
});

test('a later normal approval and a later supersede use the in-place name', () => {
    const { root } = projectWithSlot();
    inPlace(root);
    const done = approveOutputs({ rootDir: root, targets: ['raw/s1/b.png'], ref: true });
    assert.deepEqual(done[0].copiedTo, ['approved/a.png', 'refs/a.png'], 'the check runs against the in-place name');
    assert.ok(!existsSync(join(root, 'approved', 'b.png')));

    approveOutputs({ rootDir: root, targets: ['raw/s1/c.png'], ref: false });
    writeFileSync(join(root, 'approved', 'a.png'), 'edited by hand');
    assert.throws(() => approveOutputs({ rootDir: root, targets: ['raw/s1/b.png'], ref: false }), /approved\/a\.png already exists with different content/);
    assert.throws(() => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/b.png', newTarget: 'raw/s1/c.png', dryRun: true }), /approved\/a\.png is not the approved file raw\/s1\/b\.png/);
    writeFileSync(join(root, 'approved', 'a.png'), BYTES.b);

    const later = supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/b.png', newTarget: 'raw/s1/c.png' });
    assert.deepEqual(later.removed, ['approved/a.png', 'refs/a.png']);
});

test('--in-place can be repeated: the next replacement takes over the same name', () => {
    const { root } = projectWithSlot();
    inPlace(root);
    const extra = Buffer.from('image d');
    writeFileSync(join(root, 'raw', 's1', 'd.png'), extra);
    appendFileSync(join(root, 'log', 'generations.jsonl'), `${JSON.stringify({ time: 't', outputs: [{ file: 'raw/s1/d.png', sha256: sha256(extra) }], estimatedUsd: 0, approved: false })}\n`);
    supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/b.png', newTarget: 'raw/s1/d.png', inPlace: true });
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), extra);
    assert.equal(outputOf(root, 'raw/s1/d.png').approvedAs, 'a.png');
    assert.equal(outputOf(root, 'raw/s1/b.png').superseded, sha256(extra));
});

test('a --in-place dry run runs every check, reports the plan and writes nothing', () => {
    const { root } = projectWithSlot();
    const log = readLogText(root);
    const report = inPlace(root, { dryRun: true });
    assert.deepEqual([report.written, report.approvedNew, report.new.file], [['approved/a.png', 'refs/a.png'], true, 'raw/s1/b.png']);
    assert.equal(readLogText(root), log);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.a);
    writeFileSync(join(root, 'raw', 's1', 'b.png'), 'changed');
    assert.throws(() => inPlace(root, { dryRun: true }), /sha256 does not match/);
});

const IN_PLACE_REFUSALS = [
    ['an old output that is not approved', { prepare() {}, overrides: { oldTarget: 'raw/s1/b.png', newTarget: 'raw/s1/c.png' } }, /raw\/s1\/b\.png is not approved, so there is nothing to supersede/],
    ['a new output that is already approved under another name', { prepare(root) {
        approveOutputs({ rootDir: root, targets: ['raw/s1/c.png'], ref: false });
    }, overrides: { newTarget: 'raw/s1/c.png' } }, /raw\/s1\/c\.png is already approved as c\.png, so it cannot also take over a\.png/],
    ['an approved copy that is not the logged old file', { prepare(root) {
        writeFileSync(join(root, 'approved', 'a.png'), 'a different file under the same name');
    } }, /approved\/a\.png is not the approved file raw\/s1\/a\.png, so it will not be overwritten/],
    ['a refs copy that is not the logged old file', { prepare(root) {
        writeFileSync(join(root, 'refs', 'a.png'), 'a different file under the same name');
    } }, /refs\/a\.png is not the approved file raw\/s1\/a\.png, so it will not be overwritten/],
    ['an approved copy that is missing', { prepare(root) {
        rmSync(join(root, 'approved', 'a.png'));
    } }, /approved\/a\.png is missing/],
    ['a new file that differs from the log', { prepare(root) {
        writeFileSync(join(root, 'raw', 's1', 'b.png'), 'tampered or re-saved');
    } }, /raw\/s1\/b\.png: sha256 does not match the log/],
    ['a new output that is superseded', { prepare(root) {
        approveOutputs({ rootDir: root, targets: ['raw/s1/c.png'], ref: false });
        supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/c.png', newTarget: 'raw/s1/a.png' });
    }, overrides: { newTarget: 'raw/s1/c.png' } }, /raw\/s1\/c\.png is superseded/],
    ['the same image on both sides', { prepare() {}, overrides: { newTarget: 'raw/s1/a.png' } }, /replace itself/],
];

for (const [name, { prepare, overrides }, message] of IN_PLACE_REFUSALS) {
    test(`--in-place refuses ${name}, and changes nothing`, () => {
        const { root } = projectWithSlot();
        prepare(root);
        const log = readLogText(root);
        const files = ['approved/a.png', 'refs/a.png', 'raw/s1/b.png'].map((file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined));
        assert.throws(() => inPlace(root, overrides), message);
        assert.equal(readLogText(root), log);
        assert.deepEqual(['approved/a.png', 'refs/a.png', 'raw/s1/b.png'].map((file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined)), files);
        assert.ok(!existsSync(join(root, 'approved', 'b.png')));
    });
}

test('without --in-place an unapproved replacement is still refused, and the message points at the flag', () => {
    const { root } = projectWithSlot();
    assert.throws(() => supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/b.png' }), /raw\/s1\/b\.png is not approved yet.*--in-place/);
});

const revert = (root, overrides = {}) => revertSupersede({ rootDir: root, newTarget: 'raw/s1/b.png', ...overrides });
const copyText = (root, file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined);
const snapshot = (root) => [readLogText(root), ...['approved/a.png', 'refs/a.png', 'approved/b.png', 'approved/c.png', 'refs/c.png', 'raw/s1/a.png'].map((file) => copyText(root, file))];

/** a was approved, then superseded in place by b, so approved/a.png holds b. */
function afterInPlace({ ref = true } = {}) {
    const project = projectWithSlot({ ref });
    inPlace(project.root);
    return project;
}

test('reverting an in-place supersede puts the old bytes back under the same names and approves the old output again', () => {
    const { root } = afterInPlace();
    const before = readLogText(root).split('\n');
    const done = revert(root);
    assert.deepEqual([done.restored, done.removed], [['approved/a.png', 'refs/a.png'], []]);
    assert.deepEqual([done.old.file, done.new.file], ['raw/s1/a.png', 'raw/s1/b.png']);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.a);
    assert.deepEqual(readFileSync(join(root, 'refs', 'a.png')), BYTES.a);
    assert.ok(!existsSync(join(root, 'approved', 'b.png')) && !existsSync(join(root, 'approved', 'a.png.tmp')));
    const old = outputOf(root, 'raw/s1/a.png');
    const replacement = outputOf(root, 'raw/s1/b.png');
    assert.deepEqual([old.approved, old.superseded], [true, undefined]);
    assert.deepEqual([replacement.approved, replacement.superseded, replacement.approvedAs], [true, sha256(BYTES.a), 'a.png'], 'b stays in the log as history');
    assert.equal(readLogText(root).split('\n')[1], before[1], 'other lines are as they were');
    assert.deepEqual(readFileSync(join(root, 'raw', 's1', 'b.png')), BYTES.b);
});

test('reverting without a copy in refs/ restores none there', () => {
    const { root } = afterInPlace({ ref: false });
    const done = revert(root);
    assert.deepEqual(done.restored, ['approved/a.png']);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.a);
    assert.ok(!existsSync(join(root, 'refs')));
});

test('reverting a plain supersede removes the new copies and puts the old output back under its own name', () => {
    const { root } = projectWithTwoApproved();
    supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/c.png' });
    const done = revert(root, { newTarget: 'raw/s1/c.png' });
    assert.deepEqual([done.restored, done.removed], [['approved/a.png', 'refs/a.png'], ['approved/c.png', 'refs/c.png']]);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.a);
    assert.deepEqual(readFileSync(join(root, 'refs', 'a.png')), BYTES.a);
    assert.ok(!existsSync(join(root, 'approved', 'c.png')) && !existsSync(join(root, 'refs', 'c.png')));
    assert.equal(outputOf(root, 'raw/s1/a.png').superseded, undefined);
    assert.equal(outputOf(root, 'raw/s1/c.png').superseded, sha256(BYTES.a));
    assert.deepEqual(readFileSync(join(root, 'raw', 's1', 'c.png')), BYTES.c);
});

test('reverting a plain supersede whose new output has no copy in refs/ restores only approved/', () => {
    const { root } = makeProject();
    approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: true });
    approveOutputs({ rootDir: root, targets: ['raw/s1/c.png'], ref: false });
    supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/c.png' });
    const done = revert(root, { newTarget: 'raw/s1/c.png' });
    assert.deepEqual([done.restored, done.removed], [['approved/a.png'], ['approved/c.png']]);
    assert.ok(!existsSync(join(root, 'refs', 'a.png')));
});

test('a later normal approval of the old output passes on the restored copies, and the new output cannot be approved or reverted again', () => {
    const { root } = afterInPlace();
    revert(root);
    const done = approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: true });
    assert.deepEqual(done[0].copiedTo, ['approved/a.png', 'refs/a.png']);
    assert.throws(() => approveOutputs({ rootDir: root, targets: ['raw/s1/b.png'], ref: true }), /raw\/s1\/b\.png was superseded by .* and cannot be approved again/);
    const log = readLogText(root);
    assert.throws(() => revert(root), /raw\/s1\/b\.png is superseded by .*, so it is not a current approval and cannot be reverted/);
    assert.equal(readLogText(root), log);
});

test('a revert dry run runs every check, reports the plan and writes nothing', () => {
    const { root } = afterInPlace();
    const state = snapshot(root);
    const done = revert(root, { dryRun: true });
    assert.deepEqual([done.restored, done.removed], [['approved/a.png', 'refs/a.png'], []]);
    assert.deepEqual(snapshot(root), state);
    rmSync(join(root, 'raw', 's1', 'a.png'));
    assert.throws(() => revert(root, { dryRun: true }), /raw\/s1\/a\.png is missing on disk/);
});

const REVERT_REFUSALS = [
    ['an output that is not approved', () => ({ target: 'raw/s1/c.png' }), /raw\/s1\/c\.png is not approved, so there is nothing to revert/],
    ['an approved output that superseded nothing', (root) => {
        approveOutputs({ rootDir: root, targets: ['raw/s1/c.png'], ref: false });
        return { target: 'raw/s1/c.png' };
    }, /Nothing was superseded by raw\/s1\/c\.png/],
    ['an output that superseded two', (root) => {
        approveOutputs({ rootDir: root, targets: ['raw/s1/c.png'], ref: false });
        const entries = readEntries(root);
        entries[1].outputs[0].superseded = sha256(BYTES.b);
        writeFileSync(join(root, 'log', 'generations.jsonl'), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
    }, /2 outputs were superseded by raw\/s1\/b\.png \(raw\/s1\/a\.png, raw\/s1\/c\.png\)\. Pass --to <file-or-sha256> with one of them/],
    ['an old file that is gone', (root) => rmSync(join(root, 'raw', 's1', 'a.png')), /raw\/s1\/a\.png is missing on disk/],
    ['an old file that is not the logged one', (root) => writeFileSync(join(root, 'raw', 's1', 'a.png'), 'changed'), /raw\/s1\/a\.png: sha256 does not match the log\. Refusing to restore/],
    ['an approved copy that is not the new output', (root) => writeFileSync(join(root, 'approved', 'a.png'), 'edited by hand'), /approved\/a\.png is not the approved file raw\/s1\/b\.png, so it will not be overwritten/],
    ['a refs copy that is not the new output', (root) => writeFileSync(join(root, 'refs', 'a.png'), 'edited by hand'), /refs\/a\.png is not the approved file raw\/s1\/b\.png/],
    ['an approved copy that is gone', (root) => rmSync(join(root, 'approved', 'a.png')), /approved\/a\.png is missing/],
];

for (const [name, prepare, message] of REVERT_REFUSALS) {
    test(`a revert refuses ${name}, and changes nothing`, () => {
        const { root } = afterInPlace();
        const { target = 'raw/s1/b.png' } = prepare(root) ?? {};
        const state = snapshot(root);
        assert.throws(() => revert(root, { newTarget: target }), message);
        assert.deepEqual(snapshot(root), state);
    });
}

test('a revert after a plain supersede refuses a different file already under the old name', () => {
    const { root } = projectWithTwoApproved();
    supersedeOutput({ rootDir: root, oldTarget: 'raw/s1/a.png', newTarget: 'raw/s1/c.png' });
    writeFileSync(join(root, 'approved', 'a.png'), 'someone else');
    const state = snapshot(root);
    assert.throws(() => revert(root, { newTarget: 'raw/s1/c.png' }), /approved\/a\.png already exists with different content/);
    assert.deepEqual(snapshot(root), state);
});

test('NOTICE.md lists the old output as current again, the new one as history, and the history line shows the revert', () => {
    const { root } = afterInPlace();
    const render = () => renderGeneratedRegion({ entries: readEntries(root).map((entry) => ({ provider: 'p', refs: [], ...entry })), tools: [], checkedOn: '2026-11-01' });
    const before = render();
    assert.match(before, new RegExp(`\\| a\\.png \\| m \\| ${sha256(BYTES.b).slice(0, 16)} \\|`));
    assert.match(before, new RegExp(`\\(${sha256(BYTES.a).slice(0, 8)} -> ${sha256(BYTES.b).slice(0, 8)}\\)`));
    revert(root);
    const after = render();
    assert.match(after, new RegExp(`\\| a\\.png \\| m \\| ${sha256(BYTES.a).slice(0, 16)} \\|`));
    assert.equal(after.match(/\| a\.png \|/g).length, 1, 'a.png is listed once');
    assert.ok(!after.includes('| b.png |'));
    assert.match(after, /Superseded approvals \(history\): 1/);
    assert.match(after, new RegExp(`\\(${sha256(BYTES.b).slice(0, 8)} -> ${sha256(BYTES.a).slice(0, 8)}\\)`));
});

/** a was superseded in place by b, b in place by c, and then c was reverted: b is current again and both a and c point at it. */
function afterChainAndRevertOfLast({ ref = true } = {}) {
    const project = projectWithSlot({ ref });
    inPlace(project.root);
    supersedeOutput({ rootDir: project.root, oldTarget: 'raw/s1/b.png', newTarget: 'raw/s1/c.png', inPlace: true });
    revert(project.root, { newTarget: 'raw/s1/c.png' });
    return project;
}

test('--to picks which of several superseded outputs a revert restores, and the others keep their history', () => {
    const { root } = afterChainAndRevertOfLast();
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.b);
    const before = readLogText(root).split('\n');
    const done = revert(root, { toTarget: 'raw/s1/a.png' });
    assert.deepEqual([done.old.file, done.new.file, done.restored, done.removed], ['raw/s1/a.png', 'raw/s1/b.png', ['approved/a.png', 'refs/a.png'], []]);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.a);
    assert.deepEqual(readFileSync(join(root, 'refs', 'a.png')), BYTES.a);
    const [first, second, third] = ['a', 'b', 'c'].map((name) => outputOf(root, `raw/s1/${name}.png`));
    assert.deepEqual([first.approved, first.superseded], [true, undefined]);
    assert.equal(second.superseded, sha256(BYTES.a));
    assert.equal(third.superseded, sha256(BYTES.b), 'c stays superseded by b, as history');
    assert.equal(readLogText(root).split('\n').length, before.length);
    assert.deepEqual([second.approvedAs, third.approvedAs], ['a.png', 'a.png']);
});

test('--to takes a sha256 prefix, and without a refs copy restores only approved/', () => {
    const { root } = afterChainAndRevertOfLast({ ref: false });
    const done = revert(root, { toTarget: sha256(BYTES.a).slice(0, 12) });
    assert.deepEqual(done.restored, ['approved/a.png']);
    assert.deepEqual(readFileSync(join(root, 'approved', 'a.png')), BYTES.a);
    assert.ok(!existsSync(join(root, 'refs')));
});

test('after a --to revert a normal check passes on the restored slot, and the outputs that were replaced cannot be approved', () => {
    const { root } = afterChainAndRevertOfLast();
    revert(root, { toTarget: 'raw/s1/a.png' });
    const done = approveOutputs({ rootDir: root, targets: ['raw/s1/a.png'], ref: true });
    assert.deepEqual(done[0].copiedTo, ['approved/a.png', 'refs/a.png']);
    for (const name of ['b', 'c']) {
        assert.throws(() => approveOutputs({ rootDir: root, targets: [`raw/s1/${name}.png`], ref: true }), /was superseded by/);
    }
});

test('a --to that is not one of the outputs superseded by the new one is refused with the candidates listed, and nothing changes', () => {
    const { root } = afterChainAndRevertOfLast();
    const state = snapshot(root);
    for (const target of ['raw/s1/b.png', sha256(BYTES.b).slice(0, 12)]) {
        assert.throws(() => revert(root, { toTarget: target }), new RegExp(`${target.replace(/[./]/g, '\\$&')} is not one of the outputs superseded by raw/s1/b\\.png\\. Candidates: raw/s1/a\\.png, raw/s1/c\\.png\\.`));
    }
    assert.throws(() => revert(root, { toTarget: 'raw/s1/zzz.png' }), /not in the log/);
    assert.deepEqual(snapshot(root), state);
    const single = afterInPlace();
    const singleState = snapshot(single.root);
    assert.throws(() => revert(single.root, { toTarget: 'raw/s1/c.png' }), /raw\/s1\/c\.png is not one of the outputs superseded by raw\/s1\/b\.png\. Candidates: raw\/s1\/a\.png\./);
    assert.deepEqual(snapshot(single.root), singleState);
});

test('without --to several candidates are still refused, and the message says to pass --to; one candidate still needs nothing', () => {
    const { root } = afterChainAndRevertOfLast();
    const state = snapshot(root);
    assert.throws(() => revert(root), /2 outputs were superseded by raw\/s1\/b\.png \(raw\/s1\/a\.png, raw\/s1\/c\.png\)\. Pass --to <file-or-sha256> with one of them to say which to restore/);
    assert.deepEqual(snapshot(root), state);
    const single = afterInPlace();
    assert.equal(revert(single.root).old.file, 'raw/s1/a.png');
});

test('a --to revert dry run runs the checks, reports the chosen output and writes nothing', () => {
    const { root } = afterChainAndRevertOfLast();
    const state = snapshot(root);
    const done = revert(root, { toTarget: 'raw/s1/a.png', dryRun: true });
    assert.deepEqual([done.old.file, done.restored], ['raw/s1/a.png', ['approved/a.png', 'refs/a.png']]);
    assert.deepEqual(snapshot(root), state);
    rmSync(join(root, 'raw', 's1', 'a.png'));
    assert.throws(() => revert(root, { toTarget: 'raw/s1/a.png', dryRun: true }), /raw\/s1\/a\.png is missing on disk/);
});

test('NOTICE.md lists the original as current after a --to revert, with a history line for each replaced output', () => {
    const { root } = afterChainAndRevertOfLast();
    revert(root, { toTarget: 'raw/s1/a.png' });
    const text = renderGeneratedRegion({ entries: readEntries(root).map((entry) => ({ provider: 'p', refs: [], ...entry })), tools: [], checkedOn: '2026-11-01' });
    assert.match(text, new RegExp(`\\| a\\.png \\| m \\| ${sha256(BYTES.a).slice(0, 16)} \\|`));
    assert.equal(text.match(/\| a\.png \|/g).length, 1);
    assert.match(text, /Superseded approvals \(history\): 2/);
    assert.match(text, new RegExp(`${sha256(BYTES.b).slice(0, 8)} -> ${sha256(BYTES.a).slice(0, 8)}`));
    assert.match(text, new RegExp(`${sha256(BYTES.c).slice(0, 8)} -> ${sha256(BYTES.b).slice(0, 8)}`));
});

/** A project whose log has one entry per `[bytes name]`, all for the file raw/s1/x.png, which holds `current` on disk. */
function rerunProject(logged, current) {
    const root = mkdtempSync(join(tmpdir(), 'sb-approve-rerun-'));
    mkdirSync(join(root, 'log'));
    mkdirSync(join(root, 'raw', 's1'), { recursive: true });
    if (current) {
        writeFileSync(join(root, 'raw', 's1', 'x.png'), BYTES[current]);
    }
    const entries = logged.map((name, index) => ({ time: `2026-11-01T1${index}:00:00.000Z`, stage: 's1', model: 'm', outputs: [{ file: 'raw/s1/x.png', sha256: sha256(BYTES[name]) }], estimatedUsd: 0, approved: false }));
    writeFileSync(join(root, 'log', 'generations.jsonl'), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    return root;
}

const approvedFlags = (root) => readEntries(root).map((entry) => entry.outputs[0].approved === true);

test('a path logged again by a re-run is approved through the entry that logged the file as it is now, never an older picture of the same path', () => {
    const forward = rerunProject(['a', 'b'], 'b');
    approveOutputs({ rootDir: forward, targets: ['raw/s1/x.png'], ref: false });
    assert.deepEqual(approvedFlags(forward), [false, true]);
    assert.deepEqual(readFileSync(join(forward, 'approved', 'x.png')), BYTES.b);

    const reverted = rerunProject(['a', 'b'], 'a');
    approveOutputs({ rootDir: reverted, targets: ['raw/s1/x.png'], ref: false });
    assert.deepEqual(approvedFlags(reverted), [true, false], 'the file is the first picture again, so the first entry is the one');
});

test('identical re-runs of a path approve the latest entry and leave the earlier ones as they were', () => {
    const root = rerunProject(['a', 'a', 'a'], 'a');
    const before = readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').split('\n');
    approveOutputs({ rootDir: root, targets: ['raw/s1/x.png'], ref: false });
    assert.deepEqual(approvedFlags(root), [false, false, true]);
    const after = readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').split('\n');
    assert.deepEqual(after.slice(0, 2), before.slice(0, 2), 'the earlier lines are byte for byte as they were');
    assert.equal(readEntries(root)[2].approved, true);
});

test('a path with several entries, none of them the file on disk, or no file on disk, is refused and writes nothing', () => {
    const changed = rerunProject(['a', 'b'], 'c');
    const log = readFileSync(join(changed, 'log', 'generations.jsonl'), 'utf8');
    assert.throws(() => approveOutputs({ rootDir: changed, targets: ['raw/s1/x.png'], ref: false }), /logged 2 times, and the file on disk \(sha256 \w+\) is none of them/);
    const missing = rerunProject(['a', 'a'], undefined);
    assert.throws(() => approveOutputs({ rootDir: missing, targets: ['raw/s1/x.png'], ref: false }), /logged 2 times and the file is missing on disk/);
    assert.ok(!existsSync(join(changed, 'approved')));
    assert.equal(readFileSync(join(changed, 'log', 'generations.jsonl'), 'utf8'), log);
});

test('a sha256 follows the same rule: identical re-runs of one file take the latest, a sha on two different files or a prefix of two shas is ambiguous', () => {
    const root = rerunProject(['a', 'b', 'a'], 'a');
    approveOutputs({ rootDir: root, targets: [sha256(BYTES.a)], ref: false });
    assert.deepEqual(approvedFlags(root), [false, false, true], 'the first entry has the same sha but is not the latest');

    const shared = rerunProject(['a'], 'a');
    writeFileSync(join(shared, 'raw', 's1', 'y.png'), BYTES.a);
    appendFileSync(join(shared, 'log', 'generations.jsonl'), `${JSON.stringify({ time: 't', outputs: [{ file: 'raw/s1/y.png', sha256: sha256(BYTES.a) }], estimatedUsd: 0, approved: false })}\n`);
    assert.throws(() => approveOutputs({ rootDir: shared, targets: [sha256(BYTES.a)], ref: false }), /matches more than one logged file \(raw\/s1\/x.png, raw\/s1\/y.png\)\. Use the file path of the one you mean\./);

    const prefixed = rerunProject([], undefined);
    const entry = (hash) => JSON.stringify({ time: 't', outputs: [{ file: 'raw/s1/x.png', sha256: hash }], estimatedUsd: 0, approved: false });
    writeFileSync(join(prefixed, 'log', 'generations.jsonl'), `${entry(`abcdef12${'0'.repeat(56)}`)}\n${entry(`abcdef12${'1'.repeat(56)}`)}\n`);
    assert.throws(() => approveOutputs({ rootDir: prefixed, targets: ['abcdef12'], ref: false }), /start of more than one sha256 .* Give more digits, or the file path\./);
});

test('a dry run of a re-run path names the entry it would approve and writes nothing', () => {
    const root = rerunProject(['a', 'b', 'b'], 'b');
    const summary = approveOutputs({ rootDir: root, targets: ['raw/s1/x.png'], ref: false, dryRun: true });
    assert.deepEqual(summary.map((item) => [item.file, item.sha256]), [['raw/s1/x.png', sha256(BYTES.b)]]);
    assert.deepEqual(approvedFlags(root), [false, false, false]);
    assert.ok(!existsSync(join(root, 'approved')));
});
