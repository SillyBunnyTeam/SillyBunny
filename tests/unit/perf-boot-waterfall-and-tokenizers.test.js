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
    isTokenCacheDirty,
    loadTokenCache,
    primeOpenAITokenCache,
    resetTokenCache,
    resetTokenizerPerfStateForTests,
    saveTokenCache,
    tokenizers,
} = await import('../../public/scripts/tokenizers.js');

const { drawChunks } = await import('../../public/scripts/extensions/token-counter/index.js');

const scriptSource = readFileSync(new URL('../../public/script.js', import.meta.url), 'utf8');
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

describe('tokenizers O(1) Map LRU, dirty flag, microtask batching, and multimodal hashing', () => {
    beforeEach(() => {
        resetTokenizerPerfStateForTests();
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

    test('coalesces concurrent getTokenCountAsync calls into one /api/tokenizers/count-batch with in-flight deduplication', async () => {
        globalThis.jQuery.ajax.mockImplementation(async (options) => {
            expect(options.url).toBe('/api/tokenizers/count-batch');
            const body = JSON.parse(options.data);
            expect(body).toEqual({
                model: 'gpt-4o',
                texts: ['first uncached string', 'second uncached string'],
            });
            return { counts: [14, 29] };
        });

        const results = await Promise.all([
            getTokenCountAsync('first uncached string'),
            getTokenCountAsync('second uncached string'),
            getTokenCountAsync('first uncached string'),
        ]);

        expect(results).toEqual([14, 29, 14]);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);

        // Subsequent calls hit the O(1) Map LRU with zero AJAX traffic.
        expect(await getTokenCountAsync('second uncached string')).toBe(29);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);
    });

    test('falls back seamlessly from /api/tokenizers/count-batch 404 to /api/tokenizers/openai/count?per_message=1 and remembers unavailability', async () => {
        const requestedUrls = [];
        globalThis.jQuery.ajax.mockImplementation(async (options) => {
            requestedUrls.push(options.url);
            if (options.url === '/api/tokenizers/count-batch') {
                const notFound = { status: 404, statusText: 'Not Found', readyState: 4 };
                throw notFound;
            }
            if (options.url.includes('/api/tokenizers/openai/count') && options.url.includes('per_message=1')) {
                const payload = JSON.parse(options.data);
                return { token_counts: payload.map((_, idx) => (idx + 1) * 11) };
            }
            throw new Error(`Unexpected URL: ${options.url}`);
        });

        const firstBatch = await Promise.all([
            getTokenCountAsync('fallback-one'),
            getTokenCountAsync('fallback-two'),
        ]);
        expect(firstBatch).toEqual([11, 22]);
        expect(requestedUrls).toEqual([
            '/api/tokenizers/count-batch',
            '/api/tokenizers/openai/count?model=gpt-4o&per_message=1',
        ]);
        expect(getTokenCacheStatsForTests().countBatchEndpointAvailable).toBe(false);

        // Next concurrent batch skips the 404 round-trip directly to per_message=1.
        requestedUrls.length = 0;
        const secondBatch = await Promise.all([
            getTokenCountAsync('fallback-three'),
            getTokenCountAsync('fallback-four'),
        ]);
        expect(secondBatch).toEqual([11, 22]);
        expect(requestedUrls).toEqual([
            '/api/tokenizers/openai/count?model=gpt-4o&per_message=1',
        ]);
    });

    test('avoids JSON.stringifying multi-MB base64 payloads in getOpenAIMessageHash while keeping distinct hashes', () => {
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

    test('retires service worker and purges sillybunny-cache-* on loopback & Android WebView while keeping remote HTTPS registration', async () => {
        const swSlice = extractSliceBetween(
            scriptSource,
            'function isLoopbackOrAndroidWebView(',
            'function scheduleDeferredStartupStylesheets(',
        );

        const runSwScenario = async ({ hostname, userAgent = 'Mozilla/5.0 Chrome/130.0', isSecureContext = true }) => {
            const idleCallbacks = [];
            const deletedCaches = [];
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

            return { registerSpy, unregisterSpy, deletedCaches };
        };

        for (const host of ['127.0.0.1', 'localhost', '[::1]', 'dev.localhost']) {
            const res = await runSwScenario({ hostname: host });
            expect(res.registerSpy).not.toHaveBeenCalled();
            expect(res.unregisterSpy).toHaveBeenCalledTimes(1);
            expect(res.deletedCaches).toEqual(['sillybunny-cache-v4', 'sillybunny-cache-v3']);
        }

        const webviewRes = await runSwScenario({
            hostname: 'companion.example.com',
            userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 Version/4.0 Chrome/128.0 Mobile Safari/537.36',
        });
        expect(webviewRes.registerSpy).not.toHaveBeenCalled();
        expect(webviewRes.unregisterSpy).toHaveBeenCalledTimes(1);

        const remoteHttpsRes = await runSwScenario({ hostname: 'sillybunny.example.com' });
        expect(remoteHttpsRes.registerSpy).toHaveBeenCalledTimes(1);
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

    test('enforces DOMContentLoaded boot gate, corrected avatar lazy-loading, flanking wheel scope, scoped observers, and lazy bundled extensions', () => {
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

        // 4. Extension observer is subtree: false and Kokoro prefetch is strictly gated.
        expect(extensionsSource).toContain('subtree: false');
        expect(extensionsSource).not.toContain('nanogallery2');
        expect(extensionsSource).toContain('extension_settings.tts?.currentProvider === \'Kokoro\'');

        // 5. TTS uses dynamic provider imports + conditional timer; quick-reply & in-chat-agents reuse initial settings snapshot.
        expect(ttsSource).not.toMatch(/^import \{[^}]+\} from '\.\/[a-z0-9-]+\.js';$/m);
        expect(ttsSource).toContain('const builtinTtsProviderLoaders = Object.freeze({');
        expect(ttsSource).toContain('syncTtsWorkerTimer()');
        expect(quickReplySource).toContain('__sbGetInitialSettingsSnapshot?.()');
        expect(inChatAgentsSource).toContain('__sbGetInitialSettingsSnapshot?.()');
        expect(inChatAgentsSource).toContain('bundledAgentsSchemaVersion');
    });

    test('skips animated splash frames on low-memory/mobile/coarse-pointer devices and skips repeated localStorage unread scans', () => {
        const evaluateSplashSkip = ({ deviceMemory, userAgent = 'Mozilla/5.0 Windows NT 10.0', coarse = false, saveData = false }) => {
            const windowStub = {
                matchMedia: (query) => ({
                    matches: query === '(pointer: coarse)' ? coarse : false,
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
                navigator: { deviceMemory, userAgent, connection: { saveData } },
                Image: function Image() {},
            };
            vm.runInNewContext(splashSource, sandbox);
            return sandbox.window.SillyBunnySplash.shouldSkipLoop();
        };

        expect(evaluateSplashSkip({ deviceMemory: 8, coarse: false })).toBe(false);
        expect(evaluateSplashSkip({ deviceMemory: 4, coarse: false })).toBe(true);
        expect(evaluateSplashSkip({ deviceMemory: 8, coarse: true })).toBe(true);
        expect(evaluateSplashSkip({ deviceMemory: 8, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' })).toBe(true);

        const contextSource = readFileSync(
            new URL('../../public/scripts/sillybunny-conversation/context.js', import.meta.url),
            'utf8',
        );
        const migrateSlice = contextSource
            .slice(contextSource.indexOf('export function clearLegacyConversationUnreadStorage()'))
            .replace(/export function /g, 'function ');

        let keyScanCount = 0;
        const removedKeys = [];
        const persistConversationStore = jest.fn();
        const store = { localStorageMigrated: true, unreadStorageCleaned: false };
        const convSandbox = {
            UNREAD_PREFIX: 'sillybunny_conv_unread_',
            getConversationStore: () => store,
            persistConversationStore,
            localStorage: {
                get length() {
                    keyScanCount += 1;
                    return 2;
                },
                key: (idx) => (idx === 0 ? 'sillybunny_conv_unread_alice' : 'other_key'),
                removeItem: (key) => removedKeys.push(key),
            },
        };

        vm.runInNewContext(migrateSlice, convSandbox);

        // First boot after upgrade cleans unread keys once and stamps unreadStorageCleaned = true.
        convSandbox.migrateConversationLocalStorage();
        expect(removedKeys).toEqual(['sillybunny_conv_unread_alice']);
        expect(store.unreadStorageCleaned).toBe(true);
        expect(persistConversationStore).toHaveBeenCalledTimes(1);

        // Subsequent boots skip the full localStorage scan completely.
        keyScanCount = 0;
        convSandbox.migrateConversationLocalStorage();
        expect(keyScanCount).toBe(0);
        expect(persistConversationStore).toHaveBeenCalledTimes(1);
    });
});
