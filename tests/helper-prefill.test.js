import { describe, expect, test } from '@jest/globals';

import {
    appendHelperPrefillMessages,
    parseHelperPrefillMessages,
    serializeHelperPrefillForPrompt,
} from '../public/scripts/extensions/helper-prefill.js';

describe('helper prefill role blocks', () => {
    test('parses role blocks in order with multiline content', () => {
        const input = `[system]
Follow the helper rules.

[user]
Current scene:
Rain on glass.

[assistant]
Let me`;

        expect(parseHelperPrefillMessages(input)).toEqual([
            { role: 'system', content: 'Follow the helper rules.' },
            { role: 'user', content: 'Current scene:\nRain on glass.' },
            { role: 'assistant', content: 'Let me' },
        ]);
    });

    test('treats unheaded text as assistant prefill and drops empty blocks', () => {
        const input = `Begin directly here.

[system]

[USER]
Keep this context.

[assistant]
`;

        expect(parseHelperPrefillMessages(input)).toEqual([
            { role: 'assistant', content: 'Begin directly here.' },
            { role: 'user', content: 'Keep this context.' },
        ]);
    });

    test('appends parsed prefill messages without mutating the base messages', () => {
        const baseMessages = [{ role: 'system', content: 'Base prompt.' }];
        const result = appendHelperPrefillMessages(baseMessages, '[assistant]\nStart');

        expect(result).toEqual([
            { role: 'system', content: 'Base prompt.' },
            { role: 'assistant', content: 'Start' },
        ]);
        expect(baseMessages).toEqual([{ role: 'system', content: 'Base prompt.' }]);
    });

    test('serializes role blocks for prompt-only helpers', () => {
        const messages = parseHelperPrefillMessages('[system]\nRules\n\n[user]\nContext\n\n[assistant]\nStart');

        expect(serializeHelperPrefillForPrompt(messages)).toBe(
            'SYSTEM:\nRules\n\nUSER:\nContext\n\nASSISTANT:\nStart',
        );
    });
});
