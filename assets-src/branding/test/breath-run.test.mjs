import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readLog, sha256 } from '../scripts/lib/log.mjs';
import { readRaster } from '../scripts/lib/raster.mjs';
import { composeBackdrop, drawScene, loadScene } from '../scripts/lib/breath-scene.mjs';
import { poseFileName, runBreath } from '../scripts/lib/breath-run.mjs';
import { breathWorkspace } from '../test-support/breath-workspace.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'breath-frames.mjs');
const NOW = () => new Date('2026-11-02T12:00:00.000Z');
const POSES = ['c', 'b'];

const request = (space, extra = {}) => ({ rootDir: space.rootDir, mode: 'dry-run', now: NOW, ...extra });
const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

test('a dry run builds and checks every picture in memory and writes nothing: no file, no gallery, no log line', async () => {
    const space = await breathWorkspace();
    const before = readFileSync(space.logPath, 'utf8');
    const { models, jobs, written, logged } = await runBreath(request(space));
    assert.deepEqual(models.map(({ id }) => id), ['mini-alice', 'mini']);
    assert.deepEqual([written, logged], [[], 0]);
    assert.ok(jobs.length >= 4);
    assert.equal(existsSync(join(space.rootDir, 'out')), false);
    assert.equal(existsSync(join(space.rootDir, 'raw')), false);
    assert.equal(readFileSync(space.logPath, 'utf8'), before);
});

test('a preview writes the poses under out/breath/ and the page that plays it under out/gallery/, and logs nothing', async () => {
    const space = await breathWorkspace();
    const before = readFileSync(space.logPath, 'utf8');
    const { written } = await runBreath(request(space, { mode: 'preview' }));
    assert.equal(readFileSync(space.logPath, 'utf8'), before);
    const names = filesIn(join(space.rootDir, 'out', 'breath'));
    assert.ok(names.includes('mini-alice--breath-b.png') && names.includes('mini-alice--breath-b-closed.png'));
    assert.equal(names.includes('mini-alice--breath-c.png'), false, 'the centre pose of a still is the approved still itself');
    assert.ok(names.includes('mini--alice--breath-c.png') && names.includes('mini--bob--breath-b.png') && names.includes('mini--backdrop.png') && names.includes('mini--breath.json'));
    assert.equal(names.includes('mini--bob--breath-b-half.png'), false, 'no blink frames, no blink poses');
    assert.ok(written.includes('out/gallery/breath.html'));
    const page = readFileSync(join(space.rootDir, 'out', 'gallery', 'breath.html'), 'utf8');
    assert.match(page, /\.\.\/breath\/mini--alice--breath-b\.png/);
    assert.match(page, /\.\.\/\.\.\/approved\/pixel\/mini-alice--half\.png/, 'the centre pose of a still is shown from the approved still');
    assert.match(page, /Pre-rendered frames/);
    assert.doesNotMatch(page, /<\/script><script/);
});

test('a second preview replaces the files of the first, and still logs nothing', async () => {
    const space = await breathWorkspace();
    const before = readFileSync(space.logPath, 'utf8');
    const first = await runBreath(request(space, { mode: 'preview' }));
    const stale = ['out/breath/mini-alice--breath-b.png', 'out/breath/mini--breath.json', 'out/gallery/breath.html'];
    const earlier = stale.map((file) => readFileSync(join(space.rootDir, file)));
    for (const file of stale) {
        writeFileSync(join(space.rootDir, file), 'left over from an earlier run');
    }
    const second = await runBreath(request(space, { mode: 'preview' }));
    assert.deepEqual(second.written, first.written, 'the same files are written again');
    stale.forEach((file, index) => assert.ok(readFileSync(join(space.rootDir, file)).equals(earlier[index]), `${file} is replaced by the new run`));
    assert.equal(readFileSync(space.logPath, 'utf8'), before);
});

test('a real run writes raw/s5/pixel-body/breath/ and logs one local breath-frames line for each source picture, with its sha256 in refs', async () => {
    const space = await breathWorkspace();
    const { logged, written } = await runBreath(request(space, { mode: 'build', stage: 's5' }));
    const dir = join(space.rootDir, 'raw', 's5', 'pixel-body', 'breath');
    assert.equal(logged, 4, 'the still, the two layers and the scene');
    assert.equal(written.length, filesIn(dir).length);
    const entries = readLog(space.logPath).filter((entry) => entry.model === 'breath-frames');
    assert.equal(entries.length, 4);
    for (const entry of entries) {
        assert.deepEqual([entry.stage, entry.provider, entry.template, entry.estimatedUsd, entry.approved], ['s5', 'local', 'breath-frames', 0, false]);
        for (const output of entry.outputs) {
            assert.ok(output.file.startsWith('raw/s5/pixel-body/breath/') && !output.approved);
            assert.equal(sha256(readFileSync(join(space.rootDir, output.file))), output.sha256);
        }
        assert.equal(entry.vars.config.file, 'breath-config.json');
    }
    const [still, alice, bob, scene] = entries;
    const stillRefs = ['mini-alice', 'mini-alice--half', 'mini-alice--closed'].map((name) => sha256(readFileSync(join(space.rootDir, 'approved', 'pixel', `${name}.png`))));
    assert.deepEqual(still.refs, stillRefs, 'the base first, then its blink frames');
    assert.deepEqual(still.outputs.map(({ file }) => file.split('/').pop()).sort(), POSES.filter((pose) => pose !== 'c').flatMap((pose) => ['base', 'half', 'closed'].map((variant) => poseFileName('mini-alice', pose, variant))).sort());
    assert.equal(still.vars.kind, 'still');
    assert.equal(still.vars.source, 'approved/pixel/mini-alice.png');
    assert.equal(still.vars.waistShare, 0.55);
    assert.equal(still.vars.waist, 82);
    assert.deepEqual(still.vars.rhythm, { cycleSeconds: 3.5, breathsPerCycle: 2 });
    assert.deepEqual(still.vars.rings, { rimWidth: 2, bandWidth: 2 });
    assert.deepEqual([alice.vars.kind, alice.vars.scene, alice.vars.layer, alice.vars.placement.z], ['layer', 'mini', 'alice', 1]);
    assert.deepEqual(alice.vars.grade.toward, '#7d8fd6');
    assert.deepEqual(bob.refs, [sha256(readFileSync(join(space.rootDir, 'approved', 'pixel', 'mini-bob.png')))]);
    assert.equal(bob.outputs.length, 2, 'two poses of one picture, no blink variants');
    assert.deepEqual([scene.vars.kind, scene.vars.recomposed], ['scene', 'identical to the approved scene']);
    assert.deepEqual(scene.outputs.map(({ file }) => file.split('/').pop()).sort(), ['mini--backdrop.png', 'mini--breath.json']);
    assert.ok(scene.refs.includes(sha256(readFileSync(join(space.rootDir, 'approved', 'pixel', 'mini.png')))), 'the approved scene is one of its sources');
});

test('the layout file has each layer\'s placement and z, and drawing the layer images from it gives the approved scene back, each figure on her own clock', async () => {
    const space = await breathWorkspace();
    await runBreath(request(space, { mode: 'build', stage: 's5' }));
    const dir = join(space.rootDir, 'raw', 's5', 'pixel-body', 'breath');
    const manifest = JSON.parse(readFileSync(join(dir, 'mini--breath.json'), 'utf8'));
    assert.deepEqual(manifest.grid, { cell: 2, width: 240, height: 180 });
    assert.equal(manifest.backdrop, 'mini--backdrop.png');
    assert.deepEqual(manifest.poses, ['c', 'b']);
    assert.deepEqual(manifest.rhythm, { cycleSeconds: 3.5, breathsPerCycle: 2 });
    assert.deepEqual(manifest.layers.map(({ id, z }) => [id, z]), [['alice', 1], ['bob', 2]]);
    const scene = await loadScene({ rootDir: space.rootDir, scene: 'mini' });
    const layers = [];
    for (const [index, layer] of manifest.layers.entries()) {
        assert.deepEqual(Object.keys(layer.images), POSES);
        assert.deepEqual(Object.keys(layer.images.b), layer.id === 'alice' ? ['base', 'half', 'closed'] : ['base']);
        const images = new Map();
        for (const [pose, byVariant] of Object.entries(layer.images)) {
            images.set(pose, Object.fromEntries(await Promise.all(Object.entries(byVariant).map(async ([variant, file]) => [variant, await readRaster(join(dir, file))]))));
        }
        const picture = images.get('c').base;
        assert.deepEqual([picture.width, picture.height], [layer.width, layer.height]);
        layers.push({ z: layer.z, order: index, left: layer.left, top: layer.top, images });
    }
    const backdrop = await readRaster(join(dir, manifest.backdrop));
    assert.ok(drawScene({ grid: scene.grid, backdrop, layers, pose: 'c' }).data.equals(scene.scene.raster.data));
    const aliceOnly = layers.map((layer, at) => ({ ...layer, images: new Map([['p', layer.images.get(at === 0 ? 'b' : 'c')]]) }));
    const mixed = drawScene({ grid: scene.grid, backdrop, layers: aliceOnly, pose: 'p' });
    const both = drawScene({ grid: scene.grid, backdrop, layers, pose: 'b' });
    assert.ok(!mixed.data.equals(scene.scene.raster.data), 'one breathing and the other not is not the centre pose');
    assert.ok(!mixed.data.equals(both.data), 'and not both breathing either');
    const staticOnly = composeBackdrop(scene);
    assert.ok(backdrop.data.equals(staticOnly.data), 'the backdrop file is the scene without its figures');
});

test('a run with no names makes what breath-config.json lists, and a name that is not a picture or a scene writes nothing', async () => {
    const space = await breathWorkspace();
    const named = await runBreath(request(space, { stills: ['mini-bob'], scenes: [] }));
    assert.deepEqual(named.models.map(({ id }) => id), ['mini-bob']);
    await assert.rejects(runBreath(request(space, { stills: ['nowhere'] })), /approved\/pixel\/nowhere\.png does not exist/);
    await assert.rejects(runBreath(request(space, { stills: [], scenes: ['nowhere'] })), /no approved grid scene called nowhere\.png/);
    await assert.rejects(runBreath(request(space, { stills: [], scenes: [] })), /There is nothing to make/);
});

test('a real run without a stage, over files that exist, or over rings the config does not name, writes nothing and logs nothing', async () => {
    const space = await breathWorkspace();
    await assert.rejects(runBreath(request(space, { mode: 'build' })), /Pass --stage/);
    await runBreath(request(space, { mode: 'build', stage: 's5', stills: ['mini-bob'], scenes: [] }));
    const lines = readLog(space.logPath).length;
    await assert.rejects(runBreath(request(space, { mode: 'build', stage: 's5', stills: ['mini-bob'], scenes: [] })), /1 of the files already exist in raw\/s5\/pixel-body\/breath\/ \(mini-bob--breath-b\.png.*\); remove them first\. Nothing was written\./);
    assert.equal(readLog(space.logPath).length, lines);
    const wide = await breathWorkspace();
    writeFileSync(join(wide.rootDir, 'snap-config.json'), JSON.stringify({ bodyHeights: { tewi: 283, reisen: 340 }, lineupRatio: 0.8333, rings: { rim: 3, band: 3 } }));
    await assert.rejects(runBreath(request(wide, { mode: 'build', stage: 's5' })), /its rings are 2\+2 art pixels but snap-config\.json says 3\+3/);
    assert.equal(existsSync(join(wide.rootDir, 'raw')), false);
});

test('without a snap-config.json the rings to rebuild are the ones the still has', async () => {
    const space = await breathWorkspace({ withSnapConfig: false });
    const { jobs } = await runBreath(request(space, { stills: ['mini-alice'], scenes: [] }));
    assert.deepEqual(jobs[0].vars.rings, { rimWidth: 2, bandWidth: 2 });
});

test('breath-frames.mjs asks for one mode, and names the way to give it', () => {
    const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    assert.match(run().stderr, /Pass one of --dry-run, --preview and --stage/);
    assert.match(run('--dry-run', '--preview').stderr, /Pass one of/);
});
