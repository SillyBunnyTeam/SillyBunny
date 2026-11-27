import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';
import { importOpenAiModule } from './util/openai-harness.js';

const { default: actualNodeFetch } = await import('node-fetch');
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

const { openai } = await importOpenAiModule();
const indexSource = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

describe('DeepSeek reasoning effort', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let capturedBody;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-deepseek-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        fs.copyFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), configPath);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-deepseek-user-'));
        tempDirs.push(userRoot);
        new SecretManager({ root: userRoot, backups: userRoot }).writeSecret(SECRET_KEYS.DEEPSEEK, 'deepseek-test-key');

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
        baseUrl = `http://127.0.0.1:${appServer.address().port}`;
    });

    beforeEach(() => {
        capturedBody = undefined;
        nodeFetchMock.mockReset();
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
            await new Promise((resolve, reject) => appServer.close(error => error ? reject(error) : resolve()));
        }
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        nodeFetchMock.mockImplementation((url, options) => actualNodeFetch(url, options));
    });

    function sendDeepSeek(overrides = {}) {
        return fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.DEEPSEEK,
                model: 'deepseek-v4-flash',
                stream: false,
                max_tokens: 128,
                messages: [{ role: 'user', content: 'Question' }],
                ...overrides,
            }),
        });
    }

    test('exposes the reasoning effort control and a DeepSeek-specific hint', () => {
        const wrapper = indexSource.match(/<div class="flex-container flexFlowColumn wide100p textAlignCenter marginTop10" data-source="([^"]*)">\s*<div class="flex-container oneline-dropdown"[^>]*>\s*<label for="openai_reasoning_effort">/);

        expect(wrapper).not.toBeNull();
        expect(wrapper[1].split(',')).toContain('deepseek');
        expect(indexSource).toMatch(/data-source="deepseek"[^>]*>\s*DeepSeek documents low, high and max reasoning efforts\./);

        // DeepSeek carries its own hint, so the generic OpenAI-style caption must not claim it.
        const genericCaption = indexSource.match(/data-source="([^"]*)"[^>]*>\s*OpenAI-style options: low, medium, high, xhigh\./);
        expect(genericCaption).not.toBeNull();
        expect(genericCaption[1].split(',')).not.toContain('deepseek');
    });

    test('preserves DeepSeek max effort on the client instead of collapsing it to high', async () => {
        const { generate_data } = await openai.createGenerationParameters(
            {
                ...openai.oai_settings,
                chat_completion_source: openai.chat_completion_sources.DEEPSEEK,
                reasoning_effort: openai.reasoning_effort_types.max,
            },
            'deepseek-v4-pro',
            'normal',
            [{ role: 'user', content: 'Hello' }],
        );

        expect(generate_data.reasoning_effort).toBe('max');
    });

    test.each([
        ['min', 'minimal'],
        ['low', 'low'],
        ['high', 'high'],
        ['max', 'max'],
    ])('forwards %s as %s to DeepSeek thinking models', async (effort, expected) => {
        const response = await sendDeepSeek({ model: 'deepseek-reasoner', reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe(expected);
    });

    test.each(['auto', 'none'])('omits reasoning_effort on DeepSeek thinking models for %s', async (effort) => {
        const response = await sendDeepSeek({ model: 'deepseek-v4-pro', reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning_effort')).toBe(false);
    });

    test('omits reasoning_effort for non-thinking DeepSeek models', async () => {
        const response = await sendDeepSeek({ model: 'deepseek-chat', reasoning_effort: 'high' });

        expect(response.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning_effort')).toBe(false);
    });

    test('offers the current V4 model ids, both of which the server treats as thinking models', async () => {
        const picker = indexSource.match(/<select id="model_deepseek_select">([\s\S]*?)<\/select>/);

        expect(picker).not.toBeNull();
        const modelIds = [...picker[1].matchAll(/value="([^"]*)"/g)].map(m => m[1]);
        expect(modelIds).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
        expect(openai.oai_settings.deepseek_model).toBe('deepseek-v4-flash');

        // Every shipped option must carry reasoning_effort through the real server handler.
        for (const model of modelIds) {
            capturedBody = undefined;
            const response = await sendDeepSeek({ model, reasoning_effort: 'max' });
            expect(response.status).toBe(200);
            expect(capturedBody.reasoning_effort).toBe('max');
        }
    });
});
