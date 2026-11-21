/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { getAssistantSubtitle, getGreetingArtAlt } = await import('../../public/scripts/sillybunny-home/assistant-copy.js');

describe('the subtitles of the assistant cards', () => {
    test.each([
        ['reisen', 'Did you need help with setup or troubleshooting? Leave it to me!'],
        ['tewi', 'Gege~ Are you a little down on your luck? Ask me anything!'],
        ['pointer', 'Chosen from your character library.'],
        ['own', 'Pick any character from your library as a third assistant.'],
    ])('of %s', (id, text) => {
        expect(getAssistantSubtitle(id)).toBe(text);
    });

    test('is empty for a card that has none', () => {
        expect(getAssistantSubtitle('guide')).toBe('');
    });
});

describe('the description of a greeting picture', () => {
    test.each([
        ['reisen', 'Early one evening, Reisen waves from her low desk among stacks of paperwork, tea and a mortar of herbs, while Tewi\'s ear peeks round the door.'],
        ['tewi', 'Late at night, Tewi rests her chin on her hands at the desk beside a newspaper and carrots, while Reisen sleeps over her papers under a blanket.'],
    ])('of %s', (id, text) => {
        expect(getGreetingArtAlt(id)).toBe(text);
    });

    test('is empty for an assistant without a picture', () => {
        expect(getGreetingArtAlt('guide')).toBe('');
    });
});
