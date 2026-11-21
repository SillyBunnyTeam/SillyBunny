import assert from 'node:assert/strict';
import { test } from 'node:test';
import { srgbToOklab } from '../scripts/lib/pixel-colour.mjs';
import { gradeRaster } from '../scripts/lib/scene-grade.mjs';
import { RIM_WIDTH, SIZE, WHITE_WIDTH, inward, sticker } from '../test-support/sticker.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const TOWARD = [125, 143, 214];
const grade = (extra = {}) => ({ toward: TOWARD, amount: 0.5, lightness: -0.05, keepSticker: true, ...extra });
const labOf = (pixel) => srgbToOklab(pixel.slice(0, 3));
// A pixel well inside the character, outside the hair patch, and the rim, band and soft edge of the synthetic sticker.
const SKIN_AT = [60, 45];
const RIM_AT = [14, 40];
const BAND_AT = [19, 40];
const HALO_AT = [11, 40];
const FADED_AT = [10, 40];
const isSticker = (x, y) => inward(x, y) >= -2 && inward(x, y) < RIM_WIDTH + WHITE_WIDTH;

test('a pixel moves the given share of the way toward the target a and b, and its lightness by the given amount', () => {
    const source = sticker();
    const graded = gradeRaster(source, grade());
    const [l, a, b] = labOf(getPixel(source, ...SKIN_AT));
    const [, targetA, targetB] = srgbToOklab(TOWARD);
    const [gl, ga, gb] = labOf(getPixel(graded, ...SKIN_AT));
    assert.ok(Math.abs(gl - (l - 0.05)) < 0.012, `lightness ${gl} from ${l}`);
    assert.ok(Math.abs(ga - (a + (targetA - a) * 0.5)) < 0.012, `a ${ga}`);
    assert.ok(Math.abs(gb - (b + (targetB - b) * 0.5)) < 0.012, `b ${gb}`);
});

test('alpha is never changed, whatever the colour does, and the picture it was given is not touched', () => {
    const source = sticker();
    const before = Buffer.from(source.data);
    for (const keepSticker of [true, false]) {
        const graded = gradeRaster(source, grade({ keepSticker }));
        for (let at = 3; at < source.data.length; at += 4) {
            assert.equal(graded.data[at], source.data[at]);
        }
    }
    assert.deepEqual(source.data, before);
});

test('with keepSticker the rim, the white band and the soft edge are byte for byte what they were, and the character is graded', () => {
    const source = sticker();
    const graded = gradeRaster(source, grade());
    let character = 0;
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const same = getPixel(graded, x, y).every((channel, at) => channel === getPixel(source, x, y)[at]);
            if (isSticker(x, y)) {
                assert.ok(same, `sticker pixel ${x},${y} changed`);
            } else if (inward(x, y) >= RIM_WIDTH + WHITE_WIDTH + 1 && !same) {
                character++;
            }
        }
    }
    assert.ok(character > 1000, `${character} character pixels were graded`);
    assert.notDeepEqual(getPixel(graded, ...SKIN_AT), getPixel(source, ...SKIN_AT));
});

test('without keepSticker the rim, the white band and the soft edge are graded too, and a fully transparent pixel still keeps its bytes', () => {
    const source = sticker();
    const graded = gradeRaster(source, grade({ keepSticker: false }));
    for (const at of [RIM_AT, BAND_AT, HALO_AT]) {
        assert.notDeepEqual(getPixel(graded, ...at), getPixel(source, ...at), `pixel ${at} stayed`);
    }
    assert.equal(getPixel(source, ...FADED_AT)[3], 0);
    assert.deepEqual(getPixel(graded, ...FADED_AT), getPixel(source, ...FADED_AT));
});

test('no amount and no lightness change gives the same bytes, and lightness is kept between 0 and 1', () => {
    const source = sticker();
    assert.deepEqual(gradeRaster(source, grade({ amount: 0, lightness: 0 })).data, source.data);
    const plain = createRaster(2, 1);
    setPixel(plain, 0, 0, [250, 250, 250, 255]);
    setPixel(plain, 1, 0, [4, 4, 4, 255]);
    const lighter = gradeRaster(plain, grade({ amount: 0, lightness: 0.5, keepSticker: false }));
    const darker = gradeRaster(plain, grade({ amount: 0, lightness: -0.5, keepSticker: false }));
    assert.ok(getPixel(lighter, 0, 0).slice(0, 3).every((channel) => channel >= 254), 'white cannot get lighter');
    assert.ok(getPixel(darker, 1, 0).slice(0, 3).every((channel) => channel <= 1), 'black cannot get darker');
});
