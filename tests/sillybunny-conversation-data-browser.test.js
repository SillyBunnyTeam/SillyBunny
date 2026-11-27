/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const download = jest.fn();
const requests = [];
const answers = new Map();

await jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' }) }));
await jest.unstable_mockModule('../public/scripts/request-compression.js', () => ({ compressRequest: async init => init }));
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({ download }));

const { conversationData, downloadConversationChat, fetchJson, installConversationDataHooks, reloadPageOnce } = await import('../public/scripts/sillybunny-conversation/conversation-data-browser.js');

function respond(path, { status = 200, json = {}, text = null, headers = {} } = {}) {
    answers.set(path, { status, json, text, headers });
}

beforeEach(() => {
    requests.length = 0;
    answers.clear();
    respond('/list', { json: { conversations: [] } });
    respond('/characters/get', { json: { version: 1, characters: {} } });
    globalThis.window = { addEventListener: jest.fn() };
    globalThis.document = { addEventListener: jest.fn(), visibilityState: 'visible' };
    globalThis.fetch = jest.fn(async (url, init) => {
        const path = String(url).replace('/api/sillybunny-conversation', '');
        requests.push({ path, init });
        const answer = answers.get(path) ?? { status: 404, json: { error: 'not_found' }, text: null, headers: {} };
        return {
            status: answer.status,
            headers: { get: name => answer.headers[name.toLowerCase()] ?? null },
            json: async () => answer.json,
            text: async () => answer.text ?? JSON.stringify(answer.json),
        };
    });
});

afterEach(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.fetch;
    download.mockClear();
});

describe('the hooks of the page', () => {
    test('read the list again after a character or a persona was deleted, or a character was renamed', async () => {
        const handlers = new Map();
        const eventSource = { on: (name, handler) => handlers.set(name, handler) };

        installConversationDataHooks({
            eventSource,
            settingsLoaded: 'settings_loaded',
            refreshOn: ['characterDeleted', 'characterRenamed', 'persona_deleted'],
            getModeObject: () => null,
        });
        handlers.get('settings_loaded')();
        await conversationData.whenReady();
        requests.length = 0;

        for (const name of ['characterDeleted', 'characterRenamed', 'persona_deleted']) {
            handlers.get(name)();
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        expect(requests.filter(request => request.path === '/list')).toHaveLength(3);
    });
});

describe('the download of a chat', () => {
    test('saves the file that the server answered under the name that it gave', async () => {
        respond('/chat/export', { text: '{"chat_metadata":{}}\n{"mes":"hi"}\n', headers: { 'content-disposition': 'attachment; filename="Trip day 1.jsonl"' } });
        await conversationData.start();
        await conversationData.loadChat({ conversationId: 'conv_1_direct01', chatId: 'main' }).catch(() => {});

        await downloadConversationChat({ conversationId: 'conv_1_direct01', chatId: 'main' });

        expect(download).toHaveBeenCalledWith('{"chat_metadata":{}}\n{"mes":"hi"}\n', 'Trip day 1.jsonl', 'application/x-ndjson');
        const request = requests.find(item => item.path === '/chat/export');
        expect(JSON.parse(request.init.body)).toEqual({ id: 'conv_1_direct01', chatId: 'main' });
        expect(request.init.method).toBe('POST');
        expect(request.init.headers['X-CSRF-Token']).toBe('token');
    });

    test('reads a file name that the server sent in the encoded form', async () => {
        respond('/chat/export', { text: '{}\n', headers: { 'content-disposition': 'attachment; filename="Caf_.jsonl"; filename*=UTF-8\'\'Caf%C3%A9.jsonl' } });

        await downloadConversationChat({ conversationId: 'conv_1_direct01', chatId: 'main' });

        expect(download.mock.calls[0][1]).toBe('Café.jsonl');
    });

    test('rejects with the code of the route, and downloads nothing, when the chat is not there', async () => {
        respond('/chat/export', { status: 404, json: { error: 'not_found' } });

        await expect(downloadConversationChat({ conversationId: 'conv_1_direct01', chatId: 'gone' })).rejects.toMatchObject({ code: 'not_found', status: 404 });

        expect(download).not.toHaveBeenCalled();
    });
});

describe('browser adapter safety', () => {
    afterEach(() => {
        delete globalThis.sessionStorage;
    });

    test('reloadPageOnce returns true on the first reload and false when suppressed or storage throws', () => {
        const reload = jest.fn();
        globalThis.window = { addEventListener: jest.fn(), location: { reload } };
        const store = new Map();
        globalThis.sessionStorage = {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
        };

        expect(reloadPageOnce('test_reload_flag')).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(reloadPageOnce('test_reload_flag')).toBe(false);
        expect(reload).toHaveBeenCalledTimes(1);

        globalThis.sessionStorage = {
            getItem: () => {
                throw new Error('storage blocked');
            },
            setItem: () => {},
        };
        expect(reloadPageOnce('test_reload_flag_2')).toBe(false);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('fetchJson serializes the request body before awaiting dynamic imports', async () => {
        respond('/chat/save', { json: { ok: true } });
        const payload = { id: 'conv_1_direct01', chat: [{ mes: 'before' }] };

        const pending = fetchJson('/chat/save', payload);
        payload.chat[0].mes = 'mutated synchronously after call';
        await pending;

        const sent = requests.find(item => item.path === '/chat/save');
        expect(JSON.parse(sent.init.body)).toEqual({ id: 'conv_1_direct01', chat: [{ mes: 'before' }] });
    });
});
