import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { encoderVersions } from '../lib/codec.js';
import { runDerive, runProve } from '../lib/commands.js';
import { MASTER_ROOT, readManifest, validateManifest } from '../lib/manifest.js';
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
