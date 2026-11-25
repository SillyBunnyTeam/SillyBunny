import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { recordCalls, seedConversations, startConversationServer } from './util/conversation-data-fixture.js';
import { pendingReply } from './util/conversation-pending-reply.js';
import { addCharacters } from './util/conversation-store-sandbox.js';

let server;
let first;
let second;
let firstAdapter;

const ADDRESS = { conversationId: 'conv_1_direct01', chatId: 'main' };
const PENDING = pendingReply({ text: 'a reply that the server wrote', triggers: ['main-1'] });
const DIRECT = { id: ADDRESS.conversationId, characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello', 'hi there'], readThrough: 'main-1' }] };

beforeEach(async () => {
    server = await startConversationServer();
    addCharacters(server.user, ['Nova.png']);
});

afterEach(async () => {
    first?.destroy();
    second?.destroy();
    first = undefined;
    second = undefined;
    await server.stop();
});

/** Two pages on one account: `first` is the one under test, `second` is another tab. */
async function startPages(descriptors = [DIRECT], { holdSaves = false } = {}) {
    seedConversations(server, descriptors);
    const gate = { open: null, wait: Promise.resolve() };
    if (holdSaves) {
        gate.wait = new Promise((resolve) => {
            gate.open = resolve;
        });
    }
    firstAdapter = recordCalls({
        ...server.adapter(),
        async fetchJson(path, body, options) {
            if (path === '/chat/save') {
                await gate.wait;
            }
            return server.adapter().fetchJson(path, body, options);
        },
    });
    first = createConversationData(firstAdapter);
    second = createConversationData(server.adapter());
    await Promise.all([first.start(), second.start()]);
    return gate;
}

const texts = data => data.chat(ADDRESS).messages.map(message => message.mes);

describe('reloadChat', () => {
    test('adopts the copy of the server when the page has changed nothing, and announces it as a change that did not come from this page', async () => {
        await startPages();
        await first.loadChat(ADDRESS);
        await second.loadChat(ADDRESS);
        second.commitChat(ADDRESS, (draft) => {
            draft.messages.push({ id: 'other-1', role: 'character', name: 'Nova', mes: 'written in another tab', created_at: Date.UTC(2026, 0, 2), extra: {} });
        });
        await second.flush();
        const events = [];
        first.subscribe(event => event.type === 'chat' && events.push(event));

        await first.reloadChat(ADDRESS);

        expect(texts(first)).toEqual(['hello', 'hi there', 'written in another tab']);
        expect(first.get(ADDRESS.conversationId).chats[0].messageCount).toBe(3);
        await Promise.resolve();
        expect(events.some(event => !event.local)).toBe(true);
    });

    test('waits for a save that is on its way, and keeps the messages that this page wrote after the server copy was read', async () => {
        const gate = await startPages([DIRECT], { holdSaves: true });
        await first.loadChat(ADDRESS);
        await second.loadChat(ADDRESS);
        second.commitChat(ADDRESS, (draft) => {
            draft.messages.push({ id: 'other-1', role: 'character', name: 'Nova', mes: 'from the other tab', created_at: Date.UTC(2026, 0, 2), extra: {} });
        });
        await second.flush();
        first.commitChat(ADDRESS, (draft) => {
            draft.messages.push({ id: 'local-1', role: 'user', name: 'You', mes: 'typed here', created_at: Date.UTC(2026, 0, 3), extra: {} });
        });

        const reload = first.reloadChat(ADDRESS);
        await new Promise(resolve => setImmediate(resolve));
        expect(firstAdapter.callsTo('/chat/get')).toHaveLength(1);
        gate.open();
        await reload;

        expect(texts(first)).toEqual(['hello', 'hi there', 'from the other tab', 'typed here']);
        await first.flush();
        await second.reloadChat(ADDRESS);
        expect(texts(second)).toEqual(['hello', 'hi there', 'from the other tab', 'typed here']);
    });

    test('loads a chat that the page does not hold, as a load would', async () => {
        await startPages();

        await first.reloadChat(ADDRESS);

        expect(texts(first)).toEqual(['hello', 'hi there']);
    });

    test('rejects, and changes nothing, when the chat is gone', async () => {
        await startPages();
        await first.loadChat(ADDRESS);
        await second.deleteConversation(ADDRESS.conversationId);

        await expect(first.reloadChat(ADDRESS)).rejects.toMatchObject({ status: 404 });
        expect(texts(first)).toEqual(['hello', 'hi there']);
    });
});

describe('saveChat', () => {
    test('resolves when the changes of the chat are on the server', async () => {
        await startPages();
        await first.loadChat(ADDRESS);
        first.commitChat(ADDRESS, (draft) => {
            draft.messages.push({ id: 'local-1', role: 'user', name: 'You', mes: 'typed here', created_at: Date.UTC(2026, 0, 3), extra: {} });
        });

        await expect(first.saveChat(ADDRESS)).resolves.toBe(true);

        await second.loadChat(ADDRESS);
        expect(texts(second)).toEqual(['hello', 'hi there', 'typed here']);
    });

    test('answers false for a chat that is not loaded', async () => {
        await startPages();

        await expect(first.saveChat(ADDRESS)).resolves.toBe(false);
    });
});

describe('onChatRead', () => {
    test('announces each chat that was read from the server, at once, for a load and for a reload', async () => {
        await startPages();
        const read = [];
        first.onChatRead(address => read.push({ ...address, count: first.chat(address).messages.length }));

        await first.loadChat(ADDRESS);
        await first.loadChat(ADDRESS);
        await first.reloadChat(ADDRESS);

        expect(read).toEqual([{ ...ADDRESS, count: 2 }, { ...ADDRESS, count: 2 }]);
    });

    test('is stopped by the function that it returns, and a listener that throws does not stop the load', async () => {
        await startPages();
        const read = [];
        const stop = first.onChatRead(() => {
            throw new Error('a listener that fails');
        });
        first.onChatRead(address => read.push(address.chatId));

        await first.loadChat(ADDRESS);
        stop();
        await first.reloadChat(ADDRESS);

        expect(read).toEqual(['main', 'main']);
    });
});

describe('markRead', () => {
    test('sets the marker to the last message that is not a pending reply, which the finalizer will replace', async () => {
        await startPages([{ ...DIRECT, chats: [{ id: 'main', messages: ['hello', 'hi there', { record: PENDING }], readThrough: '' }] }]);
        await first.loadChat(ADDRESS);

        await first.markRead(ADDRESS);
        await first.flush();

        expect(first.get(ADDRESS.conversationId).chats[0].readThrough).toBe('main-1');
    });

    test('sets no marker for a chat whose only message is pending', async () => {
        await startPages([{ ...DIRECT, chats: [{ id: 'main', messages: [{ record: PENDING }], readThrough: '' }] }]);
        await first.loadChat(ADDRESS);

        await first.markRead(ADDRESS);

        expect(first.get(ADDRESS.conversationId).chats[0].readThrough).toBe('');
        expect(firstAdapter.callsTo('/update')).toHaveLength(0);
    });
});
