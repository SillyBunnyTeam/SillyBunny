import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, KIND, detectSheet, flagList, parseHeadSpec, renderRemnantSheet } from '../scripts/lib/ear-remnants.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const PAGE = [244, 241, 251];
const HAIR = [165, 140, 205];
const SHADOW = [130, 100, 180];
const SKIN = [252, 232, 220];
const SIZE = { width: 220, height: 180 };

const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

/**
 * A front-view head: lavender hair with darker strands, a skin face with eyes and a mouth, hair over the forehead
 * with one thin gap, and a neck. `extras` adds the remnants a test wants to find.
 */
function head(extras = () => {}) {
    const raster = createRaster(SIZE.width, SIZE.height, [...PAGE, 255]);
    for (let y = 0; y < SIZE.height; y++) {
        for (let x = 0; x < SIZE.width; x++) {
            if (inEllipse(x, y, 110, 90, 82, 86)) {
                setPixel(raster, x, y, x % 12 < 2 ? SHADOW : HAIR);
            }
            if (inEllipse(x, y, 110, 100, 42, 52) && y >= 62) {
                setPixel(raster, x, y, SKIN);
            }
        }
    }
    for (let y = 62; y < 70; y++) {
        for (let x = 108; x < 112; x++) {
            setPixel(raster, x, y - 8, SKIN);
        }
    }
    for (const eyeX of [90, 130]) {
        for (let y = 90; y < 100; y++) {
            for (let x = eyeX - 8; x < eyeX + 8; x++) {
                if (inEllipse(x, y, eyeX, 95, 8, 5)) {
                    setPixel(raster, x, y, [190, 40, 60]);
                }
            }
        }
    }
    for (let y = 124; y < 127; y++) {
        for (let x = 104; x < 116; x++) {
            setPixel(raster, x, y, [200, 120, 120]);
        }
    }
    for (let y = 150; y < 180; y++) {
        for (let x = 96; x < 124; x++) {
            setPixel(raster, x, y, SKIN);
        }
    }
    for (let y = 40; y < 60; y++) {
        for (let x = 140; x < 150; x++) {
            setPixel(raster, x, y, [200, 180, 230]);
        }
    }
    extras(raster);
    return raster;
}

const fill = (raster, [x, y, width, height], colour) => {
    for (let row = y; row < y + height; row++) {
        for (let column = x; column < x + width; column++) {
            setPixel(raster, column, row, colour);
        }
    }
};

const REMNANT_SKIN = [238, 196, 170];
const LEFT_SLIVER = [62, 98, 4, 14];
const RIGHT_BUMP = [152, 96, 6, 12];
const OUTLINE = [175, 90, 1, 30];
const withRemnants = (raster) => {
    fill(raster, LEFT_SLIVER, REMNANT_SKIN);
    fill(raster, RIGHT_BUMP, SKIN);
    fill(raster, OUTLINE, [150, 70, 70]);
};

const spec = (overrides = {}) => ({ name: 'front', crop: [0, 0, 220, 180], skin: [95, 112], ...overrides });
const detect = (raster, overrides = {}, options = {}) => detectSheet(raster, parseHeadSpec([spec(overrides)], raster), options)[0];
const share = (result, [x, y, width, height], kind) => {
    let hit = 0;
    for (let row = y; row < y + height; row++) {
        for (let column = x; column < x + width; column++) {
            hit += result.flags[(row - result.crop.y) * result.crop.width + (column - result.crop.x)] === kind ? 1 : 0;
        }
    }
    return hit / (width * height);
};
const flaggedWithin = (result, test) => {
    let count = 0;
    for (let y = 0; y < result.crop.height; y++) {
        for (let x = 0; x < result.crop.width; x++) {
            count += result.flags[y * result.crop.width + x] !== 0 && test(x + result.crop.x, y + result.crop.y) ? 1 : 0;
        }
    }
    return count;
};

test('the skin colour is the median of the cheek patch, and it is reported', () => {
    const result = detect(head());
    assert.deepEqual(result.skinColour, SKIN);
});

test('a clean head has no flags: hair strands, highlights, eyes, mouth, the forehead gap and the neck are not remnants', () => {
    const result = detect(head());
    assert.equal(flaggedWithin(result, () => true), 0);
    assert.deepEqual(result.components, []);
});

test('a skin-toned sliver in the hair and a bump fused to the face contour are both found, as skin', () => {
    const result = detect(head(withRemnants));
    assert.ok(share(result, LEFT_SLIVER, KIND.skin) >= 0.9, `sliver ${share(result, LEFT_SLIVER, KIND.skin)}`);
    // The columns next to the contour belong to the face's own rounded shape; the outer half of the bump is what sticks out.
    assert.ok(share(result, [155, 96, 3, 12], KIND.skin) >= 0.8, `bump ${share(result, [155, 96, 3, 12], KIND.skin)}`);
});

test('a thin warm outline line in the hair is found as warm, not as skin', () => {
    const result = detect(head(withRemnants));
    assert.ok(share(result, OUTLINE, KIND.warm) >= 0.8, `outline ${share(result, OUTLINE, KIND.warm)}`);
    assert.equal(share(result, OUTLINE, KIND.skin), 0);
});

test('the face itself is never flagged, and nothing is flagged away from the three remnants', () => {
    const result = detect(head(withRemnants));
    assert.equal(flaggedWithin(result, (x, y) => inEllipse(x, y, 110, 100, 38, 48) && y >= 66), 0, 'flag inside the face');
    const near = (rect, margin) => (x, y) => x >= rect[0] - margin && y >= rect[1] - margin && x < rect[0] + rect[2] + margin && y < rect[1] + rect[3] + margin;
    const elsewhere = flaggedWithin(result, (x, y) => !near(LEFT_SLIVER, 3)(x, y) && !near(RIGHT_BUMP, 3)(x, y) && !near(OUTLINE, 3)(x, y));
    assert.equal(elsewhere, 0, `${elsewhere} flags away from the remnants`);
});

test('components describe each remnant: kind, box and pixel count, largest first', () => {
    const { components } = detect(head(withRemnants));
    assert.equal(components.length, 3);
    const sliver = components.find((c) => c.kind === 'skin' && c.x < 70);
    assert.deepEqual([sliver.x, sliver.y, sliver.width, sliver.height], [...LEFT_SLIVER]);
    assert.ok(sliver.pixels >= 48 && sliver.pixels <= 56, `the rim filter may round the corners, got ${sliver.pixels} pixels`);
    assert.ok(components.every((c, at) => at === 0 || components[at - 1].pixels >= c.pixels));
    assert.ok(components.some((c) => c.kind === 'warm' && c.x === 175));
});

test('a remnant smaller than the minimum size is noise and is not reported', () => {
    const raster = head((r) => fill(r, [62, 100, 3, 3], REMNANT_SKIN));
    assert.deepEqual(detect(raster).components, []);
    assert.ok(detect(raster, {}, { minPixels: 3 }).components.some((c) => c.x === 62 && c.pixels >= 3));
});

test('the page and the white of the sticker are never skin, whatever the threshold, because their hue and chroma are wrong', () => {
    assert.deepEqual(detect(head(), {}, { threshold: 0.2 }).components, []);
});

test('the flag threshold decides how far from the cheek colour still counts as skin', () => {
    const raster = head((r) => fill(r, LEFT_SLIVER, [215, 170, 150]));
    assert.equal(share(detect(raster, {}, { threshold: 0.03 }), LEFT_SLIVER, KIND.skin), 0);
    assert.ok(share(detect(raster, {}, { threshold: 0.12 }), LEFT_SLIVER, KIND.skin) >= 0.9);
});

test('an ignore rect hides what is inside it, such as a rabbit ear that hangs beside the face', () => {
    const earCream = (r) => fill(r, [158, 70, 14, 20], [246, 214, 196]);
    assert.ok(detect(head(earCream)).components.length > 0, 'the ear-coloured block is flagged when nothing ignores it');
    assert.deepEqual(detect(head(earCream), { ignore: [[156, 68, 18, 24]] }).components, []);
});

test('the search stays to the sides of the face: the same sliver far above the head is not looked at', () => {
    const raster = head((r) => fill(r, [90, 4, 4, 14], REMNANT_SKIN));
    assert.deepEqual(detect(raster).components, []);
});

test('a head with no face (a back view) uses a skin colour sampled elsewhere on the sheet and flags any skin-like pixel in its hair', () => {
    const sheet = createRaster(340, 180, [...PAGE, 255]);
    const front = head();
    for (let y = 0; y < 180; y++) {
        for (let x = 0; x < 220; x++) {
            setPixel(sheet, x, y, getPixel(front, x, y));
        }
    }
    fill(sheet, [230, 20, 100, 140], HAIR);
    fill(sheet, [270, 80, 4, 12], REMNANT_SKIN);
    const heads = parseHeadSpec([
        spec({ name: 'back', crop: [225, 10, 110, 160], skin: [95, 112], faceless: true }),
    ], sheet);
    const [back] = detectSheet(sheet, heads);
    assert.deepEqual(back.skinColour, SKIN);
    assert.equal(back.components.length, 1);
    assert.deepEqual([back.components[0].x, back.components[0].y, back.components[0].width, back.components[0].height], [270, 80, 4, 12]);
});

test('the specs are checked: crops inside the image, known keys, a skin point and unique names', () => {
    const raster = head();
    for (const [bad, message] of [
        [{}, /list of heads/],
        [[], /at least one head/],
        [[{ crop: [0, 0, 10, 10], skin: [1, 1] }], /name/],
        [[spec({ crop: [0, 0, 300, 10] })], /outside the 220x180 image/],
        [[spec({ skin: [500, 5] })], /skin point \[500, 5\] is outside/],
        [[spec({ skin: undefined })], /needs skin/],
        [[spec({ bogus: 1 })], /unknown key "bogus"/],
        [[spec(), spec()], /duplicate/],
        [[spec({ ignore: [[0, 0, 5]] })], /ignore/],
    ]) {
        assert.throws(() => parseHeadSpec(bad, raster), message);
    }
    const ok = parseHeadSpec([spec({ ignore: [[0, 0, 5, 5]] })], raster);
    assert.deepEqual(ok[0].crop, { x: 0, y: 0, width: 220, height: 180 });
    assert.equal(ok[0].faceless, false);
});

test('the flag list is every flagged pixel in source coordinates with its kind, and the defaults are the ones the tool documents', () => {
    const result = detect(head(withRemnants));
    const list = flagList([result]);
    assert.ok(list.some(([x, y, kind]) => x === 63 && y === 100 && kind === KIND.skin));
    assert.ok(list.every((entry) => entry.length === 3 && entry.every(Number.isInteger)));
    assert.equal(list.length, result.components.reduce((sum, c) => sum + c.pixels, 0));
    assert.equal(typeof DEFAULTS.threshold, 'number');
});

test('the overlay is each head at 4x with flagged pixels tinted: skin red, warm yellow, everything else untouched', async () => {
    const raster = head(withRemnants);
    const result = detect(raster);
    const sheet = await renderRemnantSheet(raster, [result], { scale: 4, columns: 1 });
    const { default: sharp } = await import('sharp');
    const { data, info } = await sharp(sheet).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3)];
    const gap = 12;
    const tile = (x, y) => at(gap + x * 4 + 2, gap + y * 4 + 2);
    const [r, g, b] = tile(63, 105);
    assert.ok(r > 200 && g < 120 && b < 120, `skin flag should read red, got ${[r, g, b]}`);
    const [wr, wg, wb] = tile(175, 100);
    assert.ok(wr > 200 && wg > 150 && wb < 100, `warm flag should read yellow, got ${[wr, wg, wb]}`);
    assert.deepEqual(tile(20, 20), PAGE, 'an unflagged pixel keeps its colour');
    assert.deepEqual(tile(110, 110), SKIN, 'the face is untouched');
    assert.equal(info.width, gap + 220 * 4 + gap);
    assert.deepEqual(getPixel(raster, 63, 105).slice(0, 3), REMNANT_SKIN);
});
