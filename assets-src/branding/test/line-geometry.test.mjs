import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { outerRunsClockwise } from '../scripts/lib/geometry.mjs';
import { buildLineShapes, lineRects } from '../scripts/lib/line-geometry.mjs';
import { serialisePath } from '../scripts/lib/vector-path.mjs';

const SIDE = 200;
// A line that leaves a dot on the left, runs right, turns down and runs right again into a dome whose edge is the line x = 160.
const LEFT_LINE = {
    dot: { cx: 30, cy: 40.5, r: 14 },
    towards: 1,
    width: 7,
    vertices: [[30, 40.5], [80.5, 40.5], [80.5, 90.5], [170, 90.5]],
    edge: { at: 160, slope: 0, bend: 0, y0: 90.5 },
};
// The mirror image: the dot on the right and the dome on its left.
const RIGHT_LINE = {
    dot: { cx: 170, cy: 40.5, r: 14 },
    towards: -1,
    width: 7,
    vertices: [[170, 40.5], [119.5, 40.5], [119.5, 90.5], [30, 90.5]],
    edge: { at: 40, slope: 0, bend: 0, y0: 90.5 },
};

const svgOf = (commandsByFill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIDE} ${SIDE}">${commandsByFill.map(([fill, commands]) => `<path fill="${fill}" d="${serialisePath(commands, 3)}"/>`).join('')}</svg>`;
const render = async (svg) => {
    const data = await sharp(Buffer.from(svg), { density: 72 }).resize(SIDE, SIDE).ensureAlpha().raw().toBuffer();
    return Uint8Array.from({ length: SIDE * SIDE }, (_, at) => (data[at * 4 + 3] >= 128 ? 1 : 0));
};

/** The same stroke and dot as masks, and the dark and light edges worked out pixel by pixel from the rule: what is drawn, shifted. */
function expected(fit, { kDark, kLight }) {
    const inRect = ({ x0, y0, x1, y1 }, x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const rects = lineRects(fit);
    const whole = (x, y) => rects.some((rect) => inRect(rect, x, y)) || Math.hypot(x + 0.5 - fit.dot.cx, y + 0.5 - fit.dot.cy) <= fit.dot.r;
    const dome = (x) => (fit.towards === 1 ? x + 0.5 >= fit.edge.at : x + 0.5 <= fit.edge.at);
    const base = new Uint8Array(SIDE * SIDE);
    const dark = new Uint8Array(SIDE * SIDE);
    const light = new Uint8Array(SIDE * SIDE);
    for (let y = 0; y < SIDE; y++) {
        for (let x = 0; x < SIDE; x++) {
            if (!whole(x, y)) {
                continue;
            }
            base[y * SIDE + x] = 1;
            if (dome(x)) {
                continue;
            }
            if (!whole(x, y + kDark)) {
                dark[y * SIDE + x] = 1;
            } else if (kLight > 0 && !whole(x, y - kLight)) {
                light[y * SIDE + x] = 1;
            }
        }
    }
    return { base, dark, light };
}

const differing = (a, b) => a.reduce((total, value, at) => total + (value === b[at] ? 0 : 1), 0);
const area = (mask) => mask.reduce((total, value) => total + value, 0);

for (const [name, fit] of [['from the left', LEFT_LINE], ['from the right', RIGHT_LINE]]) {
    test(`the line ${name} is drawn as exact shapes: the stroke and dot, the dark lower edge and the light upper edge`, async () => {
        const bands = { kDark: 3, kLight: 2 };
        const shapes = buildLineShapes(fit, bands);
        const wanted = expected(fit, bands);
        // The base shape runs on under the dome, so it is compared only on the dot side of the edge.
        const outsideDome = Uint8Array.from({ length: SIDE * SIDE }, (_, at) => ((fit.towards === 1 ? (at % SIDE) + 0.5 < fit.edge.at : (at % SIDE) + 0.5 > fit.edge.at) ? 1 : 0));
        const drawn = {};
        for (const key of ['base', 'dark', 'light']) {
            drawn[key] = (await render(svgOf([['#000', shapes[key]]]))).map((value, at) => value * outsideDome[at]);
            wanted[key] = wanted[key].map((value, at) => value * outsideDome[at]);
            // Only a pixel that an arc crosses near its middle can land on the other side of the rule, so at most a few differ.
            assert.ok(differing(drawn[key], wanted[key]) <= 3, `${key}: ${differing(drawn[key], wanted[key])} of ${area(wanted[key])} pixels differ`);
        }
        assert.ok(area(wanted.dark) > 300 && area(wanted.light) > 200, 'the bands are not empty');
    });

    test(`the edges of the line ${name} are on whole pixels, and every subpath runs clockwise`, () => {
        const { dark, light, base } = buildLineShapes(fit, { kDark: 3, kLight: 2 });
        for (const commands of [base, dark, light]) {
            assert.ok(outerRunsClockwise(commands));
        }
        // The first subpath of the base shape is the stroke: its corners are integers.
        const corners = base.slice(0, base.findIndex(({ command }) => command === 'Z')).flatMap(({ points }) => points);
        assert.ok(corners.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y)), JSON.stringify(corners));
    });
}

test('the stroke is a rectangle for each piece, with square corners and ends that run on by half a width rounded up', () => {
    assert.deepEqual(lineRects(LEFT_LINE), [
        { x0: 26, x1: 84, y0: 37, y1: 44 },
        { x0: 77, x1: 84, y0: 37, y1: 94 },
        { x0: 77, x1: 174, y0: 87, y1: 94 },
    ]);
});

test('a stroke off the half pixel grid, or a width that is not whole, is refused', () => {
    assert.throws(() => lineRects({ ...LEFT_LINE, vertices: [[30, 40.25], [80, 40.25]] }), /half pixels/);
    assert.throws(() => lineRects({ ...LEFT_LINE, width: 6.5 }), /half pixels/);
});

test('bands that are not whole pixels, or are wider than the line, are refused', () => {
    assert.throws(() => buildLineShapes(LEFT_LINE, { kDark: 0, kLight: 2 }), /whole numbers/);
    assert.throws(() => buildLineShapes(LEFT_LINE, { kDark: 2, kLight: -1 }), /whole numbers/);
    assert.throws(() => buildLineShapes(LEFT_LINE, { kDark: 8, kLight: 2 }), /wider than the line/);
});

test('with no light band there is no light shape, and the dark edge is the same as with one', async () => {
    const [plain, both] = [buildLineShapes(LEFT_LINE, { kDark: 3, kLight: 0 }), buildLineShapes(LEFT_LINE, { kDark: 3, kLight: 2 })];
    assert.deepEqual(plain.light, []);
    assert.deepEqual(plain.dark, both.dark);
    assert.ok(both.light.length > 0);
});

test('the dark and the light edge of a line never overlap, so the order they are drawn in does not matter', async () => {
    const { dark, light } = buildLineShapes(LEFT_LINE, { kDark: 3, kLight: 2 });
    const [darkMask, lightMask] = await Promise.all([render(svgOf([['#000', dark]])), render(svgOf([['#000', light]]))]);
    assert.equal(darkMask.reduce((total, value, at) => total + value * lightMask[at], 0), 0);
});
