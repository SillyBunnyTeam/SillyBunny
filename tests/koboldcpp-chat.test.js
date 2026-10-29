import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const { Response: FetchResponse } = await import('node-fetch');
const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));

const API_KEY = 'kcpp-chat-test-key';

function jsonResponse(body) {
    return new FetchResponse(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * @param {string} pathname URL path of a KoboldCpp request
 * @returns {Array<{ url: URL, options: any, body: any }>} Requests the server sent to that path
 */
function getRequests(pathname) {
    return fetchMock.mock.calls
        .map(([url, options]) => ({ url: new URL(String(url)), options, body: options?.body ? JSON.parse(options.body) : null }))
        .filter(request => request.url.pathname === pathname);
}

describe('KoboldCpp Chat Completion source', () => {
    let server;
    let baseUrl;
    let tempDir;
    /** @type {PassThrough[]} */
    const openStreams = [];

    beforeAll(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-kcpp-chat-'));
        const configPath = path.join(tempDir, 'config.yaml');
        fs.writeFileSync(configPath, fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8'));
        setConfigFilePath(configPath);

        const keyedRoot = path.join(tempDir, 'keyed');
        const keylessRoot = path.join(tempDir, 'keyless');
        fs.mkdirSync(keyedRoot);
        fs.mkdirSync(keylessRoot);
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        new SecretManager({ root: keyedRoot, backups: keyedRoot }).writeSecret(SECRET_KEYS.KOBOLDCPP, API_KEY);

        const { router: completions } = await import('../src/endpoints/backends/chat-completions.js');
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            const root = req.get('x-test-user') === 'keyless' ? keylessRoot : keyedRoot;
            req.user = { directories: { root, backups: root } };
            next();
        });
        app.use('/completions', completions);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        for (const method of ['debug', 'info', 'warn', 'error', 'log']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
        fetchMock.mockReset();
        fetchMock.mockImplementation(async () => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });

    afterEach(() => {
        for (const stream of openStreams.splice(0)) {
            stream.end();
        }
        jest.restoreAllMocks();
    });

    function post(route, body, { keyless = false, signal } = {}) {
        return fetch(`${baseUrl}/completions/${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(keyless ? { 'x-test-user': 'keyless' } : {}) },
            body: JSON.stringify(body),
            signal,
        });
    }

    function generate(overrides = {}, options = {}) {
        return post('generate', {
            chat_completion_source: 'koboldcpp',
            koboldcpp_url: 'http://localhost:5001',
            model: 'koboldcpp/Qwen3-0.6B-Q8_0',
            messages: [{ role: 'user', content: 'Hello' }],
            temperature: 0.8,
            presence_penalty: 0.1,
            frequency_penalty: 0.4,
            top_p: 0.95,
            top_k: 0,
            min_p: 0.05,
            top_a: 0.2,
            repetition_penalty: 1.1,
            max_tokens: 300,
            stream: false,
            ...overrides,
        }, options);
    }

    test('checks the status at the OpenAI-compatible model list with the saved key', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ object: 'list', data: [{ id: 'koboldcpp/Qwen3-0.6B-Q8_0', object: 'model' }] }));

        const response = await post('status', { chat_completion_source: 'koboldcpp', koboldcpp_url: 'http://localhost:5001/v1/' });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ object: 'list', data: [{ id: 'koboldcpp/Qwen3-0.6B-Q8_0', object: 'model' }] });
        const [request] = getRequests('/v1/models');
        expect(request.url.origin).toBe('http://127.0.0.1:5001');
        expect(request.options.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });

    test('checks the status without a key when none is saved', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ object: 'list', data: [{ id: 'inactive', object: 'model' }] }));

        const response = await post('status', { chat_completion_source: 'koboldcpp', koboldcpp_url: 'http://127.0.0.1:5001' }, { keyless: true });

        expect(response.status).toBe(200);
        expect(getRequests('/v1/models')).toHaveLength(1);
    });

    test.each([
        [{}],
        [{ koboldcpp_url: '' }],
        [{ koboldcpp_url: 'file:///etc/passwd' }],
    ])('turns down a status check without a usable URL: %j', async (body) => {
        const response = await post('status', { chat_completion_source: 'koboldcpp', ...body });

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('sends the KoboldCpp samplers and no model name', async () => {
        const response = await generate({ seed: 42 });

        expect(response.status).toBe(200);
        const [request] = getRequests('/v1/chat/completions');
        expect(request.url.origin).toBe('http://127.0.0.1:5001');
        expect(request.options.headers.Authorization).toBe(`Bearer ${API_KEY}`);
        expect(request.body).toMatchObject({
            messages: [{ role: 'user', content: 'Hello' }],
            temperature: 0.8,
            presence_penalty: 0.1,
            top_p: 0.95,
            top_k: 0,
            min_p: 0.05,
            top_a: 0.2,
            repetition_penalty: 1.1,
            max_tokens: 300,
            seed: 42,
        });
        expect(request.body).not.toHaveProperty('model');
        expect(request.body.genkey).toMatch(/^sillybunny-[0-9a-f-]{36}$/);
    });

    test('gives each generation its own key', async () => {
        await generate();
        await generate();

        const [first, second] = getRequests('/v1/chat/completions');
        expect(first.body.genkey).not.toBe(second.body.genkey);
    });

    test.each([
        ['none', undefined],
        ['auto', undefined],
        ['min', 'minimal'],
        ['low', 'low'],
        ['medium', 'medium'],
        ['high', 'high'],
        ['xhigh', 'xhigh'],
        ['max', 'max'],
    ])('sends reasoning effort %s as %s', async (effort, expected) => {
        await generate({ reasoning_effort: effort });

        const [request] = getRequests('/v1/chat/completions');
        expect(request.body.reasoning_effort).toBe(expected);
    });

    test('applies the KoboldCpp Additional Parameters', async () => {
        await generate({
            koboldcpp_include_body: 'dry_multiplier: 0.8\nsampler_order: [6, 0, 1]\ngenkey: user-key',
            koboldcpp_exclude_body: '- top_a',
            koboldcpp_include_headers: 'X-Test: yes',
            custom_include_body: 'custom_only: true',
            custom_exclude_body: '- temperature',
        });

        const [request] = getRequests('/v1/chat/completions');
        expect(request.body).toMatchObject({ dry_multiplier: 0.8, sampler_order: [6, 0, 1], temperature: 0.8 });
        expect(request.body.genkey).toMatch(/^sillybunny-/);
        expect(request.body).not.toHaveProperty('top_a');
        expect(request.body).not.toHaveProperty('custom_only');
        expect(request.options.headers['X-Test']).toBe('yes');
    });

    test.each([
        ['koboldcpp/Llama-3.2-1B-Instruct-Q8_0', 100],
        // A reasoning model keeps its budget, judged by the model the client reported.
        ['koboldcpp/Qwen3-0.6B-Q8_0', 4000],
    ])('applies the response limit after the Additional Parameters for %s', async (model, expected) => {
        await generate({
            model,
            koboldcpp_include_body: 'max_tokens: 4000',
            request_controls: { maxOutputTokens: 100 },
        });

        const [request] = getRequests('/v1/chat/completions');
        expect(request.body.max_tokens).toBe(expected);
        expect(request.body).not.toHaveProperty('request_controls');
    });

    test('converts attached audio to the input_audio part KoboldCpp reads', async () => {
        await generate({
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Listen' }, { type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,UklGRg==' } }] }],
        });

        const [request] = getRequests('/v1/chat/completions');
        expect(request.body.messages[0].content[1]).toEqual({ type: 'input_audio', input_audio: { format: 'wav', data: 'UklGRg==' } });
    });

    test('generates without a key when none is saved', async () => {
        const response = await generate({}, { keyless: true });

        expect(response.status).toBe(200);
        expect(getRequests('/v1/chat/completions')).toHaveLength(1);
    });

    test('turns down a generation without a usable URL', async () => {
        const response = await generate({ koboldcpp_url: 'not a url' });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: { message: 'KoboldCpp API URL is not valid.' } });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('asks KoboldCpp to stop the generation by its key when the client leaves', async () => {
        fetchMock.mockImplementation(async (url) => {
            if (new URL(String(url)).pathname === '/api/extra/abort') {
                return jsonResponse({ success: 'true', done: 'true' });
            }
            const stream = new PassThrough();
            openStreams.push(stream);
            stream.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n');
            return new FetchResponse(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        });

        const controller = new AbortController();
        const response = await generate({ stream: true }, { signal: controller.signal });
        const reader = response.body.getReader();
        await reader.read();
        controller.abort();

        const deadline = Date.now() + 5000;
        while (!getRequests('/api/extra/abort').length && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        const [generation] = getRequests('/v1/chat/completions');
        const aborts = getRequests('/api/extra/abort');
        expect(aborts).toHaveLength(1);
        expect(aborts[0].url.origin).toBe('http://127.0.0.1:5001');
        expect(aborts[0].body).toEqual({ genkey: generation.body.genkey });
        expect(aborts[0].options.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });

    test('sends no abort after a finished generation', async () => {
        await generate();
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(getRequests('/api/extra/abort')).toHaveLength(0);
    });
});
