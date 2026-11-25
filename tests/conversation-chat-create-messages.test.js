import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createSandboxUser, header, line, listBackups, PERSONA } from './util/conversation-store-sandbox.js';

const {
    ConversationStoreError,
    createChatFromMessages,
    createConversation,
    loadChat,
    readConversation,
    saveChat,
} = await import('../src/conversation-store.js');
const { getBackupKey } = await import('../src/endpoints/chats.js');
const { getConversationBackupName } = await import('../src/conversation-paths.js');

let sandbox;
let user;
let conversationId;

beforeEach(() => {
    // The regular chat backup is throttled, and a second save inside the window leaves a timer that would fire after the test.
    jest.useFakeTimers();
    sandbox = createSandboxUser();
    user = sandbox.user;
    conversationId = createConversation(user, {
        kind: 'direct',
        personaId: PERSONA,
        characters: ['Nova.png'],
        id: 'conv_1700000000000_abcdef0123',
        chats: [{ id: 'main', name: 'Main', createdAt: 100 }],
    }).conversation.id;
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    sandbox.cleanup();
});

const chatsFolder = () => path.join(user.directories.conversations, conversationId, 'chats');
const chatFile = chatId => path.join(chatsFolder(), `${chatId}.jsonl`);
const messages = (count = 3) => Array.from({ length: count }, (_, index) => line(`m${index}`, `text ${index}`, { user: index % 2 === 1, minute: index }));

async function codeOfAsync(promise) {
    try {
        await promise;
    } catch (error) {
        return error instanceof ConversationStoreError ? error.code : error;
    }
    return undefined;
}

describe('createChatFromMessages', () => {
    test('writes the messages as the first save of the chat, and answers with the slug that the file carries', async () => {
        const result = await createChatFromMessages(user, conversationId, { id: 'branch-1', name: 'Branch', messages: messages(3), readThrough: 'm2' });

        expect(result.chat).toMatchObject({ id: 'branch-1', name: 'Branch', readThrough: 'm2' });
        expect(result.conversation.chats.map(item => item.id)).toEqual(['main', 'branch-1']);
        expect(result.integrity).toMatch(/^[0-9a-f-]{36}$/);
        const stored = loadChat(user, conversationId, 'branch-1');
        expect(stored[0].chat_metadata.integrity).toBe(result.integrity);
        expect(stored.slice(1)).toEqual(messages(3));
        expect(readConversation(user, conversationId).chats.map(item => item.id)).toEqual(['main', 'branch-1']);
    });

    test('chooses the chat id when the caller gives none, and opens the chat when asked to', async () => {
        const { chat, conversation } = await createChatFromMessages(user, conversationId, { messages: messages(1), activate: true });

        expect(chat.id).toMatch(/^chat_\d+_[0-9a-f]{6}$/);
        expect(conversation.activeChatId).toBe(chat.id);
    });

    test('keeps the active chat when it is not asked to open the new one', async () => {
        const { conversation } = await createChatFromMessages(user, conversationId, { id: 'second', messages: messages(1) });

        expect(conversation.activeChatId).toBe('main');
    });

    test('puts the memory summary of the source chat in the header', async () => {
        const memory = { memory_summary: 'They met at the pier.', memory_message_count: 12, memory_updated_at: 1700000000000 };

        await createChatFromMessages(user, conversationId, { id: 'second', messages: messages(2), chatMetadata: { sb_conversation: memory } });

        const [first] = loadChat(user, conversationId, 'second');
        expect(first.chat_metadata.sb_conversation).toEqual(memory);
        expect(first.user_name).toBe('unused');
    });

    test('goes through the save path: a backup, a recovery copy, and the slug check on the next save', async () => {
        const key = getBackupKey(getConversationBackupName(conversationId, 'second'));

        const { integrity } = await createChatFromMessages(user, conversationId, { id: 'second', messages: messages(3) });

        expect(listBackups(user, `chat_${key}_`)).toHaveLength(1);
        expect(fs.readdirSync(path.join(user.directories.backups, '_chat_recovery')).some(name => name.endsWith('.latest.jsonl'))).toBe(true);
        const divergent = [header(), line('x', 'a history of its own', { minute: 50 })];
        expect(await codeOfAsync(saveChat(user, conversationId, 'second', divergent, { allowShrink: true }))).toBe('integrity');
        const next = [header({ integrity }), ...messages(3), line('m3', 'next', { minute: 3 })];
        await expect(saveChat(user, conversationId, 'second', next)).resolves.toMatchObject({ integrity: expect.any(String) });
    });

    test('lists the chat with its counts at once', async () => {
        await createChatFromMessages(user, conversationId, { id: 'second', messages: messages(3), readThrough: 'm2' });

        const { listConversations } = await import('../src/conversation-store.js');
        const listed = listConversations(user).conversations[0].chats.find(item => item.id === 'second');
        expect(listed).toMatchObject({ messageCount: 3, unread: 0 });
    });

    test('refuses a chat id that is listed, and leaves that chat alone', async () => {
        await saveChat(user, conversationId, 'main', [header(), ...messages(2)]);
        const before = fs.readFileSync(chatFile('main'), 'utf8');

        expect(await codeOfAsync(createChatFromMessages(user, conversationId, { id: 'main', messages: messages(1) }))).toBe('exists');
        expect(fs.readFileSync(chatFile('main'), 'utf8')).toBe(before);
    });

    test('refuses a chat id whose file is there but not listed, and keeps the file', async () => {
        fs.writeFileSync(chatFile('stray'), JSON.stringify(header()));

        expect(await codeOfAsync(createChatFromMessages(user, conversationId, { id: 'stray', messages: messages(1) }))).toBe('exists');
        expect(fs.readFileSync(chatFile('stray'), 'utf8')).toBe(JSON.stringify(header()));
        expect(readConversation(user, conversationId).chats.map(item => item.id)).toEqual(['main']);
    });

    test('lists no chat and leaves no file when the save fails', async () => {
        const circular = line('loop', 'x');
        circular.extra = circular;

        const error = await codeOfAsync(createChatFromMessages(user, conversationId, { id: 'broken', messages: [circular] }));

        expect(error).toBeInstanceOf(Error);
        expect(readConversation(user, conversationId).chats.map(item => item.id)).toEqual(['main']);
        expect(fs.existsSync(chatFile('broken'))).toBe(false);
    });

    test('takes the file back when the conversation is gone before the chat is listed', async () => {
        const { deleteConversation } = await import('../src/conversation-store.js');
        const pending = createChatFromMessages(user, conversationId, { id: 'late', messages: messages(1) });
        deleteConversation(user, conversationId);

        expect(await codeOfAsync(pending)).toBe('not_found');
        expect(fs.existsSync(path.join(user.directories.conversations, conversationId))).toBe(false);
    });

    test.each([
        ['messages that are not a list', { messages: 'text' }],
        ['no messages', { messages: undefined }],
        ['a message that is not an object', { messages: [line('a', 'x'), 'x'] }],
        ['a message that is a header', { messages: [header(), line('a', 'x')] }],
        ['a message with chat_metadata', { messages: [{ ...line('a', 'x'), chat_metadata: {} }] }],
        ['a chat id that is a path', { id: '../x', messages: [line('a', 'x')] }],
        ['a memory block that is a string', { messages: [line('a', 'x')], chatMetadata: 'x' }],
        ['a header key that is not the memory', { messages: [line('a', 'x')], chatMetadata: { integrity: 'abc' } }],
        ['memory fields that are not the memory', { messages: [line('a', 'x')], chatMetadata: { sb_conversation: { memory_summary: 5 } } }],
        ['memory with a field of its own', { messages: [line('a', 'x')], chatMetadata: { sb_conversation: { memory_summary: 'x', evil: 1 } } }],
        ['activate that is a string', { messages: [line('a', 'x')], activate: 'yes' }],
    ])('refuses %s and writes nothing', async (_name, input) => {
        const code = await codeOfAsync(createChatFromMessages(user, conversationId, input));

        expect(['invalid_input', 'invalid_id']).toContain(code);
        expect(fs.readdirSync(chatsFolder())).toEqual(['main.jsonl']);
        expect(readConversation(user, conversationId).chats).toHaveLength(1);
    });

    test('is not_found for a conversation that does not exist and invalid_id for an id that is not one', async () => {
        expect(await codeOfAsync(createChatFromMessages(user, 'conv_9_abcdef', { messages: messages(1) }))).toBe('not_found');
        expect(await codeOfAsync(createChatFromMessages(user, '../x', { messages: messages(1) }))).toBe('invalid_id');
    });
});
