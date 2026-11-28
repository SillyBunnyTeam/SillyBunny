/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

let activeRuntime = null;

afterEach(() => {
    activeRuntime?.cleanup();
    activeRuntime = null;
    jest.restoreAllMocks();
});

async function createSaveRuntime({ holdFirstFetch = false, isTemporary = false } = {}) {
    let releaseFirstFetch = null;
    const isTemporaryChat = jest.fn(() => isTemporary);
    const fetchMock = jest.fn(async (url, init) => {
        if (String(url) === '/api/chats/save' && holdFirstFetch && fetchMock.mock.calls.filter(([u]) => u === '/api/chats/save').length === 1) {
            await new Promise(resolve => { releaseFirstFetch = resolve; });
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ integrity: 'saved' }),
            text: async () => '',
        };
    });

    const loaded = await importScriptModule({
        fetch: fetchMock,
        keepReal: ['scripts/chat-save-guard.js', 'scripts/chat-backup-sequence.js'],
        mocks: {
            'scripts/sillybunny-temporary-chat-state.js': {
                getStoredChatName: () => '',
                isTemporaryChat,
                isTemporaryChatWith: () => false,
                reassertReservedChatName: jest.fn(),
            },
        },
    });
    activeRuntime = loaded;

    const { script } = loaded;
    script.characters.push({ name: 'Bunny', avatar: 'bunny.png', chat: 'original-chat' });
    script.setCharacterId(0);
    script.setCharacterName('Bunny');
    script.chat.push({ mes: 'queued message', extra: { value: 'queued' } });
    script.updateChatMetadata({ integrity: 'original' }, true);

    let blocker = null;
    if (holdFirstFetch) {
        blocker = script.saveChat({ chatName: 'blocker-chat' });
        for (let i = 0; i < 20 && !releaseFirstFetch; i++) {
            await Promise.resolve();
        }
    }

    const saveCalls = () => fetchMock.mock.calls.filter(([u]) => u === '/api/chats/save');

    return {
        script,
        fetchMock,
        saveCalls,
        toastr: loaded.toastr,
        isTemporaryChat,
        async releaseQueue() {
            releaseFirstFetch?.();
            await blocker;
        },
    };
}

describe('real chat save queue', () => {
    test('snapshots legacy positional saves before they wait in the queue', async () => {
        const { script, saveCalls, releaseQueue } = await createSaveRuntime({ holdFirstFetch: true });
        jest.spyOn(console, 'trace').mockImplementation(() => {});
        const save = script.saveChat('copy-chat', { label: 'queued metadata' }, 0, false, true);
        script.chat[0].mes = 'later message';
        script.chat[0].extra.value = 'later';
        script.chat_metadata.label = 'later metadata';
        await releaseQueue();

        await expect(save).resolves.toBe(true);
        const payload = JSON.parse(saveCalls()[1][1].body);
        expect(payload).toMatchObject({
            file_name: 'copy-chat',
            avatar_url: 'bunny.png',
            chat: [{ chat_metadata: { label: 'queued metadata' } }, { mes: 'queued message', extra: { value: 'queued' } }],
        });
    });

    test('legacy callers can omit the filename and save the active chat', async () => {
        const { script, saveCalls, releaseQueue } = await createSaveRuntime({ holdFirstFetch: true });
        jest.spyOn(console, 'trace').mockImplementation(() => {});
        const save = script.saveChat(undefined, { label: 'legacy' });
        await releaseQueue();

        await expect(save).resolves.toBe(true);
        expect(JSON.parse(saveCalls()[1][1].body).file_name).toBe('original-chat');
    });

    test('invalidates legacy positional saves after a swipe or chat reload', async () => {
        const { script, saveCalls, releaseQueue } = await createSaveRuntime({ holdFirstFetch: true });
        jest.spyOn(console, 'trace').mockImplementation(() => {});
        const save = script.saveChat('original-chat', {}, undefined, false, true);
        await script.clearChat({ clearData: true });
        await releaseQueue();

        await expect(save).resolves.toBe(false);
        expect(saveCalls()).toHaveLength(1);
    });

    test('posts /api/chats/save once for each save of the open chat', async () => {
        const { script, saveCalls } = await createSaveRuntime();

        await expect(script.saveChat()).resolves.toBe(true);
        expect(saveCalls()).toHaveLength(1);
        expect(saveCalls()[0][0]).toBe('/api/chats/save');
        await expect(script.saveChat()).resolves.toBe(true);
        expect(saveCalls()).toHaveLength(2);
        expect(JSON.parse(saveCalls()[1][1].body)).toMatchObject({ file_name: 'original-chat', avatar_url: 'bunny.png' });
    });

    test('declines to save a chat with no character and no file name, without a request', async () => {
        const { script, saveCalls } = await createSaveRuntime();
        script.setCharacterId(undefined);
        script.setCharacterName('Assistant');

        await expect(script.saveChat()).resolves.toBe(false);
        expect(saveCalls()).toHaveLength(0);
    });

    test('declines to save a character chat that has no file name, without a request', async () => {
        const { script, saveCalls } = await createSaveRuntime();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        script.characters[0].chat = '';

        await expect(script.saveChat()).resolves.toBe(false);
        expect(saveCalls()).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith('saveChat called without chat_name and no chat file found');
    });

    test('writes nothing for a temporary chat, whatever file name the save names', async () => {
        const { script, saveCalls, toastr } = await createSaveRuntime({ isTemporary: true });

        await expect(script.saveChat()).resolves.toBe(false);
        await expect(script.saveChat({ chatName: 'copy-chat', withMetadata: {}, throwOnError: true })).resolves.toBe(false);
        expect(saveCalls()).toHaveLength(0);
        expect(toastr.error).not.toHaveBeenCalled();
    });

    test('saves again once the chat is no longer temporary', async () => {
        const { script, saveCalls, isTemporaryChat } = await createSaveRuntime();
        isTemporaryChat.mockReturnValueOnce(true);

        await expect(script.saveChat()).resolves.toBe(false);
        await expect(script.saveChat()).resolves.toBe(true);
        expect(saveCalls()).toHaveLength(1);
    });

    test('invalidates object saves after a character switch without writing a new file', async () => {
        const { script, saveCalls, releaseQueue } = await createSaveRuntime({ holdFirstFetch: true });
        const save = script.saveChat();
        script.characters.push({ name: 'Other', avatar: 'other.png', chat: 'other-chat' });
        script.setCharacterId(1);
        await releaseQueue();

        await expect(save).resolves.toBe(false);
        expect(saveCalls()).toHaveLength(1);
    });
});
