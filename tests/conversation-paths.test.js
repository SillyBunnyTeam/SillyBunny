import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';
import { createDirectoryLink } from './util/platform-capabilities.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const {
    CHAT_ID_PATTERN,
    CONVERSATION_ID_PATTERN,
    createChatId,
    createConversationId,
    getCharactersJsonPath,
    getChatFilePath,
    getConversationBackupName,
    getConversationDirectory,
    getConversationJsonPath,
    isChatId,
    isConversationId,
    resolveConversationChatTarget,
} = await import('../src/conversation-paths.js');
const {
    clearChatRecoveryState,
    createCharacterChatTarget,
    createGroupChatTarget,
    getChatRecoveryPaths,
    loadActiveChatWithRecovery,
    markChatDeleted,
    writeLatestChatSnapshot,
} = await import('../src/chat-recovery.js');

const ID = 'conv_1700000000000_a1b2c3d4e5';

describe('conversation ids', () => {
    test.each([
        'conv_1700000000000_a1b2c3d4e5',
        'conv_1_abcd',
        'conv_1700000000000_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    ])('accepts %s', (id) => {
        expect(isConversationId(id)).toBe(true);
    });

    test.each([
        ['an empty string', ''],
        ['no prefix', '1700000000000_a1b2c3d4e5'],
        ['a legacy group id', 'conversation_1700000000000_abc123'],
        ['a slash', 'conv_1/../x_abcd'],
        ['a path with a slash', 'conv_1_abcd/../../x'],
        ['a backslash', 'conv_1_ab\\cd'],
        ['dot segments', '..'],
        ['a single dot', '.'],
        ['a NUL byte', 'conv_1_abcd\u0000'],
        ['a trailing newline', 'conv_1_abcd\n'],
        ['a space', 'conv_1_ab cd'],
        ['a random part shorter than 4', 'conv_1_abc'],
        ['a random part longer than 32', `conv_1_${'a'.repeat(33)}`],
        ['a time part longer than 16', `conv_${'1'.repeat(17)}_abcd`],
        ['an upper-case prefix', 'CONV_1_abcd'],
        ['a number', 7],
        ['null', null],
        ['undefined', undefined],
        ['an array', ['conv_1_abcd']],
        ['an object with a hostile toString', { toString: 'x' }],
        ['an object that renders as a valid id', { toString: () => ID }],
    ])('refuses %s', (_name, value) => {
        expect(isConversationId(value)).toBe(false);
    });

    test('a generated id matches the pattern and is not repeated', () => {
        const ids = new Set(Array.from({ length: 200 }, () => createConversationId()));
        expect(ids.size).toBe(200);
        for (const id of ids) {
            expect(CONVERSATION_ID_PATTERN.test(id)).toBe(true);
        }
    });

    test('a generated id carries the time and the random part it is given', () => {
        expect(createConversationId(1700000000123, 'abcdef0123')).toBe('conv_1700000000123_abcdef0123');
    });
});

describe('chat ids', () => {
    test.each(['main', 'Main', 'a', '0', 'chat_1700000000000_a1b2c3', 'a-b_c', 'A'.repeat(64)])('accepts %s', (id) => {
        expect(isChatId(id)).toBe(true);
    });

    test.each([
        ['an empty string', ''],
        ['a leading dash', '-main'],
        ['a leading underscore', '_main'],
        ['a dot', 'ma.in'],
        ['a leading dot', '.hidden'],
        ['dot segments', '..'],
        ['a slash', 'a/b'],
        ['a backslash', 'a\\b'],
        ['a space', 'a b'],
        ['a colon', 'a:b'],
        ['a NUL byte', 'ma\u0000in'],
        ['a trailing newline', 'main\n'],
        ['65 characters', 'a'.repeat(65)],
        ['a non-ASCII letter', 'café'],
        ['a Windows device name', 'CON'],
        ['a Windows device name in lower case', 'nul'],
        ['a Windows device name with a number', 'com1'],
        ['a number', 7],
        ['null', null],
        ['an object that renders as a valid id', { toString: () => 'main' }],
    ])('refuses %s', (_name, value) => {
        expect(isChatId(value)).toBe(false);
    });

    test('a generated id matches the pattern and is not repeated', () => {
        const ids = new Set(Array.from({ length: 200 }, () => createChatId()));
        expect(ids.size).toBe(200);
        for (const id of ids) {
            expect(CHAT_ID_PATTERN.test(id)).toBe(true);
            expect(isChatId(id)).toBe(true);
        }
    });

    test('a generated id carries the time and the random part it is given', () => {
        expect(createChatId(1700000000123, 'abcdef')).toBe('chat_1700000000123_abcdef');
    });
});

describe('paths under the conversations folder', () => {
    let root;
    let directories;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-conversation-paths-'));
        directories = { conversations: path.join(root, 'conversations'), backups: path.join(root, 'backups') };
        fs.mkdirSync(directories.conversations, { recursive: true });
        fs.mkdirSync(directories.backups, { recursive: true });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('builds the layout of the plan', () => {
        expect(getConversationDirectory(directories, ID)).toBe(path.join(directories.conversations, ID));
        expect(getConversationJsonPath(directories, ID)).toBe(path.join(directories.conversations, ID, 'conversation.json'));
        expect(getChatFilePath(directories, ID, 'main')).toBe(path.join(directories.conversations, ID, 'chats', 'main.jsonl'));
        expect(getCharactersJsonPath(directories)).toBe(path.join(directories.conversations, 'characters.json'));
    });

    test.each([
        ['a path', '../x'],
        ['an id with a slash', 'conv_1_a/b'],
        ['an empty id', ''],
        ['a non-string', 5],
    ])('refuses a conversation directory for %s', (_name, id) => {
        expect(() => getConversationDirectory(directories, id)).toThrow(/conversation id/i);
    });

    test.each([
        ['a path', '../x'],
        ['a slash', 'a/b'],
        ['an empty id', ''],
        ['a device name', 'aux'],
    ])('refuses a chat file for %s', (_name, chatId) => {
        expect(() => getChatFilePath(directories, ID, chatId)).toThrow(/chat id/i);
    });

    test('refuses a user without a conversations folder', () => {
        expect(() => getConversationDirectory({ backups: directories.backups }, ID)).toThrow(/conversations folder/i);
        expect(() => getCharactersJsonPath({})).toThrow(/conversations folder/i);
    });

    test('refuses a conversation folder that is a link out of the conversations folder', () => {
        const outside = path.join(root, 'outside');
        fs.mkdirSync(outside);
        createDirectoryLink(outside, path.join(directories.conversations, ID));

        expect(() => getConversationDirectory(directories, ID)).toThrow(/outside the conversations folder/i);
        expect(() => getChatFilePath(directories, ID, 'main')).toThrow(/outside the conversations folder/i);
    });

    test('refuses a chats folder that is a link out of the conversations folder', () => {
        const outside = path.join(root, 'outside');
        fs.mkdirSync(outside);
        fs.mkdirSync(path.join(directories.conversations, ID));
        createDirectoryLink(outside, path.join(directories.conversations, ID, 'chats'));

        expect(() => getChatFilePath(directories, ID, 'main')).toThrow(/outside the conversations folder/i);
    });

    test('refuses a conversation.json that resolves outside the conversations folder', () => {
        const outside = path.join(root, 'outside.json');
        fs.writeFileSync(outside, '{}');
        const conversationDir = path.join(directories.conversations, ID);
        const jsonPath = path.join(conversationDir, 'conversation.json');
        fs.mkdirSync(conversationDir, { recursive: true });
        fs.writeFileSync(jsonPath, '{}');
        const originalRealpath = fs.realpathSync;
        jest.spyOn(fs, 'realpathSync').mockImplementation((target) => {
            if (path.resolve(String(target)) === path.resolve(jsonPath)) {
                return originalRealpath(outside);
            }
            return originalRealpath(target);
        });

        expect(() => getConversationJsonPath(directories, ID)).toThrow(/outside the conversations folder/i);
    });

    test('a conversation folder that does not exist yet is allowed', () => {
        expect(getConversationDirectory(directories, 'conv_2_abcd')).toBe(path.join(directories.conversations, 'conv_2_abcd'));
    });

    test('the backup name of a chat names the conversation and the chat', () => {
        expect(getConversationBackupName(ID, 'main')).toBe(`conversation_${ID}_main`);
    });
});

describe('resolveConversationChatTarget', () => {
    let root;
    let directories;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-conversation-target-'));
        directories = { conversations: path.join(root, 'conversations'), backups: path.join(root, 'backups') };
        fs.mkdirSync(directories.conversations, { recursive: true });
        fs.mkdirSync(directories.backups, { recursive: true });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('names the file, the backup key and a recovery target of its own type', () => {
        const target = resolveConversationChatTarget(directories, { conversationId: ID, chatId: 'main' }, 25);

        expect(target.filePath).toBe(path.join(directories.conversations, ID, 'chats', 'main.jsonl'));
        expect(target.fileName).toBe('main.jsonl');
        expect(target.cardName).toBe(`conversation_${ID}_main`);
        expect(target.recoveryTarget).toMatchObject({
            type: 'conversation',
            owner: ID,
            filename: 'main.jsonl',
            activePath: target.filePath,
            maxRecoveryStates: 25,
        });
    });

    test.each([
        ['a bad conversation id', { conversationId: '../x', chatId: 'main' }],
        ['a bad chat id', { conversationId: ID, chatId: '../main' }],
        ['no ids', {}],
        ['no target', null],
    ])('returns null for %s', (_name, target) => {
        expect(resolveConversationChatTarget(directories, target, 25)).toBeNull();
    });

    test('a conversation chat and a character chat of the same names do not share recovery state', () => {
        const conversation = resolveConversationChatTarget(directories, { conversationId: ID, chatId: 'main' }, 25).recoveryTarget;
        const character = createCharacterChatTarget({ chatsDirectory: path.join(root, 'chats'), backupDirectory: directories.backups, owner: ID, filename: 'main.jsonl', maxRecoveryStates: 25 });
        const group = createGroupChatTarget({ groupChatsDirectory: path.join(root, 'group chats'), backupDirectory: directories.backups, filename: 'main.jsonl', maxRecoveryStates: 25 });

        expect(new Set([conversation.id, character.id, group.id]).size).toBe(3);
    });

    test('the recovery state of a conversation chat is written, found again, tombstoned and cleared', () => {
        const { filePath, recoveryTarget } = resolveConversationChatTarget(directories, { conversationId: ID, chatId: 'main' }, 25);
        const data = [{ chat_metadata: { integrity: 'one' } }, { name: 'A', is_user: false, mes: 'hi', send_date: '2026-01-01T00:00:00.000Z' }].map(JSON.stringify).join('\n');

        writeLatestChatSnapshot(recoveryTarget, data);
        expect(fs.existsSync(getChatRecoveryPaths(recoveryTarget).latestPath)).toBe(true);

        const restored = loadActiveChatWithRecovery(recoveryTarget);
        expect(restored.status).toBe('ok');
        expect(restored.recovered).toBe(true);
        expect(restored.records).toHaveLength(2);
        expect(fs.readFileSync(filePath, 'utf8')).toBe(data);

        markChatDeleted(recoveryTarget);
        expect(fs.existsSync(getChatRecoveryPaths(recoveryTarget).tombstonePath)).toBe(true);

        clearChatRecoveryState(recoveryTarget);
        expect(fs.existsSync(getChatRecoveryPaths(recoveryTarget).latestPath)).toBe(false);
        expect(fs.existsSync(getChatRecoveryPaths(recoveryTarget).tombstonePath)).toBe(false);
    });
});
