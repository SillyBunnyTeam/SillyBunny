import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { TEXTGEN_TYPES } from '../src/constants.js';
import {
    createLoopbackFetch,
    ensureDefaultConfigLoaded,
    startBackendApp,
    startFakeUpstream,
    testSecretFor,
} from './util/provider-contract-harness.js';

ensureDefaultConfigLoaded();

const actualNodeFetchModule = await import('node-fetch');
// Every Text Completion backend accepts api_server, so fail closed on any non-loopback URL.
const strictLoopbackFetch = createLoopbackFetch(actualNodeFetchModule.default, () => null, { allowRedirect: false });

await jest.unstable_mockModule('node-fetch', () => ({
    ...actualNodeFetchModule,
    default: strictLoopbackFetch,
}));

const { SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const { router: textCompletionsRouter } = await import('../src/endpoints/backends/text-completions.js');

const GENERATE_ROUTE = '/api/backends/text-completions/generate';
const STATUS_ROUTE = '/api/backends/text-completions/status';
const PROMPT_TEXT = 'Once upon a contract test';

const TEXTGEN_SSE_CHUNKS = [
    'data: {"choices":[{"index":0,"text":"chunk-1-"}]}\n\n',
    'data: {"choices":[{"index":0,"text":"chunk-2","finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
];

const OLLAMA_NDJSON_CHUNKS = [
    '{"model":"llama3","response":"chunk-1-","done":false}\n',
    '{"model":"llama3","response":"chunk-2","thinking":"plan","done":true}\n',
];

function standardReply(type) {
    return {
        id: `cmpl-${type}`,
        choices: [{ index: 0, text: `reply-${type}`, finish_reason: 'stop' }],
    };
}

function assertBearer(secretKey) {
    return (req) => {
        expect(req.headers.authorization).toBe(`Bearer ${testSecretFor(secretKey)}`);
    };
}

function assertPassThroughBody(body, { stream, model }) {
    expect(body.prompt).toBe(PROMPT_TEXT);
    expect(body.model).toBe(model);
    expect(body.stream).toBe(stream);
    expect(body.max_tokens).toBe(64);
}

function assertWhitelistedBody(body, { stream, model }) {
    assertPassThroughBody(body, { stream, model });
    expect(body).not.toHaveProperty('api_server');
    expect(body).not.toHaveProperty('api_type');
    expect(body).not.toHaveProperty('extra_unlisted_field');
}

function parseSseDataObjects(sseText) {
    return sseText
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6).trim())
        .filter(data => data && data !== '[DONE]')
        .map(data => JSON.parse(data));
}

const TEXTGEN_CONTRACTS = [
    {
        type: TEXTGEN_TYPES.OOBA,
        model: 'ooba-model',
        expectedPath: '/v1/completions',
        statusPath: '/v1/models',
        assertHeaders: assertBearer(SECRET_KEYS.OOBA),
        assertBody: assertPassThroughBody,
        nonStreamReply: standardReply('ooba'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-ooba'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.MANCER,
        model: 'mancer-model',
        expectedPath: '/oai/v1/completions',
        statusPath: '/oai/v1/models',
        assertHeaders: (req) => {
            expect(req.headers['x-api-key']).toBe(testSecretFor(SECRET_KEYS.MANCER));
            expect(req.headers.authorization).toBe(`Bearer ${testSecretFor(SECRET_KEYS.MANCER)}`);
        },
        assertBody: assertPassThroughBody,
        nonStreamReply: standardReply('mancer'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-mancer'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.VLLM,
        model: 'vllm-model',
        expectedPath: '/v1/completions',
        statusPath: '/v1/models',
        assertHeaders: assertBearer(SECRET_KEYS.VLLM),
        assertBody: assertWhitelistedBody,
        nonStreamReply: standardReply('vllm'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-vllm'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.APHRODITE,
        model: 'aphrodite-model',
        expectedPath: '/v1/completions',
        statusPath: '/v1/models',
        assertHeaders: (req) => {
            expect(req.headers['x-api-key']).toBe(testSecretFor(SECRET_KEYS.APHRODITE));
            expect(req.headers.authorization).toBe(`Bearer ${testSecretFor(SECRET_KEYS.APHRODITE)}`);
        },
        assertBody: assertPassThroughBody,
        nonStreamReply: standardReply('aphrodite'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-aphrodite'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.TABBY,
        model: 'tabby-model',
        expectedPath: '/v1/completions',
        statusPath: '/v1/model/list',
        assertHeaders: (req) => {
            expect(req.headers['x-api-key']).toBe(testSecretFor(SECRET_KEYS.TABBY));
            expect(req.headers.authorization).toBe(`Bearer ${testSecretFor(SECRET_KEYS.TABBY)}`);
        },
        assertBody: assertPassThroughBody,
        nonStreamReply: standardReply('tabby'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-tabby'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.KOBOLDCPP,
        model: 'koboldcpp-model',
        expectedPath: '/v1/completions',
        statusPath: '/v1/models',
        assertHeaders: assertBearer(SECRET_KEYS.KOBOLDCPP),
        assertBody: assertPassThroughBody,
        nonStreamReply: standardReply('koboldcpp'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-koboldcpp'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
        expectsExplicitAbortEndpoint: true,
    },
    {
        type: TEXTGEN_TYPES.TOGETHERAI,
        model: 'together-model',
        expectedPath: '/v1/completions',
        statusPath: '/api/models',
        assertHeaders: assertBearer(SECRET_KEYS.TOGETHERAI),
        assertBody: assertWhitelistedBody,
        nonStreamReply: standardReply('togetherai'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-togetherai'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.LLAMACPP,
        model: 'llamacpp-model',
        expectedPath: '/completion',
        statusPath: '/v1/models',
        assertHeaders: assertBearer(SECRET_KEYS.LLAMACPP),
        assertBody: assertPassThroughBody,
        nonStreamReply: { content: 'reply-llamacpp', stop: true },
        assertNonStreamReply: (res) => expect(res.json?.content).toBe('reply-llamacpp'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.OLLAMA,
        model: 'llama3',
        expectedPath: '/api/generate',
        statusPath: '/api/tags',
        assertHeaders: (req) => {
            expect(req.headers.authorization).toBeUndefined();
        },
        assertBody: (body, { stream, model }) => {
            expect(body).toEqual({
                model,
                prompt: PROMPT_TEXT,
                stream,
                keep_alive: -1,
                raw: true,
                options: expect.objectContaining({
                    temperature: 0.7,
                    top_p: 0.9,
                }),
            });
            expect(body).not.toHaveProperty('api_server');
            expect(body).not.toHaveProperty('extra_unlisted_field');
        },
        nonStreamReply: { model: 'llama3', response: 'reply-ollama', done: true },
        assertNonStreamReply: (res) => expect(res.json?.response).toBe('reply-ollama'),
        streamChunks: OLLAMA_NDJSON_CHUNKS,
        streamContentType: 'application/x-ndjson',
        isOllama: true,
    },
    {
        type: TEXTGEN_TYPES.INFERMATICAI,
        model: 'infermatic-model',
        expectedPath: '/v1/completions',
        statusPath: '/v1/models',
        assertHeaders: assertBearer(SECRET_KEYS.INFERMATICAI),
        assertBody: assertWhitelistedBody,
        // InfermaticAI returns chat-style message.content that the route maps into choices[].text.
        nonStreamReply: {
            choices: [{ index: 0, message: { content: 'reply-infermaticai' }, logprobs: null }],
        },
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-infermaticai'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.DREAMGEN,
        model: 'dreamgen-model',
        expectedPath: '/api/openai/v1/completions',
        statusPath: '/api/openai/v1/models',
        assertHeaders: assertBearer(SECRET_KEYS.DREAMGEN),
        assertBody: assertPassThroughBody,
        nonStreamReply: standardReply('dreamgen'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-dreamgen'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.OPENROUTER,
        model: 'meta-llama/llama-3.1-8b-instruct',
        expectedPath: '/v1/chat/completions',
        statusPath: '/v1/models',
        extraBody: {
            provider: ['DeepInfra'],
            quantizations: ['fp8'],
            service_tier: 'priority',
        },
        assertHeaders: (req) => {
            expect(req.headers.authorization).toBe(`Bearer ${testSecretFor(SECRET_KEYS.OPENROUTER)}`);
            expect(req.headers['http-referer']).toBe('https://sillytavern.app');
            expect(req.headers['x-title']).toBe('SillyTavern');
        },
        assertBody: (body, ctx) => {
            assertWhitelistedBody(body, ctx);
            expect(body.provider).toEqual({
                allow_fallbacks: true,
                order: ['DeepInfra'],
                quantizations: ['fp8'],
            });
            expect(body.service_tier).toBe('priority');
        },
        nonStreamReply: standardReply('openrouter'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-openrouter'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.FEATHERLESS,
        model: 'featherless-model',
        expectedPath: '/v1/completions',
        statusPath: '/v1/models',
        assertHeaders: (req) => {
            expect(req.headers.authorization).toBe(`Bearer ${testSecretFor(SECRET_KEYS.FEATHERLESS)}`);
            expect(req.headers['http-referer']).toBe('https://sillytavern.app');
            expect(req.headers['x-title']).toBe('SillyTavern');
        },
        assertBody: assertWhitelistedBody,
        nonStreamReply: standardReply('featherless'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-featherless'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.HUGGINGFACE,
        model: 'hf-model',
        expectedPath: '/v1/completions',
        statusPath: '/info',
        assertHeaders: assertBearer(SECRET_KEYS.HUGGINGFACE),
        assertBody: assertPassThroughBody,
        nonStreamReply: standardReply('huggingface'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-huggingface'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
    {
        type: TEXTGEN_TYPES.GENERIC,
        model: 'generic-model',
        expectedPath: '/v1/completions',
        statusPath: '/v1/models',
        assertHeaders: assertBearer(SECRET_KEYS.GENERIC),
        assertBody: (body, ctx) => {
            assertWhitelistedBody(body, ctx);
            expect(body.stop).toEqual(['s1', 's2', 's3', 's4']);
        },
        nonStreamReply: standardReply('generic'),
        assertNonStreamReply: (res) => expect(res.json?.choices?.[0]?.text).toBe('reply-generic'),
        streamChunks: TEXTGEN_SSE_CHUNKS,
    },
];

function buildPayload(row, upstreamUrl, overrides = {}) {
    return {
        api_type: row.type,
        api_server: upstreamUrl,
        model: row.model,
        prompt: PROMPT_TEXT,
        max_tokens: 64,
        temperature: 0.7,
        top_p: 0.9,
        stop: ['s1', 's2', 's3', 's4', 's5', 's6'],
        stream: false,
        extra_unlisted_field: 'should-be-filtered',
        ...(row.extraBody ?? {}),
        ...overrides,
    };
}

function assertTextgenStreamReply(row, response) {
    if (row.isOllama) {
        expect(response.text).toContain('data: [DONE]');
        const events = parseSseDataObjects(response.text);
        expect(events.map(event => event.choices[0].text).join('')).toBe('chunk-1-chunk-2');
        expect(events.map(event => event.choices[0].thinking).join('')).toBe('plan');
        return;
    }

    expect(response.text).toBe(row.streamChunks.join(''));
}

function assertTextgenStreamError(row, status, streamResponse, expectedFragment) {
    if (row.isOllama) {
        // Known src bug: parseOllamaStream does not inspect jsonStream.ok or status before emitting SSE.
        expect(streamResponse.status).toBe(200);
        expect(streamResponse.text).toContain('data: [DONE]');
        return;
    }

    const expectedStreamStatus = status === 401 ? 400 : status;
    expect(streamResponse.status).toBe(expectedStreamStatus);
    expect(streamResponse.text).toContain(expectedFragment);
    expect(streamResponse.headers['x-upstream-status']).toBe(status === 401 ? '401' : undefined);
}

function assertTextgenMalformedStreamError(row, streamResponse) {
    if (row.isOllama) {
        // Known src bug: parseOllamaStream swallows non-JSON error responses and ends with HTTP 200.
        expect(streamResponse.status).toBe(200);
        expect(streamResponse.text).toContain('data: [DONE]');
        return;
    }

    expect(streamResponse.status).toBe(502);
    expect(streamResponse.text).toContain('Bad Gateway');
}

async function assertTextgenAbortFollowup(row, upstream) {
    if (!row.expectsExplicitAbortEndpoint) {
        return;
    }

    const sawAbortPost = await upstream.waitForRequests(
        reqs => reqs.some(req => req.pathname === '/api/extra/abort'),
    );
    expect(sawAbortPost).toBe(true);
    const abortReq = upstream.requests.find(req => req.pathname === '/api/extra/abort');
    expect(abortReq.method).toBe('POST');
    expect(abortReq.headers.authorization).toBe(`Bearer ${testSecretFor(SECRET_KEYS.KOBOLDCPP)}`);
}

describe('Text Completion provider contract matrix', () => {
    let upstream;
    let app;

    beforeAll(async () => {
        upstream = await startFakeUpstream();
        app = await startBackendApp({
            '/api/backends/text-completions': textCompletionsRouter,
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
        if (app) {
            await app.close();
        }
        if (upstream) {
            await upstream.close();
        }
    });

    test('covers 100% of TEXTGEN_TYPES in src/constants.js', () => {
        const expectedTypes = Object.values(TEXTGEN_TYPES).sort();
        const coveredTypes = TEXTGEN_CONTRACTS.map(row => row.type).sort();

        expect(coveredTypes).toEqual(expectedTypes);
        expect(new Set(coveredTypes).size).toBe(expectedTypes.length);
    });

    describe.each(TEXTGEN_CONTRACTS)('$type', (row) => {
        test('sends expected request shape, headers, and returns non-streamed reply', async () => {
            upstream.replyJson(200, row.nonStreamReply);

            const response = await app.postJson(
                GENERATE_ROUTE,
                buildPayload(row, upstream.url, { stream: false }),
            );

            expect(response.status).toBe(200);
            row.assertNonStreamReply(response);
            expect(upstream.requests).toHaveLength(1);

            const [req] = upstream.requests;
            expect(req.method).toBe('POST');
            expect(req.pathname).toBe(row.expectedPath);
            row.assertHeaders(req);
            row.assertBody(req.jsonBody, { stream: false, model: row.model });
        });

        test('relays chunked streaming reply intact', async () => {
            upstream.replyStream(row.streamChunks, {
                contentType: row.streamContentType ?? 'text/event-stream',
                // Separate Ollama NDJSON frames so each chunk parses cleanly.
                chunkDelayMs: row.isOllama ? 15 : 5,
            });

            const response = await app.postJson(
                GENERATE_ROUTE,
                buildPayload(row, upstream.url, { stream: true }),
            );

            expect(response.status).toBe(200);
            expect(upstream.requests).toHaveLength(1);
            const [req] = upstream.requests;
            expect(req.pathname).toBe(row.expectedPath);
            row.assertHeaders(req);
            row.assertBody(req.jsonBody, { stream: true, model: row.model });
            assertTextgenStreamReply(row, response);
        });

        test.each([
            [401, { error: { message: 'Invalid API key' } }, 'Invalid API key'],
            [429, { error: { message: 'Rate limit exceeded' } }, 'Rate limit exceeded'],
            [500, { error: { message: 'Upstream failure' } }, 'Upstream failure'],
        ])('reports upstream HTTP %i error cleanly (non-streaming and streaming)', async (status, errorPayload, expectedFragment) => {
            upstream.replyJson(status, errorPayload);
            const nonStreamResponse = await app.postJson(
                GENERATE_ROUTE,
                buildPayload(row, upstream.url, { stream: false }),
            );
            const expectedNonStreamStatus = status >= 400 && status < 500 ? status : 502;
            expect(nonStreamResponse.status).toBe(expectedNonStreamStatus);
            expect(nonStreamResponse.json).toEqual({
                error: true,
                status,
                response: JSON.stringify(errorPayload),
            });

            upstream.reset();
            upstream.replyJson(status, errorPayload);
            const streamResponse = await app.postJson(
                GENERATE_ROUTE,
                buildPayload(row, upstream.url, { stream: true }),
            );
            assertTextgenStreamError(row, status, streamResponse, expectedFragment);
        });

        test('handles malformed non-JSON upstream error body cleanly (non-streaming and streaming)', async () => {
            const rawHtml = '<html><body>Bad Gateway</body></html>';

            upstream.replyText(502, rawHtml, { 'Content-Type': 'text/html' });
            const nonStreamResponse = await app.postJson(
                GENERATE_ROUTE,
                buildPayload(row, upstream.url, { stream: false }),
            );
            expect(nonStreamResponse.status).toBe(502);
            expect(nonStreamResponse.json).toEqual({
                error: true,
                status: 502,
                response: rawHtml,
            });

            upstream.reset();
            upstream.replyText(502, rawHtml, { 'Content-Type': 'text/html' });
            const streamResponse = await app.postJson(
                GENERATE_ROUTE,
                buildPayload(row, upstream.url, { stream: true }),
            );
            assertTextgenMalformedStreamError(row, streamResponse);
        });

        test('propagates client abort to cancel active upstream stream', async () => {
            upstream.replyHangingStream(row.streamChunks[0], {
                contentType: row.streamContentType ?? 'text/event-stream',
            });

            const clientResult = await app.streamAndAbortAfterFirstChunk(
                GENERATE_ROUTE,
                buildPayload(row, upstream.url, { stream: true }),
            );
            expect(clientResult.status).toBe(200);
            expect(clientResult.firstChunk).toContain('chunk-1-');

            const generationReq = upstream.requests.find(req => req.pathname === row.expectedPath);
            expect(generationReq).toBeDefined();
            const aborted = await upstream.waitForAbort(generationReq);
            expect(aborted).toBe(true);
            await assertTextgenAbortFollowup(row, upstream);
        });

        test('checks /status against the backend model discovery endpoint', async () => {
            upstream.setHandler((record, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (row.type === TEXTGEN_TYPES.TOGETHERAI) {
                    res.end(JSON.stringify([{ name: row.model }]));
                    return;
                }
                if (row.type === TEXTGEN_TYPES.OLLAMA) {
                    res.end(JSON.stringify({ models: [{ name: row.model }] }));
                    return;
                }
                if (row.type === TEXTGEN_TYPES.HUGGINGFACE) {
                    res.end(JSON.stringify({ model_id: row.model }));
                    return;
                }
                if (record.pathname === '/v1/internal/model/info') {
                    res.end(JSON.stringify({ model_name: row.model }));
                    return;
                }
                if (record.pathname === '/v1/model') {
                    res.end(JSON.stringify({ id: row.model }));
                    return;
                }
                res.end(JSON.stringify({ data: [{ id: row.model }] }));
            });

            const response = await app.postJson(STATUS_ROUTE, {
                api_type: row.type,
                api_server: upstream.url,
            });

            expect(response.status).toBe(200);
            expect(upstream.requests.length).toBeGreaterThanOrEqual(1);
            expect(upstream.requests[0].method).toBe('GET');
            expect(upstream.requests[0].pathname).toBe(row.statusPath);
            row.assertHeaders(upstream.requests[0]);
            expect(response.json?.result).toBe(row.type === TEXTGEN_TYPES.HUGGINGFACE ? 'Valid' : row.model);
        });
    });

    test('OpenRouter Text Completion rejects an invalid service_tier with HTTP 400 before calling upstream', async () => {
        const response = await app.postJson(GENERATE_ROUTE, {
            api_type: TEXTGEN_TYPES.OPENROUTER,
            api_server: upstream.url,
            model: 'meta-llama/llama-3.1-8b-instruct',
            prompt: PROMPT_TEXT,
            service_tier: 'invalid-tier',
            stream: false,
        });

        expect(response.status).toBe(400);
        expect(response.json).toEqual({ error: true, field: 'service_tier' });
        expect(upstream.requests).toHaveLength(0);
    });

    test('trims trailing /v1/ from api_server instead of duplicating /v1', async () => {
        upstream.replyJson(200, standardReply('ooba'));

        const response = await app.postJson(GENERATE_ROUTE, {
            api_type: TEXTGEN_TYPES.OOBA,
            api_server: `${upstream.url}/v1/`,
            model: 'ooba-model',
            prompt: PROMPT_TEXT,
            max_tokens: 64,
            stream: false,
        });

        expect(response.status).toBe(200);
        expect(upstream.requests).toHaveLength(1);
        expect(upstream.requests[0].pathname).toBe('/v1/completions');
    });

    test('documents current parseOllamaStream failure when multiple NDJSON frames coalesce in one chunk', async () => {
        upstream.replyStream([
            '{"model":"llama3","response":"part-1","done":false}\n{"model":"llama3","response":"part-2","done":true}\n',
        ], { contentType: 'application/x-ndjson', chunkDelayMs: 0 });

        const response = await app.postJson(GENERATE_ROUTE, {
            api_type: TEXTGEN_TYPES.OLLAMA,
            api_server: upstream.url,
            model: 'llama3',
            prompt: PROMPT_TEXT,
            max_tokens: 64,
            stream: true,
        });

        // Known src bug: parseOllamaStream calls JSON.parse on the raw buffer without splitting on newlines, dropping coalesced frames.
        expect(response.status).toBe(200);
        expect(parseSseDataObjects(response.text)).toEqual([]);
        expect(response.text).toBe('data: [DONE]\n\n');
    });
});
