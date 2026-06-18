import { describe, expect, test } from '@jest/globals';
import {
    buildChatCompletionPreset,
    buildChatCompletionPresetForSave,
    buildChatCompletionSamplingProfileKey,
    buildChatCompletionSamplingSettingsSnapshot,
    buildReverseProxyPresetForSave,
    getChatCompletionConnectionPresetKeys,
    getChatCompletionSamplingProfileLookupKeys,
    getChatCompletionSamplingPresetKeys,
    getChatCompletionSamplingSettingsKeys,
    normalizeReverseProxyPreset,
    shouldIncludeConnectionFieldsInPreset,
    shouldIncludeSamplingFieldsInPreset,
} from '../public/scripts/openai-preset-utils.js';

const settingsMap = {
    chat_completion_source: ['#chat_completion_source', 'chat_completion_source', false, true],
    temperature: ['#temp_openai', 'temp_openai', false, false],
    openai_model: ['#model_openai_select', 'openai_model', false, true],
    assistant_prefill: ['#claude_assistant_prefill', 'assistant_prefill', false, false],
    custom_url: ['#custom_api_url_text', 'custom_url', false, true],
    prompts: ['', 'prompts', false, false],
};

const settingsMapWithSampling = {
    chat_completion_source: ['#chat_completion_source', 'chat_completion_source', false, true, false],
    temperature: ['#temp_openai', 'temp_openai', false, false, true],
    frequency_penalty: ['#freq_pen_openai', 'freq_pen_openai', false, false, true],
    openai_model: ['#model_openai_select', 'openai_model', false, true, false],
    assistant_prefill: ['#claude_assistant_prefill', 'assistant_prefill', false, false, false],
    custom_url: ['#custom_api_url_text', 'custom_url', false, true, false],
    prompts: ['', 'prompts', false, false, false],
};

const settings = {
    chat_completion_source: 'custom',
    temp_openai: 0.72,
    freq_pen_openai: 0.1,
    openai_model: 'mimo-model',
    assistant_prefill: '',
    custom_url: 'http://127.0.0.1:8080/v1',
    prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
};

describe('Chat Completion preset utilities', () => {
    test('preserves legacy preset behavior by including connection fields by default', () => {
        expect(buildChatCompletionPreset(settings, settingsMap)).toEqual({
            chat_completion_source: 'custom',
            temperature: 0.72,
            openai_model: 'mimo-model',
            assistant_prefill: '',
            custom_url: 'http://127.0.0.1:8080/v1',
            prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
        });
    });

    test('can build a generation preset without provider/model connection fields', () => {
        expect(buildChatCompletionPreset(settings, settingsMap, { includeConnection: false })).toEqual({
            temperature: 0.72,
            assistant_prefill: '',
            prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
        });
    });

    test('keeps explicit empty generation values when excluding connection fields', () => {
        const preset = buildChatCompletionPreset(settings, settingsMap, { includeConnection: false });

        expect(Object.hasOwn(preset, 'assistant_prefill')).toBe(true);
        expect(preset.assistant_prefill).toBe('');
    });

    test('lists connection preset keys using preset field names', () => {
        expect(getChatCompletionConnectionPresetKeys(settingsMap)).toEqual([
            'chat_completion_source',
            'openai_model',
            'custom_url',
        ]);
    });

    test('excludes connection fields for normal preset saves', () => {
        const includeConnection = shouldIncludeConnectionFieldsInPreset({
            ...settings,
            bind_preset_to_connection: false,
        });

        expect(buildChatCompletionPreset(settings, settingsMap, { includeConnection })).toEqual({
            temperature: 0.72,
            assistant_prefill: '',
            prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
        });
    });

    test('includes connection fields for explicitly linked preset saves', () => {
        const includeConnection = shouldIncludeConnectionFieldsInPreset({
            ...settings,
            bind_preset_to_connection: true,
        });

        expect(buildChatCompletionPreset(settings, settingsMap, { includeConnection })).toEqual({
            chat_completion_source: 'custom',
            temperature: 0.72,
            openai_model: 'mimo-model',
            assistant_prefill: '',
            custom_url: 'http://127.0.0.1:8080/v1',
            prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
        });
    });

    test('builds preset manager save snapshots from the current link mode', () => {
        expect(buildChatCompletionPresetForSave({
            ...settings,
            bind_preset_to_connection: false,
        }, settingsMap)).toEqual({
            temperature: 0.72,
            assistant_prefill: '',
            prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
        });

        expect(buildChatCompletionPresetForSave({
            ...settings,
            bind_preset_to_connection: true,
        }, settingsMap)).toEqual({
            chat_completion_source: 'custom',
            temperature: 0.72,
            openai_model: 'mimo-model',
            assistant_prefill: '',
            custom_url: 'http://127.0.0.1:8080/v1',
            prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
        });
    });

    test('normalizes legacy reverse proxy presets without source bindings', () => {
        expect(normalizeReverseProxyPreset({
            name: 'Legacy proxy',
            url: 'https://proxy.example/v1',
            password: 'secret',
        }, { supportedSources: ['makersuite'] })).toEqual({
            name: 'Legacy proxy',
            url: 'https://proxy.example/v1',
            password: 'secret',
            source: '',
        });
    });

    test('saves supported reverse proxy source bindings', () => {
        expect(buildReverseProxyPresetForSave({
            name: 'Gemini proxy',
            url: 'https://proxy.example/google',
            password: 'secret',
            source: 'makersuite',
        }, { supportedSources: ['openai', 'makersuite'] })).toEqual({
            name: 'Gemini proxy',
            url: 'https://proxy.example/google',
            password: 'secret',
            source: 'makersuite',
        });
    });

    test('ignores unsupported reverse proxy source bindings', () => {
        expect(buildReverseProxyPresetForSave({
            name: 'Unsupported proxy',
            url: 'https://proxy.example/v1',
            password: '',
            source: 'custom',
        }, { supportedSources: ['openai', 'makersuite'] })).toEqual({
            name: 'Unsupported proxy',
            url: 'https://proxy.example/v1',
            password: '',
            source: '',
        });
    });

    test('does not source-bind the None reverse proxy preset', () => {
        expect(buildReverseProxyPresetForSave({
            name: 'None',
            url: '',
            password: '',
            source: 'makersuite',
        }, { supportedSources: ['makersuite'] })).toEqual({
            name: 'None',
            url: '',
            password: '',
            source: '',
        });
    });

    test('can build a preset without sampling fields', () => {
        expect(buildChatCompletionPreset(settings, settingsMapWithSampling, { includeSampling: false })).toEqual({
            chat_completion_source: 'custom',
            openai_model: 'mimo-model',
            assistant_prefill: '',
            custom_url: 'http://127.0.0.1:8080/v1',
            prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
        });
    });

    test('can build a preset without both connection and sampling fields', () => {
        expect(buildChatCompletionPreset(settings, settingsMapWithSampling, { includeConnection: false, includeSampling: false })).toEqual({
            assistant_prefill: '',
            prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
        });
    });

    test('lists sampling preset keys using preset field names', () => {
        expect(getChatCompletionSamplingPresetKeys(settingsMapWithSampling)).toEqual([
            'temperature',
            'frequency_penalty',
        ]);
    });

    test('lists sampling settings keys using live setting names', () => {
        expect(getChatCompletionSamplingSettingsKeys(settingsMapWithSampling)).toEqual([
            'temp_openai',
            'freq_pen_openai',
        ]);
    });

    test('builds model sampling snapshots from sampling flags', () => {
        expect(buildChatCompletionSamplingSettingsSnapshot(settings, settingsMapWithSampling)).toEqual({
            temp_openai: 0.72,
            freq_pen_openai: 0.1,
        });
    });

    test('returns empty sampling keys for maps without sampling flags', () => {
        expect(getChatCompletionSamplingPresetKeys(settingsMap)).toEqual([]);
        expect(getChatCompletionSamplingSettingsKeys(settingsMap)).toEqual([]);
        expect(buildChatCompletionSamplingSettingsSnapshot(settings, settingsMap)).toEqual({});
    });

    test('includes sampling fields by default when bind_preset_to_sampling is not set', () => {
        expect(shouldIncludeSamplingFieldsInPreset({})).toBe(true);
        expect(shouldIncludeSamplingFieldsInPreset({ bind_preset_to_sampling: undefined })).toBe(true);
        expect(shouldIncludeSamplingFieldsInPreset({ bind_preset_to_sampling: true })).toBe(true);
    });

    test('excludes sampling fields when bind_preset_to_sampling is false', () => {
        expect(shouldIncludeSamplingFieldsInPreset({ bind_preset_to_sampling: false })).toBe(false);
    });

    test('builds preset manager save snapshots respecting sampling binding', () => {
        expect(buildChatCompletionPresetForSave({
            ...settings,
            bind_preset_to_connection: false,
            bind_preset_to_sampling: false,
        }, settingsMapWithSampling)).toEqual({
            assistant_prefill: '',
            prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
        });

        expect(buildChatCompletionPresetForSave({
            ...settings,
            bind_preset_to_connection: false,
            bind_preset_to_sampling: true,
        }, settingsMapWithSampling)).toEqual({
            temperature: 0.72,
            frequency_penalty: 0.1,
            assistant_prefill: '',
            prompts: [{ identifier: 'main', content: 'Prompt after edit' }],
        });
    });
});

describe('Chat Completion sampling profile keys', () => {
    test('builds canonical keys for native OpenAI models', () => {
        expect(buildChatCompletionSamplingProfileKey('openai', 'gpt-4o')).toBe('openai:gpt-4o');
        expect(buildChatCompletionSamplingProfileKey('openai', 'gpt-4-turbo')).toBe('openai:gpt-4-turbo');
        expect(buildChatCompletionSamplingProfileKey('openai', 'o1-preview')).toBe('openai:o1-preview');
        expect(buildChatCompletionSamplingProfileKey('openai_responses', 'gpt-4o')).toBe('openai:gpt-4o');
        expect(buildChatCompletionSamplingProfileKey('azure_openai', 'gpt-4')).toBe('openai:gpt-4');
    });

    test('shares canonical keys for OpenAI Custom models', () => {
        expect(buildChatCompletionSamplingProfileKey('custom', 'openai/gpt-4o')).toBe('openai:gpt-4o');
        expect(buildChatCompletionSamplingProfileKey('custom', 'models/openai/gpt-4-turbo')).toBe('openai:gpt-4-turbo');
        expect(buildChatCompletionSamplingProfileKey('custom', 'chatgpt-4o-latest')).toBe('openai:gpt-4o');
        expect(buildChatCompletionSamplingProfileKey('custom', 'o1-preview-2024-08-01')).toBe('openai:o1-preview');
    });

    test('normalizes model separators and case in canonical keys', () => {
        expect(buildChatCompletionSamplingProfileKey('openai', 'GPT-4O')).toBe('openai:gpt-4o');
        expect(buildChatCompletionSamplingProfileKey('custom', 'openai\\gpt-4')).toBe('openai:gpt-4');
        expect(buildChatCompletionSamplingProfileKey('custom', 'openai:gpt-4-turbo')).toBe('openai:gpt-4-turbo');
    });

    test('isolates unknown custom models with normalized keys', () => {
        expect(buildChatCompletionSamplingProfileKey('custom', 'my-local-model')).toBe('custom:my-local-model');
        expect(buildChatCompletionSamplingProfileKey('custom', 'llama-3.1')).toBe('custom:llama-3.1');
        expect(buildChatCompletionSamplingProfileKey('custom', 'MyLocalModel')).toBe('custom:mylocalmodel');
    });

    test('includes legacy exact key in lookup keys', () => {
        const keys = getChatCompletionSamplingProfileLookupKeys('openai', 'gpt-4o');
        expect(keys).toContain('openai:gpt-4o');
        expect(keys[0]).toBe('openai:gpt-4o');
    });

    test('includes legacy key for OpenAI Custom models', () => {
        const keys = getChatCompletionSamplingProfileLookupKeys('custom', 'openai/gpt-4o');
        expect(keys[0]).toBe('openai:gpt-4o');
        expect(keys).toContain('custom:openai/gpt-4o');
    });

    test('deduplicates canonical and legacy keys when identical', () => {
        const keys = getChatCompletionSamplingProfileLookupKeys('custom', 'my-model');
        expect(keys).toEqual(['custom:my-model']);
    });

    test('returns null for missing source or model', () => {
        expect(buildChatCompletionSamplingProfileKey('', 'gpt-4o')).toBeNull();
        expect(buildChatCompletionSamplingProfileKey('openai', '')).toBeNull();
        expect(buildChatCompletionSamplingProfileKey(null, 'gpt-4o')).toBeNull();
        expect(buildChatCompletionSamplingProfileKey('openai', null)).toBeNull();
    });

    test('returns empty array for missing source or model', () => {
        expect(getChatCompletionSamplingProfileLookupKeys('', 'gpt-4o')).toEqual([]);
        expect(getChatCompletionSamplingProfileLookupKeys('openai', '')).toEqual([]);
    });
});
