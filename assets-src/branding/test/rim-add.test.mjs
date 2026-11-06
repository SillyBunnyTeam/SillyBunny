import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addRim, addRimMeasured, measureRimWidth } from '../scripts/lib/rim-add.mjs';
import { EDGE, RIM_WIDTH, SIZE, inward, ringlessSticker, softFringeSticker, sticker } from '../test-support/sticker.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const TARGET = [185, 155, 242];
const near = (pixel, colour, tolerance) => colour.every((channel, at) => Math.abs(pixel[at] - channel) <= tolerance);
const sameBytes = (one, two, x, y) => getPixel(one, x, y).every((channel, at) => channel === getPixel(two, x, y)[at]);

test('the rim width is how far from the silhouette the colour has gone half way from the rim to white, in source pixels', () => {
    const width = measureRimWidth(sticker());
    // The synthetic rim is 5 pixels, then one pixel that is half rim and half white, so the half way point is about 5.5.
    assert.ok(Math.abs(width - 5.5) < 0.6, `measured ${width}`);
});

test('a picture with no rim colour, or with no white band, has no rim width to measure', () => {
    assert.throws(() => measureRimWidth(ringlessSticker()), /rim/);
    assert.throws(() => measureRimWidth(createRaster(20, 20)), /rim/);
});

test('the new ring is the target colour, as wide as asked, and starts right outside the white band', () => {
    const { raster, stats } = addRim(ringlessSticker(), { target: TARGET, width: 5 });
    for (const offset of [2, 3, 4, 5]) {
        const pixel = getPixel(raster, EDGE - offset, 40);
        assert.ok(near(pixel.slice(0, 3), TARGET, 1), `ring pixel ${offset} is ${pixel}`);
    }
    assert.equal(getPixel(raster, EDGE - 5, 40)[3], 255, 'the ring is solid inside its width');
    assert.equal(getPixel(raster, EDGE - 7, 40)[3], 0, 'and nothing is drawn beyond it');
    assert.ok(stats.added > 4 * 5 * 60);
});

test('the outer edge of the ring is antialiased, so a width that is not a whole number gives a partly covered last pixel', () => {
    const { raster } = addRim(ringlessSticker(), { target: TARGET, width: 5.5 });
    const alphas = [1, 2, 3, 4, 5, 6, 7].map((step) => getPixel(raster, EDGE - step, 40)[3]);
    assert.deepEqual(alphas.slice(0, 5), [255, 255, 255, 255, 255]);
    assert.ok(alphas[5] > 100 && alphas[5] < 155, `the sixth pixel is half covered: ${alphas[5]}`);
    assert.equal(alphas[6], 0);
    for (let at = 1; at < alphas.length; at++) {
        assert.ok(alphas[at] <= alphas[at - 1], 'coverage never grows outward');
    }
});

test('every pixel that is at least half opaque is byte for byte what it was', () => {
    const source = ringlessSticker();
    const { raster } = addRim(source, { target: TARGET, width: 6 });
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            if (getPixel(source, x, y)[3] >= 128) {
                assert.ok(sameBytes(source, raster, x, y), `pixel ${x},${y} changed`);
            }
        }
    }
});

test('the faint antialiased edge of the band keeps its colour under the ring and gains alpha, so no seam is left', () => {
    const source = ringlessSticker();
    const { raster } = addRim(source, { target: TARGET, width: 6 });
    const before = getPixel(source, EDGE - 1, 40);
    const after = getPixel(raster, EDGE - 1, 40);
    assert.equal(before[3], 90);
    assert.ok(after[3] > before[3], 'the ring shows through behind it');
    assert.ok(after[0] > TARGET[0] - 1 && after[0] <= 255, 'and its colour lies between the ring and white');
});

test('a translucent lavender fringe outside the band is not a rim: the ring is grown from the band and replaces the whole fringe, leaving the band untouched', () => {
    const source = softFringeSticker();
    const { raster, stats } = addRim(source, { target: TARGET, width: 5 });
    for (const step of [1, 2, 3, 4, 5]) {
        const pixel = getPixel(raster, EDGE - step, 40);
        assert.equal(pixel[3], 255, `step ${step}`);
        assert.ok(step === 5 || near(pixel.slice(0, 3), TARGET, 1), `step ${step} is ${pixel}`);
    }
    assert.equal(getPixel(raster, EDGE - 6, 40)[3], 0, 'beyond the ring the old fringe is cleared, so the edge is the ring\'s own');
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            if (inward(x, y) >= 0) {
                assert.ok(sameBytes(source, raster, x, y), `pixel ${x},${y} of the band or the character changed`);
            }
        }
    }
    assert.ok(stats.replaced > 0, 'the report counts the fringe pixels it replaced');
});

test('the rim width is measured from the band, so a fringe does not make the ring wider than asked', () => {
    const { raster } = addRim(softFringeSticker(), { target: TARGET, width: 5 });
    assert.equal(getPixel(raster, EDGE - 5, 40)[3], 255);
    assert.ok(getPixel(raster, EDGE - 6, 40)[3] <= 50, 'nothing opaque lies past 5 pixels from the band');
});

test('the corners are rounded, since the ring is a distance from the silhouette and not a box', () => {
    const { raster } = addRim(ringlessSticker(), { target: TARGET, width: 6 });
    assert.equal(getPixel(raster, EDGE - 6, EDGE - 6)[3], 0, 'the square corner is not filled');
    assert.ok(getPixel(raster, EDGE - 4, EDGE - 4)[3] > 0, 'a corner pixel close to the band is');
});

test('a picture that already has a lavender rim is refused, so a rim is never drawn twice', () => {
    assert.throws(() => addRim(sticker(), { target: TARGET, width: 5 }), /already has a lavender rim/);
});

test('the canvas border is a cut, not an edge: no ring is drawn along it', () => {
    const raster = createRaster(40, 40);
    for (let y = 10; y < 40; y++) {
        for (let x = 10; x < 30; x++) {
            setPixel(raster, x, y, y < 14 || x < 14 || x > 25 ? [255, 255, 255] : [250, 230, 220]);
        }
    }
    const { raster: out } = addRim(raster, { target: TARGET, width: 4 });
    assert.equal(getPixel(out, 20, 39)[3], 255);
    assert.deepEqual(getPixel(out, 20, 39), getPixel(raster, 20, 39));
    assert.ok(getPixel(out, 8, 30)[3] > 0, 'the open sides get their ring');
});

test('the width must be a positive number and the picture must have something in it', () => {
    for (const width of [0, -1, Number.NaN, Infinity]) {
        assert.throws(() => addRim(ringlessSticker(), { target: TARGET, width }), /width/);
    }
    assert.throws(() => addRim(createRaster(10, 10), { target: TARGET, width: 5 }), /nothing/);
});

test('a second run on the result is refused as well, because the ring it drew is now a rim', () => {
    const { raster } = addRim(ringlessSticker(), { target: TARGET, width: RIM_WIDTH });
    assert.throws(() => addRim(raster, { target: TARGET, width: RIM_WIDTH }), /already has a lavender rim/);
});

test('a measured width is met: the ring is drawn as wide as needed for the result to measure what the approved masters measure', () => {
    for (const wanted of [4, 5.5, 7]) {
        const { raster, stats } = addRimMeasured(ringlessSticker(), { target: TARGET, measuredWidth: wanted });
        assert.ok(Math.abs(measureRimWidth(raster) - wanted) < 0.3, `asked ${wanted}, measured ${measureRimWidth(raster)}`);
        assert.equal(stats.measuredWidth, wanted);
        assert.ok(stats.width > 0, 'the drawn width is reported too');
    }
});

test('a translucent fringe is covered by a measured width as well, so the new rim is as thick as the others whatever the old fringe was', () => {
    const { raster } = addRimMeasured(softFringeSticker(), { target: TARGET, measuredWidth: 5 });
    assert.ok(Math.abs(measureRimWidth(raster) - 5) < 0.3, `measured ${measureRimWidth(raster)}`);
});

test('a measured width that no ring can give is refused', () => {
    assert.throws(() => addRimMeasured(ringlessSticker(), { target: TARGET, measuredWidth: 40 }), /measured width/);
    assert.throws(() => addRimMeasured(ringlessSticker(), { target: TARGET, measuredWidth: 0 }), /measured width/);
});
