import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decode, encoderVersions } from '../lib/codec.js';
import { runDerive, runProve } from '../lib/commands.js';
import { fitToGrid } from '../lib/fit.js';
import { parseRatio } from '../lib/manifest.js';
import { samePixels } from '../lib/raster.js';
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
