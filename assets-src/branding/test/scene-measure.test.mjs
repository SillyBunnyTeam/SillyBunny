import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRaster, opaqueBox } from '../scripts/lib/raster.mjs';
import { isEarColour, measureFigure } from '../scripts/lib/scene-measure.mjs';
import { STICKER, figure } from '../test-support/figure.mjs';
import { setPixel } from '../test-support/synthetic.mjs';

// The sticker is 2 * STICKER wide here, and two more pixels are cut as a margin.
const OPTIONS = { stickerWidth: STICKER * 2 + 2 };

test('white fur and pink inner ears are ear colours, and hair, skin, a gold bell and a dress are not', () => {
    for (const rgb of [[252, 250, 252], [255, 255, 255], [235, 140, 150], [200, 90, 110]]) {
        assert.ok(isEarColour(rgb), `${rgb} is an ear`);
    }
    for (const rgb of [[180, 160, 230], [40, 30, 40], [250, 215, 190], [200, 150, 40], [120, 150, 220], [140, 40, 50]]) {
        assert.ok(!isEarColour(rgb), `${rgb} is not an ear`);
    }
});

test('the height is taken from the top of the hair, so ears that stand above the head and a thin strand of hair do not count', () => {
    const picture = figure();
    const metrics = measureFigure(picture, OPTIONS);
    assert.equal(metrics.method, 'head');
    // The head's top is at 100, and the first row with a wide enough run of hair is a few rows below it.
    assert.ok(metrics.headTop >= 100 && metrics.headTop <= 112, `head top ${metrics.headTop}`);
    assert.equal(metrics.feet, opaqueBox(picture, 128).y + opaqueBox(picture, 128).height);
    assert.equal(metrics.boxHeight, metrics.feet - metrics.box.y);
    assert.ok(metrics.boxHeight - metrics.figureHeight > 70, `the box is ${metrics.boxHeight} and the figure ${metrics.figureHeight}`);
    assert.equal(metrics.figureHeight, metrics.feet - metrics.headTop);
});

test('the same figure at the same size measures the same wherever it stands in the picture', () => {
    const left = measureFigure(figure(), OPTIONS);
    const right = measureFigure(figure({ width: 420, shiftX: 100 }), OPTIONS);
    assert.equal(left.figureHeight, right.figureHeight);
});

test('with two figures in one picture, an x range measures one of them', () => {
    const wide = figure({ width: 640 });
    const second = figure({ width: 640, shiftX: 300 });
    for (let at = 0; at < second.data.length; at += 4) {
        if (second.data[at + 3] !== 0 && !(wide.data[at + 3] !== 0 && at / 4 % 640 < 300)) {
            wide.data.set(second.data.subarray(at, at + 4), at);
        }
    }
    const one = measureFigure(wide, { ...OPTIONS, xRange: [0, 280] });
    const two = measureFigure(wide, { ...OPTIONS, xRange: [300, 639] });
    assert.ok(Math.abs(one.figureHeight - two.figureHeight) <= 1);
    assert.ok(one.box.x + one.box.width <= 281 && two.box.x >= 300);
    assert.throws(() => measureFigure(wide, { xRange: [10, 700] }), /not inside/);
    assert.throws(() => measureFigure(figure({ width: 640 }), { xRange: [500, 600] }), /no figure in columns 500\.\.600/);
});

test('a picture with nothing but ear coloured pixels falls back to the whole box, and says so', () => {
    const raster = createRaster(120, 200);
    for (let y = 20; y < 180; y++) {
        for (let x = 30; x < 90; x++) {
            setPixel(raster, x, y, [252, 250, 252]);
        }
    }
    const metrics = measureFigure(raster, { stickerWidth: 4 });
    assert.equal(metrics.method, 'box');
    assert.equal(metrics.figureHeight, 160);
    assert.equal(metrics.headTop, 20);
});
