/* global globalThis */
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

const SERVER_URL = 'http://127.0.0.1:5001';
const resolvePublic = (relativePath) => fileURLToPath(new URL(`../public/${relativePath}`, import.meta.url));

const textgenStatusState = {
    onlineStatus: 'no_connection',
    refreshes: [],
};

const originalLocalStorage = globalThis.localStorage;
const originalDocument = globalThis.document;
const originalSessionStorage = globalThis.sessionStorage;
const originalFetch = globalThis.fetch;

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null };

await jest.unstable_mockModule(resolvePublic('script.js'), () => ({
    abortStatusCheck: new AbortController(),
    eventSource: { on: () => {}, emit: async () => {} },
    event_types: { TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready' },
    getRequestHeaders: () => ({}),
    getStoppingStrings: () => [],
    main_api: 'textgenerationwebui',
    max_context: 4096,
    online_status: 'Valid',
    resultCheckStatus: () => {},
    saveSettings: async () => {},
    saveSettingsDebounced: () => {},
    setGenerationParamsFromPreset: () => {},
    setOnlineStatus: (value) => { textgenStatusState.onlineStatus = value; },
    startStatusLoading: () => {},
    substituteParams: text => text,
}));
await jest.unstable_mockModule(resolvePublic('scripts/chat-templates.js'), () => ({
    deriveTemplatesFromChatTemplate: () => null,
}));
await jest.unstable_mockModule(resolvePublic('scripts/i18n.js'), () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
await jest.unstable_mockModule(resolvePublic('scripts/instruct-mode.js'), () => ({
    autoSelectInstructPreset: () => false,
    selectContextPreset: () => {},
    selectInstructPreset: () => {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/logit-bias.js'), () => ({
    BIAS_CACHE: new Map(),
    createNewLogitBiasEntry: () => ({}),
    displayLogitBias: () => {},
    getLogitBiasListResult: () => [],
}));
await jest.unstable_mockModule(resolvePublic('scripts/power-user.js'), () => ({
    power_user: { instruct: { enabled: false }, instruct_derived: false, context_derived: false, context_size_derived: false },
    registerDebugFunction: () => {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/samplerSelect.js'), () => ({
    getActiveManualApiSamplers: () => [],
    getApiSamplerVisibilityState: () => ({}),
    isSamplerManualPriorityEnabled: () => false,
    loadApiSelectedSamplers: () => {},
    saveApiSelectedSamplers: () => {},
    setApiSamplerVisibilityState: () => {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/secrets.js'), () => ({
    SECRET_KEYS: {},
    writeSecret: async () => {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/sse-stream.js'), () => ({
    getEventSourceStream: () => null,
}));
await jest.unstable_mockModule(resolvePublic('scripts/resumable-generation.js'), () => ({
    fetchResumable: jest.fn(),
}));
await jest.unstable_mockModule(resolvePublic('scripts/local-url-utils.js'), () => ({
    getLocalPromptCacheValue: () => false,
    isLikelyLocalServerUrl: () => true,
}));
await jest.unstable_mockModule(resolvePublic('scripts/sampling-parameter-policy.js'), () => ({
    POLICY_SCHEMA_VERSION: 1,
    applySamplingParameterPolicy: payload => payload,
    createSamplingRequestContext: () => ({}),
    createSamplingTargetKey: () => '',
    getTargetSamplingPolicy: () => ({}),
    normalizeTransmissionState: state => state,
    parseLegacySamplingExclusions: () => ({}),
    resolveEffectiveParameterDecision: () => ({}),
    setTargetParameterState: () => {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/openai.js'), () => ({
    oai_settings: {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/textgen-models.js'), () => ({
    getCurrentDreamGenModelTokenizer: () => '',
    getCurrentOpenRouterModelTokenizer: () => '',
    loadAphroditeModels: () => {},
    loadDreamGenModels: () => {},
    loadFeatherlessModels: () => {},
    loadGenericModels: () => {},
    loadInfermaticAIModels: () => {},
    loadLlamaCppModels: () => {},
    loadMancerModels: () => {},
    loadOllamaModels: () => {},
    loadOpenRouterModels: () => {},
    loadTabbyModels: () => {},
    loadTogetherAIModels: () => {},
    loadVllmModels: () => {},
    setOpenRouterProviders: () => {},
    updateOpenRouterProvidersWarning: () => {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/sillybunny-koboldcpp-models.js'), () => ({
    refreshKoboldCppModels: async () => {
        textgenStatusState.refreshes.push(textgenStatusState.onlineStatus);
    },
}));
await jest.unstable_mockModule(resolvePublic('scripts/tokenizers.js'), () => ({
    ENCODE_TOKENIZERS: [],
    TEXTGEN_TOKENIZERS: [],
    TOKENIZER_SUPPORTED_KEY: 'tokenization',
    getTextTokens: () => [],
    getTokenizerBestMatch: () => null,
    tokenizers: {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/util/AbortReason.js'), () => ({
    AbortReason: class AbortReason extends Error {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/utils.js'), () => ({
    getSortableDelay: () => 0,
    onlyUnique: () => true,
    arraysEqual: () => true,
    isObject: value => value !== null && typeof value === 'object',
}));
await jest.unstable_mockModule(resolvePublic('scripts/sillybunny-request-errors.js'), () => ({
    createFailedResponseError: () => new Error('failed'),
    extractProviderMessage: () => '',
    showRequestError: () => {},
    getFailureStatus: () => 500,
}));

const { getStatusTextgen, textgenerationwebui_settings } = await import('../public/scripts/textgen-settings.js');

describe('getStatusTextgen() hook', () => {
    beforeAll(() => {
        globalThis.sessionStorage = { setItem: () => {}, removeItem: () => {} };
    });

    afterAll(() => {
        if (originalLocalStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = originalLocalStorage;
        if (originalDocument === undefined) delete globalThis.document;
        else globalThis.document = originalDocument;
        if (originalSessionStorage === undefined) delete globalThis.sessionStorage;
        else globalThis.sessionStorage = originalSessionStorage;
        globalThis.fetch = originalFetch;
    });

    /**
     * Runs getStatusTextgen() from textgen-settings.js against a server that reports a loaded model.
     * @param {string} type Text Completion type
     * @param {number} [checks] Number of status checks to run
     * @returns {Promise<string[]>} Online status at each refresh of the switcher
     */
    async function runStatusChecks(type, checks = 1) {
        textgenStatusState.onlineStatus = 'no_connection';
        textgenStatusState.refreshes = [];
        globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({ result: 'koboldcpp/alpha' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        textgenerationwebui_settings.type = type;
        textgenerationwebui_settings.server_urls[type] = SERVER_URL;
        textgenerationwebui_settings.bypass_status_check = false;

        for (let check = 0; check < checks; check++) {
            await getStatusTextgen();
        }
        return [...textgenStatusState.refreshes];
    }

    test('refreshes the switcher after every KoboldCpp status check, once the new status is set', async () => {
        await expect(runStatusChecks('koboldcpp', 2)).resolves.toEqual(['koboldcpp/alpha', 'koboldcpp/alpha']);
    });

    test('leaves the switcher alone for other Text Completion types', async () => {
        await expect(runStatusChecks('ooba')).resolves.toEqual([]);
    });
});
