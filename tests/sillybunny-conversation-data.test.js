import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    ChatNotLoadedError,
    createConversationData,
    FREQUENT_DELAY_MS,
    FREQUENT_MAX_WAIT_MS,
    MAX_LOADED_CHATS,
    mergePatches,
    RETRY_DELAYS_MS,
} from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { header, line, PERSONA, recordCalls, scriptedAdapter, seedConversations, settle, startConversationServer } from './util/conversation-data-fixture.js';

const { loadChat: loadStoredChat, readConversation, saveChat: saveStoredChat, readCharacterState } = await import('../src/conversation-store.js');

let server;
let adapter;
let data;
let events;

beforeEach(async () => {
    server = await startConversationServer();
    events = [];
});

afterEach(async () => {
    data?.destroy();
    await server.stop();
    jest.restoreAllMocks();
});

async function started(descriptors = [], overrides = {}) {
    seedConversations(server, descriptors);
    adapter = recordCalls(server.adapter(overrides));
    data = createConversationData(adapter);
    data.subscribe(event => events.push(event));
    await data.start();
    await data.whenReady();
    return data;
}

const DIRECT = { id: 'conv_1_direct01', characters: ['Nova.png'], chats: [{ id: 'main', name: 'Main', messages: ['hello', 'hi there', 'how are you'], readThrough: 'main-0' }] };
const GROUP = { id: 'conv_2_group001', characters: ['Nova.png', 'Orion.png'], name: 'Trip', chats: [{ id: 'main', messages: ['one'] }] };
const ADDRESS = { conversationId: 'conv_1_direct01', chatId: 'main' };

const message = (id, mes, extra = {}) => ({ ...line(id, mes, { minute: Number(id.replace(/\D/g, '')) || 0 }), ...extra });

describe('start', () => {
    test('reads the list and the state of the characters in one go, and is ready', async () => {
        await started([DIRECT, GROUP]);

        expect(adapter.paths().sort()).toEqual(['/characters/get', '/list']);
        expect(data.status().state).toBe('ready');
        expect(data.list().map(view => view.id)).toEqual(['conv_1_direct01', 'conv_2_group001']);
        expect(data.get('conv_1_direct01')).toMatchObject({ kind: 'direct', messageCount: 3, unread: 1, preview: 'how are you', lastMessageRole: 'character', hasUserMessage: true });
        expect(data.get('conv_1_direct01').chats[0]).toMatchObject({ id: 'main', name: 'Main', unread: 1 });
    });

    test('lists the conversations of one persona, newest message first', async () => {
        await started([DIRECT, { ...GROUP, personaId: 'other.png' }]);

        expect(data.list({ personaId: PERSONA }).map(view => view.id)).toEqual(['conv_1_direct01']);
        expect(data.list({ personaId: 'other.png' }).map(view => view.id)).toEqual(['conv_2_group001']);
    });

    test('is idempotent and starts the requests once', async () => {
        await started([DIRECT]);
        await data.start();

        expect(adapter.callsTo('/list')).toHaveLength(1);
    });

    test('answers whenReady to a caller that asks before start', async () => {
        seedConversations(server, [DIRECT]);
        data = createConversationData(server.adapter());
        let ready = false;
        const waiting = data.whenReady().then(() => {
            ready = true;
        });
        await settle(2);
        expect(ready).toBe(false);

        await data.start();
        await waiting;

        expect(ready).toBe(true);
    });

    test('says failed with the time of the next try while the migration waits, and tries again then', async () => {
        const answers = [
            { status: 503, json: { error: 'migration_failed' } },
            { status: 503, json: { error: 'migration_failed' } },
            { status: 200, json: { conversations: [], problems: [] } },
        ];
        const scripted = scriptedAdapter((path) => {
            if (path === '/migration/status') {
                return { status: 200, json: { state: 'failed', error: { code: 'write_failed', message: 'Disk full' }, retryAfterMs: 60_000 } };
            }
            if (path === '/characters/get') {
                return { status: 200, json: { version: 1, characters: {} } };
            }
            return answers.shift() ?? { status: 200, json: { conversations: [], problems: [] } };
        });
        data = createConversationData(scripted);
        data.subscribe(event => events.push(event));

        await data.start();

        expect(data.status()).toMatchObject({ state: 'failed', code: 'write_failed', retryAt: scripted.now() + 60_000 });
        await scripted.clock.advance(60_000);
        await settle();
        expect(data.status()).toMatchObject({ state: 'failed' });
        answers.length = 0;
        await scripted.clock.advance(60_000);
        await settle();
        expect(data.status().state).toBe('ready');
    });

    test('reloads the page once when the migration ran after the settings were read and the settings are old', async () => {
        const reloadPage = jest.fn();
        const scripted = scriptedAdapter((path) => {
            if (path === '/migration/status') {
                return { status: 200, json: { state: 'migrated', report: {} } };
            }
            if (path === '/characters/get') {
                return { status: 200, json: { version: 1, characters: {} } };
            }
            return { status: 503, json: { error: 'migration_failed' } };
        }, { isSettingsStale: () => true, reloadPage });
        data = createConversationData(scripted);

        await data.start();

        expect(reloadPage).toHaveBeenCalledTimes(1);
        expect(data.status().state).not.toBe('ready');
    });

    test('says failed and tries again after a network failure', async () => {
        let up = false;
        const scripted = scriptedAdapter(async (path) => {
            if (!up) {
                throw new Error('offline');
            }
            return path === '/list' ? { status: 200, json: { conversations: [], problems: [] } } : { status: 200, json: { version: 1, characters: {} } };
        });
        data = createConversationData(scripted);

        await data.start();
        expect(data.status()).toMatchObject({ state: 'failed', code: 'network' });

        up = true;
        await scripted.clock.advance(RETRY_DELAYS_MS[1]);
        await settle();
        expect(data.status().state).toBe('ready');
    });
});

describe('resolve and find', () => {
    beforeEach(async () => {
        await started([DIRECT, { ...GROUP, chats: [{ id: 'main', messages: ['one'] }, { id: 'later', messages: ['two'] }], activeChatId: 'later' }]);
    });

    test('a direct conversation is found by persona and avatar, and a group by its id', () => {
        expect(data.resolve({ avatar: 'Nova.png', personaId: PERSONA })).toEqual(ADDRESS);
        expect(data.resolve({ avatar: 'Nova.png', groupId: 'conv_2_group001', personaId: PERSONA })).toEqual({ conversationId: 'conv_2_group001', chatId: 'later' });
        expect(data.findDirect(PERSONA, 'Nova.png').id).toBe('conv_1_direct01');
    });

    test('takes the chat that is named when the conversation has it, and the active chat otherwise', () => {
        expect(data.resolve({ avatar: 'Nova.png', groupId: 'conv_2_group001', personaId: PERSONA, chatId: 'main' }).chatId).toBe('main');
        expect(data.resolve({ avatar: 'Nova.png', groupId: 'conv_2_group001', personaId: PERSONA, chatId: 'ghost' }).chatId).toBe('later');
    });

    test('is null for a conversation that does not exist, another persona, or a direct id used as a group', () => {
        expect(data.resolve({ avatar: 'Ghost.png', personaId: PERSONA })).toBeNull();
        expect(data.resolve({ avatar: 'Nova.png', personaId: 'other.png' })).toBeNull();
        expect(data.resolve({ avatar: 'Nova.png', groupId: 'conv_1_direct01', personaId: PERSONA })).toBeNull();
        expect(data.get('nope')).toBeNull();
    });

    test('adds up the unread counts of a persona over the conversations that the caller accepts', () => {
        expect(data.totalUnread(PERSONA)).toBe(data.get('conv_1_direct01').unread + data.get('conv_2_group001').unread);
        expect(data.totalUnread(PERSONA, view => view.kind === 'group')).toBe(data.get('conv_2_group001').unread);
        expect(data.totalUnread('other.png')).toBe(0);
    });
});

describe('loadChat', () => {
    test('loads a chat once, however many callers ask at the same time', async () => {
        await started([DIRECT]);

        const [first, second] = await Promise.all([data.loadChat(ADDRESS), data.loadChat(ADDRESS)]);
        await data.loadChat(ADDRESS);

        expect(first).toBe(second);
        expect(adapter.callsTo('/chat/get')).toHaveLength(1);
        expect(first.messages.map(item => item.id)).toEqual(['main-0', 'main-1', 'main-2']);
        expect(data.chat(ADDRESS)).toBe(first);
    });

    test('answers null for a chat that is not loaded, and throws for a write to it', async () => {
        await started([DIRECT]);

        expect(data.chat(ADDRESS)).toBeNull();
        expect(() => data.commitChat(ADDRESS, () => {})).toThrow(ChatNotLoadedError);
    });

    test('rejects with the code of the route for a chat that does not exist', async () => {
        await started([DIRECT]);

        await expect(data.loadChat({ conversationId: 'conv_1_direct01', chatId: 'ghost' })).rejects.toMatchObject({ code: 'not_found', status: 404 });
        expect(data.chat({ conversationId: 'conv_1_direct01', chatId: 'ghost' })).toBeNull();
    });

    test('works out the summary of a loaded chat from its messages, as the server does', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);

        const fromServer = (await adapter.fetchJson('/list', {})).json.conversations[0];
        expect(data.get('conv_1_direct01')).toMatchObject({ messageCount: fromServer.messageCount, unread: fromServer.unread, preview: fromServer.preview, lastMessageAt: fromServer.lastMessageAt });
    });

    test(`keeps at most ${MAX_LOADED_CHATS} chats that nothing needs, and never the open, dirty or saving ones`, async () => {
        const chats = Array.from({ length: MAX_LOADED_CHATS + 4 }, (_, index) => ({ id: `c${index}`, messages: ['x'] }));
        await started([{ id: 'conv_3_manychat', characters: ['Nova.png'], chats }]);
        const address = index => ({ conversationId: 'conv_3_manychat', chatId: `c${index}` });
        // The server refuses saves, so that the chat that was changed stays dirty.
        const original = adapter.fetchJson;
        adapter.fetchJson = async (path, body, options) => (path === '/chat/save' ? { status: 400, json: { error: 'invalid_input' } } : original(path, body, options));
        await data.loadChat(address(0));
        data.setOpen(address(0));
        await data.loadChat(address(1));
        data.commitChat(address(1), (draft) => {
            draft.messages.push(message('z9', 'unsaved'));
        });

        for (let index = 2; index < chats.length; index++) {
            await data.loadChat(address(index));
        }

        expect(data.chat(address(0))).not.toBeNull();
        expect(data.chat(address(1))).not.toBeNull();
        const loaded = chats.filter((_, index) => data.chat(address(index)));
        // The open chat and the unsaved one are kept on top of the ones that fit.
        expect(loaded).toHaveLength(MAX_LOADED_CHATS + 2);
        expect(data.chat(address(2))).toBeNull();
    });
});

describe('saving messages', () => {
    test('an append is saved at once as the whole chat with the slug of the load, and the new slug is kept', async () => {
        await started([DIRECT]);
        const loaded = await data.loadChat(ADDRESS);
        const firstSlug = loaded.header.chat_metadata.integrity;

        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(message('main-3', 'fine, thanks'));
        });
        await data.flush();

        const saves = adapter.callsTo('/chat/save');
        expect(saves).toHaveLength(1);
        expect(saves[0].body).toMatchObject({ id: 'conv_1_direct01', chatId: 'main' });
        expect(saves[0].body.chat).toHaveLength(5);
        expect(saves[0].body.allowShrink).toBeUndefined();
        expect(loadStoredChat(server.user, 'conv_1_direct01', 'main').at(-1).mes).toBe('fine, thanks');
        expect(loaded.header.chat_metadata.integrity).toBeTruthy();
        expect(loaded.header.chat_metadata.integrity).not.toBe(firstSlug);
        const slugAfterFirstSave = loaded.header.chat_metadata.integrity;

        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(message('main-4', 'bye'));
        });
        await data.flush();
        expect(adapter.callsTo('/chat/save')[1].body.chat[0].chat_metadata.integrity).toBe(slugAfterFirstSave);
        expect(loadStoredChat(server.user, 'conv_1_direct01', 'main')).toHaveLength(6);
    });

    test('changes made in one tick are one request', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);

        for (const id of ['a1', 'a2', 'a3']) {
            data.commitChat(ADDRESS, (draft) => {
                draft.messages.push(message(id, id));
            });
        }
        await data.flush();

        expect(adapter.callsTo('/chat/save')).toHaveLength(1);
        expect(loadStoredChat(server.user, 'conv_1_direct01', 'main')).toHaveLength(7);
    });

    test('a change made while a save is in flight waits, and is sent once, with the latest state', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const original = adapter.fetchJson;
        adapter.fetchJson = async (path, body, options) => {
            if (path === '/chat/save' && adapter.callsTo('/chat/save').length === 0) {
                adapter.calls.push({ path, body: structuredClone(body), options });
                await gate;
                return server.adapter().fetchJson(path, body, options);
            }
            return original(path, body, options);
        };

        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(message('b1', 'one'));
        });
        await settle(3);
        for (const id of ['b2', 'b3', 'b4']) {
            data.commitChat(ADDRESS, (draft) => {
                draft.messages.push(message(id, id));
            });
        }
        await settle(3);
        expect(adapter.callsTo('/chat/save')).toHaveLength(1);
        release();
        await data.flush();

        expect(adapter.callsTo('/chat/save')).toHaveLength(2);
        expect(loadStoredChat(server.user, 'conv_1_direct01', 'main').map(item => item.id).slice(-4)).toEqual(['b1', 'b2', 'b3', 'b4']);
    });

    test('edits and deletes are saved too, and a declared shrink is sent as allowShrink', async () => {
        const messages = Array.from({ length: 12 }, (_, index) => `message ${index}`);
        await started([{ id: 'conv_4_longchat1', characters: ['Nova.png'], chats: [{ id: 'main', messages }] }]);
        const address = { conversationId: 'conv_4_longchat1', chatId: 'main' };
        await data.loadChat(address);

        data.commitChat(address, (draft) => {
            draft.messages[0].mes = 'edited';
        });
        await data.flush();
        data.commitChat(address, (draft) => {
            draft.messages.splice(3);
        }, { shrink: true });
        await data.flush();

        const saves = adapter.callsTo('/chat/save');
        expect(saves.map(call => call.body.allowShrink)).toEqual([undefined, true]);
        expect(loadStoredChat(server.user, 'conv_4_longchat1', 'main')).toHaveLength(4);
        expect(loadStoredChat(server.user, 'conv_4_longchat1', 'main')[1].mes).toBe('edited');
    });

    test('a shrink that the caller did not declare is refused by the server, the file stays, and the chat is read again', async () => {
        const messages = Array.from({ length: 12 }, (_, index) => `message ${index}`);
        await started([{ id: 'conv_4_longchat1', characters: ['Nova.png'], chats: [{ id: 'main', messages }] }]);
        const address = { conversationId: 'conv_4_longchat1', chatId: 'main' };
        const loaded = await data.loadChat(address);

        data.commitChat(address, (draft) => {
            draft.messages.splice(2);
        });
        await data.flush();

        expect(loadStoredChat(server.user, 'conv_4_longchat1', 'main')).toHaveLength(13);
        expect(loaded.messages).toHaveLength(12);
        expect(events.some(event => event.type === 'error' && event.code === 'destructive')).toBe(true);
    });

    test('a save that is refused as stale merges what only this page wrote into the server copy and saves again', async () => {
        await started([DIRECT]);
        const loaded = await data.loadChat(ADDRESS);
        // Another tab saves a reply, so that the slug of this page is stale.
        const stored = loadStoredChat(server.user, 'conv_1_direct01', 'main');
        await saveStoredChat(server.user, 'conv_1_direct01', 'main', [...stored, message('main-9', 'from another tab')]);

        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(message('main-3', 'written here'));
        });
        await data.flush();

        const onDisk = loadStoredChat(server.user, 'conv_1_direct01', 'main');
        expect(onDisk.slice(1).map(item => item.id)).toEqual(['main-0', 'main-1', 'main-2', 'main-3', 'main-9'].sort((a, b) => (a === 'main-9' ? 1 : a.localeCompare(b))).slice(0, 5));
        expect(onDisk.some(item => item.mes === 'written here')).toBe(true);
        expect(onDisk.some(item => item.mes === 'from another tab')).toBe(true);
        expect(loaded.messages.map(item => item.id)).toEqual(onDisk.slice(1).map(item => item.id));
        expect(events.find(event => event.type === 'conflict')).toMatchObject({ appended: 1, lostEdits: 0, lostDeletes: 0 });
    });

    test('says how many local edits a rebase lost', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);
        const stored = loadStoredChat(server.user, 'conv_1_direct01', 'main');
        stored[1] = { ...stored[1], mes: 'edited in the other tab' };
        await saveStoredChat(server.user, 'conv_1_direct01', 'main', stored);

        data.commitChat(ADDRESS, (draft) => {
            draft.messages[0].mes = 'edited here';
        });
        await data.flush();

        expect(events.find(event => event.type === 'conflict')).toMatchObject({ appended: 0, lostEdits: 1 });
        expect(data.chat(ADDRESS).messages[0].mes).toBe('edited in the other tab');
        expect(loadStoredChat(server.user, 'conv_1_direct01', 'main')[1].mes).toBe('edited in the other tab');
    });

    test('drops the conversation from the cache and says so when the server no longer has it', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);
        await adapter.fetchJson('/delete', { id: 'conv_1_direct01' });

        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(message('main-3', 'late'));
        });
        await data.flush();
        await settle();

        expect(events.some(event => event.type === 'error' && event.code === 'not_found')).toBe(true);
        expect(data.get('conv_1_direct01')).toBeNull();
        expect(data.chat(ADDRESS)).toBeNull();
    });

    test('keeps the chat and tries again after 2, 5 and 15 seconds when the server fails', async () => {
        let failures = 3;
        const scripted = scriptedAdapter((path, body) => {
            switch (path) {
                case '/list': return { status: 200, json: { conversations: [{ id: 'conv_1_direct01', kind: 'direct', personaId: PERSONA, characters: ['Nova.png'], extras: [], name: '', description: '', avatar: '', favorite: false, settings: {}, activeChatId: 'main', chats: [{ id: 'main', name: 'Main', createdAt: 1, readThrough: '', followupCount: 0, lastAutoMessageAt: 0, lastActivity: 0, sessionMarkers: {}, messageCount: 0, lastMessageAt: 0, preview: '', unread: 0, lastMessageRole: '', hasUserMessage: false }], reminders: [], createdAt: 1, updatedAt: 1, legacyKey: '' }], problems: [] } };
                case '/characters/get': return { status: 200, json: { version: 1, characters: {} } };
                case '/chat/get': return { status: 200, json: { chat: [header({ integrity: 's0' })] } };
                case '/chat/save':
                    if (failures-- > 0) {
                        return { status: 500, json: { error: 'internal' } };
                    }
                    return { status: 200, json: { ok: true, integrity: `slug${body.chat.length}` } };
                default: return { status: 200, json: {} };
            }
        });
        data = createConversationData(scripted);
        data.subscribe(event => events.push(event));
        await data.start();
        await data.loadChat(ADDRESS);

        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(message('x1', 'hello'));
        });
        await settle();
        expect(scripted.callsTo('/chat/save')).toHaveLength(1);
        await scripted.clock.advance(RETRY_DELAYS_MS[0] - 1);
        expect(scripted.callsTo('/chat/save')).toHaveLength(1);
        await scripted.clock.advance(1);
        expect(scripted.callsTo('/chat/save')).toHaveLength(2);
        await scripted.clock.advance(RETRY_DELAYS_MS[1]);
        expect(scripted.callsTo('/chat/save')).toHaveLength(3);
        await scripted.clock.advance(RETRY_DELAYS_MS[2]);
        expect(scripted.callsTo('/chat/save')).toHaveLength(4);
        expect(data.hasPendingWrites()).toBe(false);
        expect(events.some(event => event.type === 'error')).toBe(false);
    });

    test('reports an error after the last try and keeps the chat dirty until the next change', async () => {
        const scripted = scriptedAdapter((path) => {
            if (path === '/list') {
                return { status: 200, json: { conversations: [{ id: 'conv_1_direct01', kind: 'direct', personaId: PERSONA, characters: ['Nova.png'], extras: [], settings: {}, activeChatId: 'main', chats: [{ id: 'main', name: 'Main', createdAt: 1, readThrough: '' }], reminders: [], createdAt: 1, updatedAt: 1 }], problems: [] } };
            }
            if (path === '/chat/get') {
                return { status: 200, json: { chat: [header()] } };
            }
            if (path === '/chat/save') {
                return { status: 502, json: null };
            }
            return { status: 200, json: { version: 1, characters: {} } };
        });
        data = createConversationData(scripted);
        data.subscribe(event => events.push(event));
        await data.start();
        await data.loadChat(ADDRESS);

        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(message('x1', 'hello'));
        });
        for (const delay of RETRY_DELAYS_MS) {
            await settle();
            await scripted.clock.advance(delay);
        }
        await settle();

        expect(scripted.callsTo('/chat/save')).toHaveLength(RETRY_DELAYS_MS.length + 1);
        expect(events.filter(event => event.type === 'error')).toHaveLength(1);
        expect(data.hasPendingWrites()).toBe(true);
    });
});

describe('metadata', () => {
    test('a patch is applied to the cache at once and sent in one request at the end of the tick', async () => {
        await started([DIRECT]);

        data.patchConversation('conv_1_direct01', { name: 'Nova', favorite: true });
        data.patchConversation('conv_1_direct01', { settings: { notifications_muted: true } });

        expect(data.get('conv_1_direct01')).toMatchObject({ name: 'Nova', favorite: true, settings: { notifications_muted: true } });
        expect(adapter.callsTo('/update')).toHaveLength(0);
        await adapter.clock.advance(0);
        await data.flush();

        expect(adapter.callsTo('/update')).toHaveLength(1);
        expect(adapter.callsTo('/update')[0].body).toEqual({ id: 'conv_1_direct01', patch: { name: 'Nova', favorite: true, settings: { notifications_muted: true } } });
        expect(readConversation(server.user, 'conv_1_direct01')).toMatchObject({ name: 'Nova', favorite: true });
    });

    test(`state that changes often waits ${FREQUENT_DELAY_MS} ms after the last change and is merged into one request`, async () => {
        await started([DIRECT]);

        data.patchConversation('conv_1_direct01', { chats: { main: { lastActivity: 1000 } } });
        await adapter.clock.advance(FREQUENT_DELAY_MS - 1);
        data.patchConversation('conv_1_direct01', { chats: { main: { followupCount: 2, sessionMarkers: { seen_at: '5' } } } });
        await adapter.clock.advance(FREQUENT_DELAY_MS - 1);
        expect(adapter.callsTo('/update')).toHaveLength(0);
        await adapter.clock.advance(1);
        await data.flush();

        expect(adapter.callsTo('/update')).toHaveLength(1);
        expect(adapter.callsTo('/update')[0].body.patch).toEqual({ chats: { main: { lastActivity: 1000, followupCount: 2, sessionMarkers: { seen_at: '5' } } } });
    });

    test(`state that changes often is sent after ${FREQUENT_MAX_WAIT_MS} ms at most, however often it changes`, async () => {
        await started([DIRECT]);

        for (let step = 1; step <= 10; step++) {
            data.patchConversation('conv_1_direct01', { chats: { main: { lastActivity: 1000 + step } } });
            await adapter.clock.advance(FREQUENT_DELAY_MS - 50);
        }
        await data.flush();

        expect(adapter.callsTo('/update').length).toBeGreaterThanOrEqual(1);
        // The timer fires at 3000 ms, between the ninth change (at 2800 ms) and the tenth (at 3150 ms).
        expect(adapter.callsTo('/update')[0].body.patch.chats.main.lastActivity).toBe(1009);
    });

    test('a change of the other kind sends what is waiting along with it, without the delay', async () => {
        await started([DIRECT]);
        data.patchConversation('conv_1_direct01', { chats: { main: { lastActivity: 1000 } } });

        data.patchConversation('conv_1_direct01', { name: 'Renamed' });
        await adapter.clock.advance(0);
        await data.flush();

        expect(adapter.callsTo('/update')).toHaveLength(1);
        expect(adapter.callsTo('/update')[0].body.patch).toEqual({ chats: { main: { lastActivity: 1000 } }, name: 'Renamed' });
    });

    test('a patch that changes nothing sends nothing', async () => {
        await started([{ ...DIRECT, settings: { notifications_muted: true } }]);

        data.patchConversation('conv_1_direct01', { favorite: false, settings: { notifications_muted: true }, chats: { main: { followupCount: 0 } } });
        await adapter.clock.advance(5000);
        await data.flush();

        expect(adapter.callsTo('/update')).toHaveLength(0);
    });

    test('a null setting removes the key', async () => {
        await started([{ ...DIRECT, settings: { notifications_muted: true, authors_note: 'x' } }]);

        data.patchConversation('conv_1_direct01', { settings: { authors_note: null } });
        await data.flush();

        expect(data.get('conv_1_direct01').settings).toEqual({ notifications_muted: true });
        expect(readConversation(server.user, 'conv_1_direct01').settings).toEqual({ notifications_muted: true });
    });

    test('the answer of the server does not undo a change that was made while the request was out', async () => {
        await started([DIRECT]);
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const original = adapter.fetchJson;
        adapter.fetchJson = async (path, body, options) => {
            if (path === '/update' && adapter.callsTo('/update').length === 0) {
                adapter.calls.push({ path, body: structuredClone(body), options });
                await gate;
                return server.adapter().fetchJson(path, body, options);
            }
            return original(path, body, options);
        };
        data.patchConversation('conv_1_direct01', { name: 'First' });
        await adapter.clock.advance(0);
        await settle(3);

        data.patchConversation('conv_1_direct01', { name: 'Second' });
        release();
        await adapter.clock.advance(0);
        await data.flush();

        expect(data.get('conv_1_direct01').name).toBe('Second');
        expect(readConversation(server.user, 'conv_1_direct01').name).toBe('Second');
    });

    test('keeps the summary of its chats when the answer of the server has none', async () => {
        await started([DIRECT]);

        data.patchConversation('conv_1_direct01', { name: 'Nova' });
        await data.flush();

        expect(data.get('conv_1_direct01')).toMatchObject({ messageCount: 3, unread: 1, preview: 'how are you' });
        expect(data.get('conv_1_direct01').chats[0]).toMatchObject({ messageCount: 3, unread: 1 });
    });

    test('a patch that the server refuses is reported, and the cache is read again', async () => {
        await started([DIRECT]);

        data.patchConversation('conv_1_direct01', { reminders: [{ id: 'r1', groupId: 'not allowed' }] });
        await data.flush();
        await settle();

        expect(events.some(event => event.type === 'error')).toBe(true);
        expect(data.get('conv_1_direct01').reminders).toEqual([]);
    });

    test('one user message costs one save of the chat and one update', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);
        adapter.calls.length = 0;

        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(message('main-3', 'a new message from the user'));
        });
        data.patchConversation('conv_1_direct01', { chats: { main: { lastActivity: 5000, followupCount: 0 } } });
        data.patchConversation('conv_1_direct01', { chats: { main: { sessionMarkers: { seen_at: '5000' } } } });
        data.patchConversation('conv_1_direct01', { chats: { main: { readThrough: 'main-3' } } });
        await adapter.clock.advance(FREQUENT_DELAY_MS);
        await data.flush();

        expect(adapter.paths().sort()).toEqual(['/chat/save', '/update']);
    });

    test('mergePatches merges settings and chat states field by field and replaces the rest', () => {
        expect(mergePatches(
            { name: 'a', settings: { x: 1, y: 2 }, chats: { main: { lastActivity: 1 } }, reminders: [{ id: 'a' }] },
            { name: 'b', settings: { y: null, z: 3 }, chats: { main: { followupCount: 2 }, other: { readThrough: 'm' } }, reminders: [] },
        )).toEqual({ name: 'b', settings: { x: 1, y: null, z: 3 }, chats: { main: { lastActivity: 1, followupCount: 2 }, other: { readThrough: 'm' } }, reminders: [] });
    });
});

describe('read markers and unread counts', () => {
    test('markRead sets the read marker to the last message and clears the badge at once', async () => {
        await started([DIRECT]);

        await data.markRead(ADDRESS);

        expect(data.get('conv_1_direct01').unread).toBe(0);
        expect(data.get('conv_1_direct01').chats[0].readThrough).toBe('main-2');
        await adapter.clock.advance(FREQUENT_DELAY_MS);
        await data.flush();
        expect(readConversation(server.user, 'conv_1_direct01').chats[0].readThrough).toBe('main-2');
    });

    test('a message from the character raises the unread count and one from the user does not', async () => {
        await started([{ ...DIRECT, chats: [{ id: 'main', messages: ['a', 'b'], readThrough: 'main-1' }] }]);
        await data.loadChat(ADDRESS);
        expect(data.get('conv_1_direct01').unread).toBe(0);

        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(message('main-2', 'reply'));
        });
        expect(data.get('conv_1_direct01').unread).toBe(1);
        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push({ ...message('main-3', 'mine'), is_user: true, role: 'user' });
        });
        expect(data.get('conv_1_direct01')).toMatchObject({ unread: 1, lastMessageRole: 'user', hasUserMessage: true, preview: 'mine' });
        await data.flush();
    });
});

describe('chats and conversations', () => {
    test('createChat lists and loads the chat at once, and the server makes it before it takes the first save', async () => {
        await started([DIRECT]);

        const created = data.createChat('conv_1_direct01', { name: 'Trip', activate: true });

        expect(created.address.chatId).toBe(`chat_${adapter.now()}_abc123`);
        expect(data.get('conv_1_direct01').activeChatId).toBe(created.address.chatId);
        expect(data.get('conv_1_direct01').chats.map(entry => entry.name)).toEqual(['Main', 'Trip']);
        expect(data.chat(created.address).messages).toEqual([]);
        data.commitChat(created.address, (draft) => {
            draft.messages.push(message('t1', 'first message of the trip'));
        });
        await data.flush();

        expect(adapter.paths().filter(path => path === '/chat/create' || path === '/chat/save')).toEqual(['/chat/create', '/chat/save']);
        expect(adapter.callsTo('/chat/create')[0].body).toEqual({ id: 'conv_1_direct01', chatId: created.address.chatId, name: 'Trip', activate: true });
        expect(loadStoredChat(server.user, 'conv_1_direct01', created.address.chatId).at(-1).mes).toBe('first message of the trip');
        expect(readConversation(server.user, 'conv_1_direct01').activeChatId).toBe(created.address.chatId);
    });

    test('a patch that names a new chat waits for the chat to be made', async () => {
        await started([DIRECT]);
        const created = data.createChat('conv_1_direct01', { name: 'Trip' });

        data.patchConversation('conv_1_direct01', { activeChatId: created.address.chatId });
        await adapter.clock.advance(0);
        await data.flush();

        expect(adapter.paths().filter(path => path === '/chat/create' || path === '/update')).toEqual(['/chat/create', '/update']);
        expect(readConversation(server.user, 'conv_1_direct01').activeChatId).toBe(created.address.chatId);
    });

    test('takes the chat back out of the list, and says so, when the server refuses to make it', async () => {
        await started([DIRECT]);
        const stray = `${server.root}/conversations/conv_1_direct01/chats/chat_${adapter.now()}_abc123.jsonl`;
        (await import('node:fs')).writeFileSync(stray, JSON.stringify(header()));

        const created = data.createChat('conv_1_direct01', { name: 'Trip', activate: true });
        await data.flush();
        await settle();

        expect(events.some(event => event.type === 'error' && event.code === 'exists')).toBe(true);
        expect(data.get('conv_1_direct01').chats.map(entry => entry.id)).toEqual(['main']);
        expect(data.get('conv_1_direct01').activeChatId).toBe('main');
        expect(data.chat(created.address)).toBeNull();
    });

    test('createConversation puts the new conversation in the cache and returns the existing one for a direct conversation that exists', async () => {
        await started([DIRECT]);

        const made = await data.createConversation({ kind: 'group', personaId: PERSONA, characters: ['Nova.png', 'Orion.png'], name: 'Crew' });
        const again = await data.createConversation({ kind: 'direct', personaId: PERSONA, characters: ['Nova.png'] });

        expect(made).toMatchObject({ created: true, conversation: { kind: 'group', name: 'Crew', messageCount: 0, unread: 0 } });
        expect(data.get(made.conversation.id)).toBe(made.conversation);
        expect(again).toMatchObject({ created: false });
        expect(again.conversation).toBe(data.get('conv_1_direct01'));
    });

    test('createConversation rejects with the code of the route', async () => {
        await started([]);

        await expect(data.createConversation({ kind: 'direct', personaId: PERSONA, characters: [] })).rejects.toMatchObject({ code: 'invalid_input', status: 400 });
    });

    test('deleteConversation removes it from the cache and the disk, and drops its loaded chats', async () => {
        await started([DIRECT, GROUP]);
        await data.loadChat(ADDRESS);

        await data.deleteConversation('conv_1_direct01');

        expect(data.get('conv_1_direct01')).toBeNull();
        expect(data.chat(ADDRESS)).toBeNull();
        expect(data.list().map(view => view.id)).toEqual(['conv_2_group001']);
        expect(() => readConversation(server.user, 'conv_1_direct01')).toThrow();
    });

    test('deleteChat takes the answer of the server, including the chat that it adds when the last one goes', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);

        const view = await data.deleteChat(ADDRESS);

        expect(view.chats).toHaveLength(1);
        expect(view.chats[0].id).not.toBe('main');
        expect(view.activeChatId).toBe(view.chats[0].id);
        expect(view.chats[0]).toMatchObject({ messageCount: 0, unread: 0 });
        expect(data.chat(ADDRESS)).toBeNull();
    });
});

describe('characters', () => {
    test('a routine and a status override are applied at once and saved', async () => {
        await started([]);

        data.patchCharacter('Nova.png', { routine: { enabled: true, text: '{"days":{}}', generatedAt: 5 } });
        data.patchCharacter('Nova.png', { statusOverride: 'dnd' });
        expect(data.characterState('Nova.png')).toEqual({ routine: { enabled: true, text: '{"days":{}}', generatedAt: 5 }, statusOverride: 'dnd' });
        await adapter.clock.advance(0);
        await data.flush();

        expect(adapter.callsTo('/characters/update')).toHaveLength(1);
        expect(readCharacterState(server.user).characters['Nova.png']).toEqual({ routine: { enabled: true, text: '{"days":{}}', generatedAt: 5 }, statusOverride: 'dnd' });
    });

    test('a null clears, and a routine merges into the one that exists', async () => {
        await started([]);
        data.patchCharacter('Nova.png', { routine: { enabled: true, text: 'a' }, statusOverride: 'idle' });
        await adapter.clock.advance(0);
        await data.flush();

        data.patchCharacter('Nova.png', { routine: { enabled: false }, statusOverride: null });

        expect(data.characterState('Nova.png')).toEqual({ routine: { enabled: false, text: 'a' } });
        await adapter.clock.advance(0);
        await data.flush();
        expect(readCharacterState(server.user).characters['Nova.png']).toEqual({ routine: { enabled: false, text: 'a' } });
        expect(data.characterState('Ghost.png')).toEqual({});
    });
});

describe('flush and unload', () => {
    test('flush sends what waits without waiting for a timer, and passes keepalive on', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);
        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(message('main-3', 'last words'));
        });
        data.patchConversation('conv_1_direct01', { chats: { main: { lastActivity: 77 } } });
        data.patchCharacter('Nova.png', { statusOverride: 'idle' });

        await data.flush({ keepalive: true });

        expect(data.hasPendingWrites()).toBe(false);
        expect(adapter.calls.filter(call => ['/chat/save', '/update', '/characters/update'].includes(call.path)).every(call => call.options?.keepalive === true)).toBe(true);
        expect(readConversation(server.user, 'conv_1_direct01').chats[0].lastActivity).toBe(77);
        expect(loadStoredChat(server.user, 'conv_1_direct01', 'main').at(-1).mes).toBe('last words');
        expect(readCharacterState(server.user).characters['Nova.png'].statusOverride).toBe('idle');
    });

    test('hasPendingWrites is true from the change until the server has answered', async () => {
        await started([DIRECT]);
        expect(data.hasPendingWrites()).toBe(false);

        data.patchConversation('conv_1_direct01', { name: 'x' });
        expect(data.hasPendingWrites()).toBe(true);
        await data.flush();
        expect(data.hasPendingWrites()).toBe(false);
    });
});

describe('legacy import and refresh', () => {
    const thread = { settings: {}, activeBranchId: 'main', branches: { main: { id: 'main', name: 'Main', messages: [], unread: 0, createdAt: 5, updatedAt: 5 } } };

    function importAdapter(state) {
        return scriptedAdapter((path) => {
            if (path === '/import-legacy') {
                return { status: 200, json: state === 'imported' ? { state, conversations: 1, chats: 1, messages: 0 } : { state } };
            }
            return path === '/list' ? { status: 200, json: { conversations: [], problems: [] } } : { status: 200, json: { version: 1, characters: {} } };
        });
    }

    test('importLegacy posts the threads as they are, reads the list again after an import, and answers what the server said', async () => {
        const scripted = importAdapter('imported');
        data = createConversationData(scripted);
        await data.start();

        const answer = await data.importLegacy({ personaId: PERSONA, characters: { 'Nova.png': thread } });

        expect(scripted.callsTo('/import-legacy')[0].body).toEqual({ personaId: PERSONA, characters: { 'Nova.png': thread } });
        expect(answer).toMatchObject({ state: 'imported', conversations: 1 });
        expect(scripted.callsTo('/list')).toHaveLength(2);
    });

    test('importLegacy reads nothing again when it was imported before', async () => {
        const scripted = importAdapter('already_imported');
        data = createConversationData(scripted);
        await data.start();

        expect(await data.importLegacy({ personaId: PERSONA, characters: {} })).toEqual({ state: 'already_imported' });
        expect(scripted.callsTo('/list')).toHaveLength(1);
    });

    test('refresh reads the list again, keeps loaded chats and unsent patches, and drops conversations that are gone', async () => {
        await started([DIRECT, GROUP]);
        await data.loadChat(ADDRESS);
        data.patchConversation('conv_1_direct01', { name: 'Pending name' });
        await adapter.fetchJson('/delete', { id: 'conv_2_group001' });
        seedConversations(server, [{ id: 'conv_5_newcomer1', characters: ['Orion.png'], chats: [{ id: 'main', messages: ['hey'] }] }]);

        await data.refresh();

        expect(data.list().map(view => view.id).sort()).toEqual(['conv_1_direct01', 'conv_5_newcomer1']);
        expect(data.chat(ADDRESS)).not.toBeNull();
        expect(data.get('conv_1_direct01').name).toBe('Pending name');
        await data.flush();
    });
});

describe('events', () => {
    test('are batched once per tick and carry the address of the chat', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);
        events.length = 0;

        for (const id of ['e1', 'e2']) {
            data.commitChat(ADDRESS, (draft) => {
                draft.messages.push(message(id, id));
            });
        }
        await settle(1);

        expect(events.filter(event => event.type === 'chat')).toEqual([{ type: 'chat', address: ADDRESS, local: true }]);
        expect(events.filter(event => event.type === 'list')).toHaveLength(1);
        await data.flush();
    });

    test('a listener that throws does not stop the others', async () => {
        await started([DIRECT]);
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const seen = [];
        data.subscribe(() => {
            throw new Error('broken listener');
        });
        data.subscribe(event => seen.push(event.type));

        data.patchConversation('conv_1_direct01', { name: 'x' });
        await settle(1);

        expect(seen).toContain('list');
        expect(error).toHaveBeenCalled();
        await data.flush();
    });
});
