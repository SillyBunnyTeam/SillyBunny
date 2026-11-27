import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

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
const { router: koboldRouter } = await import('../src/endpoints/backends/kobold.js');
const { router: novelAiRouter } = await import('../src/endpoints/novelai.js');
const { router: hordeRouter } = await import('../src/endpoints/horde.js');

const KOBOLD_SSE_CHUNKS = [
    'event: message\ndata: {"token":"chunk-1-"}\n\n',
    'event: message\ndata: {"token":"chunk-2"}\n\n',
];

const NOVELAI_SSE_CHUNKS = [
    'event: newToken\ndata: {"token":"chunk-1-","ptr":0,"final":false}\n\n',
    'event: newToken\ndata: {"token":"chunk-2","ptr":1,"final":true}\n\n',
];

describe('Standalone completion backend contracts (KoboldAI, NovelAI, AI Horde)', () => {
    let upstream;
    let app;

    beforeAll(async () => {
        upstream = await startFakeUpstream();
        activeUpstreamPort = upstream.port;
        app = await startBackendApp({
            '/api/backends/kobold': koboldRouter,
            '/api/novelai': novelAiRouter,
            '/api/horde': hordeRouter,
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

    describe('KoboldAI native (/api/backends/kobold)', () => {
        function buildKoboldPayload(overrides = {}) {
            return {
                api_server: `${upstream.url}/api`,
                prompt: 'Hello Kobold',
                max_context_length: 2048,
                max_length: 64,
                temperature: 0.7,
                streaming: false,
                can_abort: true,
                ...overrides,
            };
        }

        test('sends expected request shape and returns non-streamed reply', async () => {
            upstream.replyJson(200, { results: [{ text: 'reply-kobold' }] });

            const response = await app.postJson('/api/backends/kobold/generate', buildKoboldPayload());

            expect(response.status).toBe(200);
            expect(response.json?.results?.[0]?.text).toBe('reply-kobold');
            expect(upstream.requests).toHaveLength(1);
            const [req] = upstream.requests;
            expect(req.method).toBe('POST');
            expect(req.originalOrigin).toBeNull();
            expect(req.pathname).toBe('/api/v1/generate');
            expect(req.jsonBody).toMatchObject({
                prompt: 'Hello Kobold',
                max_context_length: 2048,
                max_length: 64,
                temperature: 0.7,
            });
        });

        test('relays chunked streaming reply intact', async () => {
            upstream.replyStream(KOBOLD_SSE_CHUNKS);

            const response = await app.postJson('/api/backends/kobold/generate', buildKoboldPayload({ streaming: true }));

            expect(response.status).toBe(200);
            expect(response.text).toBe(KOBOLD_SSE_CHUNKS.join(''));
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].pathname).toBe('/api/extra/generate/stream');
        });

        test.each([
            [401, { detail: { msg: 'Invalid key' } }, 'Invalid key'],
            [429, { detail: { msg: 'Too many requests' } }, 'Too many requests'],
            [500, { detail: { msg: 'Backend crashed' } }, 'Backend crashed'],
        ])('reports upstream HTTP %i error cleanly (non-streaming and streaming)', async (status, payload, expectedFragment) => {
            upstream.replyJson(status, payload);
            const nonStream = await app.postJson('/api/backends/kobold/generate', buildKoboldPayload());
            expect(nonStream.status).toBe(400);
            expect(nonStream.json?.error?.message).toBe(expectedFragment);

            upstream.reset();
            upstream.replyJson(status, payload);
            const stream = await app.postJson('/api/backends/kobold/generate', buildKoboldPayload({ streaming: true }));
            expect(stream.status).toBe(status === 401 ? 400 : status);
            expect(stream.text).toContain(expectedFragment);
            expect(stream.headers['x-upstream-status']).toBe(status === 401 ? '401' : undefined);
        });

        test('handles malformed non-JSON upstream error body cleanly', async () => {
            const rawHtml = '<html>Bad Gateway</html>';

            upstream.replyText(502, rawHtml, { 'Content-Type': 'text/html' });
            const nonStream = await app.postJson('/api/backends/kobold/generate', buildKoboldPayload());
            expect(nonStream.status).toBe(400);
            expect(nonStream.json?.error?.message).toBe(rawHtml);

            upstream.reset();
            upstream.replyText(502, rawHtml, { 'Content-Type': 'text/html' });
            const stream = await app.postJson('/api/backends/kobold/generate', buildKoboldPayload({ streaming: true }));
            expect(stream.status).toBe(502);
            expect(stream.text).toContain('Bad Gateway');
        });

        test('propagates client abort and sends /api/extra/abort when can_abort is true', async () => {
            upstream.replyHangingStream(KOBOLD_SSE_CHUNKS[0]);

            const clientResult = await app.streamAndAbortAfterFirstChunk(
                '/api/backends/kobold/generate',
                buildKoboldPayload({ streaming: true, can_abort: true }),
            );
            expect(clientResult.status).toBe(200);
            expect(clientResult.firstChunk).toContain('chunk-1-');

            const generationReq = upstream.requests.find(req => req.pathname === '/api/extra/generate/stream');
            expect(generationReq).toBeDefined();
            expect(await upstream.waitForAbort(generationReq)).toBe(true);

            const sawAbort = await upstream.waitForRequests(
                reqs => reqs.some(req => req.pathname === '/api/extra/abort'),
            );
            expect(sawAbort).toBe(true);
            expect(upstream.requests.find(req => req.pathname === '/api/extra/abort').method).toBe('POST');
        });
    });

    describe('NovelAI (/api/novelai)', () => {
        function buildNovelPayload(overrides = {}) {
            return {
                model: 'kayra-v1',
                input: 'Hello NovelAI',
                max_length: 64,
                temperature: 0.8,
                streaming: false,
                ...overrides,
            };
        }

        test.each([
            ['kayra-v1', 'https://text.novelai.net'],
            ['llama-3-erato-v1', 'https://text.novelai.net'],
            ['clio-v1', 'https://api.novelai.net'],
        ])('routes %s to %s with Bearer auth and returns non-streamed reply', async (model, expectedOrigin) => {
            upstream.replyJson(200, { output: `reply-${model}` });

            const response = await app.postJson('/api/novelai/generate', buildNovelPayload({ model }));

            expect(response.status).toBe(200);
            expect(response.json?.output).toBe(`reply-${model}`);
            expect(upstream.requests).toHaveLength(1);
            const [req] = upstream.requests;
            expect(req.method).toBe('POST');
            expect(req.originalOrigin).toBe(expectedOrigin);
            expect(req.pathname).toBe('/ai/generate');
            expect(req.headers.authorization).toBe(`Bearer ${testSecretFor(SECRET_KEYS.NOVEL)}`);
            expect(req.jsonBody).toMatchObject({
                model,
                input: 'Hello NovelAI',
                parameters: expect.objectContaining({
                    max_length: 64,
                    temperature: 0.8,
                }),
            });
        });

        test('relays chunked streaming reply intact', async () => {
            upstream.replyStream(NOVELAI_SSE_CHUNKS);

            const response = await app.postJson('/api/novelai/generate', buildNovelPayload({ streaming: true }));

            expect(response.status).toBe(200);
            expect(response.text).toBe(NOVELAI_SSE_CHUNKS.join(''));
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].originalOrigin).toBe('https://text.novelai.net');
            expect(upstream.requests[0].pathname).toBe('/ai/generate-stream');
        });

        test.each([
            [401, { statusCode: 401, message: 'Access token invalid' }, 'Access token invalid'],
            [429, { statusCode: 429, message: 'Concurrent generation limit' }, 'Concurrent generation limit'],
            [500, { statusCode: 500, message: 'NovelAI error' }, 'NovelAI error'],
        ])('reports upstream HTTP %i error cleanly (non-streaming and streaming)', async (status, payload, expectedFragment) => {
            upstream.replyJson(status, payload);
            const nonStream = await app.postJson('/api/novelai/generate', buildNovelPayload());
            expect(nonStream.status).toBe(500);
            expect(nonStream.json?.error?.message).toBe(expectedFragment);

            upstream.reset();
            upstream.replyJson(status, payload);
            const stream = await app.postJson('/api/novelai/generate', buildNovelPayload({ streaming: true }));
            expect(stream.status).toBe(status === 401 ? 400 : status);
            expect(stream.text).toContain(expectedFragment);
            expect(stream.headers['x-upstream-status']).toBe(status === 401 ? '401' : undefined);
        });

        test('handles malformed non-JSON upstream error body cleanly', async () => {
            const rawHtml = '<html>Bad Gateway</html>';

            upstream.replyText(502, rawHtml, { 'Content-Type': 'text/html' });
            const nonStream = await app.postJson('/api/novelai/generate', buildNovelPayload());
            expect(nonStream.status).toBe(500);
            expect(nonStream.json?.error?.message).toBe(rawHtml);

            upstream.reset();
            upstream.replyText(502, rawHtml, { 'Content-Type': 'text/html' });
            const stream = await app.postJson('/api/novelai/generate', buildNovelPayload({ streaming: true }));
            expect(stream.status).toBe(502);
            expect(stream.text).toContain('Bad Gateway');
        });

        test('propagates client abort to cancel active upstream stream', async () => {
            upstream.replyHangingStream(NOVELAI_SSE_CHUNKS[0]);

            const clientResult = await app.streamAndAbortAfterFirstChunk(
                '/api/novelai/generate',
                buildNovelPayload({ streaming: true }),
            );
            expect(clientResult.status).toBe(200);
            expect(clientResult.firstChunk).toContain('chunk-1-');

            const [generationReq] = upstream.requests;
            expect(generationReq.pathname).toBe('/ai/generate-stream');
            expect(await upstream.waitForAbort(generationReq)).toBe(true);
        });
    });

    describe('AI Horde (/api/horde)', () => {
        test('submits async text generation with apikey and Client-Agent headers', async () => {
            upstream.replyJson(202, { id: 'horde-task-123', kudos: 5 });

            const payload = {
                prompt: 'Hello Horde',
                models: ['aphrodite/test-model'],
                params: { max_length: 64, max_context_length: 2048 },
            };
            const response = await app.postJson('/api/horde/generate-text', payload);

            expect(response.status).toBe(200);
            expect(response.json).toEqual({ id: 'horde-task-123', kudos: 5 });
            expect(upstream.requests).toHaveLength(1);
            const [req] = upstream.requests;
            expect(req.method).toBe('POST');
            expect(req.originalOrigin).toBe('https://aihorde.net');
            expect(req.pathname).toBe('/api/v2/generate/text/async');
            expect(req.headers.apikey).toBe(testSecretFor(SECRET_KEYS.HORDE));
            expect(req.headers['client-agent']).toMatch(/^SillyBunny:/);
            expect(req.jsonBody).toEqual(payload);
        });

        test.each([
            [401, '{"message":"Invalid API key"}'],
            [429, '{"message":"Too many requests"}'],
            [500, '{"message":"Horde overloaded"}'],
            [502, '<html>Bad Gateway</html>'],
        ])('reports upstream HTTP %i error cleanly on /generate-text', async (status, body) => {
            upstream.replyText(status, body);

            const response = await app.postJson('/api/horde/generate-text', { prompt: 'Hello Horde' });

            expect(response.status).toBe(200);
            expect(response.json).toEqual({ error: { message: body } });
        });

        test('cancels an active Horde generation task via DELETE /cancel-task', async () => {
            upstream.replyJson(200, { finished: 0, faulted: false, cancelled: true });

            const response = await app.postJson('/api/horde/cancel-task', { taskId: 'horde-task-123' });

            expect(response.status).toBe(200);
            expect(response.json?.cancelled).toBe(true);
            expect(upstream.requests).toHaveLength(1);
            const [req] = upstream.requests;
            expect(req.method).toBe('DELETE');
            expect(req.originalOrigin).toBe('https://aihorde.net');
            expect(req.pathname).toBe('/api/v2/generate/text/status/horde-task-123');
            expect(req.headers['client-agent']).toMatch(/^SillyBunny:/);
        });

        test('polls task status via GET /task-status', async () => {
            upstream.replyJson(200, { done: true, generations: [{ text: 'reply-horde' }] });

            const response = await app.postJson('/api/horde/task-status', { taskId: 'horde-task-123' });

            expect(response.status).toBe(200);
            expect(response.json?.generations?.[0]?.text).toBe('reply-horde');
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].method).toBe('GET');
            expect(upstream.requests[0].pathname).toBe('/api/v2/generate/text/status/horde-task-123');
        });

        test('documents that /generate-text does not abort an in-flight submission when the client disconnects', async () => {
            const hold = upstream.replyHangingBeforeHeaders();

            const client = app.startAbortablePost('/api/horde/generate-text', { prompt: 'Hello Horde' });
            const received = await hold.waitUntilReceived();
            client.abort();

            // Known src bug: /api/horde/generate-text does not attach abortOnRequestClose or pass a signal to fetch.
            expect(await upstream.waitForAbort(received, 150)).toBe(false);
        });
    });
});
