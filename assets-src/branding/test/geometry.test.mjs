import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    arcCubics,
    circleCommands,
    clipByLine,
    dropCollinear,
    loopCommands,
    maskOutlines,
    mirrorCommands,
    orientSubpaths,
    outerRunsClockwise,
    reverseSubpath,
    shortSpan,
    signedArea,
    splitSubpaths,
    transformCommands,
} from '../scripts/lib/geometry.mjs';

const maskOf = (rows) => {
    const mask = Uint8Array.from(rows.join('').split('').map((cell) => (cell === '#' ? 1 : 0)));
    return { mask, width: rows[0].length, height: rows.length };
};

const cubicAt = ([p0, p1, p2, p3], t) => [0, 1].map((axis) => (1 - t) ** 3 * p0[axis] + 3 * (1 - t) ** 2 * t * p1[axis] + 3 * (1 - t) * t ** 2 * p2[axis] + t ** 3 * p3[axis]);

test('a loop that runs clockwise on screen has a positive area, and the other way round a negative one', () => {
    assert.equal(signedArea([[0, 0], [4, 0], [4, 3], [0, 3]]), 12);
    assert.equal(signedArea([[0, 0], [0, 3], [4, 3], [4, 0]]), -12);
});

test('vertices on the straight line between their neighbours are dropped, repeatedly', () => {
    assert.deepEqual(dropCollinear([[0, 0], [2, 0], [4, 0], [4, 4], [0, 4], [0, 2]]), [[0, 0], [4, 0], [4, 4], [0, 4]]);
});

test('the outline of an L shaped mask is one clockwise loop of six corners at the pixel edges', () => {
    const { mask, width, height } = maskOf(['#..', '#..', '###']);
    const loops = maskOutlines(mask, width, height);
    assert.equal(loops.length, 1);
    assert.equal(loops[0].length, 6);
    assert.equal(signedArea(loops[0]), 5);
    assert.deepEqual([...loops[0]].sort((a, b) => a[0] - b[0] || a[1] - b[1]), [[0, 0], [0, 3], [1, 0], [1, 2], [3, 2], [3, 3]]);
});

test('a hole in a mask is its own loop running the other way, and the origin moves every point', () => {
    const { mask, width, height } = maskOf(['###', '#.#', '###']);
    const loops = maskOutlines(mask, width, height, 10, 20);
    assert.deepEqual(loops.map(signedArea).sort((a, b) => a - b), [-1, 9]);
    assert.ok(loops.every((loop) => loop.every(([x, y]) => x >= 10 && x <= 13 && y >= 20 && y <= 23)));
});

test('two cells that only touch at a corner are two shapes, not one pinched shape', () => {
    const { mask, width, height } = maskOf(['#.', '.#']);
    const loops = maskOutlines(mask, width, height);
    assert.deepEqual(loops.map(signedArea), [1, 1]);
});

test('a loop is cut by a slanted line with exact new corners, and keeps the side asked for', () => {
    const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
    // x = 5 + 0.2 * (y - 0): the line leans right going down.
    const left = clipByLine(square, { at: 5, slope: 0.2, y0: 0, keep: 'left' });
    assert.equal(signedArea(left), 5 * 10 + 0.2 * 100 / 2);
    assert.ok(left.every(([x, y]) => x <= 5 + 0.2 * y + 1e-9));
    const right = clipByLine(square, { at: 5, slope: 0.2, y0: 0, keep: 'right' });
    assert.ok(Math.abs(signedArea(left) + signedArea(right) - 100) < 1e-9);
    assert.deepEqual(clipByLine(square, { at: 50, slope: 0, y0: 0, keep: 'left' }), square);
    assert.deepEqual(clipByLine(square, { at: -5, slope: 0, y0: 0, keep: 'left' }), []);
});

test('an arc is made of cubic curves that start and end on the circle and stay on it', () => {
    const circle = { cx: 30, cy: -20, r: 25 };
    const curves = arcCubics(circle, 0.3, 4);
    assert.equal(curves.length, 3, 'one curve for each quarter turn or less');
    let start = [circle.cx + circle.r * Math.cos(0.3), circle.cy + circle.r * Math.sin(0.3)];
    for (const { points } of curves) {
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            const [x, y] = cubicAt([start, ...points], t);
            assert.ok(Math.abs(Math.hypot(x - circle.cx, y - circle.cy) - circle.r) < circle.r * 3e-4, `t = ${t}`);
        }
        start = points[2];
    }
    assert.ok(Math.hypot(start[0] - (circle.cx + circle.r * Math.cos(4)), start[1] - (circle.cy + circle.r * Math.sin(4))) < 1e-9);
    const backwards = arcCubics(circle, 4, 0.3);
    assert.equal(backwards.length, 3);
    assert.ok(Math.hypot(backwards[2].points[2][0] - (circle.cx + circle.r * Math.cos(0.3)), backwards[2].points[2][1] - (circle.cy + circle.r * Math.sin(0.3))) < 1e-9, 'a backwards arc ends where the forward one began');
});

test('a circle is one closed subpath of four curves, clockwise unless asked otherwise', () => {
    const circle = { cx: 5, cy: 5, r: 3 };
    const commands = circleCommands(circle);
    assert.deepEqual(commands.map(({ command }) => command), ['M', 'C', 'C', 'C', 'C', 'Z']);
    assert.ok(outerRunsClockwise(commands));
    assert.ok(!outerRunsClockwise(circleCommands(circle, false)));
});

test('the short way round between two angles is under half a turn', () => {
    assert.ok(Math.abs(shortSpan(0.1, 6.2) - (6.2 - 0.1 - 2 * Math.PI)) < 1e-12);
    assert.ok(Math.abs(shortSpan(3, 3.5) - 0.5) < 1e-12);
});

test('a polygon with an arc edge ends each edge exactly on its vertex and bulges along the circle', () => {
    const circle = { cx: 0, cy: 0, r: 10 };
    const a = [10 * Math.cos(-0.5), 10 * Math.sin(-0.5)];
    const b = [10 * Math.cos(0.5), 10 * Math.sin(0.5)];
    const commands = loopCommands([a, b, [20, 5], [20, -5]], new Map([[0, circle]]));
    assert.deepEqual(commands.map(({ command }) => command), ['M', 'C', 'L', 'L', 'Z']);
    assert.deepEqual(commands[1].points[2], b);
    const [x, y] = cubicAt([a, ...commands[1].points], 0.5);
    assert.ok(Math.abs(Math.hypot(x, y) - 10) < 0.01 && x > 0);
});

test('a subpath reversed twice is itself, and one run the other way is turned back clockwise', () => {
    const square = loopCommands([[0, 0], [4, 0], [4, 4], [0, 4]]);
    assert.ok(outerRunsClockwise(square));
    const reversed = reverseSubpath(square);
    assert.ok(!outerRunsClockwise(reversed));
    assert.deepEqual(reverseSubpath(reversed), square);
    const mixed = [...square, ...reversed];
    assert.deepEqual(splitSubpaths(orientSubpaths(mixed, true)).map((subpath) => outerRunsClockwise(subpath)), [true, true]);
    assert.deepEqual(splitSubpaths(orientSubpaths(mixed, false)).map((subpath) => outerRunsClockwise(subpath)), [false, false]);
});

test('a curved subpath is reversed with its control points in the right order', () => {
    const commands = [{ command: 'M', points: [[0, 0]] }, { command: 'C', points: [[1, 2], [3, 2], [4, 0]] }, { command: 'L', points: [[0, 5]] }, { command: 'Z', points: [] }];
    assert.deepEqual(reverseSubpath(commands), [
        { command: 'M', points: [[0, 5]] },
        { command: 'L', points: [[4, 0]] },
        { command: 'C', points: [[3, 2], [1, 2], [0, 0]] },
        { command: 'Z', points: [] },
    ]);
});

test('the orientation of a shape is that of its biggest subpath, so a hole does not decide it', () => {
    const outer = loopCommands([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const hole = reverseSubpath(loopCommands([[3, 3], [6, 3], [6, 6], [3, 6]]));
    assert.ok(outerRunsClockwise([...hole, ...outer]));
    assert.throws(() => outerRunsClockwise([]), /no shape/);
});

test('shapes are mirrored about a line and scaled and moved point by point', () => {
    const commands = [{ command: 'M', points: [[1, 2]] }, { command: 'L', points: [[3, 4]] }];
    assert.deepEqual(mirrorCommands(commands, 'x', 5), [{ command: 'M', points: [[9, 2]] }, { command: 'L', points: [[7, 4]] }]);
    assert.deepEqual(mirrorCommands(commands, 'y', 5), [{ command: 'M', points: [[1, 8]] }, { command: 'L', points: [[3, 6]] }]);
    assert.deepEqual(transformCommands(commands, 2, 10, -1), [{ command: 'M', points: [[12, 3]] }, { command: 'L', points: [[16, 7]] }]);
});
