import { describe, expect, test } from '@jest/globals';

import { CHAT_COMPLETION_SOURCES } from '../../src/constants.js';
import { CHAT_ID_FORWARDING_SOURCES, shouldForwardChatId } from '../../public/scripts/local-url-utils.js';

const FORWARDING_SOURCES = [
    CHAT_COMPLETION_SOURCES.FIREWORKS,
    CHAT_COMPLETION_SOURCES.OPENROUTER,
    CHAT_COMPLETION_SOURCES.OPENAI,
    CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
    CHAT_COMPLETION_SOURCES.XAI,
    CHAT_COMPLETION_SOURCES.MISTRALAI,
    CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
];

describe('shouldForwardChatId', () => {
    test('lists exactly the sources whose server code derives a routing key from the chat id', () => {
        expect([...CHAT_ID_FORWARDING_SOURCES].sort()).toEqual([...FORWARDING_SOURCES].sort());
    });

    test.each(FORWARDING_SOURCES)('forwards the chat id of main turns for %s', (source) => {
        expect(shouldForwardChatId(source, 'normal', 'main')).toBe(true);
        expect(shouldForwardChatId(source, 'swipe', undefined)).toBe(true);
        expect(shouldForwardChatId(source, 'continue', null)).toBe(true);
        expect(shouldForwardChatId(source, 'regenerate', '')).toBe(true);
        expect(shouldForwardChatId(source, 'impersonate', 'main')).toBe(true);
    });

    test.each(FORWARDING_SOURCES.filter(source => source !== CHAT_COMPLETION_SOURCES.FIREWORKS))('forwards the chat id of quiet requests and of other cache scopes for %s', (source) => {
        expect(shouldForwardChatId(source, 'quiet', 'auxiliary')).toBe(true);
        expect(shouldForwardChatId(source, 'quiet', undefined)).toBe(true);
        expect(shouldForwardChatId(source, 'quiet', 'conversation-mode')).toBe(true);
        expect(shouldForwardChatId(source, 'normal', 'auxiliary')).toBe(true);
    });

    test('keeps the chat id out of quiet Fireworks requests, as upstream does', () => {
        expect(shouldForwardChatId(CHAT_COMPLETION_SOURCES.FIREWORKS, 'quiet', 'auxiliary')).toBe(false);
        expect(shouldForwardChatId(CHAT_COMPLETION_SOURCES.FIREWORKS, 'quiet', undefined)).toBe(false);
        expect(shouldForwardChatId(CHAT_COMPLETION_SOURCES.FIREWORKS, 'normal', 'auxiliary')).toBe(true);
    });

    test.each(FORWARDING_SOURCES)('keeps the chat id out of requests that opt out of caching for %s', (source) => {
        expect(shouldForwardChatId(source, 'normal', 'none')).toBe(false);
        expect(shouldForwardChatId(source, 'quiet', 'none')).toBe(false);
    });

    test.each([
        CHAT_COMPLETION_SOURCES.CLAUDE,
        CHAT_COMPLETION_SOURCES.MAKERSUITE,
        CHAT_COMPLETION_SOURCES.CUSTOM,
        CHAT_COMPLETION_SOURCES.NANOGPT,
        CHAT_COMPLETION_SOURCES.DEEPSEEK,
        undefined,
    ])('never forwards the chat id for %s', (source) => {
        expect(shouldForwardChatId(source, 'normal', 'main')).toBe(false);
    });
});
