import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolateLines, lineThickness, measureShading, rasterFromTones, shadeLines, toneRoles } from '../scripts/lib/line-shading.mjs';
import { opaqueMask } from '../scripts/lib/shape-ops.mjs';
import { findTones, pinTone, snapToTones } from '../scripts/lib/tone-snap.mjs';
import { DARK, LIGHT, MID, emblem } from '../test-support/emblem.mjs';
import { createRaster, getPixel } from '../test-support/synthetic.mjs';

const hex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
const TONES = [MID, DARK, LIGHT].map((rgb) => ({ rgb, hex: hex(rgb) }));
const BASE = { base: 0, dark: 1, light: 2 };

/** A picture as a tone index (-1 is background), built from a list of [tone, x0, y0, x1, y1] boxes drawn in order. */
function pictureOf(width, height, boxes) {
    const toneIndex = new Int8Array(width * height).fill(-1);
    for (const [tone, x0, y0, x1, y1] of boxes) {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                toneIndex[y * width + x] = tone;
            }
        }
    }
    return toneIndex;
}

const zoneOf = (toneIndex, tone) => Uint8Array.from(toneIndex, (value) => (value === tone ? 1 : 0));
/** One column of a tone index as text, one character per row: . for background, else the tone. */
const column = (toneIndex, width, x, from, to) => Array.from({ length: to - from }, (_, row) => toneIndex[(from + row) * width + x]).map((tone) => (tone < 0 ? '.' : tone)).join('');

test('the roles are the given base tone, the darkest of the others and the lightest, whatever order the tones come in', () => {
    const reordered = [TONES[2], TONES[0], TONES[1]];
    assert.deepEqual(toneRoles(TONES, '#8b64aa'), BASE);
    assert.deepEqual(toneRoles(reordered, '#8B64AA'), { base: 1, dark: 2, light: 0 });
});

test('a logo that does not have three tones, or whose base is not among them, is refused', () => {
    assert.throws(() => toneRoles(TONES.slice(0, 2), '#8b64aa'), /three tones/);
    assert.throws(() => toneRoles(TONES, '#20c020'), /not one of the tones/);
});

const LINE_WIDTH = 170;
// A body with a long line and a square dot hanging off its left side, and a speck far from both.
function lineAndBody() {
    const raster = createRaster(LINE_WIDTH, 90);
    const toneIndex = pictureOf(LINE_WIDTH, 90, [
        [0, 100, 20, 160, 80],
        [0, 12, 47, 100, 53],
        [0, 3, 40, 19, 60],
        [0, 164, 5, 167, 8],
    ]);
    toneIndex.forEach((tone, at) => {
        if (tone >= 0) {
            raster.data.set([...MID, 255], at * 4);
        }
    });
    return { raster, toneIndex };
}

test('lines and dots are what an opening wider than the line cuts away, less the specks, and the shading zone reaches the body', () => {
    const { raster } = lineAndBody();
    const { zone, thin, body, parts, radius } = isolateLines(raster, 11);
    const at = (x, y) => y * LINE_WIDTH + x;
    assert.equal(radius, 5);
    assert.equal(parts.length, 1, 'the line with its dot is one piece, and the 3 pixel speck is not a piece');
    assert.ok(parts[0].area >= 200);
    assert.ok(parts[0].box.x <= 4 && parts[0].box.x + parts[0].box.width >= 94, JSON.stringify(parts[0].box));
    assert.equal(thin[at(50, 50)], 1, 'the line');
    assert.equal(thin[at(8, 45)], 1, 'the dot');
    assert.equal(thin[at(165, 6)], 0, 'a speck is not a line');
    assert.equal(zone[at(165, 6)], 0);
    assert.equal(body[at(98, 50)], 1, 'the first pixels of the line at the body are rounded back into it');
    assert.equal(thin[at(98, 50)], 0);
    assert.equal(zone[at(98, 50)], 1, 'and the zone still covers them, so the shading runs up to the body');
    assert.equal(zone[at(130, 50)], 0, 'the inside of the body is not in the zone');
    assert.equal(zone[at(105, 25)], 0);
});

test('the thickness of the lines is the most common thickness, which the wider dots do not move', () => {
    const { raster, toneIndex } = lineAndBody();
    const { thin } = isolateLines(raster, 11);
    const mask = Uint8Array.from(toneIndex, (tone) => (tone >= 0 ? 1 : 0));
    assert.equal(lineThickness(thin, mask, LINE_WIDTH, 90), 6);
    assert.throws(() => lineThickness(new Uint8Array(LINE_WIDTH * 90), mask, LINE_WIDTH, 90), /no lines/);
});

test('on the emblem the two lines with dots and the charm cord are found, and none of them is the dome or an ear', () => {
    const source = emblem();
    const tones = pinTone(findTones(source), '#8b64aa');
    const { raster } = snapToTones(source, tones);
    const { parts } = isolateLines(raster, 11);
    assert.equal(parts.length, 3);
    const boxes = parts.map(({ box }) => box).sort((a, b) => a.y - b.y);
    assert.ok(boxes[0].y < 140, 'the cord of the charm');
    assert.ok(boxes[1].x < 60 && boxes[2].x > 250, 'the left and the right line');
    for (const box of boxes) {
        assert.ok(box.height <= 24, JSON.stringify(box));
    }
});

test('a line is dark along its lower edge by the band width, and keeps its middle', () => {
    const toneIndex = pictureOf(40, 30, [[0, 5, 10, 35, 22]]);
    const shaded = shadeLines({ toneIndex, width: 40, height: 30, zone: zoneOf(toneIndex, 0), roles: BASE, kDark: 4 });
    assert.equal(column(shaded.toneIndex, 40, 20, 8, 24), '..000000001111..');
    assert.equal(shaded.darkened, 4 * 30);
    assert.equal(shaded.lightened, 0);
    assert.equal(toneIndex[19 * 40 + 20], 0, 'the input is not changed');
});

test('with a light band the upper edge is light, and where the two bands meet the dark one wins', () => {
    const thick = pictureOf(40, 30, [[0, 5, 10, 35, 22]]);
    const shadedThick = shadeLines({ toneIndex: thick, width: 40, height: 30, zone: zoneOf(thick, 0), roles: BASE, kDark: 4, kLight: 3 });
    assert.equal(column(shadedThick.toneIndex, 40, 20, 10, 22), '222000001111');
    assert.equal(shadedThick.lightened, 3 * 30);

    const thin = pictureOf(40, 30, [[0, 5, 10, 35, 15]]);
    const shadedThin = shadeLines({ toneIndex: thin, width: 40, height: 30, zone: zoneOf(thin, 0), roles: BASE, kDark: 3, kLight: 3 });
    assert.equal(column(shadedThin.toneIndex, 40, 20, 10, 15), '22111', 'row 12 is in both bands and is dark');
});

test('only base tone pixels inside the zone are shaded, and the edge is judged by what is drawn, not by its tone', () => {
    const toneIndex = pictureOf(40, 30, [
        [0, 5, 10, 35, 22],
        [2, 10, 18, 14, 22],
        [0, 38, 10, 40, 22],
    ]);
    const zone = Uint8Array.from(toneIndex, (tone, at) => (tone >= 0 && at % 40 < 36 ? 1 : 0));
    const shaded = shadeLines({ toneIndex, width: 40, height: 30, zone, roles: BASE, kDark: 4 });
    const at = (x, y) => shaded.toneIndex[y * 40 + x];
    assert.equal(at(12, 20), 2, 'a light pixel in the zone stays light');
    assert.equal(at(12, 16), 0, 'a base pixel above a light one has drawn picture below it, so it is not on the edge');
    assert.equal(at(20, 20), 1);
    assert.equal(at(38, 20), 0, 'outside the zone stays base');
    assert.equal(at(20, 15), 0);
});

test('a line that meets the body is shaded right up to it, and the body itself has no edge below the line', () => {
    const toneIndex = pictureOf(60, 40, [
        [0, 30, 0, 60, 40],
        [0, 5, 15, 30, 23],
    ]);
    const zone = Uint8Array.from(toneIndex, (tone, at) => (tone >= 0 && at % 60 < 36 ? 1 : 0));
    const shaded = shadeLines({ toneIndex, width: 60, height: 40, zone, roles: BASE, kDark: 3 });
    const at = (x, y) => shaded.toneIndex[y * 60 + x];
    assert.equal(at(29, 22), 1, 'the band runs right up to the body');
    assert.equal(at(29, 19), 0);
    assert.equal(at(32, 22), 0, 'inside the body there is drawn picture below, so there is no edge');
});

test('band widths must be whole pixels, 1 or more for the dark band and 0 or more for the light', () => {
    const toneIndex = pictureOf(10, 10, [[0, 0, 0, 10, 10]]);
    const request = { toneIndex, width: 10, height: 10, zone: zoneOf(toneIndex, 0), roles: BASE };
    assert.throws(() => shadeLines({ ...request, kDark: 0 }), /whole numbers/);
    assert.throws(() => shadeLines({ ...request, kDark: 2.5 }), /whole numbers/);
    assert.throws(() => shadeLines({ ...request, kDark: 2, kLight: -1 }), /whole numbers/);
});

test('the picture is redrawn from the tone index in the tones at full opacity', () => {
    const raster = rasterFromTones(Int8Array.from([0, 1, 2, -1]), 2, 2, TONES);
    assert.deepEqual(getPixel(raster, 0, 0), [...MID, 255]);
    assert.deepEqual(getPixel(raster, 1, 0), [...DARK, 255]);
    assert.deepEqual(getPixel(raster, 0, 1), [...LIGHT, 255]);
    assert.deepEqual(getPixel(raster, 1, 1), [0, 0, 0, 0]);
    assert.deepEqual([...opaqueMask(raster)], [1, 1, 1, 0]);
});

// An ear whose right edge is light, joined to a dome with a light top and a dark bottom.
function shadedLogo() {
    return pictureOf(200, 200, [
        [0, 20, 0, 60, 140],
        [2, 50, 0, 60, 140],
        [0, 20, 140, 180, 200],
        [2, 60, 140, 180, 147],
        [1, 20, 191, 180, 200],
    ]);
}

test('the shading the picture already has is measured: the dome\'s dark and light bands and the ear\'s light edge', () => {
    const measured = measureShading({ toneIndex: shadedLogo(), width: 200, height: 200, roles: BASE, dome: { left: 20, right: 179 } });
    assert.equal(measured.domeDark, 9);
    assert.equal(measured.domeLight, 7);
    assert.equal(measured.earLight, 10);
    assert.ok(measured.samples.dark > 0 && measured.samples.light > 0 && measured.samples.ear > 0);
});

test('a picture with nothing in it cannot be measured', () => {
    assert.throws(() => measureShading({ toneIndex: new Int8Array(100).fill(-1), width: 10, height: 10, roles: BASE, dome: { left: 0, right: 9 } }), /empty/);
});
