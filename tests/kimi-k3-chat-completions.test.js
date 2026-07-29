import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
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

describe('Kimi K3 chat completion requests', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let capturedBody;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-kimi-k3-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-kimi-k3-user-'));
        tempDirs.push(userRoot);

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: userRoot, backups: userRoot } };
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
        nodeFetchMock.mockClear();
        nodeFetchMock.mockImplementation(async (_url, options) => {
            capturedBody = JSON.parse(options?.body ?? '{}');
            return new Response(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: ' continuation' }, finish_reason: 'stop' }],
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

    function makeRequest(source, overrides = {}) {
        return fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: source,
                custom_url: 'https://custom.kimi.test/v1',
                reverse_proxy: 'https://api.moonshot.test/v1',
                proxy_password: 'test-key',
                model: 'kimi-k3',
                stream: false,
                temperature: 1,
                top_p: 0.95,
                presence_penalty: 0,
                frequency_penalty: 0,
                n: 3,
                max_tokens: 4096,
                messages: [
                    { role: 'user', content: 'Question' },
                    { role: 'assistant', content: 'Prefill' },
                ],
                ...overrides,
            }),
        });
    }

    function expectFixedParametersOmitted() {
        expect(capturedBody.temperature).toBeUndefined();
        expect(capturedBody.top_p).toBeUndefined();
        expect(capturedBody.presence_penalty).toBeUndefined();
        expect(capturedBody.frequency_penalty).toBeUndefined();
        expect(capturedBody.n).toBeUndefined();
    }

    test('marks native Moonshot K3 prefill as partial and omits unsupported parameters', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.MOONSHOT);

        expect(response.status).toBe(200);
        expect(capturedBody.messages.at(-1)).toEqual({
            role: 'assistant',
            content: 'Prefill',
            partial: true,
        });
        expect(capturedBody.thinking).toBeUndefined();
        expectFixedParametersOmitted();
    });

    test('marks namespaced Custom K3 prefill as partial', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            model: 'moonshotai/Kimi-K3',
            custom_include_body: 'thinking:\n  type: enabled',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.messages.at(-1).partial).toBe(true);
        expect(capturedBody.thinking).toBeUndefined();
        expectFixedParametersOmitted();
    });

    test('marks the final assistant message supplied by Custom YAML', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            custom_include_body: [
                'messages:',
                '  - role: user',
                '    content: YAML question',
                '  - role: assistant',
                '    content: YAML prefill',
            ].join('\n'),
        });

        expect(response.status).toBe(200);
        expect(capturedBody.messages.at(-1)).toEqual({
            role: 'assistant',
            content: 'YAML prefill',
            partial: true,
        });
    });

    test('does not use Partial Mode with structured output', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            json_schema: {
                name: 'answer',
                value: { type: 'object', properties: { answer: { type: 'string' } } },
            },
        });

        expect(response.status).toBe(200);
        expect(capturedBody.response_format.type).toBe('json_schema');
        expect(capturedBody.messages.at(-1).partial).toBeUndefined();
    });

    test('allows Partial Mode with an explicit text response format', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            custom_include_body: 'response_format:\n  type: text',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.response_format).toEqual({ type: 'text' });
        expect(capturedBody.messages.at(-1).partial).toBe(true);
    });

    test('does not mark a prefill after tool history', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            messages: [
                { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
                { role: 'tool', tool_call_id: 'call-1', content: 'result' },
                { role: 'assistant', content: 'Prefill' },
            ],
        });

        expect(response.status).toBe(200);
        expect(capturedBody.messages.at(-1).partial).toBeUndefined();
    });

    test('leaves non-K3 Custom requests unchanged', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            model: 'kimi-k2.5',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.messages.at(-1).partial).toBeUndefined();
        expect(capturedBody.temperature).toBe(1);
        expect(capturedBody.top_p).toBe(0.95);
        expect(capturedBody.n).toBe(3);
    });

    test('retains K2 thinking controls for native Moonshot', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.MOONSHOT, {
            model: 'kimi-k2.5',
            include_reasoning: true,
        });

        expect(response.status).toBe(200);
        expect(capturedBody.thinking).toEqual({ type: 'enabled' });
        expect(capturedBody.messages.at(-1).partial).toBe(true);
    });
});
