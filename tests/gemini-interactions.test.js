/* eslint-disable playwright/no-duplicate-hooks, playwright/no-conditional-in-test */
import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';
import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { MockServer } from './util/mock-server.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const UPSTREAM_PORT = 3031;
const APP_PORT = 3040;
const UPSTREAM_ORIGIN = `http://127.0.0.1:${UPSTREAM_PORT}`;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

const { default: actualNodeFetch, Response: NodeFetchResponse } = await import('node-fetch');
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

function createProviderFetchSpy(handler) {
    nodeFetchMock.mockClear();
    nodeFetchMock.mockImplementation((url, options) => {
        const href = typeof url === 'string'
            ? url
            : url instanceof URL
                ? url.toString()
                : url?.url ?? String(url);
        if (href.startsWith(UPSTREAM_ORIGIN)) {
            return actualNodeFetch(url, options);
        }
        return handler(href, options);
    });
    return nodeFetchMock;
}

/**
 * Reads an SSE response body into the list of parsed data payloads.
 * @param {Response} response Fetch response
 * @returns {Promise<object[]>} Parsed events
 */
async function readSseEvents(response) {
    const text = await response.text();
    return text
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6).trim())
        .filter(data => data && data !== '[DONE]')
        .map(data => JSON.parse(data));
}

describe('Gemini Interactions API integration', () => {
    /** @type {import('express').Router} */
    let chatCompletionsRouter;
    /** @type {MockServer} */
    let upstream;
    /** @type {import('http').Server} */
    let appServer;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let userDirectories;
    let resumableGeneration = null;
    const tempDirs = [];

    beforeAll(async () => {
        ({ router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js'));

        upstream = new MockServer({ port: UPSTREAM_PORT, host: '127.0.0.1' });
        await upstream.start();
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-gemini-interactions-'));
        tempDirs.push(userRoot);
        userDirectories = {
            root: userRoot,
            backups: userRoot,
        };

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = {
                directories: userDirectories,
            };
            req.resumableGeneration = resumableGeneration;
            next();
        });
        app.use('/api/backends/chat-completions', chatCompletionsRouter);

        await new Promise((resolve) => {
            appServer = app.listen(APP_PORT, '127.0.0.1', resolve);
        });
    });

    afterAll(async () => {
        await upstream.stop();

        if (appServer) {
            await new Promise((resolve, reject) => {
                appServer.close((err) => err ? reject(err) : resolve());
            });
        }

        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /**
     * Sends a generate request through the router to the mock upstream.
     * @param {object} body Request body overrides
     * @returns {Promise<Response>} Fetch response
     */
    async function generate(body) {
        return fetch(`${APP_ORIGIN}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.GEMINI_INTERACTIONS,
                reverse_proxy: UPSTREAM_ORIGIN,
                proxy_password: 'test-key',
                model: 'gemini-3.8-flash',
                stream: false,
                max_tokens: 32,
                messages: [{ role: 'user', content: 'Hello from Interactions.' }],
                ...body,
            }),
        });
    }

    test('posts to the versioned interactions endpoint with the model in the body', async () => {
        const fetchSpy = createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({});
        expect(response.status).toBe(200);

        const [requestedUrl] = fetchSpy.mock.calls[0];
        const href = requestedUrl instanceof URL ? requestedUrl.toString() : String(requestedUrl);
        expect(href).toBe(`${UPSTREAM_ORIGIN}/v1beta/interactions`);

        const outgoing = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(outgoing.model).toBe('gemini-3.8-flash');
        expect(outgoing.store).toBe(false);
        expect(outgoing.stream).toBe(false);
    });

    test('maps system messages to system_instruction and keeps user input as steps', async () => {
        const fetchSpy = createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({
            use_sysprompt: true,
            messages: [
                { role: 'system', content: 'Be concise.' },
                { role: 'user', content: 'Hello from Interactions.' },
            ],
        });
        expect(response.status).toBe(200);

        const outgoing = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(outgoing.system_instruction).toBe('Be concise.');
        expect(outgoing.input).toEqual([
            { type: 'user_input', content: [{ type: 'text', text: 'Hello from Interactions.' }] },
        ]);
    });

    test('normalizes model_output text and retains thought summaries as reasoning_content', async () => {
        createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({});
        expect(response.status).toBe(200);

        const json = await response.json();
        expect(json).toEqual({
            id: 'int-test-1',
            object: 'chat.completion',
            created: expect.any(Number),
            model: 'gemini-3.8-flash',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'Hello from Interactions.',
                        reasoning_content: 'gemini-3.8-flash\n1\n32',
                    },
                    finish_reason: 'stop',
                },
            ],
            usage: {
                prompt_tokens: 12,
                completion_tokens: 5,
                total_tokens: 17,
            },
        });
    });

    test('maps OpenAI function tools to Interactions function declarations and tool_choice', async () => {
        const fetchSpy = createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({
            tools: [{
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get the weather.',
                    parameters: {
                        type: 'object',
                        properties: { location: { type: 'string' } },
                        required: ['location'],
                    },
                },
            }],
            tool_choice: 'required',
        });
        expect(response.status).toBe(200);

        const outgoing = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(outgoing.tools).toEqual([{
            type: 'function',
            name: 'get_weather',
            description: 'Get the weather.',
            parameters: {
                type: 'object',
                properties: { location: { type: 'string' } },
                required: ['location'],
            },
        }]);
        expect(outgoing.generation_config.tool_choice).toBe('any');
    });

    test('round-trips assistant tool calls and tool results as steps', async () => {
        const fetchSpy = createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({
            messages: [
                { role: 'user', content: 'What is the weather?' },
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '{"location":"Boston, MA"}' },
                    }],
                },
                { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
            ],
        });
        expect(response.status).toBe(200);

        const outgoing = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(outgoing.input).toEqual([
            { type: 'user_input', content: [{ type: 'text', text: 'What is the weather?' }] },
            { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: { location: 'Boston, MA' } },
            { type: 'function_result', call_id: 'call_1', name: 'get_weather', result: 'Sunny' },
        ]);
    });

    test('requests reasoning summaries when include_reasoning is set', async () => {
        const fetchSpy = createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({ include_reasoning: true, reasoning_effort: 'high' });
        expect(response.status).toBe(200);

        const outgoing = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(outgoing.generation_config.thinking_summaries).toBe('auto');
        expect(outgoing.generation_config.thinking_level).toBe('high');
    });

    test('omits deprecated sampling parameters for newer Gemini models', async () => {
        const fetchSpy = createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({ model: 'gemini-3.8-flash', temperature: 0.7, top_p: 0.9 });
        expect(response.status).toBe(200);

        const outgoing = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(outgoing.generation_config.temperature).toBeUndefined();
        expect(outgoing.generation_config.top_p).toBeUndefined();
    });

    test('forwards sampling parameters for models that still accept them', async () => {
        const fetchSpy = createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({ model: 'gemini-2.5-flash', temperature: 0.7, top_p: 0.9 });
        expect(response.status).toBe(200);

        const outgoing = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(outgoing.generation_config.temperature).toBe(0.7);
        expect(outgoing.generation_config.top_p).toBe(0.9);
    });

    test('sends structured output as a typed response_format', async () => {
        const fetchSpy = createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const schema = { type: 'object', properties: { winner: { type: 'string' } }, required: ['winner'] };
        const response = await generate({ json_schema: { value: schema } });
        expect(response.status).toBe(200);

        const outgoing = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(outgoing.response_format).toEqual({
            type: 'text',
            mime_type: 'application/json',
            schema: schema,
        });
    });

    test('streams reasoning summaries and text as Chat Completions deltas', async () => {
        createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({ stream: true });
        expect(response.status).toBe(200);

        const events = await readSseEvents(response);
        expect(events).toHaveLength(2);
        expect(events.map(event => event.object)).toEqual(['chat.completion.chunk', 'chat.completion.chunk']);
        expect(events[0].choices).toEqual([
            { index: 0, delta: { reasoning_content: 'gemini-3.8-flash stream' }, finish_reason: null },
        ]);
        expect(events[1].choices).toEqual([
            { index: 0, delta: { content: 'Hello from Interactions.' }, finish_reason: null },
        ]);
    });

    test('turns off the fetch idle timeout so a long thinking pass can stay silent', async () => {
        const fetchSpy = createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({});
        expect(response.status).toBe(200);

        expect(fetchSpy.mock.calls[0][1].timeout).toBe(0);
    });

    test('sends the highest documented thinking level when Gemini 4 is asked for max', async () => {
        const fetchSpy = createProviderFetchSpy(() => {
            throw new Error('Unexpected provider call');
        });
        const response = await generate({ model: 'gemini-4-argon', reasoning_effort: 'max' });
        expect(response.status).toBe(200);

        const outgoing = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(outgoing.generation_config.thinking_level).toBe('high');
    });

    describe('interactions that end early', () => {
        const PROVIDER_ORIGIN = 'http://interactions.invalid';
        const CUT_OFF_STATUSES = ['requires_continuation', 'incomplete'];

        function replyWithEvents(...events) {
            createProviderFetchSpy(() => new NodeFetchResponse(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            }));
        }

        test.each(CUT_OFF_STATUSES)('reports a non-streamed %s interaction as a length finish', async (status) => {
            createProviderFetchSpy(() => new NodeFetchResponse(JSON.stringify({
                id: 'int-cut-off',
                status,
                steps: [{ type: 'model_output', content: [{ type: 'text', text: 'partial' }] }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

            const json = await (await generate({ reverse_proxy: PROVIDER_ORIGIN })).json();

            expect(json.choices[0].message.content).toBe('partial');
            expect(json.choices[0].finish_reason).toBe('length');
        });

        test.each(CUT_OFF_STATUSES)('ends a streamed %s interaction with a length finish', async (status) => {
            replyWithEvents(
                { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'partial' } },
                { event_type: 'interaction.completed', interaction: { id: 'int-cut-off', status } },
            );

            const events = await readSseEvents(await generate({ stream: true, reverse_proxy: PROVIDER_ORIGIN }));

            expect(events.map(event => event.choices[0])).toEqual([
                { index: 0, delta: { content: 'partial' }, finish_reason: null },
                { index: 0, delta: {}, finish_reason: 'length' },
            ]);
        });

        test('reads a cut-off status from a status update event', async () => {
            replyWithEvents(
                { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'partial' } },
                { event_type: 'interaction.status_update', interaction_id: 'int-cut-off', status: 'requires_continuation' },
                { event_type: 'interaction.completed', interaction: { id: 'int-cut-off' } },
            );

            const events = await readSseEvents(await generate({ stream: true, reverse_proxy: PROVIDER_ORIGIN }));

            expect(events.at(-1).choices[0].finish_reason).toBe('length');
        });

        test('lets the final status replace an earlier cut-off status', async () => {
            replyWithEvents(
                { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'complete' } },
                { event_type: 'interaction.status_update', interaction_id: 'int-resumed', status: 'requires_continuation' },
                { event_type: 'interaction.completed', interaction: { id: 'int-resumed', status: 'completed' } },
            );

            const events = await readSseEvents(await generate({ stream: true, reverse_proxy: PROVIDER_ORIGIN }));

            expect(events.map(event => event.choices[0].finish_reason)).toEqual([null]);
        });
    });

    describe('long decode', () => {
        const PROVIDER_ORIGIN = 'http://interactions.invalid';
        const JSON_HEADERS = { 'Content-Type': 'application/json' };
        const SSE_HEADERS = { 'Content-Type': 'text/event-stream' };

        const textDelta = text => ({ event_type: 'step.delta', index: 0, delta: { type: 'text', text } });
        const completed = (status, token) => ({ event_type: 'interaction.completed', interaction: { id: 'int', status, ...(token ? { continuation_token: token } : {}) } });
        const statusUpdate = (status, token) => ({ event_type: 'interaction.status_update', interaction_id: 'int', status, ...(token ? { continuation_token: token } : {}) });
        const sseBody = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
        const sseHop = (...events) => new NodeFetchResponse(sseBody(events), { status: 200, headers: SSE_HEADERS });
        const jsonHop = interaction => new NodeFetchResponse(JSON.stringify(interaction), { status: 200, headers: JSON_HEADERS });
        const textStep = text => ({ type: 'model_output', content: [{ type: 'text', text }] });

        function droppedHop(...events) {
            async function* sendThenDrop() {
                yield sseBody(events);
                await new Promise(resolve => setTimeout(resolve, 20));
                throw new Error('socket hang up');
            }
            return new NodeFetchResponse(Readable.from(sendThenDrop(), { objectMode: false }), { status: 200, headers: SSE_HEADERS });
        }

        function replyWithHops(...hops) {
            return createProviderFetchSpy(() => {
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

        const requestBody = (fetchSpy, index) => JSON.parse(fetchSpy.mock.calls[index][1].body);
        const replyText = events => events.map(event => event.choices[0].delta?.content ?? '').join('');
        const finishes = events => events.map(event => event.choices[0].finish_reason).filter(Boolean);

        afterEach(() => {
            resumableGeneration = null;
        });

        describe('without streaming', () => {
            test('restarts the generation lifetime limit for each later request', async () => {
                resumableGeneration = { onCancel: () => () => undefined, extendLifetime: jest.fn() };
                replyWithHops(
                    jsonHop({ id: 'int-1', status: 'requires_continuation', continuation_token: 'token-1', steps: [textStep('one ')] }),
                    jsonHop({ id: 'int-2', status: 'completed', steps: [textStep('two')] }),
                );

                const json = await (await generate({ reverse_proxy: PROVIDER_ORIGIN })).json();

                expect(json.choices[0].message.content).toBe('one two');
                expect(resumableGeneration.extendLifetime).toHaveBeenCalledTimes(1);
            });

            test('resends the input with the token and keeps the request stateless', async () => {
                const fetchSpy = replyWithHops(
                    jsonHop({ id: 'int-1', status: 'requires_continuation', continuation_token: 'token-1', steps: [textStep('Part one ')], usage: { total_input_tokens: 10, total_output_tokens: 20, total_tokens: 30 } }),
                    jsonHop({ id: 'int-2', status: 'requires_continuation', continuation_token: 'token-2', steps: [{ type: 'thought', summary: [{ type: 'text', text: 'thinking' }] }], usage: { total_input_tokens: 15, total_output_tokens: 0, total_tokens: 15 } }),
                    jsonHop({ id: 'int-3', status: 'completed', steps: [textStep('and part two.')], usage: { total_input_tokens: 30, total_output_tokens: 5, total_tokens: 35 } }),
                );

                const json = await (await generate({ reverse_proxy: PROVIDER_ORIGIN })).json();

                expect(fetchSpy).toHaveBeenCalledTimes(3);
                const first = requestBody(fetchSpy, 0);
                expect(first).not.toHaveProperty('continuation_token');
                expect(first.store).toBe(false);
                expect(requestBody(fetchSpy, 1)).toEqual({ ...first, continuation_token: 'token-1' });
                expect(requestBody(fetchSpy, 2)).toEqual({ ...first, continuation_token: 'token-2' });
                expect(requestBody(fetchSpy, 1)).not.toHaveProperty('previous_interaction_id');
                expect(json.choices[0].message.content).toBe('Part one and part two.');
                expect(json.choices[0].message.reasoning_content).toBe('thinking');
                expect(json.choices[0].finish_reason).toBe('stop');
                expect(json.usage).toEqual({ prompt_tokens: 55, completion_tokens: 25, total_tokens: 80 });
            });

            test('stops at incomplete even though the interaction carries a token', async () => {
                const fetchSpy = replyWithHops(jsonHop({ id: 'int-1', status: 'incomplete', continuation_token: 'token-1', steps: [textStep('partial')] }));

                const json = await (await generate({ reverse_proxy: PROVIDER_ORIGIN })).json();

                expect(fetchSpy).toHaveBeenCalledTimes(1);
                expect(json.choices[0].finish_reason).toBe('length');
            });

            test.each([
                ['an error status', () => new NodeFetchResponse('{"error":{"message":"overloaded"}}', { status: 503, headers: JSON_HEADERS })],
                ['a network error', () => new Error('socket hang up')],
            ])('keeps the reply so far as a length finish when a later request returns %s', async (_name, createFailure) => {
                const fetchSpy = replyWithHops(
                    jsonHop({ id: 'int-1', status: 'requires_continuation', continuation_token: 'token-1', steps: [textStep('Part one')] }),
                    createFailure(),
                );

                const json = await (await generate({ reverse_proxy: PROVIDER_ORIGIN })).json();

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(json.choices[0].message.content).toBe('Part one');
                expect(json.choices[0].finish_reason).toBe('length');
            });

            test('stops when a request hands back the token it was sent with', async () => {
                const fetchSpy = replyWithHops(
                    jsonHop({ id: 'int-1', status: 'requires_continuation', continuation_token: 'token-1', steps: [textStep('one ')] }),
                    jsonHop({ id: 'int-2', status: 'requires_continuation', continuation_token: 'token-1', steps: [textStep('two')] }),
                );

                const json = await (await generate({ reverse_proxy: PROVIDER_ORIGIN })).json();

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(json.choices[0].message.content).toBe('one two');
                expect(json.choices[0].finish_reason).toBe('length');
            });
        });

        describe('with streaming', () => {
            const requestStream = () => generate({ stream: true, reverse_proxy: PROVIDER_ORIGIN });

            test('joins the requests into one stream that hides the hop boundary', async () => {
                const fetchSpy = replyWithHops(
                    sseHop({ event_type: 'interaction.created', interaction: { id: 'int-1', status: 'in_progress' } }, textDelta('Part one '), completed('requires_continuation', 'token-1')),
                    sseHop({ event_type: 'interaction.created', interaction: { id: 'int-2', status: 'in_progress' } }, textDelta('and part two.'), completed('completed')),
                );

                const response = await requestStream();
                const raw = await response.clone().text();
                const events = await readSseEvents(response);

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                const first = requestBody(fetchSpy, 0);
                expect(first).not.toHaveProperty('continuation_token');
                expect(requestBody(fetchSpy, 1)).toEqual({ ...first, continuation_token: 'token-1' });
                expect(replyText(events)).toBe('Part one and part two.');
                expect(finishes(events)).toEqual([]);
                expect(raw.match(/\[DONE\]/g)).toHaveLength(1);
                expect(raw.trim().endsWith('data: [DONE]')).toBe(true);
            });

            test('ignores a done marker from a request that ended without a final event', async () => {
                const fetchSpy = replyWithHops(
                    new NodeFetchResponse(`${sseBody([textDelta('Part one '), statusUpdate('requires_continuation', 'token-1')])}data: [DONE]\n\n`, { status: 200, headers: SSE_HEADERS }),
                    sseHop(textDelta('and part two.'), completed('completed')),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(replyText(events)).toBe('Part one and part two.');
                expect(finishes(events)).toEqual([]);
            });

            test('stops at incomplete even though the interaction carries a token', async () => {
                const fetchSpy = replyWithHops(sseHop(textDelta('partial'), completed('incomplete', 'token-1')));

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(1);
                expect(finishes(events)).toEqual(['length']);
            });

            test('ends with a length finish when a later request returns an error status', async () => {
                const fetchSpy = replyWithHops(
                    sseHop(textDelta('Part one'), completed('requires_continuation', 'token-1')),
                    new NodeFetchResponse('{"error":{"message":"overloaded"}}', { status: 503, headers: JSON_HEADERS }),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(replyText(events)).toBe('Part one');
                expect(finishes(events)).toEqual(['length']);
            });

            test('sends a request again when it stops before a new token and before any content', async () => {
                const fetchSpy = replyWithHops(
                    sseHop(textDelta('one '), completed('requires_continuation', 'token-1')),
                    new Error('socket hang up'),
                    droppedHop(),
                    droppedHop({ event_type: 'interaction.created', interaction: { id: 'int-2', status: 'in_progress' } }),
                    sseHop(textDelta('two'), completed('completed')),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(5);
                expect([1, 2, 3, 4].map(index => requestBody(fetchSpy, index).continuation_token)).toEqual(['token-1', 'token-1', 'token-1', 'token-1']);
                expect(replyText(events)).toBe('one two');
                expect(finishes(events)).toEqual([]);
            });

            test('ends with a length finish once the retries run out', async () => {
                const fetchSpy = replyWithHops(
                    sseHop(textDelta('Part one'), completed('requires_continuation', 'token-1')),
                    new Error('socket hang up'),
                    new Error('socket hang up'),
                    new Error('socket hang up'),
                    new Error('socket hang up'),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(5);
                expect(replyText(events)).toBe('Part one');
                expect(finishes(events)).toEqual(['length']);
            });

            test('does not send a request again after it sent content with no new token', async () => {
                const fetchSpy = replyWithHops(
                    sseHop(textDelta('one '), completed('requires_continuation', 'token-1')),
                    droppedHop(textDelta('two')),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(replyText(events)).toBe('one two');
                expect(finishes(events)).toEqual(['length']);
            });

            test('does not send a request again after text when a status update repeats its token', async () => {
                const fetchSpy = replyWithHops(
                    sseHop(textDelta('one '), completed('requires_continuation', 'token-1')),
                    droppedHop(textDelta('two'), statusUpdate('in_progress', 'token-1')),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(replyText(events)).toBe('one two');
                expect(finishes(events)).toEqual(['length']);
            });

            test('stops when a status update asks for the next request with the token the request started with', async () => {
                const fetchSpy = replyWithHops(
                    sseHop(textDelta('one '), completed('requires_continuation', 'token-1')),
                    sseHop(statusUpdate('requires_continuation', 'token-1')),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(replyText(events)).toBe('one ');
                expect(finishes(events)).toEqual(['length']);
            });

            test('continues when a status update asks for the next request with a new token', async () => {
                const fetchSpy = replyWithHops(
                    sseHop(textDelta('one '), statusUpdate('requires_continuation', 'token-1')),
                    sseHop(textDelta('two'), completed('completed')),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(requestBody(fetchSpy, 1).continuation_token).toBe('token-1');
                expect(replyText(events)).toBe('one two');
                expect(finishes(events)).toEqual([]);
            });

            test('still warns when the stream drops after a created event with a status it does not know', async () => {
                const fetchSpy = replyWithHops(droppedHop({ event_type: 'interaction.created', interaction: { id: 'int', status: 'queued' } }, textDelta('partial')));

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(1);
                expect(replyText(events)).toBe('partial');
                expect(finishes(events)).toEqual(['length']);
            });

            test('forwards the cut-off status when a request hands back its own token', async () => {
                const fetchSpy = replyWithHops(
                    sseHop(textDelta('one '), completed('requires_continuation', 'token-1')),
                    sseHop(textDelta('two'), completed('requires_continuation', 'token-1')),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(replyText(events)).toBe('one two');
                expect(finishes(events)).toEqual(['length']);
            });

            test('resumes a dropped stream from a checkpoint when nothing visible went out after it', async () => {
                const fetchSpy = replyWithHops(
                    droppedHop(textDelta('seen '), statusUpdate('in_progress', 'checkpoint')),
                    sseHop(textDelta('and the rest.'), completed('completed')),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(requestBody(fetchSpy, 1).continuation_token).toBe('checkpoint');
                expect(replyText(events)).toBe('seen and the rest.');
                expect(finishes(events)).toEqual([]);
            });

            test('reads a checkpoint from an interaction object inside the event', async () => {
                const fetchSpy = replyWithHops(
                    droppedHop(textDelta('seen '), { event_type: 'interaction.status_update', interaction: { id: 'int', status: 'in_progress', continuation_token: 'checkpoint' } }),
                    sseHop(textDelta('and the rest.'), completed('completed')),
                );

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(2);
                expect(requestBody(fetchSpy, 1).continuation_token).toBe('checkpoint');
                expect(replyText(events)).toBe('seen and the rest.');
            });

            test('ends with a length finish when the stream drops after text went out past the checkpoint', async () => {
                const fetchSpy = replyWithHops(droppedHop(statusUpdate('in_progress', 'checkpoint'), textDelta('unsafe to repeat')));

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(1);
                expect(finishes(events)).toEqual(['length']);
            });

            test('takes a final status from a status update and does not resume', async () => {
                const fetchSpy = replyWithHops(sseHop(statusUpdate('in_progress', 'checkpoint'), statusUpdate('completed')));

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(1);
                expect(finishes(events)).toEqual([]);
            });

            test('does not resume after an error event', async () => {
                const fetchSpy = replyWithHops(sseHop(statusUpdate('in_progress', 'checkpoint'), { event_type: 'error', error: { message: 'failed' } }));

                const events = await readSseEvents(await requestStream());

                expect(fetchSpy).toHaveBeenCalledTimes(1);
                expect(finishes(events)).toEqual(['length']);
            });

            test('passes a failed first request through with its status', async () => {
                const fetchSpy = replyWithHops(new NodeFetchResponse('{"error":{"message":"bad request"}}', { status: 400, statusText: 'Bad Request', headers: JSON_HEADERS }));

                const response = await requestStream();

                expect(response.status).toBe(400);
                expect(fetchSpy).toHaveBeenCalledTimes(1);
            });
        });
    });

    test('lists models through the shared Google catalog for the interactions source', async () => {
        const response = await fetch(`${APP_ORIGIN}/api/backends/chat-completions/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.GEMINI_INTERACTIONS,
                reverse_proxy: UPSTREAM_ORIGIN,
                proxy_password: 'test-key',
            }),
        });

        expect(response.status).toBe(200);
    });
});
