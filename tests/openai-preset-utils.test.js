import { describe, expect, test } from '@jest/globals';
import {
    buildChatCompletionPreset,
    buildChatCompletionPresetForSave,
    buildChatCompletionSamplingProfileKey,
    buildChatCompletionSamplingSettingsSnapshot,
    buildCustomEndpointPresetForSave,
    buildReverseProxyPresetForSave,
    fillMissingCustomEndpointParameters,
    getChatCompletionConnectionPresetKeys,
    getChatCompletionSamplingProfileLookupKeys,
    getChatCompletionSamplingPresetKeys,
    getChatCompletionSamplingSettingsKeys,
    getCustomEndpointFavoritesKey,
    getCustomEndpointProfileRequestOverrides,
    normalizeCustomEndpointPreset,
    normalizeReverseProxyPreset,
    pickCustomEndpointParameters,
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

    test('normalizes legacy Custom endpoint profiles without keys or models', () => {
        expect(normalizeCustomEndpointPreset({
            name: 'Local proxy',
            url: 'http://127.0.0.1:1234/v1',
        })).toEqual({
            name: 'Local proxy',
            url: 'http://127.0.0.1:1234/v1',
            key: '',
            model: '',
            secretId: '',
        });
    });

    test('normalizes Custom endpoint profile secret ids', () => {
        expect(normalizeCustomEndpointPreset({
            name: 'Bound proxy',
            url: 'https://proxy.example/v1',
            secretId: 'secret-1',
        })).toEqual({
            name: 'Bound proxy',
            url: 'https://proxy.example/v1',
            key: '',
            model: '',
            secretId: 'secret-1',
        });

        expect(normalizeCustomEndpointPreset({
            name: 'Imported proxy',
            'secret-id': 'secret-2',
        }).secretId).toBe('secret-2');

        expect(normalizeCustomEndpointPreset({
            name: 'Request-shaped proxy',
            secret_id: 'secret-3',
        }).secretId).toBe('secret-3');
    });

    test('saves Custom endpoint profiles with URL, key, and model', () => {
        expect(buildCustomEndpointPresetForSave({
            name: 'Story proxy',
            url: 'https://proxy.example/v1',
            key: 'sk-story',
            model: 'gpt-4o',
        })).toEqual({
            name: 'Story proxy',
            url: 'https://proxy.example/v1',
            key: 'sk-story',
            model: 'gpt-4o',
            secretId: '',
        });
    });

    test('strips Custom endpoint plaintext keys when a secret id is bound', () => {
        expect(buildCustomEndpointPresetForSave({
            name: 'Story proxy',
            url: 'https://proxy.example/v1',
            key: 'sk-story',
            model: 'gpt-4o',
            secretId: 'secret-story',
        })).toEqual({
            name: 'Story proxy',
            url: 'https://proxy.example/v1',
            // Plaintext key is not persisted when the profile is bound to a saved secret
            key: '',
            model: 'gpt-4o',
            secretId: 'secret-story',
        });
    });

    test('keeps the plaintext key only while no secret id is bound', () => {
        expect(buildCustomEndpointPresetForSave({
            name: 'Unbound proxy',
            url: 'https://proxy.example/v1',
            key: 'sk-unbound',
            model: 'gpt-4o',
        }).key).toBe('sk-unbound');
    });

    test('clears Custom endpoint profile fields for None', () => {
        expect(buildCustomEndpointPresetForSave({
            name: 'None',
            url: 'https://proxy.example/v1',
            key: 'sk-story',
            model: 'gpt-4o',
            custom_include_body: 'top_k: 20',
        })).toEqual({
            name: 'None',
            url: '',
            key: '',
            model: '',
            secretId: '',
            custom_include_body: '',
            custom_exclude_body: '',
            custom_include_headers: '',
        });
    });

    test('saves Custom endpoint profiles with their Additional Parameters verbatim, empty values included', () => {
        expect(buildCustomEndpointPresetForSave({
            name: 'Story proxy',
            url: 'https://proxy.example/v1',
            model: 'gpt-4o',
            secretId: 'secret-story',
            custom_include_body: '  top_k: 20\n  min_p: 0.05\n',
            custom_exclude_body: '',
            custom_include_headers: 'X-Title: Story',
        })).toEqual({
            name: 'Story proxy',
            url: 'https://proxy.example/v1',
            key: '',
            model: 'gpt-4o',
            secretId: 'secret-story',
            custom_include_body: '  top_k: 20\n  min_p: 0.05\n',
            custom_exclude_body: '',
            custom_include_headers: 'X-Title: Story',
        });
    });

    test('gives a Custom endpoint profile only the Additional Parameters it holds', () => {
        expect(normalizeCustomEndpointPreset({ name: 'Partial', custom_include_body: 'top_k: 20', custom_exclude_body: null })).toEqual({
            name: 'Partial',
            url: '',
            key: '',
            model: '',
            secretId: '',
            custom_include_body: 'top_k: 20',
        });
    });

    test('fills the Additional Parameters that one profile lacks with the live ones, and leaves None and stored values alone', () => {
        const settings = { custom_include_body: '  top_k: 20\n', custom_exclude_body: '- seed', custom_include_headers: 'X-Title: Story' };
        const none = normalizeCustomEndpointPreset({ name: 'None' });
        const legacy = normalizeCustomEndpointPreset({ name: 'Legacy', url: 'https://legacy.example/v1' });
        const partial = normalizeCustomEndpointPreset({ name: 'Partial', custom_include_body: 'min_p: 0.1' });
        const stored = normalizeCustomEndpointPreset({ name: 'Stored', custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });

        expect(fillMissingCustomEndpointParameters(legacy, settings)).toBe(true);
        expect(fillMissingCustomEndpointParameters(partial, settings)).toBe(true);
        expect(fillMissingCustomEndpointParameters(stored, settings)).toBe(false);
        expect(fillMissingCustomEndpointParameters(none, settings)).toBe(false);

        expect(legacy).toMatchObject(settings);
        expect(partial).toMatchObject({ custom_include_body: 'min_p: 0.1', custom_exclude_body: '- seed', custom_include_headers: 'X-Title: Story' });
        expect(stored).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
        expect(none).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
        expect(fillMissingCustomEndpointParameters(legacy, { ...settings, custom_include_body: 'changed: 1' })).toBe(false);
        expect(legacy.custom_include_body).toBe('  top_k: 20\n');
    });

    test('fills nothing when there is no profile or the live settings hold none of the parameters', () => {
        const legacy = normalizeCustomEndpointPreset({ name: 'Legacy' });

        expect(fillMissingCustomEndpointParameters(null, { custom_include_body: 'top_k: 20' })).toBe(false);
        expect(fillMissingCustomEndpointParameters(undefined, { custom_include_body: 'top_k: 20' })).toBe(false);
        expect(fillMissingCustomEndpointParameters(legacy, {})).toBe(false);
        expect(legacy).toEqual({ name: 'Legacy', url: '', key: '', model: '', secretId: '' });
    });

    describe('request overrides from the Custom endpoint profile of a connection profile', () => {
        const endpointProfiles = [
            normalizeCustomEndpointPreset({ name: 'None' }),
            normalizeCustomEndpointPreset({ name: 'Local', custom_include_body: '  top_k: 20\n', custom_exclude_body: '', custom_include_headers: 'X-Title: Story' }),
            normalizeCustomEndpointPreset({ name: 'Legacy', url: 'http://127.0.0.1:5001/v1' }),
        ];
        const connectionProfile = { api: 'custom', 'custom-endpoint-profile': 'Local' };
        const overridesFor = (profile, { overridePayload = {}, isCustomSource = true, profiles = endpointProfiles } = {}) =>
            getCustomEndpointProfileRequestOverrides({ profile, endpointProfiles: profiles, overridePayload, isCustomSource });

        test('gives a connection profile that records none the values its endpoint profile stores, empty ones included', () => {
            expect(overridesFor(connectionProfile)).toEqual({
                custom_include_body: '  top_k: 20\n',
                custom_exclude_body: '',
                custom_include_headers: 'X-Title: Story',
            });
        });

        test('leaves a value that the connection profile records and a value that the caller passes to them', () => {
            const profile = { ...connectionProfile, 'custom-include-body': 'min_p: 0.1' };

            expect(overridesFor(profile, { overridePayload: { custom_include_headers: 'X-Caller: 1' } })).toEqual({ custom_exclude_body: '' });
            expect(overridesFor({ ...connectionProfile, 'custom-include-body': '' })).not.toHaveProperty('custom_include_body');
        });

        test('gives empty values for None, as applying the profile clears them', () => {
            expect(overridesFor({ ...connectionProfile, 'custom-endpoint-profile': 'None' })).toEqual({
                custom_include_body: '',
                custom_exclude_body: '',
                custom_include_headers: '',
            });
        });

        test.each([
            ['a name that no endpoint profile has', { ...connectionProfile, 'custom-endpoint-profile': 'Deleted' }],
            ['an endpoint profile that stores none', { ...connectionProfile, 'custom-endpoint-profile': 'Legacy' }],
            ['no name', { api: 'custom' }],
            ['no connection profile', undefined],
        ])('gives nothing for %s', (_, profile) => {
            expect(overridesFor(profile)).toEqual({});
        });

        test('gives nothing when the connection profile is not of the Custom source, or there are no endpoint profiles', () => {
            expect(overridesFor(connectionProfile, { isCustomSource: false })).toEqual({});
            expect(overridesFor(connectionProfile, { profiles: null })).toEqual({});
            expect(overridesFor(connectionProfile, { profiles: [] })).toEqual({});
        });

        test('changes neither the connection profile, the endpoint profiles nor the caller payload', () => {
            const profile = { ...connectionProfile };
            const overridePayload = { custom_include_headers: 'X-Caller: 1' };
            const before = structuredClone({ profile, endpointProfiles, overridePayload });

            overridesFor(profile, { overridePayload });

            expect({ profile, endpointProfiles, overridePayload }).toEqual(before);
        });
    });

    test('picks only the Additional Parameters from live settings or a profile', () => {
        expect(pickCustomEndpointParameters({
            custom_url: 'https://proxy.example/v1',
            custom_include_body: 'top_k: 20',
            custom_exclude_body: '- frequency_penalty',
            custom_include_headers: '',
        })).toEqual({
            custom_include_body: 'top_k: 20',
            custom_exclude_body: '- frequency_penalty',
            custom_include_headers: '',
        });
        expect(pickCustomEndpointParameters(null)).toEqual({});
        expect(pickCustomEndpointParameters({ name: 'Legacy', url: 'https://legacy.example/v1' })).toEqual({});
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

describe('Custom endpoint favorites keys', () => {
    test('passes through non-Custom sources', () => {
        expect(getCustomEndpointFavoritesKey('claude', 'https://proxy.example/v1')).toBe('claude');
        expect(getCustomEndpointFavoritesKey('openai', '')).toBe('openai');
    });

    test('scopes Custom favorites by endpoint URL', () => {
        expect(getCustomEndpointFavoritesKey('custom', 'https://proxy.example/v1')).toBe('custom::https://proxy.example/v1');
    });

    test('normalizes Custom endpoint URL whitespace and trailing slashes', () => {
        expect(getCustomEndpointFavoritesKey('custom', '  https://proxy.example/v1///  ')).toBe('custom::https://proxy.example/v1');
    });

    test('keeps legacy Custom key for empty endpoint URLs', () => {
        expect(getCustomEndpointFavoritesKey('custom', '')).toBe('custom');
        expect(getCustomEndpointFavoritesKey('custom', '  ///  ')).toBe('custom');
    });
});
