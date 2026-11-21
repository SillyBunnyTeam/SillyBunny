import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readLog, sha256 } from '../scripts/lib/log.mjs';
import { readRaster } from '../scripts/lib/raster.mjs';
import { findBaseSnap } from '../scripts/lib/snap-frame.mjs';
import { runSplash } from '../scripts/lib/splash-run.mjs';
import { drawLayers } from '../scripts/lib/splash-scene.mjs';
import { LEGS, SPLASH_CONFIG, splashWorkspace } from '../test-support/splash-workspace.mjs';

const NOW = () => new Date('2026-11-02T12:00:00.000Z');
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'splash-frames.mjs');
const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((name) => /\.\w+$/.test(name)).sort() : []);
const run = (space, mode, stage) => runSplash({ rootDir: space.rootDir, mode, stage, now: NOW });

test('a dry run snaps both bases, composes and snaps both frames and lays the scene out, and writes nothing: no file, no gallery, no log', async () => {
    const space = await splashWorkspace();
    const result = await run(space, 'dry-run');
    assert.deepEqual(result.frames.map(({ id }) => id), ['loop-a--call', 'loop-b--mid']);
    assert.equal(result.written.length, 0);
    assert.equal(existsSync(join(space.rootDir, 'out')), false);
    assert.equal(existsSync(space.logPath), false);
    assert.equal(existsSync(join(space.rootDir, 'raw', 's5', 'splash-anim')), false);
});

test('each frame changes only inside its mask, the kept parts do not change at all, and the mouth frame changes a small box on the face', async () => {
    const space = await splashWorkspace();
    const { frames } = await run(space, 'dry-run');
    const [call, mid] = frames;
    assert.ok(call.check.changed > 0 && call.check.changed < 400, `${call.check.changed} art pixels changed for the mouth`);
    assert.ok(call.check.box.width < 15 && call.check.box.height < 15);
    assert.deepEqual(mid.check.keep.map(({ name, changed }) => [name, changed]), [['legs', 0]]);
    assert.ok(mid.check.keep[0].pixels > 100);
    assert.ok(mid.composed.dropped.edit.pieces >= 1, 'the blob away from the figure was dropped');
    assert.equal(mid.prepared.report.rings.measured.rimWidth, 2);
    assert.equal(mid.prepared.report.rings.measured.bandWidth, 2);
    assert.equal(mid.prepared.report.frame.base.id, 'loop-b');
    assert.equal(mid.prepared.id, 'loop-b--mid');
});

test('the scene has both characters side by side on one feet row, with no pixel of one touching the other in any pose, and every pose of a character is one frame', async () => {
    const space = await splashWorkspace();
    const { scene, built } = await run(space, 'dry-run');
    const [left, right] = scene.layers;
    assert.deepEqual([left.id, right.id, left.z, right.z], ['reisen', 'tewi', 1, 2]);
    assert.equal(left.top + left.height, right.top + right.height);
    assert.ok(right.left > left.left);
    assert.deepEqual([...left.frames.keys()], ['idle', 'call']);
    assert.deepEqual([...right.frames.keys()], ['raised', 'mid']);
    for (const layer of scene.layers) {
        for (const frame of layer.frames.values()) {
            assert.deepEqual([frame.width, frame.height], [layer.width, layer.height]);
        }
    }
    assert.equal(scene.width, Math.max(left.width, right.left - 3 + right.width) + 6, 'the canvas is the boxes and the margin');
    const poses = new Map(scene.layers.map((layer) => [layer.id, layer.base]));
    const neutral = drawLayers({ width: scene.width, height: scene.height, layers: scene.layers, poseOf: (id) => poses.get(id) });
    assert.ok(neutral.data.some((value, at) => at % 4 === 3 && value === 255));
    assert.equal(built.reisen.snap.id, 'loop-a');
});

test('a preview writes the frames, the masks\' cut pictures, the layers, the manifest and the page under out/, and logs nothing; running it again replaces them', async () => {
    const space = await splashWorkspace();
    const first = await run(space, 'preview');
    const stale = ['out/splash/pixel/loop-a.png', 'out/splash/masters/loop-b--mid--cut.png', 'out/gallery/splash-anim.html'];
    const earlier = stale.map((file) => readFileSync(join(space.rootDir, file)));
    for (const file of stale) {
        writeFileSync(join(space.rootDir, file), 'left over from an earlier run');
    }
    const { written } = await run(space, 'preview');
    assert.deepEqual(written, first.written, 'the same files are written again');
    stale.forEach((file, index) => assert.ok(readFileSync(join(space.rootDir, file)).equals(earlier[index]), `${file} is replaced by the new run`));
    assert.equal(existsSync(space.logPath), false);
    const names = filesIn(join(space.rootDir, 'out'));
    for (const wanted of ['splash/pixel/loop-a.png', 'splash/pixel/loop-b--mid.png', 'splash/masters/loop-b--mid--cut.png', 'splash/masters/loop-a--call.png', 'splash/scene/loop-both--reisen--call.png', 'splash/scene/loop-both--tewi--raised.png', 'splash/scene/loop-both.png', 'splash/scene/loop-both--anim.json', 'gallery/splash-anim.html']) {
        assert.ok(names.includes(wanted), `${wanted} is written`);
    }
    assert.ok(written.includes('out/gallery/splash-anim.html'));
    const manifest = JSON.parse(readFileSync(join(space.rootDir, 'out', 'splash', 'scene', 'loop-both--anim.json'), 'utf8'));
    assert.deepEqual(manifest.layers.map(({ id, z }) => [id, z]), [['reisen', 1], ['tewi', 2]]);
    assert.deepEqual(Object.keys(manifest.layers[1].frames), ['raised', 'mid']);
    assert.deepEqual(manifest.timelines.both.seconds, 2.4);
    const page = readFileSync(join(space.rootDir, 'out', 'gallery', 'splash-anim.html'), 'utf8');
    assert.match(page, /loop-both--tewi--mid\.png/);
    assert.doesNotMatch(page, /<\/script><script/);
});

test('a real run writes raw/<stage>/splash-anim/ and logs, as local tools, each base snap, each composition, each frame snap with its base snap in refs, the layers and the scene', async () => {
    const space = await splashWorkspace();
    const { logged, written } = await run(space, 'build', 's5');
    const entries = readLog(space.logPath);
    assert.equal(logged, 9);
    assert.deepEqual(entries.map(({ template }) => template), ['pixel-snap', 'pixel-snap', 'frame-compose', 'pixel-snap', 'frame-compose', 'pixel-snap', 'splash-frames', 'splash-frames', 'splash-frames']);
    assert.ok(entries.every((entry) => entry.provider === 'local' && entry.estimatedUsd === 0 && entry.approved === false));
    assert.equal(written.length, 12, 'two base snaps, two masters and two frame snaps, four layer images, the picture of both and the manifest');
    const masterSha = (file) => sha256(readFileSync(join(space.rootDir, file)));
    const [baseA, baseB, composeA, snapA, composeB, snapB] = entries;
    assert.equal(baseA.vars.id, 'loop-a');
    assert.equal(baseA.vars.character, 'reisen');
    assert.deepEqual(composeA.refs, [masterSha('raw/s5/splash/base-a.png'), masterSha('raw/s5/splash/call.png')], 'the composition refers to the base and to the edit');
    assert.equal(composeA.model, 'frame-compose');
    assert.equal(composeA.vars.id, 'loop-a--call');
    assert.equal(composeA.vars.edit.file, 'raw/s5/splash/call.png');
    assert.deepEqual(composeA.outputs, [{ file: 'raw/s5/splash-anim/frames/loop-a--call.png', sha256: masterSha('raw/s5/splash-anim/frames/loop-a--call.png') }]);
    assert.deepEqual(snapA.refs, [composeA.outputs[0].sha256, baseA.outputs[0].sha256], 'the frame snap refers to its master and to the base snap');
    assert.equal(snapA.vars.gridFrom.id, 'loop-a');
    assert.equal(snapA.vars.id, 'loop-a--call');
    assert.deepEqual(composeB.vars.keep, [{ name: 'legs', box: LEGS }]);
    assert.ok(composeB.vars.mask.cutPixels > 0 && composeB.vars.mask.stickerGrownBy > 0);
    assert.deepEqual(snapB.refs, [composeB.outputs[0].sha256, baseB.outputs[0].sha256]);
    for (const entry of entries) {
        for (const output of entry.outputs) {
            assert.equal(output.sha256, masterSha(output.file), output.file);
        }
    }
    const found = await findBaseSnap({ rootDir: space.rootDir, from: 'raw/s5/splash-anim/pixel/loop-b.png' });
    assert.equal(found.id, 'loop-b', 'the logged base snap is one a later frame can take its grid from');
    const scene = entries.at(-1);
    assert.equal(scene.vars.kind, 'scene');
    assert.deepEqual(scene.vars.layers.map(({ id, z }) => [id, z]), [['reisen', 1], ['tewi', 2]]);
    const manifest = JSON.parse(readFileSync(join(space.rootDir, 'raw', 's5', 'splash-anim', 'scene', 'loop-both--anim.json'), 'utf8'));
    const reisenLayer = manifest.layers[0];
    const drawn = drawLayers({
        width: manifest.grid.width,
        height: manifest.grid.height,
        layers: await Promise.all(manifest.layers.map(async (layer) => ({ ...layer, frames: new Map(await Promise.all(Object.entries(layer.frames).map(async ([pose, file]) => [pose, await readRaster(join(space.rootDir, 'raw', 's5', 'splash-anim', 'scene', file))]))) }))),
        poseOf: (id) => manifest.layers.find((layer) => layer.id === id).base,
    });
    const picture = await readRaster(join(space.rootDir, 'raw', 's5', 'splash-anim', 'scene', 'loop-both.png'));
    assert.ok(Buffer.from(drawn.data).equals(Buffer.from(picture.data)), 'the layers at their placements are the picture of both');
    assert.equal(reisenLayer.z, 1);
});

test('a real run without a stage, over files that exist, or with an edit that differs from its base nowhere, writes nothing and logs nothing', async () => {
    const space = await splashWorkspace();
    await assert.rejects(run(space, 'build'), /Pass --stage/);
    await run(space, 'build', 's5');
    const before = readFileSync(space.logPath, 'utf8');
    await assert.rejects(run(space, 'build', 's5'), /loop-a.png already exists; pick another name or remove it first/);
    assert.equal(readFileSync(space.logPath, 'utf8'), before);
    const same = await splashWorkspace({ config: { ...SPLASH_CONFIG, frames: [{ ...SPLASH_CONFIG.frames[0], edit: 'raw/s5/splash/base-a.png' }, SPLASH_CONFIG.frames[1]] } });
    await assert.rejects(run(same, 'build', 's5'), /loop-a--call: the edit differs from the base nowhere/);
    assert.equal(existsSync(same.logPath), false);
    assert.equal(existsSync(join(same.rootDir, 'raw', 's5', 'splash-anim')), false);
});

test('splash-frames.mjs with no mode exits with an error that names the three modes', async () => {
    const space = await splashWorkspace();
    const bare = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: space.rootDir });
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /Pass one of --dry-run, --preview and --stage/);
});
