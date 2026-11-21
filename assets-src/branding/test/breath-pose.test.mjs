import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breathe, breathProblems, buildBreath, outlineDefects, seamWindow, shiftUpperRows, smoothOutline, waistOf } from '../scripts/lib/breath-pose.mjs';
import { measureRings, repairRings, STICKER_BAND, STICKER_RIM } from '../scripts/lib/pixel-snap.mjs';
import { createRaster, crop, opaqueBox } from '../scripts/lib/raster.mjs';
import { boxOfPixels, changedPixels } from '../scripts/lib/snap-frame.mjs';
import { eyesShut, snappedFigure } from '../test-support/breath-workspace.mjs';
import { getPixel, setPixel } from '../test-support/synthetic.mjs';

const RINGS = { rimWidth: 2, bandWidth: 2 };
const SHARE = 0.55;

const base = snappedFigure();
const variants = { base, half: eyesShut(base), closed: eyesShut(eyesShut(base)) };
const built = buildBreath({ variants, waistShare: SHARE, rings: RINGS });
const breath = built.poses[1];
const rowsOf = (raster, from, to) => crop(raster, { x: 0, y: from, width: raster.width, height: to - from });
const same = (one, two) => changedPixels(one, two).length === 0;

test('the waist is the share of the way from the top row of the figure to its last row, and a share that leaves nothing above it is refused', () => {
    const box = opaqueBox(base, 1);
    assert.deepEqual(waistOf(base, SHARE), { box, waist: box.y + Math.round((box.height - 1) * SHARE) });
    assert.equal(waistOf(base, 0.5).waist, box.y + Math.round((box.height - 1) * 0.5));
    assert.ok(waistOf(base, 0.7).waist > waistOf(base, 0.4).waist, 'a larger share is lower on the figure');
    assert.equal(built.waist, waistOf(base, SHARE).waist);
    assert.throws(() => waistOf(createRaster(10, 10), SHARE), /picture is empty/);
    assert.throws(() => waistOf(base, 0.001), /leaves nothing above it to move/);
});

test('the upper rows move down by exactly one row, the lower rows stay, and the waist row is drawn over the row that lands on it', () => {
    const waist = 40;
    const source = createRaster(6, 60);
    for (let y = 0; y < 60; y++) {
        for (let x = 0; x < 6; x++) {
            setPixel(source, x, y, y < 3 ? [0, 0, 0, 0] : [y, x, 7, 255]);
        }
    }
    setPixel(source, 5, waist, [0, 0, 0, 0]);
    setPixel(source, 4, waist, [200, 200, 200, 255]);
    const before = Buffer.from(source.data);
    const moved = shiftUpperRows(source, waist);
    assert.ok(source.data.equals(before), 'the input is not changed');
    for (let y = 0; y < 60; y++) {
        for (let x = 0; x < 6; x++) {
            const expected = y < 4 ? [0, 0, 0, 0] : y < waist ? getPixel(source, x, y - 1) : getPixel(source, x, y);
            if (y === waist && x === 5) {
                assert.deepEqual(getPixel(moved, x, y), getPixel(source, x, waist - 1), 'where the waist row is clear the moved row shows');
            } else {
                assert.deepEqual(getPixel(moved, x, y), expected, `row ${y}, column ${x}`);
            }
        }
    }
    assert.deepEqual(getPixel(moved, 4, waist), [200, 200, 200, 255], 'where the waist row is opaque it wins');
});

test('the breath pose of the figure: the top row of the figure is empty and every row of the upper body is the source row above it', () => {
    const { box, waist } = built;
    const { first, last } = seamWindow(waist, RINGS, base.height);
    for (const [variant, { raster }] of Object.entries(breath.variants)) {
        assert.equal(opaqueBox(raster, 1).y, box.y + 1, `${variant}: the figure starts one row lower`);
        assert.ok(rowsOf(raster, 0, box.y + 1).data.every((value) => value === 0), `${variant}: the old top row and the rows above it are empty, nothing is left behind`);
        assert.ok(same(rowsOf(raster, box.y + 1, first), rowsOf(built.sources[variant], box.y, first - 1)), `${variant}: rows ${box.y + 1} to ${first - 1} are the rows above them`);
        assert.ok(same(rowsOf(raster, last + 1, base.height), rowsOf(built.sources[variant], last + 1, base.height)), `${variant}: rows ${last + 1} down are untouched`);
    }
    assert.deepEqual([breath.variants.base.raster.width, breath.variants.base.raster.height], [base.width, base.height], 'the canvas stays the size of the source');
});

test('the rows from the waist down stay: below the waist only ring pixels near the seam can differ from the source, and none after the rings\' reach', () => {
    const { waist } = built;
    const { raster } = breath.variants.base;
    const ringColour = (colour) => [STICKER_RIM, STICKER_BAND].some((ring) => ring.every((channel, index) => colour[index] === channel));
    for (let y = waist + 1; y < base.height; y++) {
        for (let x = 0; x < base.width; x++) {
            const [after, before] = [getPixel(raster, x, y), getPixel(base, x, y)];
            if (!(after[3] === 0 && before[3] === 0) && after.some((channel, index) => channel !== before[index])) {
                assert.ok(ringColour(after) && y <= waist + RINGS.rimWidth + RINGS.bandWidth + 2, `${x},${y} differs and is not a ring pixel near the seam`);
            }
        }
    }
});

test('the rings are continuous across the seam: rebuilding them changes nothing, and the whole figure has its 2+2 rings', () => {
    const { first, last } = seamWindow(built.waist, RINGS, base.height);
    for (const [variant, { raster }] of Object.entries(breath.variants)) {
        const rebuilt = repairRings(raster, { ...RINGS, rim: STICKER_RIM, band: STICKER_BAND }).raster;
        assert.ok(same(rowsOf(raster, first, last + 1), rowsOf(rebuilt, first, last + 1)), variant);
        assert.deepEqual(measureRings(raster, { rim: STICKER_RIM, band: STICKER_BAND }), RINGS, variant);
    }
});

test('where the figure narrows at the waist row, the moved row shows past it, and the band and the rim are rebuilt around that seam', () => {
    const opaqueAt = (raster, x, y) => raster.data[(y * raster.width + x) * 4 + 3] !== 0;
    const overhangs = (y) => [...Array(base.width).keys()].filter((x) => opaqueAt(base, x, y - 1) && !opaqueAt(base, x, y));
    const waist = [...Array(120).keys()].map((row) => row + 20).find((row) => overhangs(row).length >= 3);
    assert.ok(waist !== undefined, 'the fixture figure narrows somewhere');
    const pose = breathe(base, { waist, rings: RINGS });
    const moved = shiftUpperRows(base, waist);
    for (const x of overhangs(waist)) {
        assert.ok(opaqueAt(moved, x, waist), `the moved row shows at column ${x} of the waist row`);
    }
    const { first, last } = seamWindow(waist, RINGS, base.height);
    const rebuilt = repairRings(pose.raster, { ...RINGS, rim: STICKER_RIM, band: STICKER_BAND }).raster;
    assert.ok(same(rowsOf(pose.raster, first, last + 1), rowsOf(rebuilt, first, last + 1)), 'rebuilding the rings again changes nothing around the seam');
    assert.ok(pose.ringsChanged > 0, 'the overlap did break a ring, and the rebuild mended it');
});

test('a blink variant of the breath pose differs from the pose\'s base picture exactly where the source\'s does, one row lower', () => {
    for (const variant of ['half', 'closed']) {
        const wanted = boxOfPixels(changedPixels(base, variants[variant]), base.width);
        const found = boxOfPixels(changedPixels(breath.variants.base.raster, breath.variants[variant].raster), base.width);
        assert.deepEqual(found, { ...wanted, y: wanted.y + 1 }, variant);
    }
    assert.deepEqual(built.problems, []);
});

test('no colour appears that the source picture did not have, and the alpha stays binary', () => {
    const colours = (raster) => new Set(Array.from({ length: raster.width * raster.height }, (_, at) => (raster.data[at * 4 + 3] === 0 ? 'clear' : raster.data.subarray(at * 4, at * 4 + 4).join(','))));
    for (const [variant, { raster }] of Object.entries(breath.variants)) {
        const allowed = colours(built.sources[variant]);
        assert.ok([...colours(raster)].every((colour) => allowed.has(colour)), variant);
        assert.ok([...raster.data].every((value, at) => at % 4 !== 3 || value === 0 || value === 255));
    }
});

test('a figure whose sticker the canvas cuts off at the top is moved down as it is: its art is not painted over with a rebuilt ring', () => {
    const cut = crop(base, { x: 0, y: opaqueBox(base, 1).y + 3, width: base.width, height: base.height - opaqueBox(base, 1).y - 3 });
    assert.equal(opaqueBox(cut, 1).y, 0);
    const clipped = buildBreath({ variants: { base: cut }, waistShare: SHARE, rings: RINGS });
    assert.deepEqual(clipped.problems, []);
    const { raster } = clipped.poses[1].variants.base;
    assert.ok(same(rowsOf(raster, 1, 30), rowsOf(cut, 0, 29)), 'the top 30 rows are the source rows, one lower');
    assert.ok(rowsOf(raster, 0, 1).data.every((value) => value === 0));
});

test('the centre pose is the source itself, and a variant the source lacks is not made', () => {
    assert.deepEqual(built.poses.map(({ name }) => name), ['c', 'b']);
    assert.equal(built.poses[0].variants.base.raster, base);
    const bare = buildBreath({ variants: { base }, waistShare: SHARE, rings: RINGS });
    assert.deepEqual(Object.keys(bare.poses[1].variants), ['base']);
});

test('a pose that did not move, moved the lower body, made up a colour, broke a ring or changed more than the eyes is named, with what is wrong', () => {
    const request = (mutate) => {
        const copy = { variants: Object.fromEntries(Object.entries(breath.variants).map(([name, { raster }]) => [name, { raster: { ...raster, data: Buffer.from(raster.data) } }])) };
        mutate(copy.variants);
        return breathProblems({ sources: built.sources, pose: copy, waist: built.waist, rings: RINGS });
    };
    assert.deepEqual(request(() => {}), []);
    const still = request((poses) => {
        poses.base.raster.data.set(base.data);
    });
    assert.ok(still.some((problem) => /b base: starts at row 2, not one row below the source's row 2/.test(problem)), still.join('\n'));
    assert.ok(request((poses) => setPixel(poses.base.raster, 42, 130, [1, 2, 3, 255])).some((problem) => /b base: 1 colours that the source picture does not have/.test(problem)));
    const lower = request((poses) => setPixel(poses.base.raster, 42, 130, [185, 155, 242, 255]));
    assert.ok(lower.some((problem) => /rows from \d+ down are not the source's own, so the lower body is not still/.test(problem)), lower.join('\n'));
    assert.ok(request((poses) => setPixel(poses.closed.raster, 47, 40, [9, 9, 9, 255])).some((problem) => /b closed: 1 colours that the source picture does not have/.test(problem)));
    assert.ok(request((poses) => setPixel(poses.base.raster, 47, 70, [0, 0, 0, 0])).some((problem) => /did not move by exactly one row/.test(problem)));
    const ring = request((poses) => setPixel(poses.base.raster, 20, built.waist, [255, 255, 255, 255]));
    assert.ok(ring.some((problem) => /around the waist .* are not the 2\+2 sticker rings/.test(problem)), ring.join('\n'));
    const far = request((poses) => setPixel(poses.half.raster, 47, 90, [0, 0, 0, 0]));
    assert.ok(far.some((problem) => /b half: differs from b base in .*, outside the eyes/.test(problem)), far.join('\n'));
    const lost = request((poses) => poses.half.raster.data.set(poses.base.raster.data));
    assert.ok(lost.some((problem) => /b half: does not differ from b base, but the source half differs from its base in \d+x\d+ at \d+,\d+, so the blink is lost/.test(problem)), lost.join('\n'));
    assert.ok(!lost.some((problem) => /^b closed/.test(problem)), 'the closed picture, which still differs, is not blamed');
});

test('outline defects are bumps and dents, found in the rows asked for only, and smoothing mends them without changing its input', () => {
    const raster = createRaster(9, 9);
    const colour = [10, 20, 30, 255];
    for (let y = 1; y < 8; y++) {
        for (let x = 3; x < 8; x++) {
            setPixel(raster, x, y, colour);
        }
    }
    setPixel(raster, 2, 4, [200, 0, 0, 255]);
    setPixel(raster, 2, 7, [200, 0, 0, 255]);
    setPixel(raster, 5, 1, [0, 0, 0, 0]);
    const before = Buffer.from(raster.data);
    const defects = outlineDefects(raster, [1, 2, 3, 4, 5]);
    assert.deepEqual(defects, [{ x: 5, y: 1, kind: 'dent' }, { x: 2, y: 4, kind: 'bump' }]);
    const smoothed = smoothOutline(raster, defects);
    assert.deepEqual(getPixel(smoothed, 2, 4), [0, 0, 0, 0], 'the bump is gone');
    assert.deepEqual(getPixel(smoothed, 5, 1), colour, 'the dent takes the colour of its neighbour');
    assert.deepEqual(getPixel(smoothed, 2, 7), [200, 0, 0, 255], 'a bump outside the rows is left');
    assert.ok(raster.data.equals(before), 'the input is not changed');
    assert.deepEqual(outlineDefects(smoothed, [1, 2, 3, 4, 5]), []);
});
