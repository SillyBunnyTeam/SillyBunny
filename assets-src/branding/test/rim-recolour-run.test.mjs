import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { approveOutputs } from '../scripts/lib/approve.mjs';
import { readLog, sha256 } from '../scripts/lib/log.mjs';
import { runRimRecolour } from '../scripts/lib/rim-recolour-run.mjs';
import { readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { getPixel } from '../test-support/synthetic.mjs';
import { EDGE, sticker } from '../test-support/sticker.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rim-recolour.mjs');
const NOW = () => new Date('2026-11-01T12:00:00.000Z');

async function workspace() {
    const rootDir = mkdtempSync(join(tmpdir(), 'sb-rim-'));
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
