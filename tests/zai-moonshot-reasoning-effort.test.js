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

describe('reasoning effort on Z.AI and Moonshot requests', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let capturedBody;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-zai-moonshot-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-zai-moonshot-user-'));
        tempDirs.push(userRoot);
        const secretManager = new SecretManager({ root: userRoot, backups: userRoot });
        secretManager.writeSecret(SECRET_KEYS.ZAI, 'zai-test-key');
        secretManager.writeSecret(SECRET_KEYS.MOONSHOT, 'moonshot-test-key');

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

    describe('Z.AI', () => {
        // Z.AI's ladder is none < minimal < low < medium < high < xhigh < max, which is this
        // fork's own ladder with the bottom rung named 'minimal' instead of 'min'.
        test.each([
            ['min', 'minimal'],
            ['low', 'low'],
            ['medium', 'medium'],
            ['high', 'high'],
            ['xhigh', 'xhigh'],
            ['max', 'max'],
        ])('sends %s as %s on GLM-5.2', async (effort, expected) => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.ZAI, { model: 'glm-5.2', reasoning_effort: effort });

            expect(response.status).toBe(200);
            expect(capturedBody.reasoning_effort).toBe(expected);
        });

        test('keeps sending the thinking switch alongside the effort', async () => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.ZAI, {
                model: 'glm-5.2',
                reasoning_effort: 'high',
                include_reasoning: true,
            });

            expect(response.status).toBe(200);
            expect(capturedBody.thinking).toEqual({ type: 'enabled' });
            expect(capturedBody.reasoning_effort).toBe('high');
        });

        test.each(['none', 'auto', '   '])('omits the effort entirely for %p', async (effort) => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.ZAI, { model: 'glm-5.2', reasoning_effort: effort });

            expect(response.status).toBe(200);
            expect(Object.hasOwn(capturedBody, 'reasoning_effort')).toBe(false);
        });

        // Z.AI documents reasoning_effort from GLM-5.2 onwards; older releases would reject it.
        test.each(['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-5v-turbo', 'glm-4.7', 'glm-4-32b-0414-128k', 'autoglm-phone-multilingual'])(
            'omits the effort on %s, which predates the parameter',
            async (model) => {
                const response = await makeRequest(CHAT_COMPLETION_SOURCES.ZAI, { model, reasoning_effort: 'high' });

                expect(response.status).toBe(200);
                expect(Object.hasOwn(capturedBody, 'reasoning_effort')).toBe(false);
                expect(capturedBody.thinking).toEqual({ type: 'disabled' });
            },
        );

        test.each(['glm-5.3', 'glm-5.10', 'glm-6'])('sends the effort on %s, which is newer than 5.2', async (model) => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.ZAI, { model, reasoning_effort: 'high' });

            expect(response.status).toBe(200);
            expect(capturedBody.reasoning_effort).toBe('high');
        });

        test('normalizes UI casing before the gate', async () => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.ZAI, { model: 'glm-5.2', reasoning_effort: ' Min ' });

            expect(response.status).toBe(200);
            expect(capturedBody.reasoning_effort).toBe('minimal');
        });
    });

    describe('Moonshot', () => {
        // Moonshot documents low, high and max for Kimi K3 and nothing else, so the rungs it
        // omits are folded rather than forwarded.
        test.each([
            ['min', 'low'],
            ['low', 'low'],
            ['medium', 'high'],
            ['high', 'high'],
            ['xhigh', 'high'],
            ['max', 'max'],
        ])('sends %s as %s on Kimi K3', async (effort, expected) => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.MOONSHOT, { model: 'kimi-k3', reasoning_effort: effort });

            expect(response.status).toBe(200);
            expect(capturedBody.reasoning_effort).toBe(expected);
        });

        test('does not add the thinking object that K3 rejects', async () => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.MOONSHOT, {
                model: 'kimi-k3',
                reasoning_effort: 'max',
                include_reasoning: true,
            });

            expect(response.status).toBe(200);
            expect(capturedBody.thinking).toBeUndefined();
            expect(capturedBody.reasoning_effort).toBe('max');
        });

        test.each(['none', 'auto', 'banana', '   '])('omits the effort entirely for %p', async (effort) => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.MOONSHOT, { model: 'kimi-k3', reasoning_effort: effort });

            expect(response.status).toBe(200);
            expect(Object.hasOwn(capturedBody, 'reasoning_effort')).toBe(false);
        });

        // Only K3 exposes the parameter; the older models keep the thinking object.
        test.each(['kimi-k2.5', 'kimi-latest', 'moonshot-v1-128k'])('omits the effort on %s and keeps thinking', async (model) => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.MOONSHOT, {
                model,
                reasoning_effort: 'high',
                include_reasoning: true,
            });

            expect(response.status).toBe(200);
            expect(Object.hasOwn(capturedBody, 'reasoning_effort')).toBe(false);
            expect(capturedBody.thinking).toEqual({ type: 'enabled' });
        });

        test('normalizes UI casing before the table lookup', async () => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.MOONSHOT, { model: 'kimi-k3', reasoning_effort: ' XHigh ' });

            expect(response.status).toBe(200);
            expect(capturedBody.reasoning_effort).toBe('high');
        });
    });

    test('the Reasoning Effort control is shown for both sources', () => {
        const indexSource = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
        const wrapper = indexSource.match(/<div class="flex-container flexFlowColumn wide100p textAlignCenter marginTop10" data-source="([^"]*)">\s*<div class="flex-container oneline-dropdown"[^>]*>\s*<label for="openai_reasoning_effort">/);

        expect(wrapper).not.toBeNull();
        expect(wrapper[1].split(',')).toEqual(expect.arrayContaining(['zai', 'moonshot']));

        // The generic OpenAI-style caption describes tiers neither provider has, so it must not claim them.
        const genericCaption = indexSource.match(/data-source="([^"]*)"[^>]*>\s*OpenAI-style options: low, medium, high, xhigh\./);
        expect(genericCaption).not.toBeNull();
        expect(genericCaption[1].split(',')).not.toContain('zai');
        expect(genericCaption[1].split(',')).not.toContain('moonshot');
    });

    test('keeps both sources out of the string-effort resolver so max is not collapsed to high', () => {
        const openAiSource = fs.readFileSync(fileURLToPath(new URL('../public/scripts/openai.js', import.meta.url)), 'utf8');
        const sources = openAiSource.match(/const reasoningEffortSources = \[([\s\S]*?)\];/);

        expect(sources).not.toBeNull();
        expect(sources[1]).not.toContain('ZAI');
        expect(sources[1]).not.toContain('MOONSHOT');
    });
});
