import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTACT_KINDS, findContacts, paintContactShadows, proposeContacts, shadowEllipse, strengthOf } from '../scripts/lib/github-contact.mjs';
import { buildLayout } from '../scripts/lib/github-build.mjs';
import { parseGithubConfig } from '../scripts/lib/github-config.mjs';
import { rulerCrop } from '../scripts/lib/github-contact-ruler.mjs';
import { createRaster, readRaster } from '../scripts/lib/raster.mjs';

const RING = 4;

/** A sticker: parts given as inclusive boxes of the figure, each grown by the rings, so the picture is the figure with its rim and band all round. */
function sticker(width, height, parts) {
    const art = createRaster(width, height);
    for (const { x0, x1, y0, y1 } of parts) {
        for (let y = y0 - RING; y <= y1 + RING; y++) {
            for (let x = x0 - RING; x <= x1 + RING; x++) {
                art.data.set([90, 60, 120, 255], (y * width + x) * 4);
            }
        }
    }
    return art;
}

const FIGURE = [
    { x0: 20, x1: 59, y0: 10, y1: 40 },
    { x0: 20, x1: 29, y0: 41, y1: 89 },
    { x0: 50, x1: 59, y0: 41, y1: 85 },
    { x0: 70, x1: 74, y0: 20, y1: 60 },
];

test('the contacts are the columns that stand on the ground: the sole of each foot, not the rim under it, and not a hanging hand', () => {
    const contacts = findContacts(sticker(100, 110, FIGURE));
    assert.deepEqual(contacts, [{ x0: 20, x1: 29, y: 89 }, { x0: 50, x1: 59, y: 85 }], 'two feet, on their soles; the arm that ends at row 60 is not one');
});

test('how far from the lowest point a foot may be is the reach, and neighbouring columns of one foot are one contact however the sole curves', () => {
    const art = sticker(100, 110, FIGURE);
    assert.deepEqual(findContacts(art, { reach: 2 }).map(({ x0 }) => x0), [20], 'a foot 4 rows higher is out of a reach of 2');
    assert.equal(findContacts(art, { reach: 45 }).length, 3, 'and the hand, which ends 29 rows above the lowest point, is in at a reach of 45');
    const toes = sticker(70, 70, [{ x0: 10, x1: 42, y0: 10, y1: 30 }, { x0: 10, x1: 14, y0: 31, y1: 50 }, { x0: 24, x1: 28, y0: 31, y1: 48 }, { x0: 38, x1: 42, y0: 31, y1: 50 }]);
    assert.equal(findContacts(toes, { gap: 9 }).length, 1, 'a heel, a toe and the middle of a sole, 9 columns apart, are one contact at a gap of 9');
    assert.equal(findContacts(toes, { gap: 3 }).length, 3, 'and three at a gap of 3');
});

test('a picture with no figure left once its rings are taken off has no contact to find, and says so', () => {
    assert.throws(() => findContacts(sticker(30, 30, [{ x0: 12, x1: 14, y0: 12, y1: 14 }]), { inset: 6 }), /no figure left once its 6 pixel rings are taken off/);
});

test('detection only proposes: the columns on the ground are contacts, and a part that ends higher is a raised one standing on the ground row, for a person to confirm', () => {
    const art = sticker(100, 110, FIGURE);
    assert.deepEqual(proposeContacts(art, { raisedReach: 20 }), [{ kind: 'contact', x0: 20, x1: 29, y: 89 }, { kind: 'contact', x0: 50, x1: 59, y: 85 }], 'a hand that hangs 29 rows above the ground is out of a reach of 20');
    assert.deepEqual(proposeContacts(art, { raisedReach: 45 }), [
        { kind: 'contact', x0: 20, x1: 29, y: 89 },
        { kind: 'contact', x0: 50, x1: 59, y: 85 },
        { kind: 'raised', x0: 70, x1: 74, y: 89 },
    ]);
});

test('a picture with no run on the ground wide enough proposes nothing, and not a raised part standing on a ground row that is not there', () => {
    const narrow = sticker(100, 110, [{ x0: 20, x1: 21, y0: 10, y1: 40 }, { x0: 60, x1: 61, y0: 20, y1: 50 }]);
    assert.deepEqual(findContacts(narrow), [], 'two columns are under the minimum width of 3');
    assert.deepEqual(proposeContacts(narrow, { raisedReach: 60 }), []);
    assert.equal(JSON.stringify(proposeContacts(narrow, { raisedReach: 60 })).includes('Infinity'), false);
});

test('the ruler crop is the bottom rows at the zoom with a margin for the numbers, whole picture when it has fewer rows than asked', async () => {
    const art = sticker(100, 110, FIGURE);
    const { width, height } = await readRaster(await rulerCrop(art, { rows: 40, zoom: 3 }));
    assert.deepEqual([width, height], [100 * 3 + 36, 40 * 3 + 36]);
    const whole = await readRaster(await rulerCrop(art, { rows: 500, zoom: 2 }));
    assert.deepEqual([whole.width, whole.height], [100 * 2 + 36, 110 * 2 + 36]);
});

const FLAT = () => createRaster(200, 120);
function flatGround() {
    const canvas = FLAT();
    for (let at = 0; at < canvas.data.length; at += 4) {
        canvas.data.set([200, 200, 200, 255], at);
    }
    return canvas;
}
const pixel = (canvas, x, y) => canvas.data[(y * canvas.width + x) * 4];
const STRENGTHS = { contact: 1, footprint: 0.5, raised: 0.5 };
const PLACING = { box: { x: 10, y: 10 }, step: 2, grid: { x: 0, y: 0, step: 6 }, inset: 4, offset: { x: 0, y: 0 } };
const SHADOW = { ...PLACING, tint: '#808080', strengths: STRENGTHS, bands: 3 };
const SHOE = { kind: 'contact', x0: 20, x1: 29, y: 30 };

test('a contact shadow is the ground multiplied by the tint, strongest in the middle and fainter band by band, and the ground away from it is not touched', () => {
    const canvas = flatGround();
    const { cells } = paintContactShadows(canvas, { ...SHADOW, contacts: [SHOE] });
    assert.ok(cells > 10);
    const { centreX, centreY, radiusX } = shadowEllipse(SHOE, PLACING);
    assert.equal(pixel(canvas, centreX, centreY), 100, 'full strength of a mid grey tint halves the ground');
    const outer = pixel(canvas, centreX + radiusX - 8, centreY);
    assert.ok(outer > 100 && outer < 200, `fainter at the edge (${outer})`);
    assert.equal(pixel(canvas, centreX + radiusX + 20, centreY), 200);
    assert.equal(pixel(canvas, centreX, 0), 200);
});

test('the shadow is made of the blocks of the plate: every pixel of a block has the same shade, and two contacts that overlap are not darker where they do', () => {
    const canvas = flatGround();
    paintContactShadows(canvas, { ...SHADOW, contacts: [SHOE] });
    const { centreX, centreY } = shadowEllipse(SHOE, PLACING);
    const left = Math.floor(centreX / 6) * 6;
    const top = Math.floor(centreY / 6) * 6;
    for (let dy = 0; dy < 6; dy++) {
        for (let dx = 0; dx < 6; dx++) {
            assert.equal(pixel(canvas, left + dx, top + dy), pixel(canvas, left, top), 'one block, one shade');
        }
    }
    const twice = flatGround();
    paintContactShadows(twice, { ...SHADOW, contacts: [SHOE, SHOE] });
    assert.deepEqual(twice.data, canvas.data);
});

test('the width of a shadow follows the width of what casts it, in the same proportion everywhere, and its height is the same for every width', () => {
    const narrow = shadowEllipse({ kind: 'contact', x0: 20, x1: 29, y: 30 }, PLACING);
    const wide = shadowEllipse({ kind: 'contact', x0: 20, x1: 109, y: 30 }, PLACING);
    assert.ok(wide.radiusX > 4 * narrow.radiusX, `${wide.radiusX} against ${narrow.radiusX}`);
    assert.equal(wide.radiusY, narrow.radiusY);
    assert.ok(Math.abs(narrow.radiusX / (10 + 8) - wide.radiusX / (90 + 8)) < 0.001 * wide.radiusX, 'the sticker round the part sets the width, 4 pixels of ring each side');
    assert.equal(shadowEllipse({ kind: 'contact', x0: 20, x1: 29, y: 30 }, { ...PLACING, step: 3 }).radiusX, narrow.radiusX * 1.5, 'and so does the step the art is drawn at');
});

test('a footprint is wider and lighter than a contact of the same part, and a raised part is smaller and fainter, with its middle on the ground row and not sunk into the rings', () => {
    const part = { x0: 20, x1: 69, y: 30 };
    const [contact, footprint, raised] = ['contact', 'footprint', 'raised'].map((kind) => shadowEllipse({ kind, ...part }, PLACING));
    assert.ok(footprint.radiusX > contact.radiusX, 'a footprint is the wider');
    assert.ok(raised.radiusX < contact.radiusX && raised.radiusY < contact.radiusY, 'a raised shadow is the smaller');
    assert.ok(strengthOf({ kind: 'footprint' }, STRENGTHS) < strengthOf({ kind: 'contact' }, STRENGTHS));
    assert.ok(strengthOf({ kind: 'raised' }, STRENGTHS) < strengthOf({ kind: 'contact' }, STRENGTHS));
    assert.equal(strengthOf({ kind: 'raised', strength: 0.2 }, STRENGTHS), 0.2, 'an entry may set its own');
    assert.equal(raised.centreY, PLACING.box.y + (part.y + 1) * PLACING.step, 'on the ground row below the part');
    assert.ok(contact.centreY > raised.centreY, 'a contact lies lower, at the bottom edge of the rings of the sole');
    assert.deepEqual(CONTACT_KINDS, ['contact', 'footprint', 'raised']);
});

test('the light moves a shadow in whole blocks of the ground and a mirrored light moves it the other way, so that a shadow of a day plate falls to the right and a mirrored one to the left', () => {
    const straight = shadowEllipse(SHOE, PLACING);
    const right = shadowEllipse(SHOE, { ...PLACING, offset: { x: 1, y: 0 } });
    const left = shadowEllipse(SHOE, { ...PLACING, offset: { x: -1, y: 0 } });
    assert.deepEqual([right.centreX - straight.centreX, left.centreX - straight.centreX], [6, -6], 'a block of the grid of the ground, 6 pixels here');
    assert.deepEqual([right.centreY, left.centreY], [straight.centreY, straight.centreY]);
    const painted = (offset) => {
        const canvas = flatGround();
        paintContactShadows(canvas, { ...SHADOW, offset, contacts: [SHOE] });
        return canvas;
    };
    const darkEdge = (canvas, side) => {
        const { centreX, centreY, radiusX } = straight;
        return pixel(canvas, Math.round(centreX + side * (radiusX - 10)), Math.round(centreY));
    };
    assert.ok(darkEdge(painted({ x: 1, y: 0 }), 1) < darkEdge(painted({ x: -1, y: 0 }), 1), 'darker on the right when the light moves it right');
    assert.ok(darkEdge(painted({ x: -1, y: 0 }), -1) < darkEdge(painted({ x: 1, y: 0 }), -1), 'and on the left when it moves it left');
});

const FEET_COLOURS = { lavender: '#b99bf2', logo: '#8b64aa', plum: '#5b3c6b', pale: '#f5e9ff', night: '#1c1228' };
const FEET_ART = sticker(40, 60, [{ x0: 10, x1: 29, y0: 5, y1: 40 }]);
const FEET_LISTED = [{ kind: 'contact', x0: 10, x1: 29, y: 40 }, { kind: 'raised', x0: 2, x1: 8, y: 40 }];
const FEET_SHADOW = { tint: 'plum', bands: 3, inset: 4, strengths: STRENGTHS, offset: { x: 0, y: 0 } };
const feetSources = (contacts) => ({ plateSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>', emblemSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>', art: { feet: FEET_ART }, contacts, backdrops: {}, placeholders: [] });
/** A 240x160 layout with the feet scene at 70,20 at step 2, with a shadow or without one, and `before` elements ahead of it. */
const feetLayout = (shadow, before = []) => parseGithubConfig({
    colours: FEET_COLOURS,
    sources: { plate: 'p.svg', emblem: 'e.svg', art: { feet: 'f.png' } },
    assets: { avatar: { width: 240, height: 160, maxBytes: 1000000 }, social: { width: 1280, height: 640, maxBytes: 1000000 }, banner: { width: 2560, height: 800, maxBytes: 1000000 } },
    contacts: shadow ? { feet: FEET_LISTED } : {},
    final: {},
    layouts: [{ id: 'test', asset: 'avatar', background: 'pale', width: 240, height: 160, elements: [...before, { type: 'art', source: 'feet', step: 2, at: { left: 70, top: 20 }, ...(shadow ? { shadow } : {}) }] }],
}).layouts[0];

test('a layout with a contact shadow darkens the ground under the feet before the art is drawn, from the contacts that the config lists, and refuses a contact outside the art or a scene with none', async () => {
    const plain = await buildLayout(feetLayout(undefined), { colours: FEET_COLOURS, sources: feetSources({}) });
    const shadowed = await buildLayout(feetLayout(FEET_SHADOW), { colours: FEET_COLOURS, sources: feetSources({ feet: FEET_LISTED }) });
    const place = shadowed.placements.find(({ type }) => type === 'art');
    assert.deepEqual(place.contacts, FEET_LISTED, 'the contacts that the config lists are the ones painted, found by no detection');
    assert.ok(place.shadowCells > 0);
    const at = (raster, x, y) => [...raster.data.subarray((y * raster.width + x) * 4, (y * raster.width + x) * 4 + 3)];
    assert.deepEqual(at(plain.raster, 75, 120), [245, 233, 255], 'the ground is the background without a shadow');
    assert.notDeepEqual(at(shadowed.raster, 90, 112), at(plain.raster, 90, 112), 'and darker under the foot with one');
    assert.deepEqual(at(shadowed.raster, 70 + 20, 20 + 20), at(plain.raster, 70 + 20, 20 + 20), 'the art is drawn over the shadow, so the figure is as it was');
    await assert.rejects(buildLayout(feetLayout(FEET_SHADOW), { colours: FEET_COLOURS, sources: feetSources({ feet: [{ kind: 'contact', x0: 10, x1: 49, y: 40 }] }) }), /the contact of "feet" at columns 10-49, row 40 is outside the 40x60 art/);
    await assert.rejects(buildLayout(feetLayout(FEET_SHADOW), { colours: FEET_COLOURS, sources: feetSources({}) }), /the art "feet" has a contact shadow but no contacts are listed for it/);
});

test('a shadow is cast on the ground alone, so it never darkens a bar that lies where the shadow falls', async () => {
    const bar = { type: 'bar', unit: 8, widthCells: 10, heightCells: 3, layers: [{ colour: 'plum', inset: 0, notch: 0 }, { colour: 'pale', inset: 1, notch: 0 }], at: { left: 60, top: 98 } };
    const options = (contacts) => ({ colours: FEET_COLOURS, sources: feetSources(contacts) });
    const plain = await buildLayout(feetLayout(undefined, [bar]), options({}));
    const shadowed = await buildLayout(feetLayout(FEET_SHADOW, [bar]), options({ feet: FEET_LISTED }));
    const onBar = (x, y) => x >= 60 && x < 140 && y >= 98 && y < 122;
    const differs = (x, y) => !shadowed.raster.data.subarray((y * 240 + x) * 4, (y * 240 + x) * 4 + 4).equals(plain.raster.data.subarray((y * 240 + x) * 4, (y * 240 + x) * 4 + 4));
    let onTheBar = 0;
    let onTheGround = 0;
    for (let y = 0; y < 160; y++) {
        for (let x = 0; x < 240; x++) {
            if (differs(x, y)) {
                onTheBar += onBar(x, y) ? 1 : 0;
                onTheGround += onBar(x, y) ? 0 : 1;
            }
        }
    }
    assert.equal(onTheBar, 0, 'not one pixel of the bar is darker for the shadow');
    assert.ok(onTheGround > 20, `and the shadow is there on the ground round the bar (${onTheGround} pixels)`);
    const overlap = shadowed.placements.find(({ type }) => type === 'art');
    assert.ok(overlap.x < 140 && overlap.x + overlap.width > 60 && overlap.y + overlap.height > 98, 'the bar lies under the feet, where the shadow falls');
});
