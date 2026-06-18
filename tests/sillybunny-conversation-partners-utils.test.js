import { describe, expect, test } from '@jest/globals';

import {
    getRecentlySilentMentionedPartnerFromThread,
    isCharacterMentionedInText,
    parseAvatarList,
    stripSpeakerPrefixText,
} from '../public/scripts/sillybunny-conversation/partners-utils.js';

describe('sillybunny conversation partner utils', () => {
    test('parses configured partner avatar lists', () => {
        expect(parseAvatarList(' ada.png, , grace.png ,')).toEqual(['ada.png', 'grace.png']);
    });

    test('matches mention boundaries without substring false positives', () => {
        const ada = { name: 'Ada Lovelace', avatar: 'ada.png' };
        const grace = { name: 'Grace Hopper', avatar: 'grace.png' };

        expect(isCharacterMentionedInText(ada, 'can @Ada look at this?', [ada, grace])).toBe(true);
        expect(isCharacterMentionedInText(ada, 'the database looks fine', [ada, grace])).toBe(false);
    });

    test('does not resolve ambiguous first-name mentions', () => {
        const aliceHart = { name: 'Alice Hart', avatar: 'alice-hart.png' };
        const aliceChen = { name: 'Alice Chen', avatar: 'alice-chen.png' };

        expect(isCharacterMentionedInText(aliceHart, 'Alice should decide.', [aliceHart, aliceChen])).toBe(false);
        expect(isCharacterMentionedInText(aliceHart, '@AliceHart should decide.', [aliceHart, aliceChen])).toBe(true);
    });

    test('finds a recently mentioned partner who has not replied yet', () => {
        const ada = { name: 'Ada Lovelace', avatar: 'ada.png' };
        const grace = { name: 'Grace Hopper', avatar: 'grace.png' };
        const thread = [
            { role: 'user', mes: 'Grace already answered.' },
            { role: 'character', mes: 'yep', extra: { partner_avatar: 'grace.png' } },
            { role: 'user', mes: '@Ada can you check this?' },
        ];

        expect(getRecentlySilentMentionedPartnerFromThread(thread, [ada, grace], 6)).toBe(ada);

        thread.push({ role: 'character', mes: 'looking now', extra: { partner_avatar: 'ada.png' } });
        expect(getRecentlySilentMentionedPartnerFromThread(thread, [ada, grace], 6)).toBe(null);
    });

    test('strips generated speaker prefixes line by line', () => {
        expect(stripSpeakerPrefixText('**Ada:** hello\n{{char}} - checking', 'Ada')).toBe('hello\nchecking');
        expect(stripSpeakerPrefixText('Ada: hello', 'Ada', text => text.toUpperCase())).toBe('HELLO');
    });
});
