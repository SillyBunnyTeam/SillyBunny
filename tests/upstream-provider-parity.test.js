import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { applyClaudeModelParameterConstraints, applyKimiK3ModelParameterConstraints, isKimiK3Model } from '../public/scripts/openai-model-capabilities.js';
import { migrateNanoGptProviderSettings } from '../public/scripts/openai-preset-utils.js';

const sources = Object.fromEntries(['openai', 'custom-request', 'reasoning'].map(name => {
    const source = readFileSync(new URL(`../public/scripts/${name}.js`, import.meta.url), 'utf8');
    return [name, { source, ast: parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) }];
}));

function load(context, file, names) {
    const { source, ast } = sources[file];
    for (const name of names) {
        const node = ast.body.map(node => node.declaration ?? node)
            .find(node => node.id?.name === name || node.declarations?.some(item => item.id.name === name));
        if (!node) throw new Error(`Missing declaration: ${file}.${name}`);
        vm.runInContext(source.slice(node.start, node.end), context);
    }
}

function makeRuntime(overrides = {}) {
    const settings = {
        chat_completion_source: 'custom',
        show_thoughts: true,
        reasoning_effort: 'low',
        verbosity: 'auto',
        temp_openai: 1,
        top_p_openai: 0.9,
        freq_pen_openai: 0,
        pres_pen_openai: 0,
        stream_openai: true,
        openai_max_tokens: 120,
        n: 1,
        ...overrides,
    };
    const context = vm.createContext({
        structuredClone,
        console,
        oai_settings: settings,
        power_user: { request_token_probabilities: true },
        name1: 'User',
        name2: 'Character',
        model_list: [],
        main_api: 'openai',
        ToolManager: { canPerformToolCalls: () => false },
        getGroupNames: () => [],
        getCurrentChatId: () => 'parity-chat',
        getCustomStoppingStrings: () => [],
        appendAutoAppendReasoningInstruction: messages => messages,
        substituteParams: value => typeof value === 'string' ? value.replaceAll('{{char}}', 'Character') : value,
        applyClaudeModelParameterConstraints,
        applyKimiK3ModelParameterConstraints,
        isKimiK3Model,
        migrateNanoGptProviderSettings,
        t: strings => strings.join(''),
    });
    load(context, 'openai', [
        'chat_completion_sources', 'reasoning_effort_types', 'verbosity_levels',
        'POLLINATIONS_ENDPOINT', 'REVERSE_PROXY_SUPPORTED_SOURCES', 'openai_max_stop_strings',
        'getReasoningEffort', 'getVerbosity', 'shouldRequestReasoning', 'getChatCompletionModel',
        'createGenerationParameters', 'getStreamingReply', 'getChatCompletionErrorMessage', 'settingsToUpdate',
    ]);
    load(context, 'custom-request', ['BOOLEAN_CHAT_COMPLETION_FIELDS', 'coerceRequestBoolean', 'normalizeChatCompletionBooleanFields', 'ChatCompletionService']);
    load(context, 'reasoning', ['extractReasoningFromData']);
    return {
        settings,
        powerUser: context.power_user,
        build: (...args) => context.createGenerationParameters(settings, ...args),
        stream: (...args) => context.getStreamingReply(...args),
        extract: (...args) => context.extractReasoningFromData(...args),
        error: (...args) => context.getChatCompletionErrorMessage(...args),
        service: vm.runInContext('ChatCompletionService', context),
    };
}

describe('upstream provider request integration', () => {
    test('requests and extracts Fireworks reasoning without attaching quiet requests to a chat', async () => {
        const runtime = makeRuntime({ chat_completion_source: 'fireworks', reasoning_effort: 'min' });
        const messages = [{ role: 'user', content: 'Hello' }];
        const { generate_data: interactive } = await runtime.build('accounts/fireworks/models/test', 'normal', messages);
        expect(interactive).toMatchObject({ chat_id: 'parity-chat', include_reasoning: true, reasoning_effort: 'low' });

        runtime.settings.reasoning_effort = 'max';
        const { generate_data: quiet } = await runtime.build('accounts/fireworks/models/test', 'quiet', messages);
        expect(quiet.reasoning_effort).toBe('max');
        expect(quiet).not.toHaveProperty('chat_id');

        runtime.settings.reasoning_effort = 'none';
        expect((await runtime.build('accounts/fireworks/models/test', 'normal', messages)).generate_data.reasoning_effort).toBeUndefined();
        const state = { reasoning: '' };
        const text = runtime.stream({ choices: [{ delta: { content: 'Answer', reasoning_content: 'Thought' } }] }, state, { chatCompletionSource: 'fireworks' });
        expect(text).toBe('Answer');
        expect(state.reasoning).toBe('Thought');
        expect(runtime.extract({ choices: [{ message: { reasoning_content: 'Stored thought' } }] }, { mainApi: 'openai', chatCompletionSource: 'fireworks' })).toBe('Stored thought');
    });

    test('keeps OpenRouter logprobs opt-in and preserves DeepSeek low effort', async () => {
        const openRouter = makeRuntime({ chat_completion_source: 'openrouter' });
        expect((await openRouter.build('provider/model', 'normal', [])).generate_data.logprobs).toBe(5);
        openRouter.powerUser.request_token_probabilities = false;
        expect((await openRouter.build('provider/model', 'normal', [])).generate_data.logprobs).toBeUndefined();
        const deepseek = makeRuntime({ chat_completion_source: 'deepseek', reasoning_effort: 'low' });
        expect((await deepseek.build('deepseek-v4-flash', 'normal', [])).generate_data.reasoning_effort).toBe('low');
    });

    test('filters non-user images for DeepSeek vision without changing the original messages', async () => {
        const runtime = makeRuntime({ chat_completion_source: 'deepseek' });
        const image = { type: 'image_url', image_url: { url: 'https://example.com/image.png' } };
        const messages = [
            { role: 'system', content: [image, { type: 'text', text: 'System' }] },
            { role: 'assistant', content: [image] },
            { role: 'user', content: [image, { type: 'text', text: 'Question' }] },
        ];
        const original = structuredClone(messages);
        const { generate_data: result } = await runtime.build('deepseek-v4-flash-vision-exp', 'normal', messages);
        expect(result.messages).toEqual([
            { role: 'system', content: [{ type: 'text', text: 'System' }] },
            messages[2],
        ]);
        expect(messages).toEqual(original);

        const profileResult = await runtime.service.presetToGeneratePayload({}, {}, {
            messages,
            model: 'deepseek-v4-flash-vision-exp',
            chat_completion_source: 'deepseek',
        });
        expect(profileResult.messages).toEqual(result.messages);
        expect(messages).toEqual(original);
    });

    test('expands custom fields on profile requests while preserving the stored preset and custom reasoning controls', async () => {
        const runtime = makeRuntime();
        const preset = { custom_include_body: 'user: {{char}}' };
        const overrides = {
            messages: [{ role: 'user', content: 'Hello' }],
            model: 'custom-model',
            chat_completion_source: 'custom',
            custom_include_headers: 'X-Character: {{char}}',
            custom_exclude_body: '- {{char}}',
            custom_reasoning_param_name: 'thinking',
            custom_reasoning_preset: 'custom',
        };
        const result = await runtime.service.presetToGeneratePayload(preset, {}, overrides);
        expect(result).toMatchObject({
            custom_include_body: 'user: Character',
            custom_include_headers: 'X-Character: Character',
            custom_exclude_body: '- Character',
            custom_reasoning_param_name: 'thinking',
            custom_reasoning_preset: 'custom',
        });
        expect(preset.custom_include_body).toBe('user: {{char}}');
        expect(overrides.custom_include_headers).toBe('X-Character: {{char}}');
    });

    test('routes Pollinations profile endpoints without modifying the active provider settings', async () => {
        const runtime = makeRuntime({ pollinations_endpoint: 'authenticated', custom_url: 'https://custom.example/v1' });
        const result = await runtime.service.presetToGeneratePayload({}, {}, {
            messages: [],
            model: 'test-model',
            chat_completion_source: 'pollinations',
            pollinations_endpoint: 'anonymous',
        });
        expect(result.pollinations_endpoint).toBe('anonymous');
        expect(result).not.toHaveProperty('custom_url');
        expect(runtime.settings.pollinations_endpoint).toBe('authenticated');
        expect(runtime.settings.chat_completion_source).toBe('custom');
        const defaultRuntime = makeRuntime({ chat_completion_source: 'pollinations' });
        expect((await defaultRuntime.build('test-model', 'normal', [])).generate_data.pollinations_endpoint).toBe('authenticated');
    });

    test('surfaces provider error details in successful HTTP responses instead of OK', () => {
        const runtime = makeRuntime();
        const ok = { ok: true, statusText: 'OK' };
        expect(runtime.error({ error: { code: 'quota_exceeded' } }, ok)).toBe('quota_exceeded');
        expect(runtime.error({ error: 'Provider unavailable' }, ok)).toBe('Provider unavailable');
        expect(runtime.error({ detail: { error: { type: 'rate_limit' } } }, ok)).toBe('rate_limit');
        expect(runtime.error({ error: {} }, ok)).toBe('Unknown error');
        expect(runtime.error({ error: {} }, { ok: false, statusText: 'Bad Gateway' })).toBe('Bad Gateway');
    });
});
