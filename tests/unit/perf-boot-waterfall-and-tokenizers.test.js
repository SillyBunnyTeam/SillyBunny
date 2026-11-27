/* global globalThis */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY,
    resolveChatRenderLifecycleRollout,
} from '../../public/scripts/chat-render-lifecycle/index.js';
import { resolveExtensionManifestRegistration } from '../../public/scripts/extension-boot-lifecycle/index.js';

const mockObjectStore = {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
};

const mockCharacters = [{ chat: 'chat-alpha' }];
const mockScriptState = {
    this_chid: 0,
    main_api: 'openai',
    online_status: 'connected',
};

const mockGroupState = {
    groups: [],
    selected_group: null,
};

const mockOaiSettings = {
    chat_completion_source: 'openai',
    openai_model: 'gpt-4o',
};

const mockPowerUser = {
    tokenizer: 12,
    token_padding: 64,
};

const hashInputs = [];

await jest.unstable_mockModule('../../public/lib.js', () => ({
    localforage: {
        createInstance: () => mockObjectStore,
    },
}));

await jest.unstable_mockModule('../../public/script.js', () => ({
    characters: mockCharacters,
    event_types: { ONLINE_STATUS_CHANGED: 'online_status_changed' },
    eventSource: { on: jest.fn() },
    get main_api() {
        return mockScriptState.main_api;
    },
    nai_settings: {},
    get online_status() {
        return mockScriptState.online_status;
    },
    get this_chid() {
        return mockScriptState.this_chid;
    },
}));

await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    power_user: mockPowerUser,
    registerDebugFunction: jest.fn(),
}));

await jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    chat_completion_sources: {
        OPENAI: 'openai',
        OPENAI_RESPONSES: 'openai_responses',
        KOBOLDCPP: 'koboldcpp',
    },
    getChatCompletionModel: () => '',
    model_list: [],
    oai_settings: mockOaiSettings,
}));

await jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
    get groups() {
        return mockGroupState.groups;
    },
    get selected_group() {
        return mockGroupState.selected_group;
    },
}));

await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    getStringHash: jest.fn((value) => {
        const str = String(value);
        hashInputs.push(str);
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
        }
        return hash;
    }),
    debounce: (fn) => fn,
    resetScrollHeight: jest.fn(async () => undefined),
}));

await jest.unstable_mockModule('../../public/scripts/kai-settings.js', () => ({
    kai_flags: {},
    kai_settings: {},
}));

await jest.unstable_mockModule('../../public/scripts/textgen-settings.js', () => ({
    textgen_types: {},
    textgenerationwebui_settings: { type: 'ooba' },
    getTextGenServer: jest.fn(() => ''),
    getTextGenModel: jest.fn(() => ''),
}));

await jest.unstable_mockModule('../../public/scripts/textgen-models.js', () => ({
    getCurrentDreamGenModelTokenizer: jest.fn(),
    getCurrentOpenRouterModelTokenizer: jest.fn(),
    openRouterModels: [],
}));

await jest.unstable_mockModule('../../public/scripts/sillybunny-koboldcpp-models.js', () => ({
    countKoboldCppChatTokens: jest.fn(),
    isKoboldCppChatCompletion: () => false,
}));

await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    getContext: () => ({ chat: [] }),
    renderExtensionTemplateAsync: jest.fn(async () => '<div></div>'),
}));

await jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: { fromProps: (props) => props },
}));

await jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: { addCommandObject: jest.fn() },
}));

await jest.unstable_mockModule('../../public/scripts/constants.js', () => ({
    debounce_timeout: { relaxed: 0 },
}));

await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { TEXT: 1 },
    callGenericPopup: jest.fn(),
}));

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings) => strings[0],
}));

const {
    MAX_CACHED_CHATS,
    MAX_CACHE_ENTRIES_PER_CHAT,
    countTokensOpenAIAsync,
    getOpenAIMessageHash,
    getTextTokensAsync,
    getTokenCacheStatsForTests,
    getTokenCountAsync,
    guesstimateOpenAIMessage,
    isTokenCacheDirty,
    loadTokenCache,
    primeOpenAITokenCache,
    resetTokenCache,
    resetTokenizerPerfStateForTests,
    saveTokenCache,
    tokenizers,
} = await import('../../public/scripts/tokenizers.js');

const { drawChunks } = await import('../../public/scripts/extensions/token-counter/index.js');

// Load a second tokenizers.js instance bound to a non-OpenAI main_api so local plain-text
// /api/tokenizers/count-batch coalescing and 404 fallback are tested against real ESM bindings.
jest.resetModules();
await jest.unstable_mockModule('../../public/script.js', () => ({
    characters: mockCharacters,
    event_types: { ONLINE_STATUS_CHANGED: 'online_status_changed' },
    eventSource: { on: jest.fn() },
    main_api: 'textgenerationwebui',
    nai_settings: {},
    online_status: 'connected',
    this_chid: 0,
}));
const localTokenizers = await import('../../public/scripts/tokenizers.js');

const indexHtmlSource = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const scriptSource = readFileSync(new URL('../../public/script.js', import.meta.url), 'utf8');
const backgroundsSource = readFileSync(new URL('../../public/scripts/backgrounds.js', import.meta.url), 'utf8');
const extensionsSource = readFileSync(new URL('../../public/scripts/extensions.js', import.meta.url), 'utf8');
const splashSource = readFileSync(new URL('../../public/scripts/sillybunny-splash.js', import.meta.url), 'utf8');
const ttsSource = readFileSync(new URL('../../public/scripts/extensions/tts/index.js', import.meta.url), 'utf8');
const quickReplySource = readFileSync(new URL('../../public/scripts/extensions/quick-reply/index.js', import.meta.url), 'utf8');
const inChatAgentsSource = readFileSync(new URL('../../public/scripts/extensions/in-chat-agents/index.js', import.meta.url), 'utf8');

function extractSliceBetween(source, startMarker, endMarker) {
    const startIndex = source.indexOf(startMarker);
    if (startIndex < 0) {
        throw new Error(`Missing start marker: ${startMarker}`);
    }
    const endIndex = source.indexOf(endMarker, startIndex);
    if (endIndex < 0) {
        throw new Error(`Missing end marker: ${endMarker}`);
    }
    return source.slice(startIndex, endIndex);
}

/**
 * Runs the real firstLoadInit() from script.js in a vm sandbox. Every function it calls is a stub that resolves on a later
 * tick, except the ones in `overrides`, so the test observes the order that boot gives to the stubs it cares about.
 * @param {Record<string, unknown>} overrides Sandbox entries that replace the generated stubs.
 */
function createFirstLoadInitSandbox(overrides = {}) {
    const bootSlice = extractSliceBetween(scriptSource, 'async function firstLoadInit() {', 'async function fixViewport() {');
    const notCalls = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'async', 'await', 'return', 'typeof']);
    const callNames = new Set(
        Array.from(bootSlice.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g), match => match[1]).filter(name => !notCalls.has(name)),
    );

    const listeners = new Map();
    const eventSource = {
        on: (name, listener) => {
            listeners.set(name, [...(listeners.get(name) ?? []), listener]);
        },
        emit: async (name, ...args) => {
            for (const listener of listeners.get(name) ?? []) {
                await listener(...args);
            }
        },
    };
    const eventTypes = new Proxy({}, { get: (_target, name) => String(name) });
    const nextTick = () => new Promise(resolve => setImmediate(resolve));

    const sandbox = {
        console,
        toastr: { error: jest.fn(), info: jest.fn() },
        t: (strings) => strings[0],
        document: { querySelector: () => null },
        window: {
            requestIdleCallback: (callback) => setImmediate(callback),
            setTimeout: (callback) => setImmediate(callback),
            addEventListener: jest.fn(),
        },
        ToolManager: { initToolSlashCommands: jest.fn() },
        FILTER_TYPES: { TAG: 'tag' },
        power_user: {},
        tags: [],
        tag_map: {},
        characters: [],
        groups: [],
        accountStorage: {},
        entitiesFilter: {},
        user_avatar: 'user-default.png',
        showdown: {},
        event_types: eventTypes,
        eventSource,
    };
    // Functions that boot passes as values instead of calling.
    for (const name of [...callNames, 'forgetAllCardScripts', 'executeSlashCommandsWithOptions']) {
        sandbox[name] = jest.fn(nextTick);
    }
    sandbox.beginBootApiPrefetch = jest.fn(() => () => undefined);
    Object.assign(sandbox, overrides);
    sandbox.globalThis = sandbox;

    vm.runInNewContext(bootSlice, sandbox);
    return { sandbox, eventSource };
}

describe('tokenizers O(1) Map LRU, dirty flag, microtask batching, and multimodal hashing', () => {
    beforeEach(() => {
        resetTokenizerPerfStateForTests();
        localTokenizers.resetTokenizerPerfStateForTests();
        mockObjectStore.getItem.mockReset().mockResolvedValue(null);
        mockObjectStore.setItem.mockReset().mockResolvedValue(undefined);
        mockObjectStore.removeItem.mockReset().mockResolvedValue(undefined);
        mockCharacters[0].chat = 'chat-alpha';
        mockScriptState.this_chid = 0;
        mockScriptState.main_api = 'openai';
        mockOaiSettings.chat_completion_source = 'openai';
        mockOaiSettings.openai_model = 'gpt-4o';
        hashInputs.length = 0;
        globalThis.jQuery = { ajax: jest.fn() };
        globalThis.toastr = { success: jest.fn(), info: jest.fn() };
    });

    test('evicts oldest per-chat and chat-bucket LRU entries only on insert overflow while promoting hits in O(1)', async () => {
        const totalInsertions = MAX_CACHE_ENTRIES_PER_CHAT + 2;
        const messages = Array.from({ length: totalInsertions }, (_, index) => ({
            role: 'user',
            content: `lru-entry-${index}`,
        }));

        globalThis.jQuery.ajax.mockResolvedValueOnce({
            token_counts: messages.slice(0, MAX_CACHE_ENTRIES_PER_CHAT).map((_, i) => i + 10),
        });
        await primeOpenAITokenCache(messages.slice(0, MAX_CACHE_ENTRIES_PER_CHAT));
        expect(getTokenCacheStatsForTests().currentChatSize).toBe(MAX_CACHE_ENTRIES_PER_CHAT);

        // Touch entry 0 so it moves to the MRU tail without triggering any network request or eviction.
        expect(await countTokensOpenAIAsync(messages[0], true)).toBe(10);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);
        expect(getTokenCacheStatsForTests().currentChatSize).toBe(MAX_CACHE_ENTRIES_PER_CHAT);

        // Insert 2 more entries: entries 1 and 2 must be evicted while entry 0 stays cached.
        globalThis.jQuery.ajax.mockResolvedValueOnce({ token_counts: [901, 902] });
        await primeOpenAITokenCache(messages.slice(MAX_CACHE_ENTRIES_PER_CHAT));
        expect(getTokenCacheStatsForTests().currentChatSize).toBe(MAX_CACHE_ENTRIES_PER_CHAT);

        expect(await countTokensOpenAIAsync(messages[0], true)).toBe(10);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(2);

        globalThis.jQuery.ajax.mockResolvedValueOnce({ token_count: 777 });
        expect(await countTokensOpenAIAsync(messages[1], true)).toBe(777);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(3);

        // Verify chat-level LRU cap (MAX_CACHED_CHATS = 20) and promotion on hit.
        resetTokenizerPerfStateForTests();
        for (let chatIdx = 0; chatIdx < MAX_CACHED_CHATS; chatIdx++) {
            mockCharacters[0].chat = `chat-${chatIdx}`;
            globalThis.jQuery.ajax.mockResolvedValueOnce({ token_counts: [chatIdx + 1] });
            await primeOpenAITokenCache([{ role: 'user', content: `seed-${chatIdx}` }]);
        }
        expect(getTokenCacheStatsForTests().chatCount).toBe(MAX_CACHED_CHATS);

        // Promote chat-0 to MRU, then insert chat-20 -> chat-1 is evicted, chat-0 survives.
        mockCharacters[0].chat = 'chat-0';
        expect(await countTokensOpenAIAsync({ role: 'user', content: 'seed-0' }, true)).toBe(1);

        mockCharacters[0].chat = `chat-${MAX_CACHED_CHATS}`;
        globalThis.jQuery.ajax.mockResolvedValueOnce({ token_counts: [99] });
        await primeOpenAITokenCache([{ role: 'user', content: 'seed-overflow' }]);

        const stats = getTokenCacheStatsForTests();
        expect(stats.chatCount).toBe(MAX_CACHED_CHATS);
        expect(stats.chatKeys).toContain('chat-0');
        expect(stats.chatKeys).not.toContain('chat-1');
    });

    test('saveTokenCache is a 0-write no-op when clean and persists once when dirty', async () => {
        mockObjectStore.getItem.mockResolvedValueOnce({
            'chat-alpha': { 'gpt-4o-seeded': 15 },
        });
        await loadTokenCache();
        expect(isTokenCacheDirty()).toBe(false);

        await saveTokenCache();
        expect(mockObjectStore.setItem).not.toHaveBeenCalled();

        globalThis.jQuery.ajax.mockResolvedValueOnce({ token_count: 23 });
        const msg = { role: 'assistant', content: 'fresh message' };
        expect(await countTokensOpenAIAsync(msg, true)).toBe(23);
        expect(isTokenCacheDirty()).toBe(true);

        await saveTokenCache();
        expect(mockObjectStore.setItem).toHaveBeenCalledTimes(1);
        expect(isTokenCacheDirty()).toBe(false);
        const [, savedPayload] = mockObjectStore.setItem.mock.calls[0];
        expect(typeof savedPayload['chat-alpha']).toBe('object');

        // Cache hit does not mark cache dirty; subsequent saveTokenCache stays a no-op.
        expect(await countTokensOpenAIAsync(msg, true)).toBe(23);
        expect(isTokenCacheDirty()).toBe(false);
        await saveTokenCache();
        expect(mockObjectStore.setItem).toHaveBeenCalledTimes(1);

        await resetTokenCache({ toast: false });
        expect(mockObjectStore.removeItem).toHaveBeenCalledWith('tokenCache');
        expect(getTokenCacheStatsForTests().chatCount).toBe(0);
    });

    test('coalesces concurrent local getTokenCountAsync calls into one /api/tokenizers/count-batch with in-flight deduplication', async () => {
        mockPowerUser.tokenizer = localTokenizers.tokenizers.LLAMA3;

        globalThis.jQuery.ajax.mockImplementation(async (options) => {
            expect(options.url).toBe('/api/tokenizers/count-batch');
            const body = JSON.parse(options.data);
            expect(body).toEqual({
                model: 'llama3',
                texts: ['first uncached string', 'second uncached string'],
            });
            return { counts: [14, 29] };
        });

        const results = await Promise.all([
            localTokenizers.getTokenCountAsync('first uncached string'),
            localTokenizers.getTokenCountAsync('second uncached string'),
            localTokenizers.getTokenCountAsync('first uncached string'),
        ]);

        expect(results).toEqual([14, 29, 14]);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);

        // Subsequent calls hit the O(1) Map LRU with zero AJAX traffic.
        expect(await localTokenizers.getTokenCountAsync('second uncached string')).toBe(29);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);
    });

    test('falls back seamlessly from /api/tokenizers/count-batch 404 to individual local tokenizer endpoints and remembers unavailability', async () => {
        mockPowerUser.tokenizer = localTokenizers.tokenizers.LLAMA3;

        const requestedUrls = [];
        globalThis.jQuery.ajax.mockImplementation((options) => {
            requestedUrls.push(options.url);
            if (options.url === '/api/tokenizers/count-batch') {
                return Promise.reject({ status: 404, statusText: 'Not Found', readyState: 4 });
            }
            if (options.url === '/api/tokenizers/llama3/encode') {
                const body = JSON.parse(options.data);
                const count = body.text.includes('one') || body.text.includes('three') ? 11 : 22;
                options.success?.({ count });
                return undefined;
            }
            throw new Error(`Unexpected URL: ${options.url}`);
        });

        const firstBatch = await Promise.all([
            localTokenizers.getTokenCountAsync('fallback-one'),
            localTokenizers.getTokenCountAsync('fallback-two'),
        ]);
        expect(firstBatch).toEqual([11, 22]);
        expect(requestedUrls).toEqual([
            '/api/tokenizers/count-batch',
            '/api/tokenizers/llama3/encode',
            '/api/tokenizers/llama3/encode',
        ]);
        expect(localTokenizers.getTokenCacheStatsForTests().countBatchEndpointAvailable).toBe(false);

        // Next concurrent batch skips the 404 round-trip directly to local endpoints.
        requestedUrls.length = 0;
        const secondBatch = await Promise.all([
            localTokenizers.getTokenCountAsync('fallback-three'),
            localTokenizers.getTokenCountAsync('fallback-four'),
        ]);
        expect(secondBatch).toEqual([11, 22]);
        expect(requestedUrls).toEqual([
            '/api/tokenizers/llama3/encode',
            '/api/tokenizers/llama3/encode',
        ]);
    });

    test('routes OpenAI bare { content } messages through /api/tokenizers/openai/count(?per_message=1) and never mixes raw /count-batch counts', async () => {
        mockScriptState.main_api = 'openai';
        const requestedUrls = [];

        globalThis.jQuery.ajax.mockImplementation(async (options) => {
            requestedUrls.push(options.url);
            expect(options.url).not.toBe('/api/tokenizers/count-batch');
            const payload = JSON.parse(options.data);
            if (options.url.includes('per_message=1')) {
                // Framed counts include +6 per-message overhead (e.g., 1 token + 6 = 7).
                return { token_counts: payload.map(msg => msg.content.length + 6) };
            }
            return { token_count: payload[0].content.length + 6 };
        });

        const batched = await Promise.all([
            getTokenCountAsync('hi'),
            getTokenCountAsync('hello'),
            getTokenCountAsync('hi'),
        ]);
        expect(batched).toEqual([8, 11, 8]);
        expect(requestedUrls).toEqual([
            '/api/tokenizers/openai/count?model=gpt-4o&per_message=1',
        ]);

        // Unframed / full=false call on a 1-char bare message stays positive and preserves framed parity.
        requestedUrls.length = 0;
        const framedSingle = await countTokensOpenAIAsync({ content: 'a' }, false);
        expect(framedSingle).toBe(5);
        expect(requestedUrls).toEqual([
            '/api/tokenizers/openai/count?model=gpt-4o',
        ]);
    });

    test('avoids JSON.stringifying multi-MB base64 payloads while hashing long multimodal text parts in full and estimating full text tokens', () => {
        const plainMessage = { role: 'user', content: 'short text message' };
        hashInputs.length = 0;
        const plainHash = getOpenAIMessageHash(plainMessage);
        expect(hashInputs).toEqual([JSON.stringify(plainMessage)]);
        expect(typeof plainHash).toBe('number');

        const twoMegBase64A = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}TAIL_ONE`;
        const twoMegBase64B = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}TAIL_TWO`;
        const multimodalA = {
            role: 'user',
            content: [
                { type: 'text', text: 'Describe this image' },
                { type: 'image_url', image_url: { url: twoMegBase64A } },
            ],
        };
        const multimodalB = {
            role: 'user',
            content: [
                { type: 'text', text: 'Describe this image' },
                { type: 'image_url', image_url: { url: twoMegBase64B } },
            ],
        };

        hashInputs.length = 0;
        const hashA = getOpenAIMessageHash(multimodalA);
        const hashB = getOpenAIMessageHash(multimodalB);

        expect(hashA).not.toBe(hashB);
        expect(hashInputs).toHaveLength(2);
        expect(hashInputs[0].length).toBeLessThan(1024);
        expect(hashInputs[1].length).toBeLessThan(1024);

        // Long text parts inside multimodal messages are hashed in full (no mid-string collision)
        // and guesstimated at full text length + fixed image overhead.
        const prefix = 'P'.repeat(200);
        const suffix = 'S'.repeat(200);
        const longProseA = `${prefix}ALPHA_SECTION_${'x'.repeat(2000)}${suffix}`;
        const longProseB = `${prefix}OMEGA_SECTION_${'x'.repeat(2000)}${suffix}`;
        expect(longProseA.length).toBe(longProseB.length);

        const multimodalTextA = {
            role: 'user',
            content: [
                { type: 'text', text: longProseA },
                { type: 'image_url', image_url: { url: twoMegBase64A } },
            ],
        };
        const multimodalTextB = {
            role: 'user',
            content: [
                { type: 'text', text: longProseB },
                { type: 'image_url', image_url: { url: twoMegBase64A } },
            ],
        };

        expect(getOpenAIMessageHash(multimodalTextA)).not.toBe(getOpenAIMessageHash(multimodalTextB));

        const estimatedTokens = guesstimateOpenAIMessage(multimodalTextA);
        // 2414-char text (~721 tokens) + fixed 256 image estimate (~980 total), never ~50 from truncated text
        // and never ~600,000 from stringifying the 2 MB base64 image.
        expect(estimatedTokens).toBeGreaterThan(900);
        expect(estimatedTokens).toBeLessThan(2000);
    });

    test('getTextTokensAsync encodes asynchronously and drawChunks commits via a single DocumentFragment', async () => {
        globalThis.jQuery.ajax.mockImplementation(({ async: isAsync, success }) => {
            expect(isAsync).toBe(true);
            success({ ids: [101, 102, 103], chunks: ['▁Hello', '\n', '<0x21>'] });
        });

        const ids = await getTextTokensAsync(tokenizers.LLAMA3, 'Hello\n!');
        expect(Array.from(ids)).toEqual([101, 102, 103]);
        expect(ids.chunks).toEqual(['▁Hello', '\n', '<0x21>']);

        const appendedNodes = [];
        const replaceChildrenCalls = [];
        const prevDocument = globalThis.document;
        try {
            globalThis.document = {
                createDocumentFragment: () => ({
                    nodes: appendedNodes,
                    appendChild(node) {
                        this.nodes.push(node);
                        return node;
                    },
                }),
                createElement: (tag) => ({
                    tagName: tag.toUpperCase(),
                    style: {},
                    textContent: '',
                    attributes: {},
                    setAttribute(name, val) {
                        this.attributes[name] = val;
                    },
                }),
            };

            const container = {
                replaceChildren(frag) {
                    replaceChildrenCalls.push(frag);
                },
            };

            drawChunks(ids.chunks, ids, container);
            expect(replaceChildrenCalls).toHaveLength(1);
            expect(appendedNodes).toHaveLength(3);
            expect(appendedNodes[0]).toMatchObject({ tagName: 'CODE', textContent: ' Hello' });
            expect(appendedNodes[1]).toMatchObject({ tagName: 'BR' });
            expect(appendedNodes[2]).toMatchObject({ tagName: 'CODE', textContent: '!' });
        } finally {
            globalThis.document = prevDocument;
        }
    });
});

describe('boot waterfall, inline extension manifests, loopback SW retirement, and script.js hotfixes', () => {
    test('boot fills the background list before APP_INITIALIZED and APP_READY listeners run', async () => {
        const backgroundList = [];
        let backgroundLoad = null;
        const loadBackgrounds = () => {
            backgroundLoad ??= new Promise(resolve => setTimeout(() => {
                backgroundList.push('forest.png');
                resolve();
            }, 15));
            return backgroundLoad;
        };
        const { sandbox, eventSource } = createFirstLoadInitSandbox({
            getBackgrounds: jest.fn(loadBackgrounds),
            ensureBackgroundsLoaded: jest.fn(loadBackgrounds),
        });

        const seen = {};
        eventSource.on('APP_INITIALIZED', () => { seen.appInitialized = [...backgroundList]; });
        eventSource.on('APP_READY', () => { seen.appReady = [...backgroundList]; });

        await sandbox.firstLoadInit();

        expect(seen.appInitialized).toEqual(['forest.png']);
        expect(seen.appReady).toEqual(['forest.png']);
    });

    test('extensions getManifests uses inline manifests without HTTP fetches and falls back per-extension when absent', async () => {
        const discoverSlice = extractSliceBetween(
            extensionsSource,
            'async function discoverExtensions() {',
            'function onDisableExtensionClick()',
        );
        const getManifestsSlice = extractSliceBetween(
            extensionsSource,
            'export async function getManifests(',
            'async function activateExtensions(',
        ).replace('export async function getManifests', 'async function getManifests');

        const fetchCalls = [];
        const sandbox = {
            globalThis: {
                __sbBootPrefetch: {
                    extensionsDiscover: Promise.resolve({
                        ok: true,
                        bodyUsed: false,
                        json: async () => [
                            { name: 'tts', type: 'system', manifest: { display_name: 'TTS', loading_order: 1, js: 'index.js' } },
                            { name: 'third-party/custom', type: 'local' },
                        ],
                    }),
                },
            },
            fetch: jest.fn(async (url) => {
                fetchCalls.push(url);
                if (String(url).includes('third-party/custom/manifest.json')) {
                    return {
                        ok: true,
                        json: async () => ({ display_name: 'Custom Ext', loading_order: 5, js: 'index.js' }),
                    };
                }
                if (String(url) === '/api/extensions/discover?manifests=1') {
                    return {
                        ok: true,
                        json: async () => [{ name: 'fallback-ext', type: 'system' }],
                    };
                }
                return { ok: false };
            }),
            getExtensionAssetUrl: (name, file) => `/scripts/extensions/${name}/${file}`,
            resolveExtensionManifestRegistration,
            console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        };

        vm.runInNewContext(`${discoverSlice}\n${getManifestsSlice}`, sandbox);

        // First discover consumes one-shot __sbBootPrefetch without hitting fetch().
        const discovered = await sandbox.discoverExtensions();
        expect(discovered).toHaveLength(2);
        expect(fetchCalls).toHaveLength(0);
        expect(sandbox.globalThis.__sbBootPrefetch.extensionsDiscover).toBeUndefined();

        // Inline manifest skips fetch for 'tts' and fetches ONLY 'third-party/custom/manifest.json'.
        const inlineMap = new Map(discovered.filter(x => x.manifest).map(x => [x.name, x.manifest]));
        const manifests = await sandbox.getManifests(['tts', 'third-party/custom'], inlineMap);
        expect(Object.keys(manifests)).toEqual(['tts', 'third-party/custom']);
        expect(fetchCalls).toEqual(['/scripts/extensions/third-party/custom/manifest.json']);

        // Second discover falls back to /api/extensions/discover?manifests=1.
        fetchCalls.length = 0;
        const fallbackDiscovered = await sandbox.discoverExtensions();
        expect(fallbackDiscovered).toEqual([{ name: 'fallback-ext', type: 'system' }]);
        expect(fetchCalls).toEqual(['/api/extensions/discover?manifests=1']);
    });

    test('resets observedExtensionSettingsContainers when observeExtensionSettingsDrawers reconnects', () => {
        const observerSlice = extractSliceBetween(
            extensionsSource,
            'function observeExtensionSettingsContainer(',
            '/**\n * Loads manifest.json files',
        );

        class FakeElement {
            constructor(id, classes = [], children = []) {
                this.id = id;
                this.classList = {
                    contains: (name) => classes.includes(name),
                };
                this.children = children;
            }
        }

        const existingContainer = new FakeElement('ext-container-1', ['extension_container']);
        const host = new FakeElement('extensions_settings', [], [existingContainer]);
        const createdObservers = [];

        class FakeMutationObserver {
            constructor(callback) {
                this.callback = callback;
                this.observed = [];
                this.disconnected = false;
                createdObservers.push(this);
            }

            observe(target, options) {
                this.observed.push({ target, options });
            }

            disconnect() {
                this.disconnected = true;
            }
        }

        const sandbox = {
            HTMLElement: FakeElement,
            MutationObserver: FakeMutationObserver,
            extensionSettingsDedupeObserver: null,
            observedExtensionSettingsContainers: new WeakSet(),
            extensionSettingsHostIds: ['extensions_settings'],
            document: {
                getElementById: (id) => (id === 'extensions_settings' ? host : null),
            },
            scheduleExtensionSettingsDedupe: jest.fn(),
        };

        vm.runInNewContext(observerSlice, sandbox);

        sandbox.observeExtensionSettingsDrawers();
        expect(createdObservers).toHaveLength(1);
        expect(createdObservers[0].observed).toEqual([
            { target: host, options: { childList: true, subtree: false } },
            { target: existingContainer, options: { childList: true, subtree: false } },
        ]);

        // Second call disconnects the first observer and MUST re-observe existing .extension_container nodes.
        sandbox.observeExtensionSettingsDrawers();
        expect(createdObservers).toHaveLength(2);
        expect(createdObservers[0].disconnected).toBe(true);
        expect(createdObservers[1].observed).toEqual([
            { target: host, options: { childList: true, subtree: false } },
            { target: existingContainer, options: { childList: true, subtree: false } },
        ]);
    });

    test('retires service worker and purges sillybunny-cache-* on loopback & Android WebView while keeping remote HTTPS registration', async () => {
        const swSlice = extractSliceBetween(
            scriptSource,
            'function isLoopbackOrAndroidWebView(',
            'function scheduleDeferredStartupStylesheets(',
        );

        const runSwScenario = async ({ hostname, userAgent = 'Mozilla/5.0 Chrome/130.0', isSecureContext = true, withController = false }) => {
            const idleCallbacks = [];
            const deletedCaches = [];
            const controllerMessages = [];
            const unregisterSpy = jest.fn(async () => true);
            const registerSpy = jest.fn(async () => ({ update: jest.fn(async () => undefined) }));

            const sandbox = {
                window: {
                    isSecureContext,
                    location: { hostname },
                    requestIdleCallback: (cb) => idleCallbacks.push(cb),
                    setTimeout: (cb) => idleCallbacks.push(cb),
                    addEventListener: jest.fn(),
                },
                navigator: {
                    userAgent,
                    serviceWorker: {
                        controller: withController ? {
                            postMessage: jest.fn((msg) => { controllerMessages.push(msg); }),
                        } : null,
                        register: registerSpy,
                        getRegistrations: jest.fn(async () => [{ unregister: unregisterSpy }]),
                    },
                },
                document: { readyState: 'complete' },
                caches: {
                    keys: jest.fn(async () => ['sillybunny-cache-v4', 'sillybunny-cache-v3', 'third-party-cache']),
                    delete: jest.fn(async (key) => {
                        deletedCaches.push(key);
                        return true;
                    }),
                },
                console: { debug: jest.fn(), warn: jest.fn() },
            };
            sandbox.globalThis = sandbox;

            vm.runInNewContext(swSlice, sandbox);
            sandbox.registerSillyBunnyServiceWorker();
            for (const cb of idleCallbacks) {
                await cb();
            }
            // Flush promise continuations inside retireLoopbackServiceWorkerAndCaches.
            await new Promise(resolve => setImmediate(resolve));

            return { registerSpy, unregisterSpy, deletedCaches, controllerMessages };
        };

        for (const host of ['127.0.0.1', 'localhost', '[::1]', 'dev.localhost']) {
            const res = await runSwScenario({ hostname: host, withController: true });
            expect(res.registerSpy).not.toHaveBeenCalled();
            expect(res.controllerMessages).toEqual([{ type: 'SB_CLEAR_CACHES' }]);
            expect(res.unregisterSpy).toHaveBeenCalledTimes(1);
            expect(res.deletedCaches).toEqual(['sillybunny-cache-v4', 'sillybunny-cache-v3']);
        }

        const webviewRes = await runSwScenario({
            hostname: 'companion.example.com',
            userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 Version/4.0 Chrome/128.0 Mobile Safari/537.36',
        });
        expect(webviewRes.registerSpy).not.toHaveBeenCalled();
        expect(webviewRes.unregisterSpy).toHaveBeenCalledTimes(1);

        // Non-Chrome Android browser containing Version/X.Y without wv/Chrome/SillyBunnyAndroid keeps remote SW registration.
        const androidNonWebViewRes = await runSwScenario({
            hostname: 'sillybunny.example.com',
            userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Version/17.0 Mobile Safari/537.36',
        });
        expect(androidNonWebViewRes.registerSpy).toHaveBeenCalledWith('/sw.js?v=20261124a', { updateViaCache: 'none' });

        const remoteHttpsRes = await runSwScenario({ hostname: 'sillybunny.example.com' });
        expect(remoteHttpsRes.registerSpy).toHaveBeenCalledWith('/sw.js?v=20261124a', { updateViaCache: 'none' });
        expect(remoteHttpsRes.unregisterSpy).not.toHaveBeenCalled();
        expect(remoteHttpsRes.deletedCaches).toEqual([]);
    });

    test('memoizes isChatRenderLifecycleRolloutEnabled across repeated hot-path calls and invalidates on storage event', () => {
        const rolloutSlice = extractSliceBetween(
            scriptSource,
            'let cachedLifecycleRolloutSearch = null;',
            'function captureVisibleChatMessageAnchor()',
        );

        let storageValue = '0';
        const getItemSpy = jest.fn(() => storageValue);
        const listeners = new Map();
        const sandbox = {
            CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY,
            resolveChatRenderLifecycleRollout,
            URLSearchParams,
            globalThis: {
                location: { search: '' },
                localStorage: { getItem: getItemSpy },
                addEventListener: (type, handler) => listeners.set(type, handler),
            },
        };

        vm.runInNewContext(rolloutSlice, sandbox);

        for (let i = 0; i < 50; i++) {
            expect(sandbox.isChatRenderLifecycleRolloutEnabled('stream')).toBe(false);
            expect(sandbox.isChatRenderLifecycleRolloutEnabled('scroll')).toBe(false);
        }
        expect(getItemSpy).toHaveBeenCalledTimes(1);

        // Simulate cross-tab storage update -> cache invalidates and re-reads once.
        storageValue = '1';
        listeners.get('storage')({ key: CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY });

        for (let i = 0; i < 20; i++) {
            expect(sandbox.isChatRenderLifecycleRolloutEnabled('stream')).toBe(true);
        }
        expect(getItemSpy).toHaveBeenCalledTimes(2);
    });

    test('enforces DOMContentLoaded boot gate, head prefetch, corrected avatar lazy-loading, flanking wheel scope, scoped observers, and lazy bundled extensions', () => {
        // 0. <head> boot prefetch uses no-store CSRF headers matching script.js and preloads lib.js before script.js.
        expect(indexHtmlSource).toContain('window.__sbBootPrefetch = {');
        expect(indexHtmlSource).toContain('cache: \'no-store\'');
        expect(indexHtmlSource).toContain('\'Pragma\': \'no-cache\'');
        expect(indexHtmlSource).toContain('/api/extensions/discover?manifests=1');
        const libPreloadIdx = indexHtmlSource.indexOf('<link rel="modulepreload" href="lib.js">');
        const scriptPreloadIdx = indexHtmlSource.indexOf('<link rel="modulepreload" href="script.js">');
        expect(libPreloadIdx).toBeGreaterThan(-1);
        expect(scriptPreloadIdx).toBeGreaterThan(libPreloadIdx);

        // 1. Boot readiness uses DOMContentLoaded and does not await dismissPreloader fade-out before getCharacters.
        expect(scriptSource).toContain('document.addEventListener(\'DOMContentLoaded\', resolve, { once: true })');
        expect(scriptSource).not.toContain('window.addEventListener(\'load\', () => resolve(), { once: true })');
        expect(scriptSource).toContain('void dismissPreloader();');

        // 2. Desktop thumbnail avatarImg + corrected bottom-up loading="lazy" + no inline --mes-avatar-original-url.
        expect(scriptSource).toContain('const viewportAvatarImg = isMobile() ? mobileAvatarImg : avatarImg;');
        expect(scriptSource).not.toContain('--mes-avatar-original-url');
        expect(scriptSource).toContain('loading: (chat.length - 1 - messageId) > 8 ? \'lazy\' : \'eager\'');
        const evaluateLoading = (chatLen, messageId) => ((chatLen - 1 - messageId) > 8 ? 'lazy' : 'eager');
        expect(evaluateLoading(100, 0)).toBe('lazy');
        expect(evaluateLoading(100, 90)).toBe('lazy');
        expect(evaluateLoading(100, 91)).toBe('eager');
        expect(evaluateLoading(100, 99)).toBe('eager');

        // 3. Wheel listener attached strictly to flanking #top-bar and #form_sheld, never document.
        expect(scriptSource).not.toContain('document.addEventListener(\'wheel\', routeShellWheelToChat');
        expect(scriptSource).toContain('for (const chromeId of [\'top-bar\', \'form_sheld\'])');

        // 4. Streaming setFirstSwipe defaults isFinal = true; offscreen hljs avoids sync getBoundingClientRect, respects nohighlight, and flushes on beforeprint.
        expect(scriptSource).toContain('setFirstSwipe(messageId, { isFinal = true } = {})');
        const hljsSlice = extractSliceBetween(scriptSource, 'function highlightCodeElementNow(', 'export function addCopyToCodeBlocks(');
        expect(hljsSlice).not.toContain('getBoundingClientRect');
        expect(hljsSlice).toContain('nohighlight');
        expect(hljsSlice).toContain('beforeprint');

        // 5. Backgrounds ensureBackgroundsLoaded checks inFlightBackgroundsPromise before systemBackgroundsLoaded.
        expect(backgroundsSource).toContain('if (inFlightBackgroundsPromise) {\n        return inFlightBackgroundsPromise;\n    }');

        // 6. Extension observer is subtree: false and Kokoro prefetch is strictly gated.
        expect(extensionsSource).toContain('subtree: false');
        expect(extensionsSource).not.toContain('nanogallery2');
        expect(extensionsSource).toContain('extension_settings.tts?.currentProvider === \'Kokoro\'');

        // 7. TTS uses dynamic provider imports + conditional timer; quick-reply & in-chat-agents reuse initial settings snapshot without a persistent schema stamp.
        expect(ttsSource).not.toMatch(/^import \{[^}]+\} from '\.\/[a-z0-9-]+\.js';$/m);
        expect(ttsSource).toContain('const builtinTtsProviderLoaders = Object.freeze({');
        expect(ttsSource).toContain('syncTtsWorkerTimer()');
        expect(quickReplySource).toContain('__sbGetInitialSettingsSnapshot?.()');
        expect(inChatAgentsSource).toContain('__sbGetInitialSettingsSnapshot?.()');
        expect(inChatAgentsSource).not.toContain('bundledAgentsSchemaVersion');
        expect(inChatAgentsSource).toContain('reconcileBundledAgentsOnce');
    });

    test('skips animated splash frames only on reduced-motion (keeping mobile loops active) and avoids boot settings POST for unread cleanup', () => {
        const evaluateSplashSkip = ({
            deviceMemory,
            userAgent = 'Mozilla/5.0 Windows NT 10.0',
            coarse = false,
            reducedMotion = false,
            saveData = false,
            effectiveType = '4g',
        }) => {
            const windowStub = {
                matchMedia: (query) => ({
                    matches: query === '(pointer: coarse)'
                        ? coarse
                        : query === '(prefers-reduced-motion: reduce)'
                            ? reducedMotion
                            : false,
                }),
                addEventListener: jest.fn(),
                setTimeout: jest.fn(),
            };
            const documentStub = {
                readyState: 'loading',
                getElementById: () => null,
                addEventListener: jest.fn(),
            };
            const sandbox = {
                window: windowStub,
                document: documentStub,
                navigator: { deviceMemory, userAgent, connection: { saveData, effectiveType } },
                Image: function Image() {},
            };
            vm.runInNewContext(splashSource, sandbox);
            return sandbox.window.SillyBunnySplash.shouldSkipLoop();
        };

        // Desktop and mobile devices (including constrained memory/network) play the splash loop unless Reduced Motion is set.
        expect(evaluateSplashSkip({ deviceMemory: 8, coarse: false })).toBe(false);
        expect(evaluateSplashSkip({ deviceMemory: 4, coarse: false })).toBe(false);
        expect(evaluateSplashSkip({ deviceMemory: 8, coarse: true })).toBe(false);
        expect(evaluateSplashSkip({ deviceMemory: 4, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', coarse: true })).toBe(false);
        expect(evaluateSplashSkip({ deviceMemory: 2, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 4a)', coarse: true })).toBe(false);
        expect(evaluateSplashSkip({ deviceMemory: 2, coarse: true })).toBe(false);
        expect(evaluateSplashSkip({ deviceMemory: undefined, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', coarse: true })).toBe(false);
        expect(evaluateSplashSkip({ deviceMemory: 8, saveData: true })).toBe(false);
        expect(evaluateSplashSkip({ deviceMemory: 8, effectiveType: '3g' })).toBe(false);

        // Only Reduced Motion skips the splash loop.
        expect(evaluateSplashSkip({ deviceMemory: 8, reducedMotion: true })).toBe(true);

        const contextSource = readFileSync(
            new URL('../../public/scripts/sillybunny-conversation/context.js', import.meta.url),
            'utf8',
        ).replace(/\r\n/g, '\n');
        const startIdx = contextSource.indexOf('const UNREAD_STORAGE_CLEANED_KEY =');
        const endIdx = contextSource.indexOf('\n// ---', startIdx);
        expect(startIdx).toBeGreaterThan(-1);
        expect(endIdx).toBeGreaterThan(startIdx);
        const unreadCleanupSlice = contextSource
            .slice(startIdx, endIdx)
            .replace(/export function /g, 'function ');

        let keyScanCount = 0;
        const removedKeys = [];
        const localData = new Map([
            ['sillybunny_conv_unread_alice', '3'],
            ['other_key', 'value'],
        ]);
        const convSandbox = {
            UNREAD_PREFIX: 'sillybunny_conv_unread_',
            localStorage: {
                get length() {
                    keyScanCount += 1;
                    return localData.size;
                },
                key: (idx) => Array.from(localData.keys())[idx] ?? null,
                getItem: (key) => localData.get(key) ?? null,
                setItem: (key, value) => localData.set(key, String(value)),
                removeItem: (key) => {
                    removedKeys.push(key);
                    localData.delete(key);
                },
            },
        };

        vm.runInNewContext(unreadCleanupSlice, convSandbox);

        // First call cleans unread keys once and stamps localStorage with UNREAD_STORAGE_CLEANED_KEY.
        expect(convSandbox.clearLegacyConversationUnreadStorage()).toBe(1);
        expect(removedKeys).toEqual(['sillybunny_conv_unread_alice']);
        expect(localData.get('sillybunny_conv_unread_cleaned_v1')).toBe('1');

        // Subsequent calls short-circuit before scanning localStorage keys.
        keyScanCount = 0;
        expect(convSandbox.clearLegacyConversationUnreadStorage()).toBe(0);
        expect(keyScanCount).toBe(0);
    });
});
