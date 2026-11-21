import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { approveOutputs } from '../scripts/lib/approve.mjs';
import { loadBackdropConfig, loggedPlates, snapPlate } from '../scripts/lib/github-backdrop-run.mjs';
import { assertStage, commitSnapLog, planSnapLog } from '../scripts/lib/github-snap-log.mjs';
import { loadScenes, loggedScenes, snapScene } from '../scripts/lib/github-snap-run.mjs';
import { appendLogEntry, makeLogEntry, readLog, sha256 } from '../scripts/lib/log.mjs';
import { upscaleNearest, writeRaster } from '../scripts/lib/raster.mjs';
import { createRaster } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const REAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLOW = { timeout: 120_000 };
const CELL = 4;
const RIM = [185, 155, 242];
const BAND = [255, 255, 255];
const BODIES = [[90, 60, 120], [110, 80, 140], [70, 50, 100], [130, 100, 160]];
const NOW = () => new Date('2026-11-05T01:02:03.000Z');
const STAGE = 's8';
const SCENE_FILE = `raw/${STAGE}/pixel/test-scene.png`;

/** A sticker in art pixels: a rounded body with a band of 2 and a rim of 2 round it, filled with a few flat colours so a grid can be read. */
function artSticker({ width = 60, height = 70, box = { x: 15, y: 12, width: 30, height: 40 } } = {}) {
    const art = createRaster(width, height);
    const inBox = (x, y, grow) => x >= box.x - grow && y >= box.y - grow && x < box.x + box.width + grow && y < box.y + box.height + grow;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const colour = inBox(x, y, 0) ? BODIES[(Math.floor(x / 3) + Math.floor(y / 3)) % BODIES.length] : inBox(x, y, 2) ? BAND : inBox(x, y, 4) ? RIM : undefined;
            if (colour) {
                art.data.set([...colour, 255], (y * width + x) * 4);
            }
        }
    }
    return art;
}

const logPathOf = (rootDir) => join(rootDir, 'log', 'generations.jsonl');
const logBytes = (rootDir) => readFileSync(logPathOf(rootDir));

/** What a generation leaves in the log: an output with its sha256. The logged mode links a snap to such an output. */
const generation = (file, bytes) => makeLogEntry({ time: '2026-11-03T20:00:00.000Z', stage: 's8', provider: 'openai', model: 'test-model', template: 'pixel-scene', vars: {}, refHashes: [], size: '1x1', outputs: [{ file, sha256: sha256(bytes) }], estimatedUsd: 0.1 });

/**
 * A package folder with one scene: a master and a patch picture, both logged as generations (except those not in `logged`), and the
 * snap config. `scene` changes or, with undefined, removes the keys of the scene.
 */
async function workspace({ scene = {}, logged = ['raw/master.png', 'raw/patch.png'] } = {}) {
    const rootDir = tempDir('sb-github-snap-log-');
    copyFileSync(join(REAL_ROOT, 'snap-config.json'), join(rootDir, 'snap-config.json'));
    mkdirSync(join(rootDir, 'raw'), { recursive: true });
    await writeRaster(join(rootDir, 'raw', 'master.png'), upscaleNearest(artSticker(), CELL));
    await writeRaster(join(rootDir, 'raw', 'patch.png'), createRaster(8, 8, [10, 20, 30, 255]));
    writeFileSync(join(rootDir, 'github-scenes.json'), JSON.stringify({ scenes: { 'test-scene': { master: 'raw/master.png', patch: 'raw/patch.png', cell: CELL, reisen: 'left', pose: 'mixed', ...scene } } }));
    for (const file of logged) {
        appendLogEntry(logPathOf(rootDir), generation(file, readFileSync(join(rootDir, file))));
    }
    return rootDir;
}

async function snapTheScene(rootDir) {
    const scenes = loadScenes(rootDir);
    const results = [await snapScene({ rootDir, name: 'test-scene', scene: scenes['test-scene'] })];
    return { results, snaps: loggedScenes(scenes, results) };
}

const logSnaps = (rootDir, snaps, stage = STAGE) => commitSnapLog(planSnapLog({ rootDir, stage, snaps }), { rootDir, stage, now: NOW });

test('a logged run writes a scene to raw/<stage>/pixel and logs one line: local pixel-snap, refs the master then the patch, the output with its sha256', SLOW, async () => {
    const rootDir = await workspace();
    const { results, snaps } = await snapTheScene(rootDir);
    const before = logBytes(rootDir);
    const logged = logSnaps(rootDir, snaps);
    assert.deepEqual(logged, [{ id: 'test-scene', file: SCENE_FILE, sha256: sha256(results[0].png) }]);
    assert.deepEqual(readFileSync(join(rootDir, SCENE_FILE)), readFileSync(join(rootDir, results[0].file)), 'the logged file is the picture that the preview shows');

    const after = logBytes(rootDir);
    assert.deepEqual(after.subarray(0, before.length), before, 'the lines before it are as they were');
    const lines = readLog(logPathOf(rootDir));
    assert.equal(lines.length, 3, 'the two generations and one line for the snap');
    const entry = lines[2];
    const { size } = results[0];
    assert.deepEqual({ ...entry, vars: undefined }, {
        time: '2026-11-05T01:02:03.000Z',
        stage: STAGE,
        provider: 'local',
        model: 'pixel-snap',
        template: 'pixel-snap',
        vars: undefined,
        refs: [sha256(readFileSync(join(rootDir, 'raw/master.png'))), sha256(readFileSync(join(rootDir, 'raw/patch.png')))],
        size: `${size.width}x${size.height}`,
        n: 1,
        outputs: [{ file: SCENE_FILE, sha256: sha256(results[0].png) }],
        estimatedUsd: 0,
        approved: false,
    });
    assert.equal(entry.vars.id, 'test-scene', 'approve.mjs names the approved copy by this');
    assert.equal(entry.vars.master, 'raw/master.png');
    assert.equal(entry.vars.cell, CELL);
    assert.equal(entry.vars.github.tool, 'github-snap.mjs');
    assert.deepEqual(entry.vars.github.sizing, { cell: CELL });
    assert.equal(entry.vars.github.patch, 'raw/patch.png');

    const approved = join(rootDir, 'approved', 'pixel', 'test-scene.png');
    // An absolute target: approve.mjs looks for a relative one in the working directory first, which is the real package when the tests run.
    const wouldCopy = approveOutputs({ rootDir, targets: [join(rootDir, SCENE_FILE)], ref: false, dryRun: true });
    assert.deepEqual(wouldCopy.map(({ copiedTo }) => copiedTo), [['approved/pixel/test-scene.png']]);
    assert.equal(existsSync(approved), false, 'a dry run copies nothing');
    approveOutputs({ rootDir, targets: [join(rootDir, SCENE_FILE)], ref: false });
    assert.deepEqual(readFileSync(approved), readFileSync(join(rootDir, SCENE_FILE)));
    const approvedEntry = readLog(logPathOf(rootDir))[2];
    assert.equal(approvedEntry.approved, true);
    assert.deepEqual([approvedEntry.outputs[0].approved, approvedEntry.outputs[0].approvedAs], [true, 'pixel/test-scene.png']);
});

test('a scene with no patch has the master alone in refs', SLOW, async () => {
    const rootDir = await workspace({ scene: { patch: undefined }, logged: ['raw/master.png'] });
    logSnaps(rootDir, (await snapTheScene(rootDir)).snaps);
    assert.deepEqual(readLog(logPathOf(rootDir)).at(-1).refs, [sha256(readFileSync(join(rootDir, 'raw/master.png')))]);
    assert.equal(readLog(logPathOf(rootDir)).at(-1).vars.github.patch, null);
});

test('a preview run logs nothing and writes nothing under raw/ beyond its master', SLOW, async () => {
    const rootDir = await workspace();
    const before = logBytes(rootDir);
    const { results } = await snapTheScene(rootDir);
    assert.equal(results[0].file, 'out/github/snapped/test-scene.png');
    assert.deepEqual(logBytes(rootDir), before);
    assert.equal(existsSync(join(rootDir, 'raw', STAGE)), false);
    assert.equal(existsSync(join(rootDir, 'approved')), false);
});

test('a logged run is refused, writing and logging nothing, when approved/pixel holds another picture under the name; the same bytes are accepted', SLOW, async () => {
    const rootDir = await workspace();
    const { results, snaps } = await snapTheScene(rootDir);
    const before = logBytes(rootDir);
    const approved = join(rootDir, 'approved', 'pixel', 'test-scene.png');
    mkdirSync(dirname(approved), { recursive: true });
    writeFileSync(approved, Buffer.from('another picture'));
    assert.throws(() => planSnapLog({ rootDir, stage: STAGE, snaps }), /^Error: Nothing was written or logged:\n- approved\/pixel\/test-scene\.png exists with other content than this run makes \(sha256 [0-9a-f]{16}, not [0-9a-f]{16}\)\. To replace approved pixel art, use approve\.mjs --supersede/);
    assert.equal(existsSync(join(rootDir, 'raw', STAGE)), false, 'no picture was written');
    assert.deepEqual(logBytes(rootDir), before, 'and no line was logged');

    writeFileSync(approved, results[0].png);
    assert.deepEqual(logSnaps(rootDir, snaps).map(({ id }) => id), ['test-scene']);
    approveOutputs({ rootDir, targets: [join(rootDir, SCENE_FILE)], ref: false });
    assert.deepEqual(readFileSync(approved), results[0].png, 'approving a reproduced picture leaves the approved copy as it was');
});

test('a logged run is refused unless the master and the patch are outputs that the log recorded, and every problem is said at once', SLOW, async () => {
    const unlogged = await workspace({ logged: [] });
    const { snaps } = await snapTheScene(unlogged);
    assert.throws(() => planSnapLog({ rootDir: unlogged, stage: STAGE, snaps }), (error) => /raw\/master\.png \(sha256 [0-9a-f]{16}\) is not an output the log recorded/.test(error.message) && /raw\/patch\.png \(sha256 [0-9a-f]{16}\) is not an output the log recorded/.test(error.message));

    const patchOnly = await workspace({ logged: ['raw/master.png'] });
    const patchOnlySnaps = (await snapTheScene(patchOnly)).snaps;
    assert.throws(() => planSnapLog({ rootDir: patchOnly, stage: STAGE, snaps: patchOnlySnaps }), (error) => !/raw\/master\.png/.test(error.message) && /raw\/patch\.png .* is not an output the log recorded/.test(error.message));

    const changed = await workspace();
    const changedSnaps = (await snapTheScene(changed)).snaps;
    writeFileSync(join(changed, 'raw', 'master.png'), Buffer.from('not the logged master any more'));
    assert.throws(() => planSnapLog({ rootDir: changed, stage: STAGE, snaps: changedSnaps }), /raw\/master\.png \(sha256 [0-9a-f]{16}\) is not an output the log recorded/, 'a file with other bytes than the logged ones is not that generation');

    const gone = await workspace();
    const goneSnaps = (await snapTheScene(gone)).snaps;
    rmSync(join(gone, 'raw', 'patch.png'));
    assert.throws(() => planSnapLog({ rootDir: gone, stage: STAGE, snaps: goneSnaps }), /raw\/patch\.png is missing/);
    for (const rootDir of [unlogged, patchOnly, changed, gone]) {
        assert.equal(existsSync(join(rootDir, 'raw', STAGE)), false, 'nothing was written');
    }
});

test('a snap is never written over a file, and two pictures cannot share the name of an approved copy', SLOW, async () => {
    const rootDir = await workspace();
    const { snaps } = await snapTheScene(rootDir);
    logSnaps(rootDir, snaps);
    const before = logBytes(rootDir);
    assert.throws(() => planSnapLog({ rootDir, stage: STAGE, snaps }), /raw\/s8\/pixel\/test-scene\.png already exists; remove it or pick another stage/);
    assert.deepEqual(logBytes(rootDir), before);
    assert.deepEqual(logSnaps(rootDir, snaps, 's9').map(({ file }) => file), ['raw/s9/pixel/test-scene.png'], 'another stage is another folder');
    assert.throws(() => planSnapLog({ rootDir, stage: 's10', snaps: [...snaps, ...snaps] }), /Two pictures are called "test-scene"/);
    assert.throws(() => planSnapLog({ rootDir, stage: 's10', snaps: [] }), /There is nothing to log/);
});

test('a stage is a plain name, so the folder it names cannot lead anywhere else', () => {
    for (const stage of ['s8', 's8-2', 's_8']) {
        assert.doesNotThrow(() => assertStage(stage), stage);
    }
    for (const stage of ['', '../x', 'a/b', 'a b', '..']) {
        assert.throws(() => assertStage(stage), /The stage ".*" may hold letters, digits, "_" and "-" only/, JSON.stringify(stage));
    }
    const rootDir = tempDir('sb-github-snap-log-stage-');
    assert.throws(() => planSnapLog({ rootDir, stage: '../x', snaps: [] }), /may hold letters/);
    assert.equal(existsSync(join(rootDir, 'raw')), false);
});

test('a stage is a string: undefined, null, a number, an array or an object are refused, though RegExp.test would read them as text that passes', () => {
    for (const stage of [undefined, null, 8, ['s8'], { toString: () => 's8' }]) {
        assert.throws(() => assertStage(stage), /The stage ".*" may hold letters, digits, "_" and "-" only/, String(stage));
    }
    const rootDir = tempDir('sb-github-snap-log-stage-');
    assert.throws(() => planSnapLog({ rootDir, stage: undefined, snaps: [] }), /may hold letters/, 'a run without --stage that reached the logging would stop here');
    assert.equal(existsSync(join(rootDir, 'raw')), false);
});

test('the patch of a scene is the path of a picture, and only the scene whose master was patched names one', () => {
    const rootDir = tempDir('sb-github-snap-log-scenes-');
    const good = { master: 'raw/a.png', cell: 3, reisen: 'left', pose: 'standing' };
    const write = (scene) => writeFileSync(join(rootDir, 'github-scenes.json'), JSON.stringify({ scenes: { one: scene } }));
    write({ ...good, patch: 'raw/p.png' });
    assert.equal(loadScenes(rootDir).one.patch, 'raw/p.png');
    write({ ...good, patch: 3 });
    assert.throws(() => loadScenes(rootDir), /"patch" is the path of the picture that was patched into the master/);
    const scenes = loadScenes(REAL_ROOT);
    assert.deepEqual(Object.keys(scenes).filter((name) => scenes[name].patch), ['banner-community']);
    assert.equal(dirname(scenes['banner-community'].patch), dirname(scenes['banner-community'].master), 'the patch picture lies beside the composite it went into');
    assert.match(scenes['banner-community'].patch, /-patch-p1-2\.png$/, 'the model result of variant 2 of the patch, as the master is the composite of variant 2');
});

/** A plate in which the cells of a grid of 3.2 by 4 master pixels can be found. */
function gridPlate() {
    const plate = createRaster(1536, 1024);
    for (let y = 0; y < 1024; y++) {
        for (let x = 0; x < 1536; x++) {
            const cellX = Math.floor(x / 3.2);
            const cellY = Math.floor((y - 0.5) / 4);
            plate.data.set([(cellX * 37 + cellY * 11) % 256, (cellX * 53 + cellY * 29) % 256, (cellX * 7 + cellY * 71) % 256, 255], (y * 1536 + x) * 4);
        }
    }
    return plate;
}

test('a plate variant is logged under its backdrop name with the plate master in refs, and --variant limits what is snapped', SLOW, async () => {
    const real = loadBackdropConfig(REAL_ROOT);
    const rootDir = tempDir('sb-github-snap-log-plates-');
    mkdirSync(join(rootDir, 'raw'), { recursive: true });
    await writeRaster(join(rootDir, 'raw', 'day.png'), gridPlate());
    appendLogEntry(logPathOf(rootDir), generation('raw/day.png', readFileSync(join(rootDir, 'raw', 'day.png'))));
    const config = { plates: { 'mansion-day': { ...real.plates['mansion-day'], master: 'raw/day.png' } } };

    await assert.rejects(snapPlate({ rootDir, plate: 'mansion-day', config, only: ['poster'] }), /The plate "mansion-day" has no "poster" crop\. Its crops: banner, social/);
    const snapped = [await snapPlate({ rootDir, plate: 'mansion-day', config, only: ['banner'] })];
    assert.deepEqual(snapped[0].variants.map(({ variant }) => variant), ['banner']);
    assert.equal(existsSync(join(rootDir, 'out/github/snapped/backdrop-mansion-day-social.png')), false, 'the crop that was not asked for was not snapped');
    const before = logBytes(rootDir);

    const logged = logSnaps(rootDir, loggedPlates(config, snapped));
    const file = `raw/${STAGE}/pixel/backdrop-mansion-day-banner.png`;
    assert.deepEqual(logged, [{ id: 'backdrop-mansion-day-banner', file, sha256: sha256(snapped[0].variants[0].png) }]);
    assert.deepEqual(readFileSync(join(rootDir, file)), readFileSync(join(rootDir, snapped[0].variants[0].file)));
    assert.deepEqual(logBytes(rootDir).subarray(0, before.length), before);
    const entry = readLog(logPathOf(rootDir)).at(-1);
    assert.deepEqual([entry.provider, entry.model, entry.template, entry.estimatedUsd, entry.approved], ['local', 'pixel-snap', 'pixel-snap', 0, false]);
    assert.deepEqual(entry.refs, [sha256(readFileSync(join(rootDir, 'raw', 'day.png')))]);
    assert.equal(entry.size, '427x134');
    assert.deepEqual(entry.outputs, [{ file, sha256: sha256(snapped[0].variants[0].png) }]);
    assert.deepEqual([entry.vars.id, entry.vars.master, entry.vars.plate, entry.vars.variant, entry.vars.like, entry.vars.character, entry.vars.github], ['backdrop-mansion-day-banner', 'raw/day.png', 'mansion-day', 'banner', null, null, undefined]);
    assert.equal(entry.vars.tool, 'github-backdrop.mjs');
    assert.ok(Math.abs(entry.vars.grid.across.cell - 3.2) < 0.02 && Math.abs(entry.vars.grid.down.cell - 4) < 0.02, 'the grid that was found');
    assert.deepEqual(Object.keys(entry.vars.grid.across), ['cell', 'offset', 'strength']);
    assert.deepEqual(entry.vars.crop, { cell: real.plates['mansion-day'].variants.banner.cell, step: real.plates['mansion-day'].variants.banner.step, x: real.plates['mansion-day'].variants.banner.x, y: real.plates['mansion-day'].variants.banner.y, columns: 427, rows: 134 });

    approveOutputs({ rootDir, targets: [join(rootDir, file)], ref: false });
    assert.deepEqual(readFileSync(join(rootDir, 'approved', 'pixel', 'backdrop-mansion-day-banner.png')), readFileSync(join(rootDir, file)));
});

/** Runs one of the snap scripts on a package folder of the test's own, so that no test can write the real package's out/, raw/ or log. */
const runScript = (script, rootDir, ...args) => spawnSync(process.execPath, [join(REAL_ROOT, 'scripts', script), '--root', rootDir, ...args], { encoding: 'utf8' });

test('github-snap.mjs without --stage is a preview: it writes under out/ and logs nothing, and with --stage it logs', SLOW, async () => {
    const rootDir = await workspace();
    const before = logBytes(rootDir);
    const preview = runScript('github-snap.mjs', rootDir);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /^preview only: nothing was logged and approved\/ was not written\.$/m);
    assert.equal(existsSync(join(rootDir, 'out/github/snapped/test-scene.png')), true, 'the preview was made');
    assert.deepEqual(logBytes(rootDir), before, 'and nothing was logged');
    assert.equal(existsSync(join(rootDir, 'raw', STAGE)), false, 'nothing was written under raw/ beyond the master');
    assert.equal(existsSync(join(rootDir, 'approved')), false);

    const logged = runScript('github-snap.mjs', rootDir, '--stage', STAGE);
    assert.equal(logged.status, 0, logged.stderr);
    assert.match(logged.stdout, new RegExp(`^logged ${SCENE_FILE.replaceAll('.', '\\.')} \\(sha256 [0-9a-f]{16}\\)$`, 'm'));
    assert.equal(readLog(logPathOf(rootDir)).length, 3, 'a logged run adds its line to the two generations');
    assert.equal(existsSync(join(rootDir, SCENE_FILE)), true);
});

test('github-backdrop.mjs without --stage is a preview: it writes under out/ and logs nothing, and with --stage it logs', SLOW, async () => {
    const rootDir = tempDir('sb-github-snap-log-backdrop-');
    mkdirSync(join(rootDir, 'raw'), { recursive: true });
    await writeRaster(join(rootDir, 'raw', 'day.png'), gridPlate());
    appendLogEntry(logPathOf(rootDir), generation('raw/day.png', readFileSync(join(rootDir, 'raw', 'day.png'))));
    const config = JSON.parse(readFileSync(join(REAL_ROOT, 'github-backdrops.json'), 'utf8'));
    config.plates['mansion-day'].master = 'raw/day.png';
    writeFileSync(join(rootDir, 'github-backdrops.json'), JSON.stringify(config));
    const before = logBytes(rootDir);
    const only = ['--plate', 'mansion-day', '--variant', 'banner'];

    const preview = runScript('github-backdrop.mjs', rootDir, ...only);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /^preview only: nothing was logged and approved\/ was not written\.$/m);
    assert.equal(existsSync(join(rootDir, 'out/github/snapped/backdrop-mansion-day-banner.png')), true, 'the preview was made');
    assert.deepEqual(logBytes(rootDir), before, 'and nothing was logged');
    assert.equal(existsSync(join(rootDir, 'raw', STAGE)), false, 'nothing was written under raw/ beyond the plate');
    assert.equal(existsSync(join(rootDir, 'approved')), false);

    const logged = runScript('github-backdrop.mjs', rootDir, ...only, '--stage', STAGE);
    assert.equal(logged.status, 0, logged.stderr);
    assert.match(logged.stdout, /^logged raw\/s8\/pixel\/backdrop-mansion-day-banner\.png \(sha256 [0-9a-f]{16}\)$/m);
    assert.equal(readLog(logPathOf(rootDir)).length, 2, 'the generation and the line of the snap');
});
