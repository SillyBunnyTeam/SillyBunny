import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { outerRunsClockwise } from '../scripts/lib/geometry.mjs';
import { srgbToOklab } from '../scripts/lib/pixel-colour.mjs';
import {
    CIRCLE_FILL,
    LIP_SHARE,
    PLATE_SIDE,
    SQUARE_FILL,
    SQUIRCLE_EXPONENT,
    enclosingCircle,
    hueOf,
    oklchToHex,
    placeEmblem,
    plateColours,
    plateOutline,
    plateSvg,
    squirclePath,
} from '../scripts/lib/plate.mjs';

const rgbOf = (hex) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
const lchOf = (hex) => {
    const [lightness, a, b] = srgbToOklab(rgbOf(hex));
    return { lightness, chroma: Math.hypot(a, b), hue: hueOf(hex) };
};
const hueGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const cubicAt = ([p0, p1, p2, p3], t) => [0, 1].map((axis) => (1 - t) ** 3 * p0[axis] + 3 * (1 - t) ** 2 * t * p1[axis] + 3 * (1 - t) * t ** 2 * p2[axis] + t ** 3 * p3[axis]);

test('the brand hue is read from the colour in OKLCH degrees', () => {
    assert.ok(Math.abs(hueOf('#8b64aa') - 308.85) < 0.05, `${hueOf('#8b64aa')}`);
    assert.ok(Math.abs(hueOf('#ff0000') - 29.2) < 0.3);
});

test('an OKLCH colour in the gamut comes back as asked, and one outside it keeps its lightness and hue and loses chroma', () => {
    const inside = lchOf(oklchToHex(0.6, 0.08, 120));
    assert.ok(Math.abs(inside.lightness - 0.6) < 0.01 && Math.abs(inside.chroma - 0.08) < 0.005 && hueGap(inside.hue, 120) < 1);
    const outside = lchOf(oklchToHex(0.9, 0.4, 150));
    assert.ok(Math.abs(outside.lightness - 0.9) < 0.015 && outside.chroma < 0.4 && outside.chroma > 0.1 && hueGap(outside.hue, 150) < 2, JSON.stringify(outside));
    assert.equal(oklchToHex(1, 0, 0), '#ffffff');
    assert.match(oklchToHex(0, 0.3, 200), /^#00000[01]$/, 'black has no chroma to keep');
});

test('the pale plate is lavender and not white, the deep one is plum, both have the brand hue, and each lip is darker than its plate', () => {
    const colours = plateColours('#8b64aa');
    const pale = lchOf(colours.L.plate);
    const deep = lchOf(colours.D.plate);
    assert.ok(Math.abs(pale.lightness - 0.95) < 0.015 && pale.chroma > 0.02, JSON.stringify(pale));
    assert.ok(Math.abs(deep.lightness - 0.22) < 0.015 && deep.chroma > 0.03, JSON.stringify(deep));
    for (const colour of [colours.L.plate, colours.D.plate, colours.L.lip, colours.D.lip]) {
        assert.match(colour, /^#[0-9a-f]{6}$/);
        assert.ok(hueGap(hueOf(colour), hueOf('#8b64aa')) < 3, `${colour} is off the brand hue`);
    }
    assert.notEqual(colours.L.plate, '#ffffff');
    assert.ok(lchOf(colours.L.lip).lightness < pale.lightness - 0.03);
    assert.ok(lchOf(colours.D.lip).lightness < deep.lightness - 0.03);
    assert.deepEqual(plateColours('#8b64aa'), colours, 'the same colour in gives the same colours out');
});

test('the squircle passes through its four tops and stays on |x|^5 + |y|^5 = 1 within a few hundredths of a pixel, drawn clockwise', () => {
    const half = 512;
    const commands = squirclePath(512, 512, half);
    assert.ok(outerRunsClockwise(commands));
    assert.deepEqual(commands[0].points[0], [1024, 512]);
    let worst = 0;
    let start = commands[0].points[0];
    let reach = [Infinity, -Infinity];
    for (const { command, points } of commands) {
        if (command !== 'C') {
            continue;
        }
        for (let t = 0; t <= 1; t += 0.1) {
            const [x, y] = cubicAt([start, ...points], t);
            const [nx, ny] = [(x - 512) / half, (y - 512) / half];
            const radiusRatio = (Math.abs(nx) ** SQUIRCLE_EXPONENT + Math.abs(ny) ** SQUIRCLE_EXPONENT) ** (1 / SQUIRCLE_EXPONENT);
            worst = Math.max(worst, Math.abs(radiusRatio - 1) * half);
            reach = [Math.min(reach[0], x, y), Math.max(reach[1], x, y)];
        }
        start = points[2];
    }
    assert.ok(worst < 0.03, `${worst} px off`);
    assert.ok(reach[0] > -0.01 && reach[1] < 1024.01, 'it stays inside its square');
    assert.equal(commands.filter(({ command }) => command === 'C').length, 64);
});

test('the plate outline is the squircle or the circle and anything else is refused', () => {
    assert.deepEqual(plateOutline('square', 100), squirclePath(50, 50, 50));
    assert.deepEqual(plateOutline('circle', 100).map(({ command }) => command), ['M', 'C', 'C', 'C', 'C', 'Z']);
    assert.throws(() => plateOutline('hexagon'), /use square or circle/);
});

test('the smallest circle round some points about an axis is found, with the height that gives it', () => {
    // The points of a circle of radius 10 centred at (50, 30), and an extra one low on the axis: the best centre still sits mid way.
    const ring = Array.from({ length: 36 }, (_, step) => [50 + 10 * Math.cos(step / 36 * 2 * Math.PI), 30 + 10 * Math.sin(step / 36 * 2 * Math.PI)]);
    const { y, radius } = enclosingCircle(ring, 50);
    assert.ok(Math.abs(y - 30) < 0.01 && Math.abs(radius - 10) < 0.01);
    const tall = enclosingCircle([[50, 0], [50, 100], [60, 50]], 50);
    assert.ok(Math.abs(tall.y - 50) < 0.01 && Math.abs(tall.radius - 50) < 0.01);
    assert.throws(() => enclosingCircle([], 0), /no points/);
});

test('on the squircle the emblem takes 80% of the plate by its larger side and is centred on the front face, up by half the lip', () => {
    const box = { x: 100, y: 40, width: 800, height: 900 };
    const placed = placeEmblem({ shape: 'square', box, domeX: 480, edge: [] });
    assert.ok(Math.abs(placed.scale - (SQUARE_FILL * PLATE_SIDE) / 900) < 1e-12, 'the height is the larger side');
    assert.deepEqual([placed.x, placed.y], [480, 490]);
    assert.equal(placed.lip, PLATE_SIDE * LIP_SHARE);
    assert.equal(placed.centreY, PLATE_SIDE / 2 - placed.lip / 2);
    const wide = placeEmblem({ shape: 'square', box: { x: 0, y: 0, width: 1000, height: 400 }, domeX: 300, edge: [] });
    assert.ok(Math.abs(wide.scale - (SQUARE_FILL * PLATE_SIDE) / 1400) < 1e-12, 'twice the reach from the dome axis (700) is the larger side');
});

test('on the circle the emblem is scaled so that its smallest enclosing circle is 94% of the plate radius', () => {
    const edge = [[400, 100], [600, 100], [400, 900], [600, 900], [500, 500]];
    const placed = placeEmblem({ shape: 'circle', box: { x: 400, y: 100, width: 200, height: 800 }, domeX: 500, edge });
    const { radius, y } = enclosingCircle(edge, 500);
    assert.ok(Math.abs(placed.radius - radius) < 1e-9 && Math.abs(placed.y - y) < 1e-9);
    assert.ok(Math.abs(placed.scale * radius - CIRCLE_FILL * PLATE_SIDE / 2) < 1e-9);
    assert.throws(() => placeEmblem({ shape: 'oval', box: { x: 0, y: 0, width: 1, height: 1 }, domeX: 0, edge: [] }), /use square or circle/);
});

test('the plate is drawn in its lip colour with the plate colour over it, cut to its outline and raised, and the emblem on top in order', async () => {
    const layers = [
        { fill: '#8b64aa', commands: [{ command: 'M', points: [[400, 300]] }, { command: 'L', points: [[600, 300]] }, { command: 'L', points: [[600, 500]] }, { command: 'L', points: [[400, 500]] }, { command: 'Z', points: [] }] },
        { fill: '#5b3c6b', commands: [{ command: 'M', points: [[450, 350]] }, { command: 'L', points: [[480, 350]] }, { command: 'L', points: [[480, 380]] }, { command: 'Z', points: [] }] },
    ];
    const placement = { scale: 1, x: 500, y: 400, centreY: 512 - 15.36, lip: 30.72 };
    const colours = { plate: '#f5e9ff', lip: '#e4d2f5' };
    for (const shape of ['circle', 'square']) {
        const svg = plateSvg({ shape, colours, layers, placement });
        assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1024 1024">/);
        assert.deepEqual([...svg.matchAll(/<(?:path|use) [^>]*?fill="(#[0-9a-f]{6})"/g)].map((match) => match[1]), ['#e4d2f5', '#f5e9ff', '#8b64aa', '#5b3c6b']);
        assert.equal(svg.match(/ d="/g).length, 3, 'the outline is written once, and the two emblem layers once each');
        assert.match(svg, /<clipPath id="c"><use href="#o"\/><\/clipPath>/);
        assert.match(svg, /<g clip-path="url\(#c\)"><use href="#o" fill="#f5e9ff" y="-30\.72"\/><\/g>/);
        const { data, info } = await sharp(Buffer.from(svg), { density: 72 }).resize(1024, 1024).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const pixel = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
        assert.deepEqual(pixel(512, 200).slice(0, 3), rgbOf('#f5e9ff'), `${shape}: the front face`);
        assert.deepEqual(pixel(512, 1010).slice(0, 3), rgbOf('#e4d2f5'), `${shape}: the lip along the bottom`);
        assert.deepEqual(pixel(512, 512 - 15 + 5).slice(0, 3), rgbOf('#8b64aa'), `${shape}: the emblem, moved to the centre of the front face`);
        assert.equal(pixel(512, 1020)[3], 255, `${shape}: the lip reaches the bottom of the plate`);
        assert.equal(pixel(512, 3)[3], 255, `${shape}: and the plate its top`);
        assert.equal(pixel(3, 3)[3], 0, `${shape}: the corner is clear`);
    }
});
