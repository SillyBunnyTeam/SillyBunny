import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    SUBTITLE_TEXT,
    SUBTITLE_UNITS_PER_EM,
    SUBTITLE_WEIGHT,
    SUBTITLE_WORDS,
    drawSubtitle,
    parseSubtitleAlign,
    parseSubtitleLines,
    subtitleSize,
    subtitleXHeight,
} from '../scripts/lib/github-subtitle.mjs';
import { sha256 } from '../scripts/lib/log.mjs';
import { opaqueBox } from '../scripts/lib/raster.mjs';

const THREE_LINES = ['A SillyTavern fork with a Bun runtime,', 'detailed human interface guidelines,', 'and modernised features!'];

test('the subtitle is the maintainer\'s sentence, word for word, drawn from pinned outlines of Adwaita Sans SemiBold', () => {
    assert.equal(SUBTITLE_TEXT, 'A SillyTavern fork with a Bun runtime, detailed human interface guidelines, and modernised features!');
    assert.equal(SUBTITLE_WEIGHT, 600);
    assert.equal(SUBTITLE_UNITS_PER_EM, 2048);
    assert.deepEqual(Object.keys(SUBTITLE_WORDS), [' ', ...SUBTITLE_TEXT.split(' ').filter((word, at, all) => all.indexOf(word) === at)]);
    const outlines = Object.entries(SUBTITLE_WORDS).map(([word, { advance, d }]) => `${word}|${advance}|${d}`).join('\n');
    assert.equal(sha256(Buffer.from(outlines)), 'f76b91b66b6da5059817c3dc200f6c36218e67a3cd1d08dc3ca2a5e6353e855e', 'a regenerated outline that differs must be looked at before the pin moves');
});

test('the lines may break the sentence anywhere between words, and may not change it', () => {
    assert.deepEqual(parseSubtitleLines(THREE_LINES, 'x'), THREE_LINES);
    assert.deepEqual(parseSubtitleLines([SUBTITLE_TEXT], 'x'), [SUBTITLE_TEXT], 'one long line');
    const two = ['A SillyTavern fork with a Bun runtime, detailed human', 'interface guidelines, and modernised features!'];
    assert.deepEqual(parseSubtitleLines(two, 'x'), two, 'two lines with other breaks');
    assert.throws(() => parseSubtitleLines(['A SillyTavern fork with a Bun runtime,', 'detailed human interface guidelines,', 'and modernized features!'], 'el'), /el\.lines read .* which is not the subtitle/);
    assert.throws(() => parseSubtitleLines(THREE_LINES.slice(0, 2), 'el'), /not the subtitle/, 'a word left out');
    assert.throws(() => parseSubtitleLines([], 'el'), /el\.lines must be a list of lines of text/);
    assert.throws(() => parseSubtitleLines(['', SUBTITLE_TEXT], 'el'), /el\.lines must be a list of lines of text/);
    assert.throws(() => parseSubtitleAlign('right', 'el'), /el\.align must be one of left, centre/);
});

test('the subtitle is drawn at its font size, and its ink fills the box that the size promises', async () => {
    for (const size of [34, 40, 42]) {
        for (const align of ['left', 'centre']) {
            const drawn = await drawSubtitle({ lines: THREE_LINES, size, colour: '#70507f', align });
            assert.deepEqual({ width: drawn.width, height: drawn.height }, subtitleSize(THREE_LINES, { size }));
            const ink = opaqueBox(drawn, 128);
            assert.ok(ink.x <= 2 && ink.y <= 2, `the ink starts at the box's corner at ${size}, ${align}`);
            assert.ok(drawn.width - (ink.x + ink.width) <= 2 && drawn.height - (ink.y + ink.height) <= 2, `and ends at its far corner at ${size}, ${align}`);
        }
    }
});

test('centred lines have the same room either side, and left lines start at the same edge', async () => {
    /** The left and right ink of each line: the lines are the bands of rows that have ink, with a clear row between them. */
    const rowsOf = (drawn) => {
        const rowHasInk = (y) => Array.from({ length: drawn.width }, (_, x) => drawn.data[(y * drawn.width + x) * 4 + 3] >= 128);
        const bands = [];
        for (let y = 0; y < drawn.height; y++) {
            const ink = rowHasInk(y);
            if (!ink.includes(true)) {
                continue;
            }
            const band = y > 0 && rowHasInk(y - 1).includes(true) ? bands.at(-1) : bands[bands.push({ left: Infinity, right: -Infinity }) - 1];
            band.left = Math.min(band.left, ink.indexOf(true));
            band.right = Math.max(band.right, ink.lastIndexOf(true));
        }
        return bands;
    };
    const centred = rowsOf(await drawSubtitle({ lines: THREE_LINES, size: 42, colour: '#70507f', align: 'centre' }));
    assert.equal(centred.length, 3, 'three lines');
    for (const { left, right } of centred.slice(1)) {
        assert.ok(Math.abs(left - (757 - right)) <= 6, `the room left (${left}) and right (${757 - right}) of a centred line`);
    }
    const flush = rowsOf(await drawSubtitle({ lines: THREE_LINES, size: 42, colour: '#70507f', align: 'left' }));
    assert.equal(flush.length, 3);
    for (const { left } of flush) {
        assert.ok(left <= 6, `a left line starts at the edge (${left})`);
    }
});

test('a size is read by the height of its lowercase letters, the x of the font', () => {
    assert.ok(Math.abs(subtitleXHeight(2048) - 1118) < 1e-9);
    assert.ok(Math.abs(subtitleXHeight(42) - 22.93) < 0.01);
});

test('a word that was never baked cannot be drawn, and says so', () => {
    assert.throws(() => subtitleSize(['Hello there'], { size: 40 }), /"Hello" is not one of the words of the subtitle/);
});
