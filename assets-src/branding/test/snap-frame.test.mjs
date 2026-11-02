import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approveOutputs } from '../scripts/lib/approve.mjs';
import { appendLogEntry, makeLogEntry, readLog, sha256 } from '../scripts/lib/log.mjs';
import { chooseGrid, snapRaster } from '../scripts/lib/pixel-snap.mjs';
import { readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { parseSnapArgs } from '../scripts/lib/snap-args.mjs';
import { allowedArtBox, boxOfPixels, changedPixels, checkFrame, findBaseSnap, FRAME_MARGIN, masterBoxOf, parseFrameRegion } from '../scripts/lib/snap-frame.mjs';
import { runSnap } from '../scripts/lib/snap-run.mjs';
import { figure } from '../test-support/figure.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const NOW = () => new Date('2026-11-02T12:00:00.000Z');
const CELL = 3.2;
// Where the patch below closes the eyes, in master pixels, and a region around it.
const EYES = { x: 130, y: 148, width: 20, height: 10 };
const REGION = '126,144,28,18';
const DARK = [20, 20, 40, 255];

/** Closes the eyes of a master of the fixture figure: a block of dark pixels on the face. */
function blink(master) {
    const patched = { ...master, data: Buffer.from(master.data) };
    for (let y = EYES.y; y < EYES.y + EYES.height; y++) {
        for (let x = EYES.x; x < EYES.x + EYES.width; x++) {
            setPixel(patched, x, y, DARK);
        }
    }
    return patched;
}

/**
 * A package with an approved master `m.png` and its snap `m` (cell 3.2, grid detected) approved as approved/pixel/m.png, and the patched copy
 * of the master (eyes closed) at raw/s5/patched/m--blink.png.
 */
async function workspace({ fixes } = {}) {
    const rootDir = tempDir('sb-frame-');
    mkdirSync(join(rootDir, 'raw', 's3'), { recursive: true });
    const raw = join(rootDir, 'raw', 's3', 'm.png');
    await writeRaster(raw, figure());
    const logPath = join(rootDir, 'log', 'generations.jsonl');
    appendLogEntry(logPath, makeLogEntry({
        time: '2026-11-01T10:00:00.000Z',
        stage: 's3',
        provider: 'openai',
        model: 'gpt-image-2.5',
        template: 'concept',
        vars: {},
        refHashes: [],
        size: '1024x1024',
        outputs: [{ file: 'raw/s3/m.png', sha256: sha256(readFileSync(raw)) }],
        estimatedUsd: 0.1,
    }));
    approveOutputs({ rootDir, targets: ['raw/s3/m.png'], ref: false });
    const master = join(rootDir, 'approved', 'm.png');
    if (fixes) {
        mkdirSync(join(rootDir, 'fixes'));
        writeFileSync(join(rootDir, 'fixes', 'm.json'), JSON.stringify(fixes));
    }
    await runSnap({ rootDir, masterPath: master, options: { cell: CELL }, stage: 's5', now: NOW });
    approveOutputs({ rootDir, targets: ['raw/s5/pixel/m.png'], ref: false });
    mkdirSync(join(rootDir, 'raw', 's5', 'patched'), { recursive: true });
    const patched = join(rootDir, 'raw', 's5', 'patched', 'm--blink.png');
    await writeRaster(patched, blink(await readRaster(master)));
    return { rootDir, master, patched, logPath, base: join(rootDir, 'approved', 'pixel', 'm.png') };
}

const frameRequest = (space, extra = {}) => ({
    rootDir: space.rootDir,
    masterPath: space.patched,
    gridFrom: 'approved/pixel/m.png',
    id: 'm--blink',
    frameRegion: parseFrameRegion(REGION),
    stage: 's5',
    now: NOW,
    ...extra,
});

/** Runs a request that must be refused, and shows that it left the log and the folder as they were. */
async function assertRefused(space, request, message) {
    const logBefore = readFileSync(space.logPath, 'utf8');
    await assert.rejects(runSnap(request), message);
    assert.equal(readFileSync(space.logPath, 'utf8'), logBefore, 'nothing was logged');
    assert.equal(existsSync(join(space.rootDir, 'raw', 's5', 'pixel', 'm--blink.png')), false, 'nothing was written');
}

test('a frame takes the cell, offset and rings of its base snap with nothing detected, and differs from the base only where the patch is', async () => {
    const space = await workspace();
    const [, baseEntry] = readLog(space.logPath);
    const result = await runSnap(frameRequest(space));
    assert.equal(result.file, 'raw/s5/pixel/m--blink.png');

    const entry = readLog(space.logPath).at(-1);
    const { vars } = entry;
    assert.equal(vars.id, 'm--blink');
    assert.equal(vars.cellSource, 'grid-from');
    assert.equal(vars.cell, baseEntry.vars.cell);
    assert.deepEqual(vars.offset, baseEntry.vars.offset);
    assert.deepEqual([vars.sample, vars.colours, vars.ringRepair, vars.rings], [baseEntry.vars.sample, baseEntry.vars.colours, baseEntry.vars.ringRepair, baseEntry.vars.rings]);
    assert.equal(vars.pitch, null, 'no pitch was detected');
    assert.deepEqual(vars.gridFrom, { id: 'm', sha256: baseEntry.outputs[0].sha256, file: 'approved/pixel/m.png' });
    assert.equal(vars.master, 'raw/s5/patched/m--blink.png');
    assert.deepEqual(entry.refs, [sha256(readFileSync(space.patched)), baseEntry.outputs[0].sha256], 'the patched still, then the base snap');
    assert.equal(entry.model, 'pixel-snap');
    assert.equal(entry.estimatedUsd, 0);

    const base = await readRaster(space.base);
    const frame = await readRaster(join(space.rootDir, result.file));
    assert.deepEqual([frame.width, frame.height], [base.width, base.height]);
    const changed = changedPixels(base, frame);
    assert.ok(changed.length > 0 && changed.length === result.report.frame.changed);
    assert.deepEqual(vars.frame, { changed: changed.length, box: boxOfPixels(changed, frame.width), masterBox: result.report.frame.masterBox, region: parseFrameRegion(REGION) });
    const { box } = result.report.frame;
    for (let y = 0; y < base.height; y++) {
        for (let x = 0; x < base.width; x++) {
            const inside = x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
            if (!inside) {
                assert.deepEqual(getPixel(frame, x, y), getPixel(base, x, y), `pixel ${x},${y} outside the changed box is the base's`);
            }
        }
    }
    const [eye] = [getPixel(frame, Math.round((EYES.x + 10 - vars.offset.x) / vars.cell), Math.round((EYES.y + 5 - vars.offset.y) / vars.cell))];
    assert.deepEqual(eye, [20, 20, 40, 255], 'the closed eye is in the frame');
});

test('a frame is approved as approved/pixel/<base id>--<name>.png, beside the base, which is left as it was', async () => {
    const space = await workspace();
    const baseBytes = readFileSync(space.base);
    await runSnap(frameRequest(space));
    const [done] = approveOutputs({ rootDir: space.rootDir, targets: ['raw/s5/pixel/m--blink.png'], ref: false });
    assert.deepEqual(done.copiedTo, ['approved/pixel/m--blink.png']);
    assert.ok(readFileSync(space.base).equals(baseBytes));
    assert.ok(existsSync(join(space.rootDir, 'approved', 'pixel', 'm--blink.png')));
});

test('a preview frame is written under out/ and logs nothing', async () => {
    const space = await workspace();
    const result = await runSnap(frameRequest(space, { stage: undefined, preview: true }));
    assert.equal(result.file, 'out/snap/m--blink-preview.png');
    assert.ok(existsSync(join(space.rootDir, 'out', 'snap', 'm--blink-preview.png')));
    assert.equal(readLog(space.logPath).length, 2, 'the master and the snap, and nothing for the preview');
});

test('the base is found by its approved file, the file the snap logged, or its sha256, and two copies of one content are told apart by the path only', async () => {
    const space = await workspace();
    await runSnap({ rootDir: space.rootDir, masterPath: space.master, id: 'm2', options: { cell: CELL }, stage: 's5', now: NOW });
    approveOutputs({ rootDir: space.rootDir, targets: ['raw/s5/pixel/m2.png'], ref: false });
    await runSnap({ rootDir: space.rootDir, masterPath: space.master, id: 'n', options: { cell: 3.4 }, stage: 's5', now: NOW });
    approveOutputs({ rootDir: space.rootDir, targets: ['raw/s5/pixel/n.png'], ref: false });
    const find = async (from) => (await findBaseSnap({ rootDir: space.rootDir, from })).id;

    assert.equal(await find('approved/pixel/m.png'), 'm');
    assert.equal(await find('approved/pixel/m2.png'), 'm2', 'the same bytes as m, told apart by the approved name');
    assert.equal(await find('raw/s5/pixel/m.png'), 'm');
    assert.equal(await find(join(space.rootDir, 'approved', 'pixel', 'n.png')), 'n');
    const nSha = sha256(readFileSync(join(space.rootDir, 'approved', 'pixel', 'n.png')));
    assert.equal(await find(nSha), 'n');
    assert.equal(await find(nSha.slice(0, 10)), 'n');
    const mSha = sha256(readFileSync(space.base));
    await assert.rejects(find(mSha), /sha256 of more than one picture \(m, m2\)\. Give the file path/);
    await assert.rejects(find('abcdef12'), /not the sha256 of a logged snap/);
    await assert.rejects(find('approved/pixel/missing.png'), /not a file, and not a sha256/);
    await assert.rejects(find('approved/m.png'), /not the output of a logged snap/);
});

test('a file edited since the snap, or a sha that is no snap, is not taken as a base', async () => {
    const space = await workspace();
    const edited = await readRaster(space.base);
    setPixel(edited, 0, 0, [1, 2, 3, 255]);
    await writeRaster(space.base, edited);
    await assertRefused(space, frameRequest(space), /is not the picture the log recorded for it/);
});

test('a frame must be called <base id>--<name>, whether the id is given or comes from the file name', async () => {
    const space = await workspace();
    await assertRefused(space, frameRequest(space, { id: 'blink' }), /must be "m--<name>" \(such as m--blink\), got "blink"/);
    await assertRefused(space, frameRequest(space, { id: 'm--' }), /must be "m--<name>"/);
    const unnamed = join(space.rootDir, 'raw', 's5', 'patched', 'blink.png');
    await writeRaster(unnamed, await readRaster(space.patched));
    await assertRefused(space, frameRequest(space, { id: undefined, masterPath: unnamed }), /got "blink"/);
});

test('a frame that changed pixels outside the region and its margin is refused, with the box that changed, and nothing is written', async () => {
    const space = await workspace();
    const stray = blink(await readRaster(space.master));
    for (let y = 300; y < 330; y++) {
        for (let x = 125; x < 175; x++) {
            setPixel(stray, x, y, DARK);
        }
    }
    await writeRaster(space.patched, stray, {});
    await assertRefused(space, frameRequest(space), /\d+ of the \d+ art pixels that changed lie outside --frame-region 126,144,28,18 plus 2 art px: they are in the box \d+x\d+ at \d+,\d+ art px \(\d+x\d+ at \d+,\d+ master px\)\. A blink should change only the eyes/);
    // Without a region the same frame is only reported.
    const { frameRegion, ...withoutRegion } = frameRequest(space);
    const result = await runSnap(withoutRegion);
    assert.equal(frameRegion.width, 28);
    assert.equal(result.report.frame.region, null);
    assert.ok(result.report.frame.box.height > 20, 'the box reaches from the eyes down to the stray block');
});

test('a region that is too small for the patch refuses it, and one with the margin accepts a change just beyond the region', async () => {
    const space = await workspace();
    await assertRefused(space, frameRequest(space, { frameRegion: parseFrameRegion('130,148,6,4') }), /outside --frame-region 130,148,6,4/);
    const result = await runSnap(frameRequest(space, { frameRegion: parseFrameRegion(`${EYES.x + 2},${EYES.y + 2},${EYES.width - 4},${EYES.height - 4}`) }));
    assert.ok(result.report.frame.changed > 0, 'the patch reaches 2 master pixels past this region, inside the cell and margin');
});

test('a frame identical to its base, of another size, or with a region outside the picture is refused', async () => {
    const space = await workspace();
    await assertRefused(space, frameRequest(space, { masterPath: space.master }), /identical to its base "m" on the grid: no art pixel changed/);
    const wider = join(space.rootDir, 'raw', 's5', 'patched', 'wide.png');
    await writeRaster(wider, blink(figure({ width: 340 })));
    await assertRefused(space, frameRequest(space, { masterPath: wider }), /snaps to \d+x\d+ art pixels and its base "m" is \d+x\d+/);
    await assertRefused(space, frameRequest(space, { frameRegion: parseFrameRegion('250,500,100,100') }), /is not inside the 300x520 picture/);
});

test('--frame-region without --grid-from is refused', async () => {
    const space = await workspace();
    await assertRefused(space, { rootDir: space.rootDir, masterPath: space.patched, id: 'x', options: { cell: CELL }, frameRegion: parseFrameRegion(REGION), stage: 's5', now: NOW }, /needs --grid-from/);
});

test('a frame gets the touch-ups of its base snap, as long as the file is the one the log recorded', async () => {
    const space = await workspace({ fixes: [{ x: 50, y: 60, color: '#123456' }] });
    const own = join(space.rootDir, 'fixes', 'm--blink.json');
    writeFileSync(own, JSON.stringify([{ x: 1, y: 1, color: '#000000' }]));
    await assertRefused(space, frameRequest(space), /fixes\/m--blink\.json exists, but a frame gets the touch-ups of its base snap "m"/);
    rmSync(own);

    const result = await runSnap(frameRequest(space));
    assert.deepEqual(getPixel(result.raster, 50, 60), [0x12, 0x34, 0x56, 255]);
    const [, baseEntry] = readLog(space.logPath);
    assert.deepEqual(readLog(space.logPath).at(-1).vars.fixes, baseEntry.vars.fixes);
});

test('a changed touch-ups file stops a frame, because the frame would no longer match its base', async () => {
    const space = await workspace({ fixes: [{ x: 50, y: 60, color: '#123456' }] });
    writeFileSync(join(space.rootDir, 'fixes', 'm.json'), JSON.stringify([{ x: 50, y: 60, color: '#654321' }]));
    await assertRefused(space, frameRequest(space), /touch-ups in fixes\/m\.json, and that file has changed since/);
});

test('the changed pixels, their box, and the master box and allowed box on the grid are worked out from the cell and offset', () => {
    const before = createRaster(6, 4);
    const after = createRaster(6, 4);
    setPixel(before, 1, 1, [9, 9, 9, 255]);
    setPixel(after, 1, 1, [9, 9, 9, 255]);
    setPixel(after, 3, 2, [1, 2, 3, 255]);
    setPixel(after, 4, 2, [1, 2, 3, 255]);
    setPixel(before, 0, 0, [7, 7, 7, 0]);
    assert.deepEqual(changedPixels(before, after), [2 * 6 + 3, 2 * 6 + 4], 'a hidden colour under a transparent pixel is no change');
    assert.deepEqual(boxOfPixels([15, 16], 6), { x: 3, y: 2, width: 2, height: 1 });
    assert.equal(boxOfPixels([], 6), null);
    assert.throws(() => changedPixels(before, createRaster(5, 4)), /same size/);

    const grid = { cell: 2.5, offset: { x: 1, y: 2 } };
    assert.deepEqual(masterBoxOf({ x: 4, y: 3, width: 2, height: 1 }, grid), { x: 11, y: 9, width: 5, height: 3 });
    // Columns 20..40 over the cell 2.5 from offset 1 touch cells 7 to 15, rows 30..40 from offset 2 touch cells 11 to 15; the margin is added on each side.
    assert.deepEqual(allowedArtBox({ x: 20, y: 30, width: 20, height: 10 }, grid), { x: 7 - FRAME_MARGIN, y: 11 - FRAME_MARGIN, width: 9 + 2 * FRAME_MARGIN, height: 5 + 2 * FRAME_MARGIN });
    assert.deepEqual(parseFrameRegion('1, 2, 3,4'), { x: 1, y: 2, width: 3, height: 4 });
    for (const bad of ['1,2,3', '1,2,3,0', '-1,2,3,4', '1,2,3.5,4', 'a,b,c,d']) {
        assert.throws(() => parseFrameRegion(bad), /must be x,y,w,h/, bad);
    }
});

test('checkFrame reports the box of the changed pixels in art and master pixels', () => {
    const base = createRaster(10, 10);
    const frame = createRaster(10, 10);
    setPixel(base, 4, 4, [5, 5, 5, 255]);
    setPixel(frame, 4, 4, [5, 5, 5, 255]);
    setPixel(frame, 5, 5, [6, 6, 6, 255]);
    const summary = checkFrame({ base, frame, grid: { cell: 3, offset: { x: 0.5, y: 1 } }, baseId: 'b', masterSize: { width: 40, height: 40 } });
    assert.deepEqual([summary.changed, summary.box, summary.masterBox, summary.region], [1, { x: 5, y: 5, width: 1, height: 1 }, { x: 15, y: 16, width: 4, height: 3 }, null]);
});

test('a grid with an offset is used as given: nothing is detected, so the pitch and fit are null, and the cell must come with it', () => {
    const master = figure();
    const grid = chooseGrid(master, { cell: 3.2, offset: { x: 1.25, y: 0.5 } });
    assert.deepEqual([grid.cell, grid.cellSource, grid.offsetX, grid.offsetY, grid.pitchAcross, grid.fitAcross], [3.2, 'grid-from', 1.25, 0.5, null, null]);
    assert.throws(() => chooseGrid(master, { offset: { x: 0, y: 0 } }), /pass the cell with it/);
    assert.throws(() => chooseGrid(master, { cell: 3, offset: { x: Number.NaN, y: 0 } }), /pass the cell with it/);
    const { raster, report } = snapRaster(master, { cell: 3.2, offset: { x: 1.25, y: 0.5 }, rimWidth: 2, bandWidth: 2 });
    assert.equal(report.fit, null);
    assert.deepEqual(report.offset, { x: 1.25, y: 0.5 });
    assert.equal(raster.width, Math.floor((master.width - 1.25) / 3.2));
});

test('snap.mjs --grid-from arguments: the base snap sets the grid, so the options that would set one are refused', () => {
    const ok = parseSnapArgs(['--in', 'raw/s5/patched/m--blink.png', '--grid-from', 'approved/pixel/m.png', '--id', 'm--blink', '--frame-region', '126,144,28,18', '--stage', 's5']);
    assert.deepEqual([ok.mode, ok.gridFrom, ok.id, ok.frameRegion, ok.stage], ['snap', 'approved/pixel/m.png', 'm--blink', { x: 126, y: 144, width: 28, height: 18 }, 's5']);
    assert.equal(parseSnapArgs(['--in', 'a.png', '--grid-from', 'abcdef123', '--preview']).gridFrom, 'abcdef123');
    for (const extra of [['--cell', '3'], ['--body-height', '300'], ['--detect'], ['--sample', 'median'], ['--colours', '24'], ['--rim-width', '2'], ['--no-ring-repair'], ['--fixes', 'f.json'], ['--character', 'tewi'], ['--compare']]) {
        assert.throws(() => parseSnapArgs(['--in', 'a.png', '--grid-from', 'approved/pixel/m.png', '--preview', ...extra]), /--grid-from takes the cell, offset, sampling, colours, rings and touch-ups of the base snap/, extra.join(' '));
    }
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--preview', '--frame-region', '1,2,3,4']), /needs --grid-from/);
    assert.throws(() => parseSnapArgs(['--in', 'a.png', '--grid-from', 'x', '--preview', '--frame-region', '1,2,3']), /must be x,y,w,h/);
    assert.throws(() => parseSnapArgs(['--batch', 'b.json', '--dry-run', '--grid-from', 'approved/pixel/m.png']), /takes its pictures and their sizes from the batch file/);
    assert.equal(parseSnapArgs(['--in', 'a.png', '--preview']).options.sample, 'median', 'the default sample is unchanged');
    assert.equal(parseSnapArgs(['--batch', 'b.json', '--dry-run']).sample, undefined);
    assert.equal(parseSnapArgs(['--batch', 'b.json', '--dry-run', '--sample', 'mode']).sample, 'mode');
});
