import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decode, encoderVersions } from '../lib/codec.js';
import { runDerive, runProve } from '../lib/commands.js';
import { fitToGrid } from '../lib/fit.js';
import { frameBox, renderFrame } from '../lib/frame.js';
import { parseRatio, readManifest } from '../lib/manifest.js';
import { paste, samePixels } from '../lib/raster.js';
import { fakeSha } from '../test-support/manifests.js';
import { paint } from '../test-support/pictures.js';
import { fixtureRepo, writeFixtureManifest } from '../test-support/repos.js';

const CLEAR = [0, 0, 0, 0];
const ART = [200, 120, 220, 255];
const SHIP = 'public/img/sillybunny';
const RATIOS = Object.freeze(['3/2', '5/3', '2']);

const codes = (run) => run.result.problems.map(({ code }) => code);
const output = (name, digit) => ({ path: `${SHIP}/${name}@native.webp`, encoding: 'webp-lossless', sha256: fakeSha(digit) });

/** The master pixels that a placement grid of `grid` pixels takes at `ratio`. */
const masterSize = (grid, ratio) => {
    const { p, q } = parseRatio(ratio);
    return [Math.ceil((grid[0] * p) / q), Math.ceil((grid[1] * p) / q)];
};

/** A picture of `box` in placement pixels, drawn on the master canvas of a ratio, so that each placement pixel owns whole master pixels. */
const figureAt = (ratio, grid, [x, y, w, h], extra = () => null) => {
    const { p, q } = parseRatio(ratio);
    const [width, height] = masterSize(grid, ratio);
    const inBox = (px, py) => px >= Math.floor((x * p) / q) && px < Math.floor(((x + w) * p) / q) && py >= Math.floor((y * p) / q) && py < Math.floor(((y + h) * p) / q);
    return paint(width, height, (px, py) => extra(px, py) ?? (inBox(px, py) ? ART : CLEAR));
};

const splashRun = () => ({
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
    blink: null,
});

/** Where the effect at master pixel 7, 2 lies on the placement grid at each ratio: the cell that holds the centre of that pixel. */
const EFFECT_CELL = Object.freeze({ '3/2': [5, 1], '5/3': [4, 1], 2: [3, 1] });

for (const ratio of RATIOS) {
    test(`a splash loop at the ratio ${ratio} ships each frame as the fit of its master and puts its effects in the cells of the master pixels`, async (t) => {
        const grid = [10, 12];
        const rest = figureAt(ratio, grid, [2, 2, 6, 8]);
        const wave = figureAt(ratio, grid, [2, 1, 7, 9]);
        const root = await fixtureRepo(t, { 'assets-src/art/master/fig/fig--rest.png': rest, 'assets-src/art/master/fig/fig--wave.png': wave, 'assets-src/art/master/fig/fig--motion.json': splashRun() });
        writeFixtureManifest(root, {
            format: 1,
            encoder: encoderVersions(),
            assets: {
                fig: {
                    type: 'still',
                    key: 'splash',
                    ratio,
                    frame: { mode: 'canvas' },
                    grid,
                    rings: null,
                    frames: { rest: { master: 'fig/fig--rest.png', outputs: [output('fig--rest', '1')] }, wave: { master: 'fig/fig--wave.png', outputs: [output('fig--wave', '2')] } },
                    outputs: [{ ...output('fig', '3'), from: 'rest' }],
                    motion: { master: 'fig/fig--motion.json', output: `${SHIP}/fig--anim.json`, layer: 'fig', cell: 2.5, sha256: fakeSha('4') },
                },
            },
        });

        assert.deepEqual(codes(await runDerive({ root, write: true })), []);

        const description = JSON.parse(readFileSync(join(root, SHIP, 'fig--anim.json'), 'utf8'));
        assert.deepEqual(description.layers[0], { id: 'fig', z: 1, left: 0, top: 0, width: 10, height: 12, base: 'rest', frames: { rest: 'fig--rest@native.webp', wave: 'fig--wave@native.webp' } });
        assert.deepEqual(description.timelines.fig.effects.map(({ x, y }) => [x, y]), [EFFECT_CELL[ratio]]);
        for (const [name, master] of [['rest', rest], ['wave', wave]]) {
            const shipped = await decode(readFileSync(join(root, SHIP, `fig--${name}@native.webp`)));
            assert.ok(samePixels(shipped, fitToGrid(master, parseRatio(ratio))), `${name} is the fit of its master`);
        }
        assert.deepEqual(codes(await runProve({ root })), []);
    });
}

for (const ratio of RATIOS) {
    test(`a breath still at the ratio ${ratio} counts its waist in the rows of the placement grid, below the top of its frame`, async (t) => {
        const still = figureAt(ratio, [10, 16], [2, 3, 6, 10]);
        const breath = figureAt(ratio, [10, 16], [2, 4, 6, 9]);
        const root = await fixtureRepo(t, {
            'assets-src/art/master/fig/fig.png': still,
            'assets-src/art/master/fig/fig--breath-b.png': breath,
            'assets-src/art/master/fig/fig--motion.json': {
                format: 1,
                kind: 'motion-frames',
                recipe: 'fig-idle',
                frames: {},
                blink: null,
                breath: { still: 'fig', rhythm: { cycleSeconds: 3, breathsPerCycle: 1 }, poses: ['c', 'b'], waist: Math.floor((9 * parseRatio(ratio).p) / parseRatio(ratio).q), images: { b: { base: 'fig--breath-b.png' } } },
            },
        });
        writeFixtureManifest(root, {
            format: 1,
            encoder: encoderVersions(),
            assets: {
                fig: {
                    type: 'still',
                    key: 'home',
                    master: 'fig/fig.png',
                    ratio,
                    frame: { mode: 'subject', margin: 1 },
                    grid: [8, 12],
                    rings: null,
                    outputs: [output('fig', '1')],
                    frames: { 'breath-b': { master: 'fig/fig--breath-b.png', outputs: [output('fig--breath-b', '2')] } },
                    motion: { master: 'fig/fig--motion.json', output: `${SHIP}/fig--breath.json`, sha256: fakeSha('4') },
                },
            },
        });

        assert.deepEqual(codes(await runDerive({ root, write: true })), []);

        const description = JSON.parse(readFileSync(join(root, SHIP, 'fig--breath.json'), 'utf8'));
        // The figure's top row is placement row 3 and the frame starts one row above it, so the waist at placement row 9 is row 7 of the still.
        assert.deepEqual({ ...description.layers[0], images: undefined }, { id: 'fig', z: 0, left: 0, top: 0, width: 8, height: 12, waist: 7, images: undefined });
        assert.deepEqual(codes(await runProve({ root })), []);
    });
}

const GROUND = [30, 30, 90, 255];
const SKIN = [240, 200, 180, 255];
const COAT = [60, 160, 90, 255];
const SHUT = [90, 40, 40, 255];
const STATES = Object.freeze(['breath-c', 'breath-c-half', 'breath-b', 'breath-b-half']);

/**
 * A scene of two figures on a ground line, drawn on a master canvas for `ratio`. The figures stand at whole master
 * pixels that are not on cell borders, and the second figure, which is drawn over the first, shares cells with it. A
 * figure has four pictures: the pose c and the pose b, each with and without a shut eye row.
 */
function fittedScene(ratio) {
    const { p, q } = parseRatio(ratio);
    const at = (unit) => Math.floor((unit * p) / q) + 1;
    const [width, height] = masterSize([20, 20], ratio);
    const rects = { first: [at(3), at(2), at(9) - at(3), at(14) - at(2)], second: [at(8), at(4), at(13) - at(8), at(14) - at(4)] };
    const colours = { first: SKIN, second: COAT };
    const picture = (layer, state) => {
        const [, , w, h] = rects[layer];
        return paint(w, h, (x, y) => {
            const lifted = state.startsWith('breath-b') && y === 0;
            const shut = state.endsWith('-half') && y === 3;
            return lifted ? CLEAR : shut ? SHUT : colours[layer];
        });
    };
    const ground = paint(width, height, (x, y) => (y === height - 2 && x >= 1 ? GROUND : CLEAR));
    const master = paint(width, height, () => CLEAR);
    paste(master, ground, 0, 0);
    for (const layer of ['first', 'second']) {
        paste(master, picture(layer, 'breath-c'), rects[layer][0], rects[layer][1]);
    }
    return { master, ground, rects, picture };
}

/** What the player lays over the backdrop for one picture of each figure, at the boxes the derive recorded. */
const composeShipped = (backdrop, layers) => {
    const canvas = { ...backdrop, data: Buffer.from(backdrop.data) };
    for (const { picture, box } of layers) {
        paste(canvas, picture, box[0], box[1]);
    }
    return canvas;
};

/** A scratch checkout of the scene of `fittedScene`, whose layer boxes are still the placeholder that the derive replaces. */
async function sceneRepo(t, ratio, { change = () => undefined } = {}) {
    const { master, ground, rects, picture } = fittedScene(ratio);
    const parsed = parseRatio(ratio);
    const placedMaster = fitToGrid(master, parsed);
    const framing = frameBox(placedMaster, { mode: 'subject', margin: 1 });
    const grid = [framing.width, framing.height];
    const files = {
        'assets-src/art/master/duo/duo.png': master,
        'assets-src/art/master/duo/duo--backdrop.png': ground,
    };
    const pictures = (layer, digit) => Object.fromEntries(STATES.map((state, at) => {
        files[`assets-src/art/master/duo/duo--${layer}--${state}.png`] = picture(layer, state);
        return [state, { master: `duo/duo--${layer}--${state}.png`, outputs: [output(`duo--${layer}--${state}`, String(digit + at))] }];
    }));
    const layers = { first: { box: [0, 0, 1, 1], pictures: pictures('first', 1) }, second: { box: [0, 0, 1, 1], pictures: pictures('second', 5) } };
    const states = (layer) => ({ c: { base: `duo--${layer}--breath-c.png`, half: `duo--${layer}--breath-c-half.png` }, b: { base: `duo--${layer}--breath-b.png`, half: `duo--${layer}--breath-b-half.png` } });
    files['assets-src/art/master/duo/duo--motion.json'] = {
        format: 1,
        kind: 'motion-frames',
        recipe: 'duo-idle',
        frames: {},
        blink: { steps: [{ eyes: 'half', ms: 90 }], gapMs: { min: 3600, max: 5400 } },
        breath: {
            scene: 'duo',
            grid: { cell: 1, width: master.width, height: master.height },
            rhythm: { cycleSeconds: 3.5, breathsPerCycle: 2 },
            poses: ['c', 'b'],
            backdrop: 'duo--backdrop.png',
            layers: ['first', 'second'].map((id, at) => ({ id, z: 3 + at, left: rects[id][0], top: rects[id][1], width: rects[id][2], height: rects[id][3], waist: 6, images: states(id) })),
        },
    };
    const manifest = {
        format: 1,
        encoder: encoderVersions(),
        assets: {
            duo: {
                type: 'scene',
                key: 'home',
                master: 'duo/duo.png',
                ratio,
                frame: { mode: 'subject', margin: 1 },
                grid,
                outputs: [output('duo', '0')],
                backdrop: { master: 'duo/duo--backdrop.png', outputs: [output('duo--backdrop', '9')] },
                layers,
                compose: { pose: 'breath-c' },
                motion: { master: 'duo/duo--motion.json', output: `${SHIP}/duo--breath.json`, cell: 2.5, sha256: fakeSha('a') },
            },
        },
    };
    change(files, manifest);
    const root = await fixtureRepo(t, files);
    writeFixtureManifest(root, manifest);
    return { root, master, ground, rects, picture, parsed, placedMaster, framing };
}

for (const ratio of RATIOS) {
    test(`a scene at the ratio ${ratio} ships layer pictures that, laid over the backdrop in any combination, give the fit of the whole frame`, async (t) => {
        const { root, ground, rects, picture, parsed, placedMaster, framing } = await sceneRepo(t, ratio);

        assert.deepEqual(codes(await runDerive({ root, write: true })), []);
        assert.deepEqual(codes(await runProve({ root })), []);

        const recorded = readManifest(root).manifest.assets.duo;
        const read = async (name) => decode(readFileSync(join(root, SHIP, `${name}@native.webp`)));
        const backdrop = await read('duo--backdrop');
        const shipped = Object.fromEntries(await Promise.all(['first', 'second'].map(async (layer) => [layer, Object.fromEntries(await Promise.all(STATES.map(async (state) => [state, await read(`duo--${layer}--${state}`)])))])));
        for (const layer of ['first', 'second']) {
            const { box } = recorded.layers[layer];
            for (const state of STATES) {
                assert.deepEqual([shipped[layer][state].width, shipped[layer][state].height], [box[2], box[3]], `${layer} ${state} has the size of its box`);
            }
        }
        let combinations = 0;
        for (const one of STATES) {
            for (const two of STATES) {
                const wholeFrame = fitToGrid(composeOnMaster(ground, rects, picture, { first: one, second: two }), parsed);
                const expected = renderFrame(wholeFrame, framing);
                const laid = composeShipped(backdrop, [{ picture: shipped.first[one], box: recorded.layers.first.box }, { picture: shipped.second[two], box: recorded.layers.second.box }]);
                assert.ok(samePixels(laid, expected), `${one} and ${two}`);
                combinations++;
            }
        }
        assert.equal(combinations, 16);
        assert.ok(samePixels(await read('duo'), renderFrame(placedMaster, framing)), 'the still is the fit of the master');

        const description = JSON.parse(readFileSync(join(root, SHIP, 'duo--breath.json'), 'utf8'));
        assert.deepEqual(description.layers.map(({ id, left, top, width, height }) => ({ id, box: [left, top, width, height] })), ['first', 'second'].map((id) => ({ id, box: recorded.layers[id].box })));
    });
}

function composeOnMaster(ground, rects, picture, chosen) {
    const canvas = { ...ground, data: Buffer.from(ground.data) };
    for (const layer of ['first', 'second']) {
        paste(canvas, picture(layer, chosen[layer]), rects[layer][0], rects[layer][1]);
    }
    return canvas;
}

test('a scene at a fit reports a layer box that the derive measured otherwise, and prove refuses it until derive --write records it', async (t) => {
    const { root } = await sceneRepo(t, '3/2');

    const dry = await runDerive({ root });
    assert.deepEqual(dry.result.layerBoxesStale.map(({ layer }) => layer), ['first', 'second']);
    const refused = codes(await runProve({ root }));
    assert.deepEqual(refused.slice(0, 2), ['manifest-stale', 'manifest-stale']);
    assert.deepEqual([...new Set(refused.slice(2))], ['output-missing']);

    assert.deepEqual(codes(await runDerive({ root, write: true })), []);
    assert.equal('layerBoxesStale' in (await runDerive({ root })).result, false);
    assert.deepEqual(codes(await runProve({ root })), []);
});

test('a scene at a fit refuses a player\'s own description, a layer that shows nothing of its own, and a picture of the wrong size', async (t) => {
    const cases = [
        ['motion-invalid', (files) => {
            files['assets-src/art/master/duo/duo--motion.json'] = { scene: 'duo', grid: { width: 1, height: 1 }, layers: [] };
        }],
        ['layer-empty', (files, manifest) => {
            const { first } = manifest.assets.duo.layers;
            for (const name of STATES) {
                files[first.pictures[name].master.replace(/^/, 'assets-src/art/master/')] = paint(files['assets-src/art/master/duo/duo--first--breath-c.png'].width, files['assets-src/art/master/duo/duo--first--breath-c.png'].height, () => CLEAR);
            }
            files['assets-src/art/master/duo/duo.png'] = paint(files['assets-src/art/master/duo/duo.png'].width, files['assets-src/art/master/duo/duo.png'].height, () => CLEAR);
            paste(files['assets-src/art/master/duo/duo.png'], files['assets-src/art/master/duo/duo--backdrop.png'], 0, 0);
            const second = files['assets-src/art/master/duo/duo--second--breath-c.png'];
            const run = files['assets-src/art/master/duo/duo--motion.json'];
            paste(files['assets-src/art/master/duo/duo.png'], second, run.breath.layers[1].left, run.breath.layers[1].top);
        }],
        ['grid-mismatch', (files) => {
            files['assets-src/art/master/duo/duo--second--breath-b.png'] = paint(3, 3, () => SKIN);
        }],
    ];
    for (const [code, change] of cases) {
        const { root } = await sceneRepo(t, '3/2', { change });
        assert.deepEqual(codes(await runDerive({ root, write: true })), [code]);
    }
});
