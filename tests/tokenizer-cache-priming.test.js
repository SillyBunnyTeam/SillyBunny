/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockOaiSettings = {
    chat_completion_source: 'openai',
    openai_model: 'gpt-4-turbo',
};

await jest.unstable_mockModule('../public/lib.js', () => ({
    localforage: {
        createInstance: () => ({
            getItem: jest.fn(async () => ({})),
            setItem: jest.fn(async () => undefined),
        }),
    },
}));

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    event_types: {},
    eventSource: { on: jest.fn() },
    main_api: 'openai',
    nai_settings: {},
    online_status: 'no_connection',
    this_chid: undefined,
}));

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { tokenizer: 0 },
    registerDebugFunction: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/openai.js', () => ({
    chat_completion_sources: { OPENAI: 'openai' },
    model_list: [],
    oai_settings: mockOaiSettings,
}));

await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    groups: [],
    selected_group: null,
}));

// A real (if crude) hash, so distinct messages get distinct cache keys. The point of these
// tests is that priming and counting agree on the key, which a constant hash would hide.
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    getStringHash: jest.fn((value) => {
        let hash = 0;
        for (let i = 0; i < String(value).length; i++) {
            hash = (Math.imul(31, hash) + String(value).charCodeAt(i)) | 0;
        }
        return hash;
    }),
}));

await jest.unstable_mockModule('../public/scripts/kai-settings.js', () => ({
    kai_flags: {},
    kai_settings: {},
}));

await jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    textgen_types: {},
    textgenerationwebui_settings: { type: 'ooba' },
    getTextGenServer: jest.fn(() => ''),
    getTextGenModel: jest.fn(() => ''),
}));

await jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({
    getCurrentDreamGenModelTokenizer: jest.fn(),
    getCurrentOpenRouterModelTokenizer: jest.fn(),
    openRouterModels: [],
}));

const {
    countTokensOpenAIAsync,
    primeOpenAITokenCache,
} = await import('../public/scripts/tokenizers.js');

/**
 * Distinct messages, so every one of them needs its own cache entry. The token cache is
 * module state that outlives a single test, so each test passes its own tag to stay isolated.
 */
function makeMessages(count, tag) {
    return Array.from({ length: count }, (_, i) => ({ role: 'assistant', content: `${tag} message number ${i}` }));
}

describe('OpenAI token cache priming', () => {
    beforeEach(() => {
        globalThis.jQuery = { ajax: jest.fn() };
    });

    test('counts a whole batch of messages in a single request', async () => {
        const messages = makeMessages(25, 'batch');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: messages.map(() => 7) });

        await primeOpenAITokenCache(messages);

        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);
        const request = globalThis.jQuery.ajax.mock.calls[0][0];
        expect(request.url).toContain('per_message=1');
        expect(JSON.parse(request.data)).toHaveLength(25);
    });

    test('primed counts are reused by countTokensOpenAIAsync without further requests', async () => {
        const messages = makeMessages(3, 'reuse');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: [11, 22, 33] });

        await primeOpenAITokenCache(messages);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);

        // This is the contract that matters: the key primeOpenAITokenCache writes has to be
        // the key countTokensOpenAIAsync looks up, or priming silently does nothing.
        const counts = [];
        for (const message of messages) {
            counts.push(await countTokensOpenAIAsync(message, true));
        }

        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);
        expect(counts).toEqual([-1 + 11, -1 + 22, -1 + 33]);
    });

    test('skips messages that are already cached', async () => {
        const messages = makeMessages(2, 'skip');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: [5, 6] });

        await primeOpenAITokenCache(messages);
        await primeOpenAITokenCache(messages);

        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);
    });

    test('sends each distinct message once even when the history repeats one', async () => {
        const repeated = { role: 'user', content: 'same text' };
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: [9] });

        await primeOpenAITokenCache([repeated, { ...repeated }, { ...repeated }]);

        expect(JSON.parse(globalThis.jQuery.ajax.mock.calls[0][0].data)).toHaveLength(1);
    });

    test('a failed prime leaves counting to the unbatched path', async () => {
        const messages = makeMessages(2, 'failed');
        globalThis.jQuery.ajax.mockRejectedValue({ status: 500, statusText: 'Server Error', readyState: 4 });

        await expect(primeOpenAITokenCache(messages)).resolves.toBeUndefined();

        globalThis.jQuery.ajax.mockResolvedValue({ token_count: 4 });
        expect(await countTokensOpenAIAsync(messages[0], true)).toBe(-1 + 4);
    });

    test('ignores a response that does not line up with the request', async () => {
        const messages = makeMessages(3, 'mismatch');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: [1, 2] });

        await primeOpenAITokenCache(messages);

        globalThis.jQuery.ajax.mockResolvedValue({ token_count: 8 });
        expect(await countTokensOpenAIAsync(messages[0], true)).toBe(-1 + 8);
    });

    test('does nothing when given no messages', async () => {
        await primeOpenAITokenCache([]);
        await primeOpenAITokenCache(undefined);

        expect(globalThis.jQuery.ajax).not.toHaveBeenCalled();
    });
});
