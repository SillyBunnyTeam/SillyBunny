import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';
import { POWER_USER_URL, SLASH_COMMANDS_URL, loadFunctions } from './helpers/vm-source.js';

/**
 * Every way into another chat has to pass the leave seam, and a few collaborators of script.js must not write for a
 * temporary chat. Jest cannot import those files, so the real functions run in a vm context with stubbed neighbours.
 */
function createContext(overrides = {}) {
    const log = [];
    return vm.createContext({
        console: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn(), trace: jest.fn() },
        log,
        characters: [{ name: 'Bunny', avatar: 'bunny.png', chat: 'bunny-chat' }, { name: 'Seraphina', avatar: 'seraphina.png', chat: 'seraphina-chat' }],
        this_chid: '0',
        selected_group: null,
        name2: 'Bunny',
        chat: [],
        chat_metadata: {},
        fetch: jest.fn(),
        toastr: { error: jest.fn(), warning: jest.fn(), info: jest.fn() },
        t: strings => strings.join(''),
        isTemporaryChat: jest.fn(() => false),
        isTemporaryChatWith: jest.fn(() => false),
        leaveTemporaryChat: jest.fn(async () => true),
        endTemporaryChat: jest.fn(),
        ...overrides,
    });
}

describe('/go, /char and /random', () => {
    function slashContext(overrides = {}) {
        const context = createContext({
            flushPendingChatSavesForNavigation: jest.fn(async () => { context.log.push('flush'); return true; }),
            resetSelectedGroup: jest.fn(() => context.log.push('resetSelectedGroup')),
            setCharacterId: jest.fn((id) => { context.log.push(`setCharacterId ${id}`); }),
            setActiveCharacter: jest.fn(),
            setActiveGroup: jest.fn(),
            reloadCurrentChat: jest.fn(async () => { context.log.push('reload'); }),
            delay: jest.fn(async () => {}),
            findChar: ({ name }) => context.characters.find(character => character.name === name),
            getCharIndex: character => context.characters.indexOf(character),
            groups: [],
            equalsIgnoreCaseAndAccents: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
            openGroupById: jest.fn(),
            ...overrides,
        });
        loadFunctions(context, ['openChat', 'goToCharacterCallback'], SLASH_COMMANDS_URL);
        return context;
    }

    test('/go asks the leave seam before it switches character, then switches and reloads, as before', async () => {
        const context = slashContext();

        await expect(context.goToCharacterCallback(null, 'Seraphina')).resolves.toBe('Seraphina');

        expect(context.log).toEqual(['flush', 'resetSelectedGroup', 'setCharacterId 1', 'reload']);
        expect(context.setActiveCharacter).toHaveBeenCalledWith('seraphina.png');
    });

    test('/go stays put and reports no character when the user declines to leave a temporary chat', async () => {
        const context = slashContext({ flushPendingChatSavesForNavigation: jest.fn(async () => false) });

        await expect(context.goToCharacterCallback(null, 'Seraphina')).resolves.toBe('');

        expect(context.setCharacterId).not.toHaveBeenCalled();
        expect(context.resetSelectedGroup).not.toHaveBeenCalled();
        expect(context.reloadCurrentChat).not.toHaveBeenCalled();
        expect(context.setActiveCharacter).not.toHaveBeenCalled();
    });

    function randomContext(overrides = {}) {
        const context = createContext({
            flushPendingChatSavesForNavigation: jest.fn(async () => { context.log.push('flush'); return true; }),
            resetSelectedGroup: jest.fn(() => context.log.push('resetSelectedGroup')),
            setCharacterId: jest.fn((id) => { context.log.push(`setCharacterId ${id}`); }),
            setActiveCharacter: jest.fn(),
            setActiveGroup: jest.fn(),
            reloadCurrentChat: jest.fn(async () => { context.log.push('reload'); }),
            delay: jest.fn(async () => {}),
            tag_map: {},
            findTagIdByName: jest.fn(),
            ...overrides,
        });
        context.Math = Object.create(Math, { random: { value: () => 0.99 } });
        loadFunctions(context, ['doRandomChat'], POWER_USER_URL);
        return context;
    }

    test('/random asks the leave seam before it switches character, then switches and reloads, as before', async () => {
        const context = randomContext();

        await expect(context.doRandomChat(null, '')).resolves.toBe('Seraphina');

        expect(context.log).toEqual(['flush', 'resetSelectedGroup', 'setCharacterId 1', 'reload']);
    });

    test('/random picks the character first, and neither asks nor switches when there is none to pick', async () => {
        const context = randomContext();

        await expect(context.doRandomChat(null, 'nobody')).resolves.toBeUndefined();

        expect(context.flushPendingChatSavesForNavigation).not.toHaveBeenCalled();
        expect(context.resetSelectedGroup).not.toHaveBeenCalled();
        expect(context.setCharacterId).not.toHaveBeenCalled();
        expect(context.toastr.error).toHaveBeenCalled();
    });

    test('/random stays put when the user declines to leave a temporary chat', async () => {
        const context = randomContext({ flushPendingChatSavesForNavigation: jest.fn(async () => false) });

        await expect(context.doRandomChat(null, '')).resolves.toBe('');

        expect(context.setCharacterId).not.toHaveBeenCalled();
        expect(context.resetSelectedGroup).not.toHaveBeenCalled();
        expect(context.reloadCurrentChat).not.toHaveBeenCalled();
    });
});

describe('reloading the open chat', () => {
    function reloadContext({ temporary, temporaryWith = false, chid = '0', ...overrides } = {}) {
        const context = createContext({
            this_chid: chid,
            isTemporaryChat: jest.fn(() => temporary),
            isTemporaryChatWith: jest.fn(() => temporaryWith),
            endTemporaryChat: jest.fn(() => { context.isTemporaryChat = () => false; }),
            getCurrentChatId: () => context.characters[context.this_chid]?.chat,
            shouldAbortReloadForActiveGeneration: () => false,
            shouldDiscardReloadTarget: () => false,
            is_send_press: false,
            activeGenerationRun: null,
            flushPendingChatSavesForNavigation: jest.fn(async () => true),
            itemizedPrompts: [{ mesId: 1 }],
            // What clearChat would store under the id of the chat it clears.
            clearChat: jest.fn(async () => { context.promptsSeenByClearChat = context.itemizedPrompts.length; }),
            ensureMessageMediaIsArray: jest.fn(),
            printMessages: jest.fn(async () => {}),
            eventSource: { emit: jest.fn(async () => {}) },
            event_types: { CHAT_CHANGED: 'chat_changed' },
            refreshSwipeButtons: jest.fn(),
            getRequestHeaders: () => ({}),
            fetchChatRaw: jest.fn(async () => null),
            fetchGroupChatRaw: jest.fn(),
            getCharacters: jest.fn(),
            saveGroupChat: jest.fn(),
            saveChatConditional: jest.fn(),
            ...overrides,
        });
        context.chat.push({ mes: 'temporary message' });
        loadFunctions(context, ['reloadCurrentChatUnsafe']);
        return context;
    }

    /** Collaborators for a reload that reads the chat file and goes on to clear the chat. */
    const readableFile = () => ({
        fetchChatRaw: jest.fn(async () => ({ messages: [], metadata: {} })),
        commitChatStaging: jest.fn(() => true),
        preserveNeutralChat: jest.fn(),
        loadItemizedPrompts: jest.fn(async () => {}),
    });

    test('redraws a temporary chat from memory when the selected character is the one it is with', async () => {
        const context = reloadContext({ temporary: true, temporaryWith: true });

        await context.reloadCurrentChatUnsafe();

        expect(context.printMessages).toHaveBeenCalledTimes(1);
        expect(context.fetchChatRaw).not.toHaveBeenCalled();
        expect(context.endTemporaryChat).not.toHaveBeenCalled();
        expect(context.isTemporaryChatWith).toHaveBeenCalledWith('bunny.png');
    });

    test('ends a temporary chat that belongs to another character, and reloads the selected one from its file', async () => {
        const context = reloadContext({ temporary: true, temporaryWith: false });

        await context.reloadCurrentChatUnsafe();

        expect(context.endTemporaryChat).toHaveBeenCalledTimes(1);
        expect(context.console.warn).toHaveBeenCalled();
        expect(context.fetchChatRaw).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'bunny-chat', avatarUrl: 'bunny.png' }));
        expect(context.printMessages).not.toHaveBeenCalled();
    });

    test('drops the prompts of the temporary chat it ends, so clearing the chat cannot store them under the other character', async () => {
        const context = reloadContext({ temporary: true, temporaryWith: false, ...readableFile() });

        await context.reloadCurrentChatUnsafe();

        expect(context.clearChat).toHaveBeenCalled();
        expect(context.promptsSeenByClearChat).toBe(0);
    });

    test('keeps the prompts of a chat that is not temporary', async () => {
        const context = reloadContext({ temporary: false, ...readableFile() });

        await context.reloadCurrentChatUnsafe();

        expect(context.promptsSeenByClearChat).toBe(1);
    });

    test('ends a temporary chat when no character is selected', async () => {
        const context = reloadContext({ temporary: true, temporaryWith: false, chid: undefined });

        await context.reloadCurrentChatUnsafe();

        expect(context.endTemporaryChat).toHaveBeenCalledTimes(1);
    });

    test('reloads a normal chat from its file, as before', async () => {
        const context = reloadContext({ temporary: false });

        await context.reloadCurrentChatUnsafe();

        expect(context.endTemporaryChat).not.toHaveBeenCalled();
        expect(context.fetchChatRaw).toHaveBeenCalledTimes(1);
    });
});

describe('flushing the chat for a cache clear or a rename', () => {
    function flushContext(overrides = {}) {
        const context = createContext({
            getCurrentChatId: () => 'bunny-chat',
            cancelDebouncedChatSave: jest.fn(),
            chatSavePromise: null,
            setChatSaveActive: jest.fn(),
            saveChat: jest.fn(async () => true),
            saveGroupChat: jest.fn(),
            saveTokenCache: jest.fn(),
            saveItemizedPrompts: jest.fn(async () => {}),
            ...overrides,
        });
        loadFunctions(context, ['flushPendingChatSaves']);
        return context;
    }

    test('saves the open chat and its itemized prompts, as before', async () => {
        const context = flushContext();

        await expect(context.flushPendingChatSaves({ silent: true })).resolves.toBe(true);

        expect(context.saveChat).toHaveBeenCalledWith({ throwOnError: true });
        expect(context.saveItemizedPrompts).toHaveBeenCalledWith('bunny-chat');
    });

    test('reports success for a temporary chat, which has nothing to save, without a save, a toast or stored prompts', async () => {
        const context = flushContext({ isTemporaryChat: jest.fn(() => true), saveChat: jest.fn(async () => false) });

        await expect(context.flushPendingChatSaves()).resolves.toBe(true);

        expect(context.saveChat).not.toHaveBeenCalled();
        expect(context.saveItemizedPrompts).not.toHaveBeenCalled();
        expect(context.toastr.info).not.toHaveBeenCalled();
        expect(context.toastr.error).not.toHaveBeenCalled();
    });
});

describe('renaming the open character', () => {
    function renameContext(overrides = {}) {
        const context = createContext({
            this_chid: '1',
            callGenericPopup: jest.fn(),
            POPUP_TYPE: { INPUT: 'input' },
            Popup: { show: { text: jest.fn() } },
            getRequestHeaders: () => ({}),
            fetch: jest.fn(async () => { context.log.push('rename request'); return { ok: false }; }),
            leaveTemporaryChat: jest.fn(async () => { context.log.push('leave'); return true; }),
            location: { reload: jest.fn() },
            ...overrides,
        });
        context.toastr.error = jest.fn();
        loadFunctions(context, ['renameCharacter']);
        return context;
    }

    test('asks to leave a temporary chat before the character is renamed on the server', async () => {
        const context = renameContext({ isTemporaryChat: jest.fn(() => true) });

        await context.renameCharacter('Serafina', { silent: true });

        expect(context.log.slice(0, 2)).toEqual(['leave', 'rename request']);
    });

    test('does not rename anything when the user declines to leave the temporary chat', async () => {
        const context = renameContext({ isTemporaryChat: jest.fn(() => true), leaveTemporaryChat: jest.fn(async () => false) });

        await expect(context.renameCharacter('Serafina', { silent: true })).resolves.toBe(false);

        expect(context.fetch).not.toHaveBeenCalled();
        expect(context.location.reload).not.toHaveBeenCalled();
    });

    test('does not ask anything for a normal chat, as before', async () => {
        const context = renameContext();

        await context.renameCharacter('Serafina', { silent: true });

        expect(context.leaveTemporaryChat).not.toHaveBeenCalled();
        expect(context.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('settings payload', () => {
    function settingsContext(overrides = {}) {
        const sent = [];
        const context = createContext({
            sent,
            settingsReady: true,
            settingsConflictReloadRequired: false,
            TempResponseLength: { isCustomized: () => false },
            lastServerSettingsVersion: 1,
            firstRun: false,
            accountStorage: { getState: () => ({}) },
            currentVersion: '2.0.0',
            name1: 'User',
            active_character: 'Seraphina.png',
            active_group: null,
            user_avatar: 'user.png',
            amount_gen: 300,
            max_context: 8192,
            main_api: 'openai',
            getWorldInfoSettings: () => ({}),
            textgen_settings: {},
            swipes: true,
            horde_settings: {},
            power_user: {},
            extension_settings: {},
            tags: [],
            tag_map: {},
            nai_settings: {},
            kai_settings: {},
            oai_settings: {},
            background_settings: {},
            proxies: [],
            selected_proxy: {},
            custom_endpoint_presets: [],
            selected_custom_endpoint_preset: null,
            compressRequest: async request => request,
            getRequestHeaders: () => ({}),
            normalizeSettingsVersion: value => Number(value) || 0,
            fetch: jest.fn(async (_url, request) => {
                sent.push(JSON.parse(request.body));
                return { ok: true, status: 200, json: async () => ({ version: 2 }) };
            }),
            eventSource: { emit: jest.fn(async () => {}) },
            event_types: { SETTINGS_UPDATED: 'settings_updated' },
            saveSettingsDebounced: jest.fn(),
            ...overrides,
        });
        loadFunctions(context, ['saveSettingsInner']);
        return context;
    }

    test('names the active character of a normal chat, so a reload can open it again', async () => {
        const context = settingsContext();

        await expect(context.saveSettingsInner()).resolves.toBe(true);

        expect(context.sent).toHaveLength(1);
        expect(context.sent[0].active_character).toBe('Seraphina.png');
        expect(context.sent[0].active_group).toBeNull();
    });

    test('names no active character for a temporary chat, so a reload does not create its real chat', async () => {
        const context = settingsContext({ isTemporaryChat: jest.fn(() => true) });

        await context.saveSettingsInner();

        expect(context.sent[0].active_character).toBeNull();
    });
});

describe('opening a chat and opening a temporary chat', () => {
    const FIRST_MESSAGE = { name: 'Bunny', mes: 'Hello from the card', is_user: false };

    function openingContext({ settingsOpen = false } = {}) {
        const events = [];
        const focus = jest.fn();
        const context = createContext({
            events,
            focus,
            incrementChatGeneration: jest.fn(),
            unshallowCharacter: jest.fn(async () => {}),
            resolveCharacterChatForLoad: jest.fn(async () => ({ chatName: 'bunny-chat', created: false })),
            getRequestHeaders: () => ({}),
            fetch: jest.fn(async () => ({ ok: true, json: async () => [{ chat_metadata: {} }] })),
            ensureMessageMediaIsArray: jest.fn(),
            getFirstMessage: jest.fn(() => ({ ...FIRST_MESSAGE })),
            saveChatConditional: jest.fn(async () => true),
            loadItemizedPrompts: jest.fn(async () => {}),
            printMessages: jest.fn(async () => {}),
            select_selected_character: jest.fn(),
            getCurrentChatId: () => 'chat-id',
            beginTemporaryChat: jest.fn(),
            showTemporaryChatError: jest.fn(),
            eventSource: { emit: jest.fn((name) => { events.push(name); return Promise.resolve(); }) },
            event_types: { CHAT_CHANGED: 'CHAT_CHANGED', CHAT_LOADED: 'CHAT_LOADED', MESSAGE_RECEIVED: 'MESSAGE_RECEIVED', CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED', CHAT_CREATED: 'CHAT_CREATED' },
            delay: jest.fn(async () => {}),
            debounce_timeout: { short: 1 },
            document: { documentElement: { dataset: settingsOpen ? { sbSettingsOpen: 'true' } : {} }, activeElement: null },
            $: jest.fn(() => {
                const wrapper = { is: () => false, trigger: (name) => { if (name === 'focus') focus(); return wrapper; } };
                return wrapper;
            }),
        });
        loadFunctions(context, ['getChat', 'getChatResult', 'getTemporaryChat']);
        context.isTemporaryChat = jest.fn(() => true);
        return context;
    }

    const settle = () => new Promise(resolve => setTimeout(resolve, 0));

    test('a temporary chat announces itself in the same order as a chat that was read from its file', async () => {
        const saved = openingContext();
        await saved.getChat();
        const temporary = openingContext();
        await temporary.getTemporaryChat();

        expect(saved.events).toEqual(['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'CHAT_LOADED']);
        expect(temporary.events).toEqual(saved.events);
    });

    test('both put the cursor in the message box once the page settles', async () => {
        const saved = openingContext();
        await saved.getChat();
        const temporary = openingContext();
        await temporary.getTemporaryChat();
        await settle();

        expect(saved.focus).toHaveBeenCalledTimes(1);
        expect(temporary.focus).toHaveBeenCalledTimes(1);
    });

    test('neither steals the focus while a settings page is open', async () => {
        const saved = openingContext({ settingsOpen: true });
        await saved.getChat();
        const temporary = openingContext({ settingsOpen: true });
        await temporary.getTemporaryChat();
        await settle();

        expect(saved.focus).not.toHaveBeenCalled();
        expect(temporary.focus).not.toHaveBeenCalled();
    });
});
