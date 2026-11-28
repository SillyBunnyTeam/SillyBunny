import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// Chat updates write backups, recovery copies, and SQLite index entries, which can approach Jest's 5 s default under parallel Windows runs.
jest.setTimeout(30_000);

import { chat, createSandboxUser, line, listBackups, PERSONA } from './util/conversation-store-sandbox.js';

const { createConversation, loadChat, saveChat } = await import('../src/conversation-store.js');
const { getBackupKey, updateChatRecords } = await import('../src/endpoints/chats.js');
const { getConversationBackupName } = await import('../src/conversation-paths.js');

let sandbox;
let user;
let conversationId;

beforeEach(async () => {
    // The regular chat backup is throttled, and a second save inside the window leaves a timer that would fire after the test.
    jest.useFakeTimers();
    sandbox = createSandboxUser();
    user = sandbox.user;
    conversationId = createConversation(user, {
        kind: 'group',
        personaId: PERSONA,
        characters: ['Nova.png', 'Orion.png'],
        id: 'conv_1700000000000_abcdef0123',
    }).conversation.id;
    await saveChat(user, conversationId, 'main', chat(2));
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    sandbox.cleanup();
});

const target = (overrides = {}) => ({ conversationChat: { conversationId, chatId: 'main', ...overrides } });
const appendReply = records => ({ records: [...records, line('reply', 'written by the server', { minute: 50 })] });

describe('updateChatRecords for the chat of a conversation', () => {
    test('reads the chat, saves what the update returns and rotates the integrity slug', async () => {
        const before = loadChat(user, conversationId, 'main');

        const result = await updateChatRecords(user, target(), appendReply);

        expect(result.status).toBe('saved');
        expect(result.previousIntegrity).toBe(before[0].chat_metadata.integrity);
        expect(result.integrity).not.toBe(result.previousIntegrity);
        const after = loadChat(user, conversationId, 'main');
        expect(after).toHaveLength(before.length + 1);
        expect(after[0].chat_metadata.integrity).toBe(result.integrity);
        expect(after.at(-1)).toMatchObject({ id: 'reply', mes: 'written by the server' });
    });

    test('keeps the backup and the recovery copy that a browser save keeps', async () => {
        const key = getBackupKey(getConversationBackupName(conversationId, 'main'));
        const preWriteBefore = listBackups(user, `chat_pre_write_${key}_`).length;

        await updateChatRecords(user, target(), appendReply);

        expect(listBackups(user, `chat_pre_write_${key}_`)).toHaveLength(preWriteBefore + 1);
        const latest = fs.readdirSync(path.join(user.directories.backups, '_chat_recovery')).filter(name => name.endsWith('.latest.jsonl'));
        expect(latest).toHaveLength(1);
        expect(fs.readFileSync(path.join(user.directories.backups, '_chat_recovery', latest[0]), 'utf8'))
            .toBe(fs.readFileSync(path.join(user.directories.conversations, conversationId, 'chats', 'main.jsonl'), 'utf8'));
    });

    test('leaves the chat alone when the update returns nothing', async () => {
        const bytes = fs.readFileSync(path.join(user.directories.conversations, conversationId, 'chats', 'main.jsonl'));

        expect(await updateChatRecords(user, target(), () => null)).toEqual({ status: 'unchanged' });
        expect(fs.readFileSync(path.join(user.directories.conversations, conversationId, 'chats', 'main.jsonl'))).toEqual(bytes);
    });

    test('is a conflict, not an overwrite, when a browser save lands between the read and the write', async () => {
        const result = await updateChatRecords(user, target(), (records) => {
            // A page saves the same chat after the server has read it. The save runs to the end before its promise returns.
            const saving = saveChat(user, conversationId, 'main', [...records, line('page', 'from the page', { minute: 49 })]);
            saving.catch(() => {});
            return appendReply(records);
        });

        expect(result.status).toBe('conflict');
        const after = loadChat(user, conversationId, 'main');
        expect(after.at(-1)).toMatchObject({ id: 'page' });
        expect(after.some(record => record.id === 'reply')).toBe(false);
    });

    test('refuses a reply that would shrink the chat, as a browser save would', async () => {
        await saveChat(user, conversationId, 'main', chat(12, { integrity: loadChat(user, conversationId, 'main')[0].chat_metadata.integrity }));

        const result = await updateChatRecords(user, target(), records => ({ records: records.slice(0, 3) }));

        expect(result.status).toBe('conflict');
        expect(loadChat(user, conversationId, 'main')).toHaveLength(13);
    });

    test.each([
        ['an id that is a path', { conversationId: '../x' }],
        ['a chat id that is a path', { chatId: '../main' }],
        ['a chat id with a slash', { chatId: 'a/b' }],
        ['a conversation id that is a character folder', { conversationId: 'Nova' }],
    ])('answers missing for %s and writes nothing', async (_name, overrides) => {
        const tree = () => fs.readdirSync(sandbox.root, { recursive: true }).sort();
        const before = tree();

        expect(await updateChatRecords(user, target(overrides), appendReply)).toEqual({ status: 'missing', reason: 'invalid-target' });
        expect(tree()).toEqual(before);
    });

    test('answers missing for a chat whose file is not there', async () => {
        expect(await updateChatRecords(user, target({ chatId: 'ghost' }), appendReply)).toEqual({ status: 'missing', reason: 'missing' });
    });

    test('never touches the folders of character chats and group chats', async () => {
        await updateChatRecords(user, target(), appendReply);

        expect(fs.readdirSync(user.directories.chats)).toEqual([]);
        expect(fs.readdirSync(user.directories.groupChats)).toEqual([]);
    });

    test('a character chat of the same file name is still addressed by its own target', async () => {
        const characterChatFile = path.join(user.directories.chats, 'Nova', 'main.jsonl');
        fs.mkdirSync(path.dirname(characterChatFile), { recursive: true });
        const original = [JSON.stringify({ chat_metadata: { integrity: 'roleplay' } }), JSON.stringify(line('r', 'roleplay line'))].join('\n');
        fs.writeFileSync(characterChatFile, original);

        const result = await updateChatRecords(user, { avatarUrl: 'Nova.png', fileName: 'main' }, appendReply);

        expect(result.status).toBe('saved');
        expect(fs.readFileSync(characterChatFile, 'utf8')).not.toBe(original);
        expect(loadChat(user, conversationId, 'main')).toHaveLength(3);
    });
});
