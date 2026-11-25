import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import _ from 'lodash';
import yaml from 'yaml';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { getConfig, getConfigValue, setConfigFilePath } from '../src/util.js';

const actualNodeFetch = (await import('node-fetch')).default;
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

const initialConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-prompt-cache-init-'));
const initialConfigPath = path.join(initialConfigRoot, 'config.yaml');
fs.writeFileSync(initialConfigPath, fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8'));
setConfigFilePath(initialConfigPath);

const promptCaching = await import('../src/prompt-caching.js');
const promptConverters = await import('../src/prompt-converters.js');

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

const cachedConfigBaseline = {
    claude: structuredClone(getConfig().claude ?? {}),
    gemini: structuredClone(getConfig().gemini ?? {}),
};

/**
 * Sets values on the cached config object that getConfigValue reads, as a saved config.yaml does.
 * @param {Record<string, unknown>} values Dotted config keys and their values
 */
function setCachingConfig(values) {
    for (const [key, value] of Object.entries(values)) {
        _.set(getConfig(), key, value);
    }
}

/**
 * Merges nested claude and gemini sections into the cached config object.
 * @param {{ claude?: Record<string, unknown>, gemini?: Record<string, unknown> }} sections
 */
function mergeCachingConfig(sections) {
    _.merge(getConfig(), sections);
}

function resetCachingConfig() {
    _.set(getConfig(), 'claude', structuredClone(cachedConfigBaseline.claude));
    _.set(getConfig(), 'gemini', structuredClone(cachedConfigBaseline.gemini));
}

function clearCachingEnv() {
    for (const name of Object.keys(process.env)) {
        if (/^SILLYTAVERN_(CLAUDE|GEMINI)_/.test(name)) {
            delete process.env[name];
        }
    }
}

describe('Prompt caching primitives and edge cases', () => {
    afterEach(() => {
        resetCachingConfig();
        clearCachingEnv();
        promptCaching.resetOpenRouterCacheableModelsCache();
    });

    test('applySystemPromptCacheForOpenRouter marks the last non-empty leading system/developer message', () => {
        const messages = [
            { role: 'system', content: 'Main prompt' },
            { role: 'developer', content: 'Character card and static world info' },
            { role: 'system', content: '   ' },
            { role: 'user', content: 'Hello!' },
            { role: 'system', content: 'Mid-chat depth injection' },
        ];

        const marked = promptCaching.applySystemPromptCacheForOpenRouter(messages);
        expect(marked).toBe(true);
        expect(messages[0].content).toBe('Main prompt');
        expect(messages[1].content).toEqual([
            { type: 'text', text: 'Character card and static world info', cache_control: { type: 'ephemeral' } },
        ]);
        expect(messages[2].content).toBe('   ');
        expect(messages[4].content).toBe('Mid-chat depth injection');
    });

    test('applySystemPromptCacheForOpenRouter does not mark mid-chat system messages when no leading system prefix exists', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
            { role: 'system', content: 'Author note at depth 0' },
        ];

        expect(promptCaching.applySystemPromptCacheForOpenRouter(messages)).toBe(false);
        expect(messages[1].content).toBe('Author note at depth 0');
    });

    test('applySystemPromptCacheForOpenRouter skips when any leading system message already has cache_control', () => {
        const messages = [
            {
                role: 'system',
                content: [{ type: 'text', text: 'Pinned', cache_control: { type: 'ephemeral' } }],
            },
            { role: 'system', content: 'Second system block' },
        ];

        expect(promptCaching.applySystemPromptCacheForOpenRouter(messages, '1h')).toBe(false);
        expect(messages[1].content).toBe('Second system block');
    });

    test('cachingAtDepthForClaude skips empty arrays, empty text, thinking, and non-allowlisted blocks without crashing', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'Turn 1' }] },
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal' }, { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} }, { type: 'text', text: '' }] },
            { role: 'user', content: [{ type: 'text', text: 'Turn 2' }, { type: 'text', text: '   ' }] },
            { role: 'assistant', content: [] },
            { role: 'user', content: [{ type: 'text', text: '' }] },
        ];

        expect(() => promptConverters.cachingAtDepthForClaude(messages, 0, '5m')).not.toThrow();

        // Depth 0 (index 4) has only empty text and index 3 has [], so it falls back to index 2's non-empty text part.
        expect(messages[4].content[0].cache_control).toBeUndefined();
        expect(messages[2].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(messages[2].content[1].cache_control).toBeUndefined();
        // Thinking, non-allowlisted server_tool_use, and empty text at index 1 never receive cache_control.
        expect(messages[1].content[0].cache_control).toBeUndefined();
        expect(messages[1].content[1].cache_control).toBeUndefined();
        expect(messages[1].content[2].cache_control).toBeUndefined();
    });

    test('cachingAtDepthForOpenRouterClaude handles null/empty tool-call turns, developer messages, and trailing images', () => {
        const messages = [
            { role: 'system', content: 'System' },
            { role: 'developer', content: 'Developer rules' },
            { role: 'user', content: [{ type: 'text', text: 'Look at this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
            { role: 'user', content: '' },
        ];

        promptConverters.cachingAtDepthForOpenRouterClaude(messages, 0, '1h');

        expect(messages[4].content).toBe('');
        expect(messages[3].content).toBeNull();
        expect(messages[2].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(messages[2].content[1].cache_control).toBeUndefined();
        expect(messages[0].content).toBe('System');
        expect(messages[1].content).toBe('Developer rules');
    });

    test('applyDepthCacheBreakpoints skips trailing assistant prefill even when followed by Post-History Instructions system message', () => {
        const messages = [
            { role: 'system', content: 'System' },
            { role: 'user', content: 'Turn 1' },
            { role: 'assistant', content: 'Reply 1' },
            { role: 'user', content: 'Turn 2' },
            { role: 'assistant', content: 'Prefill start...' },
            { role: 'system', content: 'Post-History Instructions' },
        ];

        const added = promptCaching.applyDepthCacheBreakpoints(messages, 0, '5m', { openRouterStyle: true });
        expect(added).toBe(2);
        // Trailing PHI system message and trailing assistant prefill are both skipped; Turn 2 is depth 0, Turn 1 is depth 2.
        expect(messages[5].content).toBe('Post-History Instructions');
        expect(messages[4].content).toBe('Prefill start...');
        expect(messages[3].content).toEqual([{ type: 'text', text: 'Turn 2', cache_control: { type: 'ephemeral', ttl: '5m' } }]);
        expect(messages[1].content).toEqual([{ type: 'text', text: 'Turn 1', cache_control: { type: 'ephemeral', ttl: '5m' } }]);
    });

    test('applyClaudeRequestCaching enforces Anthropic 4-breakpoint cap and skips empty system blocks', () => {
        const systemPrompt = [
            { type: 'text', text: 'Real system instructions' },
            { type: 'text', text: '' },
        ];
        const tools = [
            { name: 'search', description: 'Search', input_schema: { type: 'object' } },
        ];
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'Pre-marked', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Reply 1' }] },
            { role: 'user', content: [{ type: 'text', text: 'Turn 2' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Reply 2' }] },
            { role: 'user', content: [{ type: 'text', text: 'Turn 3' }] },
        ];
        const betaHeaders = [];

        const total = promptCaching.applyClaudeRequestCaching({
            systemPrompt,
            tools,
            messages,
            useSystemPrompt: true,
            betaHeaders,
            config: {
                claude: {
                    enableSystemPromptCache: true,
                    cachingAtDepth: 0,
                    extendedTTL: false,
                    cacheTTL: '5m',
                },
                gemini: { enableSystemPromptCache: false },
            },
        });

        expect(total).toBe(4);
        expect(promptCaching.countCacheControlMarkers({ systemPrompt, tools, messages })).toBe(4);
        expect(tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(systemPrompt[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(systemPrompt[1].cache_control).toBeUndefined();
        // Only 1 budget slot remained after pre-marked (1) + tool (1) + system (1) = 3 -> Turn 3 gets marked, Turn 2 skipped.
        expect(messages[4].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(messages[2].content[0].cache_control).toBeUndefined();
        expect(betaHeaders).toEqual(['prompt-caching-2024-07-31']);
    });

    test('applyClaudeRequestCaching enforces monotonic non-increasing TTL (never places 5m before 1h or 1h after 5m)', () => {
        // Case A: pre-existing 1h marker in messages[0] with 5m config -> never stamps 5m ahead of 1h, stamps 5m after, emits 1h beta header.
        const systemA = [{ type: 'text', text: 'System A' }];
        const toolsA = [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }];
        const messagesA = [
            { role: 'user', content: [{ type: 'text', text: 'Pinned 1h doc', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Reply 1' }] },
            { role: 'user', content: [{ type: 'text', text: 'Turn 2' }] },
        ];
        const headersA = [];
        const totalA = promptCaching.applyClaudeRequestCaching({
            systemPrompt: systemA,
            tools: toolsA,
            messages: messagesA,
            useSystemPrompt: true,
            betaHeaders: headersA,
            config: {
                claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: false, cacheTTL: '5m' },
                gemini: { enableSystemPromptCache: false },
            },
        });
        expect(totalA).toBe(2);
        expect(toolsA[0].cache_control).toBeUndefined();
        expect(systemA[0].cache_control).toBeUndefined();
        expect(messagesA[2].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(headersA).toEqual(['prompt-caching-2024-07-31', 'extended-cache-ttl-2025-04-11']);

        // Case B: pre-existing 5m (omitted ttl) marker in system with 1h config -> clamps later depth markers to 5m.
        const systemB = [{ type: 'text', text: 'System B', cache_control: { type: 'ephemeral' } }];
        const messagesB = [
            { role: 'user', content: [{ type: 'text', text: 'Turn 1' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Reply 1' }] },
            { role: 'user', content: [{ type: 'text', text: 'Turn 2' }] },
        ];
        const headersB = [];
        promptCaching.applyClaudeRequestCaching({
            systemPrompt: systemB,
            messages: messagesB,
            useSystemPrompt: true,
            betaHeaders: headersB,
            config: {
                claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: true, cacheTTL: '1h' },
                gemini: { enableSystemPromptCache: false },
            },
        });
        expect(messagesB[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(messagesB[2].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(headersB).toEqual(['prompt-caching-2024-07-31']);

        // Case C: zero breakpoints placed -> emits no prompt-caching beta headers.
        const headersC = [];
        const totalC = promptCaching.applyClaudeRequestCaching({
            systemPrompt: [{ type: 'text', text: '' }],
            messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }],
            useSystemPrompt: true,
            betaHeaders: headersC,
            config: {
                claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: true, cacheTTL: '1h' },
                gemini: { enableSystemPromptCache: false },
            },
        });
        expect(totalC).toBe(0);
        expect(headersC).toEqual([]);
    });

    test('OpenAI-style Claude caching counts pre-existing tool.function.cache_control markers against the 4-breakpoint cap', async () => {
        const tools = [
            { type: 'function', function: { name: 't1', cache_control: { type: 'ephemeral', ttl: '5m' } } },
            { type: 'function', function: { name: 't2', cache_control: { type: 'ephemeral', ttl: '5m' } } },
        ];
        const messages = [
            { role: 'system', content: 'System' },
            { role: 'user', content: 'Turn 1' },
            { role: 'assistant', content: 'Reply 1' },
            { role: 'user', content: 'Turn 2' },
        ];
        const bodyParams = {};

        await promptCaching.applyOpenRouterRequestCaching({
            requestBody: { model: 'anthropic/claude-sonnet-4-6', messages, tools },
            bodyParams,
            config: {
                claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: true, cacheTTL: '1h' },
                gemini: { enableSystemPromptCache: false },
            },
        });

        expect(promptCaching.countCacheControlMarkers({ tools, messages })).toBe(4);
        // Existing 5m tool markers clamp later message markers to 5m and leave only 2 slots (system + depth 0).
        expect(messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(messages[3].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(messages[1].content).toBe('Turn 1');
    });

    test('getPromptCachingConfig reads the cached config object on every call', () => {
        setCachingConfig({
            'claude.enableSystemPromptCache': true,
            'claude.cachingAtDepth': 3,
            'claude.extendedTTL': true,
            'gemini.enableSystemPromptCache': true,
        });
        expect(promptCaching.getPromptCachingConfig()).toEqual({
            claude: { enableSystemPromptCache: true, cachingAtDepth: 3, extendedTTL: true, cacheTTL: '1h' },
            gemini: { enableSystemPromptCache: true },
        });

        setCachingConfig({ 'claude.extendedTTL': false, 'claude.cachingAtDepth': -4 });
        expect(promptCaching.getPromptCachingConfig().claude).toEqual({
            enableSystemPromptCache: true,
            cachingAtDepth: -1,
            extendedTTL: false,
            cacheTTL: '5m',
        });
    });

    test('process.env overrides take precedence over values saved to the cached config', () => {
        setCachingConfig({
            'claude.enableSystemPromptCache': false,
            'claude.cachingAtDepth': 0,
            'claude.extendedTTL': false,
            'gemini.enableSystemPromptCache': false,
        });
        process.env.SILLYTAVERN_CLAUDE_ENABLESYSTEMPROMPTCACHE = 'true';
        process.env.SILLYTAVERN_CLAUDE_CACHINGATDEPTH = '2';
        process.env.SILLYTAVERN_CLAUDE_EXTENDEDTTL = 'true';
        process.env.SILLYTAVERN_GEMINI_ENABLESYSTEMPROMPTCACHE = 'true';

        const config = promptCaching.getPromptCachingConfig();
        expect(config.claude).toEqual({ enableSystemPromptCache: true, cachingAtDepth: 2, extendedTTL: true, cacheTTL: '1h' });
        expect(config.gemini.enableSystemPromptCache).toBe(true);
    });

    test('deriveSessionCacheKey isolates distinct user handles with identical chat_id', () => {
        const keyAlice = promptCaching.deriveSessionCacheKey('Assistant - 2026', 'server-secret', { namespace: 'openrouter', userHandle: 'alice' });
        const keyBob = promptCaching.deriveSessionCacheKey('Assistant - 2026', 'server-secret', { namespace: 'openrouter', userHandle: 'bob' });

        expect(keyAlice).toMatch(/^sb_[a-f0-9]{32}$/);
        expect(keyBob).toMatch(/^sb_[a-f0-9]{32}$/);
        expect(keyAlice).not.toBe(keyBob);
    });

    test('model matchers detect tilde latest aliases and stacked routing suffixes', () => {
        expect(promptCaching.isOpenRouterClaudeModel('~anthropic/claude-sonnet-latest')).toBe(true);
        expect(promptCaching.isOpenRouterClaudeModel('anthropic/claude-opus-5.5:nitro')).toBe(true);
        expect(promptCaching.isOpenRouterClaudeModel('google/gemini-4-neon')).toBe(false);

        expect(promptCaching.isOpenRouterGeminiModel('google/gemini-4-neon')).toBe(true);
        expect(promptCaching.isOpenRouterGeminiModel('~google/gemini-pro-latest')).toBe(true);
        expect(promptCaching.isOpenRouterGeminiModel('google/gemini-4-neon:online')).toBe(true);
        expect(promptCaching.isOpenRouterGeminiModel('z-ai/glm-5.3')).toBe(false);

        expect(promptCaching.isNanoGptClaudeModel('anthropic/claude-sonnet-4-6:thinking')).toBe(true);
        expect(promptCaching.isNanoGptClaudeModel('claude-opus-4-6')).toBe(true);
        expect(promptCaching.isElectronHubClaudeModel('anthropic/claude-sonnet-4-6')).toBe(true);
        expect(promptCaching.isElectronHubClaudeModel('claude-sonnet-4-6')).toBe(true);
    });

    test('isOpenRouterModelCacheable recovers after a fetch implementation that throws synchronously', async () => {
        let nowMs = 2_000_000;
        const throwingFetch = jest.fn(() => {
            throw new Error('sync failure');
        });
        expect(await promptCaching.isOpenRouterModelCacheable('qwen/qwen3-max', { fetchImpl: throwingFetch, now: () => nowMs })).toBe(false);
        expect(throwingFetch).toHaveBeenCalledTimes(1);

        nowMs += promptCaching.OPENROUTER_MODELS_FAILURE_BACKOFF_MS + 1;
        const goodFetch = jest.fn(async () => jsonResponse({ data: [{ id: 'qwen/qwen3-max', pricing: { input_cache_write: '0.0000015' } }] }));
        expect(await promptCaching.isOpenRouterModelCacheable('qwen/qwen3-max', { fetchImpl: goodFetch, now: () => nowMs })).toBe(true);
        expect(goodFetch).toHaveBeenCalledTimes(1);
    });

    test('isOpenRouterModelCacheable handles case-insensitivity, stacked suffixes, deduplication, and outage backoff', async () => {
        let nowMs = 1_000_000;
        const mockFetch = jest.fn();

        // First call fails transiently -> enters failure backoff so immediate follow-up doesn't hammer /models.
        mockFetch.mockRejectedValueOnce(new Error('network blip'));
        expect(await promptCaching.isOpenRouterModelCacheable('google/gemini-4-neon', { fetchImpl: mockFetch, now: () => nowMs })).toBe(false);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        expect(await promptCaching.isOpenRouterModelCacheable('google/gemini-4-neon', { fetchImpl: mockFetch, now: () => nowMs + 5000 })).toBe(false);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // After backoff expires, next parallel calls share one fetch and handle mixed case + stacked suffixes.
        nowMs += promptCaching.OPENROUTER_MODELS_FAILURE_BACKOFF_MS + 1;
        mockFetch.mockImplementationOnce(async () => jsonResponse({
            data: [
                { id: 'google/gemini-4-neon', pricing: { input_cache_write: '0.0000000833' } },
                { id: 'google/gemini-3.5-flash', pricing: { input_cache_write: '0.0000000833' } },
                { id: 'google/gemini-3.5-flash:batch', pricing: { input_cache_read: '0.000000075' } },
                { id: 'google/gemini-nano-banana-2.1', pricing: { prompt: '0.0000015' } },
            ],
        }));

        const results = await Promise.all([
            promptCaching.isOpenRouterModelCacheable('Google/Gemini-4-Neon', { fetchImpl: mockFetch, now: () => nowMs }),
            promptCaching.isOpenRouterModelCacheable('google/gemini-4-neon:nitro:online', { fetchImpl: mockFetch, now: () => nowMs }),
            promptCaching.isOpenRouterModelCacheable('google/gemini-3.5-flash:batch', { fetchImpl: mockFetch, now: () => nowMs }),
            promptCaching.isOpenRouterModelCacheable('google/gemini-nano-banana-2.1', { fetchImpl: mockFetch, now: () => nowMs }),
        ]);

        expect(results).toEqual([true, true, false, false]);
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // Subsequent negative lookup stays cached without hitting /models again.
        expect(await promptCaching.isOpenRouterModelCacheable('google/gemini-nano-banana-2.1', { fetchImpl: mockFetch, now: () => nowMs + 1000 })).toBe(false);
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // After TTL expires, catalog refreshes.
        nowMs += promptCaching.OPENROUTER_MODELS_CACHE_TTL_MS + 1;
        mockFetch.mockResolvedValueOnce(jsonResponse({
            data: [{ id: 'google/gemini-4-neon', pricing: { input_cache_write: '0.0000000833' } }],
        }));
        expect(await promptCaching.isOpenRouterModelCacheable('google/gemini-4-neon', { fetchImpl: mockFetch, now: () => nowMs })).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });
});

describe('TTL ordering and breakpoint budget over seeded random payloads', () => {
    const ITERATIONS = 4000;

    /** @param {number} seed */
    function createRandom(seed) {
        let state = seed;
        const next = () => {
            state = (state * 1664525 + 1013904223) % 4294967296;
            return state / 4294967296;
        };
        return { next, int: (max) => Math.floor(next() * max), pick: (values) => values[Math.floor(next() * values.length)] };
    }

    const ttlOf = (cacheControl) => (cacheControl?.ttl === '1h' ? '1h' : '5m');
    const hasLongBeforeShort = (ttls) => {
        let seenShort = false;
        for (const ttl of ttls) {
            if (ttl === '5m') {
                seenShort = true;
            } else if (seenShort) {
                return true;
            }
        }
        return false;
    };

    function buildPayload(random) {
        const existingMarker = () => (random.next() < 0.8
            ? undefined
            : random.pick([{ type: 'ephemeral' }, { type: 'ephemeral', ttl: '5m' }, { type: 'ephemeral', ttl: '1h' }]));
        const textBlock = (text) => {
            const block = { type: 'text', text };
            const marker = existingMarker();
            if (marker) {
                block.cache_control = marker;
            }
            return block;
        };

        const tools = Array.from({ length: random.int(4) }, (_, index) => {
            const tool = { name: `tool${index}` };
            const marker = existingMarker();
            if (marker) {
                tool.cache_control = marker;
            }
            return tool;
        });
        const systemPrompt = Array.from({ length: random.int(3) }, (_, index) => textBlock(`system${index}`));
        const messages = Array.from({ length: 1 + random.int(8) }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: Array.from({ length: 1 + random.int(2) }, (_, part) => textBlock(`message${index}.${part}`)),
        }));
        const ext = random.next() < 0.5;
        const config = {
            claude: {
                enableSystemPromptCache: random.next() < 0.8,
                cachingAtDepth: random.pick([-1, 0, 0, 1, 2]),
                extendedTTL: ext,
                cacheTTL: ext ? '1h' : '5m',
            },
            gemini: { enableSystemPromptCache: false },
        };
        return { tools, systemPrompt, messages, config, useSystemPrompt: random.next() < 0.7 };
    }

    /** Marker TTLs in the order Anthropic reads the prompt: tools, system, messages. */
    function markerTtls({ tools, systemPrompt, messages, useSystemPrompt }) {
        const ttls = [];
        for (const tool of tools) {
            if (tool.cache_control) ttls.push(ttlOf(tool.cache_control));
        }
        if (useSystemPrompt) {
            for (const block of systemPrompt) {
                if (block.cache_control) ttls.push(ttlOf(block.cache_control));
            }
        }
        for (const message of messages) {
            for (const block of message.content) {
                if (block.cache_control) ttls.push(ttlOf(block.cache_control));
            }
        }
        return ttls;
    }

    function checkInvariants(before, after, tally) {
        tally.total += 1;
        if (hasLongBeforeShort(before)) {
            return;
        }
        if (after.length > before.length) {
            tally.placed += 1;
        }
        expect(hasLongBeforeShort(after)).toBe(false);
        if (before.length <= 4) {
            expect(after.length).toBeLessThanOrEqual(4);
        } else {
            expect(after.length).toBe(before.length);
        }
    }

    test('native Claude never puts a 5m marker before a 1h marker and never adds one past four', () => {
        const random = createRandom(12345);
        const tally = { total: 0, placed: 0 };

        for (let i = 0; i < ITERATIONS; i++) {
            const payload = buildPayload(random);
            const before = markerTtls(payload);
            promptCaching.applyClaudeRequestCaching({
                requestBody: { type: 'normal' },
                systemPrompt: payload.systemPrompt,
                tools: payload.tools,
                allTools: payload.tools,
                messages: payload.messages,
                useSystemPrompt: payload.useSystemPrompt,
                betaHeaders: [],
                config: payload.config,
            });
            checkInvariants(before, markerTtls(payload), tally);
        }

        expect(tally.placed).toBeGreaterThan(ITERATIONS / 4);
    });

    test('OpenRouter Claude keeps the same two invariants on OpenAI-style messages', async () => {
        const random = createRandom(67890);
        const tally = { total: 0, placed: 0 };

        for (let i = 0; i < ITERATIONS; i++) {
            const payload = buildPayload(random);
            const messages = [];
            if (payload.systemPrompt.length > 0) {
                messages.push({ role: 'system', content: payload.systemPrompt });
            }
            messages.push(...payload.messages);
            const readTtls = () => markerTtls({ tools: payload.tools, systemPrompt: [], messages, useSystemPrompt: false });
            const before = readTtls();
            const requestBody = { type: 'normal', model: 'anthropic/claude-sonnet-4.5', messages, tools: payload.tools.length > 0 ? payload.tools : undefined };

            await promptCaching.applyOpenRouterRequestCaching({ requestBody, bodyParams: {}, tools: requestBody.tools, config: payload.config });
            checkInvariants(before, readTtls(), tally);
        }

        expect(tally.placed).toBeGreaterThan(ITERATIONS / 4);
    });
});

describe('Chat completions backend prompt caching integration', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let configPath;
    let configYamlBaseline;
    const tempDirs = [];

    beforeAll(async () => {
        configPath = initialConfigPath;
        configYamlBaseline = fs.readFileSync(configPath, 'utf8');

        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-prompt-cache-data-'));
        tempDirs.push(initialConfigRoot, dataRoot);
        global.DATA_ROOT = dataRoot;
        global.COMMAND_LINE_ARGS = { ...(global.COMMAND_LINE_ARGS || {}), configPath };

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { router: serverAdminRouter } = await import('../src/endpoints/server-admin.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');

        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-prompt-cache-user-'));
        tempDirs.push(userRoot);
        const secretManager = new SecretManager({ root: userRoot, backups: userRoot });
        for (const key of [
            SECRET_KEYS.OPENROUTER,
            SECRET_KEYS.CLAUDE,
            SECRET_KEYS.OPENAI,
            SECRET_KEYS.NANOGPT,
            SECRET_KEYS.ELECTRONHUB,
            SECRET_KEYS.MAKERSUITE,
            SECRET_KEYS.XAI,
            SECRET_KEYS.MISTRALAI,
            SECRET_KEYS.AZURE_OPENAI,
        ]) {
            secretManager.writeSecret(key, 'test-provider-key');
        }

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = {
                profile: { handle: req.get('x-test-user') ?? 'admin', admin: true },
                directories: { root: userRoot, backups: userRoot },
            };
            next();
        });
        app.use('/api/backends/chat-completions', chatCompletionsRouter);
        app.use('/api/server-admin', serverAdminRouter);

        await new Promise((resolve) => {
            appServer = app.listen(0, '127.0.0.1', resolve);
        });
        const address = appServer.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    beforeEach(() => {
        fs.writeFileSync(configPath, configYamlBaseline);
        resetCachingConfig();
        clearCachingEnv();
        promptCaching.resetOpenRouterCacheableModelsCache();
        nodeFetchMock.mockReset();
        nodeFetchMock.mockImplementation(async (url) => {
            if (String(url).endsWith('/models')) {
                return jsonResponse({
                    data: [
                        { id: 'google/gemini-4-neon', pricing: { input_cache_write: '0.0000000833', input_cache_read: '0.00000015' } },
                        { id: '~google/gemini-pro-latest', pricing: { input_cache_write: '0.0000001875', input_cache_read: '0.0000001' } },
                        { id: 'qwen/qwen3-max', pricing: { input_cache_write: '0.0000015', input_cache_read: '0.0000001' } },
                        { id: 'openai/gpt-5.6', pricing: { input_cache_write: '0.00000625', input_cache_read: '0.0000005' } },
                        { id: 'openai/gpt-4o', pricing: { input_cache_read: '0.00000125' } },
                        { id: '~x-ai/grok-latest', pricing: { input_cache_write: '0', input_cache_read: '0.0000002' } },
                    ],
                });
            }
            if (String(url).endsWith('/messages')) {
                return jsonResponse({ content: [{ type: 'text', text: 'ok' }] });
            }
            if (String(url).includes(':generateContent')) {
                return jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
            }
            if (String(url).endsWith('/responses')) {
                return jsonResponse({
                    id: 'resp_1',
                    model: 'gpt-5',
                    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
                });
            }
            if (String(url).endsWith('/completions')) {
                return jsonResponse({ choices: [{ text: 'ok' }] });
            }
            return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
        });
    });

    afterAll(async () => {
        resetCachingConfig();
        clearCachingEnv();
        promptCaching.resetOpenRouterCacheableModelsCache();
        if (appServer) {
            await new Promise((resolve, reject) => {
                appServer.close(error => error ? reject(error) : resolve());
            });
        }
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        nodeFetchMock.mockImplementation((url, options) => actualNodeFetch(url, options));
    });

    function post(route, body, headers = {}) {
        return fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
    }

    test('OpenRouter Gemini 4 sends stable opaque session_id even with explicit cache markers off, and skips /models fetch', async () => {
        for (const chatId of ['secret-character-chat-1', 'secret-character-chat-1', 'secret-character-chat-2']) {
            const res = await post('/api/backends/chat-completions/generate', {
                chat_completion_source: CHAT_COMPLETION_SOURCES.OPENROUTER,
                model: 'google/gemini-4-neon',
                chat_id: chatId,
                stream: false,
                max_tokens: 256,
                messages: [
                    { role: 'system', content: 'System prompt' },
                    { role: 'user', content: 'Hello' },
                ],
            });
            expect(res.status).toBe(200);
        }

        const completionCalls = nodeFetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'));
        const modelCalls = nodeFetchMock.mock.calls.filter(([url]) => String(url).endsWith('/models'));
        expect(modelCalls).toHaveLength(0);
        expect(completionCalls).toHaveLength(3);

        const bodies = completionCalls.map(([, opts]) => JSON.parse(opts.body));
        expect(bodies[0].session_id).toMatch(/^sb_[a-f0-9]{32}$/);
        expect(bodies[1].session_id).toBe(bodies[0].session_id);
        expect(bodies[2].session_id).not.toBe(bodies[0].session_id);
        expect(completionCalls[0][1].body).not.toContain('secret-character-chat-1');
    });

    const MARKER_SOURCES = [
        { name: 'native Claude', source: CHAT_COMPLETION_SOURCES.CLAUDE, model: 'claude-sonnet-4-6', extra: { use_sysprompt: true } },
        { name: 'OpenRouter Claude', source: CHAT_COMPLETION_SOURCES.OPENROUTER, model: 'anthropic/claude-sonnet-4-6', extra: {} },
        { name: 'NanoGPT', source: CHAT_COMPLETION_SOURCES.NANOGPT, model: 'anthropic/claude-sonnet-4-6', extra: {} },
        { name: 'Electron Hub', source: CHAT_COMPLETION_SOURCES.ELECTRONHUB, model: 'anthropic/claude-sonnet-4-6', extra: {} },
    ];
    const NON_MAIN_REQUESTS = [
        ['quiet', { type: 'quiet' }],
        ['auxiliary', { type: 'normal', cacheScope: 'auxiliary' }],
        ['conversation-mode', { type: 'quiet', cacheScope: 'conversation-mode' }],
    ];

    /** Counts cache_control markers placed in the prompt, not the NanoGPT body helper. */
    function countInlineMarkers(body) {
        return promptCaching.countCacheControlMarkers({ systemPrompt: body.system, tools: body.tools, messages: body.messages });
    }

    async function sendMarkerRequest({ source, model, extra }, overrides = {}) {
        nodeFetchMock.mockClear();
        const res = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: source,
            model,
            stream: false,
            max_tokens: 256,
            messages: [
                { role: 'system', content: 'Helper system' },
                { role: 'user', content: 'Turn 1' },
                { role: 'assistant', content: 'Reply 1' },
                { role: 'user', content: 'Summarize' },
            ],
            ...extra,
            ...overrides,
        });
        expect(res.status).toBe(200);
        const [, options] = nodeFetchMock.mock.calls[0];
        return { body: JSON.parse(options.body), headers: options.headers };
    }

    describe.each(MARKER_SOURCES)('$name cache markers', (sourceCase) => {
        beforeEach(() => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: false } });
        });

        test.each(NON_MAIN_REQUESTS)('are placed on %s requests, as on a main turn', async (_name, overrides) => {
            const main = await sendMarkerRequest(sourceCase);
            const helper = await sendMarkerRequest(sourceCase, overrides);

            expect(countInlineMarkers(main.body)).toBeGreaterThanOrEqual(2);
            expect(countInlineMarkers(helper.body)).toBe(countInlineMarkers(main.body));
            expect(helper.body.system ?? helper.body.messages[0].content).toEqual(main.body.system ?? main.body.messages[0].content);
        });

        test('are absent for cacheScope none, together with the NanoGPT helper and the Claude beta header', async () => {
            const { body, headers } = await sendMarkerRequest(sourceCase, { cacheScope: 'none', chat_id: 'some-chat' });

            expect(countInlineMarkers(body)).toBe(0);
            expect(body.cache_control).toBeUndefined();
            expect(body.session_id).toBeUndefined();
            expect(String(headers['anthropic-beta'] ?? '')).not.toContain('prompt-caching');
        });
    });

    test.each(NON_MAIN_REQUESTS)('session keys follow chat_id on %s requests and never the request type', async (_name, overrides) => {
        const send = async (source, model, extra) => {
            nodeFetchMock.mockClear();
            const res = await post('/api/backends/chat-completions/generate', {
                chat_completion_source: source,
                model,
                stream: false,
                max_tokens: 64,
                messages: [{ role: 'user', content: 'Hi' }],
                ...overrides,
                ...extra,
            });
            expect(res.status).toBe(200);
            return JSON.parse(nodeFetchMock.mock.calls[0][1].body);
        };

        const withChat = await send(CHAT_COMPLETION_SOURCES.OPENROUTER, 'anthropic/claude-sonnet-4-6', { chat_id: 'secret-chat' });
        expect(withChat.session_id).toMatch(/^sb_[a-f0-9]{32}$/);
        expect(JSON.stringify(withChat)).not.toContain('secret-chat');
        expect((await send(CHAT_COMPLETION_SOURCES.OPENROUTER, 'anthropic/claude-sonnet-4-6', {})).session_id).toBeUndefined();
        expect((await send(CHAT_COMPLETION_SOURCES.OPENROUTER, 'anthropic/claude-sonnet-4-6', { chat_id: '  ' })).session_id).toBeUndefined();
        expect((await send(CHAT_COMPLETION_SOURCES.OPENROUTER, 'anthropic/claude-sonnet-4-6', { chat_id: 'secret-chat', cacheScope: 'none' })).session_id).toBeUndefined();

        const openAiWithChat = await send(CHAT_COMPLETION_SOURCES.OPENAI, 'gpt-5', { chat_id: 'secret-chat' });
        expect(openAiWithChat.prompt_cache_key).toMatch(/^sb_[a-f0-9]{32}$/);
        expect((await send(CHAT_COMPLETION_SOURCES.OPENAI, 'gpt-5', {})).prompt_cache_key).toBeUndefined();
        expect((await send(CHAT_COMPLETION_SOURCES.OPENAI, 'gpt-5', { chat_id: 'secret-chat', cacheScope: 'none' })).prompt_cache_key).toBeUndefined();
    });

    test('OpenRouter Gemini places its system marker on a quiet request too', async () => {
        mergeCachingConfig({ gemini: { enableSystemPromptCache: true } });
        nodeFetchMock.mockClear();
        const res = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENROUTER,
            model: 'google/gemini-4-neon',
            type: 'quiet',
            stream: false,
            max_tokens: 64,
            messages: [
                { role: 'system', content: 'Prefix' },
                { role: 'user', content: 'Summarize' },
            ],
        });
        expect(res.status).toBe(200);
        const completionCall = nodeFetchMock.mock.calls.find(([url]) => String(url).endsWith('/chat/completions'));
        expect(JSON.parse(completionCall[1].body).messages[0].content).toEqual([
            { type: 'text', text: 'Prefix', cache_control: { type: 'ephemeral' } },
        ]);
    });

    test('OpenRouter Gemini 4 with suffix marks only the static leading system prefix without TTL', async () => {
        mergeCachingConfig({
            gemini: { enableSystemPromptCache: true },
        });

        const res = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENROUTER,
            model: 'google/gemini-4-neon:online',
            chat_id: 'chat-gemini-explicit',
            stream: false,
            max_tokens: 256,
            messages: [
                { role: 'system', content: 'Main Prompt' },
                { role: 'system', content: 'Character Card + Lore' },
                { role: 'user', content: 'Turn 1' },
                { role: 'assistant', content: 'Reply 1' },
                { role: 'user', content: 'Turn 2' },
            ],
        });
        expect(res.status).toBe(200);

        const completionCall = nodeFetchMock.mock.calls.find(([url]) => String(url).endsWith('/chat/completions'));
        const body = JSON.parse(completionCall[1].body);
        expect(body.session_id).toMatch(/^sb_[a-f0-9]{32}$/);
        // System marker lands on last leading system message (index 1) without TTL; rolling turns rely on implicit caching + session_id.
        expect(body.messages[0].content).toBe('Main Prompt');
        expect(body.messages[1].content).toEqual([
            { type: 'text', text: 'Character Card + Lore', cache_control: { type: 'ephemeral' } },
        ]);
        expect(body.messages[2].content).toBe('Turn 1');
        expect(body.messages[4].content).toBe('Turn 2');
    });

    test('OpenRouter ~anthropic/claude-sonnet-latest receives Claude system and depth markers with TTL', async () => {
        mergeCachingConfig({
            claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: true },
        });

        const res = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENROUTER,
            model: '~anthropic/claude-sonnet-latest',
            chat_id: 'chat-claude-latest',
            stream: false,
            max_tokens: 256,
            messages: [
                { role: 'system', content: 'Base' },
                { role: 'system', content: 'Card' },
                { role: 'user', content: 'Turn 1' },
                { role: 'assistant', content: 'Reply 1' },
                { role: 'user', content: 'Turn 2' },
            ],
        });
        expect(res.status).toBe(200);

        const body = JSON.parse(nodeFetchMock.mock.calls[0][1].body);
        expect(body.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(body.messages[2].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(body.messages[4].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    });

    describe('OpenRouter models other than Claude and Gemini', () => {
        const history = [
            { role: 'system', content: 'System' },
            { role: 'user', content: 'Turn 1' },
            { role: 'assistant', content: 'Reply 1' },
            { role: 'user', content: 'Turn 2' },
        ];

        async function sendOpenRouter(model, overrides = {}) {
            nodeFetchMock.mockClear();
            const res = await post('/api/backends/chat-completions/generate', {
                chat_completion_source: CHAT_COMPLETION_SOURCES.OPENROUTER,
                model,
                stream: false,
                max_tokens: 256,
                messages: structuredClone(history),
                ...overrides,
            });
            expect(res.status).toBe(200);
            const completionCall = nodeFetchMock.mock.calls.find(([url]) => String(url).endsWith('/chat/completions'));
            return {
                body: JSON.parse(completionCall[1].body),
                catalogFetches: nodeFetchMock.mock.calls.filter(([url]) => String(url).endsWith('/models')).length,
            };
        }

        test.each(['qwen/qwen3-max', 'qwen/qwen3-max:nitro'])('%s gets the system and depth markers without a ttl', async (model) => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: true } });

            const { body } = await sendOpenRouter(model);
            expect(body.messages[0].content).toEqual([{ type: 'text', text: 'System', cache_control: { type: 'ephemeral' } }]);
            expect(body.messages[1].content).toEqual([{ type: 'text', text: 'Turn 1', cache_control: { type: 'ephemeral' } }]);
            expect(body.messages[2].content).toBe('Reply 1');
            expect(body.messages[3].content).toEqual([{ type: 'text', text: 'Turn 2', cache_control: { type: 'ephemeral' } }]);
        });

        test('the claude settings decide which markers a catalog model gets', async () => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: -1 } });
            const systemOnly = (await sendOpenRouter('qwen/qwen3-max')).body;
            expect(promptCaching.countCacheControlMarkers({ messages: systemOnly.messages })).toBe(1);
            expect(systemOnly.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });

            mergeCachingConfig({ claude: { enableSystemPromptCache: false, cachingAtDepth: 0 } });
            const depthOnly = (await sendOpenRouter('qwen/qwen3-max')).body;
            expect(depthOnly.messages[0].content).toBe('System');
            expect(promptCaching.countCacheControlMarkers({ messages: depthOnly.messages })).toBe(2);
        });

        test('markers also reach a catalog model on a quiet request', async () => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: 0 } });
            const { body } = await sendOpenRouter('qwen/qwen3-max', { type: 'quiet', cacheScope: 'auxiliary' });
            expect(promptCaching.countCacheControlMarkers({ messages: body.messages })).toBe(3);
        });

        test('an OpenAI model, a model with only a cache read price or a free cache write, or no catalog entry, gets no markers', async () => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: 0 } });

            for (const model of ['openai/gpt-5.6', 'openai/gpt-4o', '~x-ai/grok-latest', 'acme/unlisted-model']) {
                const { body, catalogFetches } = await sendOpenRouter(model);
                expect(catalogFetches).toBeLessThanOrEqual(1);
                expect(body.messages).toEqual(history);
            }
        });

        test('no catalog fetch happens while both claude settings are off', async () => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: false, cachingAtDepth: -1 } });

            const { body, catalogFetches } = await sendOpenRouter('qwen/qwen3-max');
            expect(catalogFetches).toBe(0);
            expect(body.messages).toEqual(history);
        });

        test('Claude models need no catalog fetch, so they keep their markers while the catalog is down', async () => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: true } });
            const defaultMock = nodeFetchMock.getMockImplementation();
            nodeFetchMock.mockImplementation(async (url, options) => {
                if (String(url).endsWith('/models')) {
                    throw new Error('catalog outage');
                }
                return defaultMock(url, options);
            });

            const claude = await sendOpenRouter('anthropic/claude-sonnet-4-6');
            expect(claude.catalogFetches).toBe(0);
            expect(claude.body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

            const qwen = await sendOpenRouter('qwen/qwen3-max');
            expect(qwen.catalogFetches).toBe(1);
            expect(qwen.body.messages).toEqual(history);
        });

        test('a stale catalog copy keeps serving during an outage', async () => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: -1 } });
            let nowMs = 5_000_000;
            const catalog = { data: [{ id: 'qwen/qwen3-max', pricing: { input_cache_write: '0.0000015' } }] };
            const fetchImpl = jest.fn()
                .mockResolvedValueOnce(jsonResponse(catalog))
                .mockRejectedValue(new Error('catalog outage'));
            const options = { fetchImpl, now: () => nowMs };

            expect(await promptCaching.isOpenRouterModelCacheable('qwen/qwen3-max', options)).toBe(true);
            nowMs += promptCaching.OPENROUTER_MODELS_CACHE_TTL_MS + 1;
            expect(await promptCaching.isOpenRouterModelCacheable('qwen/qwen3-max', options)).toBe(true);
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        });
    });

    describe.each([
        {
            name: 'xAI',
            source: CHAT_COMPLETION_SOURCES.XAI,
            model: 'grok-4',
            extra: {},
            read: ({ headers, body }) => ({ key: headers['x-grok-conv-id'], absentFromBody: !('prompt_cache_key' in body) }),
        },
        {
            name: 'Mistral',
            source: CHAT_COMPLETION_SOURCES.MISTRALAI,
            model: 'mistral-large-latest',
            extra: {},
            read: ({ headers, body }) => ({ key: body.prompt_cache_key, absentFromBody: !('x-grok-conv-id' in headers) }),
        },
        {
            name: 'Azure OpenAI',
            source: CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
            model: 'gpt-4.1',
            extra: { azure_base_url: 'https://example.openai.azure.com', azure_deployment_name: 'dep', azure_api_version: '2024-10-21' },
            read: ({ body }) => ({ key: body.prompt_cache_key, absentFromBody: true }),
        },
    ])('$name cache routing key', ({ source, model, extra, read }) => {
        async function send(overrides = {}, user) {
            nodeFetchMock.mockClear();
            const res = await post('/api/backends/chat-completions/generate', {
                chat_completion_source: source,
                model,
                stream: false,
                max_tokens: 64,
                messages: [{ role: 'user', content: 'Hi' }],
                ...extra,
                ...overrides,
            }, user ? { 'x-test-user': user } : {});
            expect(res.status).toBe(200);
            const [, options] = nodeFetchMock.mock.calls[0];
            return { body: JSON.parse(options.body), headers: options.headers, raw: JSON.stringify({ body: options.body, headers: options.headers }) };
        }

        test('is stable for a chat, differs between chats and users, and never carries the chat id', async () => {
            const first = await send({ chat_id: 'private-chat-name' });
            const again = await send({ chat_id: 'private-chat-name' });
            const otherChat = await send({ chat_id: 'another-chat-name' });
            const otherUser = await send({ chat_id: 'private-chat-name' }, 'bob');

            const { key } = read(first);
            expect(key).toMatch(/^sb_[a-f0-9]{32}$/);
            expect(read(again).key).toBe(key);
            expect(read(otherChat).key).not.toBe(key);
            expect(read(otherUser).key).not.toBe(key);
            for (const sent of [first, again, otherChat, otherUser]) {
                expect(sent.raw).not.toContain('private-chat-name');
                expect(sent.raw).not.toContain('another-chat-name');
            }
        });

        test.each([
            ['no chat id', {}],
            ['an empty chat id', { chat_id: '' }],
            ['a reverse proxy', { chat_id: 'private-chat-name', reverse_proxy: 'https://proxy.example/v1', proxy_password: 'proxy-key' }],
            ['cacheScope none', { chat_id: 'private-chat-name', cacheScope: 'none' }],
        ])('is absent with %s', async (_name, overrides) => {
            const sent = await send(overrides);
            expect(read(sent).key).toBeUndefined();
            expect(sent.raw).not.toMatch(/sb_[a-f0-9]{32}/);
        });

        test('follows chat_id on quiet requests, as the client decides which requests carry it', async () => {
            const sent = await send({ chat_id: 'private-chat-name', type: 'quiet', cacheScope: 'auxiliary' });
            expect(read(sent).key).toMatch(/^sb_[a-f0-9]{32}$/);
        });
    });

    test('Azure OpenAI drops a client-supplied prompt_cache_key and sends only the derived one', async () => {
        const send = async (overrides) => {
            nodeFetchMock.mockClear();
            const res = await post('/api/backends/chat-completions/generate', {
                chat_completion_source: CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
                model: 'gpt-4.1',
                azure_base_url: 'https://example.openai.azure.com',
                azure_deployment_name: 'dep',
                azure_api_version: '2024-10-21',
                stream: false,
                max_tokens: 64,
                messages: [{ role: 'user', content: 'Hi' }],
                prompt_cache_key: 'client-chosen',
                ...overrides,
            });
            expect(res.status).toBe(200);
            return JSON.parse(nodeFetchMock.mock.calls[0][1].body);
        };

        expect((await send({})).prompt_cache_key).toBeUndefined();
        expect((await send({ chat_id: 'private-chat-name' })).prompt_cache_key).toMatch(/^sb_[a-f0-9]{32}$/);
    });

    describe('NanoGPT prompt caching', () => {
        const history = [
            { role: 'system', content: 'System' },
            { role: 'user', content: 'Turn 1' },
            { role: 'assistant', content: 'Reply 1' },
            { role: 'user', content: 'Turn 2' },
        ];

        async function sendNanoGpt({ messages = history, model = 'anthropic/claude-sonnet-4-6', ...overrides } = {}) {
            nodeFetchMock.mockClear();
            const res = await post('/api/backends/chat-completions/generate', {
                chat_completion_source: CHAT_COMPLETION_SOURCES.NANOGPT,
                model,
                stream: false,
                max_tokens: 256,
                messages: structuredClone(messages),
                ...overrides,
            });
            expect(res.status).toBe(200);
            return JSON.parse(nodeFetchMock.mock.calls[0][1].body);
        }

        test('system flag on with depth -1 sends only the body helper, so NanoGPT places the breakpoints', async () => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: -1, extendedTTL: false } });

            const body = await sendNanoGpt();
            expect(body.cache_control).toEqual({ enabled: true, ttl: '5m' });
            expect(body.cache_control).not.toHaveProperty('explicitCacheControl');
            expect(body.messages).toEqual(history);

            mergeCachingConfig({ claude: { extendedTTL: true } });
            expect((await sendNanoGpt()).cache_control).toEqual({ enabled: true, ttl: '1h' });
        });

        test('system flag on with depth -1 sends the helper without a leading system message and on a quiet request', async () => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: -1, extendedTTL: false } });

            const noSystem = await sendNanoGpt({ messages: history.slice(1) });
            expect(noSystem.cache_control).toEqual({ enabled: true, ttl: '5m' });
            expect(noSystem.messages).toEqual(history.slice(1));

            const quiet = await sendNanoGpt({ type: 'quiet', cacheScope: 'auxiliary' });
            expect(quiet.cache_control).toEqual({ enabled: true, ttl: '5m' });
            expect(quiet.messages).toEqual(history);
        });

        test('a depth of 0 or more places inline markers and sends the helper with explicitCacheControl', async () => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: true } });

            const withSystem = await sendNanoGpt();
            expect(withSystem.cache_control).toEqual({ enabled: true, ttl: '1h', explicitCacheControl: true });
            expect(withSystem.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
            expect(withSystem.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
            expect(withSystem.messages[3].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

            mergeCachingConfig({ claude: { enableSystemPromptCache: false, extendedTTL: false } });
            const depthOnly = await sendNanoGpt();
            expect(depthOnly.cache_control).toEqual({ enabled: true, ttl: '5m', explicitCacheControl: true });
            expect(depthOnly.messages[0].content).toBe('System');
            expect(depthOnly.messages[3].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });

            const quiet = await sendNanoGpt({ type: 'quiet', cacheScope: 'auxiliary' });
            expect(quiet.cache_control).toEqual({ enabled: true, ttl: '5m', explicitCacheControl: true });
            expect(quiet.messages[3].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        });

        test('a depth with nothing to mark falls back to the helper only when the system flag is on', async () => {
            const unmarkable = [{ role: 'user', content: '   ' }];

            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: 0 } });
            expect((await sendNanoGpt({ messages: unmarkable })).cache_control).toEqual({ enabled: true, ttl: '5m' });

            mergeCachingConfig({ claude: { enableSystemPromptCache: false } });
            expect((await sendNanoGpt({ messages: unmarkable })).cache_control).toBeUndefined();
        });

        test('both flags off sends nothing, and a non-Claude model gets nothing', async () => {
            mergeCachingConfig({ claude: { enableSystemPromptCache: false, cachingAtDepth: -1 } });
            const off = await sendNanoGpt();
            expect(off.cache_control).toBeUndefined();
            expect(off.messages).toEqual(history);

            mergeCachingConfig({ claude: { enableSystemPromptCache: true, cachingAtDepth: 0 } });
            const other = await sendNanoGpt({ model: 'deepseek/deepseek-v3.2' });
            expect(other.cache_control).toBeUndefined();
            expect(other.messages).toEqual(history);
        });
    });

    test('Electron Hub applies Claude cache markers for both bare and vendor-prefixed Claude model IDs', async () => {
        mergeCachingConfig({
            claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: false },
        });

        const res = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.ELECTRONHUB,
            model: 'anthropic/claude-sonnet-4-6',
            stream: false,
            max_tokens: 256,
            messages: [
                { role: 'system', content: 'System' },
                { role: 'user', content: 'Turn 1' },
            ],
        });
        expect(res.status).toBe(200);

        const body = JSON.parse(nodeFetchMock.mock.calls[0][1].body);
        expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(body.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    });

    test('Native Claude marks stable tools before json_schema tool and only sends extended-cache-ttl beta header for 1h TTL', async () => {
        mergeCachingConfig({
            claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: true },
        });

        const res = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.CLAUDE,
            model: 'claude-sonnet-4-6',
            use_sysprompt: true,
            stream: false,
            max_tokens: 256,
            tools: [{ type: 'function', function: { name: 'weather', description: 'Weather', parameters: { type: 'object' } } }],
            tool_choice: 'auto',
            json_schema: { name: 'reply_schema', value: { type: 'object' } },
            messages: [
                { role: 'system', content: 'System prompt' },
                { role: 'system', content: '' },
                { role: 'user', content: 'Hello' },
            ],
        });
        expect(res.status).toBe(200);

        const [, opts] = nodeFetchMock.mock.calls[0];
        const body = JSON.parse(opts.body);
        expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(body.system[1].cache_control).toBeUndefined();
        expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(body.tools[1].cache_control).toBeUndefined();
        expect(opts.headers['anthropic-beta']).toContain('prompt-caching-2024-07-31');
        expect(opts.headers['anthropic-beta']).toContain('extended-cache-ttl-2025-04-11');
    });

    test('Direct OpenAI and Responses attach opaque prompt_cache_key, skip proxy & legacy /completions, and keep mid-chat system messages in Responses input', async () => {
        const directRes = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI,
            model: 'gpt-5',
            chat_id: 'openai-private-chat',
            stream: false,
            max_tokens: 128,
            messages: [{ role: 'user', content: 'Hi' }],
        });
        expect(directRes.status).toBe(200);

        const responsesRes = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
            model: 'gpt-5',
            chat_id: 'openai-private-chat',
            stream: false,
            max_tokens: 128,
            messages: [
                { role: 'system', content: 'Static system prefix' },
                { role: 'user', content: 'Turn 1' },
                { role: 'system', content: 'Depth-0 Author Note' },
                { role: 'user', content: 'Turn 2' },
            ],
        });
        expect(responsesRes.status).toBe(200);

        const proxyRes = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI,
            reverse_proxy: 'https://proxy.example/v1',
            proxy_password: 'proxy-key',
            model: 'gpt-5',
            chat_id: 'openai-private-chat',
            stream: false,
            max_tokens: 128,
            messages: [{ role: 'user', content: 'Hi' }],
        });
        expect(proxyRes.status).toBe(200);

        const legacyCompletionsRes = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI,
            model: 'gpt-3.5-turbo-instruct',
            chat_id: 'openai-private-chat',
            stream: false,
            max_tokens: 64,
            messages: 'Complete this sentence:',
        });
        expect(legacyCompletionsRes.status).toBe(200);

        const [directBody, responsesBody, proxyBody, legacyBody] = nodeFetchMock.mock.calls.map(([, opts]) => JSON.parse(opts.body));
        expect(directBody.prompt_cache_key).toMatch(/^sb_[a-f0-9]{32}$/);
        expect(responsesBody.prompt_cache_key).toBe(directBody.prompt_cache_key);
        expect(directBody.prompt_cache_key.length).toBeLessThanOrEqual(64);
        expect(JSON.stringify(directBody)).not.toContain('openai-private-chat');
        expect(proxyBody.prompt_cache_key).toBeUndefined();
        expect(legacyBody.prompt_cache_key).toBeUndefined();
        // Responses keeps only the leading system message in instructions and preserves mid-chat system injection in input.
        expect(responsesBody.instructions).toBe('Static system prefix');
        expect(responsesBody.input).toEqual([
            { role: 'user', content: 'Turn 1' },
            { role: 'system', content: 'Depth-0 Author Note' },
            { role: 'user', content: 'Turn 2' },
        ]);
    });

    test('OpenAI Responses keeps only the text of mid-chat system and developer items and drops items without text', async () => {
        const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
        const res = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
            model: 'gpt-5',
            stream: false,
            max_tokens: 128,
            messages: [
                { role: 'system', content: [{ type: 'text', text: 'Leading rules' }, image] },
                { role: 'developer', content: 'Leading developer rules' },
                { role: 'user', content: [{ type: 'text', text: 'Look at this' }, image] },
                { role: 'system', content: [{ type: 'text', text: 'Narrator note' }, image] },
                { role: 'system', content: [image] },
                { role: 'developer', content: [image, { type: 'text', text: 'Developer note' }] },
                { role: 'system', content: '' },
                { role: 'assistant', content: 'Reply' },
                { role: 'user', content: 'Turn 2' },
            ],
        });
        expect(res.status).toBe(200);

        const body = JSON.parse(nodeFetchMock.mock.calls[0][1].body);
        expect(body.instructions).toBe('Leading rules\n\nLeading developer rules');
        expect(body.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'Look at this' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
            { role: 'system', content: [{ type: 'input_text', text: 'Narrator note' }] },
            { role: 'developer', content: [{ type: 'input_text', text: 'Developer note' }] },
            { role: 'assistant', content: 'Reply' },
            { role: 'user', content: 'Turn 2' },
        ]);
    });

    test('server-admin /config/chat-completions/save persists YAML flags, parses quoted YAML booleans, and preserves omitted fields', async () => {
        const getRes = await post('/api/server-admin/config/chat-completions/get', {});
        expect(getRes.status).toBe(200);
        const initial = await getRes.json();
        expect(initial.settings.gemini.enableSystemPromptCache).toBe(false);
        expect(initial.envManaged).toEqual([]);

        const saveRes = await post('/api/server-admin/config/chat-completions/save', {
            expectedLastModifiedMs: initial.lastModifiedMs,
            restart: false,
            settings: {
                claude: {
                    enableSystemPromptCache: true,
                    cachingAtDepth: 2,
                    extendedTTL: true,
                    enableAdaptiveThinking: false,
                },
                gemini: {
                    apiVersion: 'v1beta',
                    thoughtSignatures: true,
                    enableSystemPromptCache: true,
                },
            },
        });
        expect(saveRes.status).toBe(200);
        const saved = await saveRes.json();
        expect(saved.settings.claude).toEqual({
            enableSystemPromptCache: true,
            cachingAtDepth: 2,
            extendedTTL: true,
            enableAdaptiveThinking: false,
        });
        expect(saved.settings.gemini).toEqual({
            apiVersion: 'v1beta',
            thoughtSignatures: true,
            enableSystemPromptCache: true,
        });
        expect(saved.envManaged).toEqual([]);
        expect(saved.message).not.toMatch(/restart/i);

        // Re-reading from disk returns persisted YAML values rather than hardcoded defaults.
        const reloadRes = await post('/api/server-admin/config/chat-completions/get', {});
        expect(reloadRes.status).toBe(200);
        const reloaded = await reloadRes.json();
        expect(reloaded.settings).toEqual(saved.settings);

        expect(promptCaching.getPromptCachingConfig()).toEqual({
            claude: {
                enableSystemPromptCache: true,
                cachingAtDepth: 2,
                extendedTTL: true,
                cacheTTL: '1h',
            },
            gemini: {
                enableSystemPromptCache: true,
            },
        });

        // Partial save omitting claude/gemini booleans preserves existing persisted flags rather than resetting them.
        const partialRes = await post('/api/server-admin/config/chat-completions/save', {
            settings: {
                claude: { cachingAtDepth: 4 },
                gemini: {},
            },
        });
        expect(partialRes.status).toBe(200);
        const partial = await partialRes.json();
        expect(partial.settings.claude).toEqual({
            enableSystemPromptCache: true,
            cachingAtDepth: 4,
            extendedTTL: true,
            enableAdaptiveThinking: false,
        });
        expect(partial.settings.gemini).toEqual({
            apiVersion: 'v1beta',
            thoughtSignatures: true,
            enableSystemPromptCache: true,
        });

        // Quoted YAML "false" parses as false (matching util.toBoolean / getConfigValue).
        const quotedYaml = fs.readFileSync(configPath, 'utf8').replace('enableSystemPromptCache: true', 'enableSystemPromptCache: "false"');
        fs.writeFileSync(configPath, quotedYaml);
        const quotedRes = await post('/api/server-admin/config/chat-completions/get', {});
        expect(quotedRes.status).toBe(200);
        const quoted = await quotedRes.json();
        expect(quoted.settings.claude.enableSystemPromptCache).toBe(false);
    });

    test.each([
        ['claude.enableSystemPromptCache', true],
        ['claude.cachingAtDepth', 3],
        ['claude.extendedTTL', true],
        ['claude.enableAdaptiveThinking', true],
        ['gemini.apiVersion', 'v1alpha'],
        ['gemini.thoughtSignatures', false],
        ['gemini.enableSystemPromptCache', true],
    ])('a partial save of %s is live at once and touches no other cached key', async (key, value) => {
        const cachedConfig = getConfig();
        const sentinel = { promptPlaceholder: cachedConfig.promptPlaceholder, listen: cachedConfig.listen };
        cachedConfig.promptPlaceholder = 'only-in-the-cache';
        cachedConfig.listen = 'only-in-the-cache';

        try {
            const res = await post('/api/server-admin/config/chat-completions/save', { settings: _.set({}, key, value) });
            expect(res.status).toBe(200);
            const body = await res.json();

            expect(_.get(body.settings, key)).toEqual(value);
            expect(getConfigValue(key)).toEqual(value);
            expect(getConfig()).toBe(cachedConfig);
            expect(cachedConfig.promptPlaceholder).toBe('only-in-the-cache');
            expect(cachedConfig.listen).toBe('only-in-the-cache');
            expect(yaml.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject(_.set({}, key, value));
        } finally {
            cachedConfig.promptPlaceholder = sentinel.promptPlaceholder;
            cachedConfig.listen = sentinel.listen;
        }
    });

    test('a saved enableAdaptiveThinking applies to the next Claude request without a restart', async () => {
        const send = async () => {
            nodeFetchMock.mockClear();
            const res = await post('/api/backends/chat-completions/generate', {
                chat_completion_source: CHAT_COMPLETION_SOURCES.CLAUDE,
                model: 'claude-sonnet-4-6',
                reasoning_effort: 'medium',
                stream: false,
                max_tokens: 4096,
                messages: [{ role: 'user', content: 'Hello' }],
            });
            expect(res.status).toBe(200);
            return JSON.parse(nodeFetchMock.mock.calls[0][1].body).thinking;
        };

        await post('/api/server-admin/config/chat-completions/save', { settings: { claude: { enableAdaptiveThinking: true } } });
        expect(await send()).toEqual({ type: 'adaptive' });

        await post('/api/server-admin/config/chat-completions/save', { settings: { claude: { enableAdaptiveThinking: false } } });
        expect(await send()).toEqual({ type: 'enabled', budget_tokens: 1024 });
    });

    test('saved Gemini apiVersion and thoughtSignatures apply to the next Google AI Studio request', async () => {
        const send = async () => {
            nodeFetchMock.mockClear();
            const res = await post('/api/backends/chat-completions/generate', {
                chat_completion_source: CHAT_COMPLETION_SOURCES.MAKERSUITE,
                model: 'gemini-3-pro-preview',
                stream: false,
                max_tokens: 256,
                messages: [
                    { role: 'user', content: 'Hello' },
                    { role: 'assistant', content: 'Hi there', signature: 'stored-signature' },
                    { role: 'user', content: 'Again' },
                ],
            });
            expect(res.status).toBe(200);
            const [url, options] = nodeFetchMock.mock.calls[0];
            const modelTurn = JSON.parse(options.body).contents.find(content => content.role === 'model');
            return { url: String(url), signature: modelTurn.parts[0].thoughtSignature };
        };

        await post('/api/server-admin/config/chat-completions/save', { settings: { gemini: { apiVersion: 'v1beta', thoughtSignatures: true } } });
        const before = await send();
        expect(before.url).toContain('/v1beta/models/gemini-3-pro-preview:generateContent');
        expect(before.signature).toBe('stored-signature');

        await post('/api/server-admin/config/chat-completions/save', { settings: { gemini: { apiVersion: 'v1alpha', thoughtSignatures: false } } });
        const after = await send();
        expect(after.url).toContain('/v1alpha/models/gemini-3-pro-preview:generateContent');
        expect(after.signature).toBeUndefined();
    });

    test('envManaged lists only mirrored keys with an environment variable, and settings report their effective value', async () => {
        process.env.SILLYTAVERN_CLAUDE_EXTENDEDTTL = 'true';
        process.env.SILLYTAVERN_CLAUDE_CACHINGATDEPTH = '2';
        process.env.SILLYTAVERN_GEMINI_APIVERSION = 'v1alpha';
        process.env.SILLYTAVERN_CLAUDE_ENABLEADAPTIVETHINKING = 'false';
        process.env.SILLYTAVERN_PROMPTPLACEHOLDER = 'env-secret-value';

        try {
            const getRes = await post('/api/server-admin/config/chat-completions/get', {});
            const got = await getRes.json();
            expect(got.envManaged.sort()).toEqual([
                'claude.cachingAtDepth',
                'claude.enableAdaptiveThinking',
                'claude.extendedTTL',
                'gemini.apiVersion',
            ]);
            expect(got.settings.claude).toEqual({
                enableSystemPromptCache: false,
                cachingAtDepth: 2,
                extendedTTL: true,
                enableAdaptiveThinking: false,
            });
            expect(got.settings.gemini.apiVersion).toBe('v1alpha');
            expect(JSON.stringify(got)).not.toContain('env-secret-value');

            // A save writes the file but cannot change what the environment variable decides.
            const saveRes = await post('/api/server-admin/config/chat-completions/save', {
                settings: { claude: { extendedTTL: false, enableSystemPromptCache: true } },
            });
            const saved = await saveRes.json();
            expect(saved.envManaged.sort()).toEqual(got.envManaged.sort());
            expect(saved.settings.claude.extendedTTL).toBe(true);
            expect(saved.settings.claude.enableSystemPromptCache).toBe(true);
            expect(yaml.parse(fs.readFileSync(configPath, 'utf8')).claude.extendedTTL).toBe(false);
            expect(promptCaching.getPromptCachingConfig().claude.cacheTTL).toBe('1h');
            expect(JSON.stringify(saved)).not.toContain('env-secret-value');
        } finally {
            delete process.env.SILLYTAVERN_PROMPTPLACEHOLDER;
        }
    });

    const describeWithDirectoryModes = process.platform !== 'win32' && process.getuid?.() !== 0 ? describe : describe.skip;
    describeWithDirectoryModes('a failed config.yaml write', () => {
        test('leaves the cached config and the reply untouched', async () => {
            const configDirectory = path.dirname(configPath);
            const yamlBefore = fs.readFileSync(configPath, 'utf8');
            const cachedBefore = structuredClone({ claude: getConfig().claude, gemini: getConfig().gemini });

            fs.chmodSync(configDirectory, 0o555);
            try {
                const res = await post('/api/server-admin/config/chat-completions/save', {
                    settings: { claude: { enableSystemPromptCache: true, cachingAtDepth: 5 }, gemini: { apiVersion: 'v9' } },
                });
                expect(res.status).toBeGreaterThanOrEqual(500);
                expect((await res.json()).error).toBeTruthy();

                const rawRes = await post('/api/server-admin/config/save', {
                    content: yamlBefore.replace('enableSystemPromptCache: false', 'enableSystemPromptCache: true'),
                });
                expect(rawRes.status).toBeGreaterThanOrEqual(500);
            } finally {
                fs.chmodSync(configDirectory, 0o755);
            }

            expect(fs.readFileSync(configPath, 'utf8')).toBe(yamlBefore);
            expect({ claude: getConfig().claude, gemini: getConfig().gemini }).toEqual(cachedBefore);
        });
    });

    test('the raw /config/save route applies the mirrored keys of the saved document at once', async () => {
        const document = yaml.parseDocument(fs.readFileSync(configPath, 'utf8'));
        document.setIn(['claude', 'enableSystemPromptCache'], true);
        document.setIn(['claude', 'cachingAtDepth'], 1);
        document.setIn(['gemini', 'apiVersion'], 'v1alpha');

        const res = await post('/api/server-admin/config/save', { content: document.toString() });
        expect(res.status).toBe(200);

        expect(getConfigValue('claude.enableSystemPromptCache', false, 'boolean')).toBe(true);
        expect(getConfigValue('claude.cachingAtDepth', -1, 'number')).toBe(1);
        expect(getConfigValue('gemini.apiVersion', 'v1beta')).toBe('v1alpha');
    });
});

describe('Chat Completion preset compatibility', () => {
    const openaiSource = fs.readFileSync(fileURLToPath(new URL('../public/scripts/openai.js', import.meta.url)), 'utf8');

    test('keeps server-side caching flags out of Chat Completion preset serialization (SillyTavern preset compatibility)', () => {
        const settingsMapMatch = openaiSource.match(/export const settingsToUpdate = \{[\s\S]*?\n\};/);
        expect(settingsMapMatch).not.toBeNull();
        const settingsMapSource = settingsMapMatch[0];
        expect(settingsMapSource).not.toMatch(/sb-config-|enableSystemPromptCache|cachingAtDepth|extendedTTL|prompt_caching/i);
    });
});
