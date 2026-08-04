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

describe('reasoning effort on outgoing chat completions', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let capturedBody;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-effort-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-effort-user-'));
        tempDirs.push(userRoot);
        const secretManager = new SecretManager({ root: userRoot, backups: userRoot });
        secretManager.writeSecret(SECRET_KEYS.NANOGPT, 'nanogpt-test-key');
        secretManager.writeSecret(SECRET_KEYS.OPENROUTER, 'openrouter-test-key');
        secretManager.writeSecret(SECRET_KEYS.PERPLEXITY, 'perplexity-test-key');

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
                choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
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
                model: 'test-model',
                stream: false,
                max_tokens: 128,
                messages: [{ role: 'user', content: 'Question' }],
                ...overrides,
            }),
        });
    }

    test.each([
        ['min', 'none'],
        ['low', 'minimal'],
        ['medium', 'low'],
        ['high', 'medium'],
        ['max', 'high'],
        ['xhigh', 'high'],
    ])('NanoGPT sends %s as %s', async (effort, expected) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning).toEqual({ effort: expected });
    });

    test.each(['none', 'auto', 'banana', '   '])('NanoGPT omits the reasoning key entirely for %p', async (effort) => {
        // Upstream emitted a bare `"reasoning": {}` for all of these, because the value is
        // truthy but has no NanoGPT equivalent. hasOwn, not toBeUndefined: an empty object
        // would also read as undefined on the nested effort.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning')).toBe(false);
    });

    test('NanoGPT omits the reasoning key when no effort is supplied', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT);

        expect(response.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning')).toBe(false);
    });

    test.each(['XHigh', ' Max ', 'MAX'])('NanoGPT normalizes %p before the table lookup', async (effort) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning).toEqual({ effort: 'high' });
    });

    test('OpenRouter receives a lowercased effort instead of the raw value', async () => {
        // OpenRouter forwards whatever it is given, so a hand-edited profile containing
        // "Medium" produced `invalid value for reasoning.effort "Medium"` from the provider.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.OPENROUTER, { reasoning_effort: 'Medium' });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning.effort).toBe('medium');
    });

    test('Perplexity receives a lowercased effort', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.PERPLEXITY, { reasoning_effort: 'HIGH' });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe('high');
    });

    test('an unrecognized value still reaches an OpenAI-compatible endpoint', async () => {
        // Several proxies take vocabulary of their own; dropping unknowns would regress them.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            reasoning_effort: 'Minimal',
            custom_url: 'https://custom.test/v1',
            model: 'gpt-5',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe('minimal');
    });
});
