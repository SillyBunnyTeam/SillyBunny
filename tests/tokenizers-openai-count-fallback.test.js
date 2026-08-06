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

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    getStringHash: jest.fn(() => 1234),
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
    countChatCompletionPayloadTokensOpenAIAsync,
    countTokensOpenAIAsync,
    guesstimate,
} = await import('../public/scripts/tokenizers.js');

describe('OpenAI token counting resilience', () => {
    beforeEach(() => {
        globalThis.jQuery = { ajax: jest.fn() };
    });

    test('falls back to a guesstimate when the tokenizer endpoint rejects with a jqXHR', async () => {
        const message = { role: 'system', content: 'Main prompt text' };
        globalThis.jQuery.ajax.mockRejectedValue({ status: 404, statusText: 'Not Found', readyState: 4 });

        const count = await countTokensOpenAIAsync(message, true);

        expect(count).toBe(-1 + guesstimate(JSON.stringify(message)));
    });

    test('falls back to a guesstimate for finalized payloads when the request fails', async () => {
        const messages = [{ role: 'user', content: 'Post-history instruction' }];
        globalThis.jQuery.ajax.mockRejectedValue({ status: 404, statusText: 'Not Found', readyState: 4 });

        const count = await countChatCompletionPayloadTokensOpenAIAsync(messages);

        expect(count).toBe(guesstimate(JSON.stringify(messages)));
    });

    test('still returns the server count when the request succeeds', async () => {
        globalThis.jQuery.ajax.mockResolvedValue({ token_count: 42 });

        const count = await countChatCompletionPayloadTokensOpenAIAsync([{ role: 'user', content: 'hi' }]);

        expect(count).toBe(42);
    });
});
