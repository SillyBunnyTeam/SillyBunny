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

describe('Google model request compatibility', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let capturedBody;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-google-model-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-google-model-user-'));
        tempDirs.push(userRoot);
        const secretManager = new SecretManager({ root: userRoot, backups: userRoot });
        secretManager.writeSecret(SECRET_KEYS.MAKERSUITE, 'google-test-key');

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
                candidates: [{ content: { parts: [{ text: 'ok' }] } }],
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

    function makeRequest(model, options = {}) {
        return fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.MAKERSUITE,
                model,
                stream: false,
                max_tokens: 128,
                temperature: 1,
                top_p: 0.9,
                top_k: 40,
                messages: [{ role: 'user', content: 'Question' }],
                ...options,
            }),
        });
    }

    test.each(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-nano-banana-2.1'])(
        'omits unsupported sampling parameters for %s',
        async (model) => {
            const response = await makeRequest(model);

            expect(response.status).toBe(200);
            expect(capturedBody.generationConfig).not.toHaveProperty('temperature');
            expect(capturedBody.generationConfig).not.toHaveProperty('topP');
            expect(capturedBody.generationConfig).not.toHaveProperty('topK');
            expect(capturedBody.generationConfig).not.toHaveProperty('candidateCount');
        },
    );

    test('keeps sampling parameters for older Gemini models', async () => {
        const response = await makeRequest('gemini-2.5-flash');

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig).toMatchObject({
            temperature: 1,
            topP: 0.9,
            topK: 40,
            candidateCount: 1,
        });
    });

    test('sends a thinking level for Gemini 4', async () => {
        const response = await makeRequest('gemini-4-argon', { reasoning_effort: 'medium' });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'medium' });
    });

    test('sends the highest documented thinking level when Gemini 4 is asked for max', async () => {
        const response = await makeRequest('gemini-4-argon', { reasoning_effort: 'max' });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    });

    test('turns off the fetch idle timeout so a long thinking pass can stay silent', async () => {
        const response = await makeRequest('gemini-4-argon');

        expect(response.status).toBe(200);
        expect(nodeFetchMock.mock.calls[0][1].timeout).toBe(0);
    });

    describe('replies that end early', () => {
        function replyWith(candidate) {
            nodeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ candidates: [candidate] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        }

        test.each(['MAX_TOKENS', 'CONTINUATION'])('marks partial text as a length finish on %s', async (finishReason) => {
            replyWith({ content: { parts: [{ text: 'partial' }] }, finishReason });

            const json = await (await makeRequest('gemini-4-argon')).json();

            expect(json.choices[0].message.content).toBe('partial');
            expect(json.choices[0].finish_reason).toBe('length');
        });

        test('leaves a normal finish without a finish reason', async () => {
            replyWith({ content: { parts: [{ text: 'complete' }] }, finishReason: 'STOP' });

            const json = await (await makeRequest('gemini-4-argon')).json();

            expect(json.choices[0].message.content).toBe('complete');
            expect(json.choices[0]).not.toHaveProperty('finish_reason');
        });

        test.each(['MAX_TOKENS', 'CONTINUATION'])('does not call a thinking-only %s reply an empty candidate', async (finishReason) => {
            replyWith({ content: { parts: [{ text: 'thinking', thought: true }] }, finishReason, continuationToken: 'token' });

            const json = await (await makeRequest('gemini-4-argon')).json();

            expect(json.error.message).toBeTruthy();
            expect(json.error.message).not.toContain('Candidate text empty');
        });

        test('keeps the generic error when another finish leaves no reply text', async () => {
            replyWith({ content: { parts: [] }, finishReason: 'SAFETY' });

            const json = await (await makeRequest('gemini-4-argon')).json();

            expect(json.error.message).toContain('Candidate text empty');
        });
    });

    test('requests image output with a size for Nano Banana 2.1', async () => {
        const response = await makeRequest('gemini-nano-banana-2.1', {
            request_images: true,
            request_image_resolution: '2K',
            request_image_aspect_ratio: '16:9',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.responseModalities).toEqual(['text', 'image']);
        expect(capturedBody.generationConfig.imageConfig).toEqual({ imageSize: '2K', aspectRatio: '16:9' });
    });

    test('omits the image size for gemini-3.1-flash-lite-image, which renders only at 1K', async () => {
        const response = await makeRequest('gemini-3.1-flash-lite-image', {
            request_images: true,
            request_image_resolution: '2K',
            request_image_aspect_ratio: '16:9',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.responseModalities).toEqual(['text', 'image']);
        expect(capturedBody.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9' });
    });
});
