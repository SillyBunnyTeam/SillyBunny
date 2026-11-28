import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';

const { default: actualNodeFetch } = await import('node-fetch');
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

describe('final Custom request controls', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-story-custom-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        fs.copyFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), configPath);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-story-custom-user-'));
        tempDirs.push(userRoot);
        const secretManager = new SecretManager({ root: userRoot, backups: userRoot });
        secretManager.writeSecret(SECRET_KEYS.CUSTOM, 'test-secret');

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
        nodeFetchMock.mockReset();
        nodeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
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

    async function sendCustom(body) {
        const response = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
                model: 'ordinary',
                messages: [{ role: 'user', content: 'prompt' }],
                max_tokens: 8192,
                custom_url: 'https://example.invalid/v1',
                stream: false,
                ...body,
            }),
        });
        expect(response.status).toBe(200);
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        const outgoing = JSON.parse(nodeFetchMock.mock.calls[0][1].body);
        expect(outgoing.request_controls).toBeUndefined();
        return outgoing;
    }

    test('caps the final ordinary payload after YAML overrides, including a max_completion_tokens override', async () => {
        const result = await sendCustom({
            include_reasoning: true,
            custom_include_body: 'max_completion_tokens: 12000\nthinking:\n  type: disabled',
            custom_exclude_body: '- max_tokens',
            request_controls: { maxOutputTokens: 160 },
        });
        expect(result.max_completion_tokens).toBe(160);
        expect(result.max_tokens).toBeUndefined();
        expect(result.thinking).toEqual({ type: 'disabled' });
    });

    test.each(['enabled', 'adaptive'])('preserves an explicit %s thinking allowance after Custom overrides', async type => {
        const result = await sendCustom({
            custom_include_body: `max_tokens: 8192\nthinking:\n  type: ${type}\n  budget_tokens: 4096`,
            request_controls: { maxOutputTokens: 160 },
        });
        expect(result.max_tokens).toBe(8192);
        expect(result.thinking).toEqual({ type, budget_tokens: 4096 });
    });

    test.each([true, false])('detects the actual Custom thinking switch, not include_reasoning by itself: %s', async enabled => {
        const result = await sendCustom({
            include_reasoning: enabled,
            custom_reasoning_param_name: 'thinking', custom_reasoning_param_format: 'thinking_object',
            request_controls: { maxOutputTokens: 160 },
        });
        expect(result.max_tokens).toBe(enabled ? 8192 : 160);
        expect(result.thinking.type).toBe(enabled ? 'enabled' : 'disabled');
    });

    test.each([true, false])('selection responseLength preserves the original total only with active thinking: %s', async enabled => {
        const result = await sendCustom({
            custom_include_body: `thinking:\n  type: ${enabled ? 'enabled' : 'disabled'}`,
            request_controls: { responseLength: 64, preserveReasoningBudget: true },
        });
        expect(result.max_tokens).toBe(enabled ? 8192 : 64);
    });

    test('restores a response limit if Custom excludes removed all budget fields', async () => {
        const result = await sendCustom({ custom_exclude_body: '- max_tokens', request_controls: { maxOutputTokens: 160 } });
        expect(result.max_tokens).toBe(160);
    });

    test('leaves uncontrolled and invalid-limit requests unchanged', async () => {
        const plain = await sendCustom({ custom_include_body: 'max_tokens: 12000' });
        nodeFetchMock.mockClear();
        const invalid = await sendCustom({ custom_include_body: 'max_tokens: 12000', request_controls: { maxOutputTokens: '160' } });
        expect(plain.max_tokens).toBe(12000);
        expect(invalid.max_tokens).toBe(12000);
    });

    test('never forwards host control annotations from Custom YAML', async () => {
        const result = await sendCustom({
            custom_include_body: 'request_controls:\n  maxOutputTokens: 1\nmax_tokens: 12000',
            request_controls: { maxOutputTokens: 160 },
        });
        expect(result.max_tokens).toBe(160);
    });

    test('preserves the exact Custom budget for a configured nonstandard thinking switch', async () => {
        const result = await sendCustom({
            include_reasoning: true,
            custom_reasoning_param_name: 'reasoning_mode', custom_reasoning_param_format: 'string',
            custom_reasoning_enabled_value: 'on', custom_reasoning_disabled_value: 'off',
            custom_include_body: 'max_tokens: 12345',
            request_controls: { responseLength: 64, preserveReasoningBudget: true },
        });
        expect(result.reasoning_mode).toBe('on');
        expect(result.max_tokens).toBe(12345);
    });

    test.each(['boolean', 'string', 'thinking_object'])('uses the final overridden Custom thinking value: %s', async format => {
        const off = format === 'boolean' ? 'false' : format === 'thinking_object' ? '{ type: off }' : 'off';
        const result = await sendCustom({
            include_reasoning: true,
            custom_reasoning_param_name: 'reasoning_mode', custom_reasoning_param_format: format,
            custom_reasoning_enabled_value: 'on', custom_reasoning_disabled_value: 'off',
            custom_include_body: `reasoning_mode: ${off}\nmax_tokens: 12345`,
            request_controls: { responseLength: 64, preserveReasoningBudget: true },
        });
        expect(result.max_tokens).toBe(64);
        expect(result.thinking).toBeUndefined();
        expect(result.reasoning).toBeUndefined();
    });
});
