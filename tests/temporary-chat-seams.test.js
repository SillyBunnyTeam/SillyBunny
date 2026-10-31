import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';
import { AUTO_ENGINE_URL, loadFunctions } from './helpers/vm-source.js';

/**
 * The guards for a temporary chat sit in script.js, which Jest cannot import, so the real functions are cut out of the
 * source and run in a context with stubbed collaborators (as chat-save-queue-runtime.test.js does for saveChat).
 */

function createContext(overrides = {}) {
    const calls = [];
    const characters = [{ name: 'Bunny', avatar: 'bunny.png', chat: 'real-chat' }, { name: 'Other', avatar: 'other.png', chat: 'other-chat' }];
    const context = vm.createContext({
        console: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn(), trace: jest.fn() },
        calls,
        characters,
        this_chid: '0',
        selected_group: null,
        is_group_generating: false,
        is_send_press: false,
        name2: 'Bunny',
        chat: [],
        chat_metadata: { stale: true },
        itemizedPrompts: [],
        fetch: jest.fn(),
        toastr: { error: jest.fn() },
        t: strings => strings.join(''),
        isTemporaryChat: jest.fn(() => false),
        leaveTemporaryChat: jest.fn(async () => true),
        hasPendingChatSave: jest.fn(() => false),
        flushPendingChatSaves: jest.fn(async () => true),
        waitForQueuedChatSaves: jest.fn(async () => {}),
        waitForQueuedGroupChatSaves: jest.fn(async () => {}),
        ...overrides,
    });
    return context;
}

describe('leaving a temporary chat through the navigation flush', () => {
    function flushContext(overrides) {
        const context = createContext(overrides);
        loadFunctions(context, ['flushPendingChatSavesForNavigation']);
        return context;
    }

    test('flushes pending saves and lets queued ones land for a normal chat, as before', async () => {
        const context = flushContext({ hasPendingChatSave: jest.fn(() => true) });

        await expect(context.flushPendingChatSavesForNavigation()).resolves.toBe(true);

        expect(context.flushPendingChatSaves).toHaveBeenCalledWith({ silent: true });
        expect(context.waitForQueuedChatSaves).toHaveBeenCalledTimes(1);
        expect(context.leaveTemporaryChat).not.toHaveBeenCalled();
    });

    test('refuses to navigate when a normal chat could not be flushed, as before', async () => {
        const context = flushContext({ hasPendingChatSave: jest.fn(() => true), flushPendingChatSaves: jest.fn(async () => false) });

        await expect(context.flushPendingChatSavesForNavigation()).resolves.toBe(false);
        expect(context.toastr.error).toHaveBeenCalled();
    });

    test('asks to leave a temporary chat and flushes nothing', async () => {
        const context = flushContext({ isTemporaryChat: jest.fn(() => true), hasPendingChatSave: jest.fn(() => true) });

        await expect(context.flushPendingChatSavesForNavigation()).resolves.toBe(true);

        expect(context.leaveTemporaryChat).toHaveBeenCalledTimes(1);
        expect(context.flushPendingChatSaves).not.toHaveBeenCalled();
        expect(context.waitForQueuedChatSaves).not.toHaveBeenCalled();
    });

    test('flushes the chat normally when leaving ended the temporary state by saving it', async () => {
        let temporary = true;
        const context = flushContext({
            isTemporaryChat: jest.fn(() => temporary),
            hasPendingChatSave: jest.fn(() => true),
            // Save as New Chat leaves the temporary state before it returns.
            leaveTemporaryChat: jest.fn(async () => { temporary = false; return true; }),
        });

        await expect(context.flushPendingChatSavesForNavigation()).resolves.toBe(true);

        expect(context.flushPendingChatSaves).toHaveBeenCalledWith({ silent: true });
        expect(context.waitForQueuedChatSaves).toHaveBeenCalledTimes(1);
    });

    test('keeps the user in a temporary chat when leaving is declined', async () => {
        const context = flushContext({ isTemporaryChat: jest.fn(() => true), leaveTemporaryChat: jest.fn(async () => false) });

        await expect(context.flushPendingChatSavesForNavigation()).resolves.toBe(false);
    });

    test('does not ask when the user only reselects the character that is already open', async () => {
        const context = flushContext({ isTemporaryChat: jest.fn(() => true) });

        await expect(context.flushPendingChatSavesForNavigation({ staying: true })).resolves.toBe(true);

        expect(context.leaveTemporaryChat).not.toHaveBeenCalled();
    });
});

describe('recording a chat name for a character', () => {
    function recordContext(overrides) {
        const context = createContext({
            getRequestHeaders: () => ({}),
            fetch: jest.fn(async () => ({ ok: true })),
            ...overrides,
        });
        loadFunctions(context, ['updateRemoteChatName']);
        return context;
    }

    test('posts the last chat of the character and remembers it, as before', async () => {
        const context = recordContext();

        await context.updateRemoteChatName('0', 'new-chat');

        expect(context.fetch).toHaveBeenCalledTimes(1);
        expect(context.fetch.mock.calls[0][0]).toBe('/api/characters/last-chat');
        expect(JSON.parse(context.fetch.mock.calls[0][1].body)).toEqual({ avatar: 'bunny.png', chat: 'new-chat' });
        expect(context.characters[0].chat).toBe('new-chat');
    });

    test('records nothing for a temporary chat, whose name is only a stand-in', async () => {
        const context = recordContext({ isTemporaryChat: jest.fn(() => true) });

        await context.updateRemoteChatName('0', 'Temporary Chat: 9');

        expect(context.fetch).not.toHaveBeenCalled();
        expect(context.characters[0].chat).toBe('real-chat');
    });
});

describe('scheduling a chat save', () => {
    test('schedules no save timer for a temporary chat', () => {
        const timers = [];
        const context = createContext({
            isTemporaryChat: jest.fn(() => true),
            setTimeout: jest.fn((...args) => timers.push(args)),
            getCurrentChatId: () => 'real-chat',
            chatGeneration: 1,
            cancelDebouncedChatSave: jest.fn(),
            DEFAULT_SAVE_EDIT_TIMEOUT: 1000,
        });
        loadFunctions(context, ['saveChatDebounced']);

        context.saveChatDebounced();

        expect(timers).toEqual([]);
        expect(context.cancelDebouncedChatSave).not.toHaveBeenCalled();
    });

    test('schedules one save timer for a normal chat, as before', () => {
        const timers = [];
        const context = createContext({
            setTimeout: jest.fn((...args) => timers.push(args)),
            getCurrentChatId: () => 'real-chat',
            chatGeneration: 1,
            cancelDebouncedChatSave: jest.fn(),
            DEFAULT_SAVE_EDIT_TIMEOUT: 1000,
        });
        loadFunctions(context, ['saveChatDebounced']);

        context.saveChatDebounced();

        expect(timers).toHaveLength(1);
    });
});

describe('selecting a character', () => {
    function selectContext(overrides = {}) {
        const log = [];
        const context = createContext({
            log,
            flushPendingChatSavesForNavigation: jest.fn(async () => true),
            cancelCharacterSaveDebounced: jest.fn(),
            setCharacterId(value) { context.this_chid = value === undefined ? undefined : String(value); },
            setCharacterName: jest.fn(),
            resetSelectedGroup: jest.fn(),
            clearChat: jest.fn(async () => { log.push('clearChat'); }),
            cancelTtsPlay: jest.fn(),
            this_edit_mes_id: undefined,
            selected_button: '',
            getChat: jest.fn(async () => true),
            getTemporaryChat: jest.fn(async () => true),
            syncCharacterMenuActiveEntity: jest.fn(),
            unshallowCharacter: jest.fn(async () => {}),
            select_selected_character: jest.fn(),
            window: { dispatchEvent: jest.fn() },
            CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
            ...overrides,
        });
        loadFunctions(context, ['selectCharacterById']);
        return context;
    }

    test('opens the saved chat of a character with getChat, as before', async () => {
        const context = selectContext();

        await expect(context.selectCharacterById(1)).resolves.toBe(true);

        expect(context.getChat).toHaveBeenCalledTimes(1);
        expect(context.getTemporaryChat).not.toHaveBeenCalled();
    });

    test('opens a temporary chat without resolving or reading any chat file', async () => {
        const context = selectContext();

        await expect(context.selectCharacterById(1, { temporary: true, switchMenu: false })).resolves.toBe(true);

        expect(context.getTemporaryChat).toHaveBeenCalledWith({ switchMenu: false });
        expect(context.getChat).not.toHaveBeenCalled();
        expect(context.fetch).not.toHaveBeenCalled();
        expect(context.log).toEqual(['clearChat']);
    });

    test('starts a temporary chat with the character that is already selected, from a clean chat', async () => {
        const context = selectContext();

        await expect(context.selectCharacterById(0, { temporary: true })).resolves.toBe(true);

        expect(context.clearChat).toHaveBeenCalledWith({ clearData: true });
        expect(context.getTemporaryChat).toHaveBeenCalledTimes(1);
    });

    test('stays where it is when the user declines to leave the open temporary chat', async () => {
        const context = selectContext({ flushPendingChatSavesForNavigation: jest.fn(async () => false) });

        await expect(context.selectCharacterById(1, { temporary: true })).resolves.toBe(false);

        expect(context.clearChat).not.toHaveBeenCalled();
        expect(context.getTemporaryChat).not.toHaveBeenCalled();
    });

    test('reselecting the open character passes the staying flag, so a temporary chat is not asked about', async () => {
        const context = selectContext();

        await context.selectCharacterById(0, { onAccepted: jest.fn() });

        expect(context.flushPendingChatSavesForNavigation).toHaveBeenCalledWith({ staying: true });
    });
});

describe('opening a temporary chat', () => {
    function openContext(overrides = {}) {
        const log = [];
        const context = createContext({
            log,
            incrementChatGeneration: jest.fn(),
            unshallowCharacter: jest.fn(async () => {}),
            beginTemporaryChat: jest.fn((character) => { character.chat = 'Temporary Chat: 1'; log.push('begin'); }),
            endTemporaryChat: jest.fn(),
            showTemporaryChatError: jest.fn(),
            getFirstMessage: jest.fn(() => ({ name: 'Bunny', mes: 'Hello from the card', is_user: false })),
            printMessages: jest.fn(async () => { log.push('print'); }),
            select_selected_character: jest.fn(),
            getCurrentChatId: () => context.characters[context.this_chid]?.chat,
            eventSource: { emit: jest.fn(async () => {}) },
            event_types: { CHAT_CHANGED: 'changed', CHAT_LOADED: 'loaded', MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
            delay: jest.fn(async () => {}),
            debounce_timeout: { short: 1 },
            $: jest.fn(() => ({ trigger: jest.fn().mockReturnThis(), is: jest.fn(() => false) })),
            document: { activeElement: null },
            ...overrides,
        });
        loadFunctions(context, ['getTemporaryChat']);
        return context;
    }

    test('shows the card greeting as the only message and reads or writes no chat file', async () => {
        const context = openContext();
        context.chat.push({ mes: 'left over' });

        await expect(context.getTemporaryChat({ switchMenu: false })).resolves.toBe(true);

        expect(context.chat.map(message => message.mes)).toEqual(['Hello from the card']);
        expect(context.fetch).not.toHaveBeenCalled();
        expect(context.log).toEqual(['begin', 'print']);
        expect(context.characters[0].chat).toBe('Temporary Chat: 1');
        expect(context.select_selected_character).toHaveBeenCalledWith('0', { switchMenu: false });
        expect(context.eventSource.emit).toHaveBeenCalledWith('changed', 'Temporary Chat: 1');
    });

    test('ends the temporary chat and reports the failure when opening throws', async () => {
        const context = openContext({ printMessages: jest.fn(async () => { throw new Error('render failed'); }) });

        await expect(context.getTemporaryChat()).resolves.toBe(false);

        expect(context.endTemporaryChat).toHaveBeenCalledTimes(1);
        expect(context.showTemporaryChatError).toHaveBeenCalledWith('TC-OPEN-ERROR');
    });
});

describe('clearing the chat', () => {
    function clearContext(overrides = {}) {
        const log = [];
        const context = createContext({
            log,
            chatRenderVersion: 0,
            cancelDebouncedChatSave: jest.fn(),
            cancelDebouncedMetadataSave: jest.fn(),
            closeMessageEditor: jest.fn(),
            clearChatLoadBottomLock: jest.fn(),
            disposeChatMessageResizeObserver: jest.fn(),
            resetMobileChatViewportLifecycle: jest.fn(),
            extension_prompts: {},
            is_delete_mode: false,
            chatElement: { children: () => ({ remove: jest.fn() }) },
            $: jest.fn(() => ({ length: 0 })),
            saveItemizedPrompts: jest.fn(async (chatId) => { log.push(`save prompts ${chatId}`); }),
            getCurrentChatId: () => context.characters[context.this_chid]?.chat,
            endTemporaryChat: jest.fn(() => { log.push('end temporary'); }),
            incrementChatGeneration: jest.fn(),
            ...overrides,
        });
        loadFunctions(context, ['clearChat']);
        return context;
    }

    test('stores the itemized prompts of a normal chat under its id, as before', async () => {
        const context = clearContext();

        await context.clearChat({ clearData: true });

        expect(context.log).toEqual(['save prompts real-chat']);
        expect(context.endTemporaryChat).not.toHaveBeenCalled();
    });

    test('stores no prompts for a temporary chat and ends it when its messages are cleared for another chat', async () => {
        const context = clearContext({ isTemporaryChat: jest.fn(() => true) });

        await context.clearChat({ clearData: true });

        expect(context.log).toEqual(['end temporary']);
    });

    test('keeps a temporary chat when only its rendering is cleared', async () => {
        const context = clearContext({ isTemporaryChat: jest.fn(() => true) });

        await context.clearChat({ clearData: false });

        expect(context.log).toEqual([]);
        expect(context.endTemporaryChat).not.toHaveBeenCalled();
    });
});

describe('starting a new chat', () => {
    function newChatContext({ temporary }) {
        let isTemporary = temporary;
        const context = createContext({
            menu_type: 'character_edit',
            isTemporaryChat: jest.fn(() => isTemporary),
            flushPendingChatSavesForNavigation: jest.fn(async () => true),
            // Clearing the chat ends a temporary chat, and gives the card its real chat name back.
            clearChat: jest.fn(async () => { isTemporary = false; }),
            getCurrentChatDetails: () => ({ sessionName: context.characters[context.this_chid].chat }),
            getChat: jest.fn(async () => true),
            updateRemoteChatName: jest.fn(async () => {}),
            delChat: jest.fn(async () => true),
            humanizedDateTime: () => 'now',
            $: jest.fn(() => ({ val: jest.fn() })),
            chat_file_for_del: undefined,
        });
        loadFunctions(context, ['doNewChat']);
        return context;
    }

    test('deletes the chat that was open when asked to, as before', async () => {
        const context = newChatContext({ temporary: false });

        await context.doNewChat({ deleteCurrentChat: true });

        expect(context.delChat).toHaveBeenCalledWith('real-chat.jsonl');
    });

    test('never deletes the real chat of the character when the chat that was open is temporary', async () => {
        const context = newChatContext({ temporary: true });

        await context.doNewChat({ deleteCurrentChat: true });

        expect(context.getChat).toHaveBeenCalledTimes(1);
        expect(context.delChat).not.toHaveBeenCalled();
    });
});

describe('Conversation reactions to the open roleplay', () => {
    function captureContext(overrides = {}) {
        const context = createContext({
            getCurrentCharAvatar: () => 'bunny.png',
            getConversationPersonaId: () => 'persona.png',
            getConversationThreadStore: () => ({ activeBranchId: 'main' }),
            buildConversationRoleplayContext: () => 'The scene so far.',
            getRoleplaySourceMessageRevision: () => 'revision',
            ...overrides,
        });
        loadFunctions(context, ['captureRoleplayDMRequest'], AUTO_ENGINE_URL);
        return context;
    }

    test('captures the scene of a normal roleplay chat for a reaction, as before', () => {
        const context = captureContext();

        expect(context.captureRoleplayDMRequest()).toMatchObject({ avatar: 'bunny.png', branchId: 'main', roleplayContext: 'The scene so far.' });
    });

    test('captures nothing from a temporary chat, so no reaction is written into the Conversation store', () => {
        const context = captureContext({ isTemporaryChat: jest.fn(() => true) });

        expect(context.captureRoleplayDMRequest()).toBeNull();
    });
});
