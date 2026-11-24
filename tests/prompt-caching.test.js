import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';

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

describe('Prompt caching primitives and edge cases', () => {
    afterEach(() => {
        promptCaching.resetPromptCachingRuntimeConfig();
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

    test('cachingAtDepthForClaude skips empty arrays, empty text blocks, and thinking blocks without crashing', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'Turn 1' }] },
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal' }, { type: 'text', text: '' }] },
            { role: 'user', content: [{ type: 'text', text: 'Turn 2' }, { type: 'text', text: '   ' }] },
            { role: 'assistant', content: [] },
            { role: 'user', content: [{ type: 'text', text: '' }] },
        ];

        expect(() => promptConverters.cachingAtDepthForClaude(messages, 0, '5m')).not.toThrow();

        // Depth 0 (index 4) has only empty text and index 3 has [], so it falls back to index 2's non-empty text part.
        expect(messages[4].content[0].cache_control).toBeUndefined();
        expect(messages[2].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(messages[2].content[1].cache_control).toBeUndefined();
        // Depth 2 (index 2) was already marked; thinking/empty at index 1 never receive cache_control.
        expect(messages[1].content[0].cache_control).toBeUndefined();
        expect(messages[1].content[1].cache_control).toBeUndefined();
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

        // Empty user turn and null tool-call turn must not be corrupted with empty text cache_control blocks.
        expect(messages[4].content).toBe('');
        expect(messages[3].content).toBeNull();
        // Falls back to index 2's text part (never the image_url part).
        expect(messages[2].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(messages[2].content[1].cache_control).toBeUndefined();
        // Leading system and developer messages stay untouched.
        expect(messages[0].content).toBe('System');
        expect(messages[1].content).toBe('Developer rules');
    });

    test('applyClaudeRequestCaching enforces Anthropic 4-breakpoint maximum and skips empty system blocks', () => {
        const systemPrompt = [
            { type: 'text', text: 'Real system instructions' },
            { type: 'text', text: '' },
        ];
        const tools = [
            { name: 'search', description: 'Search', input_schema: { type: 'object' } },
        ];
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'Pre-marked', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
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
                gemini: { enableSystemPromptCache: false, cachingAtDepth: -1 },
            },
        });

        expect(total).toBe(4);
        expect(promptCaching.countCacheControlMarkers({ systemPrompt, tools, messages })).toBe(4);
        expect(systemPrompt[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(systemPrompt[1].cache_control).toBeUndefined();
        expect(tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        // Only 1 budget slot remained after pre-marked (1) + system (1) + tool (1) = 3 -> Turn 3 gets marked, Turn 2 skipped.
        expect(messages[4].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
        expect(messages[2].content[0].cache_control).toBeUndefined();
        // 5m TTL should not send the 1h extended-cache-ttl beta header.
        expect(betaHeaders).toEqual(['prompt-caching-2024-07-31']);
    });

    test('model matchers detect tilde latest aliases and routing suffixes', () => {
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

        expect(promptCaching.stripOpenRouterModelSuffix('google/gemini-4-neon:online')).toBe('google/gemini-4-neon');
        expect(promptCaching.stripOpenRouterModelSuffix('google/gemini-4-neon')).toBe('google/gemini-4-neon');
    });

    test('isOpenRouterModelCacheable caches catalog with TTL, deduplicates parallel calls, handles suffixes, and retries after failure', async () => {
        let nowMs = 1_000_000;
        const mockFetch = jest.fn();

        // First call fails transiently -> returns false and does not cache the failure.
        mockFetch.mockRejectedValueOnce(new Error('network blip'));
        expect(await promptCaching.isOpenRouterModelCacheable('google/gemini-4-neon', { fetchImpl: mockFetch, now: () => nowMs })).toBe(false);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Next parallel calls share one fetch and cache both positive and negative results.
        mockFetch.mockImplementationOnce(async () => jsonResponse({
            data: [
                { id: 'google/gemini-4-neon', pricing: { input_cache_write: '0.0000000833' } },
                { id: 'google/gemini-3.5-flash', pricing: { input_cache_write: '0.0000000833' } },
                { id: 'google/gemini-3.5-flash:batch', pricing: { input_cache_read: '0.000000075' } },
                { id: 'google/gemini-nano-banana-2.1', pricing: { prompt: '0.0000015' } },
            ],
        }));

        const results = await Promise.all([
            promptCaching.isOpenRouterModelCacheable('google/gemini-4-neon', { fetchImpl: mockFetch, now: () => nowMs }),
            promptCaching.isOpenRouterModelCacheable('google/gemini-4-neon:online', { fetchImpl: mockFetch, now: () => nowMs }),
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

describe('Chat completions backend prompt caching integration', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let configPath;
    const tempDirs = [];

    beforeAll(async () => {
        configPath = initialConfigPath;

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
        ]) {
            secretManager.writeSecret(key, 'test-provider-key');
        }

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = {
                profile: { handle: 'admin', admin: true },
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
        promptCaching.resetPromptCachingRuntimeConfig();
        promptCaching.resetOpenRouterCacheableModelsCache();
        nodeFetchMock.mockReset();
        nodeFetchMock.mockImplementation(async (url) => {
            if (String(url).endsWith('/models')) {
                return jsonResponse({
                    data: [
                        { id: 'google/gemini-4-neon', pricing: { input_cache_write: '0.0000000833', input_cache_read: '0.00000015' } },
                        { id: '~google/gemini-pro-latest', pricing: { input_cache_write: '0.0000001875', input_cache_read: '0.0000001' } },
                    ],
                });
            }
            if (String(url).endsWith('/messages')) {
                return jsonResponse({ content: [{ type: 'text', text: 'ok' }] });
            }
            if (String(url).endsWith('/responses')) {
                return jsonResponse({
                    id: 'resp_1',
                    model: 'gpt-5',
                    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
                });
            }
            return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
        });
    });

    afterAll(async () => {
        promptCaching.resetPromptCachingRuntimeConfig();
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

    function post(route, body) {
        return fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

    test('OpenRouter omits session_id on quiet and auxiliary requests', async () => {
        for (const overrides of [{ type: 'quiet' }, { type: 'normal', cacheScope: 'auxiliary' }]) {
            const res = await post('/api/backends/chat-completions/generate', {
                chat_completion_source: CHAT_COMPLETION_SOURCES.OPENROUTER,
                model: 'google/gemini-4-neon',
                chat_id: 'main-chat-id',
                stream: false,
                max_tokens: 128,
                messages: [{ role: 'user', content: 'Summarize' }],
                ...overrides,
            });
            expect(res.status).toBe(200);
        }

        const bodies = nodeFetchMock.mock.calls.map(([, opts]) => JSON.parse(opts.body));
        expect(bodies[0].session_id).toBeUndefined();
        expect(bodies[1].session_id).toBeUndefined();
    });

    test('OpenRouter Gemini 4 with suffix marks last leading system message and single depth breakpoint without TTL', async () => {
        promptCaching.setPromptCachingRuntimeConfig({
            gemini: { enableSystemPromptCache: true, cachingAtDepth: 0 },
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
        // System marker lands on last leading system message (index 1) without TTL.
        expect(body.messages[0].content).toBe('Main Prompt');
        expect(body.messages[1].content).toEqual([
            { type: 'text', text: 'Character Card + Lore', cache_control: { type: 'ephemeral' } },
        ]);
        // Single depth breakpoint at depth 0 (index 4) without TTL; depth + 2 (index 2) is NOT marked for Gemini.
        expect(body.messages[2].content).toBe('Turn 1');
        expect(body.messages[4].content).toEqual([
            { type: 'text', text: 'Turn 2', cache_control: { type: 'ephemeral' } },
        ]);
    });

    test('OpenRouter ~anthropic/claude-sonnet-latest receives Claude system and depth markers with TTL', async () => {
        promptCaching.setPromptCachingRuntimeConfig({
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

    test('NanoGPT applies both top-level cache_control and inline Claude depth markers', async () => {
        promptCaching.setPromptCachingRuntimeConfig({
            claude: { enableSystemPromptCache: true, cachingAtDepth: 0, extendedTTL: true },
        });

        const res = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: CHAT_COMPLETION_SOURCES.NANOGPT,
            model: 'anthropic/claude-sonnet-4-6',
            stream: false,
            max_tokens: 256,
            messages: [
                { role: 'system', content: 'System' },
                { role: 'user', content: 'Turn 1' },
                { role: 'assistant', content: 'Reply 1' },
                { role: 'user', content: 'Turn 2' },
            ],
        });
        expect(res.status).toBe(200);

        const body = JSON.parse(nodeFetchMock.mock.calls[0][1].body);
        expect(body.cache_control).toEqual({ enabled: true, ttl: '1h' });
        expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(body.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(body.messages[3].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    });

    test('Electron Hub applies Claude cache markers for both bare and vendor-prefixed Claude model IDs', async () => {
        promptCaching.setPromptCachingRuntimeConfig({
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
        promptCaching.setPromptCachingRuntimeConfig({
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

    test('Direct OpenAI and OpenAI Responses attach opaque prompt_cache_key and skip it when a reverse proxy is configured', async () => {
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
            messages: [{ role: 'user', content: 'Hi' }],
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

        const [directBody, responsesBody, proxyBody] = nodeFetchMock.mock.calls.map(([, opts]) => JSON.parse(opts.body));
        expect(directBody.prompt_cache_key).toMatch(/^sb_[a-f0-9]{32}$/);
        expect(responsesBody.prompt_cache_key).toBe(directBody.prompt_cache_key);
        expect(directBody.prompt_cache_key.length).toBeLessThanOrEqual(64);
        expect(JSON.stringify(directBody)).not.toContain('openai-private-chat');
        expect(proxyBody.prompt_cache_key).toBeUndefined();
    });

    test('server-admin /config/chat-completions/save persists gemini.cachingAtDepth and updates runtime caching immediately', async () => {
        const getRes = await post('/api/server-admin/config/chat-completions/get', {});
        expect(getRes.status).toBe(200);
        const initial = await getRes.json();
        expect(initial.settings.gemini.cachingAtDepth).toBe(-1);

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
                    cachingAtDepth: 0,
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
            cachingAtDepth: 0,
        });

        // Re-reading from disk returns the persisted YAML values rather than hardcoded defaults.
        const reloadRes = await post('/api/server-admin/config/chat-completions/get', {});
        expect(reloadRes.status).toBe(200);
        const reloaded = await reloadRes.json();
        expect(reloaded.settings).toEqual(saved.settings);

        // Runtime cache config is updated immediately without a server restart.
        expect(promptCaching.getPromptCachingConfig()).toEqual({
            claude: {
                enableSystemPromptCache: true,
                cachingAtDepth: 2,
                extendedTTL: true,
                cacheTTL: '1h',
            },
            gemini: {
                enableSystemPromptCache: true,
                cachingAtDepth: 0,
            },
        });

        // Saving a payload that omits gemini.cachingAtDepth preserves the existing saved value.
        const preserveRes = await post('/api/server-admin/config/chat-completions/save', {
            expectedLastModifiedMs: saved.lastModifiedMs,
            restart: false,
            settings: {
                claude: saved.settings.claude,
                gemini: {
                    apiVersion: 'v1beta',
                    thoughtSignatures: true,
                    enableSystemPromptCache: true,
                },
            },
        });
        expect(preserveRes.status).toBe(200);
        const preserved = await preserveRes.json();
        expect(preserved.settings.gemini.cachingAtDepth).toBe(0);
    });
});

describe('Frontend prompt caching UI and chat_id wiring', () => {
    const openaiSource = fs.readFileSync(fileURLToPath(new URL('../public/scripts/openai.js', import.meta.url)), 'utf8');

    test('exposes Claude & Gemini server config controls for OpenRouter and router sources', () => {
        expect(openaiSource).toContain('data-source="claude,openrouter,makersuite,vertexai,gemini_interactions,nanogpt,electronhub,linkapi"');
        expect(openaiSource).toContain('data-source="claude,openrouter,nanogpt,electronhub,linkapi"');
        expect(openaiSource).toContain('data-source="makersuite,vertexai,gemini_interactions,openrouter,linkapi"');
        expect(openaiSource).toContain('id="sb-config-gemini-caching-depth"');
    });

    test('forwards chat_id for OpenRouter, OpenAI, OpenAI Responses, and Fireworks main turns', () => {
        expect(openaiSource).toMatch(/chat_completion_sources\.OPENROUTER[\s\S]*?chat_completion_sources\.OPENAI[\s\S]*?chat_completion_sources\.OPENAI_RESPONSES[\s\S]*?generate_data\.chat_id = getCurrentChatId\(\)/);
    });
});
