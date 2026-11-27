import { describe, expect, test } from '@jest/globals';

const { emojiKey, isSingleEmoji, qualifyEmoji } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-validate.js');

describe('isSingleEmoji', () => {
    test.each([
        ['a face', '😀'],
        ['a text-default symbol with its selector', '❤️'],
        ['a skin tone', '👍🏽'],
        ['a flag', '🇯🇵'],
        ['a subdivision flag', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'],
        ['a keycap', '1️⃣'],
        ['a keycap without its selector', '1⃣'],
        ['a ZWJ family', '👨‍👩‍👧'],
        ['a ZWJ sequence with a selector', '👨‍⚕️'],
        ['a rainbow flag', '🏳️‍🌈'],
        ['two people with two tones', '🧑🏻‍🤝‍🧑🏿'],
    ])('accepts %s', (_name, text) => {
        expect(isSingleEmoji(text)).toBe(true);
    });

    test.each([
        ['an empty text', ''],
        ['a letter', 'a'],
        ['digits', '12'],
        ['a single digit', '1'],
        ['a hash sign', '#'],
        ['a name', 'heart'],
        ['two emoji', '😀😀'],
        ['an emoji and a letter', '😀a'],
        ['a leading space', ' 😀'],
        ['a trailing space', '👍 '],
        ['two hearts', '❤️❤️'],
        ['a lone joiner', '‍'],
        ['a lone selector', '️'],
        ['a half flag', '🇯'],
        ['a dangling joiner', '😀‍'],
        ['a leading joiner', '‍😀'],
        ['a long text', 'x'.repeat(40)],
        ['a number', 5],
        ['null', null],
    ])('refuses %s', (_name, text) => {
        expect(isSingleEmoji(text)).toBe(false);
    });
});

describe('qualifyEmoji', () => {
    test.each([
        ['❤', '❤️'],
        ['☺', '☺️'],
        ['👨‍⚕', '👨‍⚕️'],
        ['1⃣', '1️⃣'],
        ['🏳‍🌈', '🏳️‍🌈'],
        ['©', '©️'],
        ['✔', '✔️'],
    ])('puts the selector on %s', (input, expected) => {
        expect(qualifyEmoji(input)).toBe(expected);
    });

    test.each(['☝🏽', '😀', '❤️', '🇯🇵', '1️⃣', '👨‍👩‍👧'])('leaves %s as it is', (text) => {
        expect(qualifyEmoji(text)).toBe(text);
    });
});

describe('emojiKey', () => {
    test('is the same for an emoji with and without its selector', () => {
        expect(emojiKey('❤')).toBe(emojiKey('❤️'));
        expect(emojiKey('👍🏽')).not.toBe(emojiKey('👍'));
    });
});
