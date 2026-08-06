import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    escapeRegex: value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
}));

const {
    CHAT_LABEL_TITLE_LIMIT,
    extractGeneratedChatLabel,
    normalizeGeneratedChatLabel,
} = await import('../public/scripts/chat-label.js');

describe('chat auto-label parser', () => {
    test('accepts valid structured and plain labels', () => {
        const cases = [
            ['{"title":"Moonlit Escape"}', 'Moonlit Escape'],
            ['{"label":"A Pact at Dawn"}', 'A Pact at Dawn'],
            ['{"name":"The Hidden Observatory"}', 'The Hidden Observatory'],
            ['"Letters from the North"', 'Letters from the North'],
            ['"[Letters] from {the North}"', 'Letters from the North'],
            ['{"title":null,"label":"The Silver Compass"}', 'The Silver Compass'],
            ['```json\n{"title":"A Dance in Winter"}\n```', 'A Dance in Winter'],
            ['<think>This needs a concise title.</think>\n{"title":"The Last Lantern"}', 'The Last Lantern'],
            ['A Quiet Morning', 'A Quiet Morning'],
            ['Chat title: Rowan - Midnight / Escape?', 'Midnight Escape'],
            ['**Label:** The {Moonlit} [Garden]', 'The Moonlit Garden'],
            ['I considered several options.\nTitle: The Clockwork Masquerade\nThis one is concise.', 'The Clockwork Masquerade'],
        ];

        for (const [response, expected] of cases) {
            expect(extractGeneratedChatLabel(response, 'Rowan')).toBe(expected);
        }
    });

    test('preserves title length and generic-label behavior', () => {
        expect(extractGeneratedChatLabel('Conversation')).toBe('');
        expect(extractGeneratedChatLabel('A'.repeat(CHAT_LABEL_TITLE_LIMIT + 20))).toBe('A'.repeat(CHAT_LABEL_TITLE_LIMIT));
    });

    test('rejects non-string input', () => {
        const cases = [
            null,
            undefined,
            42,
            true,
            ['Moonlit Escape'],
            { title: 'Moonlit Escape' },
            new String('Moonlit Escape'),
        ];

        for (const response of cases) {
            expect(extractGeneratedChatLabel(response)).toBe('');
        }
    });

    test('rejects unsupported JSON values and wrappers', () => {
        const cases = [
            '{}',
            '[]',
            '["Moonlit Escape"]',
            '{"content":"Moonlit Escape"}',
            '{"result":{"title":"Moonlit Escape"}}',
            '{"title":{"text":"Moonlit Escape"}}',
            '{"title":["Moonlit Escape"]}',
            '{"title":42}',
            '{"title":"Moonlit Escape","metadata":{"source":"model"}}',
            '[object Object]',
            'Title: [object Object]',
            'Title: ["Moonlit Escape"]',
            'Content: Moonlit Escape',
            'null',
            'true',
            '42',
        ];

        for (const response of cases) {
            expect(extractGeneratedChatLabel(response)).toBe('');
        }
    });

    test('fails closed for malformed machine-shaped output', () => {
        const cases = [
            '{"title":"Moonlit Escape"',
            'Here is the JSON: {"title":"Moonlit Escape"}',
            '```json\n{"title":"Moonlit Escape"\n```',
            '"title": "Moonlit Escape"',
            'Title: ["Moonlit Escape"',
            'Here is the object: {"result":"Moonlit Escape"}',
            '<content>Moonlit Escape</content>',
        ];

        for (const response of cases) {
            expect(extractGeneratedChatLabel(response)).toBe('');
        }
    });

    test('does not use multiline explanations as a label', () => {
        expect(extractGeneratedChatLabel('Moonlit Escape\nA concise title for the conversation.')).toBe('');
        expect(extractGeneratedChatLabel('Title: Moonlit Escape\nLabel: A Different Choice')).toBe('');
    });

    test('normalization strips filename punctuation and rejects arbitrary values', () => {
        expect(normalizeGeneratedChatLabel('Name: A {Map} [Beyond] / Time?')).toBe('A Map Beyond Time');
        expect(normalizeGeneratedChatLabel({ title: 'Moonlit Escape' })).toBe('');
    });
});
