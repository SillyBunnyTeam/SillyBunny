import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { chat, createSandboxUser, header, line, listBackups, PERSONA } from './util/conversation-store-sandbox.js';

const {
    ConversationStoreError,
    createChat,
    createConversation,
    deleteChat,
    exportChat,
    listConversations,
    loadChat,
    readConversation,
    saveChat,
    updateConversation,
} = await import('../src/conversation-store.js');
const { conversationIndex } = await import('../src/conversation-index.js');
const { getBackupKey } = await import('../src/endpoints/chats.js');
const { getChatRecoveryPaths, loadActiveChatWithRecovery } = await import('../src/chat-recovery.js');
const { getConversationBackupName, resolveConversationChatTarget } = await import('../src/conversation-paths.js');

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
    jest.restoreAllMocks();
    sandbox.cleanup();
});

const chatFile = (chatId = 'main') => path.join(user.directories.conversations, conversationId, 'chats', `${chatId}.jsonl`);
const readChatFile = (chatId = 'main') => fs.readFileSync(chatFile(chatId), 'utf8').split('\n').map(item => JSON.parse(item));

async function errorOfAsync(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    return undefined;
}

async function codeOfAsync(promise) {
    const error = await errorOfAsync(promise);
    return error instanceof ConversationStoreError ? error.code : error;
}

function errorOf(operation) {
    try {
        operation();
    } catch (error) {
        return error;
    }
    return undefined;
}

/** The code of the store error that an operation throws, or what it threw if that is not a store error. */
function codeOf(operation) {
    const error = errorOf(operation);
    return error instanceof ConversationStoreError ? error.code : error;
}

describe('createChat', () => {
    test('adds a blank chat with an id of the server, and leaves the active chat as it was', () => {
        const { conversation, chat: created } = createChat(user, conversationId, { name: 'Trip' });

        expect(created.id).toMatch(/^chat_\d+_[0-9a-f]{12}$/);
        expect(created).toMatchObject({ name: 'Trip', readThrough: '', followupCount: 0 });
        expect(conversation.chats.map(item => item.id)).toEqual(['main', created.id]);
        expect(conversation.activeChatId).toBe('main');
        expect(readConversation(user, conversationId)).toEqual(conversation);
        expect(fs.readFileSync(chatFile(created.id), 'utf8')).toBe(JSON.stringify(header()));
    });

    test('opens the new chat when asked', () => {
        const { conversation, chat: created } = createChat(user, conversationId, { activate: true });
        expect(conversation.activeChatId).toBe(created.id);
    });

    test('takes an id and records that the caller brings, as a branch or a migration does', () => {
        const records = [header({ sb_conversation: { memorySummary: 'Kept.' } }), line('a', 'copied')];

        const { chat: created } = createChat(user, conversationId, { id: 'branch-1', name: 'Branch', records, createdAt: 5, readThrough: 'a' });

        expect(created).toMatchObject({ id: 'branch-1', name: 'Branch', createdAt: 5, readThrough: 'a' });
        expect(fs.readFileSync(chatFile('branch-1'), 'utf8')).toBe(records.map(record => JSON.stringify(record)).join('\n'));
    });

    test('two new chats get two ids', () => {
        const first = createChat(user, conversationId, {}).chat.id;
        const second = createChat(user, conversationId, {}).chat.id;
        expect(first).not.toBe(second);
    });

    test.each([
        ['an id that is a path', { id: '../main' }],
        ['an id with a slash', { id: 'a/b' }],
        ['an id that is a device name', { id: 'con' }],
        ['an id that is taken', { id: 'main' }],
        ['a name over 200 characters', { name: 'n'.repeat(201) }],
        ['records without a header', { records: [line('a', 'x')] }],
        ['records with a row that is not an object', { records: [header(), 5] }],
        ['a field that does not exist', { other: 1 }],
        ['an input that is an array', []],
    ])('refuses %s and writes nothing', (_name, input) => {
        const before = fs.readdirSync(path.dirname(chatFile()));

        expect(codeOf(() => createChat(user, conversationId, input))).toBe(input.id === 'main' ? 'exists' : 'invalid_input');
        expect(fs.readdirSync(path.dirname(chatFile()))).toEqual(before);
        expect(readConversation(user, conversationId).chats).toHaveLength(1);
    });

    test('refuses a file that is already there under an id that the conversation does not list, and keeps that file', () => {
        fs.writeFileSync(chatFile('orphan'), 'kept');

        expect(codeOf(() => createChat(user, conversationId, { id: 'orphan' }))).toBe('exists');
        expect(fs.readFileSync(chatFile('orphan'), 'utf8')).toBe('kept');
    });

    test('is not_found for a conversation that does not exist', () => {
        expect(codeOf(() => createChat(user, 'conv_9_abcdef', {}))).toBe('not_found');
        expect(codeOf(() => createChat(user, '../x', {}))).toBe('invalid_id');
    });
});

describe('loadChat', () => {
    test('returns the records of the chat, header first', () => {
        const records = [header({ sb_conversation: { memorySummary: 'S' } }), line('a', 'x'), line('b', 'y', { user: true })];
        createChat(user, conversationId, { id: 'second', records });

        expect(loadChat(user, conversationId, 'second')).toEqual(records);
    });

    test('is not_found for a chat that the conversation does not list, even when a file is there', () => {
        fs.writeFileSync(chatFile('orphan'), JSON.stringify(header()));

        expect(codeOf(() => loadChat(user, conversationId, 'orphan'))).toBe('not_found');
    });

    test('is not_found for a listed chat whose file is gone and has no recovery copy', () => {
        fs.rmSync(chatFile('main'));

        expect(codeOf(() => loadChat(user, conversationId, 'main'))).toBe('not_found');
    });

    test('restores a listed chat whose file is gone from the copy that its last load or save left', async () => {
        const saved = chat(4);
        await saveChat(user, conversationId, 'main', saved);
        fs.rmSync(chatFile('main'));

        const records = loadChat(user, conversationId, 'main');

        expect(records).toHaveLength(5);
        expect(records.slice(1)).toEqual(saved.slice(1));
        expect(fs.existsSync(chatFile('main'))).toBe(true);
    });

    test('is corrupt for a file that is not chat JSONL, and does not change it', () => {
        fs.writeFileSync(chatFile('main'), 'this is not json');

        expect(codeOf(() => loadChat(user, conversationId, 'main'))).toBe('corrupt');
        expect(fs.readFileSync(chatFile('main'), 'utf8')).toBe('this is not json');
    });

    test('is invalid_id for ids that are not ids, and not_found for a conversation that does not exist', () => {
        expect(codeOf(() => loadChat(user, conversationId, '../../../etc/passwd'))).toBe('invalid_id');
        expect(codeOf(() => loadChat(user, '../x', 'main'))).toBe('invalid_id');
        expect(codeOf(() => loadChat(user, 'conv_9_abcdef', 'main'))).toBe('not_found');
    });
});

describe('saveChat', () => {
    test('writes the chat and returns the integrity slug that the file now carries', async () => {
        const { integrity } = await saveChat(user, conversationId, 'main', chat(3));

        expect(integrity).toMatch(/^[0-9a-f-]{36}$/);
        const [first, ...messages] = readChatFile();
        expect(first.chat_metadata.integrity).toBe(integrity);
        expect(messages).toEqual(chat(3).slice(1));
        expect(loadChat(user, conversationId, 'main')[0].chat_metadata.integrity).toBe(integrity);
    });

    test('accepts the slug of the last save and gives a new one', async () => {
        const first = await saveChat(user, conversationId, 'main', chat(2));
        const second = await saveChat(user, conversationId, 'main', chat(3, { integrity: first.integrity }));

        expect(second.integrity).not.toBe(first.integrity);
        expect(readChatFile()).toHaveLength(4);
    });

    test('refuses a save that carries a slug that is no longer the file\'s, and keeps the file', async () => {
        const first = await saveChat(user, conversationId, 'main', chat(2));
        await saveChat(user, conversationId, 'main', chat(3, { integrity: first.integrity }));
        const bytes = fs.readFileSync(chatFile());

        expect(await codeOfAsync(saveChat(user, conversationId, 'main', [...chat(2, { integrity: first.integrity }), line('late', 'from a stale tab')]))).toBe('integrity');

        expect(fs.readFileSync(chatFile())).toEqual(bytes);
    });

    test('of two saves with the same slug at once, one stands and the other is refused', async () => {
        const { integrity } = await saveChat(user, conversationId, 'main', chat(2));

        const results = await Promise.allSettled([
            saveChat(user, conversationId, 'main', [...chat(2, { integrity }), line('x', 'tab one', { minute: 20 })]),
            saveChat(user, conversationId, 'main', [...chat(2, { integrity }), line('y', 'tab two', { minute: 21 }), line('z', 'more', { minute: 22 })]),
        ]);

        expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(results.find(result => result.status === 'rejected').reason.code).toBe('integrity');
    });

    test('refuses a save that would drop most of a chat, and allows it when the caller says it deletes messages', async () => {
        let { integrity } = await saveChat(user, conversationId, 'main', chat(12));

        const refusal = await errorOfAsync(saveChat(user, conversationId, 'main', chat(3, { integrity })));
        expect(refusal).toBeInstanceOf(ConversationStoreError);
        expect(refusal.code).toBe('destructive');
        expect(refusal.details?.reason).toBeTruthy();
        expect(readChatFile()).toHaveLength(13);

        ({ integrity } = await saveChat(user, conversationId, 'main', chat(3, { integrity }), { allowShrink: true }));
        expect(readChatFile()).toHaveLength(4);
        expect(integrity).toBeTruthy();
    });

    test('keeps the chat as it was before a save replaces it, and writes a regular backup of the saved chat', async () => {
        const key = getBackupKey(getConversationBackupName(conversationId, 'main'));
        const first = await saveChat(user, conversationId, 'main', chat(2));
        await saveChat(user, conversationId, 'main', chat(3, { integrity: first.integrity }));

        const preWrite = listBackups(user, `chat_pre_write_${key}_`);
        expect(preWrite).toHaveLength(2);
        const preWriteLengths = preWrite.map(name => fs.readFileSync(path.join(user.directories.backups, name), 'utf8').split('\n').length).sort();
        expect(preWriteLengths).toEqual([1, 3]);
        expect(listBackups(user, `chat_${key}_`)).toHaveLength(1);
        expect(listBackups(user).every(name => name.includes(key))).toBe(true);
    });

    test('keeps the backups of two chats of one conversation apart', async () => {
        createChat(user, conversationId, { id: 'second' });
        await saveChat(user, conversationId, 'main', chat(2));
        await saveChat(user, conversationId, 'second', chat(2, { prefix: 's' }));

        const mainKey = getBackupKey(getConversationBackupName(conversationId, 'main'));
        const secondKey = getBackupKey(getConversationBackupName(conversationId, 'second'));
        expect(mainKey).not.toBe(secondKey);
        expect(listBackups(user, `chat_pre_write_${mainKey}_`)).toHaveLength(1);
        expect(listBackups(user, `chat_pre_write_${secondKey}_`)).toHaveLength(1);
        expect(listBackups(user, `chat_${mainKey}_`)).toHaveLength(1);
        expect(listBackups(user, `chat_${secondKey}_`)).toHaveLength(1);
    });

    test('writes no regular backup for a save that defers it', async () => {
        const key = getBackupKey(getConversationBackupName(conversationId, 'main'));

        await saveChat(user, conversationId, 'main', chat(2), { deferBackup: true });

        expect(listBackups(user, `chat_${key}_`)).toEqual([]);
    });

    test('writes the recovery copy of the chat that its own folder keeps', async () => {
        const { integrity } = await saveChat(user, conversationId, 'main', chat(2));
        const { recoveryTarget } = resolveConversationChatTarget(user.directories, { conversationId, chatId: 'main' }, 25);

        const latest = fs.readFileSync(getChatRecoveryPaths(recoveryTarget).latestPath, 'utf8');

        expect(JSON.parse(latest.split('\n')[0]).chat_metadata.integrity).toBe(integrity);
        expect(latest).toBe(fs.readFileSync(chatFile(), 'utf8'));
    });

    test('leaves no temporary file next to the chat', async () => {
        await saveChat(user, conversationId, 'main', chat(2));

        expect(fs.readdirSync(path.dirname(chatFile()))).toEqual(['main.jsonl']);
    });

    test.each([
        ['an empty list', []],
        ['a chat without a header', [line('a', 'x')]],
        ['a header whose chat_metadata is not an object', [{ chat_metadata: 'x' }]],
        ['a row that is not an object', [header(), 'text']],
        ['a row that is null', [header(), null]],
        ['a body that is not an array', { chat: [] }],
        ['a string', 'text'],
    ])('refuses %s', async (_name, records) => {
        expect(await codeOfAsync(saveChat(user, conversationId, 'main', records))).toBe('invalid_input');
        expect(readChatFile()).toEqual([header()]);
    });

    test('is not_found for a chat that the conversation does not list, and writes nothing for it', async () => {
        expect(await codeOfAsync(saveChat(user, conversationId, 'ghost', chat(2)))).toBe('not_found');
        expect(await codeOfAsync(saveChat(user, 'conv_9_abcdef', 'main', chat(2)))).toBe('not_found');

        expect(fs.existsSync(chatFile('ghost'))).toBe(false);
    });

    test.each(['../main', '..', 'a/b', '', 5, null, undefined, { toString: () => 'main' }])('is invalid_id for the chat id %p', async (chatId) => {
        expect(await codeOfAsync(saveChat(user, conversationId, chatId, chat(2)))).toBe('invalid_id');
        expect(fs.readdirSync(path.join(user.directories.conversations, conversationId))).toEqual(['chats', 'conversation.json']);
    });

    test.each(['../x', '..', 'conv_1_a/b', '', 5, null])('is invalid_id for the conversation id %p', async (id) => {
        expect(await codeOfAsync(saveChat(user, id, 'main', chat(2)))).toBe('invalid_id');
    });

    test('saves a chat that was written without a slug, as the migration writes them', async () => {
        createChat(user, conversationId, { id: 'migrated', records: [header(), line('a', 'old line')] });

        const { integrity } = await saveChat(user, conversationId, 'migrated', [header(), line('a', 'old line'), line('b', 'new line', { user: true, minute: 5 })]);

        expect(readChatFile('migrated')[0].chat_metadata.integrity).toBe(integrity);
        expect(readChatFile('migrated')).toHaveLength(3);
    });
});

describe('deleteChat', () => {
    beforeEach(() => {
        updateConversation(user, conversationId, { activeChatId: 'main' });
        createChat(user, conversationId, { id: 'second', name: 'Second', createdAt: 200 });
        createChat(user, conversationId, { id: 'third', name: 'Third', createdAt: 300 });
    });

    test('removes the chat, its file, its recovery copy and its place in the list', async () => {
        await saveChat(user, conversationId, 'second', chat(2, { prefix: 's' }));
        const { recoveryTarget } = resolveConversationChatTarget(user.directories, { conversationId, chatId: 'second' }, 25);
        expect(fs.existsSync(getChatRecoveryPaths(recoveryTarget).latestPath)).toBe(true);

        const conversation = deleteChat(user, conversationId, 'second');

        expect(conversation.chats.map(item => item.id)).toEqual(['main', 'third']);
        expect(readConversation(user, conversationId)).toEqual(conversation);
        expect(fs.existsSync(chatFile('second'))).toBe(false);
        expect(fs.existsSync(getChatRecoveryPaths(recoveryTarget).latestPath)).toBe(false);
        expect(loadActiveChatWithRecovery(recoveryTarget).status).toBe('missing');
        expect(codeOf(() => loadChat(user, conversationId, 'second'))).toBe('not_found');
    });

    test('keeps the backups of the deleted chat', async () => {
        const { integrity } = await saveChat(user, conversationId, 'second', chat(2, { prefix: 's' }));
        await saveChat(user, conversationId, 'second', chat(3, { prefix: 's', integrity }));
        const before = listBackups(user);

        deleteChat(user, conversationId, 'second');

        expect(before).not.toHaveLength(0);
        expect(listBackups(user)).toEqual(before);
    });

    test('leaves the active chat when another chat is deleted', () => {
        expect(deleteChat(user, conversationId, 'third').activeChatId).toBe('main');
    });

    test('makes the newest remaining chat the active one when the active chat is deleted', () => {
        updateConversation(user, conversationId, { activeChatId: 'second' });

        expect(deleteChat(user, conversationId, 'second').activeChatId).toBe('third');
    });

    test('leaves one empty chat when the last chat is deleted', async () => {
        await saveChat(user, conversationId, 'main', chat(2));
        deleteChat(user, conversationId, 'second');
        deleteChat(user, conversationId, 'third');

        const conversation = deleteChat(user, conversationId, 'main');

        expect(conversation.chats).toHaveLength(1);
        const [replacement] = conversation.chats;
        expect(replacement.id).not.toBe('main');
        expect(conversation.activeChatId).toBe(replacement.id);
        expect(readChatFile(replacement.id)).toEqual([header()]);
        expect(fs.readdirSync(path.dirname(chatFile()))).toEqual([`${replacement.id}.jsonl`]);
    });

    test('is not_found for a chat that is not listed, and leaves the conversation alone', () => {
        const before = readConversation(user, conversationId);

        expect(codeOf(() => deleteChat(user, conversationId, 'ghost'))).toBe('not_found');
        expect(codeOf(() => deleteChat(user, 'conv_9_abcdef', 'main'))).toBe('not_found');
        expect(codeOf(() => deleteChat(user, conversationId, '../main'))).toBe('invalid_id');
        expect(readConversation(user, conversationId)).toEqual(before);
    });

    test('removes a listed chat whose file is already gone', () => {
        fs.rmSync(chatFile('third'));

        expect(deleteChat(user, conversationId, 'third').chats.map(item => item.id)).toEqual(['main', 'second']);
    });

    test('writes conversation.json once and still drops index and recovery state when removing the chat file fails', async () => {
        await saveChat(user, conversationId, 'second', chat(2, { prefix: 's' }));
        listConversations(user);
        const secondFile = chatFile('second');
        const secondStat = fs.statSync(secondFile);
        const { recoveryTarget } = resolveConversationChatTarget(user.directories, { conversationId, chatId: 'second' }, 25);
        expect(conversationIndex.get(secondFile, secondStat, '')).toBeDefined();

        const jsonPath = path.join(user.directories.conversations, conversationId, 'conversation.json');
        const originalRenameSync = fs.renameSync;
        let jsonWrites = 0;
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (String(to) === jsonPath) {
                jsonWrites++;
            }
            return originalRenameSync(from, to);
        });
        const originalRmSync = fs.rmSync;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
            if (String(target) === secondFile) {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            return originalRmSync(target, ...rest);
        });

        const updated = deleteChat(user, conversationId, 'second');

        expect(jsonWrites).toBe(1);
        expect(updated.chats.map(item => item.id)).toEqual(['main', 'third']);
        expect(conversationIndex.get(secondFile, secondStat, '')).toBeUndefined();
        expect(fs.existsSync(getChatRecoveryPaths(recoveryTarget).latestPath)).toBe(false);
    });
});

describe('exportChat', () => {
    test('returns the file as it is stored, named after the chat', async () => {
        const { integrity } = await saveChat(user, conversationId, 'main', chat(2));

        const exported = exportChat(user, conversationId, 'main');

        expect(exported.fileName).toBe('Main.jsonl');
        expect(exported.data).toBe(fs.readFileSync(chatFile(), 'utf8'));
        expect(JSON.parse(exported.data.split('\n')[0]).chat_metadata.integrity).toBe(integrity);
    });

    test('names a chat without a name by its id, and keeps path characters out of the name', () => {
        createChat(user, conversationId, { id: 'plain' });
        createChat(user, conversationId, { id: 'slashes', name: '../../etc/passwd' });

        expect(exportChat(user, conversationId, 'plain').fileName).toBe('plain.jsonl');
        expect(exportChat(user, conversationId, 'slashes').fileName).toBe('....etcpasswd.jsonl');
    });

    test('is not_found for a chat that is not listed or has no file, and invalid_id for a bad id', () => {
        createChat(user, conversationId, { id: 'empty' });
        fs.rmSync(chatFile('empty'));

        expect(codeOf(() => exportChat(user, conversationId, 'ghost'))).toBe('not_found');
        expect(codeOf(() => exportChat(user, conversationId, 'empty'))).toBe('not_found');
        expect(codeOf(() => exportChat(user, conversationId, '../main'))).toBe('invalid_id');
    });
});
