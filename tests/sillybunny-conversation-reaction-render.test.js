import { describe, expect, test } from '@jest/globals';

import { getConversationMessageExtraFingerprint } from '../public/scripts/sillybunny-conversation/render-utils.js';

const withReactions = conversation_reactions => ({ id: 'm1', role: 'character', extra: { conversation_reactions } });
const fingerprint = message => getConversationMessageExtraFingerprint(message);

describe('the render fingerprint of the reactions of a message', () => {
    test('is the same for a message with none, whichever way the absence is written', () => {
        expect(fingerprint(withReactions([]))).toBe(fingerprint({ id: 'm1', role: 'character', extra: {} }));
        expect(fingerprint(withReactions({}))).toBe(fingerprint({ id: 'm1', role: 'character' }));
    });

    test('changes when a reaction comes and when it goes', () => {
        const none = fingerprint(withReactions([]));
        const one = fingerprint(withReactions([{ emoji: '😂', by: 'user', at: 1 }]));
        const two = fingerprint(withReactions([{ emoji: '😂', by: 'user', at: 1 }, { emoji: '😂', by: 'aster.png', at: 2 }]));

        expect(new Set([none, one, two]).size).toBe(3);
    });

    test('changes when the user takes a reaction back and a character keeps the chip', () => {
        const both = fingerprint(withReactions([{ emoji: '😂', by: 'user', at: 1 }, { emoji: '😂', by: 'aster.png', at: 2 }]));
        const characterOnly = fingerprint(withReactions([{ emoji: '😂', by: 'aster.png', at: 2 }]));
        const userOnly = fingerprint(withReactions([{ emoji: '😂', by: 'user', at: 1 }]));

        expect(new Set([both, characterOnly, userOnly]).size).toBe(3);
    });

    test('does not change when the old object is rewritten as the array that says the same', () => {
        expect(fingerprint(withReactions({ heart: 1 }))).toBe(fingerprint(withReactions([{ emoji: '❤️', by: 'user', at: 99 }])));
    });

    test('does not change with the time of a reaction', () => {
        expect(fingerprint(withReactions([{ emoji: '😂', by: 'user', at: 1 }]))).toBe(fingerprint(withReactions([{ emoji: '😂', by: 'user', at: 2 }])));
    });
});
