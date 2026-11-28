/* global globalThis */
import { jest } from '@jest/globals';
import { ReadableStream, TextDecoderStream, TransformStream } from 'node:stream/web';
import { TextEncoder, TextDecoder } from 'node:util';
import { importScriptModule } from './script-harness.js';

export function ensureWebStreamGlobals() {
    if (typeof globalThis.ReadableStream === 'undefined') globalThis.ReadableStream = ReadableStream;
    if (typeof globalThis.TextDecoderStream === 'undefined') globalThis.TextDecoderStream = TextDecoderStream;
    if (typeof globalThis.TransformStream === 'undefined') globalThis.TransformStream = TransformStream;
    if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder;
    if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder;
    if (typeof globalThis.Response === 'undefined') {
        const encoder = new TextEncoder();
        globalThis.Response = class MinimalResponse {
            constructor(body = '', init = {}) {
                this._text = typeof body === 'string' ? body : String(body ?? '');
                this.status = init.status ?? 200;
                this.statusText = init.statusText ?? '';
                this.ok = this.status >= 200 && this.status < 300;
                const map = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
                this.headers = { get: key => map.get(String(key).toLowerCase()) ?? null };
                const bytes = encoder.encode(this._text);
                this.body = new ReadableStream({
                    start(controller) {
                        controller.enqueue(bytes);
                        controller.close();
                    },
                });
            }
            async text() { return this._text; }
            async json() { return JSON.parse(this._text); }
        };
    }
}

/**
 * Returns the shared peer mocks required to run `importScriptModule` with real
 * `scripts/openai.js` (and optionally real `scripts/textgen-settings.js`,
 * `scripts/reasoning.js`, `scripts/sse-stream.js`, and `scripts/group-chats.js`).
 * @param {object} [options]
 */
export function buildStoryModeMocks({
    keepReal = [],
    promptManagerMocks = null,
    extraMocks = {},
} = {}) {
    const keepRealSet = new Set(keepReal);
    const noopProxy = new Proxy({}, { get: () => jest.fn(() => jest.fn(() => [])) });

    const baseMocks = {
        'scripts/chat-templates.js': {
            deriveTemplatesFromChatTemplate: jest.fn(() => ({})),
        },
        'scripts/instruct-mode.js': base => ({
            ...base,
            autoSelectInstructPreset: jest.fn(),
        }),
        'scripts/logit-bias.js': {
            BIAS_CACHE: new Map(),
            createNewLogitBiasEntry: jest.fn(),
            displayLogitBias: jest.fn(),
            getLogitBiasListResult: jest.fn(() => []),
        },
        'scripts/power-user.js': base => ({
            ...base,
            registerDebugFunction: jest.fn(),
            performFuzzySearch: jest.fn(() => []),
        }),
        'scripts/samplerSelect.js': {
            initCustomSelectedSamplers: jest.fn(),
            validateDisabledSamplers: jest.fn(),
            getActiveManualApiSamplers: jest.fn(() => []),
            getApiSamplerVisibilityState: jest.fn(() => ({})),
            isSamplerManualPriorityEnabled: jest.fn(() => false),
            loadApiSelectedSamplers: jest.fn(),
            saveApiSelectedSamplers: jest.fn(),
            setApiSamplerVisibilityState: jest.fn(),
        },
        'scripts/secrets.js': base => ({
            ...base,
            SECRET_KEYS: new Proxy({}, { get: (_target, key) => `api_key_${String(key).toLowerCase()}` }),
            secret_state: new Proxy({}, { get: () => true }),
            checkOpenRouterAuth: jest.fn(),
            initSecrets: jest.fn(),
            readSecretState: jest.fn(async () => {}),
            writeSecret: jest.fn(async () => 'secret-id'),
            rotateSecret: jest.fn(async () => 'secret-id'),
            deleteSecret: jest.fn(async () => {}),
            findSecret: jest.fn(async () => null),
            canViewSecrets: jest.fn(async () => false),
            resolveSecretKey: jest.fn(() => ''),
            updateSecretDisplay: jest.fn(),
            getSecretLabelById: jest.fn(() => ''),
        }),
        'scripts/logprobs.js': base => ({
            ...base,
            saveLogprobsForActiveMessage: jest.fn(),
            parseChatCompletionLogprobs: jest.fn(() => null),
        }),
        'scripts/sillybunny-connection-state.js': {
            setConnectionStatus: jest.fn(),
            setStatusCheckPending: jest.fn(),
        },
        'scripts/sillybunny-koboldcpp-models.js': base => ({
            ...base,
            countStatusLoadingStart: jest.fn(),
            getKoboldCppChatState: jest.fn(() => null),
            refreshKoboldCppModels: jest.fn(async () => []),
            getKoboldCppModels: jest.fn(() => []),
            syncKoboldCppModelSelect: jest.fn(),
            normalizeKoboldCppModelId: v => String(v ?? ''),
            countKoboldCppChatTokens: jest.fn(async () => 0),
            isKoboldCppChatCompletion: jest.fn(() => false),
            initKoboldCppModels: jest.fn(),
        }),
        'scripts/sillybunny-connection-notices.js': {
            flagMissingKey: jest.fn(),
        },
        'scripts/sillybunny-editor/option-details.js': {
            registerOptionDetails: jest.fn(),
            hasOptionDetails: jest.fn(() => false),
            toDetails: jest.fn(v => v),
            detailsToText: jest.fn(() => ''),
            renderDetails: jest.fn(() => document.createElement('div')),
            icon: jest.fn(),
            link: jest.fn(),
            badge: jest.fn(),
            createDetailsMapper: jest.fn(() => jest.fn()),
        },
        'scripts/sillybunny-model-details.js': {
            describeAimlapiModel: jest.fn(),
            describeChutesModel: jest.fn(),
            describeElectronHubModel: jest.fn(),
            describeHordeModel: jest.fn(),
            describeMancerModel: jest.fn(),
            describeOpenRouterModel: jest.fn(),
            describeTogetherModel: jest.fn(),
            plainText: value => String(value ?? ''),
        },
        'scripts/PromptManager.js': promptManagerMocks ?? {
            registerPromptManagerMigration: jest.fn(),
            chatCompletionDefaultPrompts: { prompts: [] },
            INJECTION_POSITION: { RELATIVE: 0, ABSOLUTE: 1 },
            Prompt: class Prompt { constructor(data = {}) { Object.assign(this, data); } },
            PromptManager: class PromptManager {
                serviceSettings = { openai_max_context: 32768, openai_max_tokens: 8192 };
                tokenHandler = { counts: false };
                messages = { collection: [] };
                init() {}
                setup() {}
                setChatCompletion() {}
                preparePrompt(p) { return p; }
                log() {}
                render() {}
                getPromptCollection() { return { collection: [] }; }
                getPromptOrderForCharacter() { return []; }
                getPromptById() { return null; }
                isPromptDisabledForActiveCharacter() { return false; }
            },
            promptManagerDefaultPromptOrders: [],
        },
        'scripts/textgen-models.js': {
            initTextGenModels: jest.fn(),
            getCurrentDreamGenModelTokenizer: jest.fn(() => null),
            getCurrentOpenRouterModelTokenizer: jest.fn(() => null),
            openRouterModels: [],
            loadAphroditeModels: jest.fn(),
            loadDreamGenModels: jest.fn(),
            loadFeatherlessModels: jest.fn(),
            loadGenericModels: jest.fn(),
            loadInfermaticAIModels: jest.fn(),
            loadLlamaCppModels: jest.fn(),
            loadMancerModels: jest.fn(),
            loadOllamaModels: jest.fn(),
            loadOpenRouterModels: jest.fn(),
            loadTabbyModels: jest.fn(),
            loadTogetherAIModels: jest.fn(),
            loadVllmModels: jest.fn(),
            setOpenRouterProviders: jest.fn(),
            syncNanoGptProvidersForModel: jest.fn(),
            syncOpenRouterProvidersForModel: jest.fn(),
            updateNanoGptProvidersWarning: jest.fn(),
            updateOpenRouterProvidersWarning: jest.fn(),
        },
        'scripts/tokenizers.js': base => ({
            ...base,
            ENCODE_TOKENIZERS: {},
            TEXTGEN_TOKENIZERS: [],
            TOKENIZER_SUPPORTED_KEY: 'tokenizer',
            getTokenizerBestMatch: jest.fn(),
            countChatCompletionPayloadTokensOpenAIAsync: jest.fn(async () => 0),
            countTokensOpenAIAsync: jest.fn(async () => 0),
            getTokenizerModel: jest.fn(() => 'gpt-4o'),
            primeOpenAITokenCache: jest.fn(),
            tokenizers: {},
        }),
        'scripts/utils.js': base => ({
            ...base,
            createThumbnail: jest.fn(),
            download: jest.fn(),
            getAudioDurationFromDataURL: jest.fn(async () => 0),
            getBase64Async: jest.fn(async () => ''),
            getFileText: jest.fn(async () => ''),
            getImageSizeFromDataURL: jest.fn(async () => ({ width: 0, height: 0 })),
            getSortableDelay: jest.fn(() => 0),
            getStringHash: jest.fn(value => String(value ?? '')),
            getVideoDurationFromDataURL: jest.fn(async () => 0),
            isFalseBoolean: value => value === false || String(value).toLowerCase() === 'false',
            isTrueBoolean: value => value === true || String(value).toLowerCase() === 'true',
            isUuid: jest.fn(() => false),
            parseJsonFile: jest.fn(async () => ({})),
            resetScrollHeight: jest.fn(),
            stringFormat: (str, ...args) => String(str).replace(/\{(\d+)\}/g, (_m, i) => args[i] ?? ''),
            textValueMatcher: jest.fn(() => true),
            arraysEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
            isObject: value => value !== null && typeof value === 'object' && !Array.isArray(value),
            toIntArray: () => [],
            setDatasetProperty: (el, key, value) => { if (el?.dataset) el.dataset[key] = value; },
            delay: jest.fn(async () => {}),
        }),
        'scripts/sillybunny-delete-confirm.js': {
            DELETE_CHOICE: { CANCEL: 0, CONFIRM: 1 },
            confirmMessageDeletion: jest.fn(async () => 1),
            confirmVerb: jest.fn(() => ({})),
        },
        'scripts/sillybunny-editor/adapters/window-content-dialogs.js': {
            accountProfileOptions: jest.fn(() => ({})),
            snapshotsOptions: jest.fn(() => ({})),
            adminPanelOptions: jest.fn(() => ({})),
            scenarioOverrideOptions: jest.fn(() => ({})),
            customEndpointParametersOptions: jest.fn(() => ({})),
        },
        'scripts/sillybunny-request-errors.js': base => ({
            ...base,
            createFailedResponseError: jest.fn(async () => new Error('Request failed')),
            extractProviderMessage: jest.fn(() => ''),
            getThrownResponseFailure: jest.fn(() => null),
            showRequestError: jest.fn(),
            getFailureStatus: jest.fn(() => 500),
        }),
        'scripts/macros/macro-system.js': {
            macros: { register: jest.fn(), registry: { unregisterMacro: jest.fn() } },
            MacroCategory: {},
        },
        'scripts/slash-commands/SlashCommand.js': {
            SlashCommand: { fromProps: props => props },
        },
        'scripts/slash-commands/SlashCommandArgument.js': {
            ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list' },
            SlashCommandArgument: class { static fromProps(p) { return p; } },
            SlashCommandNamedArgument: class { static fromProps(p) { return p; } },
        },
        'scripts/slash-commands/SlashCommandCommonEnumsProvider.js': {
            commonEnumProviders: noopProxy,
            enumIcons: new Proxy({}, { get: () => '' }),
        },
        'scripts/slash-commands/SlashCommandEnumValue.js': {
            SlashCommandEnumValue: class {},
            enumTypes: { enum: 'enum', name: 'name', command: 'command', getBasedOnIndex: () => 'enum' },
        },
        'scripts/slash-commands/SlashCommandParser.js': {
            SlashCommandParser: { addCommandObject: jest.fn(), commands: {} },
        },
    };

    if (!keepRealSet.has('scripts/sse-stream.js')) {
        baseMocks['scripts/sse-stream.js'] = {
            default: class EventSourceStream {},
            EventSourceStream: class EventSourceStream {},
            getEventSourceStream: jest.fn(),
        };
    }

    if (!keepRealSet.has('scripts/group-chats.js')) {
        baseMocks['scripts/group-chats.js'] = base => ({
            ...base,
            getGroupNames: jest.fn(() => []),
        });
    }

    const merged = { ...baseMocks };
    for (const [key, override] of Object.entries(extraMocks)) {
        if (typeof override === 'function' && typeof merged[key] === 'function') {
            const prev = merged[key];
            merged[key] = base => override(prev(base));
        } else if (typeof override === 'function' && merged[key] && typeof merged[key] === 'object') {
            const prevObj = merged[key];
            merged[key] = base => override({ ...base, ...prevObj });
        } else if (override && typeof override === 'object' && typeof merged[key] === 'function') {
            const prev = merged[key];
            merged[key] = base => ({ ...prev(base), ...override });
        } else if (override && typeof override === 'object' && merged[key] && typeof merged[key] === 'object') {
            merged[key] = { ...merged[key], ...override };
        } else {
            merged[key] = override;
        }
    }
    return merged;
}

export async function importStoryModeRuntime({
    keepReal = ['scripts/openai.js'],
    dom = undefined,
    fetch = null,
    promptManagerMocks = null,
    extraMocks = {},
} = {}) {
    ensureWebStreamGlobals();
    return importScriptModule({
        dom,
        keepReal,
        fetch,
        mocks: buildStoryModeMocks({ keepReal, promptManagerMocks, extraMocks }),
    });
}
