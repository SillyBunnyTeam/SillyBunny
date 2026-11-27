import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { recordCalls, seedConversations, startConversationServer } from './util/conversation-data-fixture.js';
import { addCharacters } from './util/conversation-store-sandbox.js';

const {
    markConversationUnread,
    setConversationFavorite,
    setConversationMuted,
} = await import('../public/scripts/sillybunny-conversation/conversation-list-actions.js');

let server;
let adapter;
let data;

beforeEach(async () => {
    server = await startConversationServer();
    addCharacters(server.user, ['Nova.png', 'Orion.png']);
});

afterEach(async () => {
    data?.destroy();
    data = undefined;
    await server.stop();
});

async function start(descriptors) {
    const seeded = seedConversations(server, descriptors);
    adapter = recordCalls(server.adapter());
    data = createConversationData(adapter);
    await data.start();
    return seeded;
}

async function reread(id) {
    await data.flush();
    await data.refresh();
    return data.get(id);
}

describe('adding a conversation to Favorites and taking it out', () => {
    test('sets `favorite` on the conversation and saves it', async () => {
        await start([{ id: 'conv_1_direct01', characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello'] }] }]);

        setConversationFavorite(data, 'conv_1_direct01', true);

        expect(data.get('conv_1_direct01').favorite).toBe(true);
        expect((await reread('conv_1_direct01')).favorite).toBe(true);

        setConversationFavorite(data, 'conv_1_direct01', false);
        expect((await reread('conv_1_direct01')).favorite).toBe(false);
    });

    test('sends nothing when the conversation already is on that side', async () => {
        await start([{ id: 'conv_1_direct01', characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello'] }] }]);
        const before = adapter.callsTo('/update').length;

        setConversationFavorite(data, 'conv_1_direct01', false);
        await data.flush();

        expect(adapter.callsTo('/update')).toHaveLength(before);
    });

    test('reports a conversation that is not in the cache', async () => {
        await start([]);

        expect(setConversationFavorite(data, 'conv_missing', true)).toBe(false);
    });
});

describe('muting a conversation', () => {
    test('writes `notifications_muted` into its settings and takes the key out again on Unmute, so the settings stay sparse', async () => {
        await start([{ id: 'conv_1_direct01', characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello'] }] }]);

        setConversationMuted(data, 'conv_1_direct01', true);
        expect((await reread('conv_1_direct01')).settings.notifications_muted).toBe(true);

        setConversationMuted(data, 'conv_1_direct01', false);
        expect(Object.hasOwn((await reread('conv_1_direct01')).settings, 'notifications_muted')).toBe(false);
    });
});

describe('Mark as Unread', () => {
    test('moves the read marker before the last message, so one message is unread', async () => {
        await start([{ id: 'conv_1_direct01', characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello', 'hi', 'how are you'], readThrough: 'main-2' }] }]);
        expect(data.get('conv_1_direct01').unread).toBe(0);

        const marked = await markConversationUnread(data, 'conv_1_direct01');

        expect(marked).toBe(true);
        expect(data.get('conv_1_direct01').unread).toBe(1);
        const view = await reread('conv_1_direct01');
        expect(view.chats[0].readThrough).toBe('main-1');
        expect(view.unread).toBe(1);
    });

    test('marks the chat that holds the last message of the conversation, not the first one', async () => {
        await start([{
            id: 'conv_1_direct01',
            characters: ['Nova.png'],
            activeChatId: 'old',
            chats: [
                { id: 'old', messages: [{ id: 'old-0', text: 'older', minute: 0 }], readThrough: 'old-0' },
                { id: 'new', messages: [{ id: 'new-0', text: 'newer', minute: 90 }, { id: 'new-1', text: 'newest', minute: 91 }], readThrough: 'new-1' },
            ],
        }]);

        await markConversationUnread(data, 'conv_1_direct01');

        const view = await reread('conv_1_direct01');
        expect(view.chats.find(chat => chat.id === 'old').unread).toBe(0);
        expect(view.chats.find(chat => chat.id === 'new').unread).toBe(1);
    });

    test('does nothing for a conversation whose last message is the user\'s, and says so', async () => {
        await start([{ id: 'conv_1_direct01', characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello', 'hi'], readThrough: 'main-1' }] }]);
        const before = adapter.callsTo('/update').length;

        const marked = await markConversationUnread(data, 'conv_1_direct01');
        await data.flush();

        expect(marked).toBe(false);
        expect(adapter.callsTo('/update')).toHaveLength(before);
        expect(data.get('conv_1_direct01').unread).toBe(0);
    });

    test('reports a conversation that is not in the cache', async () => {
        await start([]);

        expect(await markConversationUnread(data, 'conv_missing')).toBe(false);
    });
});
