import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contrastRatio, luminance, parseHex } from '../scripts/lib/github-colour.mjs';
import { drawWordmark, wordmarkSize } from '../scripts/lib/github-vector.mjs';
import { WORDMARK_ADVANCE, WORDMARK_INK, WORDMARK_PATH, WORDMARK_TEXT, WORDMARK_UNITS_PER_EM } from '../scripts/lib/github-wordmark.mjs';
import { sha256 } from '../scripts/lib/log.mjs';
import { opaqueBox } from '../scripts/lib/raster.mjs';

test('the wordmark is the one word, drawn from pinned outlines of Adwaita Sans ExtraBold', () => {
    assert.equal(WORDMARK_TEXT, 'SillyBunny');
    assert.equal(WORDMARK_UNITS_PER_EM, 2048);
    assert.equal(WORDMARK_ADVANCE, 10944);
    assert.deepEqual({ ...WORDMARK_INK }, { left: 71.9, top: -1585.4, right: 10921.7, bottom: 426 });
    assert.equal(sha256(Buffer.from(WORDMARK_PATH)), '96afac912b8445fbe2896c4190ec922522af6538a6b6ff57d32d2c0c563b72c1', 'a regenerated outline that differs must be looked at before the pin moves');
});

test('the wordmark is drawn at its font size, and its ink fills the box that the size promises', async () => {
    for (const size of [60, 112, 180]) {
        const expected = wordmarkSize(size);
        const drawn = await drawWordmark({ size, colour: '#24152f' });
        assert.deepEqual({ width: drawn.width, height: drawn.height }, expected);
        const ink = opaqueBox(drawn, 128);
        assert.ok(ink.x <= 2 && ink.y <= 2, `the ink starts at the box's corner at ${size}`);
        assert.ok(drawn.width - (ink.x + ink.width) <= 2 && drawn.height - (ink.y + ink.height) <= 2, `and ends at its far corner at ${size}`);
    }
});

test('the wordmark has one colour: every pixel that is drawn is that colour, only its alpha varies', async () => {
    const drawn = await drawWordmark({ size: 112, colour: '#24152f' });
    const colours = new Set();
    for (let at = 0; at < drawn.data.length; at += 4) {
        if (drawn.data[at + 3] === 255) {
            colours.add(`${drawn.data[at]},${drawn.data[at + 1]},${drawn.data[at + 2]}`);
        }
    }
    assert.deepEqual([...colours], ['36,21,47']);
});

test('colours are six hex digits, and the contrast ratio is the WCAG one', () => {
    assert.deepEqual(parseHex('#b99bf2'), { r: 185, g: 155, b: 242 });
    for (const bad of ['b99bf2', '#b99bf', '#b99bf2ff', '#gggggg', undefined]) {
        assert.throws(() => parseHex(bad), /six hex digits/);
    }
    assert.equal(luminance(parseHex('#ffffff')), 1);
    assert.equal(luminance(parseHex('#000000')), 0);
    assert.equal(contrastRatio('#000000', '#ffffff'), 21);
    assert.equal(contrastRatio('#ffffff', '#000000'), 21);
    assert.equal(contrastRatio('#808080', '#808080'), 1);
});
