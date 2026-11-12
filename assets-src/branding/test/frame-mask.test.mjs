import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    boxMask,
    cleanPicture,
    composeFrame,
    countOf,
    differenceMask,
    discDilate,
    discErode,
    discOpen,
    dropSpecks,
    fillPockets,
    growSilhouette,
    piecesOf,
    stickerExtra,
} from '../scripts/lib/frame-mask.mjs';
import { hasBinaryAlpha } from '../scripts/lib/raster.mjs';
import { figure } from '../test-support/figure.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const SKIN = [250, 215, 190, 255];
const ARM = { x: 185, y: 215, width: 80, height: 26 };
const FACE_KEEP = { name: 'face', box: { x: 120, y: 120, width: 60, height: 70 } };
const LEGS_KEEP = { name: 'legs', box: { x: 90, y: 400, width: 120, height: 120 } };

const paint = (raster, box, colour) => {
    for (let y = box.y; y < box.y + box.height; y++) {
        for (let x = box.x; x < box.x + box.width; x++) {
            setPixel(raster, x, y, colour);
        }
    }
};

/**
 * The base: the sticker figure. The edit: the same figure with a thinner sticker (the edit lost most of it), an arm that the base does not have, a changed
 * patch in the face, and what a model leaves behind: a faint dark cloud and a solid blob away from the figure, and a translucent pixel inside the body.
 */
function pair() {
    const base = figure();
    const edit = figure({ sticker: 2 });
    paint(edit, ARM, SKIN);
    paint(edit, { x: 140, y: 150, width: 22, height: 22 }, [10, 200, 40, 255]);
    paint(edit, { x: 20, y: 400, width: 40, height: 30 }, [20, 20, 30, 70]);
    paint(edit, { x: 250, y: 470, width: 30, height: 30 }, [20, 20, 30, 255]);
    setPixel(edit, 150, 300, [120, 150, 220, 40]);
    setPixel(base, 140, 450, [250, 215, 190, 200]);
    return { base, edit };
}

const sameAt = (one, two, at) => one.data.subarray(at * 4, at * 4 + 4).equals(two.data.subarray(at * 4, at * 4 + 4));

test('a cleaned picture is binary alpha with only the figure in it: the faint cloud and the blob that is not joined to it are dropped, a stray translucent pixel inside it is filled', () => {
    const { edit } = pair();
    const cleaned = cleanPicture(edit);
    assert.ok(hasBinaryAlpha(cleaned.raster));
    assert.deepEqual(getPixel(cleaned.raster, 30, 410), [0, 0, 0, 0], 'the cloud (alpha 70) is gone');
    assert.deepEqual(getPixel(cleaned.raster, 260, 480), [0, 0, 0, 0], 'the blob away from the figure is gone');
    assert.deepEqual(cleaned.dropped, { pixels: 900, pieces: 1 });
    assert.deepEqual(getPixel(cleaned.raster, 150, 300), [120, 150, 220, 255], 'the translucent pixel inside the body is opaque, in its own colour');
    assert.deepEqual(getPixel(cleaned.raster, 150, 120).slice(0, 3), getPixel(edit, 150, 120).slice(0, 3), 'colours are the picture\'s own');
    assert.throws(() => cleanPicture(createRaster(10, 10)), /no pixel that is 160 opaque or more/);
});

test('a hole in the figure is kept when it is a gap and filled when it is a flaw: only holes under the limit are filled', () => {
    const picture = createRaster(60, 60);
    paint(picture, { x: 5, y: 5, width: 50, height: 50 }, [200, 100, 100, 255]);
    paint(picture, { x: 20, y: 20, width: 3, height: 3 }, [0, 0, 0, 0]);
    paint(picture, { x: 30, y: 30, width: 12, height: 12 }, [0, 0, 0, 0]);
    const cleaned = cleanPicture(picture, 160, 50);
    assert.equal(getPixel(cleaned.raster, 21, 21)[3], 255, 'the 9 pixel hole is filled');
    assert.equal(getPixel(cleaned.raster, 35, 35)[3], 0, 'the 144 pixel gap stays');
});

test('only what changed is taken from the edit: outside the cut every pixel is the base\'s own, byte for byte, and the changed region is the arm and what came with it', () => {
    const { base, edit } = pair();
    const result = composeFrame({ base, edit, keep: [FACE_KEEP, LEGS_KEEP] });
    assert.equal(result.raster.width, base.width);
    for (let at = 0; at < result.cut.length; at++) {
        if (result.cut[at] === 0) {
            assert.ok(sameAt(result.raster, base, at), `pixel ${at} is not the base's`);
        }
    }
    assert.deepEqual(getPixel(result.raster, 230, 228), SKIN, 'the arm is the edit\'s');
    const box = (mask) => {
        const at = [...mask.keys()].filter((index) => mask[index] === 1);
        return { left: Math.min(...at.map((index) => index % base.width)), right: Math.max(...at.map((index) => index % base.width)), top: Math.min(...at.map((index) => Math.floor(index / base.width))), bottom: Math.max(...at.map((index) => Math.floor(index / base.width))) };
    };
    const cut = box(result.cut);
    const reach = result.settings.growRadius + result.sticker.radius + 2;
    assert.ok(cut.left >= ARM.x - reach && cut.right <= ARM.x + ARM.width + reach && cut.top >= ARM.y - reach && cut.bottom <= ARM.y + ARM.height + reach, `the cut ${JSON.stringify(cut)} is the arm and a margin, not a rectangle around the figure`);
    assert.ok(countOf(result.cut) < (ARM.width + 2 * reach) * (ARM.height + 2 * reach), 'and it follows the arm, with room to spare in the corners of its box');
});

test('there is no blending: every pixel of the frame is a pixel of the base or a pixel of the cleaned edit, and the alpha inside the cut is binary', () => {
    const { base, edit } = pair();
    const result = composeFrame({ base, edit, keep: [FACE_KEEP, LEGS_KEEP] });
    const grown = growSilhouette(cleanPicture(edit).raster, result.sticker.radius);
    for (let at = 0; at < result.cut.length; at++) {
        const own = result.cut[at] === 1 ? grown : base;
        assert.ok(sameAt(result.raster, own, at), `pixel ${at}`);
        if (result.cut[at] === 1) {
            assert.ok(result.raster.data[at * 4 + 3] === 0 || result.raster.data[at * 4 + 3] === 255);
        }
    }
});

test('the smudges do not come through: the cloud and the blob are not in the frame, and the translucent pixel does not make a hole in the arm', () => {
    const { base, edit } = pair();
    const result = composeFrame({ base, edit, keep: [FACE_KEEP, LEGS_KEEP] });
    assert.deepEqual(getPixel(result.raster, 30, 410), [0, 0, 0, 0]);
    assert.deepEqual(getPixel(result.raster, 260, 480), [0, 0, 0, 0]);
    assert.equal(result.dropped.edit.pieces, 1);
    assert.equal(result.cut[410 * base.width + 30], 0);
});

test('a part to keep stays the base\'s even where the edit changed it, and the frame says how much it held back', () => {
    const { base, edit } = pair();
    const kept = composeFrame({ base, edit, keep: [FACE_KEEP, LEGS_KEEP] });
    assert.deepEqual(getPixel(kept.raster, 145, 155), getPixel(base, 145, 155), 'the changed patch of the face is the base\'s');
    assert.ok(kept.held.changedInKeep >= 250, `${kept.held.changedInKeep} changed pixels were held back`);
    const open = composeFrame({ base, edit, keep: [LEGS_KEEP] });
    assert.deepEqual(getPixel(open.raster, 145, 155), [10, 200, 40, 255], 'without the keep the edit\'s patch comes through');
});

test('the cut does not grow into a part to keep that lies next to what changed: those pixels stay the base\'s and the frame counts them', () => {
    const { base, edit } = pair();
    const next = { name: 'next-to-arm', box: { x: 150, y: 205, width: 33, height: 60 } };
    const result = composeFrame({ base, edit, keep: [FACE_KEEP, LEGS_KEEP, next] });
    assert.ok(result.held.grownIntoKeep > 50, `${result.held.grownIntoKeep} pixels of the grown cut fell in the part`);
    for (let y = next.box.y; y < next.box.y + next.box.height; y++) {
        for (let x = next.box.x; x < next.box.x + next.box.width; x++) {
            assert.equal(result.cut[y * base.width + x], 0);
            assert.ok(sameAt(result.raster, base, y * base.width + x));
        }
    }
});

test('where a new part of the edit runs into a part to keep, its outline turns into the base\'s outline over the stitch radius, so there is no ledge at the kept part\'s edge', () => {
    const { base, edit } = pair();
    paint(edit, { x: 80, y: 215, width: 32, height: 45 }, SKIN);
    const shelf = { name: 'shelf', box: { x: 60, y: 245, width: 150, height: 150 } };
    const keep = [FACE_KEEP, LEGS_KEEP, shelf];
    const open = composeFrame({ base, edit, keep, settings: { stitchRadius: 0 } });
    const stitched = composeFrame({ base, edit, keep });
    const opaqueAt = (result, x, y) => result.raster.data[(y * base.width + x) * 4 + 3];
    assert.equal(opaqueAt(open, 90, 244), 255, 'without the stitch the new part ends in a straight edge against the kept part');
    assert.equal(opaqueAt(stitched, 90, 244), 0, 'with it the outline there is the base\'s (nothing is outside the body)');
    assert.equal(opaqueAt(stitched, 90, 215), 255, 'the new part is whole at the stitch radius from the kept part, and away from it');
    assert.equal(opaqueAt(stitched, 90, 219), 255);
    for (let y = shelf.box.y; y < shelf.box.y + shelf.box.height; y++) {
        for (let x = shelf.box.x; x < shelf.box.x + shelf.box.width; x++) {
            assert.ok(sameAt(stitched.raster, base, y * base.width + x), 'the kept part is the base\'s');
        }
    }
    assert.ok(stitched.raster.data.every((value, at) => at % 4 !== 3 || value === 0 || value === 255 || sameAt(stitched.raster, base, (at - 3) / 4)), 'every pixel outside the base\'s own is binary');
});

test('a figure that touches the canvas edge works like any other: the cut reaches the edge, the change comes through there, and a kept part that runs off the canvas holds', () => {
    const [width, height] = [120, 120];
    const BODY = [200, 160, 150, 255];
    const base = createRaster(width, height);
    paint(base, { x: 0, y: 40, width: 90, height: 80 }, BODY);
    const edit = createRaster(width, height);
    paint(edit, { x: 0, y: 40, width: 90, height: 80 }, BODY);
    paint(edit, { x: 0, y: 70, width: 30, height: 30 }, [10, 200, 40, 255]);
    const cleaned = cleanPicture(edit, 160, 300);
    assert.equal(cleaned.mask[70 * width], 1, 'the figure\'s pixels on the edge column are kept');
    const result = composeFrame({ base, edit });
    assert.equal(result.cut[85 * width], 1, 'the cut includes the pixels on the left edge');
    assert.equal(result.cut[119 * width + 10], 0, 'the cut grows from the change and stops short of the bottom edge it is far from');
    assert.deepEqual(getPixel(result.raster, 0, 85), [10, 200, 40, 255]);
    assert.deepEqual(getPixel(result.raster, 29, 99), [10, 200, 40, 255]);
    assert.deepEqual(getPixel(result.raster, 80, 110), BODY, 'away from the change the pixel is the base\'s');
    const lower = { name: 'lower', box: { x: -10, y: 90, width: 60, height: 40 } };
    const kept = composeFrame({ base, edit, keep: [lower] });
    assert.ok(kept.held.changedInKeep > 0, 'the part of the change inside the box is held back');
    assert.deepEqual(getPixel(kept.raster, 0, 99), BODY, 'a box that starts and ends past the canvas still holds the pixels on the canvas');
    assert.deepEqual(getPixel(kept.raster, 0, 85), [10, 200, 40, 255], 'above the box the change still comes through');
});

test('the sticker the edit lacks is grown back: the silhouette around the arm reaches as far as the base\'s sticker does around the body', () => {
    const { base, edit } = pair();
    const result = composeFrame({ base, edit, keep: [FACE_KEEP, LEGS_KEEP] });
    assert.equal(result.sticker.radius, 8, 'the base has 12 pixels of sticker and the edit 4');
    assert.ok(result.sticker.score > 0.97);
    const armTop = result.raster.data[((ARM.y - 8) * base.width + 230) * 4 + 3];
    const aboveGrown = result.raster.data[((ARM.y - 10) * base.width + 230) * 4 + 3];
    assert.equal(armTop, 255, 'the arm\'s grown edge is opaque');
    assert.equal(aboveGrown, 0, 'and it stops there');
});

test('an edit that shows what the base shows changes nothing: no cut, and the frame is the base', () => {
    const { base } = pair();
    const result = composeFrame({ base, edit: figure(), keep: [] });
    assert.equal(countOf(result.cut), 0);
    assert.ok(result.raster.data.equals(base.data));
});

test('a picture of another size is refused', () => {
    const { base } = pair();
    assert.throws(() => composeFrame({ base, edit: createRaster(10, 10) }), /must be the same size/);
});

test('a drawing that the edit shifted by a pixel or two is not a difference, one shifted far is', () => {
    const base = createRaster(80, 80);
    paint(base, { x: 20, y: 20, width: 30, height: 30 }, [200, 60, 60, 255]);
    const shifted = (by) => {
        const edit = createRaster(80, 80);
        paint(edit, { x: 20 + by, y: 20, width: 30, height: 30 }, [200, 60, 60, 255]);
        return edit;
    };
    assert.equal(countOf(differenceMask(base, shifted(2))), 0);
    assert.ok(countOf(differenceMask(base, shifted(9))) > 100);
    assert.ok(countOf(differenceMask(base, shifted(0))) === 0);
});

test('morphology: dilation grows by a disc, erosion shrinks, opening removes what is thin, pieces are counted and specks and pockets are dealt with', () => {
    const [w, h] = [40, 40];
    const mask = boxMask({ x: 10, y: 10, width: 20, height: 20 }, w, h);
    assert.equal(countOf(mask), 400);
    const grown = discDilate(mask, w, h, 3);
    assert.equal(grown[10 * w + 7], 1);
    assert.equal(grown[10 * w + 6], 0);
    assert.equal(grown[7 * w + 7], 0, 'a disc, not a square: the corner is out of reach');
    assert.equal(discErode(mask, w, h, 3)[13 * w + 13], 1);
    assert.equal(discErode(mask, w, h, 3)[12 * w + 12], 0);
    const thin = Uint8Array.from(mask);
    for (let x = 0; x < 6; x++) {
        thin[2 * w + x] = 1;
    }
    assert.equal(discOpen(thin, w, h, 2)[2 * w + 3], 0, 'a line of one pixel does not survive an opening');
    assert.equal(discOpen(thin, w, h, 2)[20 * w + 20], 1);
    const twoPieces = Uint8Array.from(mask);
    twoPieces[2 * w + 2] = 1;
    assert.deepEqual(piecesOf(twoPieces, w, h).pieces.map(({ pixels }) => pixels), [400, 1]);
    assert.equal(countOf(dropSpecks(twoPieces, w, h, 5)), 400);
    const ring = Uint8Array.from(mask);
    ring[20 * w + 20] = 0;
    assert.equal(countOf(fillPockets(ring, w, h, 10)), 400);
    assert.equal(countOf(fillPockets(ring, w, h, 1)), 399, 'a pocket as big as the limit is left');
});

test('the sticker difference is measured where the pictures should agree and is 0 when they do', () => {
    const { base, edit } = pair();
    const [w, h] = [base.width, base.height];
    const baseMask = cleanPicture(base).mask;
    const editMask = cleanPicture(edit).mask;
    const within = boxMask(LEGS_KEEP.box, w, h);
    assert.equal(stickerExtra({ baseMask, editMask, within, width: w, height: h }).radius, 8);
    assert.equal(stickerExtra({ baseMask, editMask: baseMask, within, width: w, height: h }).radius, 0);
});
