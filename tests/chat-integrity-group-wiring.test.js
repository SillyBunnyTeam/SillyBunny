/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fetchWithCsrfRetry as realFetchWithCsrfRetry } from '../public/scripts/csrf-token-refresh.js';
import { importGroupChatsModule } from './util/group-chats-module-harness.js';

afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('public/scripts/group-chats.js integrity, save queue, navigation, and CSRF retry wiring', () => {
    test('queues group chat saves, adopts active integrity only, and runs 412 forced overwrite inside the active task', async () => {
        const events = [];
        let releaseFirstSave = null;
        let saveAttempt = 0;

        const fetchMock = jest.fn(async (url, init) => {
            const target = String(url);
            if (target === '/api/chats/group/get') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => [
                        { chat_metadata: { integrity: 'group-initial' } },
                        { name: 'Alice', is_user: false, mes: 'hello' },
                    ],
                    text: async () => '',
                };
            }
            if (target === '/api/chats/group/save') {
                const body = JSON.parse(init.body);
                saveAttempt++;
                events.push({
                    attempt: saveAttempt,
                    id: body.id,
                    force: Boolean(body.force),
                    deferBackup: Boolean(body.deferBackup),
                    mes: body.chat[1]?.mes,
                    integrity: body.chat[0]?.chat_metadata?.integrity,
                });
                if (saveAttempt === 1) {
                    await new Promise(resolve => { releaseFirstSave = resolve; });
                    return { ok: false, status: 412, json: async () => ({ error: 'integrity' }), text: async () => '' };
                }
                if (saveAttempt === 2) {
                    return { ok: true, status: 200, json: async () => ({ integrity: 'group-forced-int' }), text: async () => '' };
                }
                return { ok: true, status: 200, json: async () => ({ integrity: `group-int-${saveAttempt}` }), text: async () => '' };
            }
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        });

        const { groupChats, state } = await importGroupChatsModule({
            fetch: fetchMock,
            popup: {
                Popup: Object.assign(jest.fn(() => ({ show: jest.fn(async () => 1) })), {
                    show: {
                        confirm: jest.fn(async () => 1),
                        input: jest.fn(async () => 'OVERWRITE'),
                    },
                }),
                POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
                callGenericPopup: jest.fn(async () => 1),
            },
        });

        groupChats.groups.push(
            { id: 'group-1', name: 'Group One', chat_id: 'chat-1', chats: ['chat-1'], members: ['alice.png'] },
            { id: 'group-2', name: 'Group Two', chat_id: 'chat-2', chats: ['chat-2'], members: ['bob.png'] },
        );
        await groupChats.openGroupById('group-1');
        state.chat.splice(0, state.chat.length, { name: 'Alice', is_user: false, mes: 'first group pass' });
        state.chat_metadata.integrity = 'group-initial';

        const firstSave = groupChats.saveGroupChat('group-1', false, false, false, { deferBackup: true });
        for (let i = 0; i < 30 && !releaseFirstSave; i++) {
            await Promise.resolve();
        }
        state.chat[0].mes = 'second group pass';
        const secondSave = groupChats.saveGroupChat('group-1', false, false, false, {});

        releaseFirstSave();
        await expect(firstSave).resolves.toBe(true);
        await expect(secondSave).resolves.toBe(true);

        expect(events).toEqual([
            { attempt: 1, id: 'chat-1', force: false, deferBackup: true, mes: 'first group pass', integrity: 'group-initial' },
            { attempt: 2, id: 'chat-1', force: true, deferBackup: true, mes: 'first group pass', integrity: 'group-initial' },
            { attempt: 3, id: 'chat-1', force: false, deferBackup: false, mes: 'second group pass', integrity: 'group-forced-int' },
        ]);
        expect(state.chat_metadata.integrity).toBe('group-int-3');

        // Saving a non-active group aborts instead of overwriting the active group's chat_metadata.integrity.
        await expect(groupChats.saveGroupChat('group-2', false, false, false, {})).resolves.toBe(false);
        expect(state.chat_metadata.integrity).toBe('group-int-3');
    });

    test('openGroupById waits for flushPendingChatSavesForNavigation instead of refusing during an active save', async () => {
        let releaseFlush = null;
        const flushPendingChatSavesForNavigation = jest.fn(() => new Promise(resolve => { releaseFlush = resolve; }));

        const fetchMock = jest.fn(async (url) => {
            if (String(url) === '/api/chats/group/get') {
                return { ok: true, status: 200, json: async () => [{ chat_metadata: { integrity: 'g1' } }], text: async () => '' };
            }
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        });

        const { groupChats } = await importGroupChatsModule({
            fetch: fetchMock,
            script: {
                is_send_press: false,
                flushPendingChatSavesForNavigation,
            },
        });
        groupChats.groups.push({ id: 'group-1', name: 'Group One', chat_id: 'chat-1', chats: ['chat-1'], members: ['alice.png'] });

        let opened = false;
        const opening = groupChats.openGroupById('group-1').then(() => { opened = true; });
        for (let i = 0; i < 30 && !releaseFlush; i++) {
            await Promise.resolve();
        }
        expect(flushPendingChatSavesForNavigation).toHaveBeenCalledTimes(1);
        expect(opened).toBe(false);

        releaseFlush(true);
        await opening;
        expect(opened).toBe(true);
        expect(groupChats.selected_group).toBe('group-1');
    });

    test('retries group chat load and info requests after stale CSRF before integrity metadata is initialized', async () => {
        const csrfCalls = [];
        let getAttempts = 0;
        let infoAttempts = 0;
        const refreshCsrfToken = jest.fn(async () => {});

        const staleCsrfResponse = () => ({
            ok: false,
            status: 403,
            clone() { return this; },
            text: async () => 'Invalid CSRF token',
            json: async () => ({}),
        });

        const retryFetchMock = jest.fn(async (url) => {
            const target = String(url);
            if (target === '/api/chats/group/get') {
                getAttempts++;
                if (getAttempts === 1) {
                    return staleCsrfResponse();
                }
                return {
                    ok: true,
                    status: 200,
                    clone() { return this; },
                    json: async () => [{ chat_metadata: { integrity: 'csrf-retried' } }],
                    text: async () => '',
                };
            }
            if (target === '/api/chats/group/info') {
                infoAttempts++;
                if (infoAttempts === 1) {
                    return staleCsrfResponse();
                }
                return {
                    ok: true,
                    status: 200,
                    clone() { return this; },
                    json: async () => ({ file_size: 456 }),
                    text: async () => '',
                };
            }
            return { ok: true, status: 200, clone() { return this; }, json: async () => ({}), text: async () => '' };
        });

        const { groupChats, state } = await importGroupChatsModule({
            fetch: retryFetchMock,
            script: { refreshCsrfToken },
            fetchWithCsrfRetry: jest.fn(async (url, buildInit, opts) => {
                csrfCalls.push({ url, hasRefresh: opts?.refreshCsrfToken === refreshCsrfToken });
                return realFetchWithCsrfRetry(url, buildInit, { ...opts, fetchFn: retryFetchMock });
            }),
        });

        groupChats.groups.push({
            id: 'group-csrf',
            name: 'CSRF Group',
            chat_id: 'csrf-chat',
            chats: ['csrf-chat'],
            members: ['alice.png'],
        });

        await groupChats.openGroupById('group-csrf');
        expect(getAttempts).toBe(2);
        expect(infoAttempts).toBe(2);
        expect(refreshCsrfToken).toHaveBeenCalledTimes(2);
        expect(csrfCalls).toContainEqual({ url: '/api/chats/group/get', hasRefresh: true });
        expect(csrfCalls).toContainEqual({ url: '/api/chats/group/info', hasRefresh: true });
        expect(state.chat_metadata.integrity).toBe('csrf-retried');
    });
});
