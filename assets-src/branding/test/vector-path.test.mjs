import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatNumber, parsePath, readVtracerPaths, serialisePath, translatePath } from '../scripts/lib/vector-path.mjs';

test('path data is read as commands with their points, and a number after M is a line', () => {
    assert.deepEqual(parsePath('M0 0 C1 2 3 4 5 6 L7 8 Z'), [
        { command: 'M', points: [[0, 0]] },
        { command: 'C', points: [[1, 2], [3, 4], [5, 6]] },
        { command: 'L', points: [[7, 8]] },
        { command: 'Z', points: [] },
    ]);
    assert.deepEqual(parsePath('M0,0 10,5 20,5').map(({ command }) => command), ['M', 'L', 'L']);
    assert.deepEqual(parsePath('M-1.5 .5 C0.4 -0 0.4 -0 2.2 -0').map(({ points }) => points.length), [1, 3]);
});

test('anything but absolute M, L, C and Z is refused, so a path is never half understood', () => {
    assert.throws(() => parsePath('M0 0 c1 1 2 2 3 3'), /relative/);
    assert.throws(() => parsePath('M0 0 H5'), /something this tool does not read/);
    assert.throws(() => parsePath('M0 0 C1 2 3'), /does not fit/);
    assert.throws(() => parsePath('1 2 M0 0'), /starts with a number/);
});

test('numbers are as short as they can be: no trailing zeros, no leading zero and no negative zero', () => {
    assert.equal(formatNumber(0.5, 1), '.5');
    assert.equal(formatNumber(-0.54, 1), '-.5');
    assert.equal(formatNumber(12.04, 1), '12');
    assert.equal(formatNumber(-0.01, 1), '0');
    assert.equal(formatNumber(3.14159, 2), '3.14');
});

test('a path is written as an absolute start and relative commands, with letters and separators left out where the grammar allows', () => {
    const commands = parsePath('M10 10 C12 10 14 12 14 14 C14 16 12 18 10 18 L10 10 Z');
    assert.equal(serialisePath(commands), 'M10 10c2 0 4 2 4 4 0 2-2 4-4 4l0-8z');
});

test('rounding does not add up: every offset is taken from the rounded position', () => {
    const points = Array.from({ length: 40 }, (_, at) => `L${at * 0.34} 0`).join('');
    const path = serialisePath(parsePath(`M0 0${points}`), 1);
    const offsets = path.replace(/^M0 0l/, '').match(/-?\.?\d+\.?\d*/g).filter((_, at) => at % 2 === 0).map(Number);
    const total = offsets.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(total - 39 * 0.34) <= 0.05 + 1e-9, `ends ${total.toFixed(2)} from where it should`);
});

test('a second subpath starts at its own absolute point, and its offsets follow from there', () => {
    const path = serialisePath(parsePath('M0 0 L5 0 L5 5 Z M20 20 L25 20 L25 25 Z'));
    assert.equal(path, 'M0 0l5 0 0 5zM20 20l5 0 0 5z');
});

test('a translate is baked into the points, so no transform is left in the SVG', () => {
    const moved = translatePath(parsePath('M0 0 L2 1 Z'), 10.5, -3);
    assert.equal(serialisePath(moved), 'M10.5-3l2 1z');
});

test('the paths, fills and translates are read from what VTracer writes, and an unknown transform is refused', () => {
    const svg = '<?xml version="1.0"?>\n<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="8" height="8">\n<path d="M0 0 L1 1 Z" fill="#8B64AA" transform="translate(2,3.5)"/>\n<path d="M0 0 L1 1 Z" fill="#000000"/>\n</svg>';
    assert.deepEqual(readVtracerPaths(svg), [
        { d: 'M0 0 L1 1 Z', fill: '#8B64AA', dx: 2, dy: 3.5 },
        { d: 'M0 0 L1 1 Z', fill: '#000000', dx: 0, dy: 0 },
    ]);
    assert.throws(() => readVtracerPaths('<path d="M0 0" fill="#000" transform="rotate(5)"/>'), /transform this tool does not read/);
    assert.throws(() => readVtracerPaths('<path fill="#000"/>'), /no d or no fill/);
});
