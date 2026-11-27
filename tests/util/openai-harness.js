/* global globalThis */
import { jest } from '@jest/globals';
import { fileURLToPath } from 'node:url';

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
        val: () => '',
        prop: () => false,
        attr: () => chain,
        removeAttr: () => chain,
        text: () => chain,
        html: () => chain,
        empty: () => chain,
        append: () => chain,
        find: () => chain,
        filter: () => chain,
        addClass: () => chain,
        removeClass: () => chain,
        toggleClass: () => chain,
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
 * @param {object} [options.script] Extra overrides merged into the `public/script.js` mock.
 * @param {object} [options.powerUser] Initial `power_user` object.
 * @param {object} [options.secrets] Extra overrides merged into the `public/scripts/secrets.js` mock.
 * @param {object} [options.accountStorage] Extra overrides for `accountStorage`.
 * @returns {Promise<{ openai: typeof import('../../public/scripts/openai.js'), mocks: Record<string, any> }>}
 */
export async function importOpenAiModule({
    mockToolCalling = true,
    script: scriptOverrides = {},
    powerUser: powerUserOverrides = {},
    secrets: secretsOverrides = {},
    accountStorage: accountStorageOverrides = {},
} = {}) {
    if (typeof globalThis.$ !== 'function') {
        const jq = createNoopJQuery();
        globalThis.$ = jq;
        globalThis.jQuery = jq;
    }
    if (!globalThis.toastr) {
        globalThis.toastr = {
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
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
        ...powerUserOverrides,
    };

    const scriptMock = {
        abortStatusCheck: jest.fn(),
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
        refreshMessageModelIcons: jest.fn(),
        resultCheckStatus: jest.fn(),
        saveChatConditional: jest.fn(async () => {}),
        saveSettings: jest.fn(async () => {}),
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
        writeSecret: jest.fn(async () => 'secret-id'),
        rotateSecret: jest.fn(async () => 'secret-id'),
        ...secretsOverrides,
    };

    const storageMap = new Map();
    const accountStorageMock = {
        getItem: jest.fn(key => storageMap.get(key) ?? null),
        setItem: jest.fn((key, value) => storageMap.set(key, String(value))),
        removeItem: jest.fn(key => storageMap.delete(key)),
        ...accountStorageOverrides,
    };

    const popupMock = {
        callGenericPopup: jest.fn(async () => null),
        Popup: class Popup {
            constructor() {}
            async show() { return null; }
        },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 },
    };

    const promptManagerMock = {
        chatCompletionDefaultPrompts: { prompts: [] },
        INJECTION_POSITION: { RELATIVE: 0, ABSOLUTE: 1 },
        Prompt: class Prompt {
            constructor(data = {}) { Object.assign(this, data); }
        },
        PromptManager: class PromptManager {
            init() {}
            getPromptCollection() { return { collection: [] }; }
            getPromptOrderForCharacter() { return []; }
            getPromptById() { return null; }
            isPromptDisabledForActiveCharacter() { return false; }
        },
        promptManagerDefaultPromptOrders: [],
    };

    await jest.unstable_mockModule(pub('lib.js'), () => ({
        Fuse: class Fuse { search() { return []; } },
        DOMPurify: { sanitize: value => value },
    }));
    await jest.unstable_mockModule(pub('script.js'), () => scriptMock);
    await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
        getGroupNames: jest.fn(() => []),
        selected_group: null,
    }));
    await jest.unstable_mockModule(pub('scripts/PromptManager.js'), () => promptManagerMock);
    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
        forceCharacterEditorTokenize: jest.fn(),
        getCustomStoppingStrings: jest.fn(() => []),
        persona_description_positions: { IN_PROMPT: 0, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 4, NONE: 9 },
        power_user: powerUser,
    }));
    await jest.unstable_mockModule(pub('scripts/secrets.js'), () => secretsMock);
    await jest.unstable_mockModule(pub('scripts/sse-stream.js'), () => ({
        getEventSourceStream: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/resumable-generation.js'), () => ({
        fetchResumable: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
        createThumbnail: jest.fn(),
        delay: jest.fn(async () => {}),
        download: jest.fn(),
        escapeHtml: value => String(value ?? ''),
        getAudioDurationFromDataURL: jest.fn(async () => 0),
        getBase64Async: jest.fn(async () => ''),
        getFileText: jest.fn(async () => ''),
        getImageSizeFromDataURL: jest.fn(async () => ({ width: 0, height: 0 })),
        getSortableDelay: jest.fn(() => 0),
        getStringHash: jest.fn(() => 0),
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
        parseJsonFile: jest.fn(async () => ({})),
        resetScrollHeight: jest.fn(),
        stringFormat: (str, ...args) => String(str).replace(/\{(\d+)\}/g, (_m, i) => args[i] ?? ''),
        textValueMatcher: jest.fn(() => true),
        uuidv4: jest.fn(() => '00000000-0000-4000-8000-000000000000'),
    }));
    await jest.unstable_mockModule(pub('scripts/tokenizers.js'), () => ({
        countChatCompletionPayloadTokensOpenAIAsync: jest.fn(async () => 0),
        countTokensOpenAIAsync: jest.fn(async () => 0),
        getTokenizerModel: jest.fn(() => 'gpt-4o'),
        primeOpenAITokenCache: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({
        isMobile: jest.fn(() => false),
    }));
    await jest.unstable_mockModule(pub('scripts/logprobs.js'), () => ({
        saveLogprobsForActiveMessage: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser: { addCommandObject: jest.fn() },
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
        enumIcons: {},
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        enumTypes: {},
        SlashCommandEnumValue: class SlashCommandEnumValue {},
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandReturnHelper.js'), () => ({
        slashCommandReturnHelper: { doReturn: jest.fn() },
    }));
    await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({
        renderTemplateAsync: jest.fn(async () => ''),
    }));
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => popupMock);
    await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({
        confirmVerb: jest.fn(() => ({})),
    }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
    }));
    if (mockToolCalling) {
        await jest.unstable_mockModule(pub('scripts/tool-calling.js'), () => ({
            ToolManager: {
                canPerformToolCalls: jest.fn(() => false),
                getToolDefinitions: jest.fn(() => []),
                isToolCallingSupported: jest.fn(() => false),
            },
        }));
    }
    await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({
        accountStorage: accountStorageMock,
    }));
    await jest.unstable_mockModule(pub('scripts/textgen-models.js'), () => ({
        setOpenRouterProviders: jest.fn(),
        syncNanoGptProvidersForModel: jest.fn(),
        syncOpenRouterProvidersForModel: jest.fn(),
        updateNanoGptProvidersWarning: jest.fn(),
        updateOpenRouterProvidersWarning: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/window-content-dialogs.js'), () => ({
        customEndpointParametersOptions: jest.fn(() => ({})),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-connection-notices.js'), () => ({
        flagMissingKey: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-koboldcpp-models.js'), () => ({
        getKoboldCppChatState: jest.fn(() => ({})),
        refreshKoboldCppModels: jest.fn(async () => {}),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-request-errors.js'), () => ({
        createFailedResponseError: jest.fn(async () => new Error('Request failed')),
        showRequestError: jest.fn(),
        getFailureStatus: jest.fn(() => 500),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/option-details.js'), () => ({
        registerOptionDetails: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-model-details.js'), () => ({
        describeAimlapiModel: jest.fn(),
        describeChutesModel: jest.fn(),
        describeElectronHubModel: jest.fn(),
        describeOpenRouterModel: jest.fn(),
    }));

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
        },
    };
}
