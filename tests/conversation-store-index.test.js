/* global globalThis */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { chat, createSandboxUser, header, line, PERSONA } from './util/conversation-store-sandbox.js';

const { ConversationIndex, conversationIndex } = await import('../src/conversation-index.js');
const {
    createChat,
    createConversation,
    deleteChat,
    deleteConversation,
    listConversations,
    recordChatSummary,
    saveChat,
    updateConversation,
} = await import('../src/conversation-store.js');

let sandbox;
let user;
let conversationId;

beforeEach(() => {
    // The regular chat backup is throttled, and a second save inside the window leaves a timer that would fire after the test.
    jest.useFakeTimers();
    sandbox = createSandboxUser();
    user = sandbox.user;
    conversationId = createConversation(user, {
        kind: 'group',
        personaId: PERSONA,
        characters: ['Nova.png', 'Orion.png'],
        id: 'conv_1700000000000_abcdef0123',
        chats: [{ id: 'main', name: 'Main', createdAt: 100 }],
    }).conversation.id;
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    sandbox.cleanup();
});

const chatFile = (chatId = 'main') => path.join(user.directories.conversations, conversationId, 'chats', `${chatId}.jsonl`);
const entryOf = (chatId = 'main') => ({ id: chatId, readThrough: '' });
const cachedSummary = (chatId = 'main', readThrough = '') => conversationIndex.get(chatFile(chatId), fs.statSync(chatFile(chatId)), readThrough);
const listedChat = (list, chatId = 'main') => list.conversations[0].chats.find(item => item.id === chatId);

describe('saveChat and the index', () => {
    test('writes the row of the saved chat, so that the list needs no read of the file', async () => {
        await saveChat(user, conversationId, 'main', chat(4));

        expect(cachedSummary()).toEqual({ messageCount: 4, lastMessageAt: Date.UTC(2026, 0, 1, 0, 3), preview: 'm text 3', unread: 2 });
    });

    test('writes a row that matches the read marker of the chat', async () => {
        updateConversation(user, conversationId, { chats: { main: { readThrough: 'm0' } } });
        await saveChat(user, conversationId, 'main', chat(4));

        expect(cachedSummary('main', 'm0')).toMatchObject({ messageCount: 4, unread: 1 });
        expect(cachedSummary('main', '')).toBeUndefined();
    });

    test('replaces the row on the next save', async () => {
        const first = await saveChat(user, conversationId, 'main', chat(2));
        await saveChat(user, conversationId, 'main', chat(5, { integrity: first.integrity }));

        expect(cachedSummary()).toMatchObject({ messageCount: 5, preview: 'm text 4' });
    });
});

describe('recordChatSummary', () => {
    test('stores a row only while the file still carries the slug of the save it describes', async () => {
        const { integrity } = await saveChat(user, conversationId, 'main', chat(2));
        conversationIndex.delete(chatFile());

        recordChatSummary(user, conversationId, entryOf(), chat(9), 'not-the-slug-of-the-file');
        expect(cachedSummary()).toBeUndefined();

        recordChatSummary(user, conversationId, entryOf(), chat(2), integrity);
        expect(cachedSummary()).toMatchObject({ messageCount: 2 });
    });

    test('stores nothing for a chat file that is gone, and does not throw', () => {
        fs.rmSync(chatFile());

        expect(() => recordChatSummary(user, conversationId, entryOf(), chat(2), 'any')).not.toThrow();
    });

    test('stores nothing when the first line of the file is not a header', () => {
        fs.writeFileSync(chatFile(), 'not json\n');

        recordChatSummary(user, conversationId, entryOf(), chat(2), 'any');

        expect(cachedSummary()).toBeUndefined();
    });
});

describe('listConversations with the index', () => {
    test('fills the index from the files on the first list', async () => {
        fs.writeFileSync(chatFile(), chat(3).map(record => JSON.stringify(record)).join('\n'));

        const list = listConversations(user);

        expect(listedChat(list)).toMatchObject({ messageCount: 3, preview: 'm text 2' });
        expect(cachedSummary()).toMatchObject({ messageCount: 3, preview: 'm text 2' });
    });

    test('answers from a row while the file is unchanged, without reading the chat', () => {
        const file = chatFile();
        fs.writeFileSync(file, chat(3).map(record => JSON.stringify(record)).join('\n'));
        conversationIndex.set(file, fs.statSync(file), '', { messageCount: 99, lastMessageAt: 5, preview: 'from the index', unread: 7 });

        const list = listConversations(user);

        expect(listedChat(list)).toMatchObject({ messageCount: 99, preview: 'from the index', unread: 7 });
        expect(list.conversations[0]).toMatchObject({ messageCount: 99, unread: 7, preview: 'from the index' });
    });

    test('reads the file again when it changed after the row was written', () => {
        const file = chatFile();
        fs.writeFileSync(file, chat(3).map(record => JSON.stringify(record)).join('\n'));
        conversationIndex.set(file, fs.statSync(file), '', { messageCount: 99, lastMessageAt: 5, preview: 'from the index', unread: 7 });

        fs.writeFileSync(file, chat(5).map(record => JSON.stringify(record)).join('\n'));

        expect(listedChat(listConversations(user))).toMatchObject({ messageCount: 5, preview: 'm text 4' });
        expect(cachedSummary()).toMatchObject({ messageCount: 5 });
    });

    test('reads the file again when the read marker changed, because the unread count comes from the marker', () => {
        const file = chatFile();
        fs.writeFileSync(file, chat(4).map(record => JSON.stringify(record)).join('\n'));
        expect(listedChat(listConversations(user))).toMatchObject({ unread: 2 });

        updateConversation(user, conversationId, { chats: { main: { readThrough: 'm2' } } });

        expect(listedChat(listConversations(user))).toMatchObject({ unread: 0 });
    });

    test('lists the same as a scan when the index is off, and writes no row', () => {
        fs.writeFileSync(chatFile(), chat(4).map(record => JSON.stringify(record)).join('\n'));
        const off = new ConversationIndex({ enabled: false });

        const scanned = listConversations(user, { index: off });
        expect(cachedSummary()).toBeUndefined();
        const indexed = listConversations(user);

        expect(listedChat(scanned)).toMatchObject({ messageCount: 4 });
        expect(indexed).toEqual(scanned);
    });

    test('keeps listing from the files when the index cannot open its database', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        fs.writeFileSync(chatFile(), chat(2).map(record => JSON.stringify(record)).join('\n'));
        // A data root that is a file makes the cache folder impossible to create.
        const blocker = path.join(sandbox.root, 'blocked');
        fs.writeFileSync(blocker, 'x');
        const previousDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = blocker;
        const broken = new ConversationIndex({ enabled: true });

        try {
            expect(listedChat(listConversations(user, { index: broken }))).toMatchObject({ messageCount: 2 });
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            broken.close();
            globalThis.DATA_ROOT = previousDataRoot;
        }
    });

    test('reads a chat whose preview has a NUL character from its file every time', () => {
        const file = chatFile();
        const records = [header(), line('a', 'cut\0off', { minute: 1 })];
        fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n'));

        const first = listConversations(user);
        const second = listConversations(user);

        expect(listedChat(first).preview).toBe('cut\0off');
        expect(listedChat(second).preview).toBe('cut\0off');
        expect(cachedSummary()).toBeUndefined();
    });

    test('forgets the rows of a chat file that was removed by hand', () => {
        const extra = createChat(user, conversationId, { id: 'extra' }).chat;
        fs.writeFileSync(chatFile(extra.id), chat(2).map(record => JSON.stringify(record)).join('\n'));
        listConversations(user);
        const stat = fs.statSync(chatFile(extra.id));
        expect(conversationIndex.get(chatFile(extra.id), stat, '')).toBeDefined();

        fs.rmSync(chatFile(extra.id));
        listConversations(user);

        expect(conversationIndex.get(chatFile(extra.id), stat, '')).toBeUndefined();
    });
});

describe('deleting through the store', () => {
    test('deleteChat forgets the row of the chat', async () => {
        const { chat: second } = createChat(user, conversationId, { id: 'second' });
        await saveChat(user, conversationId, second.id, chat(2));
        const stat = fs.statSync(chatFile(second.id));
        expect(conversationIndex.get(chatFile(second.id), stat, '')).toBeDefined();

        deleteChat(user, conversationId, second.id);

        expect(conversationIndex.get(chatFile(second.id), stat, '')).toBeUndefined();
    });

    test('deleteConversation forgets the rows of all its chats', async () => {
        await saveChat(user, conversationId, 'main', chat(2));
        const file = chatFile();
        const stat = fs.statSync(file);

        deleteConversation(user, conversationId);

        expect(conversationIndex.get(file, stat, '')).toBeUndefined();
    });
});
