/* eslint-disable playwright/no-duplicate-hooks */
import { beforeAll, afterAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';
import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { MockServer } from './util/mock-server.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const actualNodeFetch = (await import('node-fetch')).default;
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

function resetNodeFetchMock() {
    nodeFetchMock.mockImplementation((url, options) => actualNodeFetch(url, options));
}

function createProviderFetchSpy(handler) {
    nodeFetchMock.mockClear();
    nodeFetchMock.mockImplementation((url, options) => {
        const href = typeof url === 'string'
            ? url
            : url instanceof URL
                ? url.toString()
                : url?.url ?? String(url);
        if (href.startsWith('http://127.0.0.1:3001')) {
            return actualNodeFetch(url, options);
        }
        return handler(href, options);
    });
    return nodeFetchMock;
}

function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('OpenAI Responses integration', () => {
    /** @type {import('express').Router} */
    let chatCompletionsRouter;
    /** @type {MockServer} */
    let upstream;
    /** @type {import('http').Server} */
    let appServer;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let userDirectories;
    let SecretManager;
    let SECRET_KEYS;
    const tempDirs = [];

    beforeAll(async () => {
        ({ SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js'));
        ({ router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js'));

        upstream = new MockServer({ port: 3001, host: '127.0.0.1' });
        await upstream.start();
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-openai-responses-'));
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
            appServer = app.listen(3010, '127.0.0.1', resolve);
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

    test('status accepts OpenAI Responses using the OpenAI models endpoint', async () => {
        const response = await fetch('http://127.0.0.1:3010/api/backends/chat-completions/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                reverse_proxy: 'http://127.0.0.1:3001/v1/',
                proxy_password: 'test-key',
            }),
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({
            data: [
                { id: 'gpt-4o-mini' },
                { id: 'gpt-5.4' },
            ],
        });
    });

    test('generate proxies OpenAI Responses requests to /v1/responses even with trailing slash reverse proxy', async () => {
        const response = await fetch('http://127.0.0.1:3010/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                reverse_proxy: 'http://127.0.0.1:3001/v1/',
                proxy_password: 'test-key',
                model: 'gpt-5.4',
                stream: false,
                temperature: 1,
                max_tokens: 32,
                top_p: 1,
                messages: [
                    { role: 'system', content: 'Be concise.' },
                    { role: 'user', content: 'Hello from Responses.' },
                ],
            }),
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({
            id: 'resp-test-1',
            object: 'chat.completion',
            created: expect.any(Number),
            model: 'gpt-5.4',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'Hello from Responses.',
                        reasoning_content: 'gpt-5.4\n1\n32',
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

    test('logs full Responses payloads only when prompt logging is enabled', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        try {
            const quietResponse = await fetch('http://127.0.0.1:3010/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                    reverse_proxy: 'http://127.0.0.1:3001/v1/',
                    proxy_password: 'test-key',
                    model: 'gpt-5.4',
                    stream: false,
                    temperature: 1,
                    max_tokens: 32,
                    top_p: 1,
                    messages: [
                        { role: 'user', content: 'Hidden backend prompt text.' },
                    ],
                }),
            });

            expect(quietResponse.status).toBe(200);
            expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Hidden backend prompt text.');

            logSpy.mockClear();

            const verboseResponse = await fetch('http://127.0.0.1:3010/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                    reverse_proxy: 'http://127.0.0.1:3001/v1/',
                    proxy_password: 'test-key',
                    model: 'gpt-5.4',
                    stream: false,
                    temperature: 1,
                    max_tokens: 32,
                    top_p: 1,
                    log_prompts: true,
                    messages: [
                        { role: 'user', content: 'Visible backend prompt text.' },
                    ],
                }),
            });

            expect(verboseResponse.status).toBe(200);
            const logText = logSpy.mock.calls.flat().join('\n');
            expect(logText).toContain('[ChatCompletions] OpenAI Responses API request payload:');
            expect(logText).toContain('Visible backend prompt text.');
        } finally {
            logSpy.mockRestore();
        }
    });

    test('generate resolves OpenAI Responses profile secrets by secret_id', async () => {
        const manager = new SecretManager(userDirectories);
        const profileSecretId = manager.writeSecret(SECRET_KEYS.OPENAI, 'profile-openai-key', 'Profile OpenAI');
        manager.writeSecret(SECRET_KEYS.OPENAI, 'active-openai-key', 'Active OpenAI');
        const providerFetch = createProviderFetchSpy((url, options) => {
            expect(url).toBe('https://api.openai.com/v1/responses');
            expect(options.headers.Authorization).toBe('Bearer profile-openai-key');
            return Promise.resolve(jsonResponse({
                id: 'resp-secret-test',
                model: 'gpt-5.4',
                status: 'completed',
                output: [
                    {
                        type: 'message',
                        content: [
                            {
                                type: 'output_text',
                                text: 'Used selected profile secret.',
                            },
                        ],
                    },
                ],
            }));
        });

        try {
            const response = await fetch('http://127.0.0.1:3010/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                    secret_id: profileSecretId,
                    model: 'gpt-5.4',
                    stream: false,
                    temperature: 1,
                    max_tokens: 32,
                    top_p: 1,
                    messages: [
                        { role: 'user', content: 'Use the profile secret.' },
                    ],
                }),
            });

            expect(response.status).toBe(200);
            expect(providerFetch).toHaveBeenCalledTimes(1);
            const json = await response.json();
            expect(json.choices[0].message.content).toBe('Used selected profile secret.');
        } finally {
            resetNodeFetchMock();
        }
    });

    test('generate resolves OpenRouter profile secrets by secret_id', async () => {
        const manager = new SecretManager(userDirectories);
        const profileSecretId = manager.writeSecret(SECRET_KEYS.OPENROUTER, 'profile-openrouter-key', 'Profile OpenRouter');
        manager.writeSecret(SECRET_KEYS.OPENROUTER, 'active-openrouter-key', 'Active OpenRouter');
        const providerFetch = createProviderFetchSpy((url, options) => {
            expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
            expect(options.headers.Authorization).toBe('Bearer profile-openrouter-key');
            return Promise.resolve(jsonResponse({
                choices: [
                    {
                        finish_reason: 'stop',
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: 'Used selected OpenRouter secret.',
                        },
                    },
                ],
                created: 0,
                model: 'openrouter/test',
            }));
        });

        try {
            const response = await fetch('http://127.0.0.1:3010/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENROUTER,
                    secret_id: profileSecretId,
                    model: 'openrouter/test',
                    stream: false,
                    temperature: 1,
                    max_tokens: 32,
                    top_p: 1,
                    messages: [
                        { role: 'user', content: 'Use the OpenRouter profile secret.' },
                    ],
                }),
            });

            expect(response.status).toBe(200);
            expect(providerFetch).toHaveBeenCalledTimes(1);
            const json = await response.json();
            expect(json.choices[0].message.content).toBe('Used selected OpenRouter secret.');
        } finally {
            resetNodeFetchMock();
        }
    });

    test.each([CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES])('sends Astra reasoning-model requests through %s', async (source) => {
        const isResponses = source === CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES;
        const manager = new SecretManager(userDirectories);
        const secretId = manager.writeSecret(SECRET_KEYS.OPENAI, 'astra-test-key', 'Astra test');
        const messages = [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: [
                { type: 'text', text: 'Describe this image.' },
                { type: 'image_url', image_url: { url: 'https://example.com/test.png' } },
            ] },
        ];
        const providerFetch = createProviderFetchSpy((_url, options) => {
            const body = JSON.parse(options.body);
            return Promise.resolve(jsonResponse(isResponses ? upstream.handleResponses(body) : upstream.handleChatCompletions(body)));
        });

        try {
            for (const [effort, limits, expectedLimit] of [
                ['low', { max_tokens: 32 }, 32],
                ['medium', { max_completion_tokens: 64 }, 64],
                ['high', { max_tokens: 32, max_completion_tokens: 64 }, 32],
                ['xhigh', { max_tokens: 32 }, 32],
                ['max', { max_tokens: 32 }, 32],
            ]) {
                const response = await fetch('http://127.0.0.1:3010/api/backends/chat-completions/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_completion_source: source,
                        secret_id: secretId,
                        model: 'gpt-6-astra',
                        messages,
                        reasoning_effort: effort,
                        stream: false,
                        ...limits,
                        temperature: 0.7,
                        top_p: 0.9,
                        frequency_penalty: 0.2,
                        presence_penalty: 0.3,
                        logit_bias: { 42: 1 },
                        stop: ['STOP'],
                        logprobs: 5,
                        top_logprobs: 5,
                        tools: [{ type: 'function', function: { name: 'test', parameters: { type: 'object', properties: {} } } }],
                        tool_choice: 'auto',
                    }),
                });

                expect(response.status).toBe(200);
                expect((await response.json()).model).toBe('gpt-6-astra');
                const [url, options] = providerFetch.mock.calls.at(-1);
                const body = JSON.parse(options.body);
                expect(url).toBe(`https://api.openai.com/v1/${isResponses ? 'responses' : 'chat/completions'}`);
                expect(options.headers.Authorization).toBe('Bearer astra-test-key');
                expect(body[isResponses ? 'max_output_tokens' : 'max_completion_tokens']).toBe(expectedLimit);
                expect(isResponses ? body.reasoning.effort : body.reasoning_effort).toBe(effort);
                expect(body.stream).toBe(false);
                for (const key of ['max_tokens', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'stop', 'logprobs', 'top_logprobs', 'tools', 'tool_choice']) {
                    expect(body).not.toHaveProperty(key);
                }
                expect(body).toEqual(expect.objectContaining(isResponses ? {
                    store: false,
                    instructions: 'Be concise.',
                    input: [{ role: 'user', content: [
                        { type: 'input_text', text: 'Describe this image.' },
                        { type: 'input_image', image_url: 'https://example.com/test.png' },
                    ] }],
                } : { messages }));
            }
            expect(providerFetch).toHaveBeenCalledTimes(5);
        } finally {
            resetNodeFetchMock();
        }
    });

    test('uses the GPT-5 token-count estimate for Astra', async () => {
        const { getTokenizerModel } = await import('../src/endpoints/tokenizers.js');
        expect(getTokenizerModel('gpt-6-astra')).toBe(getTokenizerModel('gpt-5.6-sol'));
    });

    test.each(['gpt-5.4', 'gpt-6-astra'])('streams %s Responses API chunks as Chat Completions SSE', async (model) => {
        const response = await fetch('http://127.0.0.1:3010/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                reverse_proxy: 'http://127.0.0.1:3001/v1/',
                proxy_password: 'test-key',
                model,
                stream: true,
                temperature: 1,
                max_tokens: 32,
                top_p: 1,
                messages: [
                    { role: 'user', content: 'Stream from Responses.' },
                ],
            }),
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');

        const text = await response.text();
        expect(text).toContain('data: [DONE]');
        const payloads = text
            .split('\n')
            .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
            .map(line => JSON.parse(line.slice(6)));

        expect(payloads).toEqual(expect.arrayContaining([
            expect.objectContaining({
                object: 'chat.completion.chunk',
                choices: [expect.objectContaining({ delta: { reasoning_content: `${model} stream` } })],
            }),
            expect.objectContaining({
                object: 'chat.completion.chunk',
                choices: [expect.objectContaining({ delta: { content: 'Hello from Responses.' } })],
            }),
        ]));
    });

    test('does not log expected Responses stream aborts as errors', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const controller = new AbortController();

        const response = await fetch('http://127.0.0.1:3010/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                reverse_proxy: 'http://127.0.0.1:3001/v1/',
                proxy_password: 'test-key',
                model: 'gpt-5.4-slow',
                stream: true,
                temperature: 1,
                max_tokens: 32,
                top_p: 1,
                messages: [
                    { role: 'user', content: 'Abort this stream.' },
                ],
            }),
        });

        expect(response.status).toBe(200);
        controller.abort();
        await response.text().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(errorSpy).not.toHaveBeenCalledWith(
            'Responses API stream error:',
            expect.anything(),
        );

        errorSpy.mockRestore();
    });
});
