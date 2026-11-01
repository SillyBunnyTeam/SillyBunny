import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { approveOutputs } from '../scripts/lib/approve.mjs';
import { compositeSheetFor } from '../scripts/lib/composite-sheet.mjs';
import { appendLogEntry, makeLogEntry, readLog } from '../scripts/lib/log.mjs';
import { snapRaster } from '../scripts/lib/pixel-snap.mjs';
import { readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { composeGridScene } from '../scripts/lib/scene-compose.mjs';
import { parseLayout } from '../scripts/lib/scene-layout.mjs';
import { runComposeScene } from '../scripts/lib/scene-run.mjs';
import { buildCompositeSheet } from '../scripts/lib/snap-sheet.mjs';
import { figure } from '../test-support/figure.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const NOW = () => new Date('2026-11-02T12:00:00.000Z');
const RED = [220, 30, 30, 255];
const BLUE = [30, 30, 220, 255];

/** A native-size still: a solid box of art pixels with a one pixel mark in its corner, so a move or a resize shows. */
function still(colour, { width = 12, height = 10, margin = 2 } = {}) {
    const raster = createRaster(width + 2 * margin, height + 2 * margin);
    for (let y = margin; y < margin + height; y++) {
        for (let x = margin; x < margin + width; x++) {
            setPixel(raster, x, y, colour);
        }
    }
    setPixel(raster, margin, margin, [255, 255, 0, 255]);
    return raster;
}

const layer = (extra) => ({ id: 'a', image: 'a.png', z: 1, at: 'top-left', anchor: { x: 40, y: 20 }, height: 40, ...extra });
const grid = (layers, { cell = 4, canvas = { width: 400, height: 200 } } = {}) => parseLayout({ canvas, grid: { cell }, layers });

test('a layout grid is a whole cell size that divides the canvas, and a layer may name its snapped still', () => {
    const parsed = grid([layer({ pixel: 'approved/pixel/a.png' })]);
    assert.deepEqual(parsed.grid, { cell: 4, width: 100, height: 50 });
    assert.equal(parsed.layers[0].pixel, 'approved/pixel/a.png');
    assert.equal(parseLayout({ canvas: { width: 400, height: 200 }, layers: [layer()] }).grid, undefined, 'a layout without a grid parses as it did');
    assert.throws(() => grid([layer()], { cell: 3 }), /400 x 200 canvas is not a whole number of 3 pixel cells/);
    assert.throws(() => grid([layer()], { cell: 2.5 }), /grid must be/);
    assert.throws(() => parseLayout({ canvas: { width: 400, height: 200 }, grid: { cell: 4, extra: 1 }, layers: [layer()] }), /unknown key "extra"/);
    assert.throws(() => grid([layer({ pixel: '' })]), /pixel must be the path/);
});

test('a layout grid may be given as a native size, which must keep the canvas proportions and may make a fractional cell', () => {
    const native = (size) => parseLayout({ canvas: { width: 400, height: 200 }, grid: size, layers: [layer()] });
    assert.deepEqual(native({ width: 150, height: 75 }).grid, { cell: 400 / 150, width: 150, height: 75 });
    assert.throws(() => native({ width: 150, height: 80 }), /does not keep the proportions of the 400 x 200 canvas/);
    assert.throws(() => native({ width: 150 }), /grid must be/);
    assert.throws(() => native({ cell: 4, width: 100, height: 50 }), /grid must be/);
    assert.throws(() => native({ width: 150.5, height: 75 }), /grid must be/);
    const { raster, placements, grid: composed } = composeGridScene(native({ width: 150, height: 75 }), new Map([['a', still(RED)]]));
    assert.deepEqual([raster.width, raster.height], [150, 75]);
    assert.deepEqual(composed, { cell: 400 / 150, width: 150, height: 75 });
    assert.deepEqual([placements[0].left, placements[0].top], [15, 8], 'the anchor 40, 20 over the cell 2.667 is 15, 7.5, which rounds to 15, 8');
});

test('the scene is the canvas divided by the cell, with each still copied in unscaled at the anchor divided by the cell', () => {
    const picture = still(RED);
    const { raster, placements, grid: composed } = composeGridScene(grid([layer()]), new Map([['a', picture]]));
    assert.deepEqual([raster.width, raster.height], [100, 50]);
    assert.deepEqual(composed, { cell: 4, width: 100, height: 50 });
    assert.deepEqual([placements[0].left, placements[0].top, placements[0].width, placements[0].height, placements[0].scale], [10, 5, 12, 10, 1]);
    for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 12; x++) {
            assert.deepEqual(getPixel(raster, 10 + x, 5 + y), getPixel(picture, 2 + x, 2 + y), `pixel ${x},${y} is the still's own`);
        }
    }
    assert.equal(getPixel(raster, 9, 5)[3], 0);
    assert.equal(getPixel(raster, 22, 5)[3], 0);
});

test('bottom-centre and centre anchors land on whole art pixels, and an anchor between two pixels rounds to one', () => {
    const feet = composeGridScene(grid([layer({ at: 'bottom-centre', anchor: { x: 200, y: 180 } })]), new Map([['a', still(RED)]]));
    assert.deepEqual([feet.placements[0].left, feet.placements[0].top], [44, 35]);
    assert.equal(getPixel(feet.raster, 50, 44)[3], 255, 'the last row of the still is the row above the anchor');
    assert.equal(getPixel(feet.raster, 50, 45)[3], 0);
    const centre = composeGridScene(grid([layer({ at: 'centre', anchor: { x: 202, y: 102 } })]), new Map([['a', still(RED)]]));
    assert.deepEqual([centre.placements[0].left, centre.placements[0].top], [45, 21], 'the anchor 50.5, 25.5 becomes 51, 26');
    assert.ok(centre.raster.data.every((value, at) => at % 4 !== 3 || value === 0 || value === 255), 'alpha stays binary');
});

test('layers are drawn in z order, and a repeated layer is placed once per point', () => {
    const layers = [layer({ id: 'front', z: 5, anchor: { x: 40, y: 20 } }), layer({ id: 'back', z: 1, anchor: { x: 60, y: 20 } }), layer({ id: 'stars', z: 0, repeat: [{ x: 0, y: 0, height: 8 }, { x: 200, y: 100, height: 8 }] })];
    const { raster, placements } = composeGridScene(grid(layers), new Map([['front', still(RED)], ['back', still(BLUE)], ['stars', still([255, 255, 255, 255], { width: 2, height: 2, margin: 0 })]]));
    assert.deepEqual(getPixel(raster, 17, 7), RED, 'the front layer covers the overlap');
    assert.deepEqual(getPixel(raster, 22, 7), BLUE, 'the back one shows where nothing covers it');
    assert.deepEqual(placements.filter(({ id }) => id === 'stars').map(({ left, top }) => [left, top]), [[0, 0], [50, 25]]);
});

test('a grade is applied to the still before it is placed, and the placed pixels are the graded still\'s own', () => {
    const graded = composeGridScene(grid([layer({ grade: { toward: '#0000ff', amount: 0.5, keepSticker: false } })]), new Map([['a', still(RED)]]));
    const plain = composeGridScene(grid([layer()]), new Map([['a', still(RED)]]));
    assert.notDeepEqual(getPixel(graded.raster, 12, 7), getPixel(plain.raster, 12, 7));
    assert.ok(getPixel(graded.raster, 12, 7)[2] > getPixel(plain.raster, 12, 7)[2], 'it moved toward blue');
    assert.equal(getPixel(graded.raster, 12, 7)[3], 255);
});

test('a picture with translucent pixels is refused, because grid mode places snapped stills and never blends or resamples', () => {
    const soft = still(RED);
    setPixel(soft, 3, 3, [220, 30, 30, 120]);
    assert.throws(() => composeGridScene(grid([layer()]), new Map([['a', soft]])), /layer "a" has translucent pixels, so it is not a snapped still/);
    assert.throws(() => composeGridScene(grid([layer()]), new Map([['a', createRaster(5, 5)]])), /is empty/);
    assert.throws(() => composeGridScene(parseLayout({ canvas: { width: 400, height: 200 }, layers: [layer()] }), new Map([['a', still(RED)]])), /has no "grid"/);
});

test('a ratio between two figures comes from the heights they were snapped at, and the scene reports it against the one the layout wanted', () => {
    const tall = snapRaster(figure(), { cell: 3 }).raster;
    const short = snapRaster(figure(), { cell: 3.6 }).raster;
    const layers = [
        layer({ id: 'reisen', image: 'r.png', at: 'bottom-centre', measure: 'figure', anchor: { x: 200, y: 440 }, height: 1000 }),
        layer({ id: 'tewi', image: 't.png', at: 'bottom-centre', measure: 'figure', anchor: { x: 600, y: 440 }, height: { ratio: 0.8333, of: 'reisen' } }),
    ];
    const { placements } = composeGridScene(grid(layers, { cell: 4, canvas: { width: 800, height: 448 } }), new Map([['reisen', tall], ['tewi', short]]));
    const [reisen, tewi] = placements;
    assert.equal(reisen.method, 'head', 'the head top is found on a snapped still');
    assert.equal(reisen.targetHeight, 250);
    assert.equal(tewi.targetHeight, 208.33);
    assert.equal(tewi.ratio.of, 'reisen');
    assert.equal(tewi.ratio.wanted, 0.8333);
    assert.ok(Math.abs(tewi.ratio.actual - tewi.figureHeight / reisen.figureHeight) < 1e-3);
    assert.ok(Math.abs(tewi.ratio.actual - 3 / 3.6) < 0.02, `ratio ${tewi.ratio.actual}`);
    assert.equal(tewi.scale, 1);
    assert.equal(reisen.ratio, undefined);
});

async function workspace() {
    const rootDir = mkdtempSync(join(tmpdir(), 'sb-grid-'));
    for (const dir of ['raw/s5/pixel', 'raw/s3', 'layouts', 'out/s5', 'approved']) {
        mkdirSync(join(rootDir, dir), { recursive: true });
    }
    await writeRaster(join(rootDir, 'raw/s5/pixel/a.png'), still(RED));
    await writeRaster(join(rootDir, 'raw/s5/pixel/b.png'), still(BLUE));
    await writeRaster(join(rootDir, 'raw/s3/a.png'), createRaster(30, 30, [9, 9, 9, 255]));
    const layout = {
        canvas: { width: 400, height: 200 },
        grid: { cell: 4 },
        layers: [
            { id: 'a', image: 'raw/s3/a.png', pixel: 'raw/s5/pixel/a.png', z: 1, at: 'top-left', anchor: { x: 40, y: 20 }, height: 40 },
            { id: 'b', image: 'raw/s3/a.png', z: 2, at: 'top-left', anchor: { x: 200, y: 20 }, height: 40 },
        ],
    };
    const layoutPath = join(rootDir, 'layouts', 'home.json');
    writeFileSync(layoutPath, JSON.stringify(layout));
    return { rootDir, layoutPath, logPath: join(rootDir, 'log', 'generations.jsonl') };
}

const runGrid = (rootDir, layoutPath, extra = {}) => runComposeScene({ rootDir, layoutPath, outPath: join(rootDir, 'raw/s5/pixel/home.png'), stage: 's5', grid: true, overrides: { b: 'raw/s5/pixel/b.png' }, now: NOW, ...extra });

test('a grid run writes the native picture, logs the grid and the art pixel placements, and takes the stills from `pixel` and --set', async () => {
    const { rootDir, layoutPath, logPath } = await workspace();
    const result = await runGrid(rootDir, layoutPath);
    assert.deepEqual(result.size, { width: 100, height: 50 });
    const picture = await readRaster(join(rootDir, 'raw/s5/pixel/home.png'));
    assert.deepEqual([picture.width, picture.height], [100, 50]);
    assert.deepEqual(getPixel(picture, 12, 7), RED);
    assert.deepEqual(getPixel(picture, 52, 7), BLUE);
    const [entry] = readLog(logPath);
    assert.deepEqual(entry.vars.grid, { cell: 4, width: 100, height: 50 });
    assert.deepEqual(entry.vars.placements.map(({ id, left, top, scale }) => [id, left, top, scale]), [['a', 10, 5, 1], ['b', 50, 5, 1]]);
    assert.deepEqual(entry.vars.inputs, ['a=raw/s5/pixel/a.png', 'b=raw/s5/pixel/b.png']);
    assert.equal(entry.size, '100x50');
});

test('without --grid the same layout is composed smooth at the canvas size from the layers\' own pictures, and its log line has no grid', async () => {
    const { rootDir, layoutPath, logPath } = await workspace();
    const result = await runComposeScene({ rootDir, layoutPath, outPath: join(rootDir, 'raw/s5/pixel/smooth.png'), stage: 's5', now: NOW });
    assert.deepEqual(result.size, { width: 400, height: 200 });
    assert.equal(readLog(logPath)[0].vars.grid, undefined);
});

test('--grid refuses a layout with no grid and a layer with no snapped still, and logs nothing', async () => {
    const { rootDir, layoutPath, logPath } = await workspace();
    await assert.rejects(runGrid(rootDir, layoutPath, { overrides: {} }), /needs a snapped still for "b"/);
    const bare = join(rootDir, 'layouts', 'bare.json');
    writeFileSync(bare, JSON.stringify({ canvas: { width: 400, height: 200 }, layers: [{ id: 'a', image: 'raw/s3/a.png', z: 1, anchor: { x: 10, y: 10 }, height: 20 }] }));
    await assert.rejects(runGrid(rootDir, bare, { overrides: {} }), /layouts\/bare\.json has no "grid"/);
    await writeRaster(join(rootDir, 'raw/s3/soft.png'), createRaster(30, 30, [9, 9, 9, 120]));
    await assert.rejects(runGrid(rootDir, layoutPath, { overrides: { b: 'raw/s3/soft.png' } }), /layer "b" has translucent pixels/);
    assert.equal(existsSync(logPath), false);
});

test('a grid preview is written under out/ only, and logs nothing', async () => {
    const { rootDir, layoutPath, logPath } = await workspace();
    await assert.rejects(runGrid(rootDir, layoutPath, { preview: true }), /under out\/ only/);
    await runGrid(rootDir, layoutPath, { preview: true, outPath: join(rootDir, 'out/s5/home.png'), stage: undefined });
    assert.ok(existsSync(join(rootDir, 'out/s5/home.png')));
    assert.equal(existsSync(logPath), false);
});

test('an approved grid scene is kept under approved/pixel/ beside a smooth master of the same name, which stays as it is', async () => {
    const { rootDir, layoutPath } = await workspace();
    writeFileSync(join(rootDir, 'approved', 'home.png'), 'the smooth master');
    await runGrid(rootDir, layoutPath);
    const [done] = approveOutputs({ rootDir, targets: ['raw/s5/pixel/home.png'], ref: false });
    assert.deepEqual(done.copiedTo, ['approved/pixel/home.png']);
    assert.equal(readFileSync(join(rootDir, 'approved', 'home.png'), 'utf8'), 'the smooth master');
    assert.equal(readLog(join(rootDir, 'log', 'generations.jsonl'))[0].outputs[0].approvedAs, 'pixel/home.png');
});

/** A package root with a grid layout of one layer, its smooth twin, a still, a review file and, when asked, the log line of the still's snap. */
async function compositeRoot({ logged = true } = {}) {
    const rootDir = mkdtempSync(join(tmpdir(), 'sb-composite-'));
    for (const folder of ['layouts', 'raw', 'review']) {
        mkdirSync(join(rootDir, folder));
    }
    const smoothLayer = { id: 'a', image: 'raw/a.png', z: 1, at: 'top-left', anchor: { x: 40, y: 20 }, height: 40 };
    writeFileSync(join(rootDir, 'layouts', 'x.json'), JSON.stringify({ canvas: { width: 400, height: 200 }, layers: [smoothLayer] }));
    writeFileSync(join(rootDir, 'layouts', 'x.grid.json'), JSON.stringify({ canvas: { width: 400, height: 200 }, grid: { cell: 4 }, layers: [{ ...smoothLayer, pixel: 'raw/a.snap.png' }] }));
    writeFileSync(join(rootDir, 'review', 'x-a.json'), JSON.stringify({ faces: [{ name: 'face', left: { x: 0, y: 0, width: 20, height: 20 }, right: { x: 20, y: 0, width: 20, height: 20 } }], hands: [{ name: 'hand', box: { x: 10, y: 10, width: 40, height: 40 } }] }));
    await writeRaster(join(rootDir, 'raw', 'a.png'), still(RED, { width: 40, height: 40, margin: 4 }));
    await writeRaster(join(rootDir, 'raw', 'a.snap.png'), still(RED));
    await writeRaster(join(rootDir, 'raw', 'smooth.png'), createRaster(400, 200, [90, 90, 90, 255]));
    await writeRaster(join(rootDir, 'raw', 'grid.png'), createRaster(100, 50, [90, 90, 90, 255]));
    if (logged) {
        appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
            time: '2026-11-02T12:00:00.000Z',
            stage: 's5',
            provider: 'local',
            model: 'pixel-snap',
            template: 'pixel-snap',
            vars: { cell: 3, offset: { x: 1, y: 2 } },
            refHashes: [],
            size: '16x14',
            outputs: [{ file: 'raw/a.snap.png', sha256: 'abc' }],
            estimatedUsd: 0,
        }));
    }
    return rootDir;
}

const sheetRequest = (rootDir) => ({ rootDir, gridLayoutPath: join(rootDir, 'layouts', 'x.grid.json'), smoothPath: join(rootDir, 'raw', 'smooth.png'), gridPath: join(rootDir, 'raw', 'grid.png'), name: 'x' });

test('the composite sheet shows the smooth and the grid scene at one size, the grid one at 2x, and a pair of close-ups for every review box', async () => {
    const rootDir = await compositeRoot();
    const sheet = await sharp(await compositeSheetFor(sheetRequest(rootDir))).metadata();
    assert.ok(sheet.width >= 2 * 400, 'the two scenes sit side by side at the canvas size');
    assert.ok(sheet.height > 200 + 100, 'the 2x scene and the close-ups are below them');
    const plain = await sharp(await buildCompositeSheet({ smooth: createRaster(400, 200), grid: createRaster(100, 50), items: [], caption: 'x' })).metadata();
    const withItems = await sharp(await buildCompositeSheet({ smooth: createRaster(400, 200), grid: createRaster(100, 50), items: [{ label: 'a', gridArea: { x: 5, y: 5, width: 10, height: 10 }, smoothArea: { x: 20, y: 20, width: 40, height: 40 } }], caption: 'x' })).metadata();
    assert.ok(withItems.height > plain.height);
});

test('the composite sheet needs the log line of each still\'s snap to place the review boxes, and a layout that is not a grid layout is refused', async () => {
    await assert.rejects(compositeSheetFor(sheetRequest(await compositeRoot({ logged: false }))), /no pixel-snap of raw\/a.snap.png/);
    const rootDir = await compositeRoot();
    await assert.rejects(compositeSheetFor({ ...sheetRequest(rootDir), gridLayoutPath: join(rootDir, 'layouts', 'x.json') }), /not a grid layout/);
});

test('a grade with keepSticker leaves every ring pixel as it was, so the rings of a placed figure keep their widths', () => {
    const { raster } = snapRaster(figure(), { cell: 3, rimWidth: 2, bandWidth: 2 });
    const layout = (grade) => parseLayout({
        canvas: { width: 800, height: 800 },
        grid: { cell: 4 },
        layers: [{ id: 'a', image: 'a.png', pixel: 'a.png', z: 1, at: 'bottom-centre', measure: 'figure', anchor: { x: 400, y: 780 }, height: 600, ...(grade ? { grade } : {}) }],
    });
    const plain = composeGridScene(layout(), new Map([['a', raster]]));
    assert.deepEqual(plain.placements[0].rings, { rimWidth: 2, bandWidth: 2 });
    const grade = { toward: '#7d8fd6', amount: 0.14, lightness: -0.03, keepSticker: true };
    const graded = composeGridScene(layout(grade), new Map([['a', raster]]));
    assert.deepEqual(graded.placements[0].rings, { rimWidth: 2, bandWidth: 2 }, 'a ring pixel at a diagonal was tinted');
    assert.ok(graded.raster.data.some((value, at) => value !== plain.raster.data[at]), 'the rest of the figure was graded');
});
