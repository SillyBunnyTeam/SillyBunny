import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockOpenAiSettings = {};
const mockProxies = [];

await jest.unstable_mockModule('../public/script.js', () => ({
    CONNECT_API_MAP: {},
    createModelIcon: jest.fn(),
    getRequestHeaders: jest.fn(() => ({})),
}));

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    extension_settings: {
        caption: {},
    },
    openThirdPartyExtensionMenu: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ''}`, ''),
}));

await jest.unstable_mockModule('../public/scripts/openai.js', () => ({
    oai_settings: mockOpenAiSettings,
    proxies: mockProxies,
    ZAI_ENDPOINT: {
        COMMON: 'common',
    },
}));

await jest.unstable_mockModule('../public/scripts/secrets.js', () => ({
    SECRET_KEYS: {},
    secret_state: {},
}));

await jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    textgen_types: {},
    textgenerationwebui_settings: {},
}));

await jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getTokenCountAsync: jest.fn(async () => 0),
}));

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    createThumbnail: jest.fn(async value => value),
    isTrueBoolean: value => ['on', 'true', '1'].includes(String(value ?? '').trim().toLowerCase()),
    isValidUrl: jest.fn(() => true),
}));

const {
    getChatCompletionProfileRequestOverrides,
    getChatCompletionProfileReverseProxy,
} = await import('../public/scripts/extensions/shared.js');

const mappedRequestFieldNames = [
    'include_reasoning',
    'reasoning_effort',
    'verbosity',
    'enable_web_search',
    'request_images',
    'request_image_resolution',
    'request_image_aspect_ratio',
    'custom_reasoning_preset',
    'custom_reasoning_param_format',
    'custom_reasoning_param_name',
    'custom_reasoning_enabled_value',
    'custom_reasoning_disabled_value',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
];

function createReasoningProfile(overrides = {}) {
    return {
        id: 'profile-reasoning',
        mode: 'cc',
        name: 'Reasoning Profile',
        api: 'openai',
        model: 'gpt-5.2',
        'request-reasoning': 'true',
        'reasoning-effort': 'high',
        'verbosity': 'low',
        'enable-web-search': '1',
        'request-images': 'off',
        'request-image-resolution': '2K',
        'request-image-aspect-ratio': '16:9',
        'custom-reasoning-preset': 'custom',
        'custom-reasoning-param-format': 'thinking_object',
        'custom-reasoning-param-name': 'thinking',
        'custom-reasoning-enabled-value': 'enabled',
        'custom-reasoning-disabled-value': 'disabled',
        'custom-include-body': '  top_k: 20\n  min_p: 0.05',
        'custom-exclude-body': '- frequency_penalty',
        'custom-include-headers': '',
        ...overrides,
    };
}

beforeEach(() => {
    for (const key of Object.keys(mockOpenAiSettings)) {
        delete mockOpenAiSettings[key];
    }
    mockProxies.splice(0, mockProxies.length);
});

describe('Connection Profile chat-completion request field mapping', () => {
    test('leaves existing profiles without reasoning request keys unchanged', () => {
        const legacyProfile = {
            id: 'profile-legacy',
            mode: 'cc',
            name: 'Legacy Profile',
            api: 'openai',
            model: 'gpt-4o-mini',
            preset: 'Default',
        };

        const result = getChatCompletionProfileRequestOverrides(legacyProfile, {});

        expect(result).toEqual({
            overrides: {},
            profileFieldNames: [],
        });
        expect(legacyProfile).toEqual({
            id: 'profile-legacy',
            mode: 'cc',
            name: 'Legacy Profile',
            api: 'openai',
            model: 'gpt-4o-mini',
            preset: 'Default',
        });
    });

    test('maps reasoning, web search, image, and custom reasoning profile keys to request fields', () => {
        const result = getChatCompletionProfileRequestOverrides(createReasoningProfile(), {});

        expect(result).toEqual({
            overrides: {
                include_reasoning: true,
                reasoning_effort: 'high',
                verbosity: 'low',
                enable_web_search: true,
                request_images: false,
                request_image_resolution: '2K',
                request_image_aspect_ratio: '16:9',
                custom_reasoning_preset: 'custom',
                custom_reasoning_param_format: 'thinking_object',
                custom_reasoning_param_name: 'thinking',
                custom_reasoning_enabled_value: 'enabled',
                custom_reasoning_disabled_value: 'disabled',
                custom_include_body: '  top_k: 20\n  min_p: 0.05',
                custom_exclude_body: '- frequency_penalty',
                custom_include_headers: '',
            },
            profileFieldNames: mappedRequestFieldNames,
        });
    });

    test('lets explicit caller overrides beat profile values', () => {
        const overridePayload = {
            include_reasoning: false,
            reasoning_effort: 'low',
            enable_web_search: false,
            request_image_resolution: '1K',
            custom_reasoning_param_name: 'caller_reasoning',
        };

        const result = getChatCompletionProfileRequestOverrides(createReasoningProfile(), overridePayload);

        expect(result.overrides).toEqual({
            verbosity: 'low',
            request_images: false,
            request_image_aspect_ratio: '16:9',
            custom_reasoning_preset: 'custom',
            custom_reasoning_param_format: 'thinking_object',
            custom_reasoning_enabled_value: 'enabled',
            custom_reasoning_disabled_value: 'disabled',
            custom_include_body: '  top_k: 20\n  min_p: 0.05',
            custom_exclude_body: '- frequency_penalty',
            custom_include_headers: '',
        });
        expect(result.profileFieldNames).toEqual(mappedRequestFieldNames.filter(field => !Object.hasOwn(overridePayload, field)));
        expect({ ...result.overrides, ...overridePayload }).toEqual(expect.objectContaining(overridePayload));
    });
});

describe('Connection Profile reverse proxy request mapping', () => {
    test('uses the saved profile proxy preset before fallbacks', () => {
        mockOpenAiSettings.reverse_proxy = 'https://active.example/v1';
        mockOpenAiSettings.proxy_password = 'active-secret';
        mockProxies.push(
            { name: 'Profile proxy', url: 'https://profile.example/v1', password: 'profile-secret', source: 'openai' },
            { name: 'Source proxy', url: 'https://source.example/v1', password: 'source-secret', source: 'makersuite' },
        );

        expect(getChatCompletionProfileReverseProxy({ proxy: 'Profile proxy' }, 'makersuite')).toEqual({
            reverse_proxy: 'https://profile.example/v1',
            proxy_password: 'profile-secret',
        });
    });

    test('honors an explicit profile proxy selection of None without fallbacks', () => {
        mockOpenAiSettings.reverse_proxy = 'https://active.example/v1';
        mockOpenAiSettings.proxy_password = 'active-secret';
        mockProxies.push(
            { name: 'None', url: '', password: '', source: '' },
            { name: 'Gemini proxy', url: 'https://proxy.example/google', password: '', source: 'makersuite' },
        );

        expect(getChatCompletionProfileReverseProxy({ proxy: 'None' }, 'makersuite')).toEqual({});
        expect(getChatCompletionProfileReverseProxy({ proxy: 'Deleted proxy' }, 'makersuite')).toEqual({});
    });

    test('falls back to a backend-bound proxy preset when the profile has no proxy key', () => {
        mockProxies.push(
            { name: 'None', url: '', password: '', source: '' },
            { name: 'Gemini proxy', url: 'https://proxy.example/google', password: '', source: 'makersuite' },
        );

        expect(getChatCompletionProfileReverseProxy({}, 'makersuite')).toEqual({
            reverse_proxy: 'https://proxy.example/google',
            proxy_password: '',
        });
    });

    test('falls back to the active reverse proxy only when the profile has no proxy key', () => {
        mockOpenAiSettings.reverse_proxy = 'https://manual.example/v1';
        mockOpenAiSettings.proxy_password = 'manual-secret';
        mockProxies.push({ name: 'None', url: '', password: '', source: '' });

        expect(getChatCompletionProfileReverseProxy({}, 'openai')).toEqual({
            reverse_proxy: 'https://manual.example/v1',
            proxy_password: 'manual-secret',
        });
        expect(getChatCompletionProfileReverseProxy({ proxy: 'None' }, 'openai')).toEqual({});
    });

    test('omits reverse proxy fields when no usable proxy is available', () => {
        mockProxies.push({ name: 'None', url: '', password: '', source: '' });

        expect(getChatCompletionProfileReverseProxy({ proxy: 'None' }, 'openai')).toEqual({});
        expect(getChatCompletionProfileReverseProxy({}, 'openai')).toEqual({});
    });
});
