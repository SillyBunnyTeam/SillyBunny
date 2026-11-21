import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOME_OVERLAP, edgeAt, fitDomeEdge, fitDot, fitLines, leastSquaresCircle, withDomeEdge } from '../scripts/lib/line-fit.mjs';
import { THIN_SHARE, isolateLines, lineThickness } from '../scripts/lib/line-shading.mjs';
import { opaqueBox } from '../scripts/lib/raster.mjs';
import { findTones, pinTone, snapToTones } from '../scripts/lib/tone-snap.mjs';
import { DOT_RADIUS, LEFT_DOT, LINE_WIDTH, RIGHT_DOT, SIZE, logoWithLines } from '../test-support/logo-lines.mjs';

/** The masks `fitLines` works from, read the way the vectorizer reads them. */
function pictureOf(raster) {
    const tones = pinTone(findTones(raster), '#8b64aa');
    const { raster: snapped, toneIndex } = snapToTones(raster, tones);
    const box = opaqueBox(snapped, 128);
    const isolated = isolateLines(snapped, Math.round(Math.max(box.width, box.height) * THIN_SHARE));
    const silhouette = Uint8Array.from(toneIndex, (tone) => (tone >= 0 ? 1 : 0));
    const thickness = lineThickness(isolated.thin, silhouette, SIZE, SIZE);
    return { silhouette, lines: isolated.thin, zone: isolated.zone, width: SIZE, height: SIZE, thickness };
}

const disc = (width, height, cx, cy, r, extra = () => false) => Uint8Array.from({ length: width * height }, (_, at) => {
    const [x, y] = [(at % width) + 0.5, Math.floor(at / width) + 0.5];
    return Math.hypot(x - cx, y - cy) <= r || extra(x, y) ? 1 : 0;
});

test('a circle is found through points on it, and none through points on a line', () => {
    const points = [0, 1, 2, 3].map((quarter) => [10 + 5 * Math.cos(quarter * 1.7), -4 + 5 * Math.sin(quarter * 1.7)]);
    const circle = leastSquaresCircle(points);
    assert.ok(Math.abs(circle.cx - 10) < 1e-6 && Math.abs(circle.cy + 4) < 1e-6 && Math.abs(circle.r - 5) < 1e-6);
    assert.equal(leastSquaresCircle([[0, 0], [1, 1], [2, 2], [3, 3]]), undefined);
});

test('a dot is a circle fitted to its edge, and the line that leaves it does not pull the circle', () => {
    const width = 120;
    const height = 80;
    const piece = disc(width, height, 30.3, 40.6, 15, (x, y) => x > 30 && x < 110 && y > 37 && y < 44);
    const dot = fitDot(piece, width, height);
    assert.ok(Math.abs(dot.cx - 30.3) < 0.4 && Math.abs(dot.cy - 40.6) < 0.4, `${dot.cx}, ${dot.cy}`);
    assert.ok(Math.abs(dot.r - 15) < 0.5, `${dot.r}`);
    assert.ok(dot.rms < 0.5);
});

test('a piece with no dot in it is refused', () => {
    const width = 40;
    const piece = new Uint8Array(width * width);
    for (let x = 5; x < 35; x++) {
        piece[20 * width + x] = 1;
    }
    assert.throws(() => fitDot(piece, width, width), /No round dot/);
});

test('the dome edge beside a line is read from the rows above and below it, and the rows with a line on them are skipped', () => {
    const width = 200;
    const height = 200;
    // A dome whose left edge leans: x = 100 + 0.1 * (y - 100), with a line coming out of it near row 100.
    const edgeOfRow = (y) => 100 + 0.1 * (y - 100);
    const silhouette = new Uint8Array(width * height);
    const zone = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = Math.ceil(edgeOfRow(y + 0.5)); x < width; x++) {
            silhouette[y * width + x] = 1;
        }
    }
    for (let y = 96; y < 104; y++) {
        for (let x = 40; x < 100; x++) {
            silhouette[y * width + x] = 1;
            zone[y * width + x] = 1;
        }
    }
    const edge = fitDomeEdge({ silhouette, zone, width, height, row: 100, near: 100, towards: 1 });
    assert.ok(Math.abs(edge.at - 100) < 0.7 && Math.abs(edge.slope - 0.1) < 0.02, JSON.stringify(edge));
    assert.ok(Math.abs(edgeAt(edge, 100) - 100) < 0.7);
    assert.ok(edge.rows > 40);
    const mirrored = Uint8Array.from(silhouette, (_, at) => silhouette[(Math.floor(at / width) + 1) * width - 1 - (at % width)]);
    const onTheRight = fitDomeEdge({ silhouette: mirrored, zone: new Uint8Array(width * height), width, height, row: 100, near: 100, towards: -1 });
    assert.ok(Math.abs(onTheRight.at - 100) < 0.7 && Math.abs(onTheRight.slope + 0.1) < 0.02, `a dome on the other side of the dot is read too: ${JSON.stringify(onTheRight)}`);
    assert.throws(() => fitDomeEdge({ silhouette: new Uint8Array(width * height), zone, width, height, row: 100, near: 100, towards: 1 }), /could not be read/);
});

test('each line with its dot is read as a circle and a right-angled centre line of one width ending on the dome', () => {
    const fits = fitLines(pictureOf(logoWithLines()));
    assert.equal(fits.length, 2);
    const [left, right] = [...fits].sort((a, b) => a.dot.cx - b.dot.cx);
    assert.equal(left.width, LINE_WIDTH);
    assert.equal(right.width, LINE_WIDTH);
    for (const [fit, dot] of [[left, LEFT_DOT], [right, RIGHT_DOT]]) {
        assert.ok(Math.abs(fit.dot.cx - dot.cx) < 0.3 && fit.dot.cy === dot.cy, JSON.stringify(fit.dot));
        assert.ok(Math.abs(fit.dot.r - DOT_RADIUS) < 0.3);
    }
    assert.equal(left.towards, 1);
    assert.equal(right.towards, -1);
    assert.deepEqual(left.vertices.slice(0, 3), [[40, 280.5], [70.5, 280.5], [70.5, 315.5]], 'a horizontal piece, a corner, a vertical piece and a corner');
    assert.equal(left.vertices.length, 4);
    assert.equal(left.vertices[3][1], 315.5);
    assert.ok(left.vertices[3][0] > edgeAt(left.edge, 315) && left.vertices[3][0] < edgeAt(left.edge, 315) + 12, 'it runs on a little into the dome');
    assert.deepEqual(right.vertices.length, 2);
    assert.deepEqual(right.vertices[0], [360, 299.5]);
    assert.ok(right.vertices[1][0] < edgeAt(right.edge, 299) && right.vertices[1][0] > edgeAt(right.edge, 299) - 12);
    assert.deepEqual(left.measured.segments.map(({ direction }) => direction), ['H', 'V', 'H']);
    assert.deepEqual(left.measured.widths, [7, 7, 7]);
});

test('every dot has the same radius and every line the same width, the middle of what was measured', () => {
    const raster = logoWithLines();
    // Make the right line one pixel wider than the left one.
    for (let y = 295; y < 303; y++) {
        for (let x = 270; x < 350; x++) {
            raster.data.set([139, 100, 170, 255], (y * SIZE + x) * 4);
        }
    }
    const fits = fitLines(pictureOf(raster));
    assert.ok(fits.every(({ width }) => width === fits[0].width));
    assert.ok(fits.every(({ dot }) => dot.r === fits[0].dot.r));
    assert.ok(fits.some(({ measured }) => measured.widths.includes(8)), 'the wider line was measured as wider');
    assert.equal(fits[0].width, 7);
});

test('a picture with no lines in it is refused', () => {
    const empty = new Uint8Array(SIZE * SIZE);
    assert.throws(() => fitLines({ silhouette: empty, lines: empty, zone: empty, width: SIZE, height: SIZE, thickness: 7 }), /No lines with dots/);
});

test('a line that does not end on the dome with a horizontal piece is refused', () => {
    const width = 200;
    const height = 200;
    const silhouette = new Uint8Array(width * height);
    const lines = new Uint8Array(width * height);
    const mark = (x0, y0, x1, y1, mask) => {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                mask[y * width + x] = 1;
            }
        }
    };
    // A dot with a vertical line going down to a dome.
    mark(50, 150, 190, 200, silhouette);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (Math.hypot(x + 0.5 - 100, y + 0.5 - 40) <= 18) {
                lines[y * width + x] = 1;
            }
        }
    }
    mark(97, 40, 104, 150, lines);
    lines.forEach((value, at) => {
        silhouette[at] = silhouette[at] | value;
    });
    assert.throws(() => fitLines({ silhouette, lines, zone: lines, width, height, thickness: 7 }), /horizontal piece/);
});

test('a line takes the dome edge from the dome\'s fitted side, and runs on into the dome from there', () => {
    const fits = fitLines(pictureOf(logoWithLines()));
    const [left, right] = [...fits].sort((a, b) => a.dot.cx - b.dot.cx);
    // A left side that leans and bends: x = 50 + 0.5 y - 0.001 y^2, with y taken from 0 (centre 0 and scale 1 make the polynomial's variable y itself).
    const leftCurve = { coefficients: [50, 0.5, -0.001], centre: 0, scale: 1 };
    const row = left.vertices.at(-1)[1];
    const placed = withDomeEdge(left, leftCurve);
    const wanted = leftCurve.coefficients[0] + leftCurve.coefficients[1] * row + leftCurve.coefficients[2] * row ** 2;
    assert.ok(Math.abs(placed.edge.at - wanted) < 1e-6 && placed.edge.y0 === row);
    assert.ok(Math.abs(edgeAt(placed.edge, Math.floor(row)) - wanted) < 1e-6, 'the edge at the line\'s own row is the curve');
    assert.equal(placed.vertices.at(-1)[0], Math.round(wanted + DOME_OVERLAP));
    assert.equal(placed.vertices.at(-1)[1], row);
    assert.deepEqual(placed.vertices.slice(0, -1), left.vertices.slice(0, -1), 'the rest of the line stays');
    assert.equal(left.edge.at !== placed.edge.at, true, 'and the fit it was given is not changed');
    const mirrored = withDomeEdge(right, { coefficients: [300, 0, 0], centre: 0, scale: 1 });
    assert.equal(mirrored.vertices.at(-1)[0], Math.round(300 - DOME_OVERLAP), 'a line from the right runs on towards the left');
});
