/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { importOpenAiModule } from './util/openai-harness.js';

const resolvePublic = (relativePath) => fileURLToPath(new URL(`../public/${relativePath}`, import.meta.url));

const originalLocalStorage = globalThis.localStorage;
const originalDocument = globalThis.document;
const originalToastr = globalThis.toastr;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null };
globalThis.toastr = { options: { timeOut: 5000, extendedTimeOut: 5000 } };

// Import real chat_completion_sources and textgen_types so CONNECT_API_MAP exercises both live registries.
const { openai } = await importOpenAiModule();
const chatCompletionSources = openai.chat_completion_sources;
jest.resetModules();

const registeredCommands = new Map();
const noop = () => {};
const noopAsync = async () => {};

await jest.unstable_mockModule(resolvePublic('lib.js'), () => ({
    Fuse: class {},
    DOMPurify: { sanitize: value => value },
}));
await jest.unstable_mockModule(resolvePublic('script.js'), () => ({
    Generate: noopAsync,
    activateSendButtons: noop,
    addOneMessage: noop,
    characters: [],
    chat: [],
    chatElement: null,
    chat_metadata: {},
    comment_avatar: '',
    deactivateSendButtons: noop,
    default_avatar: '',
    deleteCharacter: noopAsync,
    deleteSwipe: noopAsync,
    displayPastChats: noopAsync,
    duplicateCharacter: noopAsync,
    eventSource: { on: noop, emit: noopAsync },
    event_types: { CHAT_CHANGED: 'chat_changed', TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready' },
    extension_prompt_roles: {},
    extension_prompt_types: {},
    extractMessageBias: noop,
    generateQuietPrompt: noopAsync,
    generateRaw: noopAsync,
    autoLabelCurrentChat: noopAsync,
    getCharacters: noopAsync,
    getCurrentChatDetails: () => ({}),
    getCurrentChatId: () => '',
    getFirstDisplayedMessageId: () => 0,
    getOneCharacter: noopAsync,
    getRequestHeaders: () => ({}),
    getStoppingStrings: () => [],
    getThumbnailUrl: () => '',
    refreshCharacterAvatar: noop,
    is_send_press: false,
    main_api: 'openai',
    max_context: 4096,
    name1: 'User',
    name2: 'Char',
    neutralCharacterName: '',
    newAssistantChat: noopAsync,
    flushPendingChatSavesForNavigation: noopAsync,
    online_status: 'Valid',
    reloadCurrentChat: noopAsync,
    refreshSwipeButtons: noop,
    removeMacros: text => text,
    renameCharacter: noopAsync,
    renameChat: noopAsync,
    resultCheckStatus: noop,
    saveChatConditional: noopAsync,
    saveSettings: noopAsync,
    saveSettingsDebounced: noop,
    selectCharacterById: noopAsync,
    select_selected_character: noopAsync,
    sendMessageAsUser: noopAsync,
    sendSystemMessage: noopAsync,
    setActiveCharacter: noop,
    setActiveGroup: noop,
    setCharacterId: noop,
    setCharacterName: noop,
    setExtensionPrompt: noop,
    setGenerationParamsFromPreset: noop,
    setOnlineStatus: noop,
    showMoreMessages: noop,
    showNewerMessages: noop,
    startStatusLoading: noop,
    swipe: noopAsync,
    stopGeneration: noop,
    substituteParams: text => text,
    system_avatar: '',
    system_message_types: {},
    this_chid: 0,
    updateMessageElement: noop,
    updateSwipeCounter: noop,
    abortStatusCheck: new AbortController(),
}));
await jest.unstable_mockModule(resolvePublic('scripts/chat-templates.js'), () => ({ deriveTemplatesFromChatTemplate: () => null }));
await jest.unstable_mockModule(resolvePublic('scripts/i18n.js'), () => ({ t: (strings, ...values) => String.raw({ raw: strings }, ...values) }));
await jest.unstable_mockModule(resolvePublic('scripts/instruct-mode.js'), () => ({
    instruct_presets: [],
    autoSelectInstructPreset: () => false,
    selectContextPreset: noop,
    selectInstructPreset: noop,
}));
await jest.unstable_mockModule(resolvePublic('scripts/logit-bias.js'), () => ({
    BIAS_CACHE: new Map(),
    createNewLogitBiasEntry: () => ({}),
    displayLogitBias: noop,
    getLogitBiasListResult: () => [],
}));
await jest.unstable_mockModule(resolvePublic('scripts/power-user.js'), () => ({
    addEphemeralStoppingString: noop,
    chat_styles: {},
    context_presets: [],
    flushEphemeralStoppingStrings: noop,
    playMessageSound: noop,
    power_user: { instruct: { enabled: false }, stscript: { autocomplete: { state: 0 } } },
    registerDebugFunction: noop,
}));
await jest.unstable_mockModule(resolvePublic('scripts/samplerSelect.js'), () => ({
    getActiveManualApiSamplers: () => [],
    getApiSamplerVisibilityState: () => ({}),
    isSamplerManualPriorityEnabled: () => false,
    loadApiSelectedSamplers: noop,
    saveApiSelectedSamplers: noop,
    setApiSamplerVisibilityState: noop,
}));
await jest.unstable_mockModule(resolvePublic('scripts/secrets.js'), () => ({ SECRET_KEYS: {}, writeSecret: noopAsync }));
await jest.unstable_mockModule(resolvePublic('scripts/sse-stream.js'), () => ({ getEventSourceStream: () => null }));
await jest.unstable_mockModule(resolvePublic('scripts/resumable-generation.js'), () => ({ fetchResumable: noopAsync }));
await jest.unstable_mockModule(resolvePublic('scripts/local-url-utils.js'), () => ({ getLocalPromptCacheValue: () => false, isLikelyLocalServerUrl: () => true }));
await jest.unstable_mockModule(resolvePublic('scripts/sampling-parameter-policy.js'), () => ({
    POLICY_SCHEMA_VERSION: 1,
    applySamplingParameterPolicy: payload => payload,
    createSamplingRequestContext: () => ({}),
    createSamplingTargetKey: () => '',
    getTargetSamplingPolicy: () => ({}),
    normalizeTransmissionState: state => state,
    parseLegacySamplingExclusions: () => ({}),
    resolveEffectiveParameterDecision: () => ({}),
    setTargetParameterState: noop,
}));
await jest.unstable_mockModule(resolvePublic('scripts/textgen-models.js'), () => ({
    getCurrentDreamGenModelTokenizer: () => '',
    getCurrentOpenRouterModelTokenizer: () => '',
    loadAphroditeModels: noop,
    loadDreamGenModels: noop,
    loadFeatherlessModels: noop,
    loadGenericModels: noop,
    loadInfermaticAIModels: noop,
    loadLlamaCppModels: noop,
    loadMancerModels: noop,
    loadOllamaModels: noop,
    loadOpenRouterModels: noop,
    loadTabbyModels: noop,
    loadTogetherAIModels: noop,
    loadVllmModels: noop,
    setOpenRouterProviders: noop,
    updateOpenRouterProvidersWarning: noop,
}));
await jest.unstable_mockModule(resolvePublic('scripts/sillybunny-koboldcpp-models.js'), () => ({ refreshKoboldCppModels: noopAsync }));
await jest.unstable_mockModule(resolvePublic('scripts/tokenizers.js'), () => ({
    ENCODE_TOKENIZERS: [],
    TEXTGEN_TOKENIZERS: [],
    TOKENIZER_SUPPORTED_KEY: 'tokenization',
    decodeTextTokens: () => '',
    getAvailableTokenizers: () => [],
    getFriendlyTokenizerName: () => '',
    getTextTokens: () => [],
    getTokenCountAsync: noopAsync,
    getTokenizerBestMatch: () => null,
    selectTokenizer: noop,
    tokenizers: {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/util/AbortReason.js'), () => ({ AbortReason: class AbortReason extends Error {} }));
await jest.unstable_mockModule(resolvePublic('scripts/sillybunny-request-errors.js'), () => ({
    createFailedResponseError: () => new Error('failed'),
    extractProviderMessage: () => '',
    showRequestError: noop,
    getFailureStatus: () => 500,
}));
await jest.unstable_mockModule(resolvePublic('scripts/utils.js'), () => ({
    arraysEqual: () => true,
    canUseNegativeLookbehind: () => true,
    copyText: noopAsync,
    debounce: fn => fn,
    delay: noopAsync,
    equalsIgnoreCaseAndAccents: (a, b) => a === b,
    findChar: () => null,
    findPersona: () => null,
    flashHighlight: noop,
    getCharIndex: () => -1,
    getSortableDelay: () => 0,
    isFalseBoolean: () => false,
    isObject: value => value !== null && typeof value === 'object',
    isTrueBoolean: () => true,
    onlyUnique: () => true,
    regexFromString: () => null,
    resolveAvatarData: noopAsync,
    showFontAwesomePicker: noopAsync,
    stringToRange: () => null,
    trimToEndSentence: text => text,
    trimToStartSentence: text => text,
    waitUntilCondition: noopAsync,
}));
await jest.unstable_mockModule(resolvePublic('scripts/openai.js'), () => ({
    chat_completion_sources: chatCompletionSources,
    MINIMAX_ENDPOINT: '',
    oai_settings: { chat_completion_source: chatCompletionSources.KOBOLDCPP },
    POLLINATIONS_ENDPOINT: '',
    promptManager: null,
    SILICONFLOW_ENDPOINT: '',
    ZAI_ENDPOINT: '',
}));
await jest.unstable_mockModule(resolvePublic('scripts/RossAscends-mods.js'), () => ({ getMessageTimeStamp: () => '', isMobile: () => false }));
await jest.unstable_mockModule(resolvePublic('scripts/chats.js'), () => ({ hideChatMessageRange: noopAsync }));
await jest.unstable_mockModule(resolvePublic('scripts/extensions.js'), () => ({ getContext: () => ({}), saveMetadataDebounced: noop }));
await jest.unstable_mockModule(resolvePublic('scripts/extensions/regex/engine.js'), () => ({ getRegexedString: text => text, regex_placement: {} }));
await jest.unstable_mockModule(resolvePublic('scripts/group-chats.js'), () => ({
    findGroupMemberId: () => null,
    groups: [],
    is_group_generating: false,
    openGroupById: noopAsync,
    regenerateGroup: noopAsync,
    resetSelectedGroup: noop,
    saveGroupChat: noopAsync,
    selected_group: null,
    getGroupMembers: () => [],
    runGroupMemberActionByChid: noopAsync,
}));
await jest.unstable_mockModule(resolvePublic('scripts/personas.js'), () => ({ user_avatar: '' }));
await jest.unstable_mockModule(resolvePublic('scripts/variables.js'), () => ({ registerVariableCommands: noop, resolveVariable: () => '' }));
await jest.unstable_mockModule(resolvePublic('scripts/action-loader-slashcommands.js'), () => ({ registerActionLoaderSlashCommands: noop }));
await jest.unstable_mockModule(resolvePublic('scripts/backgrounds.js'), () => ({ background_settings: {}, getBackgroundTargets: () => [] }));
await jest.unstable_mockModule(resolvePublic('scripts/popup.js'), () => ({ POPUP_RESULT: {}, POPUP_TYPE: {}, Popup: class {}, callGenericPopup: noopAsync }));
await jest.unstable_mockModule(resolvePublic('scripts/sillybunny-delete-confirm.js'), () => ({ confirmVerb: () => 'Delete' }));
await jest.unstable_mockModule(resolvePublic('scripts/sillybunny-editor/rows.js'), () => ({ createButtonRow: () => ({}) }));
await jest.unstable_mockModule(resolvePublic('scripts/util/AccountStorage.js'), () => ({ accountStorage: { getItem: () => null, setItem: noop, removeItem: noop } }));
await jest.unstable_mockModule(resolvePublic('scripts/kai-settings.js'), () => ({ kai_settings: {} }));
await jest.unstable_mockModule(resolvePublic('scripts/constants.js'), () => ({ debounce_timeout: { quick: 0, normal: 0, relaxed: 0 }, SWIPE_DIRECTION: {}, SWIPE_SOURCE: {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandParser.js'), () => ({
    SlashCommandParser: class {
        static commands = {};
        static addCommand = noop;
        static addCommandObject(cmd) {
            if (cmd?.name) {
                registeredCommands.set(cmd.name, cmd);
                this.commands[cmd.name] = cmd;
            }
        }
        getHelpString() { return ''; }
    },
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandParserError.js'), () => ({ SlashCommandParserError: class extends Error {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandClosure.js'), () => ({ SlashCommandClosure: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandClosureResult.js'), () => ({ SlashCommandClosureResult: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandArgument.js'), () => ({
    ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list', DICTIONARY: 'dictionary', CLOSURE: 'closure', RANGE: 'range', SUBCOMMAND: 'subcommand', VARIABLE_NAME: 'variable_name' },
    SlashCommandArgument: class {
        static fromProps(props) { return props; }
    },
    SlashCommandNamedArgument: class {
        static fromProps(props) { return props; }
    },
}));
await jest.unstable_mockModule(resolvePublic('scripts/autocomplete/AutoComplete.js'), () => ({ AutoComplete: class {}, AUTOCOMPLETE_STATE: {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommand.js'), () => ({ SlashCommand: { fromProps: props => props } }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandAbortController.js'), () => ({ SlashCommandAbortController: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandNamedArgumentAssignment.js'), () => ({ SlashCommandNamedArgumentAssignment: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
    SlashCommandEnumValue: class {},
    enumTypes: { getBasedOnIndex: () => 'enum' },
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
    commonEnumProviders: new Proxy({}, {
        get: (_target, prop) => (prop === 'boolean' ? () => () => [] : () => []),
    }),
    enumIcons: {},
    commonEnumMatchProviders: new Proxy({}, { get: () => () => [] }),
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandBreakController.js'), () => ({ SlashCommandBreakController: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandExecutionError.js'), () => ({ SlashCommandExecutionError: class extends Error {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandReturnHelper.js'), () => ({
    slashCommandReturnHelper: new Proxy({}, { get: () => () => [] }),
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandDebugController.js'), () => ({ SlashCommandDebugController: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandScope.js'), () => ({ SlashCommandScope: class {} }));

const { CONNECT_API_MAP, initDefaultSlashCommands } = await import('../public/scripts/slash-commands.js');
initDefaultSlashCommands();

if (originalLocalStorage === undefined) delete globalThis.localStorage;
else globalThis.localStorage = originalLocalStorage;
if (originalDocument === undefined) delete globalThis.document;
else globalThis.document = originalDocument;
if (originalToastr === undefined) delete globalThis.toastr;
else globalThis.toastr = originalToastr;

describe('KoboldCpp API names', () => {
    test.each(['koboldcpp', 'kcpp'])('/api %s keeps selecting the KoboldCpp Text Completion API', (name) => {
        expect(CONNECT_API_MAP[name]).toMatchObject({ selected: 'textgenerationwebui', type: 'koboldcpp' });
    });

    test.each(['koboldcpp-chat', 'kcpp-chat'])('/api %s selects the KoboldCpp Chat Completion source', (name) => {
        expect(CONNECT_API_MAP[name]).toEqual({ selected: 'openai', button: '#api_button_openai', source: 'koboldcpp' });
    });

    test('/api reports koboldcpp-chat, the first name for the KoboldCpp Chat Completion source', async () => {
        const apiCommand = registeredCommands.get('api');
        expect(apiCommand).toBeDefined();
        await expect(apiCommand.callback({}, '')).resolves.toBe('koboldcpp-chat');
    });
});
