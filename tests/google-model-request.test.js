import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';

const { default: actualNodeFetch, Response: NodeFetchResponse } = await import('node-fetch');
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

describe('Google model request compatibility', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let capturedBody;
    let resumableGeneration;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-google-model-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-google-model-user-'));
        tempDirs.push(userRoot);
        const secretManager = new SecretManager({ root: userRoot, backups: userRoot });
        secretManager.writeSecret(SECRET_KEYS.MAKERSUITE, 'google-test-key');
        secretManager.writeSecret(SECRET_KEYS.VERTEXAI, 'vertex-test-key');

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: userRoot, backups: userRoot } };
            req.resumableGeneration = resumableGeneration;
            next();
        });
        app.use('/api/backends/chat-completions', chatCompletionsRouter);

        await new Promise((resolve) => {
            appServer = app.listen(0, '127.0.0.1', resolve);
        });
        const address = appServer.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    beforeEach(() => {
        capturedBody = undefined;
        resumableGeneration = null;
        nodeFetchMock.mockClear();
        nodeFetchMock.mockImplementation(async (_url, options) => {
            capturedBody = JSON.parse(options?.body ?? '{}');
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{ text: 'ok' }] } }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
    });

    afterAll(async () => {
        if (appServer) {
            await new Promise((resolve, reject) => {
                appServer.close((error) => error ? reject(error) : resolve());
            });
        }
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        nodeFetchMock.mockImplementation((url, options) => actualNodeFetch(url, options));
    });

    function makeRequest(model, options = {}) {
        return fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.MAKERSUITE,
                model,
                stream: false,
                max_tokens: 128,
                temperature: 1,
                top_p: 0.9,
                top_k: 40,
                messages: [{ role: 'user', content: 'Question' }],
                ...options,
            }),
        });
    }

    test.each(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-nano-banana-2.1'])(
        'omits unsupported sampling parameters for %s',
        async (model) => {
            const response = await makeRequest(model);

            expect(response.status).toBe(200);
            expect(capturedBody.generationConfig).not.toHaveProperty('temperature');
            expect(capturedBody.generationConfig).not.toHaveProperty('topP');
            expect(capturedBody.generationConfig).not.toHaveProperty('topK');
            expect(capturedBody.generationConfig).not.toHaveProperty('candidateCount');
        },
    );

    test('keeps sampling parameters for older Gemini models', async () => {
        const response = await makeRequest('gemini-2.5-flash');

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig).toMatchObject({
            temperature: 1,
            topP: 0.9,
            topK: 40,
            candidateCount: 1,
        });
    });

    test('sends a thinking level for Gemini 4', async () => {
        const response = await makeRequest('gemini-4-argon', { reasoning_effort: 'medium' });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'medium' });
    });

    test('sends the highest documented thinking level when Gemini 4 is asked for max', async () => {
        const response = await makeRequest('gemini-4-argon', { reasoning_effort: 'max' });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    });

    test('turns off the fetch idle timeout so a long thinking pass can stay silent', async () => {
        const response = await makeRequest('gemini-4-argon');

        expect(response.status).toBe(200);
        expect(nodeFetchMock.mock.calls[0][1].timeout).toBe(0);
    });

    describe('replies that end early', () => {
        function replyWith(candidate) {
            nodeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ candidates: [candidate] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        }

        test.each(['MAX_TOKENS', 'CONTINUATION'])('marks partial text as a length finish on %s', async (finishReason) => {
            replyWith({ content: { parts: [{ text: 'partial' }] }, finishReason });

            const json = await (await makeRequest('gemini-4-argon')).json();

            expect(json.choices[0].message.content).toBe('partial');
            expect(json.choices[0].finish_reason).toBe('length');
        });

        test('leaves a normal finish without a finish reason', async () => {
            replyWith({ content: { parts: [{ text: 'complete' }] }, finishReason: 'STOP' });

            const json = await (await makeRequest('gemini-4-argon')).json();

            expect(json.choices[0].message.content).toBe('complete');
            expect(json.choices[0]).not.toHaveProperty('finish_reason');
        });

        test.each(['MAX_TOKENS', 'CONTINUATION'])('does not call a thinking-only %s reply an empty candidate', async (finishReason) => {
            replyWith({ content: { parts: [{ text: 'thinking', thought: true }] }, finishReason, continuationToken: 'token' });

            const json = await (await makeRequest('gemini-4-argon')).json();

            expect(json.error.message).toBeTruthy();
            expect(json.error.message).not.toContain('Candidate text empty');
        });

        test('keeps the generic error when another finish leaves no reply text', async () => {
            replyWith({ content: { parts: [] }, finishReason: 'SAFETY' });

            const json = await (await makeRequest('gemini-4-argon')).json();

            expect(json.error.message).toContain('Candidate text empty');
        });
    });

    describe('long decode', () => {
        const JSON_HEADERS = { 'Content-Type': 'application/json' };
        const SSE_HEADERS = { 'Content-Type': 'text/event-stream' };

        const candidate = (parts, extra = {}) => ({ content: { role: 'model', parts }, index: 0, ...extra });
        const jsonHop = (parts, extra) => new Response(JSON.stringify({ candidates: [candidate(parts, extra)] }), { status: 200, headers: JSON_HEADERS });
        const sseBody = (...chunks) => chunks.map(chunk => `data: ${JSON.stringify({ candidates: [chunk] })}\r\n\r\n`).join('');
        const sseHop = (...chunks) => new NodeFetchResponse(sseBody(...chunks), { status: 200, headers: SSE_HEADERS });
        const failedHop = () => new Response('{"error":{"message":"overloaded"}}', { status: 503, headers: JSON_HEADERS });
        const networkError = () => new Error('socket hang up');
        const silentHop = () => new NodeFetchResponse(': keep-alive\r\n\r\n', { status: 200, headers: SSE_HEADERS });

        function droppedHop(...chunks) {
            async function* sendThenDrop() {
                yield sseBody(...chunks);
                await new Promise(resolve => setTimeout(resolve, 20));
                throw networkError();
            }
            return new NodeFetchResponse(Readable.from(sendThenDrop(), { objectMode: false }), { status: 200, headers: SSE_HEADERS });
        }

        function replyWithHops(...hops) {
            nodeFetchMock.mockImplementation(async () => {
                const hop = hops.shift();
                if (!hop) {
                    throw new Error('Unexpected extra request');
                }
                if (hop instanceof Error) {
                    throw hop;
                }
                return hop;
            });
        }

        const requestBody = index => JSON.parse(nodeFetchMock.mock.calls[index][1].body);
        const requestUrl = index => String(nodeFetchMock.mock.calls[index][0]);

        async function readStream(response) {
            const text = await response.text();
            const events = text.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
            return {
                raw: text,
                events,
                reply: events.flatMap(event => event.candidates?.[0]?.content?.parts ?? []).filter(part => !part.thought).map(part => part.text).join(''),
                finishes: events.map(event => event.candidates?.[0]?.finishReason).filter(Boolean),
            };
        }

        describe('without streaming', () => {
            test('sends the same request with the token until the reply finishes', async () => {
                replyWithHops(
                    jsonHop([{ text: 'Part one ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' }),
                    jsonHop([{ text: 'and part two ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-2' }),
                    jsonHop([{ text: 'and the end.' }], { finishReason: 'STOP' }),
                );

                const json = await (await makeRequest('gemini-4-argon')).json();

                expect(nodeFetchMock).toHaveBeenCalledTimes(3);
                expect(requestBody(0)).not.toHaveProperty('continuationToken');
                expect(requestBody(1)).toEqual({ ...requestBody(0), continuationToken: 'token-1' });
                expect(requestBody(2)).toEqual({ ...requestBody(0), continuationToken: 'token-2' });
                expect(requestUrl(1)).toBe(requestUrl(0));
                expect(json.choices[0].message.content).toBe('Part one and part two and the end.');
                expect(json.choices[0]).not.toHaveProperty('finish_reason');
                expect(json.responseContent.parts).toHaveLength(3);
            });

            test('restarts the generation lifetime limit for each later request', async () => {
                resumableGeneration = { onCancel: () => () => undefined, extendLifetime: jest.fn() };
                replyWithHops(
                    jsonHop([{ text: 'one ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' }),
                    jsonHop([{ text: 'two ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-2' }),
                    jsonHop([{ text: 'three' }], { finishReason: 'STOP' }),
                );

                const json = await (await makeRequest('gemini-4-argon')).json();

                expect(json.choices[0].message.content).toBe('one two three');
                expect(resumableGeneration.extendLifetime).toHaveBeenCalledTimes(2);
            });

            test('treats a thinking-only request as progress and keeps its parts for history', async () => {
                replyWithHops(
                    jsonHop([{ text: 'thinking', thought: true }, { text: '', thoughtSignature: 'sig-1' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' }),
                    jsonHop([{ text: 'The answer.' }], { finishReason: 'STOP' }),
                );

                const json = await (await makeRequest('gemini-4-argon')).json();

                expect(json.choices[0].message.content).toBe('The answer.');
                expect(json.choices[0]).not.toHaveProperty('finish_reason');
                expect(json.responseContent.parts).toEqual([
                    { text: 'thinking', thought: true },
                    { text: '', thoughtSignature: 'sig-1' },
                    { text: 'The answer.' },
                ]);
            });

            test('adds the part separator inside one request and nothing between requests', async () => {
                replyWithHops(
                    jsonHop([{ text: 'first' }, { text: 'second mid-wo' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' }),
                    jsonHop([{ text: 'rd third' }], { finishReason: 'STOP' }),
                );

                const json = await (await makeRequest('gemini-4-argon')).json();

                expect(json.choices[0].message.content).toBe('first\n\nsecond mid-word third');
            });

            test('adds no separator for a part with no text', async () => {
                replyWithHops(
                    jsonHop([{ text: 'mid-wo' }, { text: '', thoughtSignature: 'sig-1' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' }),
                    jsonHop([{ text: 'rd' }], { finishReason: 'STOP' }),
                );

                const json = await (await makeRequest('gemini-4-argon')).json();

                expect(json.choices[0].message.content).toBe('mid-word');
            });

            test('stops at MAX_TOKENS even though the response carries a token', async () => {
                replyWithHops(jsonHop([{ text: 'partial' }], { finishReason: 'MAX_TOKENS', continuationToken: 'token-1' }));

                const json = await (await makeRequest('gemini-4-argon')).json();

                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
                expect(json.choices[0].message.content).toBe('partial');
                expect(json.choices[0].finish_reason).toBe('length');
            });

            test.each([
                ['an error status', failedHop],
                ['a network error', networkError],
                ['no candidates', () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'OTHER' } }), { status: 200, headers: JSON_HEADERS })],
            ])('keeps the reply so far as a length finish when a later request returns %s', async (_name, createFailure) => {
                replyWithHops(
                    jsonHop([{ text: 'Part one' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' }),
                    createFailure(),
                );

                const response = await makeRequest('gemini-4-argon');
                const json = await response.json();

                expect(response.status).toBe(200);
                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(json.choices[0].message.content).toBe('Part one');
                expect(json.choices[0].finish_reason).toBe('length');
            });

            test('stops when a request hands back the token it was sent with', async () => {
                replyWithHops(
                    jsonHop([{ text: 'one ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' }),
                    jsonHop([{ text: 'two' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' }),
                );

                const json = await (await makeRequest('gemini-4-argon')).json();

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(json.choices[0].message.content).toBe('one two');
                expect(json.choices[0].finish_reason).toBe('length');
            });

            test('stops after the most requests a valid reply can need', async () => {
                let count = 0;
                nodeFetchMock.mockImplementation(async () => jsonHop([{ text: 'x' }], { finishReason: 'CONTINUATION', continuationToken: `token-${++count}` }));

                const json = await (await makeRequest('gemini-4-argon')).json();

                expect(nodeFetchMock).toHaveBeenCalledTimes(32);
                expect(json.choices[0].finish_reason).toBe('length');
            });

            test('caps the first Gemini 4 request and sends the full limit with the token', async () => {
                replyWithHops(
                    jsonHop([{ text: 'one ' }], { finishReason: 'MAX_TOKENS', continuationToken: 'token-1' }),
                    jsonHop([{ text: 'two ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-2' }),
                    jsonHop([{ text: 'three' }], { finishReason: 'STOP' }),
                );

                const json = await (await makeRequest('gemini-4-argon', { max_tokens: 100000 })).json();

                expect(nodeFetchMock).toHaveBeenCalledTimes(3);
                expect(requestBody(0)).not.toHaveProperty('continuationToken');
                expect(requestBody(0).generationConfig.maxOutputTokens).toBe(32768);
                expect(requestBody(1)).toMatchObject({ continuationToken: 'token-1', generationConfig: { maxOutputTokens: 100000 } });
                expect(requestBody(2)).toMatchObject({ continuationToken: 'token-2', generationConfig: { maxOutputTokens: 100000 } });
                expect(requestBody(1).contents).toEqual(requestBody(0).contents);
                expect(json.choices[0].message.content).toBe('one two three');
                expect(json.choices[0]).not.toHaveProperty('finish_reason');
            });

            test('stops once the full limit runs out', async () => {
                replyWithHops(
                    jsonHop([{ text: 'one ' }], { finishReason: 'MAX_TOKENS', continuationToken: 'token-1' }),
                    jsonHop([{ text: 'two' }], { finishReason: 'MAX_TOKENS', continuationToken: 'token-2' }),
                );

                const json = await (await makeRequest('gemini-4-argon', { max_tokens: 40000 })).json();

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(json.choices[0].message.content).toBe('one two');
                expect(json.choices[0].finish_reason).toBe('length');
            });

            test.each([
                ['a limit at the cap', 'gemini-4-argon', 32768],
                ['an older model', 'gemini-3.7-flash', 100000],
            ])('sends %s unchanged and stops at MAX_TOKENS', async (_name, model, maxTokens) => {
                replyWithHops(jsonHop([{ text: 'partial' }], { finishReason: 'MAX_TOKENS', continuationToken: 'token-1' }));

                const json = await (await makeRequest(model, { max_tokens: maxTokens })).json();

                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
                expect(requestBody(0).generationConfig.maxOutputTokens).toBe(maxTokens);
                expect(json.choices[0].finish_reason).toBe('length');
            });
        });

        describe('with streaming', () => {
            const requestStream = options => makeRequest('gemini-4-argon', { stream: true, ...options });

            test('joins the requests into one stream that hides the hop boundary', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'Part one ' }]), candidate([{ text: '' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    sseHop(candidate([{ text: 'and part two.' }]), candidate([{ text: '' }], { finishReason: 'STOP' })),
                );

                const { raw, reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(requestBody(0)).not.toHaveProperty('continuationToken');
                expect(requestBody(1)).toEqual({ ...requestBody(0), continuationToken: 'token-1' });
                expect(requestUrl(1)).toBe(requestUrl(0));
                expect(reply).toBe('Part one and part two.');
                expect(finishes).toEqual(['STOP']);
                expect(raw).not.toContain('token-1');
            });

            test('keeps text from the chunk that ends a request', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'Part one ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    sseHop(candidate([{ text: 'and part two.' }], { finishReason: 'STOP' })),
                );

                const { reply, finishes } = await readStream(await requestStream());

                expect(reply).toBe('Part one and part two.');
                expect(finishes).toEqual(['STOP']);
            });

            test('continues from the newest token when the finish comes on a later chunk with text', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'one ' }], { continuationToken: 'token-1' }), candidate([{ text: 'two ' }], { finishReason: 'CONTINUATION' })),
                    sseHop(candidate([{ text: 'three' }], { finishReason: 'STOP' })),
                );

                const { raw, reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(requestBody(1).continuationToken).toBe('token-1');
                expect(raw).not.toContain('token-1');
                expect(reply).toBe('one two three');
                expect(finishes).toEqual(['STOP']);
            });

            test('does not cap the first streaming request', async () => {
                replyWithHops(sseHop(candidate([{ text: 'ok' }], { finishReason: 'STOP' })));

                await (await requestStream({ max_tokens: 100000 })).text();

                expect(requestBody(0).generationConfig.maxOutputTokens).toBe(100000);
            });

            test('removes checkpoint tokens and leaves a finished stream at one request', async () => {
                replyWithHops(sseHop(
                    candidate([{ text: 'before ' }], { continuationToken: 'checkpoint' }),
                    candidate([{ text: 'after' }]),
                    candidate([{ text: '' }], { finishReason: 'STOP' }),
                ));

                const { raw, reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
                expect(raw).not.toContain('checkpoint');
                expect(reply).toBe('before after');
                expect(finishes).toEqual(['STOP']);
            });

            test('stops at MAX_TOKENS and removes its token', async () => {
                replyWithHops(sseHop(candidate([{ text: 'partial' }], { finishReason: 'MAX_TOKENS', continuationToken: 'token-1' })));

                const { raw, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
                expect(raw).not.toContain('token-1');
                expect(finishes).toEqual(['MAX_TOKENS']);
            });

            test('ends with a cut-off finish when a later request returns an error status', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'Part one' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    failedHop(),
                );

                const response = await requestStream();
                const { reply, finishes } = await readStream(response);

                expect(response.status).toBe(200);
                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(reply).toBe('Part one');
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test('sends a request again when it stops before a new token and before any content', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'one ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    networkError(),
                    droppedHop(),
                    silentHop(),
                    sseHop(candidate([{ text: 'two' }], { finishReason: 'STOP' })),
                );

                const { reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(5);
                expect([1, 2, 3, 4].map(index => requestBody(index).continuationToken)).toEqual(['token-1', 'token-1', 'token-1', 'token-1']);
                expect(reply).toBe('one two');
                expect(finishes).toEqual(['STOP']);
            });

            test('ends with a cut-off finish once the retries run out', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'Part one' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    networkError(),
                    networkError(),
                    networkError(),
                    networkError(),
                );

                const response = await requestStream();
                const { reply, finishes } = await readStream(response);

                expect(response.status).toBe(200);
                expect(nodeFetchMock).toHaveBeenCalledTimes(5);
                expect(reply).toBe('Part one');
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test('starts the retries over after a request brings a new token', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'one ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    networkError(),
                    networkError(),
                    networkError(),
                    sseHop(candidate([{ text: 'two ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-2' })),
                    networkError(),
                    networkError(),
                    networkError(),
                    sseHop(candidate([{ text: 'three' }], { finishReason: 'STOP' })),
                );

                const { reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(9);
                expect(reply).toBe('one two three');
                expect(finishes).toEqual(['STOP']);
            });

            test('does not send a request again after it sent content with no new token', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'one ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    droppedHop(candidate([{ text: 'two' }])),
                );

                const { reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(reply).toBe('one two');
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test.each([
                ['on the chunk with its own token', [candidate([{ text: 'two' }], { continuationToken: 'token-1' })]],
                ['on the chunk before its own token', [candidate([{ text: 'two' }]), candidate([], { continuationToken: 'token-1' })]],
            ])('does not send a request again after it sent content %s', async (_name, chunks) => {
                replyWithHops(
                    sseHop(candidate([{ text: 'one ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    droppedHop(...chunks),
                );

                const { raw, reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(raw).not.toContain('token-1');
                expect(reply).toBe('one two');
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test('does not send a request again after an error event with no new token', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'Part one' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    new NodeFetchResponse(`data: ${JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } })}\r\n\r\n`, { status: 200, headers: SSE_HEADERS }),
                );

                const { events, reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(events.filter(event => event.error)).toHaveLength(1);
                expect(reply).toBe('Part one');
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test('resumes from a new token after an error event', async () => {
                replyWithHops(
                    new NodeFetchResponse(
                        `${sseBody(candidate([{ text: 'seen ' }], { continuationToken: 'checkpoint' }))}data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } })}\r\n\r\n`,
                        { status: 200, headers: SSE_HEADERS },
                    ),
                    sseHop(candidate([{ text: 'and the rest.' }], { finishReason: 'STOP' })),
                );

                const { reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(requestBody(1).continuationToken).toBe('checkpoint');
                expect(reply).toBe('seen and the rest.');
                expect(finishes).toEqual(['STOP']);
            });

            test('forwards the cut-off finish when a request hands back its own token', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'one ' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    sseHop(candidate([{ text: 'two' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                );

                const { reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(reply).toBe('one two');
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test('stops after the most requests a valid reply can need', async () => {
                let count = 0;
                nodeFetchMock.mockImplementation(async () => sseHop(candidate([{ text: 'x' }], { finishReason: 'CONTINUATION', continuationToken: `token-${++count}` })));

                const { finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(32);
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test.each([
                ['an empty part with a signature', { text: '', thoughtSignature: 'sig-1' }],
                ['a part with only a signature', { thoughtSignature: 'sig-1' }],
            ])('resumes a dropped stream from the checkpoint when only %s went out after it', async (_name, part) => {
                replyWithHops(
                    droppedHop(
                        candidate([{ text: 'seen ' }], { continuationToken: 'checkpoint' }),
                        candidate([part]),
                    ),
                    sseHop(candidate([{ text: 'and the rest.' }], { finishReason: 'STOP' })),
                );

                const { reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(requestBody(1).continuationToken).toBe('checkpoint');
                expect(reply).toBe('seen and the rest.');
                expect(finishes).toEqual(['STOP']);
            });

            test('resumes from the checkpoint when the server closes a silent stream', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'seen ' }], { continuationToken: 'checkpoint' })),
                    sseHop(candidate([{ text: 'and the rest.' }], { finishReason: 'STOP' })),
                );

                const { reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(requestBody(1).continuationToken).toBe('checkpoint');
                expect(reply).toBe('seen and the rest.');
                expect(finishes).toEqual(['STOP']);
            });

            test('ends with a cut-off finish when the server closes the stream after text went out past the checkpoint', async () => {
                replyWithHops(sseHop(
                    candidate([{ text: 'seen' }], { continuationToken: 'checkpoint' }),
                    candidate([{ text: ' unsafe to repeat' }]),
                ));

                const { finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test.each([
                ['text', { text: ' unsent twice' }],
                ['a thought', { text: 'thinking', thought: true }],
                ['a function call', { functionCall: { name: 'tool', args: {} } }],
            ])('ends with a cut-off finish when the stream drops after %s went out past the checkpoint', async (_name, part) => {
                replyWithHops(droppedHop(
                    candidate([{ text: 'seen' }], { continuationToken: 'checkpoint' }),
                    candidate([part]),
                ));

                const { finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test('ends with a cut-off finish when a stream drops before any token', async () => {
                replyWithHops(droppedHop(candidate([{ text: 'partial' }])));

                const { reply, finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
                expect(reply).toBe('partial');
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test('ends with a cut-off finish and no retry when a later request blocks the prompt', async () => {
                replyWithHops(
                    sseHop(candidate([{ text: 'Part one' }], { finishReason: 'CONTINUATION', continuationToken: 'token-1' })),
                    new NodeFetchResponse(`data: ${JSON.stringify({ promptFeedback: { blockReason: 'OTHER' } })}\r\n\r\n`, { status: 200, headers: SSE_HEADERS }),
                );

                const { finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(2);
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test('does not resume from a checkpoint after a blocked prompt', async () => {
                replyWithHops(new NodeFetchResponse(
                    `${sseBody(candidate([{ text: 'seen' }], { continuationToken: 'checkpoint' }))}data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })}\r\n\r\n`,
                    { status: 200, headers: SSE_HEADERS },
                ));

                const { finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test('does not continue after a blocked prompt when a finish asks for the next request', async () => {
                replyWithHops(new NodeFetchResponse(
                    `data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })}\r\n\r\n${sseBody(candidate([], { finishReason: 'CONTINUATION', continuationToken: 'token-1' }))}`,
                    { status: 200, headers: SSE_HEADERS },
                ));

                const { finishes } = await readStream(await requestStream());

                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
                expect(finishes).toEqual(['CONTINUATION']);
            });

            test('passes a first request with no token and no finish through unchanged', async () => {
                const body = sseBody(candidate([{ text: 'relay ' }]), candidate([{ text: 'reply' }]));
                replyWithHops(new NodeFetchResponse(body, { status: 200, headers: SSE_HEADERS }));

                const response = await requestStream();

                expect(await response.text()).toBe(body);
                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
            });

            test('passes a failed first request through with its status', async () => {
                replyWithHops(new NodeFetchResponse('{"error":{"message":"bad request"}}', { status: 400, statusText: 'Bad Request', headers: JSON_HEADERS }));

                const response = await requestStream();

                expect(response.status).toBe(400);
                expect(await response.text()).toBe('{"error":{"message":"bad request"}}');
                expect(nodeFetchMock).toHaveBeenCalledTimes(1);
            });
        });

        describe('on Vertex AI', () => {
            const VERTEX = {
                chat_completion_source: CHAT_COMPLETION_SOURCES.VERTEXAI,
                vertexai_auth_mode: 'express',
                vertexai_region: 'us-central1',
            };

            test.each([
                ['gemini-4-argon', 40000, 'v1beta1'],
                ['gemini-4-argon', 32768, 'v1'],
                ['gemini-3.7-flash', 40000, 'v1'],
            ])('sends %s at %i tokens to %s', async (model, maxTokens, version) => {
                replyWithHops(
                    jsonHop([{ text: 'ok' }], { finishReason: 'STOP' }),
                    jsonHop([{ text: 'ok' }], { finishReason: 'STOP' }),
                    jsonHop([{ text: 'ok' }], { finishReason: 'STOP' }),
                );

                await (await makeRequest(model, { ...VERTEX, max_tokens: maxTokens })).json();
                await (await makeRequest(model, { ...VERTEX, max_tokens: maxTokens, vertexai_express_project_id: 'project' })).json();
                await (await makeRequest(model, { ...VERTEX, max_tokens: maxTokens, reverse_proxy: 'http://vertex.invalid', proxy_password: 'test-key' })).json();

                expect(requestUrl(0)).toContain(`us-central1-aiplatform.googleapis.com/${version}/publishers/google/models/${model}:generateContent`);
                expect(requestUrl(1)).toContain(`aiplatform.googleapis.com/${version}/projects/project/locations/us-central1/publishers/google/models/${model}:generateContent`);
                expect(requestUrl(2)).toContain(`vertex.invalid/${version}/publishers/google/models/${model}:generateContent`);
            });

            test('continues a reply on the same URL', async () => {
                replyWithHops(
                    jsonHop([{ text: 'one ' }], { finishReason: 'MAX_TOKENS', continuationToken: 'token-1' }),
                    jsonHop([{ text: 'two' }], { finishReason: 'STOP' }),
                );

                const json = await (await makeRequest('gemini-4-argon', { ...VERTEX, max_tokens: 40000 })).json();

                expect(requestUrl(1)).toBe(requestUrl(0));
                expect(requestUrl(1)).toContain('/v1beta1/');
                expect(json.choices[0].message.content).toBe('one two');
            });
        });
    });

    test('requests image output with a size for Nano Banana 2.1', async () => {
        const response = await makeRequest('gemini-nano-banana-2.1', {
            request_images: true,
            request_image_resolution: '2K',
            request_image_aspect_ratio: '16:9',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.responseModalities).toEqual(['text', 'image']);
        expect(capturedBody.generationConfig.imageConfig).toEqual({ imageSize: '2K', aspectRatio: '16:9' });
    });

    test('omits the image size for gemini-3.1-flash-lite-image, which renders only at 1K', async () => {
        const response = await makeRequest('gemini-3.1-flash-lite-image', {
            request_images: true,
            request_image_resolution: '2K',
            request_image_aspect_ratio: '16:9',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.responseModalities).toEqual(['text', 'image']);
        expect(capturedBody.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9' });
    });
});
