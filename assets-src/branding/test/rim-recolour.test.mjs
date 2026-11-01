import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHexColour, recolourRim } from '../scripts/lib/rim-recolour.mjs';
import { EDGE, HAIR, OLD_RIM_A, RIM_WIDTH, SIZE, SKIN, WHITE_WIDTH, inward, sticker } from '../test-support/sticker.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const TARGET = [185, 155, 242];

const differs = (one, two, x, y) => getPixel(one, x, y).some((channel, at) => channel !== getPixel(two, x, y)[at]);
const near = (pixel, colour, tolerance) => colour.every((channel, at) => Math.abs(pixel[at] - channel) <= tolerance);

test('a hex colour is parsed, and anything else is refused', () => {
    assert.deepEqual(parseHexColour('#b99bf2'), [185, 155, 242]);
    assert.deepEqual(parseHexColour('B99BF2'), [185, 155, 242]);
    assert.throws(() => parseHexColour('#b99b'), /hex colour/);
    assert.throws(() => parseHexColour('purple'), /hex colour/);
});

test('the rim ring takes the target colour, to within a rounding step, with its alpha untouched', () => {
    const source = sticker();
    const { raster, stats } = recolourRim(source, { target: TARGET });
    for (const x of [EDGE + 1, EDGE + 2, EDGE + RIM_WIDTH - 2]) {
        const pixel = getPixel(raster, x, 40);
        assert.ok(near(pixel, TARGET, 6), `rim pixel at ${x} is ${pixel}`);
        assert.equal(pixel[3], 255);
    }
    assert.ok(stats.recoloured > 300);
    for (let at = 3; at < source.data.length; at += 4) {
        assert.equal(raster.data[at], source.data[at], 'alpha is never changed');
    }
});

test('everything inside the white band is byte for byte what it was, and so is the white band', () => {
    const source = sticker();
    const { raster } = recolourRim(source, { target: TARGET });
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            if (inward(x, y) > RIM_WIDTH) {
                assert.ok(!differs(source, raster, x, y), `pixel ${x},${y} changed`);
            }
        }
    }
    assert.ok(!differs(source, raster, 45, 45), 'a dark detail is untouched');
});

test('hair of nearly the rim colour right behind the white band is not mistaken for the rim', () => {
    const source = sticker();
    const { raster } = recolourRim(source, { target: TARGET });
    const hairDepth = RIM_WIDTH + WHITE_WIDTH + 1;
    assert.deepEqual(getPixel(raster, 40, EDGE + hairDepth), getPixel(source, 40, EDGE + hairDepth));
    assert.deepEqual(getPixel(raster, 40, EDGE + hairDepth), [...HAIR, 255]);
});

test('the soft outer edge moves too, and a pixel that is half rim and half white moves only half way', () => {
    const source = sticker();
    const { raster } = recolourRim(source, { target: TARGET });
    const halo = getPixel(raster, EDGE - 1, 40);
    assert.equal(halo[3], 60);
    assert.ok(near(halo, TARGET, 8), `half transparent edge is ${halo}`);
    const mixed = getPixel(raster, EDGE + RIM_WIDTH, 40);
    const before = getPixel(source, EDGE + RIM_WIDTH, 40);
    const full = getPixel(raster, EDGE + 2, 40);
    assert.ok(Math.abs(mixed[2] - before[2]) < Math.abs(full[2] - getPixel(source, EDGE + 2, 40)[2]), 'the half and half pixel moves less than the rim');
});

test('the shift keeps the variation of the rim instead of flattening it', () => {
    const { raster } = recolourRim(sticker(), { target: TARGET });
    const even = getPixel(raster, EDGE + 2, 40);
    const odd = getPixel(raster, EDGE + 2, 41);
    assert.notDeepEqual(even, odd, 'two shades of the old rim stay two shades');
    assert.ok(even.slice(0, 3).every((channel, at) => Math.abs(channel - odd[at]) <= 8));
});

test('a rim that already has the target colour is left as it is, and a second run changes nothing', () => {
    const once = recolourRim(sticker(), { target: TARGET }).raster;
    const twice = recolourRim(once, { target: TARGET });
    let changed = 0;
    for (let at = 0; at < once.data.length; at++) {
        changed += once.data[at] === twice.raster.data[at] ? 0 : 1;
    }
    assert.ok(changed <= 8, `${changed} bytes moved on a second run`);
});

test('the canvas border is a cut, not an edge: lavender character pixels on it are left alone', () => {
    const source = sticker({ borderCut: true });
    const { raster } = recolourRim(source, { target: TARGET });
    assert.deepEqual(getPixel(raster, 40, SIZE - 1), getPixel(source, 40, SIZE - 1));
});

test('a picture without a rim is refused, and the report names the rim it found', () => {
    const plain = createRaster(40, 40);
    for (let y = 8; y < 32; y++) {
        for (let x = 8; x < 32; x++) {
            setPixel(plain, x, y, SKIN);
        }
    }
    assert.throws(() => recolourRim(plain, { target: TARGET }), /rim/);
    assert.throws(() => recolourRim(createRaster(10, 10), { target: TARGET }), /rim/);
    const { stats } = recolourRim(sticker(), { target: TARGET });
    assert.ok(near(stats.rimBefore, OLD_RIM_A, 8));
    assert.deepEqual(stats.rimTarget, TARGET);
});

const COARSE = { size: 260, edge: 10, rim: 32, white: 32 };
const coarseInward = (x, y) => Math.min(x, y, COARSE.size - 1 - x, COARSE.size - 1 - y) - COARSE.edge;

/** A sticker drawn on a coarse grid (a 32 pixel rim and a 32 pixel white band, hard edges), which the first 16 pixels of the search cannot see past. */
function coarseSticker() {
    const raster = createRaster(COARSE.size, COARSE.size);
    for (let y = 0; y < COARSE.size; y++) {
        for (let x = 0; x < COARSE.size; x++) {
            const depth = coarseInward(x, y);
            if (depth < 0) {
                continue;
            }
            const colour = depth < COARSE.rim ? OLD_RIM_A : depth < COARSE.rim + COARSE.white ? [255, 255, 255] : SKIN;
            setPixel(raster, x, y, colour);
        }
    }
    setPixel(raster, 130, 130, [60, 30, 50]);
    return raster;
}

test('a sticker whose rim and white band are 32 pixels thick is found, recoloured in the rim only, with its alpha and everything inside the rim untouched', () => {
    const source = coarseSticker();
    const { raster, stats } = recolourRim(source, { target: TARGET });
    let rim = 0;
    for (let y = 0; y < COARSE.size; y++) {
        for (let x = 0; x < COARSE.size; x++) {
            const depth = coarseInward(x, y);
            if (depth >= 0 && depth < COARSE.rim) {
                rim++;
                assert.ok(near(getPixel(raster, x, y), TARGET, 6), `rim pixel ${x},${y} is ${getPixel(raster, x, y)}`);
            } else {
                assert.ok(!differs(source, raster, x, y), `pixel ${x},${y} outside the rim changed`);
            }
        }
    }
    assert.equal(stats.recoloured, rim);
    assert.ok(near(stats.rimBefore, OLD_RIM_A, 2));
    for (let at = 3; at < source.data.length; at += 4) {
        assert.equal(raster.data[at], source.data[at], 'alpha is never changed');
    }
});

test('a picture with a rim but no white band at any depth is still refused', () => {
    const solid = createRaster(120, 120);
    for (let y = 10; y < 110; y++) {
        for (let x = 10; x < 110; x++) {
            setPixel(solid, x, y, OLD_RIM_A);
        }
    }
    assert.throws(() => recolourRim(solid, { target: TARGET }), /No white band found within 256 pixels/);
});
