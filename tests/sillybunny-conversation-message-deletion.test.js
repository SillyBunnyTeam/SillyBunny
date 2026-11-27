import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import {
    dropQueueItemsOfDeletedMessages,
    getReadThroughAfterDeletion,
    removeChatMessages,
} from '../public/scripts/sillybunny-conversation/message-deletion.js';
import { recordCalls, seedConversations, settle, startConversationServer } from './util/conversation-data-fixture.js';

const { loadChat: loadStoredChat } = await import('../src/conversation-store.js');

const ids = list => list.map(message => message.id);
const msg = id => ({ id });

describe('getReadThroughAfterDeletion', () => {
    const messages = ['a', 'b', 'c', 'd', 'e'].map(msg);

    test('keeps a marker that names a message that stays', () => {
        expect(getReadThroughAfterDeletion(messages, 'c', ['a', 'e'])).toBe('c');
    });

    test('moves a marker whose message goes to the nearest earlier message that stays, so later messages stay unread', () => {
        expect(getReadThroughAfterDeletion(messages, 'd', ['d'])).toBe('c');
        expect(getReadThroughAfterDeletion(messages, 'd', ['b', 'c', 'd'])).toBe('a');
    });

    test('reads as nothing read when no earlier message stays', () => {
        expect(getReadThroughAfterDeletion(messages, 'b', ['a', 'b'])).toBe('');
    });

    test('leaves an empty marker and a marker that already names no message alone', () => {
        expect(getReadThroughAfterDeletion(messages, '', ['a'])).toBe('');
        expect(getReadThroughAfterDeletion(messages, 'gone', ['a'])).toBe('gone');
    });
});

describe('dropQueueItemsOfDeletedMessages', () => {
    test('removes, in place, the queued items that were triggered by a deleted message, and returns them', () => {
        const kept = { messageIds: ['x'], chatId: 'main' };
        const hit = { messageIds: ['x', 'y'], chatId: 'main' };
        const other = { messageIds: ['y'], chatId: 'other' };
        const forcedNoTrigger = { messageIds: [], chatId: 'main', force: true };
        const queue = [kept, hit, other, forcedNoTrigger];

        const dropped = dropQueueItemsOfDeletedMessages(queue, { chatId: 'main', messageIds: ['y'] });

        expect(dropped).toEqual([hit]);
        expect(queue).toEqual([kept, other, forcedNoTrigger]);
    });

    test('does nothing for a list of no messages', () => {
        const queue = [{ messageIds: ['x'], chatId: 'main' }];
        expect(dropQueueItemsOfDeletedMessages(queue, { chatId: 'main', messageIds: [] })).toEqual([]);
        expect(queue).toHaveLength(1);
    });
});

describe('removeChatMessages on the data module', () => {
    let server;
    let data;
    let adapter;
    const ADDRESS = { conversationId: 'conv_1_direct01', chatId: 'main' };

    beforeEach(async () => {
        server = await startConversationServer();
        seedConversations(server, [{
            id: 'conv_1_direct01',
            characters: ['Nova.png'],
            chats: [{ id: 'main', name: 'Main', readThrough: 'main-3', messages: Array.from({ length: 8 }, (_, index) => `message ${index}`) }],
        }]);
        adapter = recordCalls(server.adapter());
        data = createConversationData(adapter);
        await data.start();
        await data.whenReady();
        await data.loadChat(ADDRESS);
    });

    afterEach(async () => {
        data.destroy();
        await server.stop();
        jest.restoreAllMocks();
    });

    test('removes any set of messages in one commit, sends the save with allowShrink, and keeps the order of the rest', async () => {
        const events = [];
        data.subscribe(event => events.push(event));

        const removed = removeChatMessages(data, ADDRESS, ['main-1', 'main-2', 'main-6']);
        await settle();
        await data.flush();

        expect(removed).toEqual(['main-1', 'main-2', 'main-6']);
        expect(ids(data.chat(ADDRESS).messages)).toEqual(['main-0', 'main-3', 'main-4', 'main-5', 'main-7']);
        expect(events.filter(event => event.type === 'chat' && event.local)).toHaveLength(1);
        const saves = adapter.callsTo('/chat/save');
        expect(saves).toHaveLength(1);
        expect(saves[0].body.allowShrink).toBe(true);
        const stored = loadStoredChat(server.user, ADDRESS.conversationId, ADDRESS.chatId);
        expect(ids(stored.slice(1))).toEqual(['main-0', 'main-3', 'main-4', 'main-5', 'main-7']);
    });

    test('recomputes the preview and the counts from the messages that are left', async () => {
        removeChatMessages(data, ADDRESS, ['main-7', 'main-6']);
        await settle();

        const entry = data.get(ADDRESS.conversationId).chats[0];
        expect(entry.messageCount).toBe(6);
        expect(entry.preview).toBe('message 5');
        expect(data.get(ADDRESS.conversationId).preview).toBe('message 5');
    });

    test('moves the read marker off a deleted message so that the unread count stays within the messages left', async () => {
        // readThrough is main-3; seed messages alternate user and character, so unread counts the character messages after it.
        const before = data.get(ADDRESS.conversationId).chats[0].unread;
        expect(before).toBeGreaterThan(0);

        removeChatMessages(data, ADDRESS, ['main-3']);
        await settle();

        const entry = data.get(ADDRESS.conversationId).chats[0];
        expect(entry.readThrough).toBe('main-2');
        expect(entry.unread).toBe(before);
        expect(entry.unread).toBeLessThanOrEqual(entry.messageCount);
    });

    test('an emptied chat has no unread messages and no preview', async () => {
        // The server logs a warning when it lets a save that empties a chat through because allowShrink is set.
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        removeChatMessages(data, ADDRESS, data.chat(ADDRESS).messages.map(message => message.id));
        await settle();

        const entry = data.get(ADDRESS.conversationId).chats[0];
        expect(entry).toMatchObject({ messageCount: 0, unread: 0, preview: '' });
        expect(entry.readThrough).toBe('');
    });

    test('names no message that is not in the chat, and changes nothing for an unknown id', async () => {
        const removed = removeChatMessages(data, ADDRESS, ['nope']);
        await settle();

        expect(removed).toEqual([]);
        expect(data.chat(ADDRESS).messages).toHaveLength(8);
        expect(adapter.callsTo('/chat/save')).toHaveLength(0);
    });
});
