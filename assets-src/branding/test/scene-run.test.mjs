import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readLog, sha256 } from '../scripts/lib/log.mjs';
import { createRaster, readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { runComposeScene } from '../scripts/lib/scene-run.mjs';
import { figure } from '../test-support/figure.mjs';
import { getPixel, setPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'compose-scene.mjs');
const NOW = () => new Date('2026-11-01T12:00:00.000Z');
const RED = [220, 30, 30, 255];
const BLUE = [30, 30, 220, 255];

function block(colour) {
    const raster = createRaster(60, 60);
    for (let y = 10; y < 50; y++) {
        for (let x = 10; x < 50; x++) {
            setPixel(raster, x, y, colour);
        }
    }
    return raster;
}

async function workspace() {
    const rootDir = tempDir('sb-scene-');
    for (const dir of ['raw/s5/masters', 'layouts', 'out/s5']) {
        mkdirSync(join(rootDir, dir), { recursive: true });
    }
    await writeRaster(join(rootDir, 'raw/s5/masters/sky.png'), block(BLUE));
    await writeRaster(join(rootDir, 'raw/s5/masters/hero.png'), block(RED));
    const layout = {
        canvas: { width: 200, height: 100 },
        layers: [
            { id: 'hero', image: 'raw/s5/masters/hero.png', z: 2, at: 'bottom-centre', anchor: { x: 60, y: 95 }, height: 60 },
            { id: 'sky', image: 'raw/s5/masters/sky.png', z: 1, at: 'centre', anchor: { x: 100, y: 40 }, height: 50 },
        ],
    };
    const layoutPath = join(rootDir, 'layouts', 'scene.json');
    writeFileSync(layoutPath, JSON.stringify(layout));
    return { rootDir, layoutPath };
}

const run = (rootDir, layoutPath, extra = {}) => runComposeScene({ rootDir, layoutPath, outPath: join(rootDir, 'raw/s5/masters/scene.png'), stage: 's5', now: NOW, ...extra });

test('the scene is written at the canvas size and logged as a derived output with every input hash, in stacking order', async () => {
    const { rootDir, layoutPath } = await workspace();
    const result = await run(rootDir, layoutPath);
    assert.deepEqual(result.size, { width: 200, height: 100 });
    const picture = await readRaster(join(rootDir, 'raw/s5/masters/scene.png'));
    assert.deepEqual([picture.width, picture.height], [200, 100]);
    assert.deepEqual(getPixel(picture, 60, 60), RED);
    assert.deepEqual(getPixel(picture, 100, 40), BLUE);
    const [entry] = readLog(join(rootDir, 'log', 'generations.jsonl'));
    assert.deepEqual([entry.stage, entry.provider, entry.model, entry.template, entry.estimatedUsd, entry.approved], ['s5', 'local', 'compose-scene', 'compose-scene', 0, false]);
    assert.deepEqual(entry.refs, [sha256(readFileSync(join(rootDir, 'raw/s5/masters/sky.png'))), sha256(readFileSync(join(rootDir, 'raw/s5/masters/hero.png')))]);
    assert.equal(entry.vars.layout, 'layouts/scene.json');
    assert.deepEqual(entry.vars.inputs, ['hero=raw/s5/masters/hero.png', 'sky=raw/s5/masters/sky.png']);
    assert.equal(entry.vars.placements.length, 2);
    assert.deepEqual(entry.outputs, [{ file: 'raw/s5/masters/scene.png', sha256: sha256(readFileSync(join(rootDir, 'raw/s5/masters/scene.png'))) }]);
    assert.equal(entry.size, '200x100');
});

test('--set swaps a layer\'s picture, and is logged by the hash of what was really used', async () => {
    const { rootDir, layoutPath } = await workspace();
    await writeRaster(join(rootDir, 'out/s5/placeholder.png'), block([20, 200, 20, 255]));
    await run(rootDir, layoutPath, { overrides: { sky: 'out/s5/placeholder.png' } });
    const picture = await readRaster(join(rootDir, 'raw/s5/masters/scene.png'));
    assert.deepEqual(getPixel(picture, 100, 40), [20, 200, 20, 255]);
    const [entry] = readLog(join(rootDir, 'log', 'generations.jsonl'));
    assert.ok(entry.vars.inputs.includes('sky=out/s5/placeholder.png'));
    assert.ok(entry.refs.includes(sha256(readFileSync(join(rootDir, 'out/s5/placeholder.png')))));
});

test('a preview is written under out/ only and is never logged, so a placeholder cannot reach the log', async () => {
    const { rootDir, layoutPath } = await workspace();
    await run(rootDir, layoutPath, { outPath: join(rootDir, 'out/s5/preview.png'), preview: true, stage: undefined });
    assert.ok(existsSync(join(rootDir, 'out/s5/preview.png')));
    assert.equal(readLog(join(rootDir, 'log', 'generations.jsonl')).length, 0);
    await assert.rejects(run(rootDir, layoutPath, { outPath: join(rootDir, 'raw/s5/masters/p.png'), preview: true }), /preview is written under out\/ only/);
});

test('missing pictures are listed with their layers and nothing is written or logged', async () => {
    const { rootDir, layoutPath } = await workspace();
    const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
    layout.layers.push({ id: 'moon', image: 'raw/s5/masters/moon.png', z: 0, anchor: { x: 1, y: 1 }, height: 10 });
    writeFileSync(layoutPath, JSON.stringify(layout));
    await assert.rejects(run(rootDir, layoutPath), /Missing pictures: moon \(raw\/s5\/masters\/moon\.png\)\. Make them first, or pass --set/);
    assert.ok(!existsSync(join(rootDir, 'raw/s5/masters/scene.png')));
    assert.equal(readLog(join(rootDir, 'log', 'generations.jsonl')).length, 0);
});

test('an existing output, an unknown --set layer, a missing stage and an output outside raw/ and out/ are refused', async () => {
    const { rootDir, layoutPath } = await workspace();
    await run(rootDir, layoutPath);
    await assert.rejects(run(rootDir, layoutPath), /already exists/);
    await assert.rejects(run(rootDir, layoutPath, { outPath: join(rootDir, 'raw/s5/masters/b.png'), overrides: { moon: 'x.png' } }), /--set names "moon".*Layers: hero, sky/);
    await assert.rejects(run(rootDir, layoutPath, { outPath: join(rootDir, 'raw/s5/masters/c.png'), stage: undefined }), /Pass the stage/);
    await assert.rejects(run(rootDir, layoutPath, { outPath: join(rootDir, 'approved/d.png') }), /inside raw\/ or out\//);
    assert.equal(readLog(join(rootDir, 'log', 'generations.jsonl')).length, 1);
});

test('the command line previews a layout with --set and reports each placement, and --measure reports a figure\'s heights', async () => {
    const { rootDir, layoutPath } = await workspace();
    await writeRaster(join(rootDir, 'raw/s5/masters/fig.png'), figure());
    const cli = (args) => spawnSync('node', [SCRIPT, ...args], { cwd: rootDir, encoding: 'utf8', env: { ...process.env } });
    const measured = cli(['--measure', join(rootDir, 'raw/s5/masters/fig.png'), `${join(rootDir, 'raw/s5/masters/fig.png')}:0-299`]);
    assert.match(measured.stdout, /figure \d+ px \(head top to feet, ears left out\); head top y \d+, feet y \d+/);
    assert.equal(measured.stdout.trim().split('\n').length, 2);
    const noArgs = cli(['--measure']);
    assert.match(noArgs.stderr, /Usage/);
    const badSet = cli(['--layout', layoutPath, '--out', 'out/s5/x.png', '--preview', '--set', 'sky']);
    assert.match(badSet.stderr, /--set must be <layer>=<picture>/);
});

async function gradedWorkspace(grade) {
    const made = await workspace();
    const layout = JSON.parse(readFileSync(made.layoutPath, 'utf8'));
    layout.layers[0].grade = grade;
    writeFileSync(made.layoutPath, JSON.stringify(layout));
    return made;
}

const BLOCK_GRADE = { toward: '#7D8FD6', amount: 0.14, lightness: -0.03, keepSticker: false };

test('a real run logs the grade of each layer, as it was applied, and a scene without grades logs none', async () => {
    const plain = await workspace();
    await run(plain.rootDir, plain.layoutPath);
    assert.ok(!('grades' in readLog(join(plain.rootDir, 'log', 'generations.jsonl'))[0].vars));

    const { rootDir, layoutPath } = await gradedWorkspace(BLOCK_GRADE);
    const result = await run(rootDir, layoutPath);
    const [entry] = readLog(join(rootDir, 'log', 'generations.jsonl'));
    assert.deepEqual(entry.vars.grades, { hero: { toward: '#7d8fd6', amount: 0.14, lightness: -0.03, keepSticker: false } });
    assert.deepEqual(result.grades, entry.vars.grades);
    const picture = await readRaster(join(rootDir, 'raw/s5/masters/scene.png'));
    assert.notDeepEqual(getPixel(picture, 60, 60), RED);
    assert.deepEqual(getPixel(picture, 100, 40), BLUE, 'a layer without a grade is as it was');
});

test('a graded preview is written under out/ and still never logged', async () => {
    const { rootDir, layoutPath } = await gradedWorkspace(BLOCK_GRADE);
    await run(rootDir, layoutPath, { outPath: join(rootDir, 'out/s5/preview.png'), preview: true, stage: undefined });
    assert.ok(existsSync(join(rootDir, 'out/s5/preview.png')));
    assert.equal(readLog(join(rootDir, 'log', 'generations.jsonl')).length, 0);
});

test('a bad grade is refused before anything is written or logged', async () => {
    const { rootDir, layoutPath } = await gradedWorkspace({ toward: 'blue', amount: 0.14 });
    await assert.rejects(run(rootDir, layoutPath), /Layer 1 \("hero"\) grade toward must be a hex colour/);
    const sticky = await gradedWorkspace({ toward: '#7d8fd6', amount: 0.14 });
    await assert.rejects(run(sticky.rootDir, sticky.layoutPath), /rim/);
    for (const { rootDir: root } of [{ rootDir }, sticky]) {
        assert.ok(!existsSync(join(root, 'raw/s5/masters/scene.png')));
        assert.equal(readLog(join(root, 'log', 'generations.jsonl')).length, 0);
    }
});
