import { beforeAll, afterAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';
import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';

const actualNodeFetch = (await import('node-fetch')).default;
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

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

describe('Claude Sonnet 5 backend request handling', () => {
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

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');

        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-claude-sonnet5-'));
        tempDirs.push(userRoot);
        userDirectories = { root: userRoot, backups: userRoot };

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

    test('Sonnet 5 with effort=high sends adaptive thinking and omits sampling params', async () => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ reasoning_effort: 'high' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.output_config?.effort).toBe('high');
        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.top_k).toBeUndefined();
    });

    test('Sonnet 5 with effort=xhigh sends xhigh (not max) as the effort string', async () => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ reasoning_effort: 'xhigh' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.output_config?.effort).toBe('xhigh');
    });

    test('Sonnet 4.6 maps unsupported xhigh effort to max', async () => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model: 'claude-sonnet-4-6', reasoning_effort: 'xhigh' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.output_config?.effort).toBe('max');
    });

    test.each(['claude-opus-4-8', 'claude-fable-5'])('%s does not inherit Sonnet 5 xhigh support', async (model) => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ model, reasoning_effort: 'xhigh' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.output_config?.effort).toBe('max');
    });

    test('Sonnet 5 with effort=none sends thinking.type disabled and omits sampling params', async () => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ reasoning_effort: 'none' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'disabled' });
        expect(body.output_config).toBeUndefined();
        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.top_k).toBeUndefined();
    });

    test('Sonnet 5 with no reasoning_effort sends thinking.type disabled', async () => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({});
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking).toEqual({ type: 'disabled' });
    });

    test('Sonnet 5 with include_reasoning adds display:summarized to thinking', async () => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ reasoning_effort: 'high', include_reasoning: true });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.thinking?.type).toBe('adaptive');
        expect(body.thinking?.display).toBe('summarized');
    });

    test('Sonnet 5 sampling params are omitted even without reasoning effort', async () => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ reasoning_effort: 'low' });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.top_k).toBeUndefined();
    });

    test('Sonnet 5 with web search enabled includes the web_search tool', async () => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({ reasoning_effort: 'high', enable_web_search: true });
        expect(res.status).toBe(200);
        const body = getBody();

        expect(Array.isArray(body.tools)).toBe(true);
        expect(body.tools.some(t => t.type === 'web_search_20250305')).toBe(true);
    });

    test('Sonnet 5 removes assistant prefill from messages', async () => {
        const getBody = captureClaudePayload();
        const res = await makeRequest({
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
});
