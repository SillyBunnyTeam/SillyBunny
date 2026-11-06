import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { buildFixSheet, enclosedBox, flowGroups, placeLetters, plateFills, regionPixels } from '../scripts/lib/fix-check.mjs';

// A plate in the form the plate files have: the outline written once and used for the lip and the plate, then the emblem, here a
// block with a hole in it for the letters. `at` moves the block and `hole` is the hole's size.
const plate = ({ at = [20, 20], hole = 20, side = 100 } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"><defs><path id="o" d="M0 0h${side}v${side}h-${side}z"/></defs><use href="#o" fill="#e4d2f5"/><use href="#o" fill="#f5e9ff"/><path fill="#8b64aa" d="M${at[0]} ${at[1]}h60v60h-60zM${at[0] + 20} ${at[1] + 20}v${hole}h${hole}v-${hole}z"/></svg>`;
const LETTERS = { left: 0, top: 0, right: 20, bottom: 20 };
const TITLE = 30;

const raw = async (svg, size) => sharp(Buffer.from(svg), { density: (72 * size) / 100 }).resize(size, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

test('the fills of the lip and the plate are read from the two uses of the outline', () => {
    assert.deepEqual(plateFills(plate()), { lip: '#e4d2f5', plate: '#f5e9ff' });
    assert.throws(() => plateFills('<svg viewBox="0 0 10 10"><path fill="#000000" d="M0 0z"/></svg>'), /lip and plate colours/);
});

test('the pixels of a picture that are like the page but shut in by the shape are boxed, and the page around it is not', async () => {
    const { data, info } = await raw(plate(), 200);
    const box = enclosedBox({ data, width: info.width, height: info.height, backgrounds: ['#e4d2f5', '#f5e9ff'] });
    // The hole is 40 to 60 in a 100 unit picture drawn at 200 px.
    for (const [value, expected] of [[box.left, 80], [box.top, 80], [box.right, 120], [box.bottom, 120]]) {
        assert.ok(Math.abs(value - expected) <= 2, `${JSON.stringify(box)}`);
    }
});

test('a picture with nothing shut in has no box', async () => {
    const { data, info } = await raw('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><path id="o" d="M0 0h100v100h-100z"/></defs><use href="#o" fill="#e4d2f5"/><use href="#o" fill="#f5e9ff"/><path fill="#8b64aa" d="M20 20h60v60h-60z"/></svg>', 100);
    assert.equal(enclosedBox({ data, width: info.width, height: info.height, backgrounds: ['#e4d2f5', '#f5e9ff'] }), undefined);
});

test('the letters are found at the scale asked for, and a region of the master is placed from them', async () => {
    const placed = await placeLetters(plate(), LETTERS, 4);
    // The letters are 20 units wide for 20 master pixels, so a master pixel is a unit, and at 4 pixels to a master pixel the picture is 400 px.
    assert.ok(Math.abs(placed.size - 400) <= 3, `${placed.size}`);
    assert.ok(Math.abs(placed.perSource - 4) < 0.1, `${placed.perSource}`);
    const region = regionPixels(placed, LETTERS, { x: -10, y: -10, width: 40, height: 40 });
    // The hole starts at 40 units, which is 160 px; 10 master pixels before the letters' corner is 40 px earlier.
    assert.ok(Math.abs(region.left - 120) <= 2 && Math.abs(region.top - 120) <= 2, JSON.stringify(region));
    assert.ok(Math.abs(region.width - 160) <= 1 && Math.abs(region.height - 160) <= 1);
});

test('a picture that has been moved is placed from where its letters are, so the same region shows the same part', async () => {
    const moved = await placeLetters(plate({ at: [30, 25] }), LETTERS, 4);
    const still = await placeLetters(plate(), LETTERS, 4);
    const [a, b] = [regionPixels(still, LETTERS, { x: 0, y: 0, width: 10, height: 10 }), regionPixels(moved, LETTERS, { x: 0, y: 0, width: 10, height: 10 })];
    assert.ok(Math.abs(b.left - a.left - 40) <= 2 && Math.abs(b.top - a.top - 20) <= 2, `${JSON.stringify([a, b])}`);
});

test('a picture whose letters are not there is an error that says which', async () => {
    await assert.rejects(placeLetters('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><path id="o" d="M0 0h100v100h-100z"/></defs><use href="#o" fill="#e4d2f5"/><use href="#o" fill="#f5e9ff"/></svg>', LETTERS, 4), /no letters/);
});

test('groups of tiles wrap onto a new row when the next group would pass the width, and each group stays together', () => {
    const tile = (width, height) => ({ width, height });
    const { positions, height } = flowGroups([[tile(100, 50), tile(100, 60)], [tile(100, 40), tile(100, 40)], [tile(100, 80)]], 450, { gap: 10, caption: 20 });
    // The first group is 210 wide, the second 210: 430 with the gap between them fits in 450. The third does not.
    assert.deepEqual(positions[0].map(({ left, top }) => [left, top]), [[0, 0], [110, 0]]);
    assert.deepEqual(positions[1].map(({ left, top }) => [left, top]), [[220, 0], [330, 0]]);
    assert.deepEqual(positions[2].map(({ left, top }) => [left, top]), [[0, 90]]);
    assert.equal(height, 90 + 80 + 20);
});

test('a group wider than the sheet still gets a row of its own', () => {
    const { positions } = flowGroups([[{ width: 300, height: 10 }, { width: 300, height: 10 }], [{ width: 50, height: 10 }]], 400, { gap: 10, caption: 0 });
    assert.deepEqual(positions[0].map(({ left }) => left), [0, 310]);
    assert.deepEqual(positions[1][0], { left: 0, top: 20 });
});

test('the sheet has the old and the new of each plate side by side, the whole and then the regions', async () => {
    const regions = [{ id: 'a', label: 'one', x: -5, y: -5, width: 30, height: 30 }, { id: 'b', label: 'two', x: 0, y: 0, width: 20, height: 20 }];
    const sheet = await buildFixSheet({ letters: LETTERS, plates: [{ label: 'logo-plate', oldSvg: plate(), newSvg: plate({ at: [24, 24] }) }], regions, wholeSize: 128, scale: 4, maxWidth: 1000 });
    const { width, height, format } = await sharp(sheet).metadata();
    assert.equal(format, 'png');
    assert.ok(width >= 128 * 2 && width <= 1000 + 40, `${width}`);
    // A title and a row that holds the two whole pictures and the two regions' pairs, 128 px tall and a caption under each.
    assert.ok(height > TITLE + 128 + 24 && height < 400, `${height}`);
});

test('a plate in the sheet that is the same size as the other but has no letters stops the sheet', async () => {
    const empty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><path id="o" d="M0 0h100v100h-100z"/></defs><use href="#o" fill="#e4d2f5"/><use href="#o" fill="#f5e9ff"/></svg>';
    await assert.rejects(buildFixSheet({ letters: LETTERS, plates: [{ label: 'logo-plate', oldSvg: plate(), newSvg: empty }], regions: [], wholeSize: 128, scale: 4, maxWidth: 1000 }), /logo-plate.*new.*no letters/);
});

test('a region outside the drawing is an error that names it', async () => {
    const placed = await placeLetters(plate(), LETTERS, 4);
    assert.throws(() => regionPixels(placed, LETTERS, { x: 500, y: 0, width: 10, height: 10, label: 'far off' }), /"far off" is outside/);
});
