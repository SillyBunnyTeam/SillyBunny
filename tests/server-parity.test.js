import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';
import { CHAT_COMPLETION_SOURCES, POLLINATIONS_ENDPOINT, TEXTGEN_TYPES } from '../src/constants.js';

const { Response: FetchResponse } = await import('node-fetch');
const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));

function jsonResponse(body) {
    return new FetchResponse(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('upstream server compatibility', () => {
    let server;
    let baseUrl;
    let tempDir;
    let countWebTokenizerTokens;
    const previousDataRoot = global.DATA_ROOT;

    beforeAll(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-server-parity-'));
        global.DATA_ROOT = tempDir;
        const defaults = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        const configPath = path.join(tempDir, 'config.yaml');
        fs.writeFileSync(configPath, defaults.replace(/enableAdaptiveThinking: (true|false)/, 'enableAdaptiveThinking: false'));
        setConfigFilePath(configPath);

        const directories = { root: tempDir, backups: tempDir };
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const secrets = new SecretManager(directories);
        for (const key of [SECRET_KEYS.FIREWORKS, SECRET_KEYS.POLLINATIONS, SECRET_KEYS.OPENROUTER, SECRET_KEYS.MINIMAX]) {
            secrets.writeSecret(key, 'test-provider-key');
        }

        const { router: completions } = await import('../src/endpoints/backends/chat-completions.js');
        const { router: openai } = await import('../src/endpoints/openai.js');
        const { router: minimax } = await import('../src/endpoints/minimax.js');
        const { router: tokenizers, countWebTokenizerTokens: countTokens } = await import('../src/endpoints/tokenizers.js');
        const { router: users } = await import('../src/endpoints/users-private.js');
        const { default: corsProxy } = await import('../src/middleware/corsProxy.js');
        countWebTokenizerTokens = countTokens;
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories, profile: { handle: 'parity-user', name: 'Parity' } };
            next();
        });
        app.use('/completions', completions);
        app.use('/openai', openai);
        app.use('/minimax', minimax);
        app.use('/tokenizers', tokenizers);
        app.use('/users', users);
        app.all('/proxy/:url', corsProxy);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = 'http://127.0.0.1:' + server.address().port;
    });

    afterAll(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        global.DATA_ROOT = previousDataRoot;
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        for (const method of ['debug', 'info', 'warn', 'error', 'log']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
        fetchMock.mockReset();
        fetchMock.mockImplementation(async () => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });

    afterEach(() => jest.restoreAllMocks());

    function post(route, body) {
        return fetch(baseUrl + route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    function generate(overrides) {
        return post('/completions/generate', {
            model: 'test-model',
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 2048,
            stream: false,
            ...overrides,
        });
    }

    test('Fireworks discovers serverless models and matching fast routers', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ models: [
            { name: 'accounts/fireworks/models/kimi-k3', displayName: 'Kimi K3', contextLength: 100000, supportsTools: true },
            { name: 'embedding', kind: 'EMBEDDING_MODEL', contextLength: 1024 },
            { name: 'empty', contextLength: 0 },
        ] }));
        const response = await post('/completions/status', { chat_completion_source: CHAT_COMPLETION_SOURCES.FIREWORKS });
        expect(response.status).toBe(200);
        expect((await response.json()).data).toEqual([
            { id: 'accounts/fireworks/models/kimi-k3', name: 'Kimi K3', context_length: 100000, supports_tools: true },
            { id: 'accounts/fireworks/routers/kimi-k3-fast', name: 'Kimi K3 (fast)', context_length: 100000, supports_tools: true },
        ]);
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=200');
    });

    test('Fireworks sends reasoning and a stable opaque affinity key per chat', async () => {
        for (const chatId of ['private-chat-a', 'private-chat-a', 'private-chat-b']) {
            const response = await generate({ chat_completion_source: CHAT_COMPLETION_SOURCES.FIREWORKS, chat_id: chatId, reasoning_effort: 'high' });
            expect(response.status).toBe(200);
        }
        const options = fetchMock.mock.calls.map(([, request]) => request);
        const affinity = options.map(request => request.headers['x-session-affinity']);
        expect(affinity[0]).toMatch(/^[a-f0-9]{16}$/);
        expect(affinity[1]).toBe(affinity[0]);
        expect(affinity[2]).not.toBe(affinity[0]);
        expect(JSON.parse(options[0].body).reasoning_effort).toBe('high');
        expect(options[0].body).not.toContain('private-chat-a');
    });

    test.each([
        [POLLINATIONS_ENDPOINT.ANONYMOUS, 'https://text.pollinations.ai/v1/chat/completions', 'Bearer anonymous', undefined, undefined],
        [POLLINATIONS_ENDPOINT.AUTHENTICATED, 'https://gen.pollinations.ai/v1/chat/completions', 'Bearer test-provider-key', 'high', { type: 'object' }],
    ])('Pollinations %s uses its matching endpoint and supported parameters', async (endpoint, url, authorization, reasoning, schema) => {
        const response = await generate({
            chat_completion_source: CHAT_COMPLETION_SOURCES.POLLINATIONS,
            pollinations_endpoint: endpoint,
            reasoning_effort: 'high',
            json_schema: { name: 'result', value: { type: 'object' } },
        });
        expect(response.status).toBe(200);
        const [calledUrl, options] = fetchMock.mock.calls[0];
        expect(calledUrl).toBe(url);
        expect(options.headers.Authorization).toBe(authorization);
        const body = JSON.parse(options.body);
        expect(body.reasoning_effort).toBe(reasoning);
        expect(body.response_format?.json_schema?.schema).toEqual(schema);
    });

    test('OpenRouter forwards requested top log probabilities', async () => {
        const response = await generate({ chat_completion_source: CHAT_COMPLETION_SOURCES.OPENROUTER, logprobs: 3 });
        expect(response.status).toBe(200);
        const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
        expect(body.logprobs).toBe(true);
        expect(body.top_logprobs).toBe(3);
    });

    test.each(['claude-opus-4-8', 'anthropic/claude-sonnet-5', 'claude-fable-5'])('%s uses mandatory adaptive thinking and omits rejected samplers', async (model) => {
        fetchMock.mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
        const response = await generate({
            chat_completion_source: CHAT_COMPLETION_SOURCES.CLAUDE,
            reverse_proxy: 'https://claude.example', proxy_password: 'test-key',
            model,
            temperature: 0.5,
            top_p: 0.9,
            top_k: 10,
            reasoning_effort: 'xhigh',
            include_reasoning: true,
        });
        expect(response.status).toBe(200);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body.output_config.effort).toBe('xhigh');
        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.top_k).toBeUndefined();
    });

    test('Fable requests readable reasoning summaries with automatic effort', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
        const response = await generate({ chat_completion_source: CHAT_COMPLETION_SOURCES.CLAUDE, reverse_proxy: 'https://claude.example', proxy_password: 'test-key', model: 'claude-fable-5', reasoning_effort: 'auto', include_reasoning: true });
        expect(response.status).toBe(200);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    });

    test('Google model pagination preserves the existing reverse-proxy API path', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ name: 'models/one', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'page two' }))
            .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'models/two', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 100000 }] }));
        const response = await post('/completions/status', { chat_completion_source: CHAT_COMPLETION_SOURCES.MAKERSUITE, reverse_proxy: 'https://google.example/v1beta' });
        expect(response.status).toBe(200);
        expect((await response.json()).data.map(model => model.id)).toEqual(['one', 'two']);
        const secondUrl = new URL(fetchMock.mock.calls[1][0]);
        expect(secondUrl.pathname).toBe('/v1beta/models');
        expect(secondUrl.searchParams.get('pageToken')).toBe('page two');
    });

    test('Oobabooga captions retain one valid multimodal user message', async () => {
        const response = await post('/openai/caption-image', { api: 'ooba', server_url: 'http://model.example/v1', model: 'vision', prompt: 'Describe', image: 'data:image/png;base64,AQID' });
        expect(response.status).toBe(200);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.messages).toEqual([{ role: 'user', content: [
            { type: 'text', text: 'Describe' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
        ] }]);
    });

    test('MiniMax speech succeeds without a GroupId secret', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ base_resp: { status_code: 0 }, data: { audio: '0102' } }));
        const response = await post('/minimax/generate-voice', { text: 'Hello', voiceId: 'voice' });
        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimax.io/v1/t2a_v2');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([1, 2]));
    });

    test('web-tokenizer counts raw text without adding chat-role wrappers', () => {
        const encode = jest.fn(text => Array.from(text));
        expect(countWebTokenizerTokens({ encode }, [{ content: 'Hello' }])).toBe(5);
        expect(encode).toHaveBeenCalledWith('Hello');
    });

    test('remote tokenizer rejects unsupported backends before contacting a server', async () => {
        const response = await post('/tokenizers/remote/textgenerationwebui/encode', { api_type: 'unsupported', url: 'http://model.example', text: 'Hello' });
        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('remote Oobabooga tokenizer normalizes v1 URLs', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ tokens: [1, 2] }));
        const response = await post('/tokenizers/remote/textgenerationwebui/encode', { api_type: TEXTGEN_TYPES.OOBA, url: 'http://model.example/v1/', text: 'Hello' });
        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe('http://model.example/v1/internal/encode');
    });

    test('CORS proxy omits zstd and private browser headers while forwarding decoded content', async () => {
        fetchMock.mockResolvedValue(new FetchResponse('decoded', { status: 200 }));
        const response = await fetch(baseUrl + '/proxy/' + encodeURIComponent('https://content.example/page'), { headers: { 'accept-encoding': 'gzip, deflate, br, zstd', cookie: 'test-cookie', 'x-csrf-token': 'test-csrf' } });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('decoded');
        const headers = fetchMock.mock.calls[0][1].headers;
        expect(headers['accept-encoding']).toBe('gzip, deflate, br');
        expect(headers.cookie).toBeUndefined();
        expect(headers['x-csrf-token']).toBeUndefined();
    });

    test('account-reset guesses are rate limited before account data can be changed', async () => {
        const statuses = [];
        for (let attempt = 0; attempt < 6; attempt++) {
            statuses.push((await post('/users/reset-step2', { code: 'wrong-code' })).status);
        }
        expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
        expect((await post('/users/reset-step1', {})).status).toBe(429);
    });
});
