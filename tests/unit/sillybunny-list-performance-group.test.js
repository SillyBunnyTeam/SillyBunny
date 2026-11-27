/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importGroupChatsModule } from '../util/group-chats-module-harness.js';

afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('group chat navigation acceptance boundary', () => {
    async function setupGroupNav({ same = false, flushImpl = null, isSendPress = false } = {}) {
        const order = [];
        let activeFlushImpl = null;
        const flush = jest.fn(async () => {
            if (activeFlushImpl) return activeFlushImpl(order);
            order.push('flush');
            return true;
        });
        const fetchMock = jest.fn(async (url) => {
            if (url === '/api/chats/group/get') {
                order.push('fetch');
                return { ok: true, status: 200, json: async () => [{ chat_metadata: {} }, { name: 'Alice', mes: 'hi', extra: {} }] };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        });

        const loaded = await importGroupChatsModule({
            fetch: fetchMock,
            is_send_press: isSendPress,
            script: {
                flushPendingChatSavesForNavigation: flush,
                setCharacterId: jest.fn(() => order.push('mutate')),
            },
        });
        loaded.groupChats.groups.push(
            { id: 'a', name: 'Group A', chat_id: 'chat-a', chats: ['chat-a'], members: [] },
            { id: 'b', name: 'Group B', chat_id: 'chat-b', chats: ['chat-b'], members: [] },
        );
        if (same) {
            await loaded.groupChats.openGroupById('b', { switchMenu: false });
        } else {
            await loaded.groupChats.openGroupById('a', { switchMenu: false });
        }
        order.length = 0;
        flush.mockClear();
        activeFlushImpl = flushImpl;
        return { ...loaded, order, flush };
    }

    test('group accepts once, after flush and before any selection mutation or fetch', async () => {
        let finish;
        const harness = await setupGroupNav({
            flushImpl: (order) => new Promise(resolve => {
                finish = () => {
                    order.push('flush');
                    resolve(true);
                };
            }),
        });

        const accepted = jest.fn(() => harness.order.push('accepted'));
        const pending = harness.groupChats.openGroupById('b', { switchMenu: false, onAccepted: accepted });
        expect(accepted).not.toHaveBeenCalled();
        expect(harness.order).toEqual([]);

        finish();
        expect(await pending).toBe(true);
        expect(accepted).toHaveBeenCalledTimes(1);
        expect(harness.order.slice(0, 3)).toEqual(['flush', 'accepted', 'mutate']);
        expect(harness.order.at(-1)).toBe('fetch');
    });

    test('group current-chat acceptance also flushes, while default callers retain the upstream path', async () => {
        const harness = await setupGroupNav({ same: true });
        const accepted = jest.fn(() => harness.order.push('accepted'));

        expect(await harness.groupChats.openGroupById('b', { switchMenu: false, onAccepted: accepted })).toBe(true);
        expect(accepted).toHaveBeenCalledTimes(1);
        expect(harness.order.slice(0, 2)).toEqual(['flush', 'accepted']);

        harness.flush.mockClear();
        expect(await harness.groupChats.openGroupById('b', { switchMenu: false })).toBe(true);
        expect(harness.flush).not.toHaveBeenCalled();
    });

    test('group never accepts a missing, send-blocked, or failed-flush selection', async () => {
        const harness = await setupGroupNav();
        const accepted = jest.fn();

        expect(await harness.groupChats.openGroupById('missing', { onAccepted: accepted })).toBe(false);

        harness.flush.mockResolvedValueOnce(false);
        expect(await harness.groupChats.openGroupById('b', { onAccepted: accepted })).toBe(false);
        expect(accepted).not.toHaveBeenCalled();

        const sendBlocked = await setupGroupNav({ isSendPress: true });
        expect(await sendBlocked.groupChats.openGroupById('b', { onAccepted: accepted })).toBe(false);
        expect(accepted).not.toHaveBeenCalled();
    });
});
