/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest unit assertions. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

globalThis.document ??= { createElement: () => ({}), querySelector: () => null };
globalThis.HTMLInputElement ??= class HTMLInputElement {};
globalThis.HTMLSelectElement ??= class HTMLSelectElement {};

import * as samplingParameterPolicy from '../public/scripts/sampling-parameter-policy.js';
import { importOpenAiModule } from './util/openai-harness.js';

const pub = relative => fileURLToPath(new URL(`../public/${relative}`, import.meta.url));

// Mock peer modules of custom-request.js, reasoning.js, and tokenizers.js before importing them.
await jest.unstable_mockModule(pub('scripts/preset-manager.js'), () => ({
    getPresetManager: jest.fn(() => null),
}));
await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({
    getTextGenServer: jest.fn(() => ''),
    getTextGenModel: jest.fn(() => ''),
    createTextGenGenerationData: jest.fn(() => ({})),
    setting_names: {},
    textgen_types: {},
    textgenerationwebui_settings: {},
}));
await jest.unstable_mockModule(pub('scripts/instruct-mode.js'), () => ({
    formatInstructModeChat: jest.fn(() => ''),
    formatInstructModePrompt: jest.fn(() => ''),
    getInstructStoppingSequences: jest.fn(() => []),
}));
await jest.unstable_mockModule(pub('scripts/extensions/regex/engine.js'), () => ({
    getRegexedString: jest.fn(value => value),
    regex_placement: {},
}));
await jest.unstable_mockModule(pub('scripts/macros/macro-system.js'), () => ({
    macros: { register: jest.fn() },
    MacroCategory: {},
}));
await jest.unstable_mockModule(pub('scripts/mobile-streaming.js'), () => ({
    getStreamingReasoningRenderInterval: jest.fn(() => 0),
    shouldReduceStreamingDomWork: jest.fn(() => false),
    shouldRenderLiveReasoningContent: jest.fn(() => true),
}));
await jest.unstable_mockModule(pub('scripts/util/stream-fadein.js'), () => ({
    applyStreamDomPatch: jest.fn(),
    applyStreamFadeIn: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/kai-settings.js'), () => ({
    kai_flags: {},
    kai_settings: {},
}));

let koboldState = null;

const { openai, mocks } = await importOpenAiModule({
    mockTokenizers: false,
    powerUser: { request_token_probabilities: true },
    script: {
        name1: 'User',
        name2: 'Character',
        getCurrentChatId: jest.fn(() => 'parity-chat'),
        substituteParams: jest.fn(value => typeof value === 'string' ? value.replaceAll('{{char}}', 'Character') : value),
        extractJsonFromData: jest.fn(),
        extractMessageFromData: jest.fn(),
        getGenerateUrl: jest.fn(() => '/api/backends/chat-completions/generate'),
        normalizeContentText: jest.fn(value => value),
        closeMessageEditor: jest.fn(),
        messageFormatting: jest.fn(value => value),
        saveChatDebounced: jest.fn(),
        syncMesToSwipe: jest.fn(),
        updateMessageBlock: jest.fn(),
        updateMessageTokenAccounting: jest.fn(),
        nai_settings: {},
    },
    koboldCpp: {
        isKoboldCppChatCompletion: jest.fn(() => openai.oai_settings.chat_completion_source === 'koboldcpp'),
        getKoboldCppChatState: jest.fn(() => koboldState),
    },
});

const { ChatCompletionService } = await import('../public/scripts/custom-request.js');
const { extractReasoningFromData } = await import('../public/scripts/reasoning.js');
const { getTokenizerModel } = await import('../public/scripts/tokenizers.js');

const initialDefaults = structuredClone(openai.oai_settings);

function configureRuntime(overrides = {}) {
    koboldState = null;
    mocks.powerUser.request_token_probabilities = true;
    Object.assign(openai.oai_settings, structuredClone(initialDefaults), {
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
    });
    return {
        settings: openai.oai_settings,
        powerUser: mocks.powerUser,
        build: (...args) => openai.createGenerationParameters(openai.oai_settings, ...args),
        stream: (...args) => openai.getStreamingReply(...args),
        extract: (...args) => extractReasoningFromData(...args),
        error: (data, response) => {
            mocks.requestErrors.showRequestError.mockClear();
            openai.tryParseStreamingError(response, JSON.stringify(data));
            return mocks.requestErrors.showRequestError.mock.calls.at(-1)?.[0]?.statusText;
        },
        tokenizer: () => getTokenizerModel(),
        service: ChatCompletionService,
    };
}

describe('upstream provider request integration', () => {
    beforeEach(async () => {
        // Clear any selected custom endpoint profile between tests.
        await openai.loadCustomEndpointPresets({
            custom_endpoint_presets: [],
            selected_custom_endpoint_preset: null,
        });
    });

    test('a stale custom profile selection does not change the native provider policy target', async () => {
        await openai.loadCustomEndpointPresets({
            custom_endpoint_presets: [{ name: 'Profile A', url: 'https://a.example/v1', model: 'gpt-4o', key: '', secretId: 'profile-a' }],
            selected_custom_endpoint_preset: { name: 'Profile A', url: 'https://a.example/v1', model: 'gpt-4o', key: '', secretId: 'profile-a' },
        });
        const runtime = configureRuntime({
            chat_completion_source: 'openai',
            model_sampling_policies: {
                version: samplingParameterPolicy.POLICY_SCHEMA_VERSION,
                targets: {
                    'openai:gpt-4o': { parameters: { temperature: 'omit' } },
                    'custom:profile-a:gpt-4o': { parameters: { temperature: 'include' } },
                },
            },
        });
        const { generate_data: nativePayload } = await runtime.build('gpt-4o', 'quiet', []);
        expect(nativePayload).not.toHaveProperty('temperature');

        runtime.settings.chat_completion_source = 'custom';
        const { generate_data: customPayload } = await runtime.build('gpt-4o', 'quiet', []);
        expect(customPayload.temperature).toBe(1);
    });

    for (const [source, model] of [
        ['openai', 'gpt-6-astra'],
        ['openai', 'gpt-6-astra-2026-09-14'],
        ['openai_responses', 'gpt-6-astra'],
        ['azure_openai', 'gpt-6-astra'],
        ['azure_openai', 'gpt-6-astra-2026-09-14'],
        ['openrouter', 'openai/gpt-6-astra'],
        ['openrouter', 'openai/gpt-6-astra-2026-09-14'],
    ]) {
        test(`normalizes Astra generation parameters for ${source} model ${model}`, async () => {
            const runtime = configureRuntime({ chat_completion_source: source, reasoning_effort: 'max' });
            const { generate_data: payload } = await runtime.build(model, 'normal', [{ role: 'user', content: 'Hello' }]);

            expect(payload).toMatchObject({ model, max_completion_tokens: 120, reasoning_effort: 'max' });
            expect(payload).not.toHaveProperty('max_tokens');
            expect(payload).not.toHaveProperty('temperature');
            expect(payload).not.toHaveProperty('top_p');
            expect(payload).not.toHaveProperty('logprobs');
            expect(payload).not.toHaveProperty('top_logprobs');
        });
    }

    for (const [source, model] of [
        ['openai', 'gpt-6-sol'],
        ['openai', 'gpt-6-luna'],
        ['openai_responses', 'gpt-6-sol'],
        ['openai_responses', 'gpt-6-luna'],
        ['azure_openai', 'gpt-6-sol'],
        ['azure_openai', 'gpt-6-luna'],
        ['openrouter', 'openai/gpt-6-sol'],
        ['openrouter', 'openai/gpt-6-luna'],
    ]) {
        test(`normalizes Sol and Luna generation parameters at max effort for ${source} model ${model}`, async () => {
            const runtime = configureRuntime({ chat_completion_source: source, reasoning_effort: 'max' });
            const { generate_data: payload } = await runtime.build(model, 'normal', [{ role: 'user', content: 'Hello' }]);

            expect(payload).toMatchObject({ model, max_completion_tokens: 120, reasoning_effort: 'max' });
            expect(payload).not.toHaveProperty('max_tokens');
            expect(payload).not.toHaveProperty('temperature');
            expect(payload).not.toHaveProperty('top_p');
            expect(payload).not.toHaveProperty('logprobs');
            expect(payload).not.toHaveProperty('top_logprobs');
        });
    }

    for (const [source, model] of [
        ['openai', 'gpt-6-sol'],
        ['openai', 'gpt-6-luna'],
        ['openai_responses', 'gpt-6-sol'],
        ['openai_responses', 'gpt-6-luna'],
        ['azure_openai', 'gpt-6-sol'],
        ['azure_openai', 'gpt-6-luna'],
    ]) {
        test(`keeps Sol and Luna sampling when reasoning is none for ${source} model ${model}`, async () => {
            const runtime = configureRuntime({ chat_completion_source: source, reasoning_effort: 'none' });
            const { generate_data: payload } = await runtime.build(model, 'normal', [{ role: 'user', content: 'Hello' }]);

            expect(payload).toMatchObject({ model, max_completion_tokens: 120, reasoning_effort: 'none', temperature: 1, top_p: 0.9 });
            expect(payload).not.toHaveProperty('max_tokens');
        });
    }

    for (const source of ['openai', 'openai_responses', 'azure_openai']) {
        test(`drops Astra reasoning effort and sampling when reasoning is none for ${source}`, async () => {
            const runtime = configureRuntime({ chat_completion_source: source, reasoning_effort: 'none' });
            const { generate_data: payload } = await runtime.build('gpt-6-astra', 'normal', [{ role: 'user', content: 'Hello' }]);

            expect(payload.reasoning_effort).toBeUndefined();
            expect(payload).not.toHaveProperty('temperature');
            expect(payload).not.toHaveProperty('top_p');
        });
    }

    for (const source of ['openai', 'azure_openai', 'openrouter']) {
        test(`preserves earlier GPT sampling behavior for ${source}`, async () => {
            const runtime = configureRuntime({ chat_completion_source: source });
            const { generate_data: gpt4 } = await runtime.build('gpt-4o', 'normal', []);
            const { generate_data: gpt5 } = await runtime.build('gpt-5.6-sol', 'normal', []);

            expect(gpt4).toMatchObject({ max_tokens: 120, temperature: 1, top_p: 0.9, logprobs: 5 });
            expect(gpt4).not.toHaveProperty('max_completion_tokens');
            expect(gpt5).toMatchObject({ max_completion_tokens: 120, temperature: 1, top_p: 0.9 });
            expect(gpt5).not.toHaveProperty('max_tokens');
            expect(gpt5).not.toHaveProperty('logprobs');
        });
    }

    for (const [model, tokenizer] of [
        ['gpt-6-astra', 'gpt-4o'],
        ['openai/gpt-6-astra', 'gpt-4o'],
        ['gpt-6-astra-2026-09-14', 'gpt-4o'],
        ['gpt-6-sol', 'gpt-4o'],
        ['gpt-6-luna', 'gpt-4o'],
        ['gpt-5.6-sol', 'gpt-4o'],
        ['gpt-4', 'gpt-4'],
        ['gpt-3.5-turbo', 'gpt-3.5-turbo'],
        ['unknown-model', 'gpt-3.5-turbo'],
    ]) {
        test(`selects the ElectronHub tokenizer for ${model}`, () => {
            const runtime = configureRuntime({ chat_completion_source: 'electronhub', electronhub_model: model });

            expect(runtime.tokenizer()).toBe(tokenizer);
        });
    }

    test.each(['fireworks', 'openrouter', 'openai', 'openai_responses', 'xai', 'mistralai', 'azure_openai'])('createGenerationParameters sends chat_id for %s unless the request opts out of caching', async (source) => {
        const runtime = configureRuntime({ chat_completion_source: source });
        const messages = [{ role: 'user', content: 'Hello' }];

        for (const type of ['normal', 'swipe', 'continue', 'impersonate']) {
            expect((await runtime.build('model-x', type, messages)).generate_data.chat_id).toBe('parity-chat');
        }
        expect((await runtime.build('model-x', 'normal', messages, { cacheScope: 'auxiliary' })).generate_data.chat_id).toBe('parity-chat');
        expect((await runtime.build('model-x', 'normal', messages, { cacheScope: 'none' })).generate_data).not.toHaveProperty('chat_id');
        const quiet = (await runtime.build('model-x', 'quiet', messages)).generate_data;
        expect(quiet.chat_id).toBe(source === 'fireworks' ? undefined : 'parity-chat');
    });

    test.each(['claude', 'custom', 'deepseek', 'makersuite'])('createGenerationParameters never sends chat_id for %s', async (source) => {
        const runtime = configureRuntime({ chat_completion_source: source });
        expect((await runtime.build('model-x', 'normal', [{ role: 'user', content: 'Hello' }])).generate_data).not.toHaveProperty('chat_id');
    });

    test('requests and extracts Fireworks reasoning without attaching quiet requests to a chat', async () => {
        const runtime = configureRuntime({ chat_completion_source: 'fireworks', reasoning_effort: 'min' });
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
        const openRouter = configureRuntime({ chat_completion_source: 'openrouter' });
        expect((await openRouter.build('provider/model', 'normal', [])).generate_data.logprobs).toBe(5);
        openRouter.powerUser.request_token_probabilities = false;
        expect((await openRouter.build('provider/model', 'normal', [])).generate_data.logprobs).toBeUndefined();
        const deepseek = configureRuntime({ chat_completion_source: 'deepseek', reasoning_effort: 'low' });
        expect((await deepseek.build('deepseek-v4-flash', 'normal', [])).generate_data.reasoning_effort).toBe('low');
    });

    test('filters non-user images for DeepSeek vision without changing the original messages', async () => {
        const runtime = configureRuntime({ chat_completion_source: 'deepseek' });
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
        const runtime = configureRuntime();
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
        const runtime = configureRuntime({ pollinations_endpoint: 'authenticated', custom_url: 'https://custom.example/v1' });
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
        const defaultRuntime = configureRuntime({ chat_completion_source: 'pollinations' });
        expect((await defaultRuntime.build('test-model', 'normal', [])).generate_data.pollinations_endpoint).toBe('authenticated');
    });

    test('builds KoboldCpp requests with its own URL, samplers and Additional Parameters', async () => {
        const runtime = configureRuntime({
            chat_completion_source: 'koboldcpp',
            koboldcpp_url: 'http://127.0.0.1:5001',
            koboldcpp_include_body: 'name: {{char}}',
            koboldcpp_exclude_body: '- top_a',
            koboldcpp_include_headers: 'X-Character: {{char}}',
            custom_include_body: 'custom_only: true',
            freq_pen_openai: 0.4,
            top_k_openai: 0,
            min_p_openai: 0.05,
            top_a_openai: 0.2,
            repetition_penalty_openai: 1.1,
            reasoning_effort: 'min',
        });

        const { generate_data: result } = await runtime.build('', 'normal', [{ role: 'user', content: 'Hello' }]);

        expect(result).toMatchObject({
            chat_completion_source: 'koboldcpp',
            koboldcpp_url: 'http://127.0.0.1:5001',
            koboldcpp_include_body: 'name: Character',
            koboldcpp_exclude_body: '- top_a',
            koboldcpp_include_headers: 'X-Character: Character',
            top_k: 0,
            min_p: 0.05,
            top_a: 0.2,
            repetition_penalty: 1.1,
            reasoning_effort: 'minimal',
        });
        expect(result).not.toHaveProperty('frequency_penalty');
        expect(result).not.toHaveProperty('custom_include_body');

        runtime.settings.reasoning_effort = 'none';
        expect((await runtime.build('', 'normal', [])).generate_data.reasoning_effort).toBeUndefined();
    });

    test('reads KoboldCpp thinking from reasoning_content', () => {
        const runtime = configureRuntime({ chat_completion_source: 'koboldcpp' });
        const state = { reasoning: '' };

        const text = runtime.stream({ choices: [{ delta: { content: 'Answer', reasoning_content: 'Thought' } }] }, state, { chatCompletionSource: 'koboldcpp' });

        expect(text).toBe('Answer');
        expect(state.reasoning).toBe('Thought');
        expect(runtime.extract({ choices: [{ message: { reasoning_content: 'Stored thought' } }] }, { mainApi: 'openai', chatCompletionSource: 'koboldcpp' })).toBe('Stored thought');
    });

    test('names the model KoboldCpp has loaded, and none while KoboldCpp reports it inactive', () => {
        const runtime = configureRuntime({ chat_completion_source: 'koboldcpp' });

        koboldState = { loadedModel: 'koboldcpp/Qwen3-0.6B-Q8_0' };
        expect(openai.getChatCompletionModel()).toBe('koboldcpp/Qwen3-0.6B-Q8_0');
        expect(runtime.tokenizer()).toBe('koboldcpp/Qwen3-0.6B-Q8_0');

        koboldState = { loadedModel: 'inactive' };
        expect(openai.getChatCompletionModel()).toBe('');
        expect(runtime.tokenizer()).toBe('koboldcpp');
    });

    test('routes KoboldCpp profile requests to the profile URL and Additional Parameters', async () => {
        const runtime = configureRuntime({ koboldcpp_url: 'http://127.0.0.1:5001', koboldcpp_include_body: 'active: true' });

        const result = await runtime.service.presetToGeneratePayload({}, {}, {
            messages: [],
            model: '',
            chat_completion_source: 'koboldcpp',
            koboldcpp_url: 'http://127.0.0.1:5002',
            custom_include_body: 'profile: {{char}}',
            custom_include_headers: 'X-Profile: yes',
        });

        expect(result).toMatchObject({
            chat_completion_source: 'koboldcpp',
            koboldcpp_url: 'http://127.0.0.1:5002',
            koboldcpp_include_body: 'profile: Character',
            koboldcpp_include_headers: 'X-Profile: yes',
        });
        expect(runtime.settings.koboldcpp_url).toBe('http://127.0.0.1:5001');
        expect(runtime.settings.koboldcpp_include_body).toBe('active: true');
    });

    test('surfaces provider error details in successful HTTP responses instead of OK', () => {
        const runtime = configureRuntime();
        const ok = { ok: true, statusText: 'OK' };
        expect(runtime.error({ error: { code: 'quota_exceeded' } }, ok)).toBe('quota_exceeded');
        expect(runtime.error({ error: 'Provider unavailable' }, ok)).toBe('Provider unavailable');
        expect(runtime.error({ detail: { error: { type: 'rate_limit' } } }, ok)).toBe('rate_limit');
        expect(runtime.error({ error: {} }, ok)).toBe('Unknown error');
        expect(runtime.error({ error: {} }, { ok: false, statusText: 'Bad Gateway' })).toBe('Bad Gateway');
    });
});
