import { describe, expect, test } from '@jest/globals';

import { firstEmoji } from '../public/scripts/sillybunny-conversation/emoji/emoji-validate.js';

describe('firstEmoji', () => {
    test.each([
        ['one emoji', '😂', '😂'],
        ['several emoji', '😂👍🎉', '😂'],
        ['several emoji with spaces between', '😂 👍', '😂'],
        ['an emoji that is text by default, qualified', '❤', '❤️'],
        ['a sequence, whole', '👨‍👩‍👧😂', '👨‍👩‍👧'],
        ['an emoji with whitespace around it', '  😂\n', '😂'],
    ])('takes the first of %s', (_name, text, expected) => {
        expect(firstEmoji(text)).toBe(expected);
    });

    test.each([
        ['nothing', ''],
        ['a word', 'laughing'],
        ['an emoji with a letter', '😂a'],
        ['a word before an emoji', 'lol 😂'],
        ['not a string', undefined],
    ])('answers nothing for %s', (_name, text) => {
        expect(firstEmoji(text)).toBe('');
    });
});
