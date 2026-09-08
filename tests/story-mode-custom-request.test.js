/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import yaml from 'yaml';
import { applyGenerationRequestControls, requestUsesReasoning } from '../public/scripts/generation-request-controls.js';
import { applyKimiK3ModelParameterConstraints, isKimiK3Model } from '../public/scripts/openai-model-capabilities.js';
import { CHAT_COMPLETION_SOURCES, OPENAI_REASONING_EFFORT_MODELS, OPENAI_VERBOSITY_MODELS } from '../src/constants.js';
import { applyReasoningEffortNormalization, toWireReasoningEffort } from '../src/reasoning-effort.js';

const files = ['endpoints/backends/chat-completions.js', 'util.js'];
const sources = Object.fromEntries(files.map(file => {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    return [file, { source, ast: parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) }];
}));

function load(context, file, names) {
    const { source, ast } = sources[file];
    for (const name of names) {
        const node = ast.body.map(node => node.declaration ?? node).find(node => node.id?.name === name);
        if (!node) throw new Error(`Missing declaration: ${name}`);
        vm.runInContext(source.slice(node.start, node.end), context);
    }
}

async function sendCustom(body) {
    const context = vm.createContext({
        AbortController, yaml,
        console: { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
        CHAT_COMPLETION_SOURCES, OPENAI_REASONING_EFFORT_MODELS, OPENAI_VERBOSITY_MODELS,
        applyGenerationRequestControls, requestUsesReasoning, applyKimiK3ModelParameterConstraints, isKimiK3Model,
        applyReasoningEffortNormalization, toWireReasoningEffort,
        TEXT_COMPLETION_MODELS: [], SECRET_KEYS: { CUSTOM: 'custom' },
        readSecret: () => 'test-secret',
        embedOpenRouterMedia: () => {}, applyLocalPromptCacheScope: () => {}, abortOnRequestClose: () => {},
        logVerboseGenerationRequest: () => {}, summarizeLlmPayloadForLog: value => value,
        isExpectedStreamAbort: () => false,
        fetch: jest.fn(async () => ({ ok: true, json: async () => ({ choices: [] }) })),
    });
    load(context, 'util.js', ['mergeObjectWithYaml', 'excludeKeysByYaml']);
    load(context, files[0], ['hasCustomReasoningParamConfig', 'resolveCustomOpenAiReasoningEffort', 'shouldEnableCustomReasoning', 'applyCustomReasoningParameters', 'getSafeCompletionErrorStatus', 'handleChatCompletionsGenerate']);
    const request = {
        body: {
            chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
            model: 'ordinary', messages: [{ role: 'user', content: 'prompt' }],
            max_tokens: 8192, custom_url: 'https://example.invalid/v1',
            ...body,
        },
        user: { directories: {} }, socket: { destroyed: false },
    };
    const response = { send: jest.fn(), status: jest.fn().mockReturnThis(), headersSent: false };
    await context.handleChatCompletionsGenerate(request, response);
    expect(response.status).not.toHaveBeenCalled();
    expect(context.fetch).toHaveBeenCalledTimes(1);
    const outgoing = JSON.parse(context.fetch.mock.calls[0][1].body);
    expect(outgoing.request_controls).toBeUndefined();
    return outgoing;
}

describe('final Custom request controls', () => {
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
