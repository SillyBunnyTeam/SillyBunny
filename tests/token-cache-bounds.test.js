/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockOaiSettings = {
    chat_completion_source: 'openai',
    openai_model: 'gpt-4-turbo',
};
const mockStore = {
    stored: undefined,
    getItem: jest.fn(async () => mockStore.stored),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
};
const mockGroups = [{ id: 'g1', chat_id: 'chat-0' }];

await jest.unstable_mockModule('../public/lib.js', () => ({
    localforage: { createInstance: () => mockStore },
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
    chat_completion_sources: { OPENAI: 'openai', OPENAI_RESPONSES: 'openai_responses', KOBOLDCPP: 'koboldcpp' },
    getChatCompletionModel: () => '',
    model_list: [],
    oai_settings: mockOaiSettings,
}));

await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    groups: mockGroups,
    selected_group: 'g1',
}));

// Every distinct string gets its own hash, so the number of cache entries equals the number of distinct messages.
const hashIds = new Map();
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    getStringHash: jest.fn((value) => {
        const text = String(value);
        if (!hashIds.has(text)) {
            hashIds.set(text, hashIds.size + 1);
        }
        return hashIds.get(text);
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

await jest.unstable_mockModule('../public/scripts/sillybunny-koboldcpp-models.js', () => ({
    countKoboldCppChatTokens: jest.fn(),
    isKoboldCppChatCompletion: () => false,
}));

const {
    countTokensOpenAI,
    initTokenizers,
    resetTokenCache,
    saveTokenCache,
} = await import('../public/scripts/tokenizers.js');

const ajax = jest.fn();

function message(index) {
    return { role: 'assistant', content: `token cache bounds message ${index}` };
}

function useChat(name) {
    mockGroups[0].chat_id = name;
}

/** Counts messages from..to-1 in the current chat. Returns how many of them needed a server call. */
function countRange(from, to) {
    const callsBefore = ajax.mock.calls.length;
    for (let i = from; i < to; i++) {
        countTokensOpenAI([message(i)], true);
    }
    return ajax.mock.calls.length - callsBefore;
}

async function lastSavedCache() {
    mockStore.setItem.mockClear();
    await saveTokenCache();
    expect(mockStore.setItem).toHaveBeenCalledTimes(1);
    const [name, value] = mockStore.setItem.mock.calls[0];
    expect(name).toBe('tokenCache');
    return value;
}

function entryIds(bucket) {
    return Object.keys(bucket).map(key => Number(key.split('-').pop()));
}

describe('token cache bounds', () => {
    beforeEach(async () => {
        ajax.mockReset();
        ajax.mockImplementation(({ success }) => success({ token_count: 5 }));
        globalThis.jQuery = { ajax };
        mockStore.stored = undefined;
        await resetTokenCache({ toast: false });
        useChat('chat-0');
    });

    test('a cache hit or an insert below the bound does not enumerate the cache', () => {
        countRange(0, 700);

        const keysSpy = jest.spyOn(Object, 'keys');
        const hitCalls = countRange(0, 700);
        const insertCalls = countRange(700, 710);

        expect(hitCalls).toBe(0);
        expect(insertCalls).toBe(10);
        const enumeratedLargeObject = keysSpy.mock.calls.some(([target]) => (
            target && typeof target === 'object' && Object.getOwnPropertyNames(target).length > 100
        ));
        keysSpy.mockRestore();
        expect(enumeratedLargeObject).toBe(false);
    });

    test('a prompt that reads far more keys than 500 hits on every repeat build', () => {
        expect(countRange(0, 1500)).toBe(1500);
        for (let build = 0; build < 3; build++) {
            expect(countRange(0, 1500)).toBe(0);
        }
    });

    test('a chat that grows past its bound drops its oldest entries and keeps the newest', () => {
        const total = 20_040;
        expect(countRange(0, total)).toBe(total);

        const newestKept = total - 20_000;
        expect(countRange(newestKept, total)).toBe(0);
        expect(countRange(0, 1)).toBe(1);
        expect(countRange(newestKept - 1, newestKept)).toBe(1);
    });

    test('only the newest 500 entries of a chat go to storage, and memory keeps more', async () => {
        const total = 1_200;
        countRange(0, total);

        const saved = await lastSavedCache();
        const ids = entryIds(saved['chat-0']);
        expect(ids).toHaveLength(500);
        expect(Math.min(...ids)).toBe(hashIds.get(JSON.stringify(message(total - 500))));
        expect(Math.max(...ids)).toBe(hashIds.get(JSON.stringify(message(total - 1))));

        expect(countRange(0, total)).toBe(0);
    });

    test('a chat with fewer than 500 entries is stored whole, as a plain object per chat', async () => {
        countRange(0, 120);
        const saved = await lastSavedCache();
        expect(Object.keys(saved)).toEqual(['chat-0']);
        expect(Object.keys(saved['chat-0'])).toHaveLength(120);
        expect(Object.getPrototypeOf(saved)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(saved['chat-0'])).toBe(Object.prototype);
    });

    test('the cache keeps the 20 chats used last, and switching to a chat makes it the newest', async () => {
        for (let chat = 0; chat < 20; chat++) {
            useChat(`chat-${chat}`);
            countRange(chat * 10, chat * 10 + 3);
        }
        useChat('chat-0');
        countRange(0, 1);
        useChat('chat-20');
        countRange(200, 203);

        const saved = await lastSavedCache();
        const chats = Object.keys(saved);
        expect(chats).toHaveLength(20);
        expect(chats).toContain('chat-0');
        expect(chats).not.toContain('chat-1');
        expect(chats[chats.length - 1]).toBe('chat-20');
        expect(chats[chats.length - 2]).toBe('chat-0');
    });

    test('a stored cache from before the bounds is cut to the bounds when it loads', async () => {
        const stored = {};
        for (let chat = 0; chat < 30; chat++) {
            stored[`old-chat-${chat}`] = {};
            for (let i = 0; i < 700; i++) {
                stored[`old-chat-${chat}`][`gpt-4-turbo-${chat * 1000 + i}`] = 5;
            }
            if (chat === 25) {
                stored['old-chat-broken'] = 'not a bucket';
            }
        }
        mockStore.stored = stored;

        await initTokenizers();
        useChat('old-chat-29');
        countRange(0, 1);
        const saved = await lastSavedCache();

        const chats = Object.keys(saved);
        expect(chats.length).toBeLessThanOrEqual(20);
        expect(chats).not.toContain('old-chat-0');
        expect(chats).not.toContain('old-chat-broken');
        expect(chats[chats.length - 1]).toBe('old-chat-29');
        for (const chat of chats) {
            expect(Object.keys(saved[chat])).toHaveLength(500);
        }
        const newestIds = entryIds(saved['old-chat-29']);
        expect(newestIds.slice(0, -1)).toEqual(Array.from({ length: 499 }, (_, i) => 29_000 + 201 + i));
        expect(newestIds.at(-1)).toBe(hashIds.get(JSON.stringify(message(0))));
    });
});
