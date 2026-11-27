/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
});

async function setupSeamsRuntime({
    temporary = false,
    leaveImpl = null,
    fetchImpl = null,
} = {}) {
    let isTemp = temporary;
    const log = [];
    const fetchMock = fetchImpl ?? jest.fn(async (url) => {
        if (url === '/api/chats/save') {
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (url === '/api/chats/get') {
            return { ok: true, status: 200, json: async () => [{ chat_metadata: {} }, { name: 'Other', mes: 'Saved greeting', extra: {} }] };
        }
        if (url === '/api/characters/last-chat') {
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (url === '/api/chats/delete') {
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });

    const isTemporaryChat = jest.fn(() => isTemp);
    const isTemporaryChatWith = jest.fn(() => isTemp);
    const beginTemporaryChat = jest.fn((character) => {
        isTemp = true;
        character.chat = 'Temporary Chat: 1';
        log.push('begin');
    });
    const endTemporaryChat = jest.fn(() => {
        isTemp = false;
        log.push('end temporary');
    });
    const leaveTemporaryChat = leaveImpl ?? jest.fn(async () => true);
    const showTemporaryChatError = jest.fn();

    loaded = await importScriptModule({
        fetch: fetchMock,
        mocks: {
            'scripts/sillybunny-temporary-chat-state.js': {
                getStoredChatName: jest.fn(() => 'real-chat'),
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
            'scripts/RossAscends-mods.js': (base) => ({
                ...base,
                humanizedDateTime: jest.fn(() => 'now'),
            }),
        },
    });

    loaded.script.characters.push(
        { name: 'Bunny', avatar: 'bunny.png', chat: 'real-chat', first_mes: 'Hello from the card', data: { extensions: {} } },
        { name: 'Other', avatar: 'other.png', chat: 'other-chat', first_mes: 'Hello from other', data: { extensions: {} } },
    );
    loaded.script.setCharacterId(0);
    loaded.script.setCharacterName('Bunny');

    return {
        ...loaded,
        log,
        fetchMock,
        isTemporaryChat,
        beginTemporaryChat,
        endTemporaryChat,
        leaveTemporaryChat,
        showTemporaryChatError,
        setTemporary: val => { isTemp = val; },
    };
}

describe('leaving a temporary chat through the navigation flush', () => {
    test('flushes pending saves for a normal chat and refuses navigation if flush fails', async () => {
        const runtime = await setupSeamsRuntime({ temporary: false });
        runtime.script.chat.push({ name: 'Bunny', mes: 'pending', extra: {} });
        runtime.script.saveChatDebounced();

        await expect(runtime.script.flushPendingChatSavesForNavigation()).resolves.toBe(true);
        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/save')).toBe(true);
        expect(runtime.leaveTemporaryChat).not.toHaveBeenCalled();

        runtime.fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Failed', json: async () => ({}) });
        runtime.script.saveChatDebounced();
        await expect(runtime.script.flushPendingChatSavesForNavigation()).resolves.toBe(false);
        expect(runtime.toastr.error).toHaveBeenCalled();
    });

    test('asks to leave a temporary chat and flushes nothing, unless leaving saved and ended temporary state', async () => {
        const runtime = await setupSeamsRuntime({ temporary: true });
        runtime.script.chat.push({ name: 'Bunny', mes: 'temp', extra: {} });

        await expect(runtime.script.flushPendingChatSavesForNavigation()).resolves.toBe(true);
        expect(runtime.leaveTemporaryChat).toHaveBeenCalledTimes(1);
        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/save')).toBe(false);
        runtime.cleanup();
        loaded = null;

        // When Save as New Chat clears temporary state during leaveTemporaryChat, pending saves flush normally.
        let savingRuntime;
        savingRuntime = await setupSeamsRuntime({
            temporary: true,
            leaveImpl: jest.fn(async () => {
                savingRuntime.setTemporary(false);
                savingRuntime.script.saveChatDebounced();
                return true;
            }),
        });
        savingRuntime.script.chat.push({ name: 'Bunny', mes: 'saved temp', extra: {} });
        await expect(savingRuntime.script.flushPendingChatSavesForNavigation()).resolves.toBe(true);
        expect(savingRuntime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/save')).toBe(true);
    });

    test('keeps the user in a temporary chat when leaving is declined, and does not ask when staying', async () => {
        const runtime = await setupSeamsRuntime({
            temporary: true,
            leaveImpl: jest.fn(async () => false),
        });

        await expect(runtime.script.flushPendingChatSavesForNavigation()).resolves.toBe(false);
        expect(runtime.leaveTemporaryChat).toHaveBeenCalledTimes(1);

        await expect(runtime.script.flushPendingChatSavesForNavigation({ staying: true })).resolves.toBe(true);
        expect(runtime.leaveTemporaryChat).toHaveBeenCalledTimes(1);
    });
});

describe('recording a chat name for a character', () => {
    test('posts the last chat for a normal chat and records nothing for a temporary chat', async () => {
        const runtime = await setupSeamsRuntime({ temporary: false });

        await runtime.script.updateRemoteChatName('0', 'new-chat');
        expect(runtime.fetchMock).toHaveBeenCalledWith('/api/characters/last-chat', expect.any(Object));
        expect(JSON.parse(runtime.fetchMock.mock.calls[0][1].body)).toEqual({ avatar: 'bunny.png', chat: 'new-chat' });
        expect(runtime.script.characters[0].chat).toBe('new-chat');

        runtime.fetchMock.mockClear();
        runtime.setTemporary(true);
        await runtime.script.updateRemoteChatName('0', 'Temporary Chat: 9');
        expect(runtime.fetchMock).not.toHaveBeenCalled();
        expect(runtime.script.characters[0].chat).toBe('new-chat');
    });
});

describe('scheduling a chat save', () => {
    test('schedules no save timer for a temporary chat and schedules one for a normal chat', async () => {
        jest.useFakeTimers();
        const runtime = await setupSeamsRuntime({ temporary: true });
        runtime.script.chat.push({ name: 'Bunny', mes: 'draft', extra: {} });

        runtime.script.saveChatDebounced();
        await jest.advanceTimersByTimeAsync(5000);
        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/save')).toBe(false);

        runtime.setTemporary(false);
        runtime.script.saveChatDebounced();
        await jest.advanceTimersByTimeAsync(5000);
        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/save')).toBe(true);
    });
});

describe('selecting a character and opening a temporary chat', () => {
    test('opens a saved chat with /api/chats/get, or a temporary chat from memory without reading any chat file', async () => {
        const runtime = await setupSeamsRuntime({ temporary: false });

        await expect(runtime.script.selectCharacterById(1, { switchMenu: false })).resolves.toBe(true);
        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/get')).toBe(true);

        runtime.fetchMock.mockClear();
        await expect(runtime.script.selectCharacterById(0, { temporary: true, switchMenu: false })).resolves.toBe(true);
        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/chats/get')).toBe(false);
        expect(runtime.beginTemporaryChat).toHaveBeenCalledTimes(1);
        expect(runtime.script.characters[0].chat).toBe('Temporary Chat: 1');
        expect(runtime.script.chat.map(m => m.mes)).toEqual(['Hello from the card']);
    });

    test('starts a fresh temporary chat with the already selected character and respects declined leave', async () => {
        const runtime = await setupSeamsRuntime({ temporary: false });
        runtime.script.chat.push({ name: 'Bunny', mes: 'left over', extra: {} });

        await expect(runtime.script.selectCharacterById(0, { temporary: true, switchMenu: false })).resolves.toBe(true);
        expect(runtime.script.chat.map(m => m.mes)).toEqual(['Hello from the card']);
        expect(runtime.fetchMock).not.toHaveBeenCalled();

        // When already in a temporary chat and leaving is declined, switching to another character refuses.
        runtime.leaveTemporaryChat.mockResolvedValueOnce(false);
        await expect(runtime.script.selectCharacterById(1, { temporary: true, switchMenu: false })).resolves.toBe(false);
        expect(runtime.script.this_chid).toBe('0');

        // Reselecting the already open character passes staying: true and does not prompt to leave.
        runtime.leaveTemporaryChat.mockClear();
        const accepted = jest.fn();
        await expect(runtime.script.selectCharacterById(0, { onAccepted: accepted, switchMenu: false })).resolves.toBe(true);
        expect(accepted).toHaveBeenCalledTimes(1);
        expect(runtime.leaveTemporaryChat).not.toHaveBeenCalled();
    });

    test('ends the temporary chat and reports failure when opening throws', async () => {
        const runtime = await setupSeamsRuntime({ temporary: false });
        // Force beginTemporaryChat to throw after entering getTemporaryChat, or force printMessages failure via invalid template.
        runtime.beginTemporaryChat.mockImplementationOnce(() => {
            throw new Error('render failed');
        });

        await expect(runtime.script.selectCharacterById(0, { temporary: true, switchMenu: false })).resolves.toBe(false);
        expect(runtime.endTemporaryChat).toHaveBeenCalled();
        expect(runtime.showTemporaryChatError).toHaveBeenCalledTimes(1);
    });
});

describe('clearing the chat', () => {
    test('stores itemized prompts for a normal chat, ends a temporary chat only on clearData=true', async () => {
        const runtime = await setupSeamsRuntime({ temporary: true });

        await runtime.script.clearChat({ clearData: false });
        expect(runtime.endTemporaryChat).not.toHaveBeenCalled();

        await runtime.script.clearChat({ clearData: true });
        expect(runtime.endTemporaryChat).toHaveBeenCalledTimes(1);

        // After ending temporary chat, clearing a normal chat does not call endTemporaryChat again.
        runtime.endTemporaryChat.mockClear();
        await runtime.script.clearChat({ clearData: true });
        expect(runtime.endTemporaryChat).not.toHaveBeenCalled();
    });
});

describe('starting a new chat', () => {
    test('deletes the current chat for a normal chat, but never deletes the character real chat when temporary', async () => {
        const runtimeNormal = await setupSeamsRuntime({ temporary: false });
        runtimeNormal.script.setMenuType('character_edit');
        await runtimeNormal.script.doNewChat({ deleteCurrentChat: true });
        const deleteCall = runtimeNormal.fetchMock.mock.calls.find(([url]) => url === '/api/chats/delete');
        expect(deleteCall).toBeTruthy();
        expect(JSON.parse(deleteCall[1].body).chatfile).toBe('real-chat.jsonl');
        runtimeNormal.cleanup();
        loaded = null;

        const runtimeTemp = await setupSeamsRuntime({ temporary: true });
        runtimeTemp.script.setMenuType('character_edit');
        await runtimeTemp.script.doNewChat({ deleteCurrentChat: true });
        expect(runtimeTemp.fetchMock.mock.calls.some(([url]) => url === '/api/chats/delete')).toBe(false);
        expect(runtimeTemp.fetchMock.mock.calls.some(([url]) => url === '/api/chats/get')).toBe(true);
    });
});
