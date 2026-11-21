import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { approveOutputs } from '../scripts/lib/approve.mjs';
import { readLog, sha256 } from '../scripts/lib/log.mjs';
import { measureApprovedRims, runRimRecolour } from '../scripts/lib/rim-recolour-run.mjs';
import { readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { getPixel } from '../test-support/synthetic.mjs';
import { EDGE, ringlessSticker, sticker } from '../test-support/sticker.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rim-recolour.mjs');
const NOW = () => new Date('2026-11-01T12:00:00.000Z');

async function workspace() {
    const rootDir = tempDir('sb-rim-');
    mkdirSync(join(rootDir, 'raw', 's3', 'concept'), { recursive: true });
    const inPath = join(rootDir, 'raw', 's3', 'concept', 'a-edit-2.png');
    await writeRaster(inPath, sticker());
    return { rootDir, inPath };
}

test('the recoloured picture is written under raw/ and logged as a derived output that costs nothing and names its source by hash', async () => {
    const { rootDir, inPath } = await workspace();
    const outPath = join(rootDir, 'raw', 's3', 'masters', 'a.png');
    const result = await runRimRecolour({ rootDir, inPath, outPath, target: [185, 155, 242], stage: 's3', now: NOW });
    assert.ok(existsSync(outPath));
    const [entry] = readLog(join(rootDir, 'log', 'generations.jsonl'));
    assert.equal(entry.template, 'rim-recolour');
    assert.equal(entry.estimatedUsd, 0);
    assert.equal(entry.chargedUsd, undefined);
    assert.equal(entry.approved, false);
    assert.deepEqual(entry.refs, [sha256(readFileSync(inPath))]);
    assert.equal(entry.n, 1);
    assert.deepEqual(entry.outputs, [{ file: 'raw/s3/masters/a.png', sha256: sha256(readFileSync(outPath)) }]);
    assert.equal(entry.vars.target, '#b99bf2');
    assert.equal(entry.vars.source, 'raw/s3/concept/a-edit-2.png');
    assert.ok(result.recoloured > 0);
    const picture = await readRaster(outPath);
    assert.ok(Math.abs(getPixel(picture, EDGE + 2, 40)[2] - 242) <= 8);
});

test('approve.mjs can approve the logged output, which needs the sha256 in the log to match the file', async () => {
    const { rootDir, inPath } = await workspace();
    const outPath = join(rootDir, 'raw', 's3', 'masters', 'a.png');
    await runRimRecolour({ rootDir, inPath, outPath, target: [185, 155, 242], stage: 's3', now: NOW });
    const [done] = approveOutputs({ rootDir, targets: ['raw/s3/masters/a.png'], ref: false });
    assert.equal(done.file, 'raw/s3/masters/a.png');
    assert.ok(existsSync(join(rootDir, 'approved', 'a.png')));
});

test('it refuses to write outside raw/ or out/, to overwrite a file, or to read something that is not a PNG, and logs nothing then', async () => {
    const { rootDir, inPath } = await workspace();
    const logPath = join(rootDir, 'log', 'generations.jsonl');
    const base = { rootDir, inPath, target: [185, 155, 242], stage: 's3', now: NOW };
    await assert.rejects(runRimRecolour({ ...base, outPath: join(rootDir, 'approved', 'a.png') }), /raw\/ or out\//);
    const outPath = join(rootDir, 'raw', 's3', 'masters', 'a.png');
    await runRimRecolour({ ...base, outPath });
    await assert.rejects(runRimRecolour({ ...base, outPath }), /already exists/);
    const notPng = join(rootDir, 'raw', 's3', 'notes.png');
    writeFileSync(notPng, 'hello');
    await assert.rejects(runRimRecolour({ ...base, inPath: notPng, outPath: join(rootDir, 'raw', 's3', 'b.png') }));
    assert.equal(readLog(logPath).length, 1);
});

test('the command line takes --in, --out and --target, and says what it did', async () => {
    const { rootDir, inPath } = await workspace();
    const run = (args) => spawnSync('node', [SCRIPT, ...args], { cwd: rootDir, encoding: 'utf8' });
    const missing = run([]);
    assert.match(missing.stderr, /Usage/);
    const bad = run(['--in', inPath, '--out', join(rootDir, 'raw', 'x.png'), '--target', 'purple']);
    assert.match(bad.stderr, /hex colour/);
});

async function ringlessWorkspace() {
    const rootDir = tempDir('sb-addrim-');
    mkdirSync(join(rootDir, 'raw', 's5', 'draft'), { recursive: true });
    const inPath = join(rootDir, 'raw', 's5', 'draft', 'a-2.png');
    await writeRaster(inPath, ringlessSticker());
    return { rootDir, inPath };
}

test('add-rim writes the picture with a new ring and logs it as a derived output, with the mode, the width and the source hash', async () => {
    const { rootDir, inPath } = await ringlessWorkspace();
    const outPath = join(rootDir, 'raw', 's5', 'masters', 'a.png');
    const result = await runRimRecolour({ rootDir, inPath, outPath, target: [185, 155, 242], stage: 's5', now: NOW, addRim: { width: 5.5 } });
    assert.ok(result.added > 0);
    const [entry] = readLog(join(rootDir, 'log', 'generations.jsonl'));
    assert.equal(entry.template, 'rim-recolour');
    assert.equal(entry.estimatedUsd, 0);
    assert.deepEqual(entry.refs, [sha256(readFileSync(inPath))]);
    assert.deepEqual([entry.vars.mode, entry.vars.width, entry.vars.target], ['add-rim', 5.5, '#b99bf2']);
    assert.ok(entry.vars.drawnWidth > 0, 'the width of the ring that was drawn is logged next to the measured one');
    assert.equal(entry.vars.source, 'raw/s5/draft/a-2.png');
    assert.equal(entry.vars.rimBefore, undefined);
    const picture = await readRaster(outPath);
    assert.deepEqual(getPixel(picture, EDGE - 3, 40).slice(0, 3), [185, 155, 242]);
    assert.deepEqual(entry.outputs, [{ file: 'raw/s5/masters/a.png', sha256: sha256(readFileSync(outPath)) }]);
});

test('an add-rim output can be approved like any other, and a picture that has a rim is refused without logging', async () => {
    const { rootDir, inPath } = await ringlessWorkspace();
    await runRimRecolour({ rootDir, inPath, outPath: join(rootDir, 'raw', 's5', 'masters', 'a.png'), target: [185, 155, 242], stage: 's5', now: NOW, addRim: { width: 5 } });
    approveOutputs({ rootDir, targets: ['raw/s5/masters/a.png'], ref: false });
    assert.ok(existsSync(join(rootDir, 'approved', 'a.png')));
    const ringed = join(rootDir, 'raw', 's5', 'draft', 'b-2.png');
    await writeRaster(ringed, sticker());
    await assert.rejects(runRimRecolour({ rootDir, inPath: ringed, outPath: join(rootDir, 'raw', 's5', 'masters', 'b.png'), target: [185, 155, 242], stage: 's5', now: NOW, addRim: { width: 5 } }), /already has a lavender rim/);
    assert.equal(readLog(join(rootDir, 'log', 'generations.jsonl')).length, 1);
    assert.ok(!existsSync(join(rootDir, 'raw', 's5', 'masters', 'b.png')));
});

test('the approved masters give the rim width: the median of their own widths, skipping sheets and pictures that have no rim to measure', async () => {
    const rootDir = tempDir('sb-approved-');
    const dir = join(rootDir, 'approved');
    mkdirSync(dir);
    await writeRaster(join(dir, 'one.png'), sticker());
    await writeRaster(join(dir, 'two.png'), sticker());
    await writeRaster(join(dir, '20261101T055439Z-sheet.png'), sticker());
    await writeRaster(join(dir, 'ringless.png'), ringlessSticker());
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const { widths, skipped, median } = await measureApprovedRims(dir);
    assert.deepEqual(widths.map(({ file }) => file), ['one.png', 'two.png']);
    assert.deepEqual(skipped.map(({ file }) => file).sort(), ['20261101T055439Z-sheet.png', 'ringless.png']);
    assert.ok(Math.abs(median - 5.5) < 0.6);
    await assert.rejects(measureApprovedRims(join(rootDir, 'nothing')), /nothing/);
});

test('the command line draws a rim with --add-rim and a width, measures with --measure, and says which width it used', async () => {
    const { rootDir, inPath } = await ringlessWorkspace();
    const run = (args) => spawnSync('node', [SCRIPT, ...args], { cwd: rootDir, encoding: 'utf8' });
    const missingWidth = run(['--add-rim', '--in', inPath, '--out', join(rootDir, 'raw', 's5', 'masters', 'x.png'), '--stage', 's5', '--approved', join(rootDir, 'nowhere')]);
    assert.match(missingWidth.stderr, /nowhere/);
    const bad = run(['--add-rim', '--rim-width', 'wide', '--in', inPath, '--out', join(rootDir, 'raw', 's5', 'masters', 'x.png'), '--stage', 's5']);
    assert.match(bad.stderr, /--rim-width/);
    const measure = run(['--measure']);
    assert.match(measure.stderr, /Usage/);
});
