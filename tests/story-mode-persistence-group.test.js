/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importGroupChatsModule } from './util/group-chats-module-harness.js';

afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('strict group chat persistence', () => {
    test.each(['group', 123])('waits for group metadata and rejects its HTTP failure instead of scheduling success: %s', async (id) => {
        const fetchMock = jest.fn(async (url) => {
            if (url === '/api/groups/edit') {
                return { ok: false, status: 500, statusText: 'Server Error' };
            }
            if (url === '/api/chats/group/get') {
                return { ok: true, status: 200, json: async () => [{ mes: 'original', extra: {} }] };
            }
            return { ok: true, json: async () => ({ integrity: 'saved' }) };
        });

        const { groupChats, mocks } = await importGroupChatsModule({
            fetch: fetchMock,
            chat: [{ mes: 'original', extra: {} }],
            chat_metadata: {},
            fetchWithCsrfRetry: jest.fn(async (_url, build) => {
                if (typeof build === 'function') await build();
                return { ok: true, json: async () => ({ integrity: 'saved' }) };
            }),
        });

        groupChats.groups.push({ id, chat_id: 'story', chats: ['story'], members: [] });
        await groupChats.openGroupById(id);
        fetchMock.mockClear();

        await expect(groupChats.saveGroupChat(id, true, false, true, { throwOnError: true }))
            .rejects.toThrow('Could not save group');
        expect(fetchMock).toHaveBeenCalledWith('/api/groups/edit', expect.any(Object));

        fetchMock.mockClear();
        mocks.toastr.error.mockClear();

        // Non-strict save schedules a debounced edit and resolves true without throwing.
        await expect(groupChats.saveGroupChat(id, true, false, false)).resolves.toBe(true);
    });

    test('propagates an actual group integrity decline without saving metadata or caches', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (url === '/api/chats/group/get') {
                return { ok: true, status: 200, json: async () => [{ mes: 'original', extra: {} }] };
            }
            return { ok: true, json: async () => ({}) };
        });
        const { groupChats, mocks } = await importGroupChatsModule({
            fetch: fetchMock,
            chat: [{ mes: 'original', extra: {} }],
            chat_metadata: {},
            fetchWithCsrfRetry: jest.fn(async () => ({
                ok: false,
                status: 412,
                json: async () => ({ error: 'integrity' }),
            })),
            popup: {
                Popup: { show: { input: jest.fn(async () => ''), confirm: jest.fn(async () => 0) } },
            },
        });

        groupChats.groups.push({ id: 'group', chat_id: 'story', chats: ['story'], members: [] });
        await groupChats.openGroupById('group');
        fetchMock.mockClear();

        await expect(groupChats.saveGroupChat('group', true, false, true, { throwOnError: true }))
            .resolves.toBe(false);
        await expect(groupChats.saveGroupChat('group', true, false, true))
            .resolves.toBe(false);

        expect(fetchMock.mock.calls.some(([url]) => url === '/api/groups/edit')).toBe(false);
        expect(mocks.popup.Popup.show.input).toHaveBeenCalledTimes(2);
    });
});
