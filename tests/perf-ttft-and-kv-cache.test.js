/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as chevrotain from 'chevrotain';
import express from 'express';
import Handlebars from 'handlebars';
import lodash from 'lodash';
import { Response as NodeFetchResponse } from 'node-fetch';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { StructuredCloneMap } from '../public/scripts/util/StructuredCloneMap.js';
import { createHarness, functionSource, worldInfoSource } from './util/world-info-harness.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readRepoFile(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('Track A: World Info batched counting, parallel loads, read-only snapshots, and regex cache', () => {
    test('batches per-entry token counts in parallel without O(K^2) cumulative prefix calls when under budget', async () => {
        const entries = {};
        for (let i = 1; i <= 20; i++) {
            entries[i] = {
                uid: i,
                key: ['dragon'],
                content: `Lore entry number ${i} about the ancient dragon.`,
                order: 1000 - i,
                position: 0,
            };
        }

        const context = createHarness({ books: { Lore: { entries } } });
        context.selected_world_info = ['Lore'];
        context.world_info = { charLore: [] };
        context.chat_metadata = {};
        context.power_user = {};
        context.world_info_budget = 50;
        context.world_info_budget_cap = 0;

        let activeCounts = 0;
        let maxConcurrentCounts = 0;
        const countedTexts = [];
        context.getTokenCountAsync = jest.fn(async (text) => {
            countedTexts.push(text);
            activeCounts++;
            maxConcurrentCounts = Math.max(maxConcurrentCounts, activeCounts);
            await Promise.resolve();
            activeCounts--;
            return String(text).split(/\s+/).filter(Boolean).length;
        });

        const result = await context.checkWorldInfo(['The dragon awakens.'], 4000, false, context.defaultGlobalScanData);

        expect(result.allActivatedEntries.size).toBe(20);
        // Must have executed per-entry counts concurrently via Promise.all rather than serially.
        expect(maxConcurrentCounts).toBeGreaterThanOrEqual(20);
        // None of the counted strings should be cumulative multi-entry prefixes.
        const multiEntryCounts = countedTexts.filter(text => (text.match(/Lore entry number/g) || []).length > 1);
        expect(multiEntryCounts).toHaveLength(0);
    });

    test('verifies exact joined prefix near budget and preserves exact cutoff and order', async () => {
        const entries = {
            1: { uid: 1, key: ['moon'], content: 'one two', order: 300, position: 0 },
            2: { uid: 2, key: ['moon'], content: 'three four', order: 200, position: 0 },
            3: { uid: 3, key: ['moon'], content: 'five six', order: 100, position: 0 },
        };

        const context = createHarness({ books: { Lore: { entries } } });
        context.selected_world_info = ['Lore'];
        context.world_info = { charLore: [] };
        context.chat_metadata = {};
        context.power_user = {};
        context.world_info_budget = 25;
        context.world_info_budget_cap = 5;

        const result = await context.checkWorldInfo(['The moon rises.'], 1000, false, context.defaultGlobalScanData);
        const uids = [...result.allActivatedEntries].map(e => e.uid);
        // Entry 1 (2 tokens) + Entry 2 (2 tokens) = 4 < 5; Entry 3 would reach 6 >= 5.
        expect(uids).toEqual([1, 2]);
    });

    test('loads multiple global and character books in parallel with readOnly snapshots', async () => {
        const context = createHarness();
        context.selected_world_info = ['BookA', 'BookB', 'BookC'];
        context.world_info = { charLore: [{ name: 'aster', extraBooks: ['Extra1', 'Extra2'] }] };
        context.chat_metadata = {};
        context.power_user = {};

        const gates = new Map();
        const started = [];
        context.loadWorldInfo = jest.fn(async (name, options) => {
            started.push({ name, readOnly: options?.readOnly });
            const gate = deferred();
            gates.set(name, gate);
            await gate.promise;
            return { entries: { 0: { uid: 0, key: [name], content: `Content ${name}` } } };
        });

        const loadPromise = context.getSortedEntries();
        await Promise.resolve();

        // All 3 global books and all 3 character books (Aster Book + Extra1 + Extra2) start before any resolve.
        expect(started.map(item => item.name)).toEqual(
            expect.arrayContaining(['BookA', 'BookB', 'BookC', 'Aster Book', 'Extra1', 'Extra2']),
        );
        expect(started.every(item => item.readOnly === true)).toBe(true);

        for (const gate of gates.values()) {
            gate.resolve();
        }
        const sorted = await loadPromise;
        expect(sorted.map(entry => entry.world)).toEqual(
            expect.arrayContaining(['BookA', 'BookB', 'BookC', 'Aster Book', 'Extra1', 'Extra2']),
        );
    });

    test('loadWorldInfo readOnly fast-path avoids cloning originalData and editor snapshots on cache hit', async () => {
        const cloneSpy = jest.fn(value => structuredClone(value));
        const cachedBook = {
            entries: { 0: { uid: 0, content: 'Entry 0' } },
            originalData: { entries: [{ id: 0, content: 'Large mirror' }] },
        };
        const cache = new StructuredCloneMap({ cloneOnGet: true, cloneOnSet: false });
        cache.set('CachedBook', cachedBook);

        const context = vm.createContext({
            lodash,
            structuredClone: cloneSpy,
            Map,
            WeakMap,
            Set,
            console,
            worldInfoCache: cache,
            worldInfoDataSnapshots: new WeakMap(),
            worldInfoEntryInstances: new WeakMap(),
            worldInfoCommittedEntryInstances: new Map(),
            worldInfoCacheVersions: new Map(),
            getRequestHeaders: () => ({}),
            fetch: jest.fn(),
        });

        const snippets = ['cloneWorldInfoData', 'getWorldInfoCachedData', 'loadWorldInfo'].map(name => functionSource(name, worldInfoSource));
        vm.runInContext(snippets.join('\n'), context);

        const readOnlyResult = await context.loadWorldInfo('CachedBook', { readOnly: true });
        expect(readOnlyResult).toBe(cachedBook);
        expect(cloneSpy).not.toHaveBeenCalled();
        expect(context.worldInfoDataSnapshots.has(readOnlyResult)).toBe(false);

        const editableResult = await context.loadWorldInfo('CachedBook');
        expect(editableResult).not.toBe(cachedBook);
        expect(cloneSpy).toHaveBeenCalled();
        expect(context.worldInfoDataSnapshots.has(editableResult)).toBe(true);
    });

    test('WorldInfoBuffer caches compiled slash-regex keys per scan and resets lastIndex on global regexes', () => {
        const context = createHarness();
        const parseSpy = jest.fn(context.parseRegexFromString);
        context.parseRegexFromString = parseSpy;

        const buffer = new context.WorldInfoBuffer(['dragon fire'], context.defaultGlobalScanData);
        const entry = { caseSensitive: false, matchWholeWords: false };

        expect(buffer.matchKeys('dragon fire', '/dragon/gi', entry)).toBe(true);
        expect(buffer.matchKeys('dragon fire', '/dragon/gi', entry)).toBe(true);
        expect(buffer.matchKeys('dragon fire', '/dragon/gi', entry)).toBe(true);
        expect(parseSpy).toHaveBeenCalledTimes(1);
    });
});

describe('Track A: OpenAI squashSystemMessages single-pass, Message.createAsync name, and multimodal 32-entry LRU', () => {
    function loadOpenAiHelpers() {
        const openaiSource = readRepoFile('public/scripts/openai.js');
        const start = openaiSource.indexOf('// SillyBunny: track static-vs-dynamic system prefix boundaries');
        const end = openaiSource.indexOf('function migrateChatCompletionSettings(settings)');
        if (start === -1 || end === -1) {
            throw new Error('Could not locate Message/ChatCompletion slice in public/scripts/openai.js');
        }
        const slice = `${openaiSource
            .slice(start, end)
            .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let)\b)/g, '')}
this.Message = Message;
this.MessageCollection = MessageCollection;
this.ChatCompletion = ChatCompletion;`;

        const countAsync = jest.fn(async (msg) => {
            const text = typeof msg?.content === 'string' ? msg.content : '';
            const nameBonus = msg?.name ? 2 : 0;
            return text.split(/\s+/).filter(Boolean).length + nameBonus;
        });

        const context = vm.createContext({
            console,
            Map,
            WeakMap,
            Set,
            Promise,
            Math,
            Number,
            String,
            Array,
            Object,
            JSON,
            structuredClone,
            chat_completion_sources: {
                OPENAI: 'openai',
                OPENROUTER: 'openrouter',
                MAKERSUITE: 'makersuite',
                MISTRALAI: 'mistralai',
                VERTEXAI: 'vertexai',
            },
            oai_settings: {
                chat_completion_source: 'openrouter',
                inline_image_quality: 'high',
            },
            default_settings: {
                inline_image_quality: 'auto',
            },
            MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' },
            RUNTIME_AGENTS_IDENTIFIER: 'sillybunnyRuntimeAgents',
            tokenHandler: { countAsync },
            isDataURL: value => typeof value === 'string' && value.startsWith('data:'),
            getStringHash: value => [...String(value)].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0),
            getImageSizeFromDataURL: jest.fn(async () => ({ width: 1024, height: 1024 })),
            createThumbnail: jest.fn(async img => `${img}#compressed`),
            getBase64Async: jest.fn(async blob => String(blob)),
            getVideoDurationFromDataURL: jest.fn(async () => 1),
            getAudioDurationFromDataURL: jest.fn(async () => 1),
            collectInChatAgentInspectionRecords: jest.fn(() => []),
            fetch: jest.fn(),
        });

        vm.runInContext(slice, context);
        return { context, countAsync };
    }

    test('squashSystemMessages counts each merged run once in parallel and preserves static-to-dynamic boundary', async () => {
        const { context, countAsync } = loadOpenAiHelpers();
        const cc = new context.ChatCompletion();
        cc.setTokenBudget(4096, 256);

        const m1 = await context.Message.createAsync('system', 'Main rule one', 'main');
        const m2 = await context.Message.createAsync('system', 'Static card description', 'charDescription');
        const m3 = await context.Message.createAsync('system', 'Static scenario text', 'scenario');
        const wi = await context.Message.createAsync('system', 'Dynamic dragon lore', 'worldInfoBefore');
        const wi2 = await context.Message.createAsync('system', 'Dynamic castle lore', 'worldInfoAfter');
        const u1 = await context.Message.createAsync('user', 'Hello', 'chatHistory-1');

        cc.add(new context.MessageCollection('main', m1));
        cc.add(new context.MessageCollection('charDescription', m2));
        cc.add(new context.MessageCollection('scenario', m3));
        cc.add(new context.MessageCollection('worldInfoBefore', wi));
        cc.add(new context.MessageCollection('worldInfoAfter', wi2));
        cc.add(new context.MessageCollection('chatHistory', u1));

        countAsync.mockClear();
        await cc.squashSystemMessages();

        // Only the 2 merged runs (3 static -> 1 static, 2 dynamic -> 1 dynamic) are counted once each.
        expect(countAsync).toHaveBeenCalledTimes(2);
        const flat = cc.getChat();
        expect(flat).toHaveLength(3);
        expect(flat[0].content).toBe('Main rule one\nStatic card description\nStatic scenario text');
        expect(flat[1].content).toBe('Dynamic dragon lore\nDynamic castle lore');
        expect(flat[2]).toEqual({ role: 'user', content: 'Hello' });
        // Static prefix ends at index 0 (ahead of dynamic WI at index 1).
        expect(cc.getStaticSystemPrefixEnd()).toBe(0);
    });

    test('Message.createAsync accepts optional name and counts only once without discarding initial count', async () => {
        const { context, countAsync } = loadOpenAiHelpers();
        const named = await context.Message.createAsync('user', 'Greetings traveler', 'chatHistory-1', 'Alice');

        expect(countAsync).toHaveBeenCalledTimes(1);
        expect(countAsync).toHaveBeenCalledWith({ role: 'user', content: 'Greetings traveler', name: 'Alice' });
        expect(named.name).toBe('Alice');
        expect(named.getTokens()).toBe(4);
    });

    test('multimodal attachment LRU reuses cached result by (url, compressMode, quality) and evicts past 32 entries', async () => {
        const { context } = loadOpenAiHelpers();
        context.clearMultimodalImageCache();

        const fetchDataUrl = jest.fn(async url => `data:image/png;base64,${url}`);
        const compressImage = jest.fn(async img => `${img}#opt`);
        const getImageSize = jest.fn(async () => ({ width: 512, height: 512 }));

        const first = await context.prepareMultimodalImage('https://example.com/a.png', {
            compressMode: 'compress',
            quality: 'auto',
            fetchDataUrl,
            compressImage,
            getImageSize,
        });
        const second = await context.prepareMultimodalImage('https://example.com/a.png', {
            compressMode: 'compress',
            quality: 'auto',
            fetchDataUrl,
            compressImage,
            getImageSize,
        });

        expect(second).toEqual(first);
        expect(fetchDataUrl).toHaveBeenCalledTimes(1);
        expect(compressImage).toHaveBeenCalledTimes(1);
        expect(getImageSize).toHaveBeenCalledTimes(1);

        // Changing quality or compressMode misses the cache cleanly.
        await context.prepareMultimodalImage('https://example.com/a.png', {
            compressMode: 'compress',
            quality: 'high',
            fetchDataUrl,
            compressImage,
            getImageSize,
        });
        expect(fetchDataUrl).toHaveBeenCalledTimes(2);

        // Fill past 32 entries and verify bounded LRU eviction.
        for (let i = 0; i < 35; i++) {
            await context.prepareMultimodalImage(`https://example.com/img-${i}.png`, {
                compressMode: 'compress',
                quality: 'low',
                fetchDataUrl,
                compressImage,
                getImageSize,
            });
        }
        expect(context.getMultimodalImageCacheSize()).toBe(32);

        // The earliest entry (img-0) was evicted, while the most recent (img-34) stays cached.
        const callsBefore = fetchDataUrl.mock.calls.length;
        await context.prepareMultimodalImage('https://example.com/img-34.png', {
            compressMode: 'compress',
            quality: 'low',
            fetchDataUrl,
            compressImage,
            getImageSize,
        });
        expect(fetchDataUrl.mock.calls.length).toBe(callsBefore);

        await context.prepareMultimodalImage('https://example.com/img-0.png', {
            compressMode: 'compress',
            quality: 'low',
            fetchDataUrl,
            compressImage,
            getImageSize,
        });
        expect(fetchDataUrl.mock.calls.length).toBe(callsBefore + 1);
    });
});

describe('Track A: Pre-send waterfall (itemizedPromptsDirty, ping freshness, OpenAI shadow guard, lazy greetings)', () => {
    test('itemizedPromptsDirty makes saveItemizedPrompts a no-op until mutated, while bookmark saves still write', async () => {
        jest.resetModules();
        const storage = new Map();
        const setItem = jest.fn(async (key, value) => {
            storage.set(key, structuredClone(value));
        });
        const getItem = jest.fn(async key => structuredClone(storage.get(key) ?? null));
        const emit = jest.fn(async () => {});

        await jest.unstable_mockModule('../public/lib.js', () => ({
            DiffMatchPatch: class {},
            DOMPurify: { sanitize: value => value },
            localforage: {
                createInstance: () => ({
                    getItem,
                    setItem,
                    removeItem: jest.fn(async key => storage.delete(key)),
                    clear: jest.fn(async () => storage.clear()),
                }),
            },
        }));
        await jest.unstable_mockModule('../public/script.js', () => ({
            chat: [],
            event_types: {
                ITEMIZED_PROMPTS_LOADED: 'loaded',
                ITEMIZED_PROMPTS_SAVED: 'saved',
                ITEMIZED_PROMPTS_DELETED: 'deleted',
                CHAT_DELETED: 'chat_deleted',
                GROUP_CHAT_DELETED: 'group_chat_deleted',
            },
            eventSource: { emit, on: jest.fn() },
            getCurrentChatId: jest.fn(() => 'chat-1'),
            reloadCurrentChat: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
        await jest.unstable_mockModule('../public/scripts/openai.js', () => ({ oai_settings: {} }));
        await jest.unstable_mockModule('../public/scripts/popup.js', () => ({ Popup: class {}, POPUP_TYPE: {} }));
        await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {}, registerDebugFunction: jest.fn() }));
        await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ isMobile: () => false }));
        await jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplateAsync: jest.fn(async () => '') }));
        await jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
            getFriendlyTokenizerName: () => ({ tokenizerName: 'test' }),
            getTokenCountAsync: jest.fn(async () => 0),
        }));
        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({ copyText: jest.fn() }));

        const mod = await import('../public/scripts/itemized-prompts.js');
        storage.set('chat-1', [{ mesId: 1, rawPrompt: 'before' }]);

        await mod.loadItemizedPrompts('chat-1');
        expect(mod.isItemizedPromptsDirty()).toBe(false);

        // Clean save is an instant no-op.
        await mod.saveItemizedPrompts('chat-1');
        expect(setItem).not.toHaveBeenCalled();

        // Saving to a new chatId (e.g. bookmark/checkpoint copy) writes even when clean.
        await mod.saveItemizedPrompts('chat-bookmark');
        expect(setItem).toHaveBeenCalledTimes(1);

        // Mutating via replaceItemizedPromptText marks dirty and writes once.
        await mod.replaceItemizedPromptText(1, 'after');
        expect(mod.isItemizedPromptsDirty()).toBe(true);
        await mod.saveItemizedPrompts('chat-1');
        expect(setItem).toHaveBeenCalledTimes(2);
        expect(mod.isItemizedPromptsDirty()).toBe(false);

        // Subsequent clean save is a no-op again.
        await mod.saveItemizedPrompts('chat-1');
        expect(setItem).toHaveBeenCalledTimes(2);
    });

    test('pingServer skips /api/ping within 5 seconds of server contact and pings when cold or stale', async () => {
        const scriptSource = readRepoFile('public/script.js');
        const start = scriptSource.indexOf('const SERVER_CONTACT_FRESHNESS_MS = 5000;');
        const end = scriptSource.indexOf('function registerSillyBunnyServiceWorker()');
        const slice = scriptSource
            .slice(start, end)
            .replace(/\bexport\s+(?=(?:async\s+)?function\b)/g, '');

        const mockFetch = jest.fn(async () => ({ ok: true }));
        const context = vm.createContext({
            fetch: mockFetch,
            Date,
            console,
            getRequestHeaders: () => ({}),
        });
        vm.runInContext(slice, context);

        // Cold connection still pings.
        expect(await context.pingServer({ allowRecentContact: true, now: 10_000 })).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Fresh contact (< 5000 ms) skips /api/ping.
        context.recordSuccessfulServerContact(10_000);
        expect(await context.pingServer({ allowRecentContact: true, now: 14_999 })).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Stale contact (>= 5000 ms) pings again.
        expect(await context.pingServer({ allowRecentContact: true, now: 15_000 })).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // Explicit ping without allowRecentContact always probes the network.
        context.recordSuccessfulServerContact(20_000);
        expect(await context.pingServer({ now: 20_100 })).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    test('script.js guards OpenAI shadow prompt counting, uses lazy card fields, and avoids sync getTokenCount in Generate', () => {
        const scriptSource = readRepoFile('public/script.js');
        expect(scriptSource).toContain('let tokenCount = main_api === \'openai\' ? 0 : await getMessagesTokenCount();');
        expect(scriptSource).toContain('typeof getCharacterCardFieldsLazy === \'function\' ? getCharacterCardFieldsLazy() : getCharacterCardFields()');
        expect(scriptSource).toContain('await pingServer({ allowRecentContact: true })');
        expect(scriptSource).toContain('const bufferedAutoContinueTokens =');
        expect(scriptSource).toContain('const streamedAutoContinueTokens =');
        expect(scriptSource).toContain('const nonStreamAutoContinueTokens =');
    });
});

describe('Track A: Macro Engine 512-entry CST LRU, {{if}} fast-path, and Handlebars 64-entry template LRU', () => {
    async function loadMacroModules() {
        jest.resetModules();
        await jest.unstable_mockModule('../public/lib.js', () => ({
            chevrotain,
            seedrandom: () => () => 0.5,
            droll: { roll: () => ({ total: 1 }) },
        }));
        await jest.unstable_mockModule('../public/script.js', () => ({
            chat_metadata: {},
            main_api: 'openai',
            getMaxPromptTokens: () => 4096,
            getMaxContextTokens: () => 4096,
            getMaxResponseTokens: () => 512,
            extension_prompts: {},
            getCurrentChatId: () => 'chat-1',
        }));
        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
            getStringHash: () => 0,
            isFalseBoolean: value => ['false', 'off', '0'].includes(String(value).trim().toLowerCase()),
            isTrueBoolean: value => ['true', 'on', '1'].includes(String(value).trim().toLowerCase()),
        }));
        await jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
            textgenerationwebui_banned_in_macros: [],
        }));
        await jest.unstable_mockModule('../public/scripts/macros/engine/MacroDiagnostics.js', () => ({
            createMacroRuntimeError: ({ message }) => Object.assign(new Error(message), { name: 'MacroRuntimeError' }),
            logMacroGeneralError: () => {},
            logMacroInternalError: () => {},
            logMacroRegisterError: () => {},
            logMacroRegisterWarning: () => {},
            logMacroRuntimeWarning: () => {},
            logMacroSyntaxWarning: () => {},
        }));

        const { MacroEngine } = await import('../public/scripts/macros/engine/MacroEngine.js');
        const { MacroParser } = await import('../public/scripts/macros/engine/MacroParser.js');
        const { registerCoreMacros, clearIfElseSplitCache } = await import('../public/scripts/macros/definitions/core-macros.js');
        registerCoreMacros();
        return { MacroEngine, MacroParser, clearIfElseSplitCache };
    }

    test('MacroEngine caches CST parses up to 512 entries and skips re-parsing repeated templates', async () => {
        const { MacroEngine, MacroParser } = await loadMacroModules();

        MacroEngine.clearParseCache();
        const parseSpy = jest.spyOn(MacroParser, 'parseDocument');

        const env = {
            names: { user: 'Alice', char: 'Bob' },
            dynamicMacros: {
                user: 'Alice',
                char: 'Bob',
            },
            functions: { postProcess: value => value },
        };

        expect(MacroEngine.evaluate('Hello {{user}} and {{char}}!', env)).toBe('Hello Alice and Bob!');
        expect(MacroEngine.evaluate('Hello {{user}} and {{char}}!', env)).toBe('Hello Alice and Bob!');
        expect(MacroEngine.evaluate('Hello {{user}} and {{char}}!', env)).toBe('Hello Alice and Bob!');
        expect(parseSpy).toHaveBeenCalledTimes(1);

        // Fill beyond 512 unique templates to verify bounded LRU eviction.
        for (let i = 0; i < 540; i++) {
            MacroEngine.evaluate(`Template #${i}: {{user}}`, env);
        }
        expect(MacroEngine.getParseCacheSize()).toBe(512);
    });

    test('core-macros {{if}} avoids parsing bodies without {{else}} and caches top-level {{else}} splits', async () => {
        const { MacroEngine, MacroParser, clearIfElseSplitCache } = await loadMacroModules();

        MacroEngine.clearParseCache();
        clearIfElseSplitCache();

        const parseSpy = jest.spyOn(MacroParser, 'parseDocument');
        const env = {
            names: { user: 'Alice', char: 'Bob' },
            dynamicMacros: { show: 'true', hide: 'false', user: 'Alice' },
            functions: { postProcess: value => value },
        };

        // {{if}} without {{else}}: splitOnTopLevelElse must NOT call MacroParser.parseDocument on the body.
        const noElseResult = MacroEngine.evaluate('{{if {{show}}}}Welcome {{user}}!{{/if}}', env);
        expect(noElseResult).toBe('Welcome Alice!');
        // 1 outer parse + 1 condition ('{{show}}') + 1 chosen branch ('Welcome {{user}}!'), zero extra parse in splitOnTopLevelElse.
        const bodyOnlyCalls = parseSpy.mock.calls.filter(([text]) => text === 'Welcome {{user}}!');
        expect(bodyOnlyCalls).toHaveLength(1);

        // {{if}} with {{else}} and nested {{if}}: evaluates the right branch and caches the split.
        const withElseTemplate = '{{if {{hide}}}}{{if {{show}}}}inner{{/if}}{{else}}fallback {{user}}{{/if}}';
        expect(MacroEngine.evaluate(withElseTemplate, env)).toBe('fallback Alice');
        const callsAfterFirst = parseSpy.mock.calls.length;
        expect(MacroEngine.evaluate(withElseTemplate, env)).toBe('fallback Alice');
        expect(parseSpy.mock.calls.length).toBe(callsAfterFirst);
    });

    test('power-user Handlebars story string template LRU caches compiled templates up to 64 entries', () => {
        const powerUserSource = readRepoFile('public/scripts/power-user.js');
        const start = powerUserSource.indexOf('const STORY_STRING_TEMPLATE_CACHE_MAX = 64;');
        const end = powerUserSource.indexOf('/**\n * Renders a story string template');
        const slice = powerUserSource
            .slice(start, end)
            .replace(/\bexport\s+function\b/g, 'function');

        const compileSpy = jest.fn((tpl, opts) => Handlebars.compile(tpl, opts));
        const context = vm.createContext({
            Map,
            String,
            Handlebars: { compile: compileSpy },
        });
        vm.runInContext(slice, context);

        const fn1 = context.getCompiledStoryStringTemplate('Hello {{char}}');
        const fn2 = context.getCompiledStoryStringTemplate('Hello {{char}}');
        expect(fn1).toBe(fn2);
        expect(fn1({ char: 'Reisen' })).toBe('Hello Reisen');
        expect(compileSpy).toHaveBeenCalledTimes(1);

        for (let i = 0; i < 70; i++) {
            context.getCompiledStoryStringTemplate(`Story template ${i}: {{char}}`);
        }
        expect(context.getStoryStringTemplateCacheSize()).toBe(64);
    });
});

describe('Track A: Parallel independent pre-reply In-Chat Agents', () => {
    test('runs consecutive additive pre-generation intercept agents concurrently and applies results in deterministic order', async () => {
        jest.resetModules();
        const listeners = new Map();
        const eventTypes = {
            GENERATION_STARTED: 'generation_started',
            GENERATION_ENDED: 'generation_ended',
            GENERATION_STOPPED: 'generation_stopped',
            GENERATION_AFTER_COMMANDS: 'generation_after_commands',
            GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
            CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
            GENERATION_OUTPUT_BUFFERING_DECISION: 'generation_output_buffering_decision',
            MAIN_GENERATION_OUTPUT_READY: 'main_generation_output_ready',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_DELETED: 'message_deleted',
            CHAT_CHANGED: 'chat_changed',
            WORLDINFO_UPDATED: 'worldinfo_updated',
            WORLDINFO_RENAMED: 'worldinfo_renamed',
            WORLDINFO_DELETED: 'worldinfo_deleted',
            STREAM_TOKEN_RECEIVED: 'stream_token_received',
        };
        const eventSource = {
            on: jest.fn((name, fn) => {
                if (!listeners.has(name)) listeners.set(name, []);
                listeners.get(name).push(fn);
            }),
            emit: jest.fn(async (name, ...args) => {
                for (const fn of listeners.get(name) ?? []) {
                    await fn(...args);
                }
            }),
        };

        let enabledAgents = [];
        const globalSettings = { appendAgentsExecutionMode: 'parallel' };
        const gateFirst = deferred();
        const gateSecond = deferred();
        const startedOrder = [];

        const generateQuietPrompt = jest.fn(async ({ quietPrompt }) => {
            if (quietPrompt.includes('First patch prompt')) {
                startedOrder.push('first');
                await gateFirst.promise;
                return 'first patch note';
            }
            if (quietPrompt.includes('Second patch prompt')) {
                startedOrder.push('second');
                await gateSecond.promise;
                return 'second patch note';
            }
            if (quietPrompt.includes('Replace pass one')) {
                startedOrder.push('replace-1');
                return 'replaced-step-1';
            }
            if (quietPrompt.includes('Replace pass two')) {
                startedOrder.push('replace-2');
                return `saw:${quietPrompt.includes('replaced-step-1')}`;
            }
            return '';
        });

        await jest.unstable_mockModule('../public/script.js', () => ({
            chat: [],
            chat_metadata: {},
            ensureSwipes: jest.fn(),
            extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
            extension_prompts: {},
            setExtensionPrompt: jest.fn(),
            setAgentGenerationContextProvider: jest.fn(),
            substituteParams: jest.fn(v => String(v ?? '')),
            substituteParamsExtended: jest.fn(v => String(v ?? '')),
            generateQuietPrompt,
            getCurrentChatId: jest.fn(() => 'chat-parallel'),
            itemizedPrompts: [],
            normalizeContentText: jest.fn(v => String(v ?? '')),
            saveChatDebounced: jest.fn(),
            stopGeneration: jest.fn(() => false),
            streamingProcessor: null,
            syncMesToSwipe: jest.fn(),
            updateMessageTokenAccounting: jest.fn(async () => ({})),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
            getContext: jest.fn(() => ({ chat: [] })),
        }));
        await jest.unstable_mockModule('../public/scripts/events.js', () => ({
            eventSource,
            event_types: eventTypes,
        }));
        await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
        await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ is_group_generating: false }));
        await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
            POPUP_RESULT: {},
            POPUP_TYPE: {},
            callGenericPopup: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/tool-calling.js', () => ({
            ToolManager: {
                RECURSE_LIMIT: 5,
                registerFunctionTool: jest.fn(),
                unregisterFunctionTool: jest.fn(),
            },
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
            areAgentsGloballyEnabled: () => true,
            getAgentById: id => enabledAgents.find(a => a.id === id) ?? null,
            getAgents: () => enabledAgents,
            getAgentRegexScripts: () => [],
            getEnabledAgents: () => enabledAgents,
            getEnabledToolAgents: () => [],
            getGlobalSettings: () => globalSettings,
            getPromptTransformMode: () => 'rewrite',
            isAgentRuntimeAllowed: () => true,
            isCompanionAgent: () => false,
            isTrackerFixAgent: () => false,
            isPathfinderSubmoduleEnabled: () => false,
            saveAgent: jest.fn(),
            isToolAgent: () => false,
            normalizePreProcessMaxTokens: () => 512,
            normalizePromptTransformMaxTokens: () => 512,
            resolveCompanionConnectionProfile: () => '',
            resolveConnectionProfile: () => '',
        }));
        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
            regexFromString: jest.fn(),
            uuidv4: () => 'uuid-1',
        }));
        await jest.unstable_mockModule('../public/scripts/chat-backup-sequence.js', () => ({
            resetChatBackupSequence: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/llm-utils.js', () => ({
            buildFallbackPromptText: () => '',
            extractProfileResponseText: () => '',
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/profile-utils.js', () => ({
            getConnectionProfileDisplayName: () => '',
            getConnectionProfileModelName: () => '',
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/helper-prefill.js', () => ({
            appendHelperPrefillMessages: msgs => ({ promptMessages: msgs, allowAssistantPrefillTail: false }),
            parseHelperPrefillMessages: () => [],
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/tool-action-registry.js', () => ({
            getToolAction: () => null,
            getToolFormatter: () => null,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js', () => ({
            getSettings: () => ({}),
            replaceSettings: jest.fn(),
            isPathfinderSelfWrite: () => false,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js', () => ({
            onPathfinderWorldInfoUpdated: jest.fn(),
            onPathfinderWorldInfoRenamed: jest.fn(),
            onPathfinderWorldInfoDeleted: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/prompts/prompt-store.js', () => ({
            initializePromptStore: jest.fn(),
            setPromptStorePersistHook: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/prompts/default-prompts.js', () => ({
            getDefaultPrompts: () => ({}),
            getDefaultPipelines: () => ({}),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tool-definitions.js', () => ({
            getPathfinderToolDefinitions: () => [],
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js', () => ({
            getContextualLorebooks: () => [],
            getForcedToolChoice: () => null,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tool-confirmation.js', () => ({
            confirmToolCall: jest.fn(async () => true),
            shouldConfirmToolCall: () => false,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/sidecar-retrieval.js', () => ({
            injectPathfinderRetrieval: jest.fn(),
            PATHFINDER_RETRIEVAL_PROMPT_KEYS: [],
            runSidecarRetrieval: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/auto-summary.js', () => ({
            resetAutoSummaryCount: jest.fn(),
            shouldAutoSummarize: () => false,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js', () => ({
            buildRegexScriptRefsForAgent: () => [],
            cacheAgentRegexScripts: jest.fn(),
            migrateLegacyRegexSnapshotsInMessages: () => 0,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/regex-scripts.js', () => ({
            AGENT_REGEX_PLACEMENT: {},
            applyRegexScriptList: value => value,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-shared.js', () => ({
            getCompanionReferenceIds: () => [],
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/tracker-state.js', () => ({
            getTrackerMetadataKey: () => '',
            getTrackerRepairPayload: () => ({ payload: '' }),
            inspectTrackerState: () => ({ status: 'valid' }),
            mergeTrackerRepairPayload: () => ({ changed: false, text: '' }),
            TRACKER_REPAIR_INSTRUCTION: '',
        }));

        const prevDocument = globalThis.document;
        const prevWindow = globalThis.window;
        const prevJquery = globalThis.$;
        const createJqueryMock = () => ({
            length: 0,
            filter: jest.fn(() => createJqueryMock()),
            find: jest.fn(() => createJqueryMock()),
            each: jest.fn(() => createJqueryMock()),
            text: jest.fn(() => ''),
            remove: jest.fn(() => createJqueryMock()),
            on: jest.fn(() => createJqueryMock()),
            off: jest.fn(() => createJqueryMock()),
            trim: jest.fn(() => ''),
        });
        globalThis.$ = jest.fn(() => createJqueryMock());
        globalThis.document = {
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            visibilityState: 'visible',
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
        };
        globalThis.window = {
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        };

        try {
            const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
            initAgentRunner();

            enabledAgents = [
                {
                    id: 'patch-second',
                    name: 'Patch Second',
                    phase: 'pre',
                    prompt: 'Second patch prompt',
                    injection: { order: 20, role: 0 },
                    preProcess: { mode: 'intercept', applyMode: 'patch', patchStartTag: '<p2>', patchEndTag: '</p2>' },
                    conditions: {},
                },
                {
                    id: 'patch-first',
                    name: 'Patch First',
                    phase: 'pre',
                    prompt: 'First patch prompt',
                    injection: { order: 10, role: 0 },
                    preProcess: { mode: 'intercept', applyMode: 'patch', patchStartTag: '<p1>', patchEndTag: '</p1>' },
                    conditions: {},
                },
            ];

            await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const eventData = { chat: [{ role: 'user', content: 'Base prompt' }], dryRun: false };
            const pendingRun = eventSource.emit(eventTypes.CHAT_COMPLETION_PROMPT_READY, eventData);

            // Wait a tick for both parallel LLM requests to launch before either gate resolves.
            await new Promise(resolve => setImmediate(resolve));
            expect(startedOrder).toEqual(['first', 'second']);

            // Resolve second BEFORE first to prove application order stays deterministic (order 10 before order 20).
            gateSecond.resolve();
            await new Promise(resolve => setImmediate(resolve));
            gateFirst.resolve();
            await pendingRun;

            expect(eventData.chat).toEqual([
                { role: 'user', content: 'Base prompt' },
                { role: 'system', content: '<p1>\nfirst patch note\n</p1>' },
                { role: 'system', content: '<p2>\nsecond patch note\n</p2>' },
            ]);

            // Replace interceptors must still run sequentially so agent 2 sees agent 1's rewritten context.
            startedOrder.length = 0;
            enabledAgents = [
                {
                    id: 'rep-1',
                    name: 'Replace 1',
                    phase: 'pre',
                    prompt: 'Replace pass one',
                    injection: { order: 10, role: 0 },
                    preProcess: { mode: 'intercept', applyMode: 'replace' },
                    conditions: {},
                },
                {
                    id: 'rep-2',
                    name: 'Replace 2',
                    phase: 'pre',
                    prompt: 'Replace pass two',
                    injection: { order: 20, role: 0 },
                    preProcess: { mode: 'intercept', applyMode: 'replace' },
                    conditions: {},
                },
            ];
            await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const textData = { prompt: 'Original text', dryRun: false };
            await eventSource.emit(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, textData);
            expect(startedOrder).toEqual(['replace-1', 'replace-2']);
            expect(textData.prompt).toBe('saw:true');
        } finally {
            if (prevDocument === undefined) {
                delete globalThis.document;
            } else {
                globalThis.document = prevDocument;
            }
            if (prevWindow === undefined) {
                delete globalThis.window;
            } else {
                globalThis.window = prevWindow;
            }
            if (prevJquery === undefined) {
                delete globalThis.$;
            } else {
                globalThis.$ = prevJquery;
            }
        }
    });
});

describe('Track A: Server TTFT, Vertex OAuth2 cache, OpenRouter SWR, KV cache alignment, async journal, UTF-8, netstat skip', () => {
    test('Vertex AI OAuth2 cache reuses access token + projectId with 60s expiry margin, evicts on invalidate, and bounds at 16 entries', async () => {
        const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-vertex-oauth-'));
        try {
            const configPath = path.join(tempDir, 'config.yaml');
            fs.writeFileSync(configPath, readRepoFile('default/config.yaml'));
            const { setConfigFilePath } = await import('../src/util.js');
            setConfigFilePath(configPath);
            const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
            const {
                getVertexAIAuth,
                invalidateVertexAIAuthCache,
                clearVertexAIAuthCache,
                getVertexAIAuthCacheSize,
            } = await import('../src/endpoints/google.js');

            clearVertexAIAuthCache();
            const secretManager = new SecretManager({ root: tempDir, backups: tempDir });
            const saJson = JSON.stringify({
                client_email: 'svc@proj-1.iam.gserviceaccount.com',
                private_key: pem,
                project_id: 'proj-alpha',
            });
            secretManager.writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, saJson);

            let nowMs = 1_000_000;
            let tokenCounter = 0;
            const fetchImpl = jest.fn(async () => new Response(JSON.stringify({
                access_token: `tok-${++tokenCounter}`,
                expires_in: 3600,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

            const req = {
                body: { vertexai_auth_mode: 'full' },
                user: { directories: { root: tempDir, backups: tempDir } },
            };

            const auth1 = await getVertexAIAuth(req, { fetchImpl, now: () => nowMs });
            const auth2 = await getVertexAIAuth(req, { fetchImpl, now: () => nowMs + 10_000 });
            expect(auth1.authHeader).toBe('Bearer tok-1');
            expect(auth2.authHeader).toBe('Bearer tok-1');
            expect(auth1.projectId).toBe('proj-alpha');
            expect(fetchImpl).toHaveBeenCalledTimes(1);

            // Within 60-second safety margin before 3600s expiry (at 3541s), token refreshes.
            nowMs += 3541 * 1000;
            const auth3 = await getVertexAIAuth(req, { fetchImpl, now: () => nowMs });
            expect(auth3.authHeader).toBe('Bearer tok-2');
            expect(fetchImpl).toHaveBeenCalledTimes(2);

            // Explicit eviction (e.g. after 401) forces immediate re-mint.
            invalidateVertexAIAuthCache(auth3.serviceAccountCacheKey);
            const auth4 = await getVertexAIAuth(req, { fetchImpl, now: () => nowMs });
            expect(auth4.authHeader).toBe('Bearer tok-3');
            expect(fetchImpl).toHaveBeenCalledTimes(3);

            // Bounded 16-entry LRU.
            for (let i = 0; i < 18; i++) {
                secretManager.writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, JSON.stringify({
                    client_email: `svc-${i}@proj.iam.gserviceaccount.com`,
                    private_key: pem,
                    project_id: `proj-${i}`,
                }));
                await getVertexAIAuth(req, { fetchImpl, now: () => nowMs });
            }
            expect(getVertexAIAuthCacheSize()).toBe(16);
            clearVertexAIAuthCache();
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('OpenRouter /models catalog uses stale-while-revalidate without stalling /generate on TTL expiry', async () => {
        const promptCaching = await import('../src/prompt-caching.js');
        promptCaching.resetOpenRouterCacheableModelsCache();

        let nowMs = 10_000_000;
        const slowRefresh = deferred();
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                data: [{ id: 'qwen/qwen3-max', pricing: { input_cache_write: '0.0000015' } }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
            .mockImplementationOnce(() => slowRefresh.promise);

        // Cold call awaits initial catalog.
        expect(await promptCaching.isOpenRouterModelCacheable('qwen/qwen3-max', { fetchImpl, now: () => nowMs })).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        // After TTL expires, stale value returns immediately while slowRefresh is still pending!
        nowMs += promptCaching.OPENROUTER_MODELS_CACHE_TTL_MS + 1;
        const swrResult = await promptCaching.isOpenRouterModelCacheable('qwen/qwen3-max', { fetchImpl, now: () => nowMs });
        expect(swrResult).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        // Once the background refresh completes with updated catalog data, subsequent calls read the fresh catalog.
        slowRefresh.resolve(new Response(JSON.stringify({
            data: [{ id: 'qwen/qwen3-max', pricing: { input_cache_write: '0' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        expect(await promptCaching.isOpenRouterModelCacheable('qwen/qwen3-max', { fetchImpl, now: () => nowMs })).toBe(false);
        promptCaching.resetOpenRouterCacheableModelsCache();
    });

    test('KV prompt-cache alignment places static-prefix cache_control ahead of dynamic worldInfoBefore while enforcing 4-marker cap and TTL monotonicity', async () => {
        const promptCaching = await import('../src/prompt-caching.js');
        const promptConverters = await import('../src/prompt-converters.js');

        // 1) Native Claude via convertClaudeMessages + cache_stability tags (stripped from serialized output).
        const rawMessages = [
            { role: 'system', content: 'Main static instructions', cache_stability: 'static' },
            { role: 'system', content: 'Dynamic worldInfoBefore lore', cache_stability: 'dynamic' },
            { role: 'system', content: 'Character description', cache_stability: 'static' },
            { role: 'user', content: 'Turn 1' },
            { role: 'assistant', content: 'Reply 1' },
            { role: 'user', content: 'Turn 2' },
        ];
        const converted = promptConverters.convertClaudeMessages(rawMessages, '', true, false, {
            charName: 'Char',
            userName: 'User',
            startsWithGroupName: () => false,
        });

        // No cache_stability key leaks into serialized blocks.
        expect(converted.systemPrompt.every(block => !Object.hasOwn(block, 'cache_stability'))).toBe(true);

        const tools = [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }];
        const betaHeaders = [];
        const total = promptCaching.applyClaudeRequestCaching({
            systemPrompt: converted.systemPrompt,
            tools,
            messages: converted.messages,
            useSystemPrompt: true,
            betaHeaders,
            config: {
                claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: true, cacheTTL: '1h' },
                gemini: { enableSystemPromptCache: false },
            },
        });

        // 1 tool + 1 static system breakpoint (ahead of dynamic WI!) + 2 depth breakpoints = 4 max.
        expect(total).toBe(4);
        expect(converted.systemPrompt[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(converted.systemPrompt[1].cache_control).toBeUndefined();
        expect(converted.systemPrompt[2].cache_control).toBeUndefined();

        // 2) OpenRouter Gemini places its single breakpoint on static prefix ahead of dynamic worldInfoBefore.
        const geminiMessages = [
            { role: 'system', content: 'Main static prompt' },
            { role: 'system', content: 'Dynamic worldInfoBefore' },
            { role: 'user', content: 'Hi' },
        ];
        await promptCaching.applyOpenRouterRequestCaching({
            requestBody: {
                model: 'google/gemini-3.5-flash',
                messages: geminiMessages,
                static_system_prefix_end: 0,
            },
            bodyParams: {},
            isModelCacheable: async () => true,
            config: {
                claude: { enableSystemPromptCache: false, cachingAtDepth: -1, extendedTTL: false, cacheTTL: '5m' },
                gemini: { enableSystemPromptCache: true },
            },
        });
        expect(geminiMessages[0].content).toEqual([
            { type: 'text', text: 'Main static prompt', cache_control: { type: 'ephemeral' } },
        ]);
        expect(geminiMessages[1].content).toBe('Dynamic worldInfoBefore');
    });

    test('generation journal coalesces rapid mutations via async atomic writes without sync fsync stalls', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-journal-async-'));
        try {
            const journal = await import('../src/generation-journal.js');
            const user = { directories: { root: tempRoot } };
            const makePlan = index => ({
                chat: { avatar: 'Aster.png' },
                file: 'chat-1',
                kind: 'append',
                index,
                anchor: 'a1',
                target: null,
                started: '2026-11-26T00:00:00.000Z',
                page: 'page-1',
                message: { original_avatar: null },
                round: [],
            });

            const journalPath = path.join(tempRoot, journal.testExports.JOURNAL_FILE);
            journal.recordGeneration(user, 'gen-1', makePlan(1));
            journal.recordGeneration(user, 'gen-2', makePlan(2));
            // Not written synchronously before microtask flush.
            expect(fs.existsSync(journalPath)).toBe(false);

            await journal.flushJournal(journalPath);
            expect(fs.existsSync(journalPath)).toBe(true);
            const saved = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
            expect(saved.map(entry => entry.id)).toEqual(['gen-1', 'gen-2']);

            // Coalesce delete and verify file is removed cleanly.
            journal.forgetGeneration(user, 'gen-1');
            journal.forgetGeneration(user, 'gen-2');
            await journal.flushJournal(journalPath);
            expect(fs.existsSync(journalPath)).toBe(false);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('pollStreamingRequestConnection skips netstat polling on Node for win32/darwin', async () => {
        jest.resetModules();
        const execFileMock = jest.fn();
        await jest.unstable_mockModule('node:os', () => ({
            ...os,
            platform: () => 'win32',
            default: { ...os, platform: () => 'win32' },
        }));
        await jest.unstable_mockModule('node:child_process', () => ({
            ...childProcess,
            execFile: execFileMock,
            default: { ...childProcess, execFile: execFileMock },
        }));

        const checker = await import('../src/connection-state-checker.js');
        const { pollStreamingRequestConnection } = await import('../src/util.js');

        expect(checker.usesNetstatPolling('win32')).toBe(true);
        expect(checker.usesNetstatPolling('darwin')).toBe(true);
        expect(checker.usesNetstatPolling('linux')).toBe(false);

        const stop = pollStreamingRequestConnection(
            { socket: { destroyed: false, localAddress: '127.0.0.1', localPort: 8080, remoteAddress: '127.0.0.2', remotePort: 5555 } },
            { writableEnded: false, destroyed: false },
            jest.fn(),
        );
        await new Promise(resolve => setImmediate(resolve));
        stop();

        // Under Node (!isBunRuntime()), netstat must never be spawned.
        expect(execFileMock).not.toHaveBeenCalled();
    });

    test('gemini-long-decode fast-paths ordinary chunks without JSON.parse and detects long-decode models', async () => {
        const { continueGenerateContentStream, isGeminiLongDecodeModel } = await import('../src/gemini-long-decode.js');

        expect(isGeminiLongDecodeModel('gemini-4-argon')).toBe(true);
        expect(isGeminiLongDecodeModel('gemini-2.5-flash')).toBe(false);
        expect(isGeminiLongDecodeModel('gemini-3.5-flash')).toBe(false);

        const parseSpy = jest.spyOn(JSON, 'parse');
        const plain1 = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] })}\r\n\r\n`;
        const plain2 = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'world' }] } }] })}\r\n\r\n`;
        const body = Readable.from([plain1, plain2], { objectMode: true });

        const response = continueGenerateContentStream(
            { ok: true, status: 200, statusText: 'OK', body },
            jest.fn(),
            new AbortController().signal,
        );

        const chunks = [];
        for await (const part of response.body) {
            chunks.push(Buffer.from(part));
        }
        expect(Buffer.concat(chunks).toString('utf8')).toBe(plain1 + plain2);
        expect(parseSpy).not.toHaveBeenCalled();
    });

    test('Responses and Interactions SSE streaming preserve split multi-byte UTF-8 via StringDecoder', async () => {
        jest.resetModules();
        const { default: actualNodeFetch } = await import('node-fetch');
        const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
        await jest.unstable_mockModule('node-fetch', () => ({ default: nodeFetchMock }));

        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-utf8-stream-'));
        const configPath = path.join(tempRoot, 'config.yaml');
        fs.writeFileSync(configPath, readRepoFile('default/config.yaml'));

        let server;
        try {
            const { setConfigFilePath } = await import('../src/util.js');
            setConfigFilePath(configPath);
            const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
            const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
            const secretManager = new SecretManager({ root: tempRoot, backups: tempRoot });
            secretManager.writeSecret(SECRET_KEYS.OPENAI, 'test-openai-key');
            secretManager.writeSecret(SECRET_KEYS.MAKERSUITE, 'test-google-key');

            const app = express();
            app.use(express.json());
            app.use((req, _res, next) => {
                req.user = { directories: { root: tempRoot, backups: tempRoot } };
                next();
            });
            app.use('/api/backends/chat-completions', chatCompletionsRouter);
            await new Promise(resolve => {
                server = app.listen(0, '127.0.0.1', resolve);
            });
            const baseUrl = `http://127.0.0.1:${server.address().port}`;

            const multiByteText = '日本語テスト🚀';
            const responsesPayload = Buffer.from(
                `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: multiByteText })}\n\n`
                + 'data: [DONE]\n\n',
                'utf8',
            );
            const splitAt = responsesPayload.indexOf(Buffer.from('🚀', 'utf8')) + 2;

            nodeFetchMock.mockImplementationOnce(async () => new NodeFetchResponse(
                Readable.from([responsesPayload.subarray(0, splitAt), responsesPayload.subarray(splitAt)], { objectMode: false }),
                { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
            ));

            const res = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                    model: 'gpt-4.1',
                    stream: true,
                    max_tokens: 64,
                    messages: [{ role: 'user', content: 'Hi' }],
                }),
            });

            const bodyText = await res.text();
            expect(bodyText).toContain(multiByteText);
            expect(bodyText).not.toContain('\uFFFD');

            // Interactions API streaming path also preserves split multi-byte UTF-8 via StringDecoder.
            const interactionPayload = Buffer.from(
                `data: ${JSON.stringify({ event_type: 'content.delta', delta: { type: 'text', text: multiByteText } })}\n\n`
                + `data: ${JSON.stringify({ event_type: 'interaction.complete', interaction: { status: 'completed' } })}\n\n`,
                'utf8',
            );
            const interactionSplitAt = interactionPayload.indexOf(Buffer.from('🚀', 'utf8')) + 2;

            nodeFetchMock.mockImplementationOnce(async () => new NodeFetchResponse(
                Readable.from([interactionPayload.subarray(0, interactionSplitAt), interactionPayload.subarray(interactionSplitAt)], { objectMode: false }),
                { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
            ));

            const interRes = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.MAKERSUITE,
                    model: 'gemini-3-flash-preview',
                    use_interactions_api: true,
                    stream: true,
                    max_tokens: 64,
                    messages: [{ role: 'user', content: 'Hi' }],
                }),
            });

            const interBodyText = await interRes.text();
            expect(interBodyText).toContain(multiByteText);
            expect(interBodyText).not.toContain('\uFFFD');
        } finally {
            if (server) {
                await new Promise(resolve => server.close(resolve));
            }
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('outbound keep-alive is configured in server-main.js and conversation-utils.js while preserving SSRF checks', () => {
        const serverMainSource = readRepoFile('src/server-main.js');
        expect(serverMainSource).toContain('const outboundKeepAlive = !isBunRuntime()');
        expect(serverMainSource).toContain('http.globalAgent = new http.Agent({ keepAlive: outboundKeepAlive');
        expect(serverMainSource).toContain('https.globalAgent = new https.Agent({ keepAlive: outboundKeepAlive');
        expect(serverMainSource).toContain('enableKeepAlive: outboundKeepAlive');

        const convUtilsSource = readRepoFile('src/endpoints/conversation-utils.js');
        expect(convUtilsSource).toContain('conversationImageHttpsAgent = new https.Agent({ keepAlive: true');
        expect(convUtilsSource).not.toContain('\'Connection\': \'close\'');
        expect(convUtilsSource).toContain('resolveGlobalAddress(url.hostname, signal)');
        expect(convUtilsSource).toContain('createConversationPinnedLookup(resolved.address, resolved.family)');
    });
});
