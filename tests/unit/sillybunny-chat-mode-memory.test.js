/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const STORAGE_KEY = 'WelcomePage_LastMode';

/**
 * Mirrors the observable behaviour of the real account storage: a write before `init()` is kept
 * in memory, and `init()` then merges the saved server state over it.
 */
function createAccountStorage() {
    let state = {};
    return {
        init(saved) {
            state = Object.assign(state, saved);
        },
        getItem: key => (Object.hasOwn(state, key) ? String(state[key]) : null),
        setItem(key, value) {
            state[key] = String(value);
        },
    };
}

let accountStorage;
let memory;
let events;
let changeListener;
let attachedListeners = [];

// Each test loads a fresh module, so listeners that the previous one added must go.
function trackListeners(target) {
    const add = target.addEventListener.bind(target);
    jest.spyOn(target, 'addEventListener').mockImplementation((type, handler, options) => {
        attachedListeners.push({ target, type, handler });
        add(type, handler, options);
    });
}

async function loadModules() {
    jest.resetModules();
    trackListeners(window);
    trackListeners(document);
    accountStorage = createAccountStorage();
    jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({ accountStorage }));
    memory = await import('../../public/scripts/sillybunny-chat-mode-memory.js');
    events = await import('../../public/scripts/events.js');
    changeListener = jest.fn();
    document.addEventListener(memory.CHAT_MODE_CHANGED_EVENT, changeListener);
}

function emitWorkspaceState(open) {
    window.dispatchEvent(new CustomEvent('sb:conversation-workspace-state-changed', { detail: { open } }));
}

function emitHomeState(active) {
    document.dispatchEvent(new CustomEvent('sb:home-state-changed', { detail: { active } }));
}

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

function showWelcomePanel() {
    document.body.innerHTML = '<div id="sheld"><div id="chat"><div class="welcomePanel"></div></div></div>';
}

beforeEach(loadModules);

afterEach(() => {
    jest.restoreAllMocks();
    for (const { target, type, handler } of attachedListeners) {
        target.removeEventListener(type, handler);
    }
    attachedListeners = [];
    document.body.innerHTML = '';
});

describe('last chat mode', () => {
    test('defaults to Roleplay when nothing is stored', () => {
        expect(memory.getLastChatMode()).toBe('roleplay');
    });

    test.each(['conversation', 'roleplay'])('stores %s when it is recorded', (mode) => {
        memory.recordChatMode(mode);

        expect(memory.getLastChatMode()).toBe(mode);
        expect(accountStorage.getItem(STORAGE_KEY)).toBe(mode);
    });

    test.each(['', 'Conversation', 'story', '1', 'null'])('reads the stored value %p as Roleplay', (stored) => {
        accountStorage.setItem(STORAGE_KEY, stored);

        expect(memory.getLastChatMode()).toBe('roleplay');
    });

    test.each(['story', '', undefined, null])('rejects %p when recording and keeps the stored mode', (mode) => {
        memory.recordChatMode('conversation');

        expect(() => memory.recordChatMode(mode)).toThrow();
        expect(memory.getLastChatMode()).toBe('conversation');
        expect(accountStorage.getItem(STORAGE_KEY)).toBe('conversation');
    });

    test('announces a change once and stays silent when the mode is the same', () => {
        memory.recordChatMode('conversation');
        memory.recordChatMode('conversation');

        expect(changeListener).toHaveBeenCalledTimes(1);
        expect(changeListener.mock.calls[0][0].detail).toEqual({ mode: 'conversation' });

        memory.recordChatMode('roleplay');

        expect(changeListener).toHaveBeenCalledTimes(2);
        expect(changeListener.mock.calls[1][0].detail).toEqual({ mode: 'roleplay' });
    });

    test('keeps a mode recorded before the account storage loads', async () => {
        memory.initChatModeMemory();
        memory.recordChatMode('conversation');

        accountStorage.init({ [STORAGE_KEY]: 'roleplay' });
        expect(memory.getLastChatMode()).toBe('conversation');

        await events.eventSource.emit(events.event_types.SETTINGS_LOADED);

        expect(memory.getLastChatMode()).toBe('conversation');
        expect(accountStorage.getItem(STORAGE_KEY)).toBe('conversation');
    });

    test('lets the account storage win once settings have loaded', async () => {
        memory.initChatModeMemory();
        memory.recordChatMode('conversation');
        accountStorage.init({});
        await events.eventSource.emit(events.event_types.SETTINGS_LOADED);

        accountStorage.setItem(STORAGE_KEY, 'roleplay');

        expect(memory.getLastChatMode()).toBe('roleplay');

        memory.recordChatMode('conversation');
        accountStorage.setItem(STORAGE_KEY, 'roleplay');

        expect(memory.getLastChatMode()).toBe('roleplay');
    });

    test('treats a storage that loaded before the module started as settled', async () => {
        await events.eventSource.emit(events.event_types.APP_READY);
        memory.initChatModeMemory();

        memory.recordChatMode('conversation');
        accountStorage.setItem(STORAGE_KEY, 'roleplay');

        expect(memory.getLastChatMode()).toBe('roleplay');
    });

    test('announces the saved mode when settings load and nothing was recorded', async () => {
        memory.initChatModeMemory();
        accountStorage.init({ [STORAGE_KEY]: 'conversation' });

        await events.eventSource.emit(events.event_types.SETTINGS_LOADED);

        expect(memory.getLastChatMode()).toBe('conversation');
        expect(changeListener).toHaveBeenCalledTimes(1);
        expect(changeListener.mock.calls[0][0].detail).toEqual({ mode: 'conversation' });
    });
});

describe('recording from app activity', () => {
    beforeEach(() => {
        memory.initChatModeMemory();
    });

    test('records Conversation when the Conversation workspace opens', () => {
        emitWorkspaceState(true);

        expect(memory.getLastChatMode()).toBe('conversation');
        expect(accountStorage.getItem(STORAGE_KEY)).toBe('conversation');
    });

    test('records nothing when the Conversation workspace closes', () => {
        emitWorkspaceState(true);
        emitWorkspaceState(false);
        emitWorkspaceState(false);

        expect(memory.getLastChatMode()).toBe('conversation');
        expect(changeListener).toHaveBeenCalledTimes(1);
    });

    test('records Roleplay when Home turns off while Conversation is closed', async () => {
        memory.recordChatMode('conversation');
        emitHomeState(true);
        emitHomeState(false);
        await nextTask();

        expect(memory.getLastChatMode()).toBe('roleplay');
        expect(accountStorage.getItem(STORAGE_KEY)).toBe('roleplay');
    });

    test('records nothing when Home turns off because Conversation opened over it', async () => {
        showWelcomePanel();
        emitWorkspaceState(true);
        emitHomeState(false);
        await nextTask();

        expect(memory.getLastChatMode()).toBe('conversation');
        expect(changeListener).toHaveBeenCalledTimes(1);
    });

    test('records nothing when Home turns back on in the same task', async () => {
        memory.recordChatMode('conversation');
        emitHomeState(false);
        showWelcomePanel();
        emitHomeState(true);
        await nextTask();

        expect(memory.getLastChatMode()).toBe('conversation');
    });

    test('records nothing when Home turns on', async () => {
        memory.recordChatMode('conversation');
        emitHomeState(true);
        await nextTask();

        expect(memory.getLastChatMode()).toBe('conversation');
    });

    test('records Roleplay when a chat opens while Conversation is closed', async () => {
        memory.recordChatMode('conversation');

        await events.eventSource.emit(events.event_types.CHAT_CHANGED, 'Seraphina - 2025-01-01');

        expect(memory.getLastChatMode()).toBe('roleplay');
        expect(accountStorage.getItem(STORAGE_KEY)).toBe('roleplay');
    });

    test('keeps Conversation when a chat opens underneath the open Conversation workspace', async () => {
        emitWorkspaceState(true);

        await events.eventSource.emit(events.event_types.CHAT_CHANGED, 'Seraphina - 2025-01-01');

        expect(memory.getLastChatMode()).toBe('conversation');
    });

    test('keeps the mode when the chat closes', async () => {
        memory.recordChatMode('conversation');

        await events.eventSource.emit(events.event_types.CHAT_CHANGED, undefined);
        await events.eventSource.emit(events.event_types.CHAT_CHANGED);

        expect(memory.getLastChatMode()).toBe('conversation');
    });

    test('initialising twice does not record twice', async () => {
        memory.initChatModeMemory();
        emitWorkspaceState(true);

        expect(changeListener).toHaveBeenCalledTimes(1);
    });
});
