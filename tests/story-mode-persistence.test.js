/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
});

async function setupPersistenceRuntime({ group = false, fetchImpl = null, saveGroupChat = null, popupInput = '' } = {}) {
    const fetchMock = fetchImpl ?? jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
    }));
    const saveGroupChatMock = saveGroupChat ?? jest.fn(async () => true);

    loaded = await importScriptModule({
        fetch: fetchMock,
        mocks: {
            'scripts/group-chats.js': {
                selected_group: group ? 'group' : null,
                groups: group ? [{ id: 'group', chat_id: 'story', chats: ['story'] }] : [],
                saveGroupChat: saveGroupChatMock,
            },
            'scripts/popup.js': {
                Popup: {
                    show: {
                        input: jest.fn(async () => popupInput),
                        confirm: jest.fn(async () => 0),
                    },
                },
            },
        },
    });

    loaded.script.characters.push({ name: 'Story', avatar: 'story.png', chat: 'story', data: { extensions: {} } });
    if (!group) {
        loaded.script.setCharacterId(0);
        loaded.script.setCharacterName('Story');
    }
    loaded.script.chat.push({ name: 'Story', mes: 'original', extra: {}, is_user: false });

    return { ...loaded, fetchMock, saveGroupChatMock };
}

describe('strict host chat saves', () => {
    test('returns success and forwards strict options for character chat', async () => {
        const runtime = await setupPersistenceRuntime({ group: false });
        const options = { throwOnError: true, deferBackup: true, allowShrink: true };

        await expect(runtime.script.saveMetadata(options)).resolves.toBe(true);

        const saveCall = runtime.fetchMock.mock.calls.find(([url]) => url === '/api/chats/save');
        expect(saveCall).toBeTruthy();
        const body = JSON.parse(saveCall[1].body);
        expect(body.file_name).toBe('story');
        expect(body.avatar_url).toBe('story.png');
        expect(body.allowShrink).toBe(true);
        expect(body.deferBackup).toBe(true);
        expect(runtime.script.isChatSaving).toBe(false);
    });

    test('returns success and forwards strict options for group chat', async () => {
        const runtime = await setupPersistenceRuntime({ group: true });
        const options = { throwOnError: true, deferBackup: true, allowShrink: true };

        await expect(runtime.script.saveMetadata(options)).resolves.toBe(true);

        expect(runtime.saveGroupChatMock).toHaveBeenCalledWith('group', true, false, true, options);
        expect(runtime.script.isChatSaving).toBe(false);
    });

    test.each([false, undefined])('rejects a lower group helper refusal (%s), while default callers receive false', async (result) => {
        const runtime = await setupPersistenceRuntime({
            group: true,
            saveGroupChat: jest.fn(async () => result),
        });

        await expect(runtime.script.saveChatConditional({ throwOnError: true })).rejects.toThrow('Chat was not saved');
        await expect(runtime.script.saveChatConditional()).resolves.toBe(false);
        expect(runtime.mocks['scripts/tokenizers.js'].saveTokenCache).not.toHaveBeenCalled();
        expect(runtime.script.isChatSaving).toBe(false);
    });

    test('preserves the original rejection and the default swallow behaviour', async () => {
        const error = new Error('network failure');
        const runtime = await setupPersistenceRuntime({
            group: true,
            saveGroupChat: jest.fn(async () => { throw error; }),
        });

        await expect(runtime.script.saveMetadata({ throwOnError: true })).rejects.toBe(error);
        await expect(runtime.script.saveMetadata()).resolves.toBe(false);
        expect(runtime.script.isChatSaving).toBe(false);
    });

    test.each(['http', 'integrity', 'missing'])('executes the queued character save through a real %s refusal', async (failure) => {
        const fetchMock = jest.fn(async () => ({
            ok: false,
            status: failure === 'integrity' ? 412 : 500,
            statusText: 'failure',
            json: async () => ({ error: failure }),
        }));
        const runtime = await setupPersistenceRuntime({ group: false, fetchImpl: fetchMock, popupInput: '' });
        if (failure === 'missing') {
            runtime.script.characters[0].chat = '';
        }

        await expect(runtime.script.saveMetadata({ throwOnError: true })).rejects.toThrow();
        await expect(runtime.script.saveMetadata()).resolves.toBe(false);
        expect(runtime.mocks['scripts/tokenizers.js'].saveTokenCache).not.toHaveBeenCalled();
        expect(runtime.script.isChatSaving).toBe(false);
    });
});
