import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    CHAT_COMPLETION_SOURCES,
    MINIMAX_ENDPOINT,
    POLLINATIONS_ENDPOINT,
    SILICONFLOW_ENDPOINT,
    ZAI_ENDPOINT,
} from '../src/constants.js';
import {
    createLoopbackFetch,
    ensureDefaultConfigLoaded,
    startBackendApp,
    startFakeUpstream,
    testSecretFor,
} from './util/provider-contract-harness.js';

ensureDefaultConfigLoaded();

const actualNodeFetchModule = await import('node-fetch');
let activeUpstreamPort = null;
const loopbackFetch = createLoopbackFetch(actualNodeFetchModule.default, () => activeUpstreamPort);

await jest.unstable_mockModule('node-fetch', () => ({
    ...actualNodeFetchModule,
    default: loopbackFetch,
}));

const { SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');

const GENERATE_ROUTE = '/api/backends/chat-completions/generate';
const STATUS_ROUTE = '/api/backends/chat-completions/status';
const USER_PROMPT = 'Hello from contract matrix';

const OPENAI_STREAM_CHUNKS = [
    'data: {"id":"cmpl-s1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"chunk-1-"}}]}\n\n',
    'data: {"id":"cmpl-s1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"chunk-2"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
];

const CLAUDE_STREAM_CHUNKS = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunk-1-"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunk-2"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const GOOGLE_STREAM_CHUNKS = [
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"chunk-1-"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"chunk-2"}]},"finishReason":"STOP"}]}\n\n',
];

const COHERE_STREAM_CHUNKS = [
    'event: content-delta\ndata: {"type":"content-delta","index":0,"delta":{"message":{"content":{"text":"chunk-1-"}}}}\n\n',
    'event: content-delta\ndata: {"type":"content-delta","index":0,"delta":{"message":{"content":{"text":"chunk-2"}}}}\n\n',
    'event: message-end\ndata: {"type":"message-end"}\n\n',
];

const RESPONSES_STREAM_CHUNKS = [
    'data: {"type":"response.output_text.delta","response_id":"resp-s1","delta":"chunk-1-"}\n\n',
    'data: {"type":"response.output_text.delta","response_id":"resp-s1","delta":"chunk-2"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp-s1"}}\n\n',
];

const INTERACTIONS_STREAM_CHUNKS = [
    'data: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"chunk-1-"}}\n\n',
    'data: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"chunk-2"}}\n\n',
    'data: {"event_type":"interaction.completed","interaction":{"id":"int-s1","status":"completed"}}\n\n',
];

function openAiReply(source) {
    return {
        id: `cmpl-${source}`,
        object: 'chat.completion',
        choices: [{
            index: 0,
            message: { role: 'assistant', content: `reply-${source}` },
            finish_reason: 'stop',
        }],
    };
}

function assertBearerAuth(req, secret) {
    expect(req.headers.authorization).toBe(`Bearer ${secret}`);
}

function assertOpenAiBody(body, { stream, model }) {
    expect(body.model).toBe(model);
    expect(body.stream).toBe(stream);
    expect(body.max_tokens).toBe(64);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: USER_PROMPT });
}

function assertOpenAiClientReply(response, source) {
    expect(response.status).toBe(200);
    expect(response.json?.choices?.[0]?.message?.content).toBe(`reply-${source}`);
}

/**
 * Contract table for every active Chat Completion source.
 * Disabled sources are listed separately in DISABLED_SOURCES so the completeness check covers 100% of CHAT_COMPLETION_SOURCES.
 */
const ACTIVE_CHAT_CONTRACTS = [
    {
        source: CHAT_COMPLETION_SOURCES.OPENAI,
        model: 'gpt-4o-mini',
        secretKey: SECRET_KEYS.OPENAI,
        expectedOrigin: 'https://api.openai.com',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('openai'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'openai'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.CLAUDE,
        model: 'claude-3-5-sonnet-20241022',
        secretKey: SECRET_KEYS.CLAUDE,
        expectedOrigin: 'https://api.anthropic.com',
        expectedPath: () => '/v1/messages',
        assertAuth: (req, secret) => {
            expect(req.headers['x-api-key']).toBe(secret);
            expect(req.headers['anthropic-version']).toBe('2023-06-01');
        },
        assertBody: (body, { stream, model }) => {
            expect(body.model).toBe(model);
            expect(body.stream).toBe(stream);
            expect(body.max_tokens).toBe(64);
            expect(Array.isArray(body.messages)).toBe(true);
            expect(body.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: USER_PROMPT }] });
        },
        nonStreamReply: {
            id: 'msg-claude',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'reply-claude' }],
        },
        assertNonStreamReply: (res) => {
            expect(res.status).toBe(200);
            expect(res.json?.choices?.[0]?.message?.content).toBe('reply-claude');
            expect(res.json?.content).toEqual([{ type: 'text', text: 'reply-claude' }]);
        },
        streamChunks: CLAUDE_STREAM_CHUNKS,
        nonStreamErrorStyle: 'claude',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.OPENROUTER,
        model: 'openai/gpt-4o-mini',
        secretKey: SECRET_KEYS.OPENROUTER,
        expectedOrigin: 'https://openrouter.ai',
        expectedPath: () => '/api/v1/chat/completions',
        assertAuth: (req, secret) => {
            assertBearerAuth(req, secret);
            expect(req.headers['http-referer']).toBe('https://sillytavern.app');
            expect(req.headers['x-title']).toBe('SillyTavern');
        },
        assertBody: (body, ctx) => {
            assertOpenAiBody(body, ctx);
            expect(body.reasoning).toEqual({ exclude: true });
        },
        nonStreamReply: openAiReply('openrouter'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'openrouter'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.AI21,
        model: 'jamba-1.5-mini',
        secretKey: SECRET_KEYS.AI21,
        expectedOrigin: 'https://api.ai21.com',
        expectedPath: () => '/studio/v1/chat/completions',
        assertAuth: (req, secret) => {
            assertBearerAuth(req, secret);
            expect(req.headers.accept).toBe('application/json');
        },
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('ai21'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'ai21'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.MAKERSUITE,
        model: 'gemini-2.5-flash',
        secretKey: SECRET_KEYS.MAKERSUITE,
        expectedOrigin: 'https://generativelanguage.googleapis.com',
        expectedPath: (stream) => `/v1beta/models/gemini-2.5-flash:${stream ? 'streamGenerateContent' : 'generateContent'}`,
        assertAuth: (req, secret, { stream }) => {
            expect(req.searchParams.get('key')).toBe(secret);
            expect(req.searchParams.get('alt')).toBe(stream ? 'sse' : null);
        },
        assertBody: (body) => {
            expect(body.contents).toEqual([{ role: 'user', parts: [{ text: USER_PROMPT }] }]);
            expect(body.generationConfig?.maxOutputTokens).toBe(64);
            expect(Array.isArray(body.safetySettings)).toBe(true);
        },
        nonStreamReply: {
            candidates: [{ content: { role: 'model', parts: [{ text: 'reply-makersuite' }] }, finishReason: 'STOP' }],
        },
        assertNonStreamReply: (res) => {
            expect(res.status).toBe(200);
            expect(res.json?.choices?.[0]?.message?.content).toBe('reply-makersuite');
        },
        streamChunks: GOOGLE_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.GEMINI_INTERACTIONS,
        model: 'gemini-3.8-flash',
        secretKey: SECRET_KEYS.MAKERSUITE,
        expectedOrigin: 'https://generativelanguage.googleapis.com',
        expectedPath: () => '/v1beta/interactions',
        assertAuth: (req, secret) => {
            expect(req.headers['x-goog-api-key']).toBe(secret);
        },
        assertBody: (body, { stream, model }) => {
            expect(body.model).toBe(model);
            expect(body.store).toBe(false);
            expect(body.stream).toBe(stream);
            expect(body.generation_config?.max_output_tokens).toBe(64);
            expect(body.input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: USER_PROMPT }] }]);
        },
        nonStreamReply: {
            id: 'int-1',
            model: 'gemini-3.8-flash',
            status: 'completed',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'reply-gemini_interactions' }] }],
        },
        assertNonStreamReply: (res) => {
            expect(res.status).toBe(200);
            expect(res.json?.choices?.[0]?.message?.content).toBe('reply-gemini_interactions');
        },
        streamChunks: INTERACTIONS_STREAM_CHUNKS,
        streamTransform: 'chat-sse',
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'custom-stream-no-upstream-header',
    },
    {
        source: CHAT_COMPLETION_SOURCES.VERTEXAI,
        model: 'gemini-2.5-flash',
        secretKey: SECRET_KEYS.VERTEXAI,
        expectedOrigin: 'https://us-central1-aiplatform.googleapis.com',
        expectedPath: (stream) => `/v1/publishers/google/models/gemini-2.5-flash:${stream ? 'streamGenerateContent' : 'generateContent'}`,
        assertAuth: (req, secret, { stream }) => {
            expect(req.searchParams.get('key')).toBe(secret);
            expect(req.searchParams.get('alt')).toBe(stream ? 'sse' : null);
        },
        assertBody: (body) => {
            expect(body.contents).toEqual([{ role: 'user', parts: [{ text: USER_PROMPT }] }]);
            expect(body.generationConfig?.maxOutputTokens).toBe(64);
            expect(body.safetySettings.length).toBeGreaterThan(5);
        },
        nonStreamReply: {
            candidates: [{ content: { role: 'model', parts: [{ text: 'reply-vertexai' }] }, finishReason: 'STOP' }],
        },
        assertNonStreamReply: (res) => {
            expect(res.status).toBe(200);
            expect(res.json?.choices?.[0]?.message?.content).toBe('reply-vertexai');
        },
        streamChunks: GOOGLE_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.MISTRALAI,
        model: 'mistral-small-latest',
        secretKey: SECRET_KEYS.MISTRALAI,
        expectedOrigin: 'https://api.mistral.ai',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('mistralai'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'mistralai'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.CUSTOM,
        model: 'custom-contract-model',
        secretKey: SECRET_KEYS.CUSTOM,
        directLoopback: true,
        buildExtraBody: (upstreamUrl) => ({ custom_url: `${upstreamUrl}/v1` }),
        expectedOrigin: null,
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: (body, ctx) => {
            assertOpenAiBody(body, ctx);
            // Loopback custom endpoints default to auxiliary cache scope, which opts out of llama.cpp prompt caching.
            expect(body.cache_prompt).toBe(false);
        },
        nonStreamReply: openAiReply('custom'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'custom'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.COHERE,
        model: 'command-r-plus',
        secretKey: SECRET_KEYS.COHERE,
        expectedOrigin: 'https://api.cohere.ai',
        expectedPath: () => '/v2/chat',
        assertAuth: assertBearerAuth,
        assertBody: (body, { stream, model }) => {
            expect(body.model).toBe(model);
            expect(body.stream).toBe(stream);
            expect(body.max_tokens).toBe(64);
            expect(Array.isArray(body.messages)).toBe(true);
            expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: USER_PROMPT });
        },
        nonStreamReply: {
            id: 'coh-1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'reply-cohere' }] },
        },
        assertNonStreamReply: (res) => {
            expect(res.status).toBe(200);
            expect(res.json?.message?.content?.[0]?.text).toBe('reply-cohere');
        },
        streamChunks: COHERE_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.PERPLEXITY,
        model: 'sonar',
        secretKey: SECRET_KEYS.PERPLEXITY,
        expectedOrigin: 'https://api.perplexity.ai',
        expectedPath: () => '/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('perplexity'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'perplexity'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.GROQ,
        model: 'llama-3.3-70b-versatile',
        secretKey: SECRET_KEYS.GROQ,
        expectedOrigin: 'https://api.groq.com',
        expectedPath: () => '/openai/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('groq'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'groq'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.CHUTES,
        model: 'deepseek-ai/DeepSeek-V3',
        secretKey: SECRET_KEYS.CHUTES,
        expectedOrigin: 'https://llm.chutes.ai',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('chutes'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'chutes'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.ELECTRONHUB,
        model: 'gpt-4o-mini',
        secretKey: SECRET_KEYS.ELECTRONHUB,
        expectedOrigin: 'https://api.electronhub.ai',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('electronhub'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'electronhub'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.NANOGPT,
        model: 'gpt-4o-mini',
        secretKey: SECRET_KEYS.NANOGPT,
        expectedOrigin: 'https://nano-gpt.com',
        expectedPath: () => '/api/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('nanogpt'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'nanogpt'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.DEEPSEEK,
        model: 'deepseek-chat',
        secretKey: SECRET_KEYS.DEEPSEEK,
        expectedOrigin: 'https://api.deepseek.com',
        expectedPath: () => '/beta/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('deepseek'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'deepseek'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.AIMLAPI,
        model: 'gpt-4o-mini',
        secretKey: SECRET_KEYS.AIMLAPI,
        expectedOrigin: 'https://api.aimlapi.com',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: (req, secret) => {
            assertBearerAuth(req, secret);
            expect(req.headers['http-referer']).toBe('https://sillytavern.app');
            expect(req.headers['x-title']).toBe('SillyTavern');
        },
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('aimlapi'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'aimlapi'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.XAI,
        model: 'grok-3',
        secretKey: SECRET_KEYS.XAI,
        expectedOrigin: 'https://api.x.ai',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('xai'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'xai'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.POLLINATIONS,
        model: 'openai',
        secretKey: SECRET_KEYS.POLLINATIONS,
        expectedOrigin: 'https://gen.pollinations.ai',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: (body, ctx) => {
            assertOpenAiBody(body, ctx);
            expect(typeof body.seed).toBe('number');
        },
        nonStreamReply: openAiReply('pollinations'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'pollinations'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.MOONSHOT,
        model: 'kimi-k2-0711-preview',
        secretKey: SECRET_KEYS.MOONSHOT,
        expectedOrigin: 'https://api.moonshot.ai',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: (body, ctx) => {
            assertOpenAiBody(body, ctx);
            expect(body.thinking).toEqual({ type: 'disabled' });
        },
        nonStreamReply: openAiReply('moonshot'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'moonshot'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.FIREWORKS,
        model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
        secretKey: SECRET_KEYS.FIREWORKS,
        expectedOrigin: 'https://api.fireworks.ai',
        expectedPath: () => '/inference/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('fireworks'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'fireworks'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
        model: 'gpt-4o',
        secretKey: SECRET_KEYS.AZURE_OPENAI,
        directLoopback: true,
        buildExtraBody: (upstreamUrl) => ({
            azure_base_url: upstreamUrl,
            azure_deployment_name: 'contract-dep',
            azure_api_version: '2025-04-01-preview',
        }),
        expectedOrigin: null,
        expectedPath: () => '/openai/deployments/contract-dep/chat/completions',
        assertAuth: (req, secret) => {
            expect(req.headers['api-key']).toBe(secret);
            expect(req.searchParams.get('api-version')).toBe('2025-04-01-preview');
        },
        assertBody: (body, { stream }) => {
            expect(body).not.toHaveProperty('model');
            expect(body.stream).toBe(stream);
            expect(body.max_tokens).toBe(64);
            expect(body.messages).toEqual([{ role: 'user', content: USER_PROMPT }]);
        },
        nonStreamReply: openAiReply('azure_openai'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'azure_openai'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'azure-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
        model: 'gpt-4o-mini',
        secretKey: SECRET_KEYS.OPENAI,
        expectedOrigin: 'https://api.openai.com',
        expectedPath: () => '/v1/responses',
        assertAuth: assertBearerAuth,
        assertBody: (body, { stream, model }) => {
            expect(body.model).toBe(model);
            expect(body.stream).toBe(stream);
            expect(body.store).toBe(false);
            expect(body.max_output_tokens).toBe(64);
            expect(body.input).toEqual([{ role: 'user', content: USER_PROMPT }]);
        },
        nonStreamReply: {
            id: 'resp-1',
            model: 'gpt-4o-mini',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'reply-openai_responses' }] }],
        },
        assertNonStreamReply: (res) => {
            expect(res.status).toBe(200);
            expect(res.json?.choices?.[0]?.message?.content).toBe('reply-openai_responses');
        },
        streamChunks: RESPONSES_STREAM_CHUNKS,
        streamTransform: 'chat-sse',
        nonStreamErrorStyle: 'passthrough-status',
        streamErrorStyle: 'custom-stream-no-upstream-header',
    },
    {
        source: CHAT_COMPLETION_SOURCES.ZAI,
        model: 'glm-4.5',
        secretKey: SECRET_KEYS.ZAI,
        expectedOrigin: 'https://api.z.ai',
        expectedPath: () => '/api/paas/v4/chat/completions',
        assertAuth: (req, secret) => {
            assertBearerAuth(req, secret);
            expect(req.headers['accept-language']).toBe('en-US,en');
        },
        assertBody: (body, ctx) => {
            assertOpenAiBody(body, ctx);
            expect(body.thinking).toEqual({ type: 'disabled' });
        },
        nonStreamReply: openAiReply('zai'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'zai'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.SILICONFLOW,
        model: 'Qwen/Qwen2.5-7B-Instruct',
        secretKey: SECRET_KEYS.SILICONFLOW,
        expectedOrigin: 'https://api.siliconflow.com',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('siliconflow'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'siliconflow'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.MINIMAX,
        model: 'MiniMax-M1',
        secretKey: SECRET_KEYS.MINIMAX,
        expectedOrigin: 'https://api.minimax.io',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('minimax'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'minimax'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'wrap-500',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.WORKERS_AI,
        model: '@cf/meta/llama-3.1-8b-instruct',
        secretKey: SECRET_KEYS.WORKERS_AI,
        buildExtraBody: () => ({ workers_ai_account_id: 'acct-contract-42' }),
        expectedOrigin: 'https://api.cloudflare.com',
        expectedPath: () => '/client/v4/accounts/acct-contract-42/ai/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('workers_ai'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'workers_ai'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.LINKAPI,
        model: 'gpt-4o-mini',
        secretKey: SECRET_KEYS.LINKAPI,
        expectedOrigin: 'https://linkapi.ai',
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: assertOpenAiBody,
        nonStreamReply: openAiReply('linkapi'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'linkapi'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
    },
    {
        source: CHAT_COMPLETION_SOURCES.KOBOLDCPP,
        model: 'koboldcpp/Llama-3.2-1B-Instruct-Q8_0',
        secretKey: SECRET_KEYS.KOBOLDCPP,
        directLoopback: true,
        buildExtraBody: (upstreamUrl) => ({ koboldcpp_url: upstreamUrl }),
        expectedOrigin: null,
        expectedPath: () => '/v1/chat/completions',
        assertAuth: assertBearerAuth,
        assertBody: (body, { stream }) => {
            expect(body).not.toHaveProperty('model');
            expect(body.stream).toBe(stream);
            expect(body.max_tokens).toBe(64);
            expect(body.genkey).toMatch(/^sillybunny-/);
            expect(body.messages).toEqual([{ role: 'user', content: USER_PROMPT }]);
        },
        nonStreamReply: openAiReply('koboldcpp'),
        assertNonStreamReply: (res) => assertOpenAiClientReply(res, 'koboldcpp'),
        streamChunks: OPENAI_STREAM_CHUNKS,
        nonStreamErrorStyle: 'shared',
        streamErrorStyle: 'forwardFetchResponse',
        expectsExplicitAbortEndpoint: true,
    },
];

const DISABLED_CHAT_SOURCES = [
    CHAT_COMPLETION_SOURCES.COMETAPI,
];

function buildGeneratePayload(row, upstreamUrl, overrides = {}) {
    return {
        chat_completion_source: row.source,
        model: row.model,
        messages: [{ role: 'user', content: USER_PROMPT }],
        max_tokens: 64,
        temperature: 0.7,
        top_p: 0.9,
        stream: false,
        ...(row.buildExtraBody ? row.buildExtraBody(upstreamUrl) : {}),
        ...overrides,
    };
}

function assertNonStreamErrorResponse(style, upstreamStatus, clientResponse, { malformed = false } = {}) {
    if (style === 'shared') {
        const expectedStatus = upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 502;
        expect(clientResponse.status).toBe(expectedStatus);
        expect(clientResponse.json?.error?.message).toBeTruthy();
        return;
    }

    if (style === 'claude') {
        const expectedStatus = upstreamStatus === 401 ? 400 : upstreamStatus;
        expect(clientResponse.status).toBe(expectedStatus);
        expect(clientResponse.json?.error?.message).toBeTruthy();
        return;
    }

    if (style === 'passthrough-status') {
        expect(clientResponse.status).toBe(upstreamStatus);
        expect(clientResponse.json?.error).toBeTruthy();
        return;
    }

    if (style === 'azure-500') {
        expect(clientResponse.status).toBe(500);
        expect(clientResponse.json?.error?.message).toBeTruthy();
        return;
    }

    // wrap-500 handlers map every non-OK upstream status to HTTP 500 with parsed JSON or { error: true }.
    expect(clientResponse.status).toBe(500);
    if (malformed) {
        expect(clientResponse.json).toEqual({ error: true });
    } else {
        expect(clientResponse.json?.error?.message).toBeTruthy();
    }
}

function assertStreamErrorResponse(style, upstreamStatus, clientResponse, expectedFragment) {
    const expectedStatus = upstreamStatus === 401 ? 400 : upstreamStatus;
    expect(clientResponse.status).toBe(expectedStatus);
    expect(clientResponse.text).toContain(expectedFragment);

    if (upstreamStatus === 401 && style === 'forwardFetchResponse') {
        expect(clientResponse.headers['x-upstream-status']).toBe('401');
    } else if (upstreamStatus === 401 && style === 'custom-stream-no-upstream-header') {
        // Known src bug: forwardResponsesApiStream and forwardInteractionStream remap 401 to 400 without setting X-Upstream-Status.
        expect(clientResponse.headers['x-upstream-status']).toBeUndefined();
    }
}

function parseSseDataObjects(sseText) {
    return sseText
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6).trim())
        .filter(data => data && data !== '[DONE]')
        .map(data => JSON.parse(data));
}

function assertStreamPayload(row, response) {
    if (row.streamTransform === 'chat-sse') {
        expect(response.text).toContain('data: [DONE]');
        const events = parseSseDataObjects(response.text);
        const text = events.map(event => event.choices?.[0]?.delta?.content ?? '').join('');
        expect(text).toBe('chunk-1-chunk-2');
        return;
    }

    expect(response.text).toBe(row.streamChunks.join(''));
}

async function assertExplicitAbortFollowup(row, upstream, generationReq) {
    if (!row.expectsExplicitAbortEndpoint) {
        return;
    }

    const sawAbortPost = await upstream.waitForRequests(
        reqs => reqs.some(req => req.pathname === '/api/extra/abort'),
    );
    expect(sawAbortPost).toBe(true);
    const abortReq = upstream.requests.find(req => req.pathname === '/api/extra/abort');
    expect(abortReq.method).toBe('POST');
    expect(abortReq.jsonBody).toEqual({ genkey: generationReq.jsonBody.genkey });
    expect(abortReq.headers.authorization).toBe(`Bearer ${testSecretFor(SECRET_KEYS.KOBOLDCPP)}`);
}

describe('Chat Completion provider contract matrix', () => {
    let upstream;
    let app;

    beforeAll(async () => {
        upstream = await startFakeUpstream();
        activeUpstreamPort = upstream.port;
        app = await startBackendApp({
            '/api/backends/chat-completions': chatCompletionsRouter,
        });
    });

    beforeEach(() => {
        upstream.reset();
        for (const method of ['debug', 'info', 'warn', 'error', 'log']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
    });

    afterEach(() => {
        upstream.releasePendingStreams();
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        activeUpstreamPort = null;
        if (app) {
            await app.close();
        }
        if (upstream) {
            await upstream.close();
        }
    });

    test('covers 100% of CHAT_COMPLETION_SOURCES in src/constants.js', () => {
        const expectedSources = Object.values(CHAT_COMPLETION_SOURCES).sort();
        const coveredSources = [
            ...ACTIVE_CHAT_CONTRACTS.map(row => row.source),
            ...DISABLED_CHAT_SOURCES,
        ].sort();

        expect(coveredSources).toEqual(expectedSources);
        expect(new Set(coveredSources).size).toBe(expectedSources.length);
    });

    describe.each(ACTIVE_CHAT_CONTRACTS)('$source', (row) => {
        test('sends expected request shape, auth, and returns non-streamed reply', async () => {
            upstream.replyJson(200, row.nonStreamReply);

            const response = await app.postJson(
                GENERATE_ROUTE,
                buildGeneratePayload(row, upstream.url, { stream: false }),
            );

            row.assertNonStreamReply(response);
            expect(upstream.requests).toHaveLength(1);

            const [req] = upstream.requests;
            expect(req.method).toBe('POST');
            expect(req.originalOrigin).toBe(row.expectedOrigin);
            expect(req.pathname).toBe(row.expectedPath(false));
            row.assertAuth(req, testSecretFor(row.secretKey), { stream: false });
            row.assertBody(req.jsonBody, { stream: false, model: row.model });
        });

        test('relays chunked streaming reply intact', async () => {
            upstream.replyStream(row.streamChunks);

            const response = await app.postJson(
                GENERATE_ROUTE,
                buildGeneratePayload(row, upstream.url, { stream: true }),
            );

            expect(response.status).toBe(200);
            expect(upstream.requests).toHaveLength(1);
            const [req] = upstream.requests;
            expect(req.pathname).toBe(row.expectedPath(true));
            row.assertAuth(req, testSecretFor(row.secretKey), { stream: true });
            row.assertBody(req.jsonBody, { stream: true, model: row.model });
            assertStreamPayload(row, response);
        });

        test.each([
            [401, { error: { message: 'Invalid API key' } }, 'Invalid API key'],
            [429, { error: { message: 'Rate limit exceeded' } }, 'Rate limit exceeded'],
            [500, { error: { message: 'Upstream failure' } }, 'Upstream failure'],
        ])('reports upstream HTTP %i error cleanly (non-streaming and streaming)', async (status, errorPayload, expectedFragment) => {
            upstream.replyJson(status, errorPayload);
            const nonStreamResponse = await app.postJson(
                GENERATE_ROUTE,
                buildGeneratePayload(row, upstream.url, { stream: false }),
            );
            expect(upstream.requests).toHaveLength(1);
            assertNonStreamErrorResponse(row.nonStreamErrorStyle, status, nonStreamResponse);

            upstream.reset();
            upstream.replyJson(status, errorPayload);
            const streamResponse = await app.postJson(
                GENERATE_ROUTE,
                buildGeneratePayload(row, upstream.url, { stream: true }),
            );
            expect(upstream.requests).toHaveLength(1);
            assertStreamErrorResponse(row.streamErrorStyle, status, streamResponse, expectedFragment);
        });

        test('handles malformed non-JSON upstream error body cleanly (non-streaming and streaming)', async () => {
            const rawHtml = '<html><body>Bad Gateway</body></html>';

            upstream.replyText(502, rawHtml, { 'Content-Type': 'text/html' });
            const nonStreamResponse = await app.postJson(
                GENERATE_ROUTE,
                buildGeneratePayload(row, upstream.url, { stream: false }),
            );
            expect(upstream.requests).toHaveLength(1);
            assertNonStreamErrorResponse(row.nonStreamErrorStyle, 502, nonStreamResponse, { malformed: true });

            upstream.reset();
            upstream.replyText(502, rawHtml, { 'Content-Type': 'text/html' });
            const streamResponse = await app.postJson(
                GENERATE_ROUTE,
                buildGeneratePayload(row, upstream.url, { stream: true }),
            );
            expect(upstream.requests).toHaveLength(1);
            assertStreamErrorResponse(row.streamErrorStyle, 502, streamResponse, 'Bad Gateway');
        });

        test('propagates client abort to cancel active upstream stream', async () => {
            upstream.replyHangingStream(row.streamChunks[0]);

            const clientResult = await app.streamAndAbortAfterFirstChunk(
                GENERATE_ROUTE,
                buildGeneratePayload(row, upstream.url, { stream: true }),
            );
            expect(clientResult.status).toBe(200);
            expect(clientResult.firstChunk).toContain('chunk-1-');

            const generationReq = upstream.requests.find(req => req.pathname === row.expectedPath(true));
            expect(generationReq).toBeDefined();
            const aborted = await upstream.waitForAbort(generationReq);
            expect(aborted).toBe(true);
            await assertExplicitAbortFollowup(row, upstream, generationReq);
        });
    });

    describe('disabled source contract (cometapi)', () => {
        test('refuses /generate without contacting upstream', async () => {
            const response = await app.postJson(GENERATE_ROUTE, {
                chat_completion_source: CHAT_COMPLETION_SOURCES.COMETAPI,
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: USER_PROMPT }],
                max_tokens: 64,
                stream: false,
            });

            expect(response.status).toBe(502);
            expect(response.json?.error?.message).toBe('This provider is temporarily disabled.');
            expect(upstream.requests).toHaveLength(0);
        });

        test('refuses /status without contacting upstream', async () => {
            const response = await app.postJson(STATUS_ROUTE, {
                chat_completion_source: CHAT_COMPLETION_SOURCES.COMETAPI,
            });

            expect(response.json).toEqual({ error: true });
            expect(upstream.requests).toHaveLength(0);
        });
    });

    describe('provider routing variants', () => {
        test('LinkAPI delegates claude models to Anthropic messages format and streams intact', async () => {
            upstream.replyStream(CLAUDE_STREAM_CHUNKS);

            const response = await app.postJson(GENERATE_ROUTE, {
                chat_completion_source: CHAT_COMPLETION_SOURCES.LINKAPI,
                model: 'claude-3-5-sonnet-20241022',
                messages: [{ role: 'user', content: USER_PROMPT }],
                max_tokens: 64,
                stream: true,
            });

            expect(response.status).toBe(200);
            expect(response.text).toBe(CLAUDE_STREAM_CHUNKS.join(''));
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].originalOrigin).toBe('https://linkapi.ai');
            expect(upstream.requests[0].pathname).toBe('/v1/messages');
            expect(upstream.requests[0].headers['x-api-key']).toBe(testSecretFor(SECRET_KEYS.LINKAPI));
        });

        test('LinkAPI delegates gemini models to Google generateContent format and streams intact', async () => {
            upstream.replyStream(GOOGLE_STREAM_CHUNKS);

            const response = await app.postJson(GENERATE_ROUTE, {
                chat_completion_source: CHAT_COMPLETION_SOURCES.LINKAPI,
                model: 'gemini-2.5-flash',
                messages: [{ role: 'user', content: USER_PROMPT }],
                max_tokens: 64,
                stream: true,
            });

            expect(response.status).toBe(200);
            expect(response.text).toBe(GOOGLE_STREAM_CHUNKS.join(''));
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].originalOrigin).toBe('https://linkapi.ai');
            expect(upstream.requests[0].pathname).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent');
            expect(upstream.requests[0].searchParams.get('key')).toBe(testSecretFor(SECRET_KEYS.LINKAPI));
        });

        test.each([
            ['pollinations anonymous', { chat_completion_source: CHAT_COMPLETION_SOURCES.POLLINATIONS, pollinations_endpoint: POLLINATIONS_ENDPOINT.ANONYMOUS, model: 'openai' }, 'https://text.pollinations.ai', '/v1/chat/completions', 'Bearer anonymous'],
            ['zai coding', { chat_completion_source: CHAT_COMPLETION_SOURCES.ZAI, zai_endpoint: ZAI_ENDPOINT.CODING, model: 'glm-4.5' }, 'https://api.z.ai', '/api/coding/paas/v4/chat/completions', `Bearer ${testSecretFor(SECRET_KEYS.ZAI)}`],
            ['siliconflow cn', { chat_completion_source: CHAT_COMPLETION_SOURCES.SILICONFLOW, siliconflow_endpoint: SILICONFLOW_ENDPOINT.CN, model: 'Qwen/Qwen2.5-7B-Instruct' }, 'https://api.siliconflow.cn', '/v1/chat/completions', `Bearer ${testSecretFor(SECRET_KEYS.SILICONFLOW)}`],
            ['minimax cn', { chat_completion_source: CHAT_COMPLETION_SOURCES.MINIMAX, minimax_endpoint: MINIMAX_ENDPOINT.CN, model: 'MiniMax-M1' }, 'https://api.minimaxi.com', '/v1/chat/completions', `Bearer ${testSecretFor(SECRET_KEYS.MINIMAX)}`],
        ])('routes regional/mode variant %s to expected upstream', async (_label, extra, expectedOrigin, expectedPath, expectedAuth) => {
            upstream.replyJson(200, openAiReply('variant'));

            const response = await app.postJson(GENERATE_ROUTE, {
                messages: [{ role: 'user', content: USER_PROMPT }],
                max_tokens: 64,
                stream: false,
                ...extra,
            });

            expect(response.status).toBe(200);
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].originalOrigin).toBe(expectedOrigin);
            expect(upstream.requests[0].pathname).toBe(expectedPath);
            expect(upstream.requests[0].headers.authorization).toBe(expectedAuth);
        });

        test('Vertex AI reverse proxy mode routes directly to loopback proxy URL with Bearer password', async () => {
            upstream.replyJson(200, {
                candidates: [{ content: { role: 'model', parts: [{ text: 'reply-vertex-proxy' }] }, finishReason: 'STOP' }],
            });

            const response = await app.postJson(GENERATE_ROUTE, {
                chat_completion_source: CHAT_COMPLETION_SOURCES.VERTEXAI,
                reverse_proxy: upstream.url,
                proxy_password: 'vertex-proxy-secret',
                model: 'gemini-2.5-flash',
                messages: [{ role: 'user', content: USER_PROMPT }],
                max_tokens: 64,
                stream: false,
            });

            expect(response.status).toBe(200);
            expect(response.json?.choices?.[0]?.message?.content).toBe('reply-vertex-proxy');
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].originalOrigin).toBeNull();
            expect(upstream.requests[0].pathname).toBe('/v1/publishers/google/models/gemini-2.5-flash:generateContent');
            expect(upstream.requests[0].headers.authorization).toBe('Bearer vertex-proxy-secret');
        });

        test('Custom endpoint enables cache_prompt on loopback when cacheScope is main', async () => {
            upstream.replyJson(200, openAiReply('custom-main'));

            const response = await app.postJson(GENERATE_ROUTE, {
                chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
                custom_url: `${upstream.url}/v1`,
                model: 'custom-contract-model',
                messages: [{ role: 'user', content: USER_PROMPT }],
                max_tokens: 64,
                cacheScope: 'main',
                stream: false,
            });

            expect(response.status).toBe(200);
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].jsonBody.cache_prompt).toBe(true);
        });

        test.each([
            CHAT_COMPLETION_SOURCES.OPENAI,
            CHAT_COMPLETION_SOURCES.CLAUDE,
            CHAT_COMPLETION_SOURCES.OPENROUTER,
            CHAT_COMPLETION_SOURCES.MAKERSUITE,
            CHAT_COMPLETION_SOURCES.GEMINI_INTERACTIONS,
            CHAT_COMPLETION_SOURCES.VERTEXAI,
            CHAT_COMPLETION_SOURCES.COHERE,
            CHAT_COMPLETION_SOURCES.DEEPSEEK,
            CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
            CHAT_COMPLETION_SOURCES.WORKERS_AI,
        ])('rejects missing secret for %s with HTTP 400 without calling upstream', async (source) => {
            const row = ACTIVE_CHAT_CONTRACTS.find(item => item.source === source);
            const response = await app.postJson(
                GENERATE_ROUTE,
                buildGeneratePayload(row, upstream.url, { stream: false }),
                { headers: { 'x-test-keyless': 'true' } },
            );

            expect(response.status).toBe(400);
            expect(upstream.requests).toHaveLength(0);
        });

        test.each([
            CHAT_COMPLETION_SOURCES.OPENAI,
            CHAT_COMPLETION_SOURCES.CLAUDE,
            CHAT_COMPLETION_SOURCES.MAKERSUITE,
            CHAT_COMPLETION_SOURCES.GEMINI_INTERACTIONS,
            CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
            CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
            CHAT_COMPLETION_SOURCES.COHERE,
            CHAT_COMPLETION_SOURCES.KOBOLDCPP,
        ])('aborts in-flight non-streaming upstream request for %s when client disconnects before headers arrive', async (source) => {
            const row = ACTIVE_CHAT_CONTRACTS.find(item => item.source === source);
            const hold = upstream.replyHangingBeforeHeaders();

            const client = app.startAbortablePost(
                GENERATE_ROUTE,
                buildGeneratePayload(row, upstream.url, { stream: false }),
            );
            const received = await hold.waitUntilReceived();
            client.abort();

            expect(await upstream.waitForAbort(received)).toBe(true);
            await assertExplicitAbortFollowup(row, upstream, received);
        });
    });
});
