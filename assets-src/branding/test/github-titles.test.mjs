import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakTitle, drawTitle, titleSize, titleWords } from '../scripts/lib/github-text.mjs';
import { TITLE_LINE_HEIGHT, TITLE_UNITS_PER_EM, TITLE_WORDS, TITLES } from '../scripts/lib/github-titles.mjs';
import { sha256 } from '../scripts/lib/log.mjs';
import { opaqueBox } from '../scripts/lib/raster.mjs';

const OUTLINES_HASH = '29b15b06f769733310084789e5eb3f773df74f5fe61b598068099f39e7ed662c';
const WORD_LIST = ['Features', 'and', 'Project', 'Philosophy', 'Installation', 'Getting', 'Started', 'Contributing', 'Credits', 'Community', 'Support'];

test('the titles are the maintainer\'s words, exactly, and nothing else can be drawn', () => {
    assert.deepEqual({ ...TITLES }, {
        features: 'Features and Project Philosophy',
        install: 'Installation and Getting Started',
        contributing: 'Contributing',
        credits: 'Credits',
        community: 'Community and Support',
    });
    for (const key of Object.keys(TITLES)) {
        assert.deepEqual(titleWords(key), TITLES[key].split(' '));
    }
    assert.throws(() => titleWords('about'), /"about" is not a section title/);
    assert.throws(() => breakTitle('about', { size: 100 }), /not a section title/);
});

test('every word of every title has outlines, and the outlines are the pinned ones', () => {
    assert.deepEqual(Object.keys(TITLE_WORDS).filter((word) => word !== ' ').sort(), [...WORD_LIST].sort());
    for (const key of Object.keys(TITLES)) {
        for (const word of titleWords(key)) {
            assert.ok(TITLE_WORDS[word].d.length > 0 && TITLE_WORDS[word].ink !== null, word);
        }
    }
    assert.equal(TITLE_UNITS_PER_EM, 2048);
    assert.equal(TITLE_WORDS[' '].advance, 448);
    const advances = WORD_LIST.map((word) => TITLE_WORDS[word].advance);
    assert.deepEqual(advances, [8894, 3812, 7217, 11377, 11515, 7495, 7550, 12898, 7385, 11867, 8218]);
    const outlines = sha256(Buffer.from(WORD_LIST.map((word) => TITLE_WORDS[word].d).join('\n')));
    assert.equal(outlines, OUTLINES_HASH, 'a regenerated outline that differs must be looked at before the pin moves');
});

test('a title is one line without a width, and breaks between words, greedily, with a width', () => {
    assert.deepEqual(breakTitle('features', { size: 136 }), [['Features', 'and', 'Project', 'Philosophy']]);
    assert.deepEqual(breakTitle('features', { size: 136, maxWidth: 1400 }), [['Features', 'and', 'Project'], ['Philosophy']]);
    assert.deepEqual(breakTitle('install', { size: 136, maxWidth: 1400 }), [['Installation', 'and'], ['Getting', 'Started']]);
    assert.deepEqual(breakTitle('community', { size: 136, maxWidth: 1400 }), [['Community', 'and'], ['Support']]);
    assert.deepEqual(breakTitle('contributing', { size: 136, maxWidth: 1400 }), [['Contributing']]);
    assert.deepEqual(breakTitle('features', { size: 136, maxWidth: 900 }), [['Features', 'and'], ['Project'], ['Philosophy']]);
});

test('no line is wider than the width it was given, and a word that cannot fit is an error and is never cut', () => {
    for (const key of Object.keys(TITLES)) {
        for (const maxWidth of [900, 1100, 1400, 2000]) {
            const lines = breakTitle(key, { size: 136, maxWidth });
            assert.deepEqual(lines.flat(), titleWords(key), 'every word stays, in order');
            for (const line of lines) {
                const width = (line.reduce((sum, word) => sum + TITLE_WORDS[word].advance, 0) + TITLE_WORDS[' '].advance * (line.length - 1)) * 136 / TITLE_UNITS_PER_EM;
                assert.ok(line.length === 1 || width <= maxWidth, `${key} at ${maxWidth}: "${line.join(' ')}" is ${width.toFixed(0)}`);
            }
        }
    }
    assert.throws(() => breakTitle('contributing', { size: 136, maxWidth: 500 }), /The word "Contributing" is 857 px wide.*wider than the 500 px/);
});

test('a title is drawn at the size it promises, in one flat colour, with its lines one line height apart', async () => {
    for (const [key, maxWidth] of [['features', 1400], ['credits', undefined], ['community', 1400]]) {
        const promised = titleSize(key, { size: 136, maxWidth });
        const drawn = await drawTitle({ title: key, size: 136, colour: '#f5e9ff', maxWidth });
        assert.deepEqual({ width: drawn.width, height: drawn.height }, promised);
        const ink = opaqueBox(drawn, 128);
        assert.ok(ink.x <= 2 && ink.y <= 2 && drawn.width - (ink.x + ink.width) <= 2 && drawn.height - (ink.y + ink.height) <= 2, `${key} ink fills its box`);
        const colours = new Set();
        for (let at = 0; at < drawn.data.length; at += 4) {
            if (drawn.data[at + 3] === 255) {
                colours.add(`${drawn.data[at]},${drawn.data[at + 1]},${drawn.data[at + 2]}`);
            }
        }
        assert.deepEqual([...colours], ['245,233,255']);
    }
    const one = titleSize('community', { size: 136 });
    const two = titleSize('community', { size: 136, maxWidth: 1400 });
    assert.ok(two.height - one.height >= Math.round(TITLE_LINE_HEIGHT * 136) - 4, 'a second line adds one line height');
    assert.ok(two.width < one.width);
});

test('the same title is the same pixels, run after run', async () => {
    const first = await drawTitle({ title: 'install', size: 100, colour: '#5b3c6b', maxWidth: 1000 });
    const second = await drawTitle({ title: 'install', size: 100, colour: '#5b3c6b', maxWidth: 1000 });
    assert.equal(Buffer.compare(Buffer.from(first.data), Buffer.from(second.data)), 0);
});
