/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    delete document.documentElement.dataset.sbSettingsOpen;
    jest.restoreAllMocks();
});

async function setupTemporaryNavRuntime({
    temporary = false,
    temporaryWith = false,
    leaveResult = true,
    fetchImpl = null,
    bootReady = false,
    settingsOpen = false,
} = {}) {
    if (settingsOpen) {
        document.documentElement.dataset.sbSettingsOpen = 'true';
    } else {
        delete document.documentElement.dataset.sbSettingsOpen;
    }

    let isTemp = temporary;
    let isTempWith = temporaryWith;
    let settingsVersion = 1;
    const log = [];
    const fetchMock = fetchImpl ?? jest.fn(async (url) => {
        if (url === '/api/settings/get') {
            return { ok: true, status: 200, json: async () => ({ settings: JSON.stringify({ _version: settingsVersion }) }) };
        }
        if (url === '/api/settings/save') {
            settingsVersion += 1;
            return { ok: true, status: 200, json: async () => ({ version: settingsVersion }) };
        }
        if (url === '/api/chats/get') {
            return { ok: true, status: 200, json: async () => [{ chat_metadata: {} }] };
        }
        if (url === '/api/chats/save') {
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (url === '/api/characters/rename') {
            log.push('rename request');
            return { ok: false, status: 500, statusText: 'Error', json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });

    const isTemporaryChat = jest.fn(() => isTemp);
    const isTemporaryChatWith = jest.fn(() => isTempWith);
    const beginTemporaryChat = jest.fn((character) => {
        isTemp = true;
        isTempWith = true;
        character.chat = 'Temporary Chat: 1';
        log.push('begin');
    });
    const endTemporaryChat = jest.fn(() => {
        isTemp = false;
        isTempWith = false;
        log.push('end');
    });
    const leaveTemporaryChat = jest.fn(async () => {
        log.push('leave');
        return leaveResult;
    });
    const showTemporaryChatError = jest.fn();

    loaded = await importScriptModule({
        keepReal: ['scripts/chat-reload-guard.js'],
        fetch: fetchMock,
        mocks: {
            'scripts/sillybunny-temporary-chat-state.js': {
                getStoredChatName: jest.fn(() => 'bunny-chat'),
                isTemporaryChat,
                isTemporaryChatWith,
                reassertReservedChatName: jest.fn(),
            },
            'scripts/sillybunny-temporary-chat.js': {
                beginTemporaryChat,
                endTemporaryChat,
                leaveTemporaryChat,
                showTemporaryChatError,
            },
            'scripts/utils.js': {
                delay: jest.fn(async () => {}),
            },
            'scripts/tags.js': {
                getTagKeyForEntity: jest.fn(value => (typeof value === 'string' ? value : (value?.avatar ?? ''))),
            },
            'scripts/sillybunny-settings-sync.js': {
                createSettingsSync: () => ({
                    getFingerprint: json => json,
                    remember() {},
                    isSynced: () => false,
                }),
            },
        },
    });

    if (bootReady) {
        await loaded.runReady();
        fetchMock.mockClear();
    }

    loaded.script.characters.push(
        { name: 'Bunny', avatar: 'bunny.png', chat: 'bunny-chat', first_mes: 'Hello from the card', data: { extensions: {} } },
        { name: 'Seraphina', avatar: 'seraphina.png', chat: 'seraphina-chat', first_mes: 'Hi', data: { extensions: {} } },
    );
    loaded.script.setCharacterId(0);
    loaded.script.setCharacterName('Bunny');

    return {
        ...loaded,
        log,
        fetchMock,
        isTemporaryChat,
        isTemporaryChatWith,
        beginTemporaryChat,
        endTemporaryChat,
        leaveTemporaryChat,
        showTemporaryChatError,
        setTemporary: (val, withCurrent = val) => {
            isTemp = val;
            isTempWith = withCurrent;
        },
    };
}

describe('reloading the open chat', () => {
    test('redraws a temporary chat from memory when the selected character is the one it is with', async () => {
        const runtime = await setupTemporaryNavRuntime({ temporary: true, temporaryWith: true });
        runtime.script.chat.push({ name: 'Bunny', is_user: false, is_system: false, mes: 'temporary message', extra: {} });

        await runtime.script.reloadCurrentChatUnsafe();

        expect(document.querySelectorAll('#chat > .mes')).toHaveLength(1);
        expect(document.querySelector('#chat > .mes .mes_text').textContent).toContain('temporary message');
        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/get')).toBe(false);
        expect(runtime.endTemporaryChat).not.toHaveBeenCalled();
        expect(runtime.isTemporaryChatWith).toHaveBeenCalledWith('bunny.png');
    });

    test('ends a temporary chat that belongs to another character and reloads the selected one from its file', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const runtime = await setupTemporaryNavRuntime({
            temporary: true,
            temporaryWith: false,
            fetchImpl: jest.fn(async (url) => {
                if (url === '/api/chats/get') {
                    return { ok: false, status: 404, json: async () => [] };
                }
                return { ok: true, status: 200, json: async () => ({}) };
            }),
        });
        runtime.script.chat.push({ name: 'Other', is_user: false, is_system: false, mes: 'temporary message', extra: {} });

        await runtime.script.reloadCurrentChatUnsafe();

        expect(runtime.endTemporaryChat).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalled();
        const getCall = runtime.fetchMock.mock.calls.find(([url]) => url === '/api/chats/get');
        expect(getCall).toBeTruthy();
        expect(JSON.parse(getCall[1].body)).toMatchObject({ file_name: 'bunny-chat', avatar_url: 'bunny.png' });
    });

    test('drops the prompts of the temporary chat it ends, while keeping prompts of a normal chat', async () => {
        const runtimeTemp = await setupTemporaryNavRuntime({
            temporary: true,
            temporaryWith: false,
            fetchImpl: jest.fn(async (url) => {
                if (url === '/api/chats/get') {
                    return { ok: true, status: 200, json: async () => [{ chat_metadata: {} }, { name: 'Bunny', mes: 'from disk', extra: {} }] };
                }
                return { ok: true, status: 200, json: async () => ({}) };
            }),
        });
        const savedPromptsTemp = [];
        runtimeTemp.mocks['scripts/RossAscends-mods.js'].saveItemizedPrompts?.mockImplementation?.(() => {});
        runtimeTemp.script.itemizedPrompts.push({ mesId: 1 });
        await runtimeTemp.script.reloadCurrentChatUnsafe();
        expect(runtimeTemp.script.itemizedPrompts).toHaveLength(0);
        expect(savedPromptsTemp).toEqual([]);
        runtimeTemp.cleanup();
        loaded = null;

        const runtimeNormal = await setupTemporaryNavRuntime({
            temporary: false,
            fetchImpl: jest.fn(async (url) => {
                if (url === '/api/chats/get') {
                    return { ok: true, status: 200, json: async () => [{ chat_metadata: {} }, { name: 'Bunny', mes: 'from disk', extra: {} }] };
                }
                return { ok: true, status: 200, json: async () => ({}) };
            }),
        });
        runtimeNormal.script.itemizedPrompts.push({ mesId: 1 });
        await runtimeNormal.script.reloadCurrentChatUnsafe();
        // Normal chat passes its prompts through clearChat (which stores them under the chat id) before reloading.
        expect(runtimeNormal.endTemporaryChat).not.toHaveBeenCalled();
        expect(runtimeNormal.fetchMock.mock.calls.some(([url]) => url === '/api/chats/get')).toBe(true);
    });

    test('ends a temporary chat when no character is selected', async () => {
        const runtime = await setupTemporaryNavRuntime({ temporary: true, temporaryWith: false });
        runtime.script.setCharacterId(undefined);

        await runtime.script.reloadCurrentChatUnsafe();

        expect(runtime.endTemporaryChat).toHaveBeenCalledTimes(1);
    });

    test('reloads a normal chat from its file', async () => {
        const runtime = await setupTemporaryNavRuntime({ temporary: false });

        await runtime.script.reloadCurrentChatUnsafe();

        expect(runtime.endTemporaryChat).not.toHaveBeenCalled();
        expect(runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/chats/get')).toHaveLength(1);
    });
});

describe('flushing the chat for a cache clear or a rename', () => {
    test('saves the open chat for a normal chat', async () => {
        const runtime = await setupTemporaryNavRuntime({ temporary: false });
        runtime.script.chat.push({ name: 'Bunny', mes: 'hello', extra: {} });

        await expect(runtime.script.flushPendingChatSaves({ silent: true })).resolves.toBe(true);

        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/save')).toBe(true);
    });

    test('reports success for a temporary chat without saving or toasting', async () => {
        const runtime = await setupTemporaryNavRuntime({ temporary: true });
        runtime.script.chat.push({ name: 'Bunny', mes: 'temp', extra: {} });

        await expect(runtime.script.flushPendingChatSaves()).resolves.toBe(true);

        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/save')).toBe(false);
        expect(runtime.toastr.info).not.toHaveBeenCalled();
        expect(runtime.toastr.error).not.toHaveBeenCalled();
    });
});

describe('renaming the open character', () => {
    test('asks to leave a temporary chat before the character is renamed on the server', async () => {
        const runtime = await setupTemporaryNavRuntime({ temporary: true, leaveResult: true });
        runtime.script.setCharacterId(1);
        runtime.script.setCharacterName('Seraphina');

        await runtime.script.renameCharacter('Serafina', { silent: true });

        expect(runtime.log.slice(0, 2)).toEqual(['leave', 'rename request']);
    });

    test('does not rename anything when the user declines to leave the temporary chat', async () => {
        const runtime = await setupTemporaryNavRuntime({ temporary: true, leaveResult: false });
        runtime.script.setCharacterId(1);
        runtime.script.setCharacterName('Seraphina');

        await expect(runtime.script.renameCharacter('Serafina', { silent: true })).resolves.toBe(false);

        expect(runtime.fetchMock).not.toHaveBeenCalled();
    });

    test('does not ask anything for a normal chat', async () => {
        const runtime = await setupTemporaryNavRuntime({ temporary: false });
        runtime.script.setCharacterId(1);
        runtime.script.setCharacterName('Seraphina');

        await runtime.script.renameCharacter('Serafina', { silent: true });

        expect(runtime.leaveTemporaryChat).not.toHaveBeenCalled();
        expect(runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/characters/rename')).toHaveLength(1);
    });
});

describe('settings payload', () => {
    test('names the active character for a normal chat, and omits it for a temporary chat', async () => {
        const runtime = await setupTemporaryNavRuntime({ temporary: false, bootReady: true });
        runtime.script.setActiveCharacter('seraphina.png');

        await expect(runtime.script.saveSettings(0, { returnResult: true })).resolves.toBe(true);
        const normalCall = runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/settings/save').at(-1);
        expect(JSON.parse(normalCall[1].body).active_character).toBe('seraphina.png');

        runtime.setTemporary(true);
        await expect(runtime.script.saveSettings(0, { returnResult: true })).resolves.toBe(true);
        const tempCall = runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/settings/save').at(-1);
        expect(JSON.parse(tempCall[1].body).active_character).toBeNull();
    });
});

describe('opening a chat and opening a temporary chat', () => {
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));

    test('a temporary chat announces itself in the same order as a chat read from its file', async () => {
        const savedEvents = [];
        const saved = await setupTemporaryNavRuntime({ temporary: false });
        for (const name of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'CHAT_LOADED']) {
            saved.eventSource.on(saved.script.event_types[name], () => savedEvents.push(name));
        }
        await saved.script.getChat();
        saved.cleanup();
        loaded = null;

        const tempEvents = [];
        const temporary = await setupTemporaryNavRuntime({ temporary: false });
        for (const name of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'CHAT_LOADED']) {
            temporary.eventSource.on(temporary.script.event_types[name], () => tempEvents.push(name));
        }
        await temporary.script.selectCharacterById(0, { temporary: true, switchMenu: false });

        expect(savedEvents).toEqual(['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'CHAT_LOADED']);
        expect(tempEvents).toEqual(savedEvents);
    });

    test('both put the cursor in the message box once the page settles, unless a settings page is open', async () => {
        const saved = await setupTemporaryNavRuntime({ temporary: false, settingsOpen: false });
        await saved.script.getChat();
        await settle();
        expect(document.activeElement).toBe(document.getElementById('send_textarea'));
        saved.cleanup();
        loaded = null;

        const temporary = await setupTemporaryNavRuntime({ temporary: false, settingsOpen: false });
        await temporary.script.selectCharacterById(0, { temporary: true, switchMenu: false });
        await settle();
        expect(document.activeElement).toBe(document.getElementById('send_textarea'));
        temporary.cleanup();
        loaded = null;

        const savedSettings = await setupTemporaryNavRuntime({ temporary: false, settingsOpen: true });
        await savedSettings.script.getChat();
        await settle();
        expect(document.activeElement).not.toBe(document.getElementById('send_textarea'));
        savedSettings.cleanup();
        loaded = null;

        const tempSettings = await setupTemporaryNavRuntime({ temporary: false, settingsOpen: true });
        await tempSettings.script.selectCharacterById(0, { temporary: true, switchMenu: false });
        await settle();
        expect(document.activeElement).not.toBe(document.getElementById('send_textarea'));
    });
});
