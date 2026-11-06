import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reverseSubpath, signedArea, splitSubpaths } from '../scripts/lib/geometry.mjs';
import { refitOutlines } from '../scripts/lib/curve-refit.mjs';
import { samplePath } from '../scripts/lib/outline-fit.mjs';

/** A circle as `count` cubic arcs, which is more pieces than a circle needs. */
function manyArcs(cx, cy, r, count, wobble = 0) {
    const step = (2 * Math.PI) / count;
    const k = (4 / 3) * Math.tan(step / 4);
    const radius = (at) => r + (wobble === 0 ? 0 : wobble * Math.sin(at * 7.3));
    const point = (at, along = 0) => {
        const angle = at * step;
        const [rr, other] = [radius(at), angle + Math.PI / 2];
        return [cx + rr * Math.cos(angle) + along * rr * Math.cos(other), cy + rr * Math.sin(angle) + along * rr * Math.sin(other)];
    };
    const commands = [{ command: 'M', points: [point(0)] }];
    for (let at = 0; at < count; at++) {
        commands.push({ command: 'C', points: [point(at, k), point(at + 1, -k), point((at + 1) % count)] });
    }
    return [...commands, { command: 'Z', points: [] }];
}

const countOf = (commands, name) => commands.filter(({ command }) => command === name).length;
const distanceToCircle = ([x, y], cx, cy, r) => Math.abs(Math.hypot(x - cx, y - cy) - r);

test('a circle drawn in many short curves is redrawn in a few, within the tolerance of the original and closed', () => {
    const original = manyArcs(100, 100, 80, 96);
    const result = refitOutlines(original, { tolerance: 0.25 });
    assert.ok(countOf(result, 'C') >= 4 && countOf(result, 'C') <= 12, `${countOf(result, 'C')} curves`);
    assert.equal(result[0].command, 'M');
    assert.equal(result.at(-1).command, 'Z');
    const worst = Math.max(...samplePath(result).map((point) => distanceToCircle(point, 100, 100, 80)));
    assert.ok(worst < 0.3, `${worst} px from the circle`);
});

test('curves that join smoothly in the original join smoothly in the result', () => {
    const result = refitOutlines(manyArcs(100, 100, 80, 96), { tolerance: 0.25 });
    const curves = result.filter(({ command }) => command === 'C');
    let start = result[0].points[0];
    const tangents = curves.map(({ points: [first, second, end] }) => {
        const out = [first[0] - start[0], first[1] - start[1]];
        const into = [end[0] - second[0], end[1] - second[1]];
        start = end;
        return { out, into };
    });
    tangents.forEach((tangent, at) => {
        const next = tangents[(at + 1) % tangents.length];
        const angle = Math.acos(Math.min(1, (tangent.into[0] * next.out[0] + tangent.into[1] * next.out[1]) / (Math.hypot(...tangent.into) * Math.hypot(...next.out))));
        assert.ok(angle < 0.02, `joint ${at} turns ${angle} rad`);
    });
});

test('a wobbling outline is redrawn smoother than it came, within the tolerance', () => {
    const original = manyArcs(100, 100, 80, 240, 0.12);
    const result = refitOutlines(original, { tolerance: 0.35 });
    assert.ok(countOf(result, 'C') <= 24, `${countOf(result, 'C')} curves for ${countOf(original, 'C')}`);
    const originalPoints = samplePath(original);
    const worst = Math.max(...samplePath(result).map((point) => Math.min(...originalPoints.map((other) => Math.hypot(point[0] - other[0], point[1] - other[1])))));
    assert.ok(worst < 0.4, `${worst} px from the original`);
});

const rounded = () => [
    { command: 'M', points: [[10, 0]] },
    { command: 'L', points: [[90, 0]] },
    { command: 'C', points: [[95.5, 0], [100, 4.5], [100, 10]] },
    { command: 'L', points: [[100, 90]] },
    { command: 'C', points: [[100, 95.5], [95.5, 100], [90, 100]] },
    { command: 'L', points: [[10, 100]] },
    { command: 'C', points: [[4.5, 100], [0, 95.5], [0, 90]] },
    { command: 'L', points: [[0, 10]] },
    { command: 'C', points: [[0, 4.5], [4.5, 0], [10, 0]] },
    { command: 'Z', points: [] },
];

test('straight lines stay as they were, with the same end points', () => {
    const result = refitOutlines(rounded(), { tolerance: 0.25 });
    const lines = result.filter(({ command }) => command === 'L').map(({ points }) => points[0]);
    for (const end of [[90, 0], [100, 90], [10, 100], [0, 10]]) {
        assert.ok(lines.some(([x, y]) => x === end[0] && y === end[1]), `a line to ${end}`);
    }
});

test('a corner between two curves stays a corner', () => {
    // Two arcs that meet at the top at a right angle, like the tip of a leaf.
    const tip = [
        { command: 'M', points: [[50, 0]] },
        { command: 'C', points: [[70, 20], [80, 50], [50, 100]] },
        { command: 'C', points: [[20, 50], [30, 20], [50, 0]] },
        { command: 'Z', points: [] },
    ];
    const result = refitOutlines(tip, { tolerance: 0.25 });
    const curves = result.filter(({ command }) => command === 'C');
    const first = curves[0].points;
    const last = curves.at(-1).points;
    const out = [first[0][0] - 50, first[0][1] - 0];
    const into = [last[2][0] - last[1][0], last[2][1] - last[1][1]];
    const angle = Math.acos((out[0] * into[0] + out[1] * into[1]) / (Math.hypot(...out) * Math.hypot(...into)));
    assert.ok(angle > 0.5, `the corner turns ${angle} rad`);
    assert.deepEqual(result[0].points[0], [50, 0]);
});

test('each subpath keeps its direction, so a hole stays a hole', () => {
    const ring = [...manyArcs(100, 100, 80, 48), ...reverseSubpath(manyArcs(100, 100, 30, 48))];
    const before = splitSubpaths(ring).map((subpath) => Math.sign(signedArea(samplePath(subpath))));
    const result = refitOutlines(ring, { tolerance: 0.25 });
    const after = splitSubpaths(result).map((subpath) => Math.sign(signedArea(samplePath(subpath))));
    assert.deepEqual(after, before);
    assert.equal(after.length, 2);
    assert.ok(after[0] * after[1] < 0);
});

test('nothing in gives nothing out, and a tolerance that is not positive is an error', () => {
    assert.deepEqual(refitOutlines([], { tolerance: 0.25 }), []);
    assert.throws(() => refitOutlines(manyArcs(0, 0, 10, 8), { tolerance: 0 }), /tolerance/);
});
