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

const { openai } = await importOpenAiModule({ mockToolCalling: false });
const { ToolManager } = await import('../public/scripts/tool-calling.js');
const indexSource = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

async function resolveClientEffort(source, model, effort = 'none') {
    const { generate_data } = await openai.createGenerationParameters(
        {
            ...openai.oai_settings,
            chat_completion_source: source,
            reasoning_effort: effort,
        },
        model,
        'normal',
        [{ role: 'user', content: 'Question' }],
    );
    return generate_data.reasoning_effort;
}

describe('reasoning effort \'none\'', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let capturedBody;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-effort-none-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        fs.copyFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), configPath);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-effort-none-user-'));
        tempDirs.push(userRoot);
        new SecretManager({ root: userRoot, backups: userRoot }).writeSecret(SECRET_KEYS.NANOGPT, 'nanogpt-test-key');

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

    test('the client resolves \'none\' to a literal only for OpenAI-style sources on GPT-5.1+ models', async () => {
        // GPT-5.1 and newer accept 'none' as a value that pins thinking off. Omitting the field
        // there lets the model pick its own default depth, which defeats picking None. Every
        // other source keeps omitting it, because endpoints that do not list the value reject it.
        const results = [];
        for (const source of ['openai', 'openai_responses', 'azure_openai', 'custom', 'fireworks', 'openrouter']) {
            for (const model of ['gpt-5', 'gpt-5.1', 'gpt-5.6', 'gpt-5.10', 'other-model']) {
                results.push({
                    source,
                    model,
                    effort: await resolveClientEffort(source, model, 'none'),
                });
            }
        }
        expect(results.filter(result => result.effort === 'none')).toEqual(
            ['openai', 'openai_responses', 'azure_openai', 'custom'].flatMap(source =>
                ['gpt-5.1', 'gpt-5.6', 'gpt-5.10'].map(model => ({ source, model, effort: 'none' })),
            ),
        );
        expect(results.every(result => result.effort === 'none' || result.effort === undefined)).toBe(true);
    });

    test('None pins thinking off on GPT-6 Sol and Luna and stays unsent on Astra', async () => {
        for (const source of ['openai', 'openai_responses', 'azure_openai', 'custom']) {
            expect(await resolveClientEffort(source, 'gpt-6-sol', 'none')).toBe('none');
            expect(await resolveClientEffort(source, 'gpt-6-luna', 'none')).toBe('none');
            expect(await resolveClientEffort(source, 'gpt-6-astra', 'none')).toBeUndefined();
        }
    });

    test('GPT-6 Sol and Luna get Chat Completions tools only with None, and Astra never does', () => {
        // SillyTavern opens this gate on Min because it sends Min as 'none'. SillyBunny sends Min as 'minimal', so None opens it here.
        const supportsTools = (source, model, reasoningEffort) => ToolManager.isToolCallingSupported(
            {
                chat_completion_source: source,
                reasoning_effort: reasoningEffort,
                function_calling: true,
                custom_prompt_post_processing: openai.custom_prompt_post_processing_types.NONE,
            },
            model,
        );

        for (const source of [CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI]) {
            for (const effort of ['auto', 'min', 'low', 'max']) {
                expect(supportsTools(source, 'gpt-6-sol', effort)).toBe(false);
                expect(supportsTools(source, 'gpt-6-luna', effort)).toBe(false);
                expect(supportsTools(source, 'gpt-6-astra', effort)).toBe(false);
            }
            expect(supportsTools(source, 'gpt-6-sol', 'none')).toBe(true);
            expect(supportsTools(source, 'gpt-6-luna', 'none')).toBe(true);
            expect(supportsTools(source, 'gpt-6-astra', 'none')).toBe(false);
        }
    });

    test('the NanoGPT handler forwards \'none\' untouched and omits \'auto\'', async () => {
        // NanoGPT's documented ladder starts at none. Gating on a translation table made the
        // caller omit the reasoning key entirely, letting the model default to thinking.
        const noneResponse = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.NANOGPT,
                model: 'test-model',
                stream: false,
                max_tokens: 128,
                messages: [{ role: 'user', content: 'Question' }],
                reasoning_effort: 'none',
            }),
        });
        expect(noneResponse.status).toBe(200);
        expect(capturedBody.reasoning).toEqual({ effort: 'none' });

        capturedBody = undefined;
        const autoResponse = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.NANOGPT,
                model: 'test-model',
                stream: false,
                max_tokens: 128,
                messages: [{ role: 'user', content: 'Question' }],
                reasoning_effort: 'auto',
            }),
        });
        expect(autoResponse.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning')).toBe(false);
    });

    test('the UI no longer promises that None is never sent', () => {
        expect(indexSource).not.toContain('None (don\'t send)');
        expect(indexSource).not.toContain('None does not send an effort level.');
        expect(indexSource).toContain('None is sent verbatim to GPT-5.1 and newer; other models get no effort level.');
    });
});
