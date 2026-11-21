import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { approveOutputs, supersedeOutput } from '../scripts/lib/approve.mjs';
import { appendLogEntry, makeLogEntry, readLog, sha256 } from '../scripts/lib/log.mjs';
import { renderGeneratedRegion } from '../scripts/lib/notice.mjs';
import { readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { parseSnapArgs } from '../scripts/lib/snap-args.mjs';
import { compareSampling, measureMasters, parseBatch, readRegions, runBatch, runSnap, snapPicture } from '../scripts/lib/snap-run.mjs';
import { buildSnapSheet, parseRegions } from '../scripts/lib/snap-sheet.mjs';
import { figure } from '../test-support/figure.mjs';
import { getPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'snap.mjs');
const NOW = () => new Date('2026-11-02T12:00:00.000Z');
const CELL = 3;
// The face of the fixture figure: where its head is, in master pixels.
const REGIONS = {
    faces: [{ name: 'face', left: { x: 100, y: 110, width: 40, height: 60 }, right: { x: 160, y: 110, width: 40, height: 60 } }],
    hands: [{ name: 'hand', box: { x: 110, y: 300, width: 60, height: 60 } }],
};

/** A package root holding an approved master `m.png` that was logged and approved the way a generated picture is. */
async function workspace() {
    const rootDir = tempDir('sb-snap-');
    mkdirSync(join(rootDir, 'raw', 's3'), { recursive: true });
    const raw = join(rootDir, 'raw', 's3', 'm.png');
    await writeRaster(raw, figure());
    const bytes = readFileSync(raw);
    appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
        time: '2026-11-01T10:00:00.000Z',
        stage: 's3',
        provider: 'openai',
        model: 'gpt-image-2.5',
        template: 'concept',
        vars: {},
        refHashes: [],
        size: '1024x1024',
        outputs: [{ file: 'raw/s3/m.png', sha256: sha256(bytes) }],
        estimatedUsd: 0.1,
    }));
    approveOutputs({ rootDir, targets: ['raw/s3/m.png'], ref: false });
    return { rootDir, master: join(rootDir, 'approved', 'm.png'), masterSha: sha256(bytes), logPath: join(rootDir, 'log', 'generations.jsonl') };
}

const snapRequest = (rootDir, master, extra = {}) => ({ rootDir, masterPath: master, options: { cell: CELL }, stage: 's5', now: NOW, ...extra });

test('a real snap is written under raw/<stage>/pixel/ and logged as a local tool with the master hash in refs and the options in vars', async () => {
    const { rootDir, master, masterSha, logPath } = await workspace();
    const result = await runSnap(snapRequest(rootDir, master));
    assert.equal(result.file, 'raw/s5/pixel/m.png');
    const entries = readLog(logPath);
    const entry = entries.at(-1);
    assert.equal(entries.length, 2);
    assert.equal(entry.provider, 'local');
    assert.equal(entry.model, 'pixel-snap');
    assert.equal(entry.template, 'pixel-snap');
    assert.equal(entry.estimatedUsd, 0);
    assert.equal(entry.approved, false);
    assert.deepEqual(entry.refs, [masterSha]);
    assert.deepEqual(entry.outputs, [{ file: 'raw/s5/pixel/m.png', sha256: sha256(readFileSync(join(rootDir, 'raw', 's5', 'pixel', 'm.png'))) }]);
    assert.equal(entry.vars.id, 'm');
    assert.equal(entry.vars.master, 'approved/m.png');
    assert.equal(entry.vars.cell, CELL);
    assert.equal(entry.vars.cellSource, 'manual');
    assert.equal(entry.vars.sample, 'median');
    assert.equal(entry.vars.colours, null);
    assert.deepEqual(entry.vars.rings, { rimWidth: 2, bandWidth: 2, rim: '#b99bf2', band: '#ffffff' });
    assert.equal(entry.vars.fixes, null);
    assert.equal(entry.size, `${result.raster.width}x${result.raster.height}`);
});

test('the snap and its options come from vars alone: snapping again with the logged cell gives the same bytes', async () => {
    const { rootDir, master, logPath } = await workspace();
    await runSnap(snapRequest(rootDir, master, { options: { figureHeight: 150 } }));
    const { vars } = readLog(logPath).at(-1);
    assert.equal(vars.cellSource, 'figure-height');
    assert.equal(vars.targetFigureHeight, 150);
    const again = await snapPicture({ rootDir, masterPath: master, options: { cell: vars.cell, sample: vars.sample } });
    const first = await readRaster(join(rootDir, 'raw', 's5', 'pixel', 'm.png'));
    assert.ok(again.raster.data.equals(first.data));
});

test('a preview is written under out/ and logs nothing, and the master is never written', async () => {
    const { rootDir, master, logPath } = await workspace();
    const before = readFileSync(master);
    const result = await runSnap({ rootDir, masterPath: master, options: { cell: CELL }, preview: true, now: NOW });
    assert.equal(result.file, 'out/snap/m-preview.png');
    assert.ok(existsSync(join(rootDir, 'out', 'snap', 'm-preview.png')));
    assert.equal(readLog(logPath).length, 1);
    assert.ok(readFileSync(master).equals(before));
    await assert.rejects(runSnap({ rootDir, masterPath: master, options: { cell: CELL }, preview: true, outPath: 'raw/s5/x.png', now: NOW }), /out\/ only/);
});

test('it refuses a stage-less logged run, an output outside raw/ or out/, a file that exists and a bad id, and logs nothing then', async () => {
    const { rootDir, master, logPath } = await workspace();
    await assert.rejects(runSnap({ rootDir, masterPath: master, options: { cell: CELL }, now: NOW }), /Pass --stage/);
    await assert.rejects(runSnap(snapRequest(rootDir, master, { outPath: join(rootDir, 'approved', 'pixel', 'm.png') })), /raw\/ or out\//);
    await assert.rejects(runSnap(snapRequest(rootDir, master, { id: 'a/b' })), /letters, digits/);
    await runSnap(snapRequest(rootDir, master));
    await assert.rejects(runSnap(snapRequest(rootDir, master)), /already exists/);
    assert.equal(readLog(logPath).length, 2);
});

test('touch-ups in fixes/<id>.json are applied after the snap, are logged with their hash, and a second snap gives the same file', async () => {
    const { rootDir, master } = await workspace();
    const plain = await snapPicture({ rootDir, masterPath: master, options: { cell: CELL } });
    const fixesDir = join(rootDir, 'fixes');
    mkdirSync(fixesDir);
    const patch = [{ x: 50, y: 60, color: '#123456' }, { x: 10, y: 10, w: 2, h: 2, color: 'transparent' }];
    writeFileSync(join(fixesDir, 'm.json'), JSON.stringify(patch));
    const fixed = await snapPicture({ rootDir, masterPath: master, options: { cell: CELL } });
    assert.deepEqual(getPixel(fixed.raster, 50, 60), [0x12, 0x34, 0x56, 255]);
    assert.deepEqual(getPixel(fixed.raster, 10, 10), [0, 0, 0, 0]);
    assert.notDeepEqual(getPixel(plain.raster, 50, 60), [0x12, 0x34, 0x56, 255]);
    assert.equal(fixed.report.fixes.edits, 2);
    assert.equal(fixed.report.fixes.file, 'fixes/m.json');
    assert.equal(fixed.report.fixes.sha256, sha256(readFileSync(join(fixesDir, 'm.json'))));
    assert.ok(fixed.report.fixes.changed >= 1);
    const again = await snapPicture({ rootDir, masterPath: master, options: { cell: CELL } });
    assert.ok(again.raster.data.equals(fixed.raster.data), 're-snapping gives the same final file');

    const run = await runSnap(snapRequest(rootDir, master));
    const [, entry] = readLog(join(rootDir, 'log', 'generations.jsonl'));
    assert.deepEqual(entry.vars.fixes, { file: 'fixes/m.json', sha256: fixed.report.fixes.sha256, edits: 2, changed: fixed.report.fixes.changed });
    assert.ok((await readRaster(join(rootDir, run.file))).data.equals(fixed.raster.data));
});

test('a patch outside the snapped picture, or a --fixes file that does not exist, stops the snap with the reason', async () => {
    const { rootDir, master } = await workspace();
    mkdirSync(join(rootDir, 'fixes'));
    writeFileSync(join(rootDir, 'fixes', 'm.json'), JSON.stringify([{ x: 5000, y: 0, color: '#000000' }]));
    await assert.rejects(snapPicture({ rootDir, masterPath: master, options: { cell: CELL } }), /outside the \d+x\d+ picture/);
    await assert.rejects(snapPicture({ rootDir, masterPath: master, options: { cell: CELL }, fixesPath: 'fixes/none.json' }), /does not exist/);
});

test('approving a snap writes approved/pixel/<id>.png and leaves the approved master alone, still approved and not superseded', async () => {
    const { rootDir, master, masterSha, logPath } = await workspace();
    const masterBytes = readFileSync(master);
    await runSnap(snapRequest(rootDir, master));
    const [done] = approveOutputs({ rootDir, targets: ['raw/s5/pixel/m.png'], ref: false });
    assert.deepEqual(done.copiedTo, ['approved/pixel/m.png']);
    assert.ok(existsSync(join(rootDir, 'approved', 'pixel', 'm.png')));
    assert.ok(readFileSync(master).equals(masterBytes), 'the master file is untouched');
    const [masterEntry, snapEntry] = readLog(logPath);
    assert.equal(masterEntry.outputs[0].approved, true);
    assert.equal(masterEntry.outputs[0].superseded, undefined);
    assert.equal(masterEntry.outputs[0].sha256, masterSha);
    assert.equal(snapEntry.outputs[0].approved, true);
    assert.equal(snapEntry.outputs[0].approvedAs, 'pixel/m.png');
    assert.equal(snapEntry.outputs[0].superseded, undefined);
});

test('NOTICE lists the snap under its subfolder name next to the master, and the pixel-snap tool in the generations table', async () => {
    const { rootDir, master, logPath } = await workspace();
    await runSnap(snapRequest(rootDir, master));
    approveOutputs({ rootDir, targets: ['raw/s5/pixel/m.png'], ref: false });
    const text = renderGeneratedRegion({ entries: readLog(logPath), tools: [], checkedOn: '2026-11-02' });
    assert.match(text, /\| m\.png \| gpt-image-2\.5 \|/);
    assert.match(text, /\| pixel\/m\.png \| pixel-snap \|/);
    assert.match(text, /\| local \| pixel-snap \| 1 \| 2026-11-02 \| 2026-11-02 \| 1 \|/);
    assert.doesNotMatch(text, /Superseded approvals/);
});

test('a snap can never supersede a master, but a newer snap can replace an older one in place', async () => {
    const { rootDir, master, logPath } = await workspace();
    await runSnap(snapRequest(rootDir, master));
    approveOutputs({ rootDir, targets: ['raw/s5/pixel/m.png'], ref: false });
    const [masterEntry] = readLog(logPath);
    assert.throws(() => supersedeOutput({ rootDir, oldTarget: 'raw/s3/m.png', newTarget: 'raw/s5/pixel/m.png', inPlace: true }), /A snap never replaces approved art/);
    assert.throws(() => supersedeOutput({ rootDir, oldTarget: masterEntry.outputs[0].sha256, newTarget: 'raw/s5/pixel/m.png' }), /A snap never replaces approved art/);

    await runSnap(snapRequest(rootDir, master, { options: { cell: 3.2 }, outPath: 'raw/s5/pixel-2/m.png' }));
    assert.throws(() => approveOutputs({ rootDir, targets: ['raw/s5/pixel-2/m.png'], ref: false }), /already exists with different content\. To replace approved pixel art, use --supersede/);
    supersedeOutput({ rootDir, oldTarget: 'raw/s5/pixel/m.png', newTarget: 'raw/s5/pixel-2/m.png', inPlace: true });
    const entries = readLog(logPath);
    assert.equal(entries[0].outputs[0].superseded, undefined, 'the master is still current');
    assert.equal(entries[1].outputs[0].superseded, entries[2].outputs[0].sha256);
    assert.equal(entries[2].outputs[0].approvedAs, 'pixel/m.png');
    assert.equal(sha256(readFileSync(join(rootDir, 'approved', 'pixel', 'm.png'))), entries[2].outputs[0].sha256);
});

test('a snap entry without a usable id is not approved, so it cannot land on a made-up name', async () => {
    const { rootDir, master, logPath } = await workspace();
    await runSnap(snapRequest(rootDir, master));
    const lines = readFileSync(logPath, 'utf8').split('\n');
    const broken = JSON.parse(lines[1]);
    broken.vars.id = '../x';
    lines[1] = JSON.stringify(broken);
    writeFileSync(logPath, lines.join('\n'));
    assert.throws(() => approveOutputs({ rootDir, targets: ['raw/s5/pixel/m.png'], ref: false }), /without a usable id/);
});

test('the pitch of each approved master is measured, with a design sheet skipped and a target height compared', async () => {
    const { rootDir } = await workspace();
    await writeRaster(join(rootDir, 'approved', '20261101T055439Z-sheet.png'), figure());
    const { rows, skipped } = await measureMasters({ approvedDir: join(rootDir, 'approved'), figureHeight: 150 });
    assert.deepEqual(rows.map((row) => row.id), ['m']);
    assert.deepEqual(skipped.map((item) => item.file), ['20261101T055439Z-sheet.png']);
    const [row] = rows;
    assert.ok(row.pitchAcross > 2.2 && row.pitchDown > 2.2);
    assert.equal(row.target.figureHeight, 150);
    assert.ok(Math.abs(row.target.cell - row.figure.height / 150) < 1e-9);
    assert.equal((await measureMasters({ approvedDir: join(rootDir, 'approved'), only: ['nothing'] })).rows.length, 0);
});

test('the review sheet holds the master and snap side by side, the snap at 1x and 2x, both sides of the face and the hands', async () => {
    const { rootDir, master } = await workspace();
    const snap = await snapPicture({ rootDir, masterPath: master, options: { cell: CELL } });
    const grid = { cell: CELL, offsetX: snap.report.offset.x, offsetY: snap.report.offset.y };
    const plain = await sharp(await buildSnapSheet({ master: snap.master, native: snap.raster, grid, caption: 'm' })).metadata();
    const full = await sharp(await buildSnapSheet({ master: snap.master, native: snap.raster, grid, regions: parseRegions(REGIONS, snap.master), caption: 'm' })).metadata();
    assert.ok(plain.width >= snap.raster.width * 3 * 2, 'two overview panels of 3x');
    assert.ok(full.height > plain.height, 'the close-ups add rows');
    assert.ok(full.width >= plain.width);
});

test('review regions outside the master, or boxes that are not whole numbers, are refused', () => {
    assert.throws(() => parseRegions({ faces: [{ name: 'f', left: { x: 0, y: 0, width: 5000, height: 5 }, right: { x: 0, y: 0, width: 5, height: 5 } }] }, { width: 100, height: 100 }), /reaches outside the 100x100 master/);
    assert.throws(() => parseRegions({ hands: [{ box: { x: 1.5, y: 0, width: 5, height: 5 } }] }, { width: 100, height: 100 }), /whole numbers/);
    assert.deepEqual(parseRegions({}, { width: 10, height: 10 }), { faces: [], hands: [] });
});

test('review/<id>.json is read when it exists and is empty when it does not', async () => {
    const { rootDir, master } = await workspace();
    const picture = await readRaster(master);
    assert.deepEqual(readRegions({ rootDir, id: 'm', master: picture }), { faces: [], hands: [] });
    mkdirSync(join(rootDir, 'review'));
    writeFileSync(join(rootDir, 'review', 'm.json'), JSON.stringify(REGIONS));
    assert.equal(readRegions({ rootDir, id: 'm', master: picture }).faces.length, 1);
});

test('the sampling comparison snaps four ways on one grid and writes a sheet under out/ only when asked', async () => {
    const { rootDir, master, logPath } = await workspace();
    const outcome = await compareSampling({ rootDir, masterPath: master, options: { cell: CELL }, colours: 12, sheetPath: 'out/snap/m-sampling.png' });
    assert.deepEqual(outcome.results.map((result) => [result.sample, result.colours]), [['median', null], ['mode', null], ['median', 12], ['mode', 12]]);
    assert.ok(outcome.results[2].distinctColours <= 14, 'the palette plus the two ring colours');
    assert.ok(outcome.results[0].distinctColours >= outcome.results[2].distinctColours);
    assert.ok(existsSync(join(rootDir, 'out', 'snap', 'm-sampling.png')));
    assert.equal(readLog(logPath).length, 1, 'a comparison logs nothing');
    await assert.rejects(compareSampling({ rootDir, masterPath: master, options: { cell: CELL }, colours: 12, sheetPath: 'approved/x.png' }), /raw\/ or out\//);
});

test('snap.mjs arguments are parsed into a trusted request, and bad ones fail before a file is read', () => {
    const snap = parseSnapArgs(['--in', 'approved/m.png', '--stage', 's5', '--figure-height', '300', '--sample', 'mode', '--colours', '24', '--no-ring-repair']);
    assert.equal(snap.mode, 'snap');
    assert.deepEqual([snap.options.figureHeight, snap.options.sample, snap.options.colours, snap.options.ringRepair], [300, 'mode', 24, false]);
    assert.equal(parseSnapArgs(['--in', 'a.png', '--cell', '3.4', '--preview']).options.cell, 3.4);
    assert.deepEqual(parseSnapArgs(['--measure', '--only', 'a, b', '--figure-height', '300']), { mode: 'measure', approved: 'approved', only: ['a', 'b'], figureHeight: 300, bodySheet: undefined });
    assert.equal(parseSnapArgs(['--compare', '--in', 'a.png']).mode, 'compare');
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--cell', '3', '--figure-height', '300']), /Pass one of --cell, --figure-height, --body-height and --detect, not --cell and --figure-height/);
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--cell', '1']), /--cell must be/);
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--figure-height', '4']), /--figure-height must be/);
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--colours', '1.5']), /--colours must be/);
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--sample', 'centre']), /--sample must be one of median, mode/);
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--no-ring-repair', '--rim-width', '2']), /builds no rings/);
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--preview', '--stage', 's5']), /logs nothing/);
    assert.throws(() => parseSnapArgs(['--measure', '--compare']), /not both/);
    const sized = parseSnapArgs(['--in', 'approved/m.png', '--stage', 's5', '--body-height', '283', '--character', 'tewi']);
    assert.deepEqual([sized.options.bodyHeight, sized.character, sized.detect], [283, 'tewi', false]);
    assert.equal(parseSnapArgs(['--in', 'a.png', '--detect', '--preview']).detect, true);
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--body-height', '4']), /--body-height must be/);
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--detect', '--cell', '3']), /Pass one of .* not --cell and --detect/);
    const batch = parseSnapArgs(['--batch', 'snap-batch.json', '--stage', 's5', '--out-dir', 'raw/s5/pixel-body', '--sheet-dir', 'out/snap']);
    assert.deepEqual([batch.mode, batch.batchPath, batch.stage, batch.outDir, batch.sheetDir, batch.dryRun], ['batch', 'snap-batch.json', 's5', 'raw/s5/pixel-body', 'out/snap', false]);
    assert.equal(parseSnapArgs(['--batch', 'b.json', '--dry-run']).dryRun, true);
    assert.throws(() => parseSnapArgs(['--batch', 'b.json']), /Pass --stage .* or --dry-run/);
    assert.throws(() => parseSnapArgs(['--batch', 'b.json', '--dry-run', '--in', 'a.png']), /takes its pictures and their sizes from the batch file/);
    assert.throws(() => parseSnapArgs([]), /Pass --in/);
});

test('snap.mjs --measure prints the pitch table of a folder of masters without writing anything', async () => {
    const { rootDir } = await workspace();
    const result = spawnSync('node', [SCRIPT, '--measure', '--approved', join(rootDir, 'approved'), '--figure-height', '150'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^picture +character +box px +head top +feet +head to feet/m);
    assert.match(result.stdout, /^m +- +\d+ +\d+ +\d+ +\d+ \(\d+\.\d%\) +\d\.\d\d \(\d+\) strength/m);
    assert.match(result.stdout, /at 150 art px \(whole box\): cell \d\.\d\d/);
    assert.match(spawnSync('node', [SCRIPT, '--cell', '3'], { encoding: 'utf8' }).stderr, /Pass --in/);
});

/** The workspace with the config and the character list the body height is read from. */
async function configured({ characters = ['tewi'] } = {}) {
    const space = await workspace();
    writeFileSync(join(space.rootDir, 'snap-config.json'), JSON.stringify({ bodyHeights: { tewi: 100, reisen: 120 }, lineupRatio: 0.8333 }));
    mkdirSync(join(space.rootDir, 'prompts'));
    writeFileSync(join(space.rootDir, 'prompts', 's5-masters.json'), JSON.stringify({ assets: { m: { characters } } }));
    return space;
}

test('with no size given, a master is snapped at the body height set for its character, and --detect keeps the detected pitch', async () => {
    const { rootDir, master } = await configured();
    const set = await snapPicture({ rootDir, masterPath: master });
    assert.equal(set.character, 'tewi');
    assert.equal(set.report.cellSource, 'body-height');
    assert.equal(set.report.targetBodyHeight, 100);
    assert.ok(Math.abs(set.report.body.height - 100) <= 4, `head to feet ${set.report.body.height}`);
    assert.deepEqual(set.report.body.problems, []);
    const named = await snapPicture({ rootDir, masterPath: master, character: 'reisen' });
    assert.equal(named.report.targetBodyHeight, 120);
    assert.ok(named.report.cell < set.report.cell, 'the taller height asks for a finer cell');
    assert.equal((await snapPicture({ rootDir, masterPath: master, detect: true })).report.cellSource, 'detected');
    assert.equal((await snapPicture({ rootDir, masterPath: master, options: { cell: CELL } })).report.cellSource, 'manual');
});

test('a picture of both characters has no body height, and the refusal says how to snap a scene instead', async () => {
    const { rootDir, master } = await configured({ characters: ['reisen', 'tewi'] });
    await assert.rejects(snapPicture({ rootDir, masterPath: master }), /shows reisen and tewi, so it has no one body height/);
    assert.equal((await snapPicture({ rootDir, masterPath: master, character: 'tewi' })).report.targetBodyHeight, 100);
});

test('a real snap logs the character and the body height it was asked for and got', async () => {
    const { rootDir, master, logPath } = await configured();
    await runSnap({ rootDir, masterPath: master, stage: 's5', now: NOW });
    const { vars } = readLog(logPath).at(-1);
    assert.equal(vars.character, 'tewi');
    assert.equal(vars.cellSource, 'body-height');
    assert.equal(vars.targetBodyHeight, 100);
    assert.ok(Math.abs(vars.bodyArtPixels - 100) <= 4);
});

test('the measure gives each master its set body height as a cell, and flags a head top that is missing or feet at the canvas edge', async () => {
    const { rootDir } = await configured();
    await writeRaster(join(rootDir, 'approved', 'edge.png'), figure({ height: 472 }));
    const { rows } = await measureMasters({ rootDir, approvedDir: join(rootDir, 'approved') });
    const [edge, ok] = ['edge', 'm'].map((id) => rows.find((row) => row.id === id));
    assert.equal(ok.character, 'tewi');
    assert.equal(ok.set.bodyHeight, 100);
    assert.ok(Math.abs(ok.set.cell - ok.body.height / 100) < 1e-9);
    assert.ok(Math.abs(ok.set.boxArtHeight - ok.figure.height / ok.set.cell) < 1e-9);
    assert.deepEqual(ok.flags, []);
    assert.equal(edge.set, null, 'a picture that is not in the character list has no set height');
    assert.match(edge.flags.join(' '), /feet reach the bottom edge/);
});

test('a batch file is parsed into items with ids, and an unknown key, a missing picture name, no items or two of one id are refused', () => {
    const parsed = parseBatch({ outDir: 'raw/s5/pixel-body', items: [{ in: 'approved/a.png' }, { in: 'raw/s5/x.png', id: 'b', character: 'tewi', bodyHeight: 283 }] });
    assert.deepEqual(parsed.items.map((item) => [item.id, item.character, item.options.bodyHeight]), [['a', undefined, undefined], ['b', 'tewi', 283]]);
    assert.throws(() => parseBatch({ items: [{ in: 'a.png' }], extra: 1 }), /unknown key "extra"/);
    assert.throws(() => parseBatch({ items: [{ in: 'a.png', size: 3 }] }), /Batch item 1 \(a.png\): unknown key "size"/);
    assert.throws(() => parseBatch({ items: [{ id: 'a' }] }), /needs "in"/);
    assert.throws(() => parseBatch({ items: [] }), /at least one picture/);
    assert.throws(() => parseBatch({ items: [{ in: 'a/x.png' }, { in: 'b/x.png' }] }), /two pictures are called "x"/);
});

test('a batch snaps every picture in this process, writing and logging one after the other', async () => {
    const { rootDir, master, logPath } = await configured();
    const batch = parseBatch({ outDir: 'raw/s5/pixel-body', items: [{ in: master, id: 'a', character: 'tewi' }, { in: master, id: 'b', character: 'reisen' }] });
    const results = await runBatch({ rootDir, batch, stage: 's5', sheetDir: 'out/snap', now: NOW });
    assert.deepEqual(results.map((result) => [result.id, result.file]), [['a', 'raw/s5/pixel-body/a.png'], ['b', 'raw/s5/pixel-body/b.png']]);
    assert.deepEqual(readLog(logPath).slice(-2).map((entry) => [entry.vars.id, entry.vars.targetBodyHeight]), [['a', 100], ['b', 120]]);
    assert.ok(existsSync(join(rootDir, 'raw', 's5', 'pixel-body', 'b.png')));
    assert.ok(existsSync(join(rootDir, 'out', 'snap', 'a-sheet.png')));
});

test('a batch dry run writes and logs nothing, and a batch with one bad picture writes and logs nothing for any of them', async () => {
    const { rootDir, master, logPath } = await configured();
    const good = { in: master, id: 'a', character: 'tewi' };
    const dry = await runBatch({ rootDir, batch: parseBatch({ outDir: 'raw/s5/pixel-body', items: [good] }), dryRun: true, sheetDir: 'out/snap', now: NOW });
    assert.equal(dry[0].report.targetBodyHeight, 100);
    assert.ok(!existsSync(join(rootDir, 'raw', 's5', 'pixel-body')));
    assert.ok(!existsSync(join(rootDir, 'out')));
    assert.equal(readLog(logPath).length, 1);

    const bad = parseBatch({ outDir: 'raw/s5/pixel-body', items: [good, { in: join(rootDir, 'approved', 'missing.png'), id: 'z', character: 'tewi' }] });
    await assert.rejects(runBatch({ rootDir, batch: bad, stage: 's5', now: NOW }), /z: .* Nothing was written\./);
    assert.ok(!existsSync(join(rootDir, 'raw', 's5', 'pixel-body', 'a.png')), 'the picture before the bad one was not written');
    assert.equal(readLog(logPath).length, 1);
    await assert.rejects(runBatch({ rootDir, batch: parseBatch({ items: [good] }), now: NOW }), /Pass --stage .* or --dry-run/);
});

test('the review boxes of the package are inside their 1024 pixel pictures, and every single-character master and every batch still has a face and a hand', () => {
    const packageRoot = join(dirname(SCRIPT), '..');
    const assets = JSON.parse(readFileSync(join(packageRoot, 'prompts', 's5-masters.json'), 'utf8')).assets;
    const singles = Object.keys(assets).filter((id) => assets[id].characters.length === 1);
    const batch = parseBatch(JSON.parse(readFileSync(join(packageRoot, 'snap-batch.json'), 'utf8')));
    // The moon and the stars are decoration, not figures: they take a figure height and have no face or hands to look at.
    const wanted = new Set([...singles, ...batch.items.filter((item) => item.options.figureHeight === undefined).map((item) => item.id)]);
    const present = new Set(readdirSync(join(packageRoot, 'review')).map((file) => file.replace(/\.json$/, '')));
    assert.deepEqual([...wanted].filter((id) => !present.has(id)), [], 'a picture without a review file');
    for (const id of wanted) {
        const regions = parseRegions(JSON.parse(readFileSync(join(packageRoot, 'review', `${id}.json`), 'utf8')), { width: 1024, height: 1024 });
        assert.ok(regions.faces.length >= 1 && regions.hands.length >= 1, `${id} needs a face and a hand`);
    }
});

test('every picture is snapped with the ring widths of the config, whatever its master\'s rings, and a flag or batch key for one picture overrides them', async () => {
    const { rootDir, master } = await configured();
    writeFileSync(join(rootDir, 'snap-config.json'), JSON.stringify({ bodyHeights: { tewi: 100, reisen: 120 }, lineupRatio: 0.8333, rings: { rim: 2, band: 2 } }));
    for (const sticker of [3, 12]) {
        const stickered = join(rootDir, `sticker-${sticker}.png`);
        await writeRaster(stickered, figure({ sticker }));
        const snap = await snapPicture({ rootDir, masterPath: stickered, id: 'm' });
        assert.deepEqual([snap.report.rings.rimWidth, snap.report.rings.bandWidth], [2, 2]);
        assert.deepEqual([snap.report.rings.measured.rimWidth, snap.report.rings.measured.bandWidth], [2, 2], `master rings ${sticker} px wide`);
        assert.deepEqual(snap.report.body.problems, []);
    }
    const own = await snapPicture({ rootDir, masterPath: master, options: { rimWidth: 3, bandWidth: 1 } });
    assert.deepEqual([own.report.rings.measured.rimWidth, own.report.rings.measured.bandWidth], [3, 1]);
    const fromBatch = parseBatch({ items: [{ in: 'a.png', rimWidth: 3, bandWidth: 1 }] });
    assert.deepEqual([fromBatch.items[0].options.rimWidth, fromBatch.items[0].options.bandWidth], [3, 1]);
    await runSnap({ rootDir, masterPath: master, stage: 's5', now: NOW });
    const { vars } = readLog(join(rootDir, 'log', 'generations.jsonl')).at(-1);
    assert.deepEqual(vars.rings, { rimWidth: 2, bandWidth: 2, rim: '#b99bf2', band: '#ffffff' });
    assert.deepEqual(vars.ringsMeasured, { rimWidth: 2, bandWidth: 2 });
});

test('a ring the measure finds different from the one asked for is a CHECK of the snap', async () => {
    const { rootDir, master } = await configured();
    const fixesDir = join(rootDir, 'fixes');
    mkdirSync(fixesDir);
    const ok = await snapPicture({ rootDir, masterPath: master, options: { cell: CELL, rimWidth: 2, bandWidth: 2 } });
    const edge = ok.report.figure;
    writeFileSync(join(fixesDir, 'm.json'), JSON.stringify([{ x: edge.x + Math.floor(edge.width / 2), y: edge.y, color: '#101010' }]));
    const touched = await snapPicture({ rootDir, masterPath: master, options: { cell: CELL, rimWidth: 2, bandWidth: 2 } });
    assert.match(touched.report.body.problems.join(' '), /rings measure rim 0 \+ band 0 art px, not the rim 2 \+ band 2/);
});
