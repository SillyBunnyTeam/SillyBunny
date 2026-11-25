import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

import { startConversationRouter, snapshotTree } from './util/conversation-route-harness.js';
import { chat, createSandboxUser, header, line, listBackups, PERSONA } from './util/conversation-store-sandbox.js';

const { createConversation, loadChat, readConversation } = await import('../src/conversation-store.js');
const { getBackupKey } = await import('../src/endpoints/chats.js');
const { getConversationBackupName } = await import('../src/conversation-paths.js');

let api;
let sandbox;
let user;

beforeAll(async () => {
    api = await startConversationRouter(() => user);
});

afterAll(async () => {
    await api.close();
});

beforeEach(() => {
    sandbox = createSandboxUser();
    user = sandbox.user;
});

afterEach(() => {
    sandbox.cleanup();
});

const post = (route, body) => api.post(route, body);
const tree = () => snapshotTree(sandbox.root);

function makeDirect(overrides = {}) {
    return createConversation(user, { kind: 'direct', personaId: PERSONA, characters: ['Nova.png'], ...overrides }).conversation;
}

const messages = (count = 3) => chat(count).slice(1);

describe('POST /chat/create with records', () => {
    let conversation;

    beforeEach(() => {
        conversation = makeDirect({ id: 'conv_1_abcdef', chats: [{ id: 'main', name: 'Main' }] });
    });

    test('writes the messages as the first save of the chat, and answers with its slug', async () => {
        const { status, json } = await post('/chat/create', { id: conversation.id, chatId: 'branch_1', name: 'Branch', records: messages(3), readThrough: 'm2', activate: true });

        expect(status).toBe(200);
        expect(json.chat).toMatchObject({ id: 'branch_1', name: 'Branch', readThrough: 'm2' });
        expect(json.conversation.activeChatId).toBe('branch_1');
        expect(json.integrity).toMatch(/^[0-9a-f-]{36}$/);
        const stored = loadChat(user, conversation.id, 'branch_1');
        expect(stored[0].chat_metadata.integrity).toBe(json.integrity);
        expect(stored.slice(1)).toEqual(messages(3));
    });

    test('goes through the save path: a backup and a recovery copy', async () => {
        const key = getBackupKey(getConversationBackupName(conversation.id, 'branch_1'));

        await post('/chat/create', { id: conversation.id, chatId: 'branch_1', records: messages(2) });

        expect(listBackups(user, `chat_${key}_`)).toHaveLength(1);
        expect(fs.readdirSync(path.join(user.directories.backups, '_chat_recovery')).some(name => name.endsWith('.latest.jsonl'))).toBe(true);
    });

    test('keeps the memory summary of the source chat in the header', async () => {
        const memory = { memory_summary: 'A summary.', memory_message_count: 4, memory_updated_at: 1700000000000 };

        const { status } = await post('/chat/create', { id: conversation.id, chatId: 'branch_1', records: messages(2), chat_metadata: { sb_conversation: memory } });

        expect(status).toBe(200);
        expect(loadChat(user, conversation.id, 'branch_1')[0].chat_metadata.sb_conversation).toEqual(memory);
    });

    test('a chat created without records is still blank, and answers without a slug', async () => {
        const { status, json } = await post('/chat/create', { id: conversation.id, chatId: 'blank' });

        expect(status).toBe(200);
        expect(json.integrity).toBeUndefined();
        expect(loadChat(user, conversation.id, 'blank')).toEqual([header()]);
    });

    test('the save that follows needs the slug, and takes the one from the answer', async () => {
        const created = await post('/chat/create', { id: conversation.id, chatId: 'branch_1', records: messages(2) });

        const stale = await post('/chat/save', { id: conversation.id, chatId: 'branch_1', chat: [header(), line('other', 'a history of its own', { minute: 30 })], allowShrink: true });
        const fresh = await post('/chat/save', { id: conversation.id, chatId: 'branch_1', chat: [header({ integrity: created.json.integrity }), ...messages(2), line('m2', 'next', { minute: 2 })] });

        expect(stale).toMatchObject({ status: 409, json: { error: 'integrity' } });
        expect(fresh.status).toBe(200);
    });

    test('answers 409 exists for a listed chat and for a file that is there but not listed', async () => {
        fs.writeFileSync(path.join(user.directories.conversations, conversation.id, 'chats', 'stray.jsonl'), JSON.stringify(header()));
        const before = tree();

        expect(await post('/chat/create', { id: conversation.id, chatId: 'main', records: messages(1) })).toMatchObject({ status: 409, json: { error: 'exists' } });
        expect(await post('/chat/create', { id: conversation.id, chatId: 'stray', records: messages(1) })).toMatchObject({ status: 409, json: { error: 'exists' } });
        expect(tree()).toEqual(before);
    });

    test.each([
        ['records that are a string', { records: 'text' }],
        ['records with a row that is not an object', { records: [line('a', 'x'), 5] }],
        ['records that start with a header', { records: [header(), line('a', 'x')] }],
        ['records with a row that carries chat_metadata', { records: [{ ...line('a', 'x'), chat_metadata: {} }] }],
        ['chat_metadata that is a string', { records: [], chat_metadata: 'x' }],
        ['chat_metadata with a key of its own', { records: [], chat_metadata: { integrity: 'forged' } }],
        ['a memory block with a field of its own', { records: [], chat_metadata: { sb_conversation: { memory_summary: 'x', polluted: true } } }],
        ['a memory summary that is a number', { records: [], chat_metadata: { sb_conversation: { memory_summary: 5 } } }],
        ['a read marker that is an object', { records: [line('a', 'x')], readThrough: { a: 1 } }],
        ['activate that is a string', { records: [line('a', 'x')], activate: 'yes' }],
        ['a field that is not for this route', { records: [line('a', 'x')], createdAt: 5 }],
        ['a legacy id', { records: [line('a', 'x')], legacyId: 'x' }],
        ['a chat id that is a path', { records: [line('a', 'x')], chatId: '../../x' }],
    ])('refuses %s with 400 and writes nothing', async (_name, extra) => {
        const before = tree();

        const { status, json } = await post('/chat/create', { id: conversation.id, ...extra });

        expect(status).toBe(400);
        expect(json.error).toMatch(/^invalid_/);
        expect(tree()).toEqual(before);
        expect(readConversation(user, conversation.id).chats).toHaveLength(1);
    });

    test('is 404 for a conversation that does not exist', async () => {
        const { status, json } = await post('/chat/create', { id: 'conv_9_abcdef', records: messages(1) });

        expect(status).toBe(404);
        expect(json).toEqual({ error: 'not_found' });
        expect(fs.readdirSync(user.directories.conversations)).toEqual(['conv_1_abcdef']);
    });
});
