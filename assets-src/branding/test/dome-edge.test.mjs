import assert from 'node:assert/strict';
import { test } from 'node:test';
import { curveAt, edgeBoundary, findCrease, fitDomeSides, fitEdgeCurve, healDomeSides, slopeAt } from '../scripts/lib/dome-edge.mjs';

const WIDTH = 200;
const HEIGHT = 200;
const SEARCH = { left: [20, 100], right: [100, 180] };
// The dome's half width on row y: a parabola that narrows going up, and a straight wall from row 160 down.
const halfWidth = (y) => 60 - 0.004 * Math.max(0, 160 - y) ** 2;

/** A dome of tone 0 with a dark band (tone 1) from row 170 down, one pixel per whole pixel whose centre is inside. */
function dome() {
    const index = new Int8Array(WIDTH * HEIGHT).fill(-1);
    for (let y = 40; y < 190; y++) {
        for (let x = 0; x < WIDTH; x++) {
            if (Math.abs(x + 0.5 - 100) <= halfWidth(y + 0.5)) {
                index[y * WIDTH + x] = y >= 170 ? 1 : 0;
            }
        }
    }
    return index;
}

const withStep = (index, from, to, side, depth) => {
    const copy = Int8Array.from(index);
    for (let y = from; y < to; y++) {
        const boundary = edgeBoundary(index, WIDTH, y, side, SEARCH[side]);
        for (let step = 0; step < depth; step++) {
            copy[y * WIDTH + (side === 'left' ? boundary + step : boundary - 1 - step)] = -1;
        }
    }
    return copy;
};

test('the curve of a polynomial is read back, with its slope, at any row', () => {
    const curve = { coefficients: [10, 4, 2], centre: 50, scale: 10 };
    // x = 10 + 4u + 2u^2 with u = (y - 50) / 10
    assert.equal(curveAt(curve, 50), 10);
    assert.equal(curveAt(curve, 60), 16);
    assert.ok(Math.abs(slopeAt(curve, 60) - (4 + 4) / 10) < 1e-12);
    assert.ok(Math.abs(slopeAt(curve, 50) - 0.4) < 1e-12);
});

test('a curve is fitted through points on a parabola, and points that are off it are left out', () => {
    const truth = (y) => 300 - 0.003 * (y - 80) ** 2;
    const points = [];
    for (let y = 0; y < 120; y++) {
        const off = y >= 40 && y < 52 ? 4 : 0;
        points.push([y + 0.5, Math.round(truth(y + 0.5)) + off]);
    }
    const fit = fitEdgeCurve(points, 4);
    assert.ok(fit.used.length <= 108 && fit.used.length >= 105, `${fit.used.length} points kept`);
    assert.ok(fit.maxResidual < 0.8 && fit.rms < 0.45);
    for (const y of [5, 45, 70, 110]) {
        assert.ok(Math.abs(curveAt(fit.curve, y + 0.5) - truth(y + 0.5)) < 0.35, `row ${y}`);
    }
});

test('points that follow no curve give no fit, and neither do too few points', () => {
    const noisy = Array.from({ length: 80 }, (_, y) => [y + 0.5, 100 + ((y * 37) % 23)]);
    assert.equal(fitEdgeCurve(noisy, 4), undefined);
    assert.equal(fitEdgeCurve([[1, 1], [2, 2], [3, 3]], 4), undefined);
});

test('the edge of a row is the first opaque column on the left and one past the last on the right, inside the columns asked for', () => {
    const index = new Int8Array(10 * 2).fill(-1);
    [2, 3, 4, 7].forEach((x) => {
        index[x] = 0;
    });
    assert.equal(edgeBoundary(index, 10, 0, 'left', [0, 10]), 2);
    assert.equal(edgeBoundary(index, 10, 0, 'right', [0, 10]), 8);
    assert.equal(edgeBoundary(index, 10, 0, 'right', [0, 7]), 5, 'a pixel outside the columns is not the edge');
    assert.equal(edgeBoundary(index, 10, 1, 'left', [0, 10]), -1);
});

test('both sides of a dome are fitted, and rows where something was cut are left out of the fit', () => {
    const cut = withStep(withStep(dome(), 100, 118, 'left', 5), 130, 142, 'right', 4);
    const sides = fitDomeSides({ index: cut, width: WIDTH, from: 60, to: 185, search: SEARCH });
    for (const y of [65, 100, 125, 160, 180]) {
        assert.ok(Math.abs(curveAt(sides.left.curve, y + 0.5) - (100 - halfWidth(y + 0.5))) < 0.4, `left, row ${y}`);
        assert.ok(Math.abs(curveAt(sides.right.curve, y + 0.5) - (100 + halfWidth(y + 0.5))) < 0.4, `right, row ${y}`);
    }
    assert.equal(sides.left.rows, 125);
    assert.ok(sides.left.used.length <= 125 - 16 && sides.right.used.length <= 125 - 10, 'the cut rows are not used');
    assert.ok(sides.left.used.length >= 100 && sides.right.used.length >= 100);
});

test('a side that is not an edge at all stops the fit with its name', () => {
    const index = dome();
    for (let y = 60; y < 185; y++) {
        for (let x = 20; x < 20 + ((y * 37) % 61); x++) {
            index[y * WIDTH + x] = -1;
        }
    }
    assert.throws(() => fitDomeSides({ index, width: WIDTH, from: 60, to: 185, search: SEARCH }), /left edge could not be read/);
});

test('healing draws the edge on its curve: a notch is filled with the tone beside it, a stub is cleared, and every row ends on the curve', () => {
    const clean = dome();
    const damaged = withStep(withStep(clean, 100, 118, 'left', 5), 130, 142, 'right', 4);
    // A stub that sticks out of the right side by three pixels, in the dark band.
    for (let y = 172; y < 180; y++) {
        const boundary = edgeBoundary(damaged, WIDTH, y, 'right', SEARCH.right);
        for (let x = boundary; x < boundary + 3; x++) {
            damaged[y * WIDTH + x] = 1;
        }
    }
    const request = { index: damaged, width: WIDTH, from: 60, to: 185, search: SEARCH };
    const { left, right } = fitDomeSides(request);
    const healed = healDomeSides({ ...request, curves: { left: left.curve, right: right.curve } });
    for (let y = 60; y < 185; y++) {
        const [l, r] = [edgeBoundary(healed.index, WIDTH, y, 'left', SEARCH.left), edgeBoundary(healed.index, WIDTH, y, 'right', SEARCH.right)];
        const [wantedL, wantedR] = [edgeBoundary(clean, WIDTH, y, 'left', SEARCH.left), edgeBoundary(clean, WIDTH, y, 'right', SEARCH.right)];
        assert.ok(Math.abs(l - wantedL) <= 1 && Math.abs(r - wantedR) <= 1, `row ${y}: ${l}, ${r} against ${wantedL}, ${wantedR}`);
    }
    assert.ok(healed.farthest >= 5 && healed.farthest <= 6, `the deepest notch was five pixels, and the curve may be a pixel off the clean edge: ${healed.farthest}`);
    assert.ok(healed.farthestRow >= 100 && healed.farthestRow < 118);
    // The filled pixels have the tone of the edge pixel they join, and the stub in the dark band is cleared.
    const row = 110;
    const boundary = edgeBoundary(healed.index, WIDTH, row, 'left', SEARCH.left);
    assert.ok([...Array(8).keys()].every((step) => healed.index[row * WIDTH + boundary + step] === 0));
    assert.equal(healed.index[176 * WIDTH + edgeBoundary(healed.index, WIDTH, 176, 'right', SEARCH.right) - 1], 1);
    assert.equal(healed.index[176 * WIDTH + edgeBoundary(clean, WIDTH, 176, 'right', SEARCH.right) + 1], -1, 'beyond the curve it is clear again');
});

test('a fill in the dark band is dark, so a band reaches the new edge with no gap of the base tone', () => {
    const clean = dome();
    const damaged = withStep(clean, 174, 184, 'left', 4);
    const request = { index: damaged, width: WIDTH, from: 60, to: 188, search: SEARCH };
    const { left, right } = fitDomeSides(request);
    const { index } = healDomeSides({ ...request, curves: { left: left.curve, right: right.curve } });
    for (let y = 174; y < 184; y++) {
        const boundary = edgeBoundary(index, WIDTH, y, 'left', SEARCH.left);
        assert.equal(index[y * WIDTH + boundary], 1, `row ${y}`);
    }
});

test('healing leaves rows outside its range, and the picture it was given, as they were', () => {
    const damaged = withStep(dome(), 100, 118, 'left', 5);
    const before = Int8Array.from(damaged);
    const request = { index: damaged, width: WIDTH, from: 60, to: 185, search: SEARCH };
    const { left, right } = fitDomeSides(request);
    const { index } = healDomeSides({ ...request, from: 90, to: 120, curves: { left: left.curve, right: right.curve } });
    assert.deepEqual(damaged, before);
    for (let y = 0; y < HEIGHT; y++) {
        if (y >= 90 && y < 120) {
            continue;
        }
        assert.deepEqual(index.subarray(y * WIDTH, (y + 1) * WIDTH), damaged.subarray(y * WIDTH, (y + 1) * WIDTH), `row ${y}`);
    }
});

test('the notch between an ear and the dome is the row where each side is furthest in', () => {
    const index = new Int8Array(WIDTH * HEIGHT).fill(-1);
    // An ear 40 wide on the left and 30 on the right standing on a dome that is 120 wide from row 100, with the ear's sides leaning in.
    for (let y = 10; y < 150; y++) {
        const [left, right] = y < 100 ? [60 + (y - 10) * 0.1, 140 - (y - 10) * 0.1] : [40, 160];
        for (let x = Math.ceil(left); x < right; x++) {
            index[y * WIDTH + x] = 0;
        }
    }
    const search = { left: [0, 100], right: [100, WIDTH] };
    assert.equal(findCrease({ index, width: WIDTH, from: 20, to: 140, side: 'left', search: search.left }), 99);
    assert.equal(findCrease({ index, width: WIDTH, from: 20, to: 140, side: 'right', search: search.right }), 99);
    assert.throws(() => findCrease({ index, width: WIDTH, from: 0, to: 5, side: 'left', search: search.left }), /no left edge/);
});
