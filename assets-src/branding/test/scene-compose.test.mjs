import assert from 'node:assert/strict';
import { test } from 'node:test';
import { srgbToOklab } from '../scripts/lib/pixel-colour.mjs';
import { createRaster, opaqueBox } from '../scripts/lib/raster.mjs';
import { TRIM_ALPHA, composeScene, over, resolveHeights } from '../scripts/lib/scene-compose.mjs';
import { parseLayout } from '../scripts/lib/scene-layout.mjs';
import { measureFigure } from '../scripts/lib/scene-measure.mjs';
import { figure } from '../test-support/figure.mjs';
import { createRaster as filled, getPixel, setPixel, upscale } from '../test-support/synthetic.mjs';

const RED = [220, 30, 30, 255];
const BLUE = [30, 30, 220, 255];

/** A transparent picture with one solid box in it, so trimming has something to do. */
function boxed(colour, { width = 100, height = 100, x = 30, y = 40, w = 40, h = 20 } = {}) {
    const raster = createRaster(width, height);
    for (let row = y; row < y + h; row++) {
        for (let column = x; column < x + w; column++) {
            setPixel(raster, column, row, colour);
        }
    }
    return raster;
}

const layout = (layers, canvas = { width: 1000, height: 600 }) => parseLayout({ canvas, layers });
const layer = (extra) => ({ id: 'a', image: 'a.png', z: 1, anchor: { x: 500, y: 300 }, height: 40, ...extra });

test('a picture is trimmed to its alpha box, scaled to the height and put on its centre anchor', async () => {
    const { raster, placements } = await composeScene(layout([layer()]), new Map([['a', boxed(RED)]]));
    assert.deepEqual(placements[0], { id: 'a', point: 0, left: 460, top: 280, width: 80, height: 40, scale: 2, measure: 'box', method: 'box', targetHeight: 40 });
    assert.deepEqual(getPixel(raster, 500, 300), RED);
    assert.equal(getPixel(raster, 458, 300)[3], 0);
    assert.equal(getPixel(raster, 500, 321)[3], 0);
    assert.deepEqual([raster.width, raster.height], [1000, 600]);
});

test('a bottom-centre anchor puts the feet on the anchor, and top-left puts the corner there', async () => {
    const feet = await composeScene(layout([layer({ at: 'bottom-centre', anchor: { x: 500, y: 590 } })]), new Map([['a', boxed(RED)]]));
    assert.equal(getPixel(feet.raster, 500, 589)[3], 255, 'the last row of the picture is on the row above the anchor');
    assert.equal(getPixel(feet.raster, 500, 590)[3], 0);
    const corner = await composeScene(layout([layer({ at: 'top-left', anchor: { x: 10, y: 20 } })]), new Map([['a', boxed(RED)]]));
    assert.deepEqual(getPixel(corner.raster, 10, 20), RED);
    assert.equal(getPixel(corner.raster, 9, 20)[3], 0);
});

test('layers are drawn in z order whatever order they are listed in, and a see-through edge shows what is behind', async () => {
    const layers = [layer({ id: 'front', z: 5, anchor: { x: 500, y: 300 } }), layer({ id: 'back', z: 1, anchor: { x: 520, y: 300 } })];
    const { raster } = await composeScene(layout(layers), new Map([['front', boxed(RED)], ['back', boxed(BLUE)]]));
    assert.deepEqual(getPixel(raster, 510, 300), RED, 'the front layer covers the overlap');
    assert.deepEqual(getPixel(raster, 550, 300), BLUE, 'the back one shows where nothing covers it');
    const half = createRaster(2, 1);
    setPixel(half, 0, 0, [255, 255, 255, 128]);
    const base = filled(2, 1, [0, 0, 255, 255]);
    over(base, half, 0, 0);
    assert.ok(getPixel(base, 0, 0)[0] > 120 && getPixel(base, 0, 0)[2] > 200 && getPixel(base, 0, 0)[3] === 255);
});

test('scaling is smooth, not nearest: a fractional scale leaves partly covered edge pixels', async () => {
    const picture = boxed(RED, { w: 41, h: 21 });
    for (let y = 48; y < 51; y++) {
        for (let x = 48; x < 53; x++) {
            setPixel(picture, x, y, [0, 0, 0, 0]);
        }
    }
    const { raster } = await composeScene(layout([layer({ height: 15, at: 'top-left', anchor: { x: 0, y: 0 } })]), new Map([['a', picture]]));
    const alphas = new Set();
    for (let x = 0; x < 29; x++) {
        alphas.add(getPixel(raster, x, 7)[3]);
    }
    assert.ok([...alphas].some((alpha) => alpha > 0 && alpha < 255), 'an edge pixel is part covered');
});

test('a height can be a ratio of another layer, and the ratio holds in the heights that are placed', async () => {
    const layers = [layer({ id: 'a', height: 100 }), layer({ id: 'b', height: { ratio: 0.8333, of: 'a' }, anchor: { x: 800, y: 300 } })];
    const { placements } = await composeScene(layout(layers), new Map([['a', boxed(RED)], ['b', boxed(BLUE)]]));
    assert.equal(placements[0].targetHeight, 100);
    assert.equal(placements[1].targetHeight, 83.33);
    assert.ok(Math.abs(placements[1].height - 83) <= 1);
});

test('a figure is sized by its head-to-feet height, so two figures drawn at different sizes come out in the ratio asked for', async () => {
    const small = figure();
    const large = upscale(figure(), 1.3);
    const layers = [
        layer({ id: 'tall', measure: 'figure', height: 400, at: 'bottom-centre', anchor: { x: 300, y: 590 }, image: 'x' }),
        layer({ id: 'short', measure: 'figure', height: { ratio: 0.8333, of: 'tall' }, at: 'bottom-centre', anchor: { x: 700, y: 590 }, image: 'y' }),
    ];
    const { placements } = await composeScene(layout(layers), new Map([['tall', small], ['short', large]]));
    assert.deepEqual(placements.map(({ method }) => method), ['head', 'head']);
    const headToFeet = (picture, scale) => measureFigure(picture).figureHeight * scale;
    assert.ok(Math.abs(headToFeet(small, placements[0].scale) - 400) <= 400 * 0.02);
    assert.ok(Math.abs(headToFeet(large, placements[1].scale) - 400 * 0.8333) <= 400 * 0.02);
    assert.ok(placements[1].height < placements[0].height, 'the second figure is shorter although its picture is larger');
});

test('a repeating layer is placed at each point, each at its own height', async () => {
    const stars = { id: 'stars', image: 's.png', z: 0, repeat: [{ x: 100, y: 100, height: 20 }, { x: 300, y: 150, height: 40 }, { x: 900, y: 50, height: 10 }] };
    const { raster, placements } = await composeScene(layout([stars]), new Map([['stars', boxed(RED, { w: 20, h: 20 })]]));
    assert.deepEqual(placements.map(({ height, point }) => [point, height]), [[0, 20], [1, 40], [2, 10]]);
    for (const [x, y] of [[100, 100], [300, 150], [900, 50]]) {
        assert.deepEqual(getPixel(raster, x, y), RED);
    }
});

test('a layer that reaches past the canvas is cut off without an error', async () => {
    const { raster } = await composeScene(layout([layer({ anchor: { x: 995, y: 595 } })]), new Map([['a', boxed(RED)]]));
    assert.deepEqual(getPixel(raster, 999, 599), RED);
});

test('a missing or empty picture, and heights that cannot be worked out, are refused', async () => {
    await assert.rejects(composeScene(layout([layer()]), new Map()), /no picture for layer "a"/);
    await assert.rejects(composeScene(layout([layer()]), new Map([['a', createRaster(10, 10)]])), /picture for layer "a" is empty/);
    const circle = layout([layer({ id: 'a', height: { ratio: 1, of: 'b' } }), layer({ id: 'b', height: { ratio: 1, of: 'a' } })]);
    assert.throws(() => resolveHeights(circle), /refer to each other in a circle/);
    const repeating = layout([{ id: 's', image: 's.png', z: 0, repeat: [{ x: 1, y: 1, height: 5 }] }, layer({ id: 'b', height: { ratio: 1, of: 's' } })]);
    assert.throws(() => resolveHeights(repeating), /repeats, so another layer cannot take its height from it/);
    const mixed = layout([layer({ id: 'a', measure: 'figure' }), layer({ id: 'b', height: { ratio: 1, of: 'a' } })]);
    assert.throws(() => resolveHeights(mixed), /measured as figure, not box/);
});

const GRADE = { toward: '#7d8fd6', amount: 0.4, lightness: -0.05 };

/** The figure drawn once at its own size, so a pixel of the picture is a pixel of the canvas, shifted by where the trim starts. */
async function figureScene(grade) {
    const picture = figure();
    const box = opaqueBox(picture, TRIM_ALPHA);
    const { raster } = await composeScene(layout([layer({ at: 'top-left', anchor: { x: 0, y: 0 }, height: box.height, ...(grade ? { grade } : {}) })]), new Map([['a', picture]]));
    return { raster, at: (x, y) => getPixel(raster, x - box.x, y - box.y) };
}

test('a layer without a grade, and one whose grade changes nothing, compose to the same bytes', async () => {
    const plain = await figureScene();
    const inert = await figureScene({ toward: '#7d8fd6', amount: 0, lightness: 0 });
    assert.deepEqual(inert.raster.data, plain.raster.data);
});

test('a graded layer is graded after the scale and keeps its sticker: the character moves toward the target, the rim and the white outline do not', async () => {
    const plain = await figureScene();
    const graded = await figureScene(GRADE);
    const [, targetA, targetB] = srgbToOklab([0x7d, 0x8f, 0xd6]);
    const distance = (pixel) => Math.hypot(srgbToOklab(pixel.slice(0, 3))[1] - targetA, srgbToOklab(pixel.slice(0, 3))[2] - targetB);
    const dress = [130, 300];
    assert.ok(distance(graded.at(...dress)) < distance(plain.at(...dress)) * 0.75, 'the dress is nearer the target');
    assert.notDeepEqual(graded.at(...dress), plain.at(...dress));
    for (const sticker of [[100, 300], [106, 300]]) {
        assert.deepEqual(graded.at(...sticker), plain.at(...sticker));
    }
    assert.equal(graded.at(...dress)[3], plain.at(...dress)[3]);
    const without = await figureScene({ ...GRADE, keepSticker: false });
    assert.notDeepEqual(without.at(100, 300), plain.at(100, 300), 'without keepSticker the rim is graded too');
    assert.notDeepEqual(without.at(106, 300), plain.at(106, 300), 'and so is the white outline');
});

test('keepSticker needs a sticker: a layer with none is refused instead of being graded all over', async () => {
    await assert.rejects(composeScene(layout([layer({ grade: GRADE })]), new Map([['a', boxed(RED)]])), /rim/);
    const { raster } = await composeScene(layout([layer({ grade: { ...GRADE, keepSticker: false } })]), new Map([['a', boxed(RED)]]));
    assert.notDeepEqual(getPixel(raster, 500, 300), RED);
});
