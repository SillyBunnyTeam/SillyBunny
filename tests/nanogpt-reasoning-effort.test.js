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

describe('outgoing chat completions', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let capturedBody;
    let capturedHeaders;
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
        secretManager.writeSecret(SECRET_KEYS.POLLINATIONS, 'pollinations-test-key');
        secretManager.writeSecret(SECRET_KEYS.COMETAPI, 'cometapi-test-key');

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
        capturedHeaders = undefined;
        nodeFetchMock.mockClear();
        nodeFetchMock.mockImplementation(async (_url, options) => {
            capturedBody = JSON.parse(options?.body ?? '{}');
            capturedHeaders = options?.headers;
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
        {},
        { nanogpt_provider: '' },
        { nanogpt_provider: ' \t ' },
        { nanogpt_payg_override: false },
        { nanogpt_allowed_providers: [] },
        { nanogpt_ignored_providers: [] },
        { nanogpt_allowed_providers: [], nanogpt_ignored_providers: [] },
        { nanogpt_provider: 'legacy-provider', nanogpt_allowed_providers: [] },
        { nanogpt_provider: 'legacy-provider', nanogpt_ignored_providers: [] },
        { nanogpt_provider: 'legacy-provider', nanogpt_allowed_providers: [], nanogpt_ignored_providers: [] },
    ])('NanoGPT omits provider and billing overrides for %p', async (overrides) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, overrides);

        expect(response.status).toBe(200);
        expect(capturedBody).not.toHaveProperty('provider');
        expect(capturedBody).not.toHaveProperty('billing_mode');
        expect(capturedHeaders).not.toHaveProperty('X-Provider');
        expect(capturedHeaders).not.toHaveProperty('X-Billing-Mode');
    });

    test.each([
        ['allowed only', { nanogpt_allowed_providers: ['Provider-A', 'unlisted/provider:V2'] }, { only: ['Provider-A', 'unlisted/provider:V2'] }],
        ['ignored only', { nanogpt_ignored_providers: ['Provider-B', 'unlisted/provider:V3'] }, { ignore: ['Provider-B', 'unlisted/provider:V3'] }],
        ['combined', { nanogpt_allowed_providers: ['Provider-A'], nanogpt_ignored_providers: ['Provider-B'] }, { only: ['Provider-A'], ignore: ['Provider-B'] }],
        ['empty ignored', { nanogpt_allowed_providers: [' Provider-A '], nanogpt_ignored_providers: [] }, { only: [' Provider-A '] }],
        ['empty allowed', { nanogpt_allowed_providers: [], nanogpt_ignored_providers: ['Provider-B'] }, { ignore: ['Provider-B'] }],
    ])('NanoGPT sends exact structured IDs with %s, without explicit billing overrides', async (_name, overrides, provider) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
            nanogpt_provider: 'legacy-provider',
            nanogpt_payg_override: false,
            ...overrides,
        });

        expect(response.status).toBe(200);
        expect(capturedBody.provider).toEqual(provider);
        expect(capturedHeaders).not.toHaveProperty('X-Provider');
        expect(capturedHeaders).not.toHaveProperty('X-Billing-Mode');
        expect(capturedBody).not.toHaveProperty('billing_mode');
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
    });

    test.each([
        [{}, undefined],
        [{ nanogpt_allowed_providers: [], nanogpt_ignored_providers: [] }, undefined],
        [{ nanogpt_allowed_providers: ['Provider-A'], nanogpt_ignored_providers: ['Provider-B'] }, { only: ['Provider-A'], ignore: ['Provider-B'] }],
    ])('NanoGPT PAYG true sends both billing overrides with %p', async (overrides, provider) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
            ...overrides,
            nanogpt_payg_override: true,
        });

        expect(response.status).toBe(200);
        expect(capturedHeaders['X-Billing-Mode']).toBe('paygo');
        expect(capturedBody.billing_mode).toBe('paygo');
        expect(capturedBody.provider).toEqual(provider);
        expect(capturedHeaders).not.toHaveProperty('X-Provider');
    });

    test('NanoGPT preserves the legacy provider header when neither list is supplied', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { nanogpt_provider: 'Legacy/provider:V2' });

        expect(response.status).toBe(200);
        expect(capturedHeaders['X-Provider']).toBe('Legacy/provider:V2');
        expect(capturedBody).not.toHaveProperty('provider');
        expect(capturedBody).not.toHaveProperty('billing_mode');
        expect(capturedHeaders).not.toHaveProperty('X-Billing-Mode');
    });

    test.each([
        ...['nanogpt_allowed_providers', 'nanogpt_ignored_providers'].flatMap(field => [
            null, '', 'Provider-A', false, 1, {},
            ['Provider-A', ''], ['Provider-A', ' \t '], ['Provider-A', null],
            ['Provider-A', false], ['Provider-A', 1], ['Provider-A', {}], ['Provider-A', []],
        ].map(value => [field, value])),
        ...[null, '', 'true', 'false', 0, 1, {}, []].map(value => ['nanogpt_payg_override', value]),
        ...[null, false, 1, {}, [], 'bad\r\nX-Injected: value', 'bad\u0000', 'bad\u0100'].map(value => ['nanogpt_provider', value]),
    ])('NanoGPT refuses malformed %s=%p before any outbound fetch', async (field, value) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
            nanogpt_provider: 'legacy-provider',
            [field]: value,
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: true });
        expect(nodeFetchMock).not.toHaveBeenCalled();
    });

    test.each([
        [400, 400],
        [503, 502],
    ])('NanoGPT does not retry without restrictions after an upstream %s', async (status, expectedStatus) => {
        nodeFetchMock.mockResolvedValueOnce(new Response('{}', { status }));
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
            nanogpt_allowed_providers: ['unlisted/provider'],
            nanogpt_ignored_providers: ['Provider-B'],
        });

        expect(response.status).toBe(expectedStatus);
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(nodeFetchMock.mock.calls[0][1].body).provider).toEqual({
            only: ['unlisted/provider'],
            ignore: ['Provider-B'],
        });
    });

    test.each([
        [CHAT_COMPLETION_SOURCES.CUSTOM, { custom_url: 'https://custom.test/v1' }],
        [CHAT_COMPLETION_SOURCES.PERPLEXITY, {}],
        [CHAT_COMPLETION_SOURCES.OPENROUTER, { provider: ['own-provider'], allow_fallbacks: false }],
    ])('%s is unaffected by valid or malformed NanoGPT fields', async (source, overrides) => {
        const baseline = await makeRequest(source, overrides);
        const originalBody = capturedBody;
        const originalHeaders = capturedHeaders;
        const response = await makeRequest(source, {
            ...overrides,
            nanogpt_allowed_providers: ['NanoGPT-only'],
            nanogpt_ignored_providers: ['NanoGPT-ignored'],
            nanogpt_payg_override: true,
            nanogpt_provider: 'legacy-provider',
        });

        expect(baseline.status).toBe(200);
        expect(response.status).toBe(200);
        expect(capturedBody).toEqual(originalBody);
        expect(capturedHeaders).toEqual(originalHeaders);

        const invalidResponse = await makeRequest(source, {
            ...overrides,
            nanogpt_allowed_providers: 'invalid',
            nanogpt_ignored_providers: null,
            nanogpt_payg_override: 'true',
            nanogpt_provider: 'bad\r\nheader',
        });

        expect(invalidResponse.status).toBe(200);
        expect(capturedBody).toEqual(originalBody);
        expect(capturedHeaders).toEqual(originalHeaders);
    });

    // NanoGPT documents none < minimal < low < medium < high < xhigh, and some models accept
    // max. Everything but min is spelled the same here, so it goes out untouched instead of
    // being shifted a rung down. min is the only name NanoGPT does not have, so it takes the
    // nearest rung. none goes out too: omitting it would let the model pick its own depth.
    test.each([
        ['none', 'none'],
        ['min', 'minimal'],
        ['low', 'low'],
        ['medium', 'medium'],
        ['high', 'high'],
        ['xhigh', 'xhigh'],
        ['max', 'max'],
    ])('NanoGPT sends %s as %s', async (effort, expected) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning).toEqual({ effort: expected });
    });

    test.each(['auto', '   '])('NanoGPT omits the reasoning key entirely for %p', async (effort) => {
        // Upstream emitted a bare `"reasoning": {}` for both, because the value is truthy but
        // means "unset". hasOwn, not toBeUndefined: an empty object would also read as
        // undefined on the nested effort.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning')).toBe(false);
    });

    test('NanoGPT forwards a value it does not recognize instead of dropping it', async () => {
        // A rung NanoGPT rejects earns an error the user can read, rather than a silent
        // downgrade to whatever the model felt like doing.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: 'banana' });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning).toEqual({ effort: 'banana' });
    });

    test('NanoGPT omits the reasoning key when no effort is supplied', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT);

        expect(response.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning')).toBe(false);
    });

    test.each([
        ['XHigh', 'xhigh'],
        [' xhigh ', 'xhigh'],
        [' Max ', 'max'],
        ['MAX', 'max'],
        [' None ', 'none'],
    ])('NanoGPT normalizes %p before the table lookup and sends %s', async (effort, expected) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning).toEqual({ effort: expected });
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

    test('an unrecognized value reaches an OpenAI-compatible endpoint with its casing intact', async () => {
        // Several proxies take vocabulary of their own. Dropping unknowns would regress them, and
        // case-folding one would too, since JSON enum values are case-sensitive.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            reasoning_effort: 'UltraFast',
            custom_url: 'https://custom.test/v1',
            model: 'gpt-5',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe('UltraFast');
    });

    test('\'none\' reaches an OpenAI-compatible endpoint verbatim for a GPT-5.1+ model', async () => {
        // The client only resolves 'none' for models that document it (GPT-5.1 and newer);
        // the server's job is to pass it through untouched rather than dropping it.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            reasoning_effort: 'none',
            custom_url: 'https://custom.test/v1',
            model: 'gpt-5.2',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe('none');
    });

    // Two representatives of the branches that assign this key unconditionally (CometAPI and
    // Chutes are the others). A value that trims to nothing has to be removed from the body
    // rather than blanked, or they ship `"reasoning_effort": ""`. The removal happens once at
    // the shared entry point, so these two cover the whole class.
    test.each([
        ['Perplexity', CHAT_COMPLETION_SOURCES.PERPLEXITY],
        ['Pollinations', CHAT_COMPLETION_SOURCES.POLLINATIONS],
    ])('%s omits the field entirely for a whitespace-only effort', async (_name, source) => {
        const response = await makeRequest(source, { reasoning_effort: '   ' });

        expect(response.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning_effort')).toBe(false);
    });
});
