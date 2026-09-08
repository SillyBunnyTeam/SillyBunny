import { describe, expect, jest, test } from '@jest/globals';
import { createChatSaveConfirmer } from '../public/scripts/extensions/quick-image-gen/lib/host-persistence.js';
import { persistChatState, persistLockedBackgroundState } from '../public/scripts/extensions/quick-image-gen/lib/chat-transaction.js';

function createContext(groupId = null) {
    return {
        chatId: 'review-chat',
        groupId,
        characterId: 0,
        characters: groupId ? [] : [{ name: 'Review', avatar: 'review.png' }],
        chat: [{ mes: 'Review fixture', is_user: false }],
        chatMetadata: {
            integrity: 'before-save',
            custom_background: 'old-background',
            chat_backgrounds: ['old-background'],
            extension: { integrity: 'intended-extension-value' },
        },
        saveChat: jest.fn(async () => undefined),
        saveMetadata: jest.fn(async () => undefined),
    };
}

function chatResponse(context, metadata = context.chatMetadata) {
    return Response.json([{ chat_metadata: metadata }, ...context.chat]);
}

describe.each([['character', null], ['group', 'review-group']])('%s chat readback', (_type, groupId) => {
    for (const metadataOnly of [false, true]) {
        test(`confirms header-format saves (metadataOnly=${metadataOnly})`, async () => {
            const context = createContext(groupId);
            const saved = structuredClone(context.chatMetadata);
            saved.integrity = 'after-save';
            const response = chatResponse(context, saved);
            const headers = { 'Content-Type': 'application/json' };
            const fetchImpl = jest.fn(async () => response);
            const confirm = createChatSaveConfirmer({ context, metadataOnly, fetchImpl, getRequestHeaders: () => headers });

            context.chatId = 'another-chat';
            context.chat[0].mes = 'Later edit';
            context.chatMetadata.custom_background = 'later-background';
            context.characters.forEach(character => { character.avatar = 'another.png'; });

            await expect(confirm()).resolves.toBe(true);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(fetchImpl.mock.calls[0][0]).toBe(groupId ? '/api/chats/group/get' : '/api/chats/get');
            expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', headers, cache: 'no-store' });
            expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(groupId
                ? { id: 'review-chat' }
                : { ch_name: 'Review', file_name: 'review-chat', avatar_url: 'review.png' });
            expect(context.chatMetadata.integrity).toBe('before-save');
        });
    }

    for (const [label, changes] of [
        ['background', { custom_background: 'wrong-background' }],
        ['background list', { chat_backgrounds: ['wrong-background'] }],
        ['nested integrity', { extension: { integrity: 'wrong-extension-value' } }],
        ['missing requested field', { custom_background: undefined }],
    ]) {
        test(`rejects changed ${label} despite a rotated host token`, async () => {
            const context = createContext(groupId);
            const fetchImpl = jest.fn(async () => chatResponse(context, {
                ...context.chatMetadata,
                integrity: 'after-save',
                ...changes,
            }));
            await expect(createChatSaveConfirmer({ context, metadataOnly: true, fetchImpl })()).resolves.toBe(false);
        });
    }

    test('rejects changed messages and missing or invalid headers', async () => {
        const context = createContext(groupId);
        for (const payload of [
            [{ chat_metadata: context.chatMetadata }, { mes: 'Wrong message', is_user: false }],
            context.chat,
            [],
            [{ chat_metadata: null }, ...context.chat],
            [{ chat_metadata: [] }, ...context.chat],
        ]) {
            const fetchImpl = jest.fn(async () => Response.json(payload));
            await expect(createChatSaveConfirmer({ context, fetchImpl })()).resolves.toBe(false);
        }
    });

    test('keeps a locked background when the host rotates integrity', async () => {
        const context = createContext(groupId);
        let saved;
        context.saveMetadata.mockImplementation(async () => {
            saved = { ...structuredClone(context.chatMetadata), integrity: 'after-save' };
            context.chatMetadata.integrity = saved.integrity;
        });
        const fetchImpl = jest.fn(async () => chatResponse(context, saved));
        await expect(persistLockedBackgroundState(context, {
            cssUrl: 'new-background',
            path: 'new-background',
            fetchImpl,
        })).resolves.toBe(true);
        expect(context.saveMetadata).toHaveBeenCalledTimes(1);
        expect(saved).toEqual({
            integrity: 'after-save',
            custom_background: 'new-background',
            chat_backgrounds: ['old-background', 'new-background'],
            extension: { integrity: 'intended-extension-value' },
        });
        expect(context.chatMetadata).toEqual(saved);
    });

    test('rejects and rolls back an unconfirmed background change', async () => {
        const context = createContext(groupId);
        const saved = structuredClone(context.chatMetadata);
        const fetchImpl = jest.fn(async () => chatResponse(context, saved));
        await expect(persistLockedBackgroundState(context, {
            cssUrl: 'unsaved-background',
            path: 'unsaved-background',
            fetchImpl,
        })).rejects.toThrow('Chat metadata persistence reported failure');
        expect(context.saveMetadata).toHaveBeenCalledTimes(2);
        expect(context.chatMetadata).toEqual(saved);
    });

    test('rejects a target change during confirmation', async () => {
        const context = createContext(groupId);
        const fetchImpl = jest.fn(async () => {
            context.chatId = 'another-chat';
            return chatResponse(context);
        });
        await expect(persistChatState(context, {
            fetchImpl,
            isCurrent: () => context.chatId === 'review-chat',
        })).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('does not confirm an explicitly failed save or save a stale target', async () => {
        const context = createContext(groupId);
        const fetchImpl = jest.fn();
        context.saveChat.mockResolvedValue(false);
        await expect(persistChatState(context, { fetchImpl })).rejects.toThrow('Persistence reported failure');
        await expect(persistChatState(context, { fetchImpl, isCurrent: () => false, skipIfStale: true })).resolves.toBe(false);
        expect(context.saveChat).toHaveBeenCalledTimes(1);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('chat readback boundaries', () => {
    for (const [label, respond] of [
        ['HTTP failure', () => new Response('', { status: 500 })],
        ['network failure', () => { throw new Error('Offline'); }],
        ['invalid JSON', () => new Response('not-json')],
        ['oversized response', () => new Response('', { headers: { 'Content-Length': String(2 * 1024 * 1024) } })],
    ]) {
        test(`returns false for ${label}`, async () => {
            await expect(createChatSaveConfirmer({ context: createContext(), fetchImpl: async () => respond() })()).resolves.toBe(false);
        });
    }

    test('aborts a timed-out readback and returns false', async () => {
        let requestSignal;
        const fetchImpl = jest.fn((_url, { signal }) => {
            requestSignal = signal;
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        });
        await expect(createChatSaveConfirmer({ context: createContext(), fetchImpl, timeoutMs: 0 })()).resolves.toBe(false);
        expect(requestSignal.aborted).toBe(true);
    });

    test('budgets the complete group chat for metadata readback', async () => {
        const context = createContext('review-group');
        context.chat[0].mes = 'x'.repeat(1024 * 1024);
        const fetchImpl = jest.fn(async () => chatResponse(context));
        await expect(createChatSaveConfirmer({ context, metadataOnly: true, fetchImpl })()).resolves.toBe(true);
    });

    test('refuses missing targets and missing intended metadata without fetching', async () => {
        const fetchImpl = jest.fn();
        for (const context of [
            { ...createContext(), chatId: '' },
            { ...createContext(), characters: [] },
            { ...createContext(), chatMetadata: undefined },
        ]) {
            await expect(createChatSaveConfirmer({ context, metadataOnly: true, fetchImpl })()).resolves.toBe(false);
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
