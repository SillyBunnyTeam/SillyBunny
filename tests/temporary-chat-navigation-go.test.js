/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

const pub = relative => fileURLToPath(new URL(`../public/${relative}`, import.meta.url));
const OriginalDollar = globalThis.$;
const OriginalToastr = globalThis.toastr;

afterEach(() => {
    globalThis.$ = OriginalDollar;
    globalThis.toastr = OriginalToastr;
    jest.restoreAllMocks();
});

async function loadGoCommand({ flushResult = true } = {}) {
    jest.resetModules();
    globalThis.toastr = { options: { timeOut: 5000, extendedTimeOut: 1000 }, info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };
    globalThis.$ = jest.fn(() => ({
        on: jest.fn().mockReturnThis(),
        off: jest.fn().mockReturnThis(),
        val: jest.fn(() => ''),
        data: jest.fn(),
    }));

    const log = [];
    const characters = [
        { name: 'Bunny', avatar: 'bunny.png', chat: 'bunny-chat' },
        { name: 'Seraphina', avatar: 'seraphina.png', chat: 'seraphina-chat' },
    ];
    const registeredCommands = new Map();

    const flushPendingChatSavesForNavigation = jest.fn(async () => {
        log.push('flush');
        return flushResult;
    });
    const resetSelectedGroup = jest.fn(() => log.push('resetSelectedGroup'));
    const setCharacterId = jest.fn(id => log.push(`setCharacterId ${id}`));
    const setActiveCharacter = jest.fn();
    const setActiveGroup = jest.fn();
    const reloadCurrentChat = jest.fn(async () => log.push('reload'));

    const emptyFn = () => {};
    const noopProxy = new Proxy({}, { get: () => jest.fn(() => jest.fn(() => [])) });
    const stringProxy = new Proxy({}, { get: () => '' });

    await jest.unstable_mockModule(pub('lib.js'), () => ({
        Fuse: class {},
        DOMPurify: { sanitize: v => String(v ?? '') },
    }));
    await jest.unstable_mockModule(pub('script.js'), () => ({
        Generate: jest.fn(),
        activateSendButtons: jest.fn(),
        addOneMessage: jest.fn(),
        characters,
        chat: [],
        chatElement: null,
        chat_metadata: {},
        comment_avatar: '',
        deactivateSendButtons: jest.fn(),
        default_avatar: '',
        deleteCharacter: jest.fn(),
        deleteSwipe: jest.fn(),
        displayPastChats: jest.fn(),
        duplicateCharacter: jest.fn(),
        eventSource: { on: jest.fn(), emit: jest.fn() },
        event_types: {},
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2, BEFORE_PROMPT: 3 },
        extractMessageBias: jest.fn(),
        generateQuietPrompt: jest.fn(),
        generateRaw: jest.fn(),
        autoLabelCurrentChat: jest.fn(),
        getCharacters: jest.fn(),
        getCurrentChatDetails: jest.fn(),
        getCurrentChatId: jest.fn(),
        getFirstDisplayedMessageId: jest.fn(),
        getOneCharacter: jest.fn(),
        getRequestHeaders: jest.fn(() => ({})),
        getThumbnailUrl: jest.fn(),
        refreshCharacterAvatar: jest.fn(),
        is_send_press: false,
        main_api: 'openai',
        name1: 'User',
        name2: 'Bunny',
        neutralCharacterName: '',
        newAssistantChat: jest.fn(),
        flushPendingChatSavesForNavigation,
        online_status: 'connected',
        reloadCurrentChat,
        refreshSwipeButtons: jest.fn(),
        removeMacros: v => v,
        renameCharacter: jest.fn(),
        renameChat: jest.fn(),
        saveChatConditional: jest.fn(),
        saveSettings: jest.fn(),
        saveSettingsDebounced: jest.fn(),
        selectCharacterById: jest.fn(),
        select_selected_character: jest.fn(),
        sendMessageAsUser: jest.fn(),
        sendSystemMessage: jest.fn(),
        setActiveCharacter,
        setActiveGroup,
        setCharacterId,
        setCharacterName: jest.fn(),
        setExtensionPrompt: jest.fn(),
        showMoreMessages: jest.fn(),
        showNewerMessages: jest.fn(),
        swipe: {},
        stopGeneration: jest.fn(),
        substituteParams: v => v,
        system_avatar: '',
        system_message_types: {},
        this_chid: 0,
        updateMessageElement: jest.fn(),
        updateSwipeCounter: jest.fn(),
    }));

    class MockSlashCommandParser {
        static commands = {};
        static addCommand() {}
        static addCommandObject(cmd) {
            if (cmd?.name) {
                registeredCommands.set(cmd.name, cmd);
                MockSlashCommandParser.commands[cmd.name] = cmd;
            }
        }
        getHelpString() {
            return '';
        }
    }
    class MockArg {
        static fromProps(props) { return props; }
    }

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser: MockSlashCommandParser,
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParserError.js'), () => ({
        SlashCommandParserError: class extends Error {},
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
        SlashCommand: { fromProps: props => props },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => ({
        ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list', DICTIONARY: 'dictionary', CLOSURE: 'closure', RANGE: 'range', SUBCOMMAND: 'subcommand', VARIABLE_NAME: 'variable_name' },
        SlashCommandArgument: MockArg,
        SlashCommandNamedArgument: MockArg,
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandClosure.js'), () => ({ SlashCommandClosure: class {} }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandClosureResult.js'), () => ({ SlashCommandClosureResult: class {} }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandAbortController.js'), () => ({ SlashCommandAbortController: class {} }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandNamedArgumentAssignment.js'), () => ({ SlashCommandNamedArgumentAssignment: class {} }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        SlashCommandEnumValue: class {},
        enumTypes: {
            enum: 'enum', name: 'name', command: 'command', variable: 'variable', macro: 'macro', qr: 'qr', number: 'number',
            getBasedOnIndex: () => 'enum',
        },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        commonEnumProviders: noopProxy,
        enumIcons: stringProxy,
        commonEnumMatchProviders: noopProxy,
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandBreakController.js'), () => ({ SlashCommandBreakController: class {} }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandExecutionError.js'), () => ({ SlashCommandExecutionError: class extends Error {} }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandReturnHelper.js'), () => ({
        slashCommandReturnHelper: new Proxy({}, { get: () => jest.fn(() => []) }),
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandDebugController.js'), () => ({ SlashCommandDebugController: class {} }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandScope.js'), () => ({ SlashCommandScope: class {} }));

    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({ getMessageTimeStamp: jest.fn(), isMobile: jest.fn(() => false) }));
    await jest.unstable_mockModule(pub('scripts/chats.js'), () => ({ hideChatMessageRange: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({ getContext: jest.fn(() => ({})), saveMetadataDebounced: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/extensions/regex/engine.js'), () => ({ getRegexedString: v => v, regex_placement: {} }));
    await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
        findGroupMemberId: jest.fn(),
        groups: [],
        is_group_generating: false,
        openGroupById: jest.fn(),
        regenerateGroup: jest.fn(),
        resetSelectedGroup,
        saveGroupChat: jest.fn(),
        selected_group: null,
        getGroupMembers: jest.fn(() => []),
        runGroupMemberActionByChid: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({
        chat_completion_sources: {},
        MINIMAX_ENDPOINT: {},
        oai_settings: {},
        POLLINATIONS_ENDPOINT: {},
        promptManager: {},
        SILICONFLOW_ENDPOINT: {},
        ZAI_ENDPOINT: {},
    }));
    await jest.unstable_mockModule(pub('scripts/personas.js'), () => ({ user_avatar: '' }));
    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
        addEphemeralStoppingString: jest.fn(),
        chat_styles: {},
        context_presets: [],
        flushEphemeralStoppingStrings: jest.fn(),
        playMessageSound: jest.fn(),
        power_user: {},
    }));
    await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({
        SERVER_INPUTS: {},
        textgen_types: {},
        textgenerationwebui_settings: {},
    }));
    await jest.unstable_mockModule(pub('scripts/tokenizers.js'), () => ({
        decodeTextTokens: jest.fn(),
        getAvailableTokenizers: jest.fn(() => []),
        getFriendlyTokenizerName: jest.fn(),
        getTextTokens: jest.fn(() => []),
        getTokenCountAsync: jest.fn(async () => 0),
        selectTokenizer: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
        canUseNegativeLookbehind: () => true,
        copyText: jest.fn(),
        findPersona: jest.fn(),
        flashHighlight: jest.fn(),
        resolveAvatarData: jest.fn(),
        debounce: fn => fn,
        delay: jest.fn(async () => {}),
        equalsIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase(),
        findChar: ({ name }) => characters.find(character => character.name === name),
        getCharIndex: character => characters.indexOf(character),
        isFalseBoolean: () => false,
        isTrueBoolean: v => v === true || v === 'true',
        onlyUnique: (v, i, a) => a.indexOf(v) === i,
        regexFromString: jest.fn(),
        showFontAwesomePicker: jest.fn(),
        stringToRange: jest.fn(),
        trimToEndSentence: v => v,
        trimToStartSentence: v => v,
        waitUntilCondition: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/variables.js'), () => ({ registerVariableCommands: emptyFn, resolveVariable: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/action-loader-slashcommands.js'), () => ({ registerActionLoaderSlashCommands: emptyFn }));
    await jest.unstable_mockModule(pub('scripts/backgrounds.js'), () => ({ background_settings: {}, getBackgroundTargets: jest.fn(() => []) }));
    await jest.unstable_mockModule(pub('scripts/autocomplete/AutoComplete.js'), () => ({ AutoComplete: class {}, AUTOCOMPLETE_STATE: {} }));
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({ POPUP_RESULT: {}, POPUP_TYPE: {}, Popup: class {}, callGenericPopup: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({ confirmVerb: jest.fn(() => ({})) }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/rows.js'), () => ({ createButtonRow: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({ accountStorage: { getItem: jest.fn(), setItem: jest.fn() } }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
    }));
    await jest.unstable_mockModule(pub('scripts/kai-settings.js'), () => ({ kai_settings: {} }));
    await jest.unstable_mockModule(pub('scripts/instruct-mode.js'), () => ({ instruct_presets: [], selectContextPreset: jest.fn(), selectInstructPreset: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/constants.js'), () => ({ debounce_timeout: { short: 1 }, SWIPE_DIRECTION: {}, SWIPE_SOURCE: {} }));

    const slashCommands = await import('../public/scripts/slash-commands.js');
    slashCommands.initDefaultSlashCommands();

    const goCommand = registeredCommands.get('go');
    expect(goCommand).toBeTruthy();

    return {
        goCallback: goCommand.callback,
        log,
        flushPendingChatSavesForNavigation,
        resetSelectedGroup,
        setCharacterId,
        setActiveCharacter,
        setActiveGroup,
        reloadCurrentChat,
    };
}

describe('/go temporary chat navigation seam', () => {
    test('/go asks the leave seam before it switches character, then switches and reloads, as before', async () => {
        const harness = await loadGoCommand({ flushResult: true });

        await expect(harness.goCallback(null, 'Seraphina')).resolves.toBe('Seraphina');

        expect(harness.log).toEqual(['flush', 'resetSelectedGroup', 'setCharacterId 1', 'reload']);
        expect(harness.setActiveCharacter).toHaveBeenCalledWith('seraphina.png');
    });

    test('/go stays put and reports no character when the user declines to leave a temporary chat', async () => {
        const harness = await loadGoCommand({ flushResult: false });

        await expect(harness.goCallback(null, 'Seraphina')).resolves.toBe('');

        expect(harness.setCharacterId).not.toHaveBeenCalled();
        expect(harness.resetSelectedGroup).not.toHaveBeenCalled();
        expect(harness.reloadCurrentChat).not.toHaveBeenCalled();
        expect(harness.setActiveCharacter).not.toHaveBeenCalled();
    });
});
