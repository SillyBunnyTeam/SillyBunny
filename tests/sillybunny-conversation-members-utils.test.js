import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    escapeRegex: value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
}));

const {
    getRecentlySilentMentionedMemberFromConversation,
    getSpeakerPrefixMatch,
    isCharacterMentionedInText,
    parseAvatarList,
    stripSpeakerPrefixText,
} = await import('../public/scripts/sillybunny-conversation/members-utils.js');

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
        const messages = [
            { role: 'user', mes: 'Grace already answered.' },
            { role: 'character', mes: 'yep', extra: { member_avatar: 'grace.png' } },
            { role: 'user', mes: '@Ada can you check this?' },
        ];

        expect(getRecentlySilentMentionedMemberFromConversation(messages, [ada, grace], 6)).toBe(ada);

        messages.push({ role: 'character', mes: 'looking now', extra: { member_avatar: 'ada.png' } });
        expect(getRecentlySilentMentionedMemberFromConversation(messages, [ada, grace], 6)).toBe(null);
    });

    test('strips generated speaker prefixes line by line', () => {
        expect(stripSpeakerPrefixText('**Ada:** hello\n{{char}} - checking', 'Ada')).toBe('hello\nchecking');
        expect(stripSpeakerPrefixText('Ada: hello', 'Ada', text => text.toUpperCase())).toBe('HELLO');
    });

    test('detects explicit generated speaker labels for group replies', () => {
        const speakers = [
            { name: 'Alhaitham', avatar: 'alhaitham.png' },
            { name: 'Kaveh', avatar: 'kaveh.png' },
        ];

        expect(getSpeakerPrefixMatch('Kaveh: did you just type as me', speakers)).toEqual({
            speaker: speakers[1],
            text: 'did you just type as me',
        });
        expect(getSpeakerPrefixMatch('I saw Kaveh: type that', speakers)).toBe(null);
    });
});
