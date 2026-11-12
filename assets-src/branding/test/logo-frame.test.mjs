import assert from 'node:assert/strict';
import { test } from 'node:test';
import { centreOfMassX, findBase, frameEmblem, placeInFrame } from '../scripts/lib/logo-frame.mjs';
import { createRaster, opaqueBox } from '../scripts/lib/raster.mjs';
import { dropThinParts, fillHoles, labelComponents, openMask } from '../scripts/lib/shape-ops.mjs';
import { MID, SIZE, emblem } from '../test-support/emblem.mjs';
import { getPixel, setPixel } from '../test-support/synthetic.mjs';

test('the base is found as the dome, however far the thin lines and the charm reach to one side', () => {
    const picture = emblem();
    const box = opaqueBox(picture, 128);
    const base = findBase(picture);
    assert.ok(Math.abs(base.centreX - 200) <= 1, `base centre ${base.centreX}`);
    assert.ok(base.left > 100 && base.right < 300, 'its extent is the dome, not the lines');
    assert.ok(Math.abs(box.x + box.width / 2 - base.centreX) > 15, 'the whole box is centred somewhere else');
});

test('with the base centred, the base sits on the axis and the top and bottom margins are equal', () => {
    const picture = emblem();
    const box = opaqueBox(picture, 128);
    const base = findBase(picture);
    const frame = frameEmblem(box, base.centreX, 'base');
    assert.equal(base.centreX + frame.offsetX, frame.side / 2);
    assert.equal(box.y + frame.offsetY, frame.side - (box.y + box.height + frame.offsetY));
    assert.ok(box.x + frame.offsetX >= frame.margin && box.x + box.width + frame.offsetX <= frame.side - frame.margin, 'nothing is nearer the side than the margin');
    const placed = placeInFrame(picture, frame);
    const placedBox = opaqueBox(placed, 128);
    assert.equal(placedBox.width, box.width, 'nothing is cut off');
    assert.equal(placed.width, placed.height, 'the canvas is square');
});

test('with the box centred, the whole emblem is in the middle of a square canvas with equal margins all round', () => {
    const picture = emblem();
    const box = opaqueBox(picture, 128);
    const frame = frameEmblem(box, 200, 'bbox');
    const placedBox = opaqueBox(placeInFrame(picture, frame), 128);
    const left = placedBox.x;
    const right = frame.side - (placedBox.x + placedBox.width);
    assert.ok(Math.abs(left - right) <= 1, `left ${left}, right ${right}`);
    const top = placedBox.y;
    const bottom = frame.side - (placedBox.y + placedBox.height);
    assert.ok(Math.abs(top - bottom) <= 1);
    assert.ok(Math.min(left, top) >= frame.margin - 1);
    assert.throws(() => frameEmblem(box, 200, 'middle'), /Unknown centring/);
});

test('the two centrings differ exactly by how far the base sits from the middle of the box', () => {
    const picture = emblem();
    const box = opaqueBox(picture, 128);
    const base = frameEmblem(box, 200, 'base');
    const bbox = frameEmblem(box, 200, 'bbox');
    const baseShift = box.x + box.width / 2 + base.offsetX - base.side / 2;
    assert.ok(Math.abs(baseShift) > 15, 'in the base framing the box is off the axis');
    assert.ok(Math.abs(box.x + box.width / 2 + bbox.offsetX - bbox.side / 2) < 1e-9);
});

test('the centre of mass is reported, and a picture with nothing in it has none', () => {
    assert.ok(centreOfMassX(emblem()) < 200, 'the long left side pulls it left');
    assert.equal(centreOfMassX(createRaster(4, 4)), undefined);
});

test('an opening removes shapes thinner than its window and keeps thicker ones', () => {
    const width = 30;
    const mask = new Uint8Array(width * width);
    for (let y = 5; y < 25; y++) {
        for (let x = 5; x < 25; x++) {
            mask[y * width + x] = 1;
        }
    }
    for (let x = 0; x < 30; x++) {
        mask[2 * width + x] = 1;
    }
    const opened = openMask(mask, width, width, 3);
    assert.equal(opened[2 * width + 15], 0, 'a one pixel line is gone');
    assert.equal(opened[15 * width + 15], 1);
    assert.equal(opened[5 * width + 5], 1, 'a square corner of a thick shape stays');
});

test('lines, dots, cords and charms are dropped, and the dome and the ears keep their pixels and tones', () => {
    const picture = emblem();
    const kept = dropThinParts(picture, { thinWidth: 17 });
    const filled = (raster, x, y) => raster.data[(y * raster.width + x) * 4 + 3] === 255;
    for (const [x, y] of [[36, 351], [306, 351], [66, 121], [90, 121], [290, 351]]) {
        assert.ok(filled(picture, x, y) && !filled(kept, x, y), `${x},${y} is dropped`);
    }
    for (const [x, y] of [[140, 190], [270, 260], [200, 360], [140, 120]]) {
        assert.ok(filled(kept, x, y), `${x},${y} stays`);
    }
    assert.deepEqual(getPixel(kept, 200, 376), getPixel(picture, 200, 376), 'a kept pixel is byte for byte what it was');
    assert.deepEqual(getPixel(kept, 140, 190).slice(0, 3), MID);
});

test('the stub a removed line leaves at the base is no longer than the thin width', () => {
    const kept = dropThinParts(emblem(), { thinWidth: 17 });
    const box = opaqueBox(kept, 128);
    assert.ok(box.x >= 116 - 17 && box.x + box.width <= 280 + 17 + 10, `box ${JSON.stringify(box)}`);
    assert.ok(kept.data[(351 * SIZE + 100) * 4 + 3] === 0, 'a point of the line 20 pixels from the dome is gone');
});

test('a picture with nothing thick, or a thin width that is not a whole number, is refused', () => {
    const lines = createRaster(40, 40);
    for (let x = 0; x < 40; x++) {
        setPixel(lines, x, 10, [0, 0, 0, 255]);
    }
    assert.throws(() => dropThinParts(lines, { thinWidth: 9 }), /Nothing is thicker/);
    assert.throws(() => dropThinParts(emblem(), { thinWidth: 2.5 }), /whole number/);
});

test('an enclosed hole is filled, and a notch that is open to the border is not', () => {
    const width = 12;
    const mask = new Uint8Array(width * width).fill(1);
    const clearBox = (x0, y0, x1, y1) => {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                mask[y * width + x] = 0;
            }
        }
    };
    clearBox(3, 3, 6, 6);
    clearBox(0, 9, 5, 11);
    const filled = fillHoles(mask, width, width);
    assert.equal(filled[4 * width + 4], 1, 'the hole in the middle is filled');
    assert.equal(filled[10 * width + 2], 0, 'the notch that reaches the edge is left');
});

test('a hole that touches the outside only at a corner is still a hole, because background is read as 4-connected', () => {
    const width = 6;
    const mask = new Uint8Array(width * width).fill(1);
    mask[2 * width + 2] = 0;
    mask[3 * width + 3] = 0;
    mask[1 * width + 1] = 0;
    assert.equal(fillHoles(mask, width, width)[2 * width + 2], 1);
    assert.equal(labelComponents(mask, width, width, 8).areas.length, 1);
    assert.equal(labelComponents(Uint8Array.from(mask, (value) => 1 - value), width, width, 4).areas.length, 3, 'three separate background pixels');
    assert.equal(labelComponents(Uint8Array.from(mask, (value) => 1 - value), width, width, 8).areas.length, 1, 'but one piece when corners count');
});
