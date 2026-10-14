/* eslint-disable playwright/no-duplicate-hooks, playwright/no-conditional-in-test */
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';
import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { MockServer } from './util/mock-server.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const UPSTREAM_PORT = 3031;
const APP_PORT = 3040;
const UPSTREAM_ORIGIN = `http://127.0.0.1:${UPSTREAM_PORT}`;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

const actualNodeFetch = (await import('node-fetch')).default;
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
