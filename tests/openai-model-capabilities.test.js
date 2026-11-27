/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static markup contracts. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { TextDecoder, TextEncoder } from 'node:util';

import {
    applyClaudeModelParameterConstraints,
    applyGrokModelParameterConstraints,
    applyKimiK3ModelParameterConstraints,
    isKimiK3Model,
} from '../public/scripts/openai-model-capabilities.js';
import { importOpenAiModule } from './util/openai-harness.js';

const indexSource = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const jquerySource = fs.readFileSync(fileURLToPath(new URL('../public/lib/jquery-3.5.1.min.js', import.meta.url)), 'utf8');

(0, eval)(jquerySource);
$.fn.select2 = function () { return this; };
$.fn.sortable = function () { return this; };

const { openai } = await importOpenAiModule();
const initialDefaults = structuredClone(openai.oai_settings);

describe('OpenAI-compatible Claude model capabilities', () => {
    beforeEach(() => {
        Object.assign(openai.oai_settings, structuredClone(initialDefaults));
        document.body.innerHTML = '';
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    test('removes unsupported parameters from provider-prefixed Claude 5 requests', () => {
        for (const model of ['anthropic/claude-sonnet-5', 'anthropic/claude-opus-5']) {
            const payload = {
                model,
                temperature: 0.8,
                top_p: 0.9,
                top_k: 40,
                frequency_penalty: 0.2,
                presence_penalty: 0.3,
                reasoning_effort: 'high',
                custom_reasoning_param_name: 'reasoning_effort',
            };

            applyClaudeModelParameterConstraints(payload);

            expect(payload).toEqual({ model });
        }
    });

    test('preserves native Claude 5 reasoning controls while removing sampling parameters', () => {
        for (const model of ['claude-sonnet-5', 'claude-opus-5']) {
            const payload = {
                model,
                temperature: 0.8,
                top_p: 0.9,
                top_k: 40,
                reasoning_effort: 'high',
                custom_reasoning_param_name: 'reasoning_effort',
            };

            applyClaudeModelParameterConstraints(payload, { preserveReasoning: true });

            expect(payload).toEqual({
                model,
                reasoning_effort: 'high',
                custom_reasoning_param_name: 'reasoning_effort',
            });
        }
    });

    test('applies Claude model constraints while building generation parameters', async () => {
        const baseSettings = {
            ...openai.oai_settings,
            temp_openai: 0.8,
            top_p_openai: 0.9,
            top_k_openai: 40,
            freq_pen_openai: 0.2,
            pres_pen_openai: 0.3,
            reasoning_effort: 'high',
        };

        // Native Claude and LinkAPI preserve reasoning_effort while stripping sampling parameters.
        for (const source of [openai.chat_completion_sources.CLAUDE, openai.chat_completion_sources.LINKAPI]) {
            const { generate_data } = await openai.createGenerationParameters(
                { ...baseSettings, chat_completion_source: source },
                'claude-sonnet-5',
                'normal',
                [],
            );
            expect(generate_data.reasoning_effort).toBe('high');
            expect(generate_data).not.toHaveProperty('temperature');
            expect(generate_data).not.toHaveProperty('top_p');
            expect(generate_data).not.toHaveProperty('top_k');
        }

        // Other providers (e.g. OpenRouter) strip reasoning_effort as well as sampling parameters.
        const { generate_data: openRouterData } = await openai.createGenerationParameters(
            { ...baseSettings, chat_completion_source: openai.chat_completion_sources.OPENROUTER },
            'anthropic/claude-sonnet-5',
            'normal',
            [],
        );
        expect(openRouterData).not.toHaveProperty('reasoning_effort');
        expect(openRouterData).not.toHaveProperty('temperature');
        expect(openRouterData).not.toHaveProperty('top_p');
    });
});

describe('Grok model capabilities', () => {
    test('removes penalty samplers from Grok reasoning model requests', () => {
        for (const model of ['grok-4.6', 'grok-4.5', 'grok-4-0709', 'grok-code-fast-1', 'grok-3-mini', 'x-ai/Grok-4.6', '[SP]grok-4.6']) {
            const payload = {
                model,
                temperature: 0.8,
                top_p: 0.9,
                frequency_penalty: 0.2,
                presence_penalty: 0.3,
                reasoning_effort: 'high',
            };

            applyGrokModelParameterConstraints(payload);

            expect(payload).toEqual({
                model,
                temperature: 0.8,
                top_p: 0.9,
                reasoning_effort: 'high',
            });
        }
    });

    test('leaves payloads for other models unchanged', () => {
        for (const model of ['grok-3', 'grok-2-vision', 'gpt-5.1', 'claude-sonnet-5', '', undefined]) {
            const payload = {
                model,
                frequency_penalty: 0.2,
                presence_penalty: 0.3,
            };

            applyGrokModelParameterConstraints(payload);

            expect(payload).toEqual({
                model,
                frequency_penalty: 0.2,
                presence_penalty: 0.3,
            });
        }
    });

    test('applies Grok constraints to LinkAPI requests only', async () => {
        jest.resetModules();
        const forwardedPayloads = [];
        const fetchMock = jest.fn(async (_url, options) => {
            forwardedPayloads.push(JSON.parse(options.body));
            return {
                ok: true,
                status: 200,
                headers: new Map(),
                json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
                text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
            };
        });
        await jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
        await jest.unstable_mockModule(fileURLToPath(new URL('../src/endpoints/secrets.js', import.meta.url)), () => ({
            SECRETS_FILE: 'secrets.json',
            SECRET_KEYS: { LINKAPI: 'api_key_linkapi', OPENAI: 'api_key_openai' },
            allowKeysExposure: false,
            readSecret: jest.fn(() => 'test-key'),
            findSecret: jest.fn(() => 'test-key'),
            readSecretState: jest.fn(() => ({})),
            getAllSecrets: jest.fn(() => ({})),
            writeSecret: jest.fn(),
            deleteSecret: jest.fn(),
            migrateFlatSecrets: jest.fn(),
            SecretManager: class SecretManager {},
            router: express.Router(),
        }));
        await jest.unstable_mockModule(fileURLToPath(new URL('../src/endpoints/tokenizers.js', import.meta.url)), () => ({
            router: express.Router(),
            getTokenizerModel: jest.fn(() => 'gpt-4o'),
            getSentencepiceTokenizer: jest.fn(),
            getTiktokenTokenizer: jest.fn(),
            getWebTokenizer: jest.fn(),
            sentencepieceTokenizers: [],
            webTokenizers: [],
            TEXT_COMPLETION_MODELS: [],
        }));

        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

        if (typeof globalThis.TextDecoder === 'undefined') {
            globalThis.TextDecoder = TextDecoder;
            globalThis.TextEncoder = TextEncoder;
        }

        const { router } = await import('../src/endpoints/backends/chat-completions.js');
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: '.' } };
            next();
        });
        app.use('/', router);

        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const postJson = (body) => new Promise((resolve, reject) => {
            const payload = JSON.stringify(body);
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: '/generate',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            }, (res) => {
                let raw = '';
                res.on('data', chunk => { raw += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, raw }));
            });
            req.on('error', reject);
            req.end(payload);
        });

        try {
            await postJson({
                chat_completion_source: 'linkapi',
                model: 'grok-4.6',
                messages: [{ role: 'user', content: 'Hi' }],
                temperature: 0.8,
                frequency_penalty: 0.2,
                presence_penalty: 0.3,
                stream: false,
            });

            await postJson({
                chat_completion_source: 'openai',
                model: 'grok-4.6',
                messages: [{ role: 'user', content: 'Hi' }],
                temperature: 0.8,
                frequency_penalty: 0.2,
                presence_penalty: 0.3,
                stream: false,
            });
        } finally {
            await new Promise(resolve => server.close(resolve));
        }

        expect(forwardedPayloads).toHaveLength(2);
        // LinkAPI strips frequency_penalty and presence_penalty for Grok reasoning models.
        expect(forwardedPayloads[0]).not.toHaveProperty('frequency_penalty');
        expect(forwardedPayloads[0]).not.toHaveProperty('presence_penalty');
        // Non-LinkAPI requests preserve those fields.
        expect(forwardedPayloads[1].frequency_penalty).toBe(0.2);
        expect(forwardedPayloads[1].presence_penalty).toBe(0.3);
    });
});

describe('Kimi K3 model capabilities', () => {
    beforeEach(() => {
        Object.assign(openai.oai_settings, structuredClone(initialDefaults));
        document.body.innerHTML = '';
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    test('recognizes native and provider-prefixed K3 model IDs', () => {
        for (const model of ['kimi-k3', 'KIMI-K3', 'moonshotai/kimi-k3', 'models:moonshotai/kimi-k3']) {
            expect(isKimiK3Model(model)).toBe(true);
        }
    });

    test('rejects unrelated model IDs', () => {
        for (const model of ['kimi-k2.5', 'moonshotai/kimi-k2', 'not-kimi-k3', '', undefined]) {
            expect(isKimiK3Model(model)).toBe(false);
        }
    });

    test('removes parameters fixed by the Kimi K3 API', () => {
        const payload = {
            model: 'moonshotai/Kimi-K3',
            temperature: 1,
            top_p: 0.95,
            frequency_penalty: 0,
            presence_penalty: 0,
            n: 3,
            max_tokens: 4096,
            reasoning_effort: 'max',
            thinking: { type: 'enabled' },
        };

        applyKimiK3ModelParameterConstraints(payload);

        expect(payload).toEqual({
            model: 'moonshotai/Kimi-K3',
            max_tokens: 4096,
            reasoning_effort: 'max',
        });
    });

    test('leaves non-K3 payloads unchanged', () => {
        const payload = {
            model: 'kimi-k2.5',
            temperature: 0.7,
            n: 2,
        };

        applyKimiK3ModelParameterConstraints(payload);

        expect(payload).toEqual({
            model: 'kimi-k2.5',
            temperature: 0.7,
            n: 2,
        });
    });

    test('applies K3 constraints and disables multi-swipe while building Custom, Moonshot, NanoGPT and OpenRouter generation parameters', async () => {
        for (const source of [
            openai.chat_completion_sources.CUSTOM,
            openai.chat_completion_sources.MOONSHOT,
            openai.chat_completion_sources.NANOGPT,
            openai.chat_completion_sources.OPENROUTER,
        ]) {
            const { generate_data, canMultiSwipe } = await openai.createGenerationParameters(
                { ...openai.oai_settings, chat_completion_source: source, n: 3, temp_openai: 0.9, top_p_openai: 0.8 },
                'moonshotai/kimi-k3',
                'normal',
                [],
            );
            expect(canMultiSwipe).toBe(false);
            expect(generate_data).not.toHaveProperty('temperature');
            expect(generate_data).not.toHaveProperty('top_p');
            expect(generate_data).not.toHaveProperty('n');
        }
    });

    test('exposes a dedicated Partial Prefill control only for K3 models', async () => {
        expect(indexSource).toMatch(/<div class="range-block" data-source="custom,moonshot,nanogpt,openrouter">[\s\S]*?id="openai_kimi_partial_prefill"/);
        expect(indexSource).toContain('for="openai_kimi_partial_prefill" class="range-block-title justifyLeft"');

        document.body.innerHTML = `
            <select id="chat_completion_source">
                <option value="moonshot">Moonshot</option>
                <option value="openai">OpenAI</option>
            </select>
            <select id="model_moonshot_select">
                <option value="kimi-k3">kimi-k3</option>
                <option value="kimi-k2.5">kimi-k2.5</option>
            </select>
            <div class="range-block" id="k3_block" data-source="custom,moonshot,nanogpt,openrouter">
                <input id="openai_kimi_partial_prefill" type="text" />
            </div>
        `;
        openai.model_list.splice(0, openai.model_list.length, { id: 'kimi-k3' }, { id: 'kimi-k2.5' });
        openai.initOpenAI();

        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.MOONSHOT;
        $('#model_moonshot_select').val('kimi-k3').trigger('change');
        expect(document.getElementById('k3_block').style.display).not.toBe('none');

        $('#model_moonshot_select').val('kimi-k2.5').trigger('change');
        expect(document.getElementById('k3_block').style.display).toBe('none');

        document.body.innerHTML = '';
        await Promise.resolve();

        // Only the Advanced Formatting input carries the class that keeps Start Reply With in sync.
        // Live power-user.js and preset-manager.js sync is tested in tests/start-reply-with-sync.test.js.
        expect(indexSource.match(/class="start-reply-with-input [^"]*"/g)).toHaveLength(1);
        expect(indexSource).toContain('id="start_reply_with"');
    });
});
