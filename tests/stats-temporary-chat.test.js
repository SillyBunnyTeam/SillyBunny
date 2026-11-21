/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/lib.js', () => ({ moment: () => ({}) }));
await jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}), characters: [], this_chid: '0' }));
await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ humanizeGenTime: () => '' }));
await jest.unstable_mockModule('../public/scripts/popup.js', () => ({ callGenericPopup: jest.fn(), POPUP_TYPE: {} }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ registerDebugFunction: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (strings, ...values) => String.raw({ raw: strings }, ...values), translate: value => value }));

globalThis.toastr = { error: jest.fn() };
globalThis.fetch = jest.fn(async url => ({ ok: true, status: 200, json: async () => (url === '/api/stats/get' ? {} : {}) }));

const { statMesProcess } = await import('../public/scripts/stats.js');
const temporaryChat = await import('../public/scripts/sillybunny-temporary-chat-state.js');

const characters = [{ name: 'Seraphina', avatar: 'Seraphina.png' }];
const userMessage = { is_user: true, mes: 'Hello there', send_date: 'now' };
const requestedUrls = () => globalThis.fetch.mock.calls.map(([url]) => url);

afterEach(() => {
    temporaryChat.exitTemporaryState();
    globalThis.fetch.mockClear();
});

describe('message statistics', () => {
    test('counts a message of a normal chat with one stats request after reading the stats', async () => {
        await statMesProcess(userMessage, 'user', characters, '0', '');

        expect(requestedUrls()).toEqual(['/api/stats/get', '/api/stats/update']);
    });

    test('counts nothing for a temporary chat, because the chat is not kept', async () => {
        temporaryChat.enterTemporaryState({ avatar: 'Seraphina.png', previousChatName: 'Seraphina - 2026' });

        await statMesProcess(userMessage, 'user', characters, '0', '');
        await statMesProcess({ is_user: false, mes: 'Reply' }, 'swipe', characters, '0', '');

        expect(requestedUrls()).toEqual([]);
    });
});
