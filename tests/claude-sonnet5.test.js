import { beforeAll, afterAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';
import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';

const actualNodeFetch = (await import('node-fetch')).default;
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));
const currentClaude5Models = ['claude-sonnet-5', 'claude-opus-5'];

function captureClaudePayload() {
    nodeFetchMock.mockClear();
    let capturedBody = null;
    nodeFetchMock.mockImplementation(async (url, options) => {
        capturedBody = JSON.parse(options?.body ?? '{}');
        // Return a minimal successful Claude messages response
        return new Response(JSON.stringify({
            id: 'msg-test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            model: capturedBody.model,
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 2 },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    return () => capturedBody;
}

describe('Claude 5 backend request handling', () => {
    /** @type {import('http').Server} */
    let appServer;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let userDirectories;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-claude-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig.replace('enableAdaptiveThinking: false', 'enableAdaptiveThinking: true'));
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { SECRET_KEYS, SecretManager } = await import('../src/endpoints/secrets.js');
        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');

        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-claude-sonnet5-'));
        tempDirs.push(userRoot);
        userDirectories = { root: userRoot, backups: userRoot };
        new SecretManager(userDirectories).writeSecret(SECRET_KEYS.LINKAPI, 'linkapi-test-key');
        new SecretManager(userDirectories).writeSecret(SECRET_KEYS.COHERE, 'cohere-test-key');

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: userDirectories };
            next();
        });
        app.use('/api/backends/chat-completions', chatCompletionsRouter);

        await new Promise((resolve) => {
            appServer = app.listen(3020, '127.0.0.1', resolve);
        });
    });

    afterAll(async () => {
        if (appServer) {
            await new Promise((resolve, reject) => {
                appServer.close((err) => err ? reject(err) : resolve());
            });
        }
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        nodeFetchMock.mockImplementation((url, options) => actualNodeFetch(url, options));
    });

    function makeRequest(overrides = {}) {
        return fetch('http://127.0.0.1:3020/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.CLAUDE,
                reverse_proxy: 'https://api.anthropic.com',
                proxy_password: 'test-key',
                model: 'claude-sonnet-5',
                stream: false,
                temperature: 0.8,
                top_p: 0.9,
                top_k: 40,
                max_tokens: 2000,
                messages: [{ role: 'user', content: 'Hello' }],
                ...overrides,
            }),
        });
    }

    test.each(currentClaude5Models)('%s with effort=high sends adaptive thinking and omits sampling params', async (model) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model, reasoning_effort: 'high' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.output_config?.effort).toBe('high');
        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.top_k).toBeUndefined();
    });

    test.each([
        ['claude-sonnet-5', 'xhigh'],
        ['claude-opus-5', 'xhigh'],
        ['claude-opus-5', 'max'],
    ])('%s preserves effort=%s', async (model, reasoningEffort) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model, reasoning_effort: reasoningEffort });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.output_config?.effort).toBe(reasoningEffort);
    });

    test('Sonnet 4.6 maps unsupported xhigh effort to max', async () => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model: 'claude-sonnet-4-6', reasoning_effort: 'xhigh' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.output_config?.effort).toBe('max');
    });

    test.each(['claude-opus-4-8', 'claude-fable-5'])('%s does not inherit Claude 5 xhigh support', async (model) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model, reasoning_effort: 'xhigh' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.output_config?.effort).toBe('max');
    });

    test.each(currentClaude5Models)('%s with effort=none sends thinking.type disabled and omits sampling params', async (model) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model, reasoning_effort: 'none' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'disabled' });
        expect(body.output_config).toBeUndefined();
        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.top_k).toBeUndefined();
    });

    test.each(currentClaude5Models)('%s with no reasoning_effort sends thinking.type disabled', async (model) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'disabled' });
    });

    test.each(currentClaude5Models)('%s with include_reasoning adds display:summarized to thinking', async (model) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model, reasoning_effort: 'high', include_reasoning: true });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking?.type).toBe('adaptive');
        expect(body.thinking?.display).toBe('summarized');
    });

    test.each(currentClaude5Models)('%s sampling params are omitted at low effort', async (model) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model, reasoning_effort: 'low' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.top_k).toBeUndefined();
    });

    test.each(currentClaude5Models)('%s with web search enabled includes the web_search tool', async (model) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model, reasoning_effort: 'high', enable_web_search: true });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(Array.isArray(body.tools)).toBe(true);
        expect(body.tools.some(t => t.type === 'web_search_20250305')).toBe(true);
    });

    test.each(currentClaude5Models)('%s removes assistant prefill from messages', async (model) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({
            model,
            reasoning_effort: 'high',
            messages: [
                { role: 'user', content: 'Question' },
                { role: 'assistant', content: 'Start of answer' },
            ],
        });
        expect(res.status).toBe(200);
        const body = getBody();

        const lastMessage = body.messages[body.messages.length - 1];
        // noPrefillModel: last assistant role must have been converted to user
        expect(lastMessage.role).not.toBe('assistant');
    });

    test.each([
        ['required', 'REQUIRED'],
        ['auto', undefined],
    ])('Cohere maps tool_choice=%s to %s', async (toolChoice, expected) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({
            chat_completion_source: CHAT_COMPLETION_SOURCES.COHERE,
            model: 'command-r-plus',
            tool_choice: toolChoice,
            tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
        });

        expect(res.status).toBe(200);
        expect(getBody().tool_choice).toBe(expected);
    });

    test('Bun LinkAPI streams bypass the leaking node-fetch pipeline', async () => {
        Object.defineProperty(process.versions, 'bun', { configurable: true, value: 'test' });
        nodeFetchMock.mockReset();
        nodeFetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
        const upstreamResponse = Object.assign(new PassThrough(), {
            statusCode: 200,
            statusMessage: 'OK',
        });
        const upstreamRequest = Object.assign(new EventEmitter(), {
            setTimeout: jest.fn(),
            end: jest.fn(() => upstreamResponse.end('data: [DONE]\n\n')),
        });
        const requestSpy = jest.spyOn(https, 'request').mockImplementation((_url, _options, callback) => {
            process.nextTick(() => callback(upstreamResponse));
            return upstreamRequest;
        });

        try {
            const res = await makeRequest({
                chat_completion_source: CHAT_COMPLETION_SOURCES.LINKAPI,
                linkapi_endpoint: 'us',
                model: 'claude-fable-5',
                stream: true,
            });

            expect(res.status).toBe(200);
            expect(await res.text()).toBe('data: [DONE]\n\n');
            expect(requestSpy).toHaveBeenCalledWith('https://api.linkapi.ai/v1/messages', expect.any(Object), expect.any(Function));
            expect(nodeFetchMock).not.toHaveBeenCalled();
        } finally {
            requestSpy.mockRestore();
            nodeFetchMock.mockReset();
            nodeFetchMock.mockImplementation((url, options) => actualNodeFetch(url, options));
            delete process.versions.bun;
        }
    });
});
