import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureMargin, MASTER_PAD, MIN_MASTER_MARGIN, padClippedRim } from '../scripts/lib/github-master.mjs';
import { createRaster, getPixel } from '../test-support/synthetic.mjs';

const WOOD = [200, 150, 100, 255];
const BAND = [254, 250, 252, 255];
const RIM = [191, 166, 230, 255];
const SKIN = [250, 215, 190, 255];
const HAIR = [175, 150, 232, 255];
const BAND_WIDTH = 6;
const RIM_WIDTH = 9;

const CORNER = 12;

/** The distance from a point to a rounded rectangle, negative inside it. */
function distanceToBox({ x, y }, box) {
    const middleX = box.x + box.width / 2;
    const middleY = box.y + box.height / 2;
    const dx = Math.abs(x + 0.5 - middleX) - (box.width / 2 - CORNER);
    const dy = Math.abs(y + 0.5 - middleY) - (box.height / 2 - CORNER);
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - CORNER;
}

/**
 * A master as a model draws it: a rounded body, a white band `BAND_WIDTH` wide round it and a lavender rim `RIM_WIDTH` wide round that,
 * on transparent ground. A body whose edge is nearer the canvas edge than the band is wide is a sticker that the canvas edge cuts.
 */
function sticker({ width = 120, height = 110, box = { x: 40, y: BAND_WIDTH, width: 40, height: 64 }, colour = WOOD } = {}) {
    const raster = createRaster(width, height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const distance = distanceToBox({ x, y }, box);
            const paint = distance <= 0 ? colour : distance <= BAND_WIDTH ? BAND : distance <= BAND_WIDTH + RIM_WIDTH ? RIM : undefined;
            if (paint) {
                raster.data.set(paint, (y * width + x) * 4);
            }
        }
    }
    return raster;
}

const CUT_BOX = { x: 40, y: -20, width: 40, height: 90 };

const opaqueOnRow = (raster, y) => Array.from({ length: raster.width }, (_, x) => getPixel(raster, x, y)[3]).filter((alpha) => alpha > 0).length;

test('a master that nothing touches the edge of comes back as it is', () => {
    const whole = sticker({ box: { x: 40, y: 30, width: 40, height: 64 } });
    const result = padClippedRim(whole);
    assert.equal(result.raster, whole);
    assert.deepEqual(result.padded, []);
});

test('a sticker cut by the edge only where its rings are is padded, and the rim is drawn whole above the white band', () => {
    const master = sticker();
    assert.ok(opaqueOnRow(master, 0) > 0, 'the master really is clipped at the top');
    const { raster, padded } = padClippedRim(master);
    assert.deepEqual(padded.map(({ edge, rows }) => [edge, rows]), [['top', MASTER_PAD]]);
    assert.equal(raster.height, master.height + MASTER_PAD);
    assert.equal(opaqueOnRow(raster, 0), 0, 'nothing is cut by the new top edge');

    const middle = 60;
    const bandTop = MASTER_PAD;
    assert.deepEqual(getPixel(raster, middle, bandTop), BAND, 'the white band is where it was');
    for (let rise = 1; rise <= RIM_WIDTH; rise++) {
        assert.deepEqual(getPixel(raster, middle, bandTop - rise), RIM, `rim ${rise} px above the band`);
    }
    assert.equal(getPixel(raster, middle, bandTop - RIM_WIDTH - 1)[3], 0, 'and the rim is as wide as the master\'s own');
    for (let y = 0; y < master.height; y++) {
        assert.deepEqual(raster.data.subarray(((y + MASTER_PAD) * raster.width + 55) * 4, ((y + MASTER_PAD) * raster.width + 56) * 4), master.data.subarray((y * master.width + 55) * 4, (y * master.width + 56) * 4), 'the drawing is not touched');
    }
});

test('the drawing itself cut by the edge is refused: skin, wood, a white sock and hair are not rings', () => {
    const cutWood = sticker({ box: CUT_BOX });
    assert.throws(() => padClippedRim(cutWood), /the top edge is cut through the drawing itself/);

    const skinBody = sticker({ box: CUT_BOX, colour: SKIN });
    assert.throws(() => padClippedRim(skinBody), /cut through the drawing itself/);

    const sock = sticker({ box: CUT_BOX, colour: BAND });
    assert.throws(() => padClippedRim(sock), /thicker than the sticker's band.*sock or hair/);

    const hair = sticker({ box: CUT_BOX, colour: HAIR });
    assert.throws(() => padClippedRim(hair), /thicker than the sticker's rim|cut through the drawing itself/);
});

test('a master whose only clipped pixels are on one side is padded on that side alone', () => {
    const sideCut = sticker({ width: 90, height: 120, box: { x: BAND_WIDTH, y: 20, width: 50, height: 70 } });
    assert.ok(Array.from({ length: sideCut.height }, (_, y) => getPixel(sideCut, 0, y)[3]).some((alpha) => alpha > 0), 'the left edge is cut');
    const { padded, raster } = padClippedRim(sideCut);
    assert.equal(padded.length, 1);
    assert.equal(padded[0].edge, 'left');
    assert.equal(raster.height, sideCut.height, 'rows are not added where nothing is cut');
});

test('a sticker too near the edge is given transparent rows up to the least margin, and one with room is not touched', () => {
    const near = sticker({ box: { x: 40, y: 30, width: 40, height: 64 } });
    near.data.fill(0);
    for (let y = 2; y < 40; y++) {
        for (let x = 3; x < 60; x++) {
            near.data.set(WOOD, (y * near.width + x) * 4);
        }
    }
    const { raster, added } = ensureMargin(near);
    assert.deepEqual(added, { left: MIN_MASTER_MARGIN - 3, top: MIN_MASTER_MARGIN - 2, right: 0, bottom: 0 });
    assert.equal(raster.width, near.width + added.left);
    assert.deepEqual(getPixel(raster, 3 + added.left, 2 + added.top), WOOD, 'the picture moved with its new margin');
    assert.equal(getPixel(raster, 0, 0)[3], 0);

    const roomy = sticker({ height: 140, box: { x: 40, y: 30, width: 40, height: 64 } });
    const same = ensureMargin(roomy);
    assert.equal(same.raster, roomy);
});
