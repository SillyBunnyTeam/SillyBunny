import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
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

const readSource = (relativePath) => fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const indexSource = readSource('../public/index.html');
const openAiSource = readSource('../public/scripts/openai.js');
const chatCompletionsSource = readSource('../src/endpoints/backends/chat-completions.js');

describe('DeepSeek reasoning effort', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-deepseek-config-'));
        tempDirs.push(configRoot);
        const configPath = path.join(configRoot, 'config.yaml');
        fs.copyFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), configPath);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-deepseek-user-'));
        tempDirs.push(userRoot);

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

    afterAll(async () => {
        if (appServer) {
            await new Promise((resolve, reject) => appServer.close(err => err ? reject(err) : resolve()));
        }
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        nodeFetchMock.mockImplementation((url, options) => actualNodeFetch(url, options));
    });

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

    test('keeps DeepSeek out of the string-effort resolver so max is not collapsed to high', () => {
        const sources = openAiSource.match(/const reasoningEffortSources = \[([\s\S]*?)\];/);

        expect(sources).not.toBeNull();
        expect(sources[1]).not.toContain('DEEPSEEK');
    });

    test('forwards the effort to DeepSeek for thinking models only, mapping min to low', () => {
        const handler = chatCompletionsSource.match(/async function sendDeepSeekRequest\(request, response\) \{([\s\S]*?)\n\}/);

        expect(handler).not.toBeNull();
        expect(handler[1]).toContain('const isThinkingModel = /(?:^|-)reasoner$|deepseek-v4|deepseek-flash/i.test(String(request.body.model || \'\'));');
        expect(handler[1]).toContain('if (isThinkingModel && request.body.reasoning_effort && ![\'auto\', \'none\'].includes(request.body.reasoning_effort)) {');
        expect(handler[1]).toContain('bodyParams[\'reasoning_effort\'] = toWireReasoningEffort(request.body.reasoning_effort);');
    });

    test('offers deepseek-flash and deepseek-v4-pro, both of which the server treats as thinking models', () => {
        const picker = indexSource.match(/<select id="model_deepseek_select">([\s\S]*?)<\/select>/);

        expect(picker).not.toBeNull();
        const modelIds = [...picker[1].matchAll(/value="([^"]*)"/g)].map(m => m[1]);
        expect(modelIds).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
        expect(openAiSource).toContain('deepseek_model: \'deepseek-flash\',');

        // Every shipped default must satisfy the handler's isThinkingModel test, or the dropdown silently does nothing.
        for (const model of modelIds) {
            expect(/(?:^|-)reasoner$|deepseek-v4|deepseek-flash/i.test(model)).toBe(true);
        }
    });

    test('exposes inline media for DeepSeek and recognizes both deepseek-flash and legacy vision ids', () => {
        const mediaBlock = indexSource.match(/<div class="range-block" data-source="([^"]*)">\s*<label for="openai_media_inlining"/);
        expect(mediaBlock).not.toBeNull();
        expect(mediaBlock[1].split(',')).toContain('deepseek');

        const visionList = openAiSource.match(/const visionSupportedModels = \[([\s\S]*?)\];/);
        expect(visionList).not.toBeNull();
        expect(visionList[1]).toContain('\'deepseek-flash\'');
        expect(visionList[1]).toContain('\'deepseek-v4-flash-vision-exp\'');
        expect(openAiSource).toContain('/deepseek-(?:flash|v4-flash)/i.test(model)');
    });

    test('deepseek-flash forwards reasoning_effort and adds reasoning_content to tool_call messages', async () => {
        let capturedBody = null;
        nodeFetchMock.mockReset();
        nodeFetchMock.mockImplementation(async (_url, options) => {
            capturedBody = JSON.parse(options?.body ?? '{}');
            return new Response(JSON.stringify({
                id: 'ds-test',
                choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        const res = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.DEEPSEEK,
                reverse_proxy: 'https://api.deepseek.com',
                proxy_password: 'test-key',
                model: 'deepseek-flash',
                stream: false,
                reasoning_effort: 'high',
                tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
                tool_choice: 'auto',
                messages: [
                    { role: 'user', content: 'Check weather' },
                    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
                    { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
                ],
            }),
        });

        expect(res.status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe('high');
        const toolCallMsg = capturedBody.messages.find(m => Array.isArray(m.tool_calls));
        expect(toolCallMsg).toBeDefined();
        expect(Object.hasOwn(toolCallMsg, 'reasoning_content')).toBe(true);
    });
});
