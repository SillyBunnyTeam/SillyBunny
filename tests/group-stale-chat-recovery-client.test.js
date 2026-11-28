/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { importGroupChatsModule } from './util/group-chats-module-harness.js';
import { importTabsModule } from './util/tabs-harness.js';

const activeCleanups = [];

afterEach(() => {
    while (activeCleanups.length) activeCleanups.pop()();
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

describe('stale group chat ID client recovery (1527a1d29)', () => {
    // Run the real group-chats.js test BEFORE importTabsModule registers a sticky mock for group-chats.js.
    test('getGroupChat validates groups by normalizing numeric IDs, pruning 404 stale chats, retaining transient errors, and switching stale chat_id to a present chat', async () => {
        const statusByChatId = new Map([
            ['101', { ok: true, status: 200, json: async () => ({ file_name: '101.jsonl' }) }],
            ['stale-active', { ok: false, status: 404 }],
            ['stale-old', { ok: false, status: 404 }],
            ['transient-error', { ok: false, status: 500 }],
        ]);
        const editedGroupPayloads = [];
        const fetchMock = jest.fn(async (url, options = {}) => {
            if (url === '/api/chats/group/info') {
                const { id } = JSON.parse(options.body);
                return statusByChatId.get(String(id)) ?? { ok: false, status: 404 };
            }
            if (url === '/api/groups/edit') {
                editedGroupPayloads.push(JSON.parse(options.body));
                return { ok: true, status: 200, json: async () => ({}) };
            }
            if (url === '/api/chats/group/get') {
                return { ok: true, status: 200, json: async () => [] };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        });

        const { groupChats } = await importGroupChatsModule({
            characters: [{ name: 'Alice', avatar: 'alice.png', first_mes: 'Hi' }],
            fetch: fetchMock,
        });

        const staleGroup = {
            id: 'grp-stale',
            name: 'Stale Group',
            members: ['alice.png'],
            chat_id: 'stale-active',
            chats: [101, '101', 'stale-old', 'stale-active', 'transient-error'],
        };
        const numericGroup = {
            id: 'grp-num',
            name: 'Numeric Group',
            members: ['alice.png'],
            chat_id: 101,
            chats: [101],
        };
        groupChats.groups.push(staleGroup, numericGroup);

        await groupChats.getGroupChat('grp-stale', false, { switchMenu: false });

        expect(staleGroup.chats).not.toContain('stale-old');
        expect(staleGroup.chats).toContain('101');
        expect(staleGroup.chats).toContain('transient-error');
        expect(staleGroup.chat_id).toBe('101');
        expect(editedGroupPayloads.some(payload => payload.id === 'grp-stale' && payload.chat_id === '101')).toBe(true);

        editedGroupPayloads.length = 0;
        await groupChats.getGroupChat('grp-num', false, { switchMenu: false });

        expect(numericGroup.chat_id).toBe('101');
        expect(numericGroup.chats).toEqual(['101']);
        expect(editedGroupPayloads.some(payload => payload.id === 'grp-num' && payload.chat_id === '101')).toBe(true);
    });

    test('bottom chat switcher drops 404 stale group chats while keeping present and non-404 entries', async () => {
        const fetchMock = jest.fn(async (_url, initOrFn) => {
            const options = typeof initOrFn === 'function' ? await initOrFn() : initOrFn;
            const { id } = JSON.parse(options.body);
            if (id === 'stale-404') {
                return { ok: false, status: 404 };
            }
            if (id === 'error-500') {
                return { ok: false, status: 500 };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ file_name: `${id}.jsonl`, last_mes: '2026-04-10' }),
            };
        });

        const group = {
            id: 'grp-1',
            name: 'Stale Group',
            chat_id: 'present-chat',
            chats: ['present-chat', 'stale-404', 'error-500'],
        };

        const loaded = await importTabsModule({
            context: {
                groupId: 'grp-1',
                groups: [group],
                chatId: 'present-chat',
                getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' }),
            },
            mocks: {
                'scripts/csrf-token-refresh.js': {
                    fetchWithCsrfRetry: fetchMock,
                },
            },
        });
        activeCleanups.push(() => loaded.cleanup());

        await loaded.eventSource.emit(loaded.event_types.CHAT_CHANGED, 'present-chat');
        await new Promise(resolve => setTimeout(resolve, 120));
        await loaded.flush();

        const chatSelect = document.querySelector('#sb-bottom-chat-bar select');
        expect(chatSelect).not.toBeNull();
        const optionValues = [...chatSelect.options].map(option => option.value).filter(Boolean);
        expect(optionValues).toEqual(['present-chat', 'error-500']);
    });
});
