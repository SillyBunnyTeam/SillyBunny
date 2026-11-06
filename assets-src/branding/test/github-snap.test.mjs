import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadArt } from '../scripts/lib/github-art.mjs';
import { loadGithubConfig } from '../scripts/lib/github-run.mjs';
import { loadScenes, snapScene } from '../scripts/lib/github-snap-run.mjs';
import { scenesSheet } from '../scripts/lib/github-sheets.mjs';
import { readRaster, upscaleNearest, writeRaster } from '../scripts/lib/raster.mjs';
import { createRaster, getPixel } from '../test-support/synthetic.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const REAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLOW = { timeout: 120_000 };
const CELL = 4;
const RIM = [185, 155, 242];
const BAND = [255, 255, 255];
const BODIES = [[90, 60, 120], [110, 80, 140], [70, 50, 100], [130, 100, 160]];

/** A sticker in art pixels: a rounded body with a band of 2 and a rim of 2 round it, filled with a few flat colours so a grid can be read. */
function artSticker({ width = 60, height = 70, box = { x: 15, y: 12, width: 30, height: 40 }, extra } = {}) {
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
    extra?.(art);
    return art;
}

/** A package folder with the logo-free parts of snapping: the snap config, one scene file, and a master made by enlarging an art picture. */
async function workspace({ art, scene }) {
    const rootDir = tempDir('sb-github-snap-');
    copyFileSync(join(REAL_ROOT, 'snap-config.json'), join(rootDir, 'snap-config.json'));
    mkdirSync(join(rootDir, 'raw'), { recursive: true });
    await writeRaster(join(rootDir, 'raw', 'master.png'), upscaleNearest(art, CELL));
    writeFileSync(join(rootDir, 'github-scenes.json'), JSON.stringify({ scenes: { 'test-scene': { master: 'raw/master.png', cell: CELL, reisen: 'left', pose: 'mixed', ...scene } } }));
    return rootDir;
}

test('the scene list is checked: one way to size a scene, a side and a pose for the line-up, and no unknown keys', () => {
    const rootDir = tempDir('sb-github-scenes-');
    const write = (scene) => writeFileSync(join(rootDir, 'github-scenes.json'), JSON.stringify({ scenes: { one: scene } }));
    const good = { master: 'raw/a.png', cell: 3, reisen: 'left', pose: 'standing' };
    write(good);
    assert.deepEqual(Object.keys(loadScenes(rootDir)), ['one']);
    write({ master: 'raw/a.png', figureHeight: 372, reisen: 'left', pose: 'standing' });
    assert.equal(loadScenes(rootDir).one.figureHeight, 372, 'the height in art pixels that the whole sticker is to have');
    write({ ...good, bodyHeight: 340 });
    assert.throws(() => loadScenes(rootDir), /exactly one of "cell", "bodyHeight" .* and "figureHeight"/);
    write({ ...good, figureHeight: 372 });
    assert.throws(() => loadScenes(rootDir), /exactly one of "cell"/);
    write({ master: 'raw/a.png', reisen: 'left', pose: 'standing' });
    assert.throws(() => loadScenes(rootDir), /exactly one of "cell"/);
    write({ ...good, pose: 'flying' });
    assert.throws(() => loadScenes(rootDir), /needs "reisen" \(left or right\) and "pose"/);
    write({ ...good, extra: 1 });
    assert.throws(() => loadScenes(rootDir), /unknown key "extra"/);
    write({ ...good, repairs: [{ erase: { x: 0, y: 0, width: 1, height: 1 }, colour: 'red' }] });
    assert.throws(() => loadScenes(rootDir), /repair 0 has an unknown key "colour"/);
});

test('the scenes of the package are the art sources of the config, each with a master named', () => {
    const scenes = loadScenes(REAL_ROOT);
    const config = loadGithubConfig(REAL_ROOT);
    assert.deepEqual(Object.keys(scenes).sort(), Object.keys(config.sources.art).sort());
    for (const [name, scene] of Object.entries(scenes)) {
        assert.equal(config.sources.art[name], `approved/pixel/${name}.png`, 'the config reads the approved copy of what the snapper writes, under the same name');
        assert.match(scene.master, /^raw\/s8\//);
    }
});

test('a scene is snapped at its cell into out/github/snapped, with the rings 2+2, and nothing is logged', SLOW, async () => {
    const rootDir = await workspace({ art: artSticker() });
    const scenes = loadScenes(rootDir);
    const result = await snapScene({ rootDir, name: 'test-scene', scene: scenes['test-scene'] });
    assert.equal(result.cell, CELL);
    assert.equal(result.file, 'out/github/snapped/test-scene.png');
    assert.deepEqual(result.rings.measured, { rim: 2, band: 2 });
    assert.equal(result.problem, undefined);
    assert.equal(result.lineup.verdict, 'not comparable');
    assert.equal(existsSync(join(rootDir, 'log')), false, 'no log folder, so no log line');
    const art = await loadArt(join(rootDir, result.file));
    assert.deepEqual([art.width, art.height], [result.drawn.width, result.drawn.height]);
    assert.equal(art.width, 38, 'the 30 pixel body with its rings of 4 on each side');
    assert.equal(existsSync(join(rootDir, 'approved')), false, 'approved/ is not written');
});

test('a scene sized by its figure height is snapped at the cell that makes the whole sticker that many art pixels tall', SLOW, async () => {
    const rootDir = await workspace({ art: artSticker(), scene: { cell: undefined, figureHeight: 24 } });
    const result = await snapScene({ rootDir, name: 'test-scene', scene: loadScenes(rootDir)['test-scene'] });
    assert.equal(result.cellSource, 'figure-height');
    assert.ok(Math.abs(result.cell - (48 * CELL) / 24) < 0.01, `the cell is ${result.cell}: 48 art pixels of 4 master pixels in 24 pixels`);
    assert.ok(Math.abs(result.drawn.height - 24) <= 1, `the sticker is ${result.drawn.height} pixels tall`);
});

test('a repair box is carried to the cell of the snap from the cell it was measured at', SLOW, async () => {
    const withTab = artSticker({ width: 60, height: 70 });
    const rootDir = await workspace({ art: withTab, scene: { cell: undefined, figureHeight: 24, repairs: [{ erase: { x: 0, y: 30, width: 58, height: 10 }, cell: CELL }] } });
    const result = await snapScene({ rootDir, name: 'test-scene', scene: loadScenes(rootDir)['test-scene'] });
    const [box] = result.repaired[0].boxes;
    assert.deepEqual([box.x, box.y, box.width, box.height], [0, 15, 29, 5], 'half the size at half the cell');
});

test('a master with a sticker close to the edge is given a margin, so the snap does not read it as touching the edge', SLOW, async () => {
    const art = artSticker({ width: 50, height: 60, box: { x: 6, y: 5, width: 30, height: 40 } });
    const rootDir = await workspace({ art, scene: {} });
    const result = await snapScene({ rootDir, name: 'test-scene', scene: loadScenes(rootDir)['test-scene'] });
    assert.ok(Object.values(result.marginAdded).some((rows) => rows > 0), 'a margin was added');
    assert.equal(result.problem, undefined, 'and the sticker is whole in the snapped picture');
    assert.ok(result.margins.left >= 1 && result.margins.top >= 1);
});

test('a master cut only in the sticker rings is padded and snapped whole, and one cut through the drawing is refused', SLOW, async () => {
    // The body starts 2 rows down, so the band is whole in rows 0 and 1 and the rim above it is cut off by the picture's edge.
    const rootDir = await workspace({ art: artSticker({ box: { x: 15, y: 2, width: 30, height: 40 } }) });
    const result = await snapScene({ rootDir, name: 'test-scene', scene: loadScenes(rootDir)['test-scene'] });
    assert.ok(result.padded.some(({ edge }) => edge === 'top'), 'the top was padded');
    assert.equal(result.problem, undefined);
    assert.deepEqual(result.rings.measured, { rim: 2, band: 2 }, 'the rim is whole round the top');
    const snapped = await loadArt(join(rootDir, result.file));
    const middle = Math.floor(snapped.width / 2);
    assert.equal(snapped.data[(0 * snapped.width + middle) * 4 + 3], 255, 'the top row is the rim');
    assert.deepEqual([...snapped.data.subarray(middle * 4, middle * 4 + 3)], RIM);

    const drawingCut = artSticker({ box: { x: 15, y: -6, width: 30, height: 50 } });
    const refused = await workspace({ art: drawingCut });
    await assert.rejects(snapScene({ rootDir: refused, name: 'test-scene', scene: loadScenes(refused)['test-scene'] }), /clipped, and not only in the sticker's rings/);
});

test('a configured repair erases a box of the snapped picture and draws the rings whole along what is left, outside the box nothing changes', SLOW, async () => {
    const withTab = artSticker({ box: { x: 15, y: 12, width: 30, height: 40 } });
    const rootDir = await workspace({ art: withTab });
    const plain = await snapScene({ rootDir, name: 'test-scene', scene: loadScenes(rootDir)['test-scene'] });
    const erase = { x: 0, y: 30, width: plain.size.width, height: 20 };
    const repaired = await workspace({ art: withTab, scene: { repairs: [{ erase }] } });
    const result = await snapScene({ rootDir: repaired, name: 'test-scene', scene: loadScenes(repaired)['test-scene'] });
    assert.equal(result.repaired.length, 1);
    assert.ok(result.repaired[0].erased > 0);
    assert.deepEqual(result.rings.measured, { rim: 2, band: 2 });
    const after = await readRaster(join(repaired, result.file));
    for (let y = 0; y < plain.size.height; y++) {
        for (let x = 0; x < plain.size.width; x++) {
            if (y < erase.y || y >= erase.y + erase.height) {
                assert.deepEqual(getPixel(after, x, y), getPixel(plain.raster, x, y), `pixel ${x},${y} outside the box changed`);
            }
        }
    }
});

test('the sheet of snapped scenes shows each at 2x with the picture\'s own edge drawn', async () => {
    const scene = artSticker();
    const png = await scenesSheet([{ name: 'one', raster: scene, margins: { left: 1, top: 2, right: 3, bottom: 4 }, lineup: { ratio: 0.83, verdict: 'ok', comparable: true } }, { name: 'two', raster: scene, margins: { left: 5, top: 6, right: 7, bottom: 8 }, lineup: { ratio: 1.1, verdict: 'not comparable', comparable: false } }]);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(readFileSync(join(REAL_ROOT, 'scripts/lib/github-sheets.mjs'), 'utf8').includes('SCENE_ZOOM = 2'));
});
