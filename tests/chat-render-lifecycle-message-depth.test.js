import { describe, expect, test } from '@jest/globals';

import { getNonSystemMessageDepth } from '../public/scripts/chat-render-lifecycle/message-depth.js';

function legacyNonSystemMessageDepth(messages, messageId) {
    const usableMessages = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => !message.is_system);
    const indexOf = usableMessages.findIndex(({ index }) => index === messageId);

    return messageId >= 0 && indexOf !== -1 ? usableMessages.length - indexOf - 1 : undefined;
}

describe('chat render lifecycle message depth', () => {
    test('matches the legacy non-system message depth behavior', () => {
        const messages = [
            { is_system: false },
            { is_system: true },
            { is_system: false },
            { is_system: false },
            { is_system: true },
            { is_system: false },
        ];

        for (let messageId = -1; messageId <= messages.length; messageId++) {
            expect(getNonSystemMessageDepth(messages, messageId)).toBe(legacyNonSystemMessageDepth(messages, messageId));
        }
    });

    test('returns the number of non-system messages after the target', () => {
        expect(getNonSystemMessageDepth([
            { is_system: false },
            { is_system: false },
            { is_system: true },
            { is_system: false },
        ], 0)).toBe(2);
    });

    test('returns undefined for system and invalid targets', () => {
        const messages = [
            { is_system: false },
            { is_system: true },
            { is_system: false },
        ];

        expect(getNonSystemMessageDepth(messages, 1)).toBeUndefined();
        expect(getNonSystemMessageDepth(messages, -1)).toBeUndefined();
        expect(getNonSystemMessageDepth(messages, 3)).toBeUndefined();
        expect(getNonSystemMessageDepth(messages, 1.5)).toBeUndefined();
        expect(getNonSystemMessageDepth(null, 0)).toBeUndefined();
    });
});
