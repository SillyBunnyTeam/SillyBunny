import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { circleMask, coverBox, gradientBackground, placeSprite, renderAvatars, renderCard, trimSprite } from '../scripts/lib/card-image.mjs';
import { parseCardConfig } from '../scripts/lib/card-config.mjs';
import { opaqueBox } from '../scripts/lib/raster.mjs';
import { BAND, DRESS, EAR, RIM, waistSprite } from '../test-support/waist-sprite.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const REAL_CONFIG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'card-config.json'), 'utf8'));
const config = parseCardConfig(REAL_CONFIG);
const near = (colour, target, tolerance = 6) => colour.slice(0, 3).every((channel, index) => Math.abs(channel - target[index]) <= tolerance);
const isSticker = (colour) => near(colour, RIM, 40) || near(colour, BAND, 20);

/** The card as RGBA pixels, the way a viewer decodes it. */
async function decoded(png) {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
}

/** The box of the pixels of a card that are not the gradient: the sprite as it was drawn. */
function spriteBoxOf(card, background) {
    const mask = createRaster(card.width, card.height);
    const rows = gradientBackground(card, background);
    for (let at = 0; at < card.width * card.height; at++) {
        const differs = [0, 1, 2].some((channel) => Math.abs(card.data[at * 4 + channel] - rows[at * 3 + channel]) > 12);
        mask.data[at * 4 + 3] = differs ? 255 : 0;
    }
    return opaqueBox(mask, 255);
}

test('the waist cut loses the white band and the rim along the bottom, and keeps them up the sides', () => {
    const art = waistSprite({ cutRow: 520, stickerWidth: 8 });
    const { sprite, cut } = trimSprite(art, config.sprite);
    assert.equal(cut.lastArtRow, 519, 'the last row of the dress is the last row of art');
    assert.equal(cut.stickerRows, 16, 'the band and the rim are 8 rows each');
    assert.equal(cut.lastKeptRow, 519 - config.sprite.sticker.inset);
    const bottom = sprite.height - 1;
    for (let x = Math.round(sprite.width * 0.3); x < Math.round(sprite.width * 0.7); x++) {
        assert.ok(near(getPixel(sprite, x, bottom), DRESS), `the last row is dress at ${x}`);
    }
    const leftmost = [...Array(sprite.height).keys()].map((y) => getPixel(sprite, 0, y)).filter(([, , , alpha]) => alpha === 255);
    assert.ok(leftmost.some((colour) => near(colour, RIM)), 'the rim still runs up the side of the sprite');
});

test('the cut is made from the rows of the picture, so a sprite with a different cut row and sticker width is cut at its own', () => {
    for (const [cutRow, stickerWidth] of [[480, 5], [540, 10]]) {
        const { cut } = trimSprite(waistSprite({ cutRow, stickerWidth }), config.sprite);
        assert.equal(cut.lastArtRow, cutRow - 1);
        assert.equal(cut.stickerRows, 2 * stickerWidth);
    }
});

test('a picture that is nothing but sticker, one with no visible pixel, and a sticker deeper than allowed are refused', () => {
    const sticker = createRaster(20, 20);
    for (let y = 0; y < 20; y++) {
        for (let x = 0; x < 20; x++) {
            setPixel(sticker, x, y, [...BAND, 255]);
        }
    }
    assert.throws(() => trimSprite(sticker, config.sprite), /Every row of the card art looks like the sticker/);
    assert.throws(() => trimSprite(createRaster(20, 20), config.sprite), /nothing to put on the card/);
    assert.throws(() => trimSprite(waistSprite({ cutRow: 400, stickerWidth: 30 }), config.sprite), /60 rows at the bottom .* more than the 48/);
});

test('the sprite is placed as large as fits inside the margins, centred, with its last row on the last row of the canvas', () => {
    const canvas = { width: 768, height: 1152 };
    const margins = { sideMargin: 16, topMargin: 16 };
    const wide = placeSprite({ width: 1024, height: 1388 }, canvas, margins);
    assert.deepEqual([wide.width, wide.height, wide.left, wide.top], [736, 998, 16, 154], 'limited by the width');
    const tall = placeSprite({ width: 300, height: 1000 }, canvas, margins);
    assert.equal(tall.top, 16, 'limited by the height, it ends at the top margin');
    assert.ok(Math.abs(tall.left + tall.width / 2 - canvas.width / 2) <= 0.5, 'centred, to the pixel');
    for (const placed of [wide, tall]) {
        assert.equal(placed.top + placed.height, canvas.height, 'flush with the bottom edge');
        assert.ok(placed.left >= margins.sideMargin - 1 && placed.left + placed.width <= canvas.width - margins.sideMargin + 1);
        assert.ok(placed.top >= margins.topMargin);
    }
});

test('the card is 768x1152, opaque (no alpha channel at all), with the gradient top and bottom colours at its edges', async () => {
    const { sprite } = trimSprite(waistSprite(), config.sprite);
    const placement = placeSprite(sprite, config.canvas, config.sprite);
    const { png, rgb } = await renderCard(sprite, config, placement);
    const meta = await sharp(png).metadata();
    assert.deepEqual([meta.width, meta.height, meta.channels, meta.hasAlpha, meta.format], [768, 1152, 3, false, 'png']);
    const card = await decoded(png);
    assert.ok([...Array(card.width * card.height).keys()].every((at) => card.data[at * 4 + 3] === 255), 'every pixel is opaque');
    assert.equal(meta.paletteBitDepth, undefined, 'stored as RGB, not as a palette, so no colour is reduced');
    assert.ok((await sharp(png).removeAlpha().raw().toBuffer()).equals(rgb), 'the PNG decodes to exactly the pixels that were drawn');
    assert.deepEqual(getPixel(card, 0, 0).slice(0, 3), config.background.top);
    assert.deepEqual(getPixel(card, 767, 0).slice(0, 3), config.background.top);
    assert.deepEqual(getPixel(card, 0, 1151).slice(0, 3), config.background.bottom, 'the corner beside the sprite shows the bottom colour');
    const middle = getPixel(card, 0, 575).slice(0, 3);
    assert.ok(middle.every((channel, index) => channel < config.background.top[index] && channel > config.background.bottom[index]), 'the gradient runs between the two colours');
});

test('the waist cut is flush with the bottom edge and no white or lavender line runs across it', async () => {
    const { sprite } = trimSprite(waistSprite(), config.sprite);
    const placement = placeSprite(sprite, config.canvas, config.sprite);
    const card = await decoded((await renderCard(sprite, config, placement)).png);
    const body = [placement.left + Math.round(placement.width * 0.3), placement.left + Math.round(placement.width * 0.7)];
    for (let y = card.height - 1; y >= card.height - 40; y--) {
        for (let x = body[0]; x < body[1]; x++) {
            assert.ok(!isSticker(getPixel(card, x, y)), `row ${y}, column ${x} is sticker coloured`);
        }
    }
    for (let x = body[0]; x < body[1]; x++) {
        assert.ok(near(getPixel(card, x, card.height - 1), DRESS, 14), 'the last row of the card is the dress, not the gradient');
    }
    assert.equal(spriteBoxOf(card, config.background).y + spriteBoxOf(card, config.background).height, card.height, 'the sprite reaches the last row');
});

test('the ear tips and the sides stay inside the canvas and its margins, for a sprite limited by the width and one limited by the height', async () => {
    for (const art of [waistSprite({ width: 700, height: 600, earReach: 4 }), waistSprite({ width: 260, height: 900, cutRow: 820, earReach: 10 })]) {
        const { sprite } = trimSprite(art, config.sprite);
        const placement = placeSprite(sprite, config.canvas, config.sprite);
        const card = await decoded((await renderCard(sprite, config, placement)).png);
        const box = spriteBoxOf(card, config.background);
        assert.ok(box.x >= config.sprite.sideMargin - 2, `left edge ${box.x}`);
        assert.ok(box.x + box.width <= card.width - config.sprite.sideMargin + 2, `right edge ${box.x + box.width}`);
        assert.ok(box.y >= config.sprite.topMargin - 2, `top edge ${box.y}`);
        // The ears are the widest part and reach the top of their own height, so a cut would show as a clipped rim at the box's sides.
        const earRows = [...Array(box.height).keys()].map((row) => row + box.y);
        const withFur = earRows.filter((y) => [...Array(box.width).keys()].some((offset) => near(getPixel(card, box.x + offset, y), EAR, 14)));
        assert.ok(withFur.length > 20, 'the ears are drawn');
        const leftEdge = [...Array(box.height).keys()].map((row) => getPixel(card, box.x + 3, box.y + row));
        assert.ok(leftEdge.some((colour) => isSticker(colour)), 'the rim of the left ear is inside the card, not cut off');
    }
});

test('the avatar crop is the centre band of the card, full width, as the app\'s object-fit: cover shows it; the circle has transparent corners and an opaque centre', async () => {
    const canvas = { width: 768, height: 1152 };
    assert.deepEqual(coverBox(canvas), { x: 0, y: 192, width: 768, height: 768 });
    assert.deepEqual(coverBox({ width: 100, height: 60 }), { x: 20, y: 0, width: 60, height: 60 }, 'a wide picture is cut at the sides');
    const box = coverBox(canvas);

    const flat = createRaster(32, 32);
    flat.data.fill(200);
    const round = circleMask(flat);
    assert.equal(getPixel(round, 0, 0)[3], 0);
    assert.equal(getPixel(round, 31, 31)[3], 0);
    assert.equal(getPixel(round, 16, 16)[3], 200);
    assert.equal(getPixel(flat, 0, 0)[3], 200, 'the input is not changed');

    const rgb = Buffer.alloc(canvas.width * canvas.height * 3, 100);
    const avatars = await renderAvatars(rgb, canvas, box, [128, 50]);
    assert.deepEqual(avatars.map(({ size, shape }) => `${size}-${shape}`), ['128-square', '128-circle', '50-square', '50-circle']);
    for (const { size, png } of avatars) {
        const meta = await sharp(png).metadata();
        assert.deepEqual([meta.width, meta.height], [size, size]);
    }

    const banded = Buffer.alloc(canvas.width * canvas.height * 3);
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            banded.set([y >> 3, x >> 3, 0], (y * canvas.width + x) * 3);
        }
    }
    const [full] = await renderAvatars(banded, canvas, box, [768]);
    assert.deepEqual(getPixel(full.raster, 0, 0).slice(0, 2), [192 >> 3, 0], 'the first row of the avatar is row 192 of the card');
    assert.deepEqual(getPixel(full.raster, 767, 767).slice(0, 2), [959 >> 3, 767 >> 3], 'the last is row 959, at the full width');
});

test('the real card-config.json parses, and a bad one is refused before any picture is read', () => {
    assert.deepEqual([config.canvas.width, config.canvas.height], [768, 1152]);
    assert.deepEqual(config.background, { top: [0xf5, 0xe9, 0xff], bottom: [0xd9, 0xc2, 0xf0] });
    assert.deepEqual(config.avatar.sizes, [128, 50]);
    assert.equal(config.world, 'SillyBunny Lexicon');
    assert.deepEqual(Object.values(config.cards).map(({ output }) => output), ['default/content/default_AssistantReisen.png', 'default/content/default_AssistantTewi.png']);
    const changed = (edit) => {
        const copy = structuredClone(REAL_CONFIG);
        edit(copy);
        return () => parseCardConfig(copy);
    };
    assert.throws(changed((raw) => { raw.extra = 1; }), /unknown key "extra"/);
    assert.throws(changed((raw) => { raw.background.top = 'lavender'; }), /background\.top must be a hex colour/);
    assert.throws(changed((raw) => { raw.canvas.width = 7.5; }), /canvas\.width must be a whole number/);
    assert.throws(changed((raw) => { raw.sprite.sticker.rowShare = 0; }), /rowShare must be a number above 0/);
    assert.throws(changed((raw) => { raw.sprite.sideMargin = 400; }), /margins leave no room/);
    assert.throws(changed((raw) => { raw.cards.reisen.output = 'out/x.png'; }), /must be default\/content\/default_<Name>\.png/);
    assert.throws(changed((raw) => { raw.cards = {}; }), /cards needs at least one card/);
    assert.throws(changed((raw) => { raw.cards['re.isen'] = raw.cards.reisen; }), /card id "re\.isen" may hold letters, digits, "_" and "-" only/);
    assert.throws(changed((raw) => { raw.cards['../x'] = raw.cards.reisen; }), /card id "\.\.\/x" may hold/);
});
