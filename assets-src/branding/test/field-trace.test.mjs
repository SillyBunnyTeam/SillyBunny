import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { splitSubpaths } from '../scripts/lib/geometry.mjs';
import { lumaOf, silhouetteCoverage, toneLumaField, traceTones } from '../scripts/lib/field-trace.mjs';
import { findPotrace } from '../scripts/lib/potrace.mjs';
import { serialisePath } from '../scripts/lib/vector-path.mjs';

let potrace;
try {
    potrace = findPotrace();
} catch {
    potrace = undefined;
}
const needsPotrace = { skip: potrace ? false : 'potrace is not installed' };

const SIZE = 120;
const constant = (curve) => ({ coefficients: [curve], centre: 0, scale: 1 });

/** A block of rows 20 to 99 whose left edge is on column 30 and right edge on column 90, as an alpha picture and a body mask. */
function block() {
    const alpha = new Uint8Array(SIZE * SIZE);
    for (let y = 20; y < 100; y++) {
        for (let x = 30; x < 90; x++) {
            alpha[y * SIZE + x] = 255;
        }
    }
    return { alpha, body: Uint8Array.from(alpha, (value) => (value === 255 ? 1 : 0)) };
}

test('luma is the Rec. 709 weighting of red, green and blue', () => {
    assert.equal(lumaOf(0, 0, 0), 0);
    assert.ok(Math.abs(lumaOf(255, 255, 255) - 255) < 1e-9);
    assert.ok(Math.abs(lumaOf(139, 100, 170) - 113.3) < 0.5);
});

test('coverage is the alpha beside the shape, and nothing further out than the reach', () => {
    const { alpha, body } = block();
    alpha[50 * SIZE + 29] = 100;
    alpha[50 * SIZE + 20] = 200;
    const coverage = silhouetteCoverage({ alpha, body, width: SIZE, height: SIZE });
    assert.ok(Math.abs(coverage[50 * SIZE + 29] - 100 / 255) < 1e-6, 'a soft edge pixel beside the shape is kept');
    assert.equal(coverage[50 * SIZE + 20], 0, 'a stray pixel far from the shape is not');
    assert.equal(coverage[50 * SIZE + 60], 1);
});

test('inside the rows given, the side of the shape is drawn from its curve, with the part of a pixel the curve covers', () => {
    const { alpha, body } = block();
    // A notch of 4 pixels cut out of the left edge of the body, though the picture is opaque there, and a stub of 3 pixels outside the right edge.
    for (let y = 45; y < 60; y++) {
        for (let x = 30; x < 34; x++) {
            body[y * SIZE + x] = 0;
        }
        for (let x = 90; x < 93; x++) {
            alpha[y * SIZE + x] = 255;
        }
    }
    const curves = { left: constant(30.25), right: constant(89.5) };
    const coverage = silhouetteCoverage({ alpha, body, width: SIZE, height: SIZE, curves, rows: [30, 90] });
    const at = (x, y) => coverage[y * SIZE + x];
    assert.equal(at(29, 50), 0);
    assert.ok(Math.abs(at(30, 50) - 0.75) < 1e-9, 'the pixel the curve cuts is 75% covered');
    assert.equal(at(31, 50), 1, 'the notch is filled');
    assert.equal(at(88, 50), 1);
    assert.ok(Math.abs(at(89, 50) - 0.5) < 1e-9);
    assert.equal(at(90, 50), 0, 'the stub is gone');
    assert.equal(at(91, 50), 0);
});

test('the curve takes over gradually at the ends of the rows, so there is no jump where it starts', () => {
    const { alpha, body } = block();
    // A curve two pixels inside the picture's edge, as where a stub of a cut line sticks out.
    const curves = { left: constant(32), right: constant(90) };
    const coverage = silhouetteCoverage({ alpha, body, width: SIZE, height: SIZE, curves, rows: [50, 80] });
    const column = (y) => coverage[y * SIZE + 30];
    assert.equal(column(35), 1, 'well above the rows the picture is used as it is');
    assert.equal(column(50), 0);
    assert.equal(column(79), 0);
    assert.ok(column(49) > 0 && column(49) < 0.2 && column(45) > 0.3 && column(45) < 0.7, `${column(49)}, ${column(45)}`);
    assert.ok(column(80) > 0 && column(80) < 0.2);
});

test('past the rows the curve is not drawn where the picture has turned away from it, as at a corner', () => {
    const { alpha, body } = block();
    // From row 96 the left side runs off to the right at 6 pixels a row, like the bottom edge of the dome after its corner, and the curve goes on down.
    for (let y = 96; y < 100; y++) {
        for (let x = 30; x < 30 + 6 * (y - 95); x++) {
            alpha[y * SIZE + x] = 0;
            body[y * SIZE + x] = 0;
        }
    }
    const coverage = silhouetteCoverage({ alpha, body, width: SIZE, height: SIZE, curves: { left: constant(30), right: constant(90) }, rows: [30, 95] });
    for (let y = 96; y < 100; y++) {
        assert.equal(coverage[y * SIZE + 31], 0, `row ${y}, in the part the corner cut away`);
        assert.equal(coverage[y * SIZE + 30], 0);
    }
    assert.equal(coverage[94 * SIZE + 30], 1);
    assert.equal(coverage[105 * SIZE + 60], 0, 'and nothing is added below the shape');
});

test('a hole inside the shape stays a hole where the curve is drawn', () => {
    const { alpha, body } = block();
    for (let y = 55; y < 65; y++) {
        for (let x = 36; x < 46; x++) {
            alpha[y * SIZE + x] = 0;
            body[y * SIZE + x] = 0;
        }
    }
    const coverage = silhouetteCoverage({ alpha, body, width: SIZE, height: SIZE, curves: { left: constant(30), right: constant(90) }, rows: [30, 90] });
    assert.equal(coverage[60 * SIZE + 40], 0);
});

test('a picture and its index of the tones give the master luma where the pixel is unchanged and the tone luma where it was redrawn', () => {
    const [width, height] = [12, 12];
    const rgba = new Uint8Array(width * height * 4);
    const index = new Int8Array(width * height).fill(-1);
    const original = new Int8Array(width * height).fill(-1);
    for (let y = 3; y < 9; y++) {
        for (let x = 3; x < 9; x++) {
            const at = y * width + x;
            [index[at], original[at]] = [0, 0];
            rgba.set([100, 100, 100, 255], at * 4);
        }
    }
    // One pixel was redrawn as tone 1, and one was cleared.
    index[4 * width + 4] = 1;
    index[5 * width + 5] = -1;
    const lumas = [100, 40, 200];
    const field = toneLumaField({ rgba, width, height, index, original, lumas, fallback: 0 });
    assert.ok(Math.abs(field[6 * width + 6] - 100) < 1e-4, 'unchanged: master');
    assert.equal(field[4 * width + 4], 40, 'redrawn: the tone');
    assert.ok(Math.abs(field[3 * width + 3] - 100) < 1e-4, 'an edge pixel keeps its luma');
});

test('beside the shape the luma carries on outwards for a few pixels, and is the fallback tone further away', () => {
    const [width, height] = [40, 20];
    const rgba = new Uint8Array(width * height * 4);
    const index = new Int8Array(width * height).fill(-1);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < 20; x++) {
            index[y * width + x] = 2;
            rgba.set([200, 200, 200, 255], (y * width + x) * 4);
        }
    }
    const field = toneLumaField({ rgba, width, height, index, original: index, lumas: [100, 40, 200], fallback: 0 });
    assert.ok(Math.abs(field[10 * width + 21] - 200) < 1e-3, 'one pixel out');
    assert.ok(Math.abs(field[10 * width + 23] - 200) < 1e-3, 'four pixels out');
    assert.equal(field[10 * width + 30], 100, 'ten pixels out is the fallback');
});

/** A disc with a light cap on its top and a dark band on its bottom, as a coverage field and a luma field. */
function discPicture() {
    const [centre, radius] = [60, 40];
    const coverage = new Float32Array(SIZE * SIZE);
    const luma = new Float32Array(SIZE * SIZE).fill(100);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const distance = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
            coverage[y * SIZE + x] = Math.min(1, Math.max(0, radius + 0.5 - distance));
            luma[y * SIZE + x] = y < 38 ? 200 : y > 82 ? 40 : 100;
        }
    }
    return { coverage, luma };
}

const render = async (commands, fill) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE * 2}" height="${SIZE * 2}"><path fill="${fill}" d="${serialisePath(commands)}"/></svg>`;
    const { data } = await sharp(Buffer.from(svg)).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    return data;
};

test('three layers come back, and a band reaches no further past the shape than the overhang', needsPotrace, async () => {
    const { coverage, luma } = discPicture();
    const layers = await traceTones({ coverage, luma, width: SIZE, height: SIZE, levels: { dark: 40, base: 100, light: 200 } }, { potrace, directory: mkdtempSync(join(tmpdir(), 'sb-field-')) });
    assert.deepEqual(Object.keys(layers), ['base', 'letters', 'dark', 'light']);
    assert.deepEqual(layers.letters, [], 'a picture with no letters has none');
    const [base, dark, light] = await Promise.all([render(layers.base, '#000'), render(layers.dark, '#000'), render(layers.light, '#000')]);
    const across = SIZE * 2;
    // The render is at twice the size, so two of its pixels are one source pixel, which is more than the overhang.
    const nearShape = (x, y) => {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                if (base[(y + dy) * across + x + dx] > 128) {
                    return true;
                }
            }
        }
        return false;
    };
    let [stray, dark128, light128] = [0, 0, 0];
    for (let y = 2; y < across - 2; y++) {
        for (let x = 2; x < across - 2; x++) {
            const at = y * across + x;
            stray += (dark[at] > 128 || light[at] > 128) && !nearShape(x, y) ? 1 : 0;
            dark128 += dark[at] > 128 ? 1 : 0;
            light128 += light[at] > 128 ? 1 : 0;
        }
    }
    assert.equal(stray, 0, `${stray} pixels of a band are more than a pixel past the shape`);
    assert.ok(dark128 > 3000 && light128 > 3000, `${dark128}, ${light128}`);
});

test('where a band meets the edge of the shape the base tone does not show beside it', needsPotrace, async () => {
    const { coverage, luma } = discPicture();
    const layers = await traceTones({ coverage, luma, width: SIZE, height: SIZE, levels: { dark: 40, base: 100, light: 200 } }, { potrace, directory: mkdtempSync(join(tmpdir(), 'sb-field-')) });
    const [base, dark, light] = await Promise.all([render(layers.base, '#000'), render(layers.dark, '#000'), render(layers.light, '#000')]);
    const across = SIZE * 2;
    let [darkRim, lightRim] = [0, 0];
    for (let y = 0; y < across; y++) {
        for (let x = 0; x < across; x++) {
            const at = y * across + x;
            // Two rows in from where a band starts is inside it all the way, so any base tone there is a gap between the band and the edge.
            darkRim = y >= 2 * 86 ? Math.max(darkRim, base[at] - dark[at]) : darkRim;
            lightRim = y < 2 * 34 ? Math.max(lightRim, base[at] - light[at]) : lightRim;
        }
    }
    assert.ok(darkRim <= 25 && lightRim <= 25, `base shows ${darkRim} and ${lightRim} of 255 beside a band`);
});

test('the bands are where the luma says, and the base is the whole disc', needsPotrace, async () => {
    const { coverage, luma } = discPicture();
    const layers = await traceTones({ coverage, luma, width: SIZE, height: SIZE, levels: { dark: 40, base: 100, light: 200 } }, { potrace, directory: mkdtempSync(join(tmpdir(), 'sb-field-')) });
    const areas = Object.fromEntries(await Promise.all(Object.entries(layers).map(async ([name, commands]) => [name, (await render(commands, '#000')).reduce((sum, value) => sum + value, 0) / 255 / 4])));
    assert.ok(Math.abs(areas.base - Math.PI * 40 * 40) < 40, `${areas.base}`);
    // The cap above row 38 and the band from row 83 down are circular segments of a disc of radius 40 centred on row 60, and each reaches
    // a quarter of a pixel past the disc along its arc.
    const segment = (depth) => 40 * 40 * Math.acos((40 - depth) / 40) - (40 - depth) * Math.sqrt(40 * 40 - (40 - depth) ** 2);
    const withOverhang = (depth) => segment(depth) + 0.25 * 2 * 40 * Math.acos((40 - depth) / 40);
    assert.ok(Math.abs(areas.light - withOverhang(38 - 20)) < 40, `${areas.light} against ${withOverhang(18)}`);
    assert.ok(Math.abs(areas.dark - withOverhang(100 - 83)) < 40, `${areas.dark} against ${withOverhang(17)}`);
});

test('a hole in the shape comes back as a shape of its own, so the outline has no hole in it', needsPotrace, async () => {
    const { coverage, luma } = discPicture();
    for (let y = 55; y < 70; y++) {
        for (let x = 50; x < 70; x++) {
            coverage[y * SIZE + x] = 0;
        }
    }
    const { base, letters } = await traceTones({ coverage, luma, width: SIZE, height: SIZE, levels: { dark: 40, base: 100, light: 200 } }, { potrace, directory: mkdtempSync(join(tmpdir(), 'sb-field-')) });
    assert.equal(splitSubpaths(base).length, 1);
    assert.equal(splitSubpaths(letters).length, 1);
    const [outline, shape] = await Promise.all([render(base, '#000'), render(letters, '#000')]);
    // The hole is 20 by 15 pixels, which is 300.
    const holeArea = shape.reduce((sum, value) => sum + value, 0) / 255 / 4;
    assert.ok(Math.abs(holeArea - 300) < 12, `${holeArea}`);
    assert.ok(outline[2 * 62 * SIZE * 2 + 2 * 60] > 200, 'the outline is solid where the letters are');
});

test('the letters keep their straight sides and corners, with no more curve than a corner needs', needsPotrace, async () => {
    const { coverage, luma } = discPicture();
    for (let y = 50; y < 80; y++) {
        for (let x = 45; x < 55; x++) {
            coverage[y * SIZE + x] = 0;
        }
    }
    const { letters } = await traceTones({ coverage, luma, width: SIZE, height: SIZE, levels: { dark: 40, base: 100, light: 200 } }, { potrace, directory: mkdtempSync(join(tmpdir(), 'sb-field-')) });
    const ends = letters.filter(({ command }) => command !== 'Z').map(({ points }) => points[points.length - 1]);
    for (const [x, y] of [[45, 50], [55, 50], [55, 80], [45, 80]]) {
        assert.ok(ends.some((end) => Math.hypot(end[0] - x, end[1] - y) < 0.9), `a corner at ${x},${y} in ${JSON.stringify(ends.map((end) => end.map((value) => Math.round(value * 10) / 10)))}`);
    }
    assert.ok(letters.length <= 12, `${letters.length} commands for a rectangle`);
});

test('a tone with no pixels is an error that names the tone', needsPotrace, async () => {
    const { coverage } = discPicture();
    const luma = new Float32Array(SIZE * SIZE).fill(100);
    await assert.rejects(traceTones({ coverage, luma, width: SIZE, height: SIZE, levels: { dark: 40, base: 100, light: 200 } }, { potrace, directory: mkdtempSync(join(tmpdir(), 'sb-field-')) }), /no pixel of the dark tone/);
});

test('a picture with no coverage has nothing to trace', needsPotrace, async () => {
    await assert.rejects(traceTones({ coverage: new Float32Array(100), luma: new Float32Array(100), width: 10, height: 10, levels: { dark: 40, base: 100, light: 200 } }, { potrace, directory: mkdtempSync(join(tmpdir(), 'sb-field-')) }), /nothing to trace/);
});
