import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approveOutputs } from '../scripts/lib/approve.mjs';
import { readLog, sha256 } from '../scripts/lib/log.mjs';
import { snapRaster } from '../scripts/lib/pixel-snap.mjs';
import { opaqueBox, readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { checkSceneFrame } from '../scripts/lib/scene-frame.mjs';
import { runComposeScene } from '../scripts/lib/scene-run.mjs';
import { changedPixels } from '../scripts/lib/snap-frame.mjs';
import { figure } from '../test-support/figure.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const NOW = () => new Date('2026-11-02T12:00:00.000Z');
const BLUE = [30, 30, 220, 255];
const DARK = [20, 20, 40, 255];
// The night grade of the hero scene: tints toward blue and keeps the sticker rings as they are.
const NIGHT = { toward: '#7d8fd6', amount: 0.14, lightness: -0.03, keepSticker: true };
// The eyes of the snapped fixture figure, in art pixels: its face is at about 50,53.
const EYES = [[46, 51], [47, 51], [53, 51], [54, 51], [46, 52], [54, 52]];

/** A snapped figure and a second snapped figure with its eyes closed, both with the grid and the rings of a real snap. */
function stills() {
    const { raster } = snapRaster(figure(), { cell: 3, rimWidth: 2, bandWidth: 2 });
    const closed = { ...raster, data: Buffer.from(raster.data) };
    for (const [x, y] of EYES) {
        setPixel(closed, x, y, DARK);
    }
    return { open: raster, closed };
}

function box(colour) {
    const raster = createRaster(40, 30);
    for (let y = 2; y < 28; y++) {
        for (let x = 2; x < 38; x++) {
            setPixel(raster, x, y, colour);
        }
    }
    return raster;
}

/** A package with a two-layer grid layout (the figure `a`, and a box `b` that overlaps it), their stills, and the base scene composed from them. */
async function workspace({ grade } = {}) {
    const rootDir = tempDir('sb-sceneframe-');
    mkdirSync(join(rootDir, 'layouts'));
    mkdirSync(join(rootDir, 'raw', 's5', 'pixel'), { recursive: true });
    const layers = [
        { id: 'b', image: 'b.png', pixel: 'raw/s5/pixel/b.png', z: 0, at: 'bottom-centre', anchor: { x: 460, y: 700 }, height: 300 },
        { id: 'a', image: 'a.png', pixel: 'raw/s5/pixel/a.png', z: 1, at: 'bottom-centre', measure: 'figure', anchor: { x: 400, y: 780 }, height: 600, ...(grade ? { grade } : {}) },
    ];
    const layoutPath = join(rootDir, 'layouts', 'x.grid.json');
    writeFileSync(layoutPath, JSON.stringify({ canvas: { width: 800, height: 800 }, grid: { cell: 4 }, layers }));
    const { open, closed } = stills();
    await writeRaster(join(rootDir, 'raw', 's5', 'pixel', 'a.png'), open);
    await writeRaster(join(rootDir, 'raw', 's5', 'pixel', 'a--blink.png'), closed);
    await writeRaster(join(rootDir, 'raw', 's5', 'pixel', 'b.png'), box(BLUE));
    await runComposeScene({ rootDir, layoutPath, outPath: join(rootDir, 'raw/s5/pixel/x.png'), stage: 's5', grid: true, now: NOW });
    approveOutputs({ rootDir, targets: ['raw/s5/pixel/x.png'], ref: false });
    return { rootDir, layoutPath, logPath: join(rootDir, 'log', 'generations.jsonl'), open, closed };
}

const frameRun = (space, extra = {}) => runComposeScene({
    rootDir: space.rootDir,
    layoutPath: space.layoutPath,
    outPath: join(space.rootDir, 'raw/s5/pixel/x--blink.png'),
    stage: 's5',
    grid: true,
    overrides: { a: 'raw/s5/pixel/a--blink.png' },
    frameOf: 'approved/pixel/x.png',
    now: NOW,
    ...extra,
});

async function assertRefused(space, run, message) {
    const logBefore = readFileSync(space.logPath, 'utf8');
    await assert.rejects(run, message);
    assert.equal(readFileSync(space.logPath, 'utf8'), logBefore, 'nothing was logged');
    assert.equal(existsSync(join(space.rootDir, 'raw', 's5', 'pixel', 'x--blink.png')), false, 'nothing was written');
}

/** Runs the frame and shows that the scene is the base scene everywhere except the pixels of the closed eyes. */
async function assertEyesOnly(space) {
    const result = await frameRun(space);
    const base = await readRaster(join(space.rootDir, 'approved', 'pixel', 'x.png'));
    const frame = await readRaster(join(space.rootDir, result.file));
    assert.deepEqual([frame.width, frame.height], [base.width, base.height]);
    const changed = changedPixels(base, frame);
    assert.equal(changed.length, EYES.length, 'one scene pixel for each pixel of the closed eyes');
    assert.equal(result.frame.changed, EYES.length);
    const { left, top } = result.placements.find(({ id }) => id === 'a');
    const trimmedAt = opaqueBox(space.open, 1);
    const eyeIndexes = new Set(EYES.map(([x, y]) => (top + y - trimmedAt.y) * frame.width + left + x - trimmedAt.x));
    assert.deepEqual(new Set(changed), eyeIndexes, 'the changed scene pixels are the eyes, where the figure is placed');
    for (const index of changed) {
        assert.equal(getPixel(frame, index % frame.width, Math.floor(index / frame.width))[3], 255);
    }
    return { result, base, frame };
}

test('a scene frame is the base scene except for the eyes of the figure whose still was swapped', async () => {
    const space = await workspace();
    const { result } = await assertEyesOnly(space);
    assert.equal(result.file, 'raw/s5/pixel/x--blink.png');
    assert.deepEqual(result.frame.layers, ['a']);
    assert.deepEqual(result.frame.base.file, 'approved/pixel/x.png');
});

test('with the night grade the frame is still the base scene except for the eyes, and the rings keep their widths', async () => {
    const space = await workspace({ grade: NIGHT });
    const { result, base, frame } = await assertEyesOnly(space);
    assert.deepEqual(result.placements.find(({ id }) => id === 'a').rings, { rimWidth: 2, bandWidth: 2 });
    assert.equal(result.grades.a.keepSticker, true);
    assert.ok(base.data.some((value, at) => value !== frame.data[at]));
});

test('the log entry of a scene frame names the base scene in vars and in refs, with the frame still among the inputs, and it is approved under its own name', async () => {
    const space = await workspace();
    await frameRun(space);
    const entry = readLog(space.logPath).at(-1);
    const baseSha = sha256(readFileSync(join(space.rootDir, 'approved', 'pixel', 'x.png')));
    assert.deepEqual(entry.vars.frameOf, { file: 'approved/pixel/x.png', sha256: baseSha });
    assert.deepEqual(entry.vars.frame.layers, ['a']);
    assert.equal(entry.vars.frame.changed, EYES.length);
    assert.ok(entry.vars.inputs.includes('a=raw/s5/pixel/a--blink.png'));
    assert.ok(entry.refs.includes(baseSha) && entry.refs.includes(sha256(readFileSync(join(space.rootDir, 'raw/s5/pixel/a--blink.png')))));
    assert.ok(entry.vars.grid, 'it is a grid scene, so it is approved as pixel art');
    const [done] = approveOutputs({ rootDir: space.rootDir, targets: ['raw/s5/pixel/x--blink.png'], ref: false });
    assert.deepEqual(done.copiedTo, ['approved/pixel/x--blink.png']);
});

test('a frame still whose figure box moved is refused, because the layer would be placed differently', async () => {
    const space = await workspace();
    const moved = { ...space.closed, data: Buffer.from(space.closed.data) };
    setPixel(moved, 1, 1, [255, 0, 0, 255]);
    await writeRaster(join(space.rootDir, 'raw/s5/pixel/a--blink.png'), moved);
    await assertRefused(space, frameRun(space), /The figure of the frame still of "a" is at .* and the base still's at .*placed by that box/);
});

test('a frame still of another size is refused', async () => {
    const space = await workspace();
    await writeRaster(join(space.rootDir, 'raw/s5/pixel/a--blink.png'), createRaster(space.open.width + 1, space.open.height, [1, 2, 3, 255]));
    await assertRefused(space, frameRun(space), /frame still of "a" is \d+x\d+ art pixels and its base still \d+x\d+/);
});

test('a scene that differs from the base elsewhere is refused with the box that differs: here another layer changed after the base was composed', async () => {
    const space = await workspace();
    await writeRaster(join(space.rootDir, 'raw/s5/pixel/b.png'), box([200, 200, 30, 255]));
    await assertRefused(space, frameRun(space), /\d+ of the \d+ scene pixels that changed from approved\/pixel\/x\.png are not pixels the swapped stills changed: they are in the box \d+x\d+ at \d+,\d+ art px \(\d+x\d+ at \d+,\d+ canvas px\)/);
});

test('a swap that changes no pixel of the scene, a frame that is not a swap, and a base that is not there are refused', async () => {
    const space = await workspace();
    await assertRefused(space, frameRun(space, { overrides: { a: 'raw/s5/pixel/a.png' } }), /identical to approved\/pixel\/x\.png: no pixel changed, so the swap did nothing/);
    await assertRefused(space, frameRun(space, { overrides: {} }), /pass --grid and --set <layer>=<frame still>/);
    await assertRefused(space, frameRun(space, { grid: false }), /pass --grid and --set/);
    await assertRefused(space, frameRun(space, { frameOf: 'approved/pixel/none.png' }), /the base scene does not exist/);
    const small = join(space.rootDir, 'raw', 's5', 'pixel', 'small.png');
    await writeRaster(small, createRaster(10, 10, [1, 1, 1, 255]));
    await assertRefused(space, frameRun(space, { frameOf: 'raw/s5/pixel/small.png' }), /is 10x10 art pixels and the scene composed is 200x200/);
});

test('a swapped layer needs a base still in the layout to be checked against', async () => {
    const space = await workspace();
    const layout = JSON.parse(readFileSync(space.layoutPath, 'utf8'));
    delete layout.layers.find(({ id }) => id === 'a').pixel;
    writeFileSync(space.layoutPath, JSON.stringify(layout));
    await assertRefused(space, frameRun(space), /The layer "a" has no "pixel" picture in the layout, so there is no base still to check its frame against/);
});

test('a preview frame is written under out/ and logs nothing', async () => {
    const space = await workspace();
    const before = readLog(space.logPath).length;
    const result = await frameRun(space, { preview: true, outPath: join(space.rootDir, 'out/s5/x--blink.png'), stage: undefined });
    assert.equal(result.frame.changed, EYES.length);
    assert.ok(existsSync(join(space.rootDir, 'out/s5/x--blink.png')));
    assert.equal(readLog(space.logPath).length, before);
});

test('checkSceneFrame lets through only the pixels the stills changed, wherever the layer is placed', () => {
    const before = createRaster(4, 4);
    const after = createRaster(4, 4);
    for (const still of [before, after]) {
        setPixel(still, 0, 0, [9, 9, 9, 255]);
        setPixel(still, 3, 3, [9, 9, 9, 255]);
    }
    setPixel(after, 1, 1, [1, 2, 3, 255]);
    const base = createRaster(10, 10);
    const frame = createRaster(10, 10);
    setPixel(frame, 6, 7, [1, 2, 3, 255]);
    const swap = { id: 'a', before, after, placements: [{ left: 5, top: 6 }] };
    const summary = checkSceneFrame({ base, frame, swaps: [swap], cell: 4, baseName: 'x.png' });
    assert.deepEqual([summary.changed, summary.box, summary.canvasBox], [1, { x: 6, y: 7, width: 1, height: 1 }, { x: 24, y: 28, width: 4, height: 4 }]);
    assert.throws(() => checkSceneFrame({ base, frame, swaps: [{ ...swap, placements: [{ left: 0, top: 0 }] }], cell: 4, baseName: 'x.png' }), /not pixels the swapped stills changed/);
});
