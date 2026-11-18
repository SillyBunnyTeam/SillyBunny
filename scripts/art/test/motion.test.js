import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { encoderVersions } from '../lib/codec.js';
import { runDerive, runProve } from '../lib/commands.js';
import { frameBox } from '../lib/frame.js';
import { MASTER_ROOT, readManifest, validateManifest } from '../lib/manifest.js';
import { readRaster } from '../lib/raster.js';
import { fakeSha } from '../test-support/manifests.js';
import { paint, REPO_ROOT } from '../test-support/pictures.js';
import { copyOfArt, fixtureRepo, writeFixtureManifest } from '../test-support/repos.js';

const CLEAR = [0, 0, 0, 0];
const ART = [200, 120, 220, 255];
const SHIP = 'public/img/sillybunny';

const block = (width, height, [x, y, w, h]) => paint(width, height, (px, py) => (px >= x && px < x + w && py >= y && py < y + h ? ART : CLEAR));
const codes = (run) => run.result.problems.map(({ code }) => code);
const output = (name, digit) => ({ path: `${SHIP}/${name}@native.webp`, encoding: 'webp-lossless', sha256: fakeSha(digit) });

/** A splash still of two frames, `rest` and `wave`, whose motion master is the description a run left. */
function splashAsset(motion = {}) {
    return {
        type: 'still',
        key: 'splash',
        ratio: '1',
        frame: { mode: 'canvas' },
        grid: [10, 12],
        rings: null,
        frames: {
            rest: { master: 'fig/fig--rest.png', outputs: [output('fig--rest', '1')] },
            wave: { master: 'fig/fig--wave.png', outputs: [output('fig--wave', '2')] },
        },
        outputs: [{ ...output('fig', '3'), from: 'rest' }],
        motion: { master: 'fig/fig--motion.json', output: `${SHIP}/fig--anim.json`, layer: 'fig', cell: 2.5, sha256: fakeSha('4'), ...motion },
    };
}

function splashRun(changes = {}) {
    return {
        format: 1,
        kind: 'splash-loop',
        recipe: 'fig-loop',
        base: 'rest',
        frames: { rest: { file: 'fig--rest.png' }, wave: { file: 'fig--wave.png' } },
        timeline: {
            seconds: 2,
            keys: [{ at: 0, frame: 'rest' }, { at: 0.5, frame: 'wave' }, { at: 1.5, frame: 'rest' }],
            effects: [{ kind: 'rings', frames: ['wave'], x: 7, y: 2 }],
        },
        blink: { steps: [{ eyes: 'half', ms: 70 }, { eyes: 'closed', ms: 110 }], gapMs: { min: 4000, max: 5000 }, never: ['wave'] },
        ...changes,
    };
}

async function splashRepo(t, { asset = splashAsset(), run = splashRun() } = {}) {
    const root = await fixtureRepo(t, {
        'assets-src/art/master/fig/fig--rest.png': block(10, 12, [2, 2, 6, 8]),
        'assets-src/art/master/fig/fig--wave.png': block(10, 12, [2, 1, 7, 9]),
        'assets-src/art/master/fig/fig--motion.json': run,
    });
    writeFixtureManifest(root, { format: 1, encoder: encoderVersions(), assets: { fig: asset } });
    return root;
}

test('a splash run\'s description gives the player\'s description: the shipped names, the opening frame, each effect from its first key, and the blink', async (t) => {
    const root = await splashRepo(t);

    assert.deepEqual(codes(await runDerive({ root, write: true })), []);
    assert.deepEqual(JSON.parse(readFileSync(join(root, SHIP, 'fig--anim.json'), 'utf8')), {
        id: 'fig',
        grid: { cell: 2.5, width: 10, height: 12 },
        layers: [{ id: 'fig', z: 1, left: 0, top: 0, width: 10, height: 12, base: 'rest', frames: { rest: 'fig--rest@native.webp', wave: 'fig--wave@native.webp' } }],
        timelines: {
            fig: {
                seconds: 2,
                keys: [{ at: 0, frame: 'rest' }, { at: 0.5, frame: 'wave' }, { at: 1.5, frame: 'rest' }],
                effects: [{ kind: 'rings', frames: ['wave'], from: 0.5, x: 7, y: 2 }],
            },
        },
        blinks: { steps: [{ variant: 'half', ms: 70 }, { variant: 'closed', ms: 110 }], gapMs: [4000, 5000], never: { fig: ['wave'] } },
    });
    assert.deepEqual(codes(await runProve({ root })), []);
});

test('a splash description with no blink, cell or layer leaves the blinks and the cell out and names its layer after the asset', async (t) => {
    const asset = splashAsset();
    delete asset.motion.layer;
    delete asset.motion.cell;
    const root = await splashRepo(t, { asset, run: splashRun({ blink: null }) });

    assert.deepEqual(codes(await runDerive({ root, write: true })), []);
    const built = JSON.parse(readFileSync(join(root, SHIP, 'fig--anim.json'), 'utf8'));
    assert.deepEqual(built.grid, { width: 10, height: 12 });
    assert.equal(built.layers[0].id, 'fig');
    assert.deepEqual(Object.keys(built.timelines), ['fig']);
    assert.equal('blinks' in built, false);
});

test('the derive builds each shipped splash description from the run\'s form of it, byte for byte', async (t) => {
    const root = copyOfArt(t);
    const { manifest } = readManifest(root);
    const splashes = Object.entries(manifest.assets).filter(([, asset]) => asset.key === 'splash' && asset.motion);
    assert.equal(splashes.length, 3);
    for (const [id, asset] of splashes) {
        const anim = JSON.parse(readFileSync(join(root, MASTER_ROOT, asset.motion.master), 'utf8'));
        const [layer] = anim.layers;
        const timeline = anim.timelines[layer.id];
        const master = asset.motion.master.replace(/--anim\.json$/, '--motion.json');
        writeFileSync(join(root, MASTER_ROOT, master), `${JSON.stringify({
            format: 1,
            kind: 'splash-loop',
            recipe: id,
            base: layer.base,
            frames: Object.fromEntries(Object.entries(asset.frames).map(([name, frame]) => [name, { file: posix.basename(frame.master) }])),
            timeline: { seconds: timeline.seconds, keys: timeline.keys, effects: timeline.effects.map(({ kind, frames, x, y }) => ({ kind, frames, x, y })) },
            blink: { steps: anim.blinks.steps.map(({ variant, ms }) => ({ eyes: variant, ms })), gapMs: { min: anim.blinks.gapMs[0], max: anim.blinks.gapMs[1] }, never: anim.blinks.never[layer.id] ?? [] },
        }, null, 4)}\n`);
        asset.motion = { master, output: asset.motion.output, layer: layer.id, cell: anim.grid.cell, sha256: asset.motion.sha256 };
    }
    writeFixtureManifest(root, manifest);

    const run = await runProve({ root, only: splashes.map(([id]) => id) });

    assert.deepEqual(run.result.problems, []);
    for (const [, asset] of splashes) {
        assert.deepEqual(readFileSync(join(root, asset.motion.output)), readFileSync(join(REPO_ROOT, asset.motion.output)));
    }
});

test('a splash run\'s description that does not fit its still, or that the derive cannot read, writes nothing', async (t) => {
    const cases = [
        ['motion-mismatch', { run: splashRun({ frames: { rest: { file: 'fig--rest.png' } } }) }],
        ['motion-mismatch', { run: splashRun({ frames: { rest: { file: 'fig--rest.png' }, wave: { file: 'fig--other.png' } } }) }],
        ['motion-mismatch', { run: splashRun({ timeline: { ...splashRun().timeline, keys: [{ at: 0, frame: 'wave' }, { at: 1, frame: 'rest' }] } }) }],
        ['motion-invalid', { run: splashRun({ timeline: { ...splashRun().timeline, effects: [{ frames: ['wave'], x: 7, y: 2 }] } }) }],
        ['motion-invalid', { run: splashRun({ timeline: { ...splashRun().timeline, keys: [{ at: 0.5, frame: 'rest' }] } }) }],
        ['motion-invalid', { run: splashRun({ blink: { ...splashRun().blink, never: ['jump'] } }) }],
        ['motion-invalid', { run: splashRun({ base: 'jump' }) }],
        ['motion-invalid', { run: splashRun({ format: 2 }) }],
        ['motion-invalid', { asset: { ...splashAsset(), ratio: '1/2', grid: [20, 24] } }],
    ];
    for (const [code, setup] of cases) {
        const root = await splashRepo(t, setup);
        const run = await runDerive({ root, write: true });
        assert.deepEqual(codes(run), [code], JSON.stringify(setup));
        assert.deepEqual(readManifest(root).manifest.assets.fig.outputs[0].sha256, fakeSha('3'));
    }
});

test('the manifest takes a splash layer id and a cell on a motion description, and refuses other values', () => {
    const manifestWith = (motion) => ({ format: 1, encoder: encoderVersions(), assets: { fig: splashAsset(motion) } });

    assert.deepEqual(validateManifest(manifestWith({})), []);
    assert.deepEqual(validateManifest(manifestWith({ layer: 'Fig' })).map(({ code }) => code), ['manifest-invalid']);
    assert.deepEqual(validateManifest(manifestWith({ cell: 0 })).map(({ code }) => code), ['manifest-invalid']);
    assert.deepEqual(validateManifest(manifestWith({ cell: '2.5' })).map(({ code }) => code), ['manifest-invalid']);
});

const GROUND = [30, 30, 90, 255];
const SKIN = [240, 200, 180, 255];
const SHUT = [90, 40, 40, 255];

/**
 * A scene of one figure on a ground line, framed by its subject with a margin of 1, so the still starts at 1,2 of the
 * master and the figure's box in the still is 3,1,3,4. The figure has a breath pose and a half-closed blink in each pose.
 */
function sceneAsset(changes = {}) {
    const picture = (name, digit) => ({ master: `duo/duo--fig--${name}.png`, outputs: [output(`duo--fig--${name}`, digit)] });
    return {
        type: 'scene',
        key: 'home',
        master: 'duo/duo.png',
        ratio: '1',
        frame: { mode: 'subject', margin: 1 },
        grid: [10, 7],
        outputs: [output('duo', '1')],
        backdrop: { master: 'duo/duo--backdrop.png', outputs: [output('duo--backdrop', '2')] },
        layers: { fig: { box: [3, 1, 3, 4], pictures: { 'breath-c': picture('breath-c', '3'), 'breath-c-half': picture('breath-c-half', '4'), 'breath-b': picture('breath-b', '5'), 'breath-b-half': picture('breath-b-half', '6') } } },
        compose: { pose: 'breath-c' },
        motion: { master: 'duo/duo--motion.json', output: `${SHIP}/duo--breath.json`, cell: 2.75, sha256: fakeSha('7') },
        ...changes,
    };
}

function sceneRun(breath = {}) {
    return {
        format: 1,
        kind: 'motion-frames',
        recipe: 'duo-idle',
        frames: { 'fig-half': { file: 'duo--fig-half.png', layer: 'fig', eyes: 'half' } },
        blink: { steps: [{ eyes: 'half', ms: 90 }], gapMs: { min: 3600, max: 5400 } },
        breath: {
            scene: 'duo',
            grid: { cell: 1, width: 12, height: 9 },
            rhythm: { cycleSeconds: 3.5, breathsPerCycle: 2 },
            poses: ['c', 'b'],
            backdrop: 'duo--backdrop.png',
            layers: [{
                id: 'fig',
                z: 3,
                left: 4,
                top: 3,
                width: 3,
                height: 4,
                waist: 2,
                images: { c: { base: 'duo--fig--breath-c.png', half: 'duo--fig--breath-c-half.png' }, b: { base: 'duo--fig--breath-b.png', half: 'duo--fig--breath-b-half.png' } },
            }],
            ...breath,
        },
    };
}

async function sceneRepo(t, { asset = sceneAsset(), run = sceneRun() } = {}) {
    const ground = (x, y) => y === 7 && x >= 2 && x < 10;
    const figure = (x, y) => x >= 4 && x < 7 && y >= 3 && y < 7;
    const root = await fixtureRepo(t, {
        'assets-src/art/master/duo/duo.png': paint(12, 9, (x, y) => (figure(x, y) ? SKIN : ground(x, y) ? GROUND : CLEAR)),
        'assets-src/art/master/duo/duo--backdrop.png': paint(12, 9, (x, y) => (ground(x, y) ? GROUND : CLEAR)),
        'assets-src/art/master/duo/duo--fig--breath-c.png': paint(3, 4, () => SKIN),
        'assets-src/art/master/duo/duo--fig--breath-c-half.png': paint(3, 4, (x, y) => (y === 1 ? SHUT : SKIN)),
        'assets-src/art/master/duo/duo--fig--breath-b.png': paint(3, 4, (x, y) => (y === 0 ? CLEAR : SKIN)),
        'assets-src/art/master/duo/duo--fig--breath-b-half.png': paint(3, 4, (x, y) => (y === 0 ? CLEAR : y === 2 ? SHUT : SKIN)),
        'assets-src/art/master/duo/duo--motion.json': run,
    });
    writeFixtureManifest(root, { format: 1, encoder: encoderVersions(), assets: { duo: asset } });
    return root;
}

test('a breath run\'s description of a scene gives the breath player\'s description, with each layer at its box in the still', async (t) => {
    const root = await sceneRepo(t);

    assert.deepEqual(codes(await runDerive({ root, write: true })), []);
    assert.deepEqual(JSON.parse(readFileSync(join(root, SHIP, 'duo--breath.json'), 'utf8')), {
        scene: 'duo',
        grid: { cell: 2.75, width: 10, height: 7 },
        rhythm: { cycleSeconds: 3.5, breathsPerCycle: 2 },
        poses: ['c', 'b'],
        backdrop: 'duo--backdrop@native.webp',
        layers: [{
            id: 'fig',
            z: 3,
            left: 3,
            top: 1,
            width: 3,
            height: 4,
            waist: 2,
            images: { c: { base: 'duo--fig--breath-c@native.webp', half: 'duo--fig--breath-c-half@native.webp' }, b: { base: 'duo--fig--breath-b@native.webp', half: 'duo--fig--breath-b-half@native.webp' } },
        }],
        blinks: { steps: [{ variant: 'half', ms: 90 }], gapMs: [3600, 5400] },
    });
    assert.deepEqual(codes(await runProve({ root })), []);
});

test('a breath run\'s description of a still makes the still and its blink frames the pose c and counts the waist in the still\'s rows', async (t) => {
    const asset = {
        type: 'still',
        key: 'home',
        master: 'fig/fig.png',
        ratio: '1',
        frame: { mode: 'subject', margin: 2 },
        grid: [10, 12],
        rings: null,
        outputs: [output('fig', '1')],
        frames: {
            'breath-b': { master: 'fig/fig--breath-b.png', outputs: [output('fig--breath-b', '2')] },
            'blink-half': { master: 'fig/fig--blink-half.png', outputs: [output('fig--blink-half', '3')] },
        },
        motion: { master: 'fig/fig--motion.json', output: `${SHIP}/fig--breath.json`, sha256: fakeSha('4') },
    };
    const run = {
        format: 1,
        kind: 'motion-frames',
        recipe: 'fig-idle',
        frames: { 'blink-half': { file: 'fig--blink-half.png', eyes: 'half' } },
        blink: null,
        breath: { still: 'fig', rhythm: { cycleSeconds: 3, breathsPerCycle: 1 }, poses: ['c', 'b'], waist: 7, images: { b: { base: 'fig--breath-b.png' } } },
    };
    const root = await fixtureRepo(t, {
        'assets-src/art/master/fig/fig.png': block(10, 14, [2, 3, 6, 8]),
        'assets-src/art/master/fig/fig--breath-b.png': block(10, 14, [2, 4, 6, 7]),
        'assets-src/art/master/fig/fig--blink-half.png': paint(10, 14, (x, y) => (y === 5 && x >= 3 && x < 7 ? SHUT : x >= 2 && x < 8 && y >= 3 && y < 11 ? ART : CLEAR)),
        'assets-src/art/master/fig/fig--motion.json': run,
    });
    writeFixtureManifest(root, { format: 1, encoder: encoderVersions(), assets: { fig: asset } });

    assert.deepEqual(codes(await runDerive({ root, write: true })), []);
    assert.deepEqual(JSON.parse(readFileSync(join(root, SHIP, 'fig--breath.json'), 'utf8')), {
        scene: 'fig',
        grid: { width: 10, height: 12 },
        rhythm: { cycleSeconds: 3, breathsPerCycle: 1 },
        poses: ['c', 'b'],
        backdrop: null,
        layers: [{ id: 'fig', z: 0, left: 0, top: 0, width: 10, height: 12, waist: 6, images: { c: { base: 'fig@native.webp', half: 'fig--blink-half@native.webp' }, b: { base: 'fig--breath-b@native.webp' } } }],
    });
});

test('the derive builds each shipped breath description from the run\'s form of it, byte for byte', async (t) => {
    const root = copyOfArt(t);
    const { manifest } = readManifest(root);
    const breathing = Object.entries(manifest.assets).filter(([, asset]) => asset.key === 'home' && asset.motion);
    assert.equal(breathing.length, 5);
    const masterOf = (pictures, name) => posix.basename(Object.values(pictures).find(({ outputs }) => posix.basename(outputs[0].path) === name).master);
    const states = (images, pictures) => Object.fromEntries(Object.entries(images).map(([state, name]) => [state, masterOf(pictures, name)]));
    for (const [id, asset] of breathing) {
        const shipped = JSON.parse(readFileSync(join(root, MASTER_ROOT, asset.motion.master), 'utf8'));
        const master = await readRaster(join(root, MASTER_ROOT, asset.master));
        const origin = frameBox(master, asset.frame);
        const breath = asset.type === 'scene'
            ? {
                scene: id,
                grid: { cell: 1, width: master.width, height: master.height },
                rhythm: shipped.rhythm,
                poses: shipped.poses,
                backdrop: shipped.backdrop && masterOf({ backdrop: asset.backdrop }, shipped.backdrop),
                layers: shipped.layers.map(({ id: layer, z, left, top, width, height, waist, images }) => ({
                    id: layer,
                    z,
                    left: left + origin.x,
                    top: top + origin.y,
                    width,
                    height,
                    waist,
                    images: { c: states(images.c, asset.layers[layer].pictures), b: states(images.b, asset.layers[layer].pictures) },
                })),
            }
            : { still: id, rhythm: shipped.rhythm, poses: shipped.poses, waist: shipped.layers[0].waist + origin.y, images: { b: states(shipped.layers[0].images.b, asset.frames) } };
        const run = {
            format: 1,
            kind: 'motion-frames',
            recipe: `${id}-idle`,
            frames: {},
            blink: { steps: shipped.blinks.steps.map(({ variant, ms }) => ({ eyes: variant, ms })), gapMs: { min: shipped.blinks.gapMs[0], max: shipped.blinks.gapMs[1] } },
            breath,
        };
        const motionMaster = asset.motion.master.replace(/--breath\.json$/, '--motion.json');
        writeFileSync(join(root, MASTER_ROOT, motionMaster), `${JSON.stringify(run, null, 4)}\n`);
        asset.motion = { master: motionMaster, output: asset.motion.output, cell: shipped.grid.cell, sha256: asset.motion.sha256 };
    }
    writeFixtureManifest(root, manifest);

    const run = await runProve({ root, only: breathing.map(([id]) => id) });

    assert.deepEqual(run.result.problems, []);
    for (const [, asset] of breathing) {
        assert.deepEqual(readFileSync(join(root, asset.motion.output)), readFileSync(join(REPO_ROOT, asset.motion.output)));
    }
});

test('a breath run\'s description that does not fit its scene, or gives no breath, writes nothing', async (t) => {
    const [layer] = sceneRun().breath.layers;
    const cases = [
        ['motion-mismatch', { run: sceneRun({ layers: [{ ...layer, left: 5 }] }) }],
        ['motion-mismatch', { run: sceneRun({ layers: [{ ...layer, id: 'other' }] }) }],
        ['motion-mismatch', { run: sceneRun({ layers: [{ ...layer, images: { ...layer.images, b: { base: 'duo--fig--breath-x.png' } } }] }) }],
        ['motion-mismatch', { run: sceneRun({ layers: [{ ...layer, images: { ...layer.images, b: { base: 'duo--fig--breath-b.png' } } }] }) }],
        ['motion-mismatch', { run: sceneRun({ backdrop: null }) }],
        ['motion-mismatch', { run: sceneRun({ grid: { cell: 1, width: 11, height: 9 } }) }],
        ['motion-invalid', { run: { ...sceneRun(), breath: null } }],
        ['motion-invalid', { run: { ...sceneRun(), blink: { ...sceneRun().blink, never: ['fig-half'] } } }],
    ];
    for (const [code, setup] of cases) {
        const root = await sceneRepo(t, setup);
        assert.deepEqual(codes(await runDerive({ root, write: true })), [code], JSON.stringify(setup.run));
        assert.equal(readManifest(root).manifest.assets.duo.motion.sha256, fakeSha('7'));
    }
});
