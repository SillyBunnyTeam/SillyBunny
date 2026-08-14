import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    applyClaudeModelParameterConstraints,
    applyGrokModelParameterConstraints,
    applyKimiK3ModelParameterConstraints,
    isKimiK3Model,
} from '../public/scripts/openai-model-capabilities.js';

const openAiSource = fs.readFileSync(fileURLToPath(new URL('../public/scripts/openai.js', import.meta.url)), 'utf8');
const chatCompletionsSource = fs.readFileSync(fileURLToPath(new URL('../src/endpoints/backends/chat-completions.js', import.meta.url)), 'utf8');
const indexSource = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const powerUserSource = fs.readFileSync(fileURLToPath(new URL('../public/scripts/power-user.js', import.meta.url)), 'utf8');
const presetManagerSource = fs.readFileSync(fileURLToPath(new URL('../public/scripts/preset-manager.js', import.meta.url)), 'utf8');

describe('OpenAI-compatible Claude model capabilities', () => {
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

    test('applies Claude model constraints while building generation parameters', () => {
        expect(openAiSource).toContain('applyClaudeModelParameterConstraints, applyKimiK3ModelParameterConstraints, isKimiK3Model');
        expect(openAiSource).toContain('applyClaudeModelParameterConstraints(generate_data, {');
        expect(openAiSource).toContain('preserveReasoning: [chat_completion_sources.CLAUDE, chat_completion_sources.LINKAPI].includes(settings.chat_completion_source)');
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

    test('applies Grok constraints to LinkAPI requests only', () => {
        expect(chatCompletionsSource).toContain('applyGrokModelParameterConstraints, applyKimiK3ModelParameterConstraints, isKimiK3Model');
        expect(chatCompletionsSource).toContain('if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.LINKAPI) {\n            applyGrokModelParameterConstraints(requestBody);');
    });
});

describe('Kimi K3 model capabilities', () => {
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

    test('applies K3 constraints while building Custom, Moonshot, NanoGPT and OpenRouter generation parameters', () => {
        expect(openAiSource).toContain('const isKimiK3Request = [chat_completion_sources.CUSTOM, chat_completion_sources.MOONSHOT, chat_completion_sources.NANOGPT, chat_completion_sources.OPENROUTER]');
        expect(openAiSource).toContain('applyKimiK3ModelParameterConstraints(generate_data);');
        expect(openAiSource).toContain('&& !isKimiK3Request;');
    });

    test('exposes a synchronized Start Reply With control only for K3 models', () => {
        expect(indexSource).toMatch(/<div class="range-block" data-source="custom,moonshot,nanogpt,openrouter">[\s\S]*?id="openai_start_reply_with"/);
        expect(indexSource).toContain('for="openai_start_reply_with" class="range-block-title justifyLeft"');
        expect(indexSource.match(/class="start-reply-with-input [^"]*"/g)).toHaveLength(2);
        expect(openAiSource).toContain('.range-block:has(#openai_start_reply_with)');
        expect(openAiSource).toContain('const supportedSources = [chat_completion_sources.CUSTOM, chat_completion_sources.MOONSHOT, chat_completion_sources.NANOGPT, chat_completion_sources.OPENROUTER];');
        expect(openAiSource).toContain('.toggle(isSupportedSource && isKimiK3Model(getChatCompletionModel()))');
        expect(openAiSource.match(/updateKimiK3PrefillVisibility\(\);/g)).toHaveLength(3);
        expect(powerUserSource).toMatch(/\$\('\.start-reply-with-input'\)\.on\('input', function \(\) \{/);
        expect(powerUserSource).toMatch(/\$\('\.start-reply-with-input'\)\.not\(this\)\.val\(value\);/);
        expect(presetManagerSource).toMatch(/\$\('\.start-reply-with-input'\)\.val\(power_user\.user_prompt_bias\);/);
    });
});
