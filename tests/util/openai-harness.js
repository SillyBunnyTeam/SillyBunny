/* global globalThis */
import { jest } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));

/**
 * Creates a chainable jQuery stand-in for Node-environment tests that load `openai.js`
 * without mounting a full DOM. Callers in jsdom with real jQuery loaded keep their own `$`.
 * @returns {Function}
 */
export function createNoopJQuery() {
    const chain = {
        length: 0,
        on: () => chain,
        off: () => chain,
        val: (...args) => (args.length > 0 ? chain : ''),
        prop: (...args) => (args.length > 1 ? chain : false),
        attr: () => chain,
        removeAttr: () => chain,
        text: () => chain,
        html: () => chain,
        empty: () => chain,
        append: () => chain,
        prepend: () => chain,
        find: () => chain,
        filter: () => chain,
        addClass: () => chain,
        removeClass: () => chain,
        toggleClass: () => chain,
        hasClass: () => false,
        toggle: () => chain,
        show: () => chain,
        hide: () => chain,
        trigger: () => chain,
        each: () => chain,
        data: () => undefined,
        select2: () => chain,
        sortable: () => chain,
        is: () => false,
        closest: () => chain,
        parent: () => chain,
        children: () => chain,
        first: () => chain,
        css: () => chain,
        remove: () => chain,
        detach: () => chain,
    };
    const jq = () => chain;
    jq.fn = {};
    return jq;
}

/**
 * Registers `jest.unstable_mockModule` stubs for the browser peers of `public/scripts/openai.js`
 * and imports the real module. Call before importing `openai.js` or modules that depend on it.
 * @param {object} [options]
 * @param {boolean} [options.mockToolCalling] Mock `tool-calling.js` instead of loading the real `ToolManager`.
 * @param {boolean} [options.mockPromptManager] Mock `PromptManager.js` instead of loading the real `PromptManager`.
 * @param {boolean} [options.mockTokenizers] Mock `tokenizers.js` instead of loading real tokenizers.
 * @param {object} [options.script] Extra overrides merged into the `public/script.js` mock.
 * @param {object} [options.powerUser] Initial `power_user` object.
 * @param {object} [options.secrets] Extra overrides merged into the `public/scripts/secrets.js` mock.
 * @param {object} [options.accountStorage] Extra overrides for `accountStorage`.
 * @param {object} [options.koboldCpp] Extra overrides for `sillybunny-koboldcpp-models.js`.
 * @param {object} [options.popup] Extra overrides for `popup.js`.
 * @param {object} [options.templates] Extra overrides for `templates.js`.
 * @param {Function} [options.fetchResumable] Custom mock implementation for `fetchResumable`.
 * @returns {Promise<{ openai: typeof import('../../public/scripts/openai.js'), mocks: Record<string, any> }>}
 */
export async function importOpenAiModule({
    mockToolCalling = true,
    mockPromptManager = true,
    mockTokenizers = true,
    mockTextgenModels = true,
    mockUtils = true,
    mockModelDetails = true,
    domPurify = null,
    script: scriptOverrides = {},
    powerUser: powerUserOverrides = {},
    secrets: secretsOverrides = {},
    accountStorage: accountStorageOverrides = {},
    koboldCpp: koboldCppOverrides = {},
    popup: popupOverrides = {},
    templates: templatesOverrides = {},
    fetchResumable: fetchResumableOverride = null,
} = {}) {
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
    }
    if (typeof globalThis.CSS === 'undefined') {
        globalThis.CSS = {
            supports: () => false,
            escape: value => String(value).replace(/([^\w-])/g, '\\$1'),
        };
    }
    if (typeof globalThis.window !== 'undefined' && typeof globalThis.window.matchMedia !== 'function') {
        globalThis.window.matchMedia = () => ({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
        });
    }
    if (typeof globalThis.$ !== 'function') {
        const jq = createNoopJQuery();
        globalThis.$ = jq;
        globalThis.jQuery = jq;
    } else if (globalThis.$.expr?.pseudos && !globalThis.$.expr.pseudos.is) {
        // jQuery 3.5.1 falls back to Sizzle when jsdom rejects `:has(...)`; Sizzle lacks CSS `:is(...)`.
        globalThis.$.expr.pseudos.is = globalThis.$.expr.createPseudo(
            selector => elem => globalThis.$(elem).is(selector),
        );
    }
    if (!globalThis.toastr) {
        globalThis.toastr = {
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
            clear: jest.fn(),
        };
    }

    const eventListeners = new Map();
    const eventSource = {
        on: jest.fn((event, listener) => {
            if (!eventListeners.has(event)) eventListeners.set(event, []);
            eventListeners.get(event).push(listener);
        }),
        once: jest.fn(),
        off: jest.fn(),
        removeListener: jest.fn(),
        emit: jest.fn(async (event, ...args) => {
            for (const listener of eventListeners.get(event) ?? []) {
                await listener(...args);
            }
        }),
        makeLast: jest.fn(),
        makeFirst: jest.fn(),
    };

    const powerUser = {
        console_log_prompts: false,
        custom_stopping_strings: '',
        custom_stopping_strings_macro: false,
        persona_description: '',
        persona_description_position: 0,
        persona_description_depth: 2,
        persona_description_role: 0,
        request_token_probabilities: false,
        user_prompt_bias: '',
        ...powerUserOverrides,
    };

    const scriptMock = {
        abortStatusCheck: new AbortController(),
        addOneMessage: jest.fn(),
        cancelStatusCheck: jest.fn(),
        characters: [],
        chat: [],
        event_types: {
            CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
            CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
            OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
            OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
            GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
            ONLINE_STATUS_CHANGED: 'online_status_changed',
            SETTINGS_UPDATED: 'settings_updated',
            APP_READY: 'app_ready',
        },
        eventSource,
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
        Generate: jest.fn(),
        getCurrentChatId: jest.fn(() => 'test-chat-id'),
        getExtensionPrompt: jest.fn(() => ''),
        getExtensionPromptMaxDepth: jest.fn(() => 0),
        getGeneratingApi: jest.fn(() => 'openai'),
        getGeneratingModel: jest.fn(() => ''),
        getMediaDisplay: jest.fn(() => 0),
        getMediaIndex: jest.fn(() => 0),
        getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
        is_send_press: false,
        main_api: 'openai',
        name1: 'User',
        name2: 'Assistant',
        online_status: 'no_connection',
        refreshMessageModelIcons: jest.fn(),
        resultCheckStatus: jest.fn(),
        saveChatConditional: jest.fn(async () => {}),
        saveSettings: jest.fn(async () => true),
        saveSettingsDebounced: jest.fn(),
        setOnlineStatus: jest.fn(),
        startStatusLoading: jest.fn(),
        substituteParams: jest.fn(text => String(text ?? '')),
        substituteParamsExtended: jest.fn(text => String(text ?? '')),
        system_avatar: 'img/five.png',
        system_message_types: { NARRATOR: 'narrator' },
        systemUserName: 'System',
        this_chid: undefined,
        ...scriptOverrides,
    };

    const secretState = {};
    const secretsMock = {
        SECRET_KEYS: {
            OPENAI: 'api_key_openai',
            CLAUDE: 'api_key_claude',
            OPENROUTER: 'api_key_openrouter',
            MAKERSUITE: 'api_key_makersuite',
            VERTEXAI: 'api_key_vertexai',
            AI21: 'api_key_ai21',
            MISTRALAI: 'api_key_mistralai',
            CUSTOM: 'api_key_custom',
            COHERE: 'api_key_cohere',
            PERPLEXITY: 'api_key_perplexity',
            GROQ: 'api_key_groq',
            NANOGPT: 'api_key_nanogpt',
            DEEPSEEK: 'api_key_deepseek',
            AIMLAPI: 'api_key_aimlapi',
            XAI: 'api_key_xai',
            POLLINATIONS: 'api_key_pollinations',
            MOONSHOT: 'api_key_moonshot',
            FIREWORKS: 'api_key_fireworks',
            COMETAPI: 'api_key_cometapi',
            AZURE_OPENAI: 'api_key_azure_openai',
            ZAI: 'api_key_zai',
            SILICONFLOW: 'api_key_siliconflow',
            MINIMAX: 'api_key_minimax',
            CHUTES: 'api_key_chutes',
            ELECTRONHUB: 'api_key_electronhub',
            LINKAPI: 'api_key_linkapi',
            WORKERS_AI: 'api_key_workers_ai',
            KOBOLDCPP: 'api_key_koboldcpp',
        },
        secret_state: secretState,
        canViewSecrets: jest.fn(async () => false),
        writeSecret: jest.fn(async () => 'secret-id'),
        rotateSecret: jest.fn(async () => 'secret-id'),
        deleteSecret: jest.fn(async () => {}),
        findSecret: jest.fn(async () => null),
        renameSecret: jest.fn(async () => {}),
        readSecretState: jest.fn(async () => {}),
        getSecretLabelById: jest.fn(() => ''),
        resolveSecretKey: jest.fn(() => ''),
        updateSecretDisplay: jest.fn(),
        ...secretsOverrides,
    };

    const storageMap = new Map();
    const accountStorageMock = {
        getItem: jest.fn(key => storageMap.get(key) ?? null),
        setItem: jest.fn((key, value) => storageMap.set(key, String(value))),
        removeItem: jest.fn(key => storageMap.delete(key)),
        ...accountStorageOverrides,
    };

    class MockPopup {
        static show = {
            confirm: jest.fn(async () => true),
            text: jest.fn(async () => null),
            input: jest.fn(async () => null),
        };
        constructor() {}
        async show() { return null; }
    }

    const popupMock = {
        callGenericPopup: jest.fn(async () => null),
        Popup: MockPopup,
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 },
        ...popupOverrides,
    };

    const promptManagerMock = {
        chatCompletionDefaultPrompts: { prompts: [] },
        INJECTION_POSITION: { RELATIVE: 0, ABSOLUTE: 1 },
        Prompt: class Prompt {
            constructor(data = {}) { Object.assign(this, data); }
        },
        PromptManager: class PromptManager {
            init(configuration, settings) {
                this.configuration = configuration;
                this.serviceSettings = settings;
            }
            setChatCompletion() {}
            preparePrompt(prompt) { return prompt; }
            log() {}
            render() {}
            getPromptCollection() { return { collection: [] }; }
            getPromptOrderForCharacter() { return []; }
            getPromptById() { return null; }
            isPromptDisabledForActiveCharacter() { return false; }
        },
        promptManagerDefaultPromptOrders: [],
    };

    const fetchResumableMock = fetchResumableOverride ?? jest.fn();
    const renderTemplateAsyncMock = jest.fn(async () => '');
    const templatesMock = {
        renderTemplateAsync: renderTemplateAsyncMock,
        ...templatesOverrides,
    };
    const registeredCommands = new Map();
    const koboldCppMock = {
        getKoboldCppChatState: jest.fn(() => null),
        refreshKoboldCppModels: jest.fn(async () => {}),
        countKoboldCppChatTokens: jest.fn(async () => 0),
        isKoboldCppChatCompletion: jest.fn(() => false),
        ...koboldCppOverrides,
    };
    const toolManagerMock = {
        RECURSE_LIMIT: 5,
        canPerformToolCalls: jest.fn(() => false),
        getToolDefinitions: jest.fn(() => []),
        isToolCallingSupported: jest.fn(() => false),
        registerFunctionToolsOpenAI: jest.fn(async () => {}),
    };

    await jest.unstable_mockModule(pub('lib.js'), () => ({
        Fuse: class Fuse { search() { return []; } },
        DOMPurify: domPurify ?? { sanitize: value => value },
        Popper: { createPopper: jest.fn(() => ({ update: jest.fn(), destroy: jest.fn() })) },
        localforage: {
            getItem: async () => null,
            setItem: async () => {},
            createInstance: () => ({ getItem: async () => null, setItem: async () => {} }),
        },
        moment: () => ({ format: () => '' }),
        Readability: class Readability {},
        isProbablyReaderable: () => false,
        lodash: {},
    }));
    await jest.unstable_mockModule(pub('script.js'), () => scriptMock);
    await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
        getGroupNames: jest.fn(() => []),
        groups: [],
        is_group_generating: false,
        selected_group: null,
    }));
    if (mockPromptManager) {
        await jest.unstable_mockModule(pub('scripts/PromptManager.js'), () => promptManagerMock);
    }
    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
        collapseNewlines: jest.fn(value => value),
        forceCharacterEditorTokenize: jest.fn(),
        getCustomStoppingStrings: jest.fn(() => []),
        performFuzzySearch: jest.fn(() => []),
        persona_description_positions: { IN_PROMPT: 0, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 4, NONE: 9 },
        power_user: powerUser,
        registerDebugFunction: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/secrets.js'), () => secretsMock);
    await jest.unstable_mockModule(pub('scripts/sse-stream.js'), () => ({
        default: class EventSourceStream {},
        getEventSourceStream: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/resumable-generation.js'), () => ({
        fetchResumable: fetchResumableMock,
    }));
    if (mockUtils) {
        await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
            copyText: jest.fn(),
            createThumbnail: jest.fn(),
            debounce: fn => fn,
            delay: jest.fn(async () => {}),
            download: jest.fn(),
            ensureImageFormatSupported: jest.fn(async value => value),
            escapeHtml: value => String(value ?? ''),
            escapeRegex: value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            getAudioDurationFromDataURL: jest.fn(async () => 0),
            getBase64Async: jest.fn(async () => ''),
            getFileText: jest.fn(async () => ''),
            getFileExtension: jest.fn(() => ''),
            convertTextToBase64: jest.fn(v => Buffer.from(String(v ?? '')).toString('base64')),
            isSameFile: jest.fn(() => false),
            clamp: (v, min, max) => Math.min(Math.max(v, min), max),
            humanFileSize: jest.fn(n => `${n} B`),
            getImageSizeFromDataURL: jest.fn(async () => ({ width: 0, height: 0 })),
            getSortableDelay: jest.fn(() => 0),
            getStringHash: jest.fn(value => String(value ?? '')),
            getVideoDurationFromDataURL: jest.fn(async () => 0),
            isDataURL: jest.fn(() => false),
            isFalseBoolean: value => value === false || String(value).toLowerCase() === 'false',
            isTrueBoolean: value => value === true || String(value).toLowerCase() === 'true',
            isUuid: jest.fn(() => false),
            isValidUrl: value => {
                try {
                    new URL(value);
                    return true;
                } catch {
                    return false;
                }
            },
            localizePagination: jest.fn(),
            PAGINATION_TEMPLATE: '',
            parseJsonFile: jest.fn(async () => ({})),
            resetScrollHeight: jest.fn(),
            setDatasetProperty: jest.fn(),
            stringFormat: (str, ...args) => String(str).replace(/\{(\d+)\}/g, (_m, i) => args[i] ?? ''),
            stringToRange: jest.fn(() => []),
            textValueMatcher: jest.fn(() => true),
            trimSpaces: value => String(value ?? '').trim(),
            uuidv4: jest.fn(() => '00000000-0000-4000-8000-000000000000'),
            waitUntilCondition: jest.fn(async () => true),
        }));
    }
    if (mockTokenizers) {
        await jest.unstable_mockModule(pub('scripts/tokenizers.js'), () => ({
            countChatCompletionPayloadTokensOpenAIAsync: jest.fn(async () => 0),
            countTokensOpenAIAsync: jest.fn(async () => 0),
            getTokenizerModel: jest.fn(() => 'gpt-4o'),
            primeOpenAITokenCache: jest.fn(),
            tokenizers: {},
        }));
    }
    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({
        isMobile: jest.fn(() => false),
    }));
    await jest.unstable_mockModule(pub('scripts/logprobs.js'), () => ({
        saveLogprobsForActiveMessage: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser: {
            addCommandObject: jest.fn(command => {
                if (command?.name) registeredCommands.set(command.name, command);
            }),
        },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
        SlashCommand: { fromProps: jest.fn(props => props) },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => ({
        ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list', DICTIONARY: 'dictionary' },
        SlashCommandArgument: { fromProps: jest.fn(props => props) },
        SlashCommandNamedArgument: { fromProps: jest.fn(props => props) },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandClosure.js'), () => ({
        SlashCommandClosure: class SlashCommandClosure {},
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        commonEnumProviders: {},
        enumIcons: {},
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        enumTypes: {},
        SlashCommandEnumValue: class SlashCommandEnumValue {},
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandReturnHelper.js'), () => ({
        slashCommandReturnHelper: { doReturn: jest.fn() },
    }));
    await jest.unstable_mockModule(pub('scripts/templates.js'), () => templatesMock);
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => popupMock);
    await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({
        confirmVerb: jest.fn(() => ({})),
    }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        getCurrentLocale: () => 'en',
        t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
        translate: value => value,
    }));
    if (mockToolCalling) {
        await jest.unstable_mockModule(pub('scripts/tool-calling.js'), () => ({
            ToolManager: toolManagerMock,
        }));
    }
    await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({
        accountStorage: accountStorageMock,
    }));
    if (mockTextgenModels) {
        await jest.unstable_mockModule(pub('scripts/textgen-models.js'), () => ({
            getCurrentDreamGenModelTokenizer: jest.fn(() => null),
            getCurrentOpenRouterModelTokenizer: jest.fn(() => null),
            openRouterModels: [],
            setOpenRouterProviders: jest.fn(),
            syncNanoGptProvidersForModel: jest.fn(),
            syncOpenRouterProvidersForModel: jest.fn(),
            updateNanoGptProvidersWarning: jest.fn(),
            updateOpenRouterProvidersWarning: jest.fn(),
        }));
    }
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/window-content-dialogs.js'), () => ({
        accountProfileOptions: jest.fn(() => ({})),
        snapshotsOptions: jest.fn(() => ({})),
        adminPanelOptions: jest.fn(() => ({})),
        scenarioOverrideOptions: jest.fn(() => ({})),
        customEndpointParametersOptions: jest.fn(() => ({})),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-connection-notices.js'), () => ({
        flagMissingKey: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-koboldcpp-models.js'), () => ({
        initKoboldCppModels: jest.fn(),
        ...koboldCppMock,
    }));
    const requestErrorsMock = {
        createFailedResponseError: jest.fn(async () => new Error('Request failed')),
        showRequestError: jest.fn(),
        getFailureStatus: jest.fn(() => 500),
    };
    await jest.unstable_mockModule(pub('scripts/sillybunny-request-errors.js'), () => requestErrorsMock);
    if (mockModelDetails) {
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/option-details.js'), () => ({
            registerOptionDetails: jest.fn(),
            hasOptionDetails: jest.fn(() => false),
            toDetails: jest.fn(v => v),
            detailsToText: jest.fn(() => ''),
            renderDetails: jest.fn(() => document.createElement('div')),
            icon: jest.fn(),
            link: jest.fn(),
            badge: jest.fn(),
            createDetailsMapper: jest.fn(() => jest.fn()),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-model-details.js'), () => ({
            describeAimlapiModel: jest.fn(),
            describeChutesModel: jest.fn(),
            describeElectronHubModel: jest.fn(),
            describeHordeModel: jest.fn(),
            describeMancerModel: jest.fn(),
            describeOpenRouterModel: jest.fn(),
            describeTogetherModel: jest.fn(),
            plainText: value => String(value ?? ''),
        }));
    }

    const openai = await import('../../public/scripts/openai.js');
    return {
        openai,
        mocks: {
            script: scriptMock,
            powerUser,
            secrets: secretsMock,
            accountStorage: accountStorageMock,
            popup: popupMock,
            eventSource,
            fetchResumable: fetchResumableMock,
            renderTemplateAsync: renderTemplateAsyncMock,
            registeredCommands,
            koboldCpp: koboldCppMock,
            toolManager: toolManagerMock,
            requestErrors: requestErrorsMock,
        },
    };
}
