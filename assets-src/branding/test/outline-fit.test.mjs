import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circleCommands, commandLoops, loopCommands, signedArea, splitSubpaths } from '../scripts/lib/geometry.mjs';
import { boxOf, boundaryDeviation, orientOutlines, samplePath, softField } from '../scripts/lib/outline-fit.mjs';

const rectMask = (width, height, [x0, y0, x1, y1]) => Uint8Array.from({ length: width * height }, (_, at) => {
    const [x, y] = [at % width, Math.floor(at / width)];
    return x >= x0 && x < x1 && y >= y0 && y < y1 ? 1 : 0;
});
const discMask = (width, height, cx, cy, r) => Uint8Array.from({ length: width * height }, (_, at) => (Math.hypot((at % width) + 0.5 - cx, Math.floor(at / width) + 0.5 - cy) <= r ? 1 : 0));
const square = (x0, y0, x1, y1) => loopCommands([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

test('a path is sampled along every segment, no further apart than asked, ending on its last point', () => {
    const samples = samplePath([{ command: 'M', points: [[0, 0]] }, { command: 'L', points: [[10, 0]] }, { command: 'C', points: [[10, 5], [15, 10], [20, 10]] }], 0.5);
    assert.deepEqual(samples[0], [0, 0]);
    assert.deepEqual(samples.at(-1), [20, 10]);
    assert.ok(samples.every((sample, at) => at === 0 || Math.hypot(sample[0] - samples[at - 1][0], sample[1] - samples[at - 1][1]) <= 0.55));
});

test('an outline on the edge of the pixels is no distance from them, and one moved half a pixel is half a pixel away, both ways', () => {
    const mask = rectMask(30, 30, [5, 5, 20, 25]);
    const exact = boundaryDeviation(square(5, 5, 20, 25), mask, 30, 30);
    assert.ok(exact.toRaster < 1e-9 && exact.fromRaster < 1e-9);
    const moved = boundaryDeviation(square(5.5, 5, 20.5, 25), mask, 30, 30);
    assert.ok(Math.abs(moved.toRaster - 0.5) < 0.02 && Math.abs(moved.fromRaster - 0.5) < 0.02, JSON.stringify(moved));
});

test('a circle through a staircase of pixels is about half a pixel from it', () => {
    const mask = discMask(80, 80, 40, 40, 25);
    const { toRaster, fromRaster } = boundaryDeviation(circleCommands({ cx: 40, cy: 40, r: 25 }), mask, 80, 80);
    assert.ok(toRaster < 0.75 && fromRaster < 0.75, `${toRaster}, ${fromRaster}`);
});

test('outsides are turned to the direction asked and the shapes inside them the other way, whatever way they came', () => {
    const outer = square(0, 0, 40, 40);
    const counter = loopCommands([[10, 10], [10, 20], [20, 20], [20, 10]]);
    for (const [first, second] of [[outer, counter], [counter, outer]]) {
        for (const clockwise of [true, false]) {
            const result = splitSubpaths(orientOutlines([...first, ...second], clockwise));
            const areas = result.map((subpath) => signedArea(commandLoops(subpath)[0]));
            const outerArea = areas.find((area) => Math.abs(area) === 1600);
            const counterArea = areas.find((area) => Math.abs(area) === 100);
            assert.equal(outerArea > 0, clockwise);
            assert.equal(counterArea > 0, !clockwise);
        }
    }
    assert.deepEqual(orientOutlines([], true), []);
});

test('a field is enlarged with an edge at the sub-pixel place its values describe, and the box of a mask is its smallest', async () => {
    const [width, height] = [20, 10];
    // A column edge 0.3 of the way into pixel 10: pixel 10 is 70% covered.
    const values = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 11; x < width; x++) {
            values[y * width + x] = 255;
        }
        values[y * width + 10] = 178;
    }
    const field = await softField(values, width, height, 4, 0.3);
    const row = Array.from({ length: width * 4 }, (_, x) => field[5 * width * 4 + x]);
    const cut = row.findIndex((value) => value >= 128) / 4;
    assert.ok(Math.abs(cut - 10.3) < 0.15, `the edge is at ${cut}`);
    assert.deepEqual(boxOf(rectMask(30, 20, [4, 6, 10, 9]), 30, 20), { left: 4, top: 6, right: 10, bottom: 9 });
    assert.equal(boxOf(new Uint8Array(12), 4, 3), undefined);
});
