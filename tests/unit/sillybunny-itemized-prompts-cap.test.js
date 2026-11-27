import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const store = new Map();
const mockEventSource = { emit: jest.fn(async () => {}) };

await jest.unstable_mockModule('../../public/lib.js', () => ({
    DiffMatchPatch: class {},
    DOMPurify: {},
    localforage: {
        createInstance: () => ({
            getItem: async key => store.has(key) ? structuredClone(store.get(key)) : null,
            setItem: async (key, value) => {
                store.set(key, structuredClone(value));
            },
            removeItem: async key => {
                store.delete(key);
            },
            clear: async () => store.clear(),
        }),
    },
}));
await jest.unstable_mockModule('../../public/script.js', () => ({
    chat: [],
    event_types: { ITEMIZED_PROMPTS_LOADED: 'loaded', ITEMIZED_PROMPTS_SAVED: 'saved', ITEMIZED_PROMPTS_DELETED: 'deleted' },
    eventSource: mockEventSource,
    getCurrentChatId: () => 'chat',
    reloadCurrentChat: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
await jest.unstable_mockModule('../../public/scripts/openai.js', () => ({ oai_settings: {} }));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({ Popup: class {}, POPUP_TYPE: {} }));
await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({ power_user: {}, registerDebugFunction: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({ isMobile: () => false }));
await jest.unstable_mockModule('../../public/scripts/templates.js', () => ({ renderTemplateAsync: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => ({
    getFriendlyTokenizerName: () => ({ tokenizerName: '' }),
    getTokenCountAsync: async () => 0,
}));
await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({ copyText: jest.fn() }));

const itemized = await import('../../public/scripts/itemized-prompts.js');

/** One stored prompt set per assistant message: message ids 1, 3, 5, ... */
function makeSets(count) {
    return Array.from({ length: count }, (_, index) => ({ mesId: index * 2 + 1, rawPrompt: `prompt ${index}` }));
}

beforeEach(() => {
    store.clear();
    mockEventSource.emit.mockClear();
});

describe('itemized prompts kept per chat', () => {
    test('a chat with 300 stored sets loads and saves all of them', async () => {
        store.set('chat', makeSets(300));

        await itemized.loadItemizedPrompts('chat');
        await itemized.saveItemizedPrompts('chat');

        expect(itemized.itemizedPrompts).toHaveLength(300);
        expect(store.get('chat')).toHaveLength(300);
    });

    test('the Prompt Itemization lookup finds the set of every message whose set is stored', async () => {
        store.set('chat', makeSets(300));
        await itemized.loadItemizedPrompts('chat');

        expect(itemized.findItemizedPromptSet(itemized.itemizedPrompts, 1)).toBe(0);
        expect(itemized.findItemizedPromptSet(itemized.itemizedPrompts, 299)).toBe(149);
        expect(itemized.findItemizedPromptSet(itemized.itemizedPrompts, 599)).toBe(299);
        expect(itemized.findItemizedPromptSet(itemized.itemizedPrompts, 2)).toBeUndefined();
    });

    test('a chat above the bound keeps its newest sets in memory and in storage', async () => {
        const total = itemized.MAX_ITEMIZED_PROMPTS + 25;
        store.set('chat', makeSets(total));

        await itemized.loadItemizedPrompts('chat');
        await itemized.saveItemizedPrompts('chat');

        expect(itemized.itemizedPrompts).toHaveLength(itemized.MAX_ITEMIZED_PROMPTS);
        expect(store.get('chat')).toHaveLength(itemized.MAX_ITEMIZED_PROMPTS);
        expect(store.get('chat')[0].mesId).toBe(25 * 2 + 1);
        expect(store.get('chat').at(-1).mesId).toBe((total - 1) * 2 + 1);
        expect(itemized.findItemizedPromptSet(itemized.itemizedPrompts, 1)).toBeUndefined();
    });

    test('Generate() trims the set list at the same bound', () => {
        const scriptSource = readFileSync(new URL('../../public/script.js', import.meta.url), 'utf8');

        expect(scriptSource).toContain(`itemizedPrompts.length > ${itemized.MAX_ITEMIZED_PROMPTS}`);
        expect(scriptSource).toContain(`itemizedPrompts.splice(0, itemizedPrompts.length - ${itemized.MAX_ITEMIZED_PROMPTS})`);
    });
});
