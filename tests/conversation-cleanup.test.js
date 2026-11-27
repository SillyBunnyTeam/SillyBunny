import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { addCharacters, createSandboxUser, header, line, listBackups, PERSONA, PERSONA_TWO } from './util/conversation-store-sandbox.js';

const {
    createConversation,
    listConversations,
    loadChat,
    readCharacterState,
    readConversation,
    renameAvatarInConversation,
    updateCharacterState,
} = await import('../src/conversation-store.js');
const { deleteConversationsOfCharacter, deleteConversationsOfPersona, renameCharacterInConversations } = await import('../src/conversation-cleanup.js');
const { conversationIndex } = await import('../src/conversation-index.js');
const { getBackupKey } = await import('../src/endpoints/chats.js');
const { getConversationBackupName } = await import('../src/conversation-paths.js');

let sandbox;
let user;
let counter;

beforeEach(() => {
    // The regular chat backup is throttled, and a second save inside the window would leave a timer that would fire after the test.
    jest.useFakeTimers();
    sandbox = createSandboxUser();
    user = sandbox.user;
    counter = 0;
    addCharacters(user, ['Nova.png', 'Orion.png', 'Pip.png', 'Quill.png']);
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    sandbox.cleanup();
});

const folder = id => path.join(user.directories.conversations, id);
const folderNames = () => fs.readdirSync(user.directories.conversations).filter(name => name.startsWith('conv_')).sort();
const chatFile = (id, chatId = 'main') => path.join(folder(id), 'chats', `${chatId}.jsonl`);

function memberLine(id, text, avatar, minute) {
    return { ...line(id, text, { minute }), role: 'member', extra: { member_avatar: avatar } };
}

function make(kind, characters, overrides = {}) {
    counter++;
    return createConversation(user, {
        id: `conv_17000000000${String(counter).padStart(2, '0')}_cleanup${String(counter).padStart(4, '0')}`,
        kind,
        personaId: PERSONA,
        characters,
        chats: [{ id: 'main', name: 'Main', records: [header(), line('u1', 'Hello', { user: true }), line('c1', 'Hi', { minute: 1 })] }],
        ...overrides,
    }).conversation;
}

describe('deleteConversationsOfCharacter', () => {
    test('deletes the direct conversations of the character for every persona, and no one else\'s', () => {
        const mine = make('direct', ['Nova.png']);
        const ofSecondPersona = make('direct', ['Nova.png'], { personaId: PERSONA_TWO });
        const others = make('direct', ['Orion.png']);

        const result = deleteConversationsOfCharacter(user, 'Nova.png');

        expect(folderNames()).toEqual([others.id]);
        expect(result).toMatchObject({ deleted: 2, failed: 0 });
        expect([mine.id, ofSecondPersona.id].some(id => fs.existsSync(folder(id)))).toBe(false);
    });

    test('takes the character out of the groups that keep two members or more', () => {
        const group = make('group', ['Nova.png', 'Orion.png', 'Pip.png'], { name: 'Trio' });
        const chatBefore = fs.readFileSync(chatFile(group.id), 'utf8');

        const result = deleteConversationsOfCharacter(user, 'Nova.png');

        expect(readConversation(user, group.id).characters).toEqual(['Orion.png', 'Pip.png']);
        expect(fs.readFileSync(chatFile(group.id), 'utf8')).toBe(chatBefore);
        expect(result).toMatchObject({ removedFromGroups: 1, converted: 0, failed: 0 });
    });

    test('converts a group of two into the direct conversation of the other character', () => {
        const group = make('group', ['Nova.png', 'Orion.png'], { name: 'Duo' });

        const result = deleteConversationsOfCharacter(user, 'Nova.png');

        expect(result).toMatchObject({ converted: 1, failed: 0 });
        const [id] = folderNames();
        expect(id).not.toBe(group.id);
        expect(readConversation(user, id)).toMatchObject({ kind: 'direct', characters: ['Orion.png'] });
        expect(readConversation(user, id).chats.map(item => item.name)).toEqual(['Duo']);
    });

    test('leaves the groups and conversations that do not hold the character', () => {
        const group = make('group', ['Orion.png', 'Pip.png']);
        const direct = make('direct', ['Quill.png']);

        deleteConversationsOfCharacter(user, 'Nova.png');

        expect(folderNames()).toEqual([group.id, direct.id].sort());
        expect(readConversation(user, group.id).characters).toEqual(['Orion.png', 'Pip.png']);
    });

    test('forgets the routine and status of the character, and keeps those of others', () => {
        updateCharacterState(user, 'Nova.png', { statusOverride: 'dnd', routine: { enabled: true, text: 'Work' } });
        updateCharacterState(user, 'Orion.png', { statusOverride: 'idle' });

        deleteConversationsOfCharacter(user, 'Nova.png');

        expect(Object.keys(readCharacterState(user).characters)).toEqual(['Orion.png']);
    });

    test('writes no characters.json for a character that has no state', () => {
        make('direct', ['Orion.png']);

        deleteConversationsOfCharacter(user, 'Nova.png');

        expect(fs.existsSync(path.join(user.directories.conversations, 'characters.json'))).toBe(false);
    });

    test('drops the index rows of what it deletes', () => {
        const direct = make('direct', ['Nova.png']);
        listConversations(user);
        const file = chatFile(direct.id);
        const stat = fs.statSync(file);
        expect(conversationIndex.get(file, stat, '')).toBeDefined();

        deleteConversationsOfCharacter(user, 'Nova.png');

        expect(conversationIndex.get(file, stat, '')).toBeUndefined();
    });

    test('goes on with the other conversations when one cannot be deleted, and says how many failed', () => {
        const first = make('direct', ['Nova.png']);
        const second = make('direct', ['Nova.png'], { personaId: PERSONA_TWO });
        const remove = fs.rmSync;
        jest.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
            if (String(target).endsWith(first.id)) {
                throw new Error('disk exploded');
            }
            return remove(target, ...rest);
        });

        const result = deleteConversationsOfCharacter(user, 'Nova.png');

        expect(result).toMatchObject({ deleted: 1, failed: 1 });
        expect(fs.existsSync(folder(second.id))).toBe(false);
    });

    test('does nothing for a user with no conversations folder, and for a name that is not an avatar', () => {
        fs.rmSync(user.directories.conversations, { recursive: true, force: true });

        expect(deleteConversationsOfCharacter(user, 'Nova.png')).toMatchObject({ deleted: 0, failed: 0 });
        expect(deleteConversationsOfCharacter({ ...user, directories: { ...user.directories, conversations: undefined } }, 'Nova.png')).toMatchObject({ deleted: 0, failed: 0 });
        expect(deleteConversationsOfCharacter(user, '../Nova.png')).toMatchObject({ deleted: 0, failed: 0 });
    });

    test('never throws, even for a folder that cannot be read', () => {
        make('direct', ['Nova.png']);
        jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
            throw new Error('no access');
        });

        expect(deleteConversationsOfCharacter(user, 'Nova.png')).toMatchObject({ failed: 1 });
    });
});

describe('renameCharacterInConversations', () => {
    const OLD = 'Nova.png';
    const NEW = 'Nova Prime.png';

    test('renames the character in the lists of a direct conversation, a group, the extras and the reminders', async () => {
        const direct = make('direct', [OLD], { extras: ['Pip.png'] });
        const group = make('group', ['Orion.png', OLD], { reminders: [{ id: 'r1', avatar: OLD, chatId: 'main', text: 'x', triggerAt: 5 }] });
        const asExtra = make('direct', ['Orion.png'], { personaId: PERSONA_TWO, extras: [OLD, 'Pip.png'] });

        const result = await renameCharacterInConversations(user, OLD, NEW);

        expect(readConversation(user, direct.id).characters).toEqual([NEW]);
        expect(readConversation(user, group.id).characters).toEqual(['Orion.png', NEW]);
        expect(readConversation(user, group.id).reminders[0].avatar).toBe(NEW);
        expect(readConversation(user, asExtra.id).extras).toEqual([NEW, 'Pip.png']);
        expect(result).toMatchObject({ conversations: 3, failed: 0 });
    });

    test('moves the routine and status of the character to the new name', async () => {
        updateCharacterState(user, OLD, { statusOverride: 'dnd', routine: { enabled: true, text: 'Work' } });
        updateCharacterState(user, 'Orion.png', { statusOverride: 'idle' });

        await renameCharacterInConversations(user, OLD, NEW);

        expect(readCharacterState(user).characters).toEqual({
            [NEW]: { statusOverride: 'dnd', routine: { enabled: true, text: 'Work' } },
            'Orion.png': { statusOverride: 'idle' },
        });
    });

    test('rewrites who wrote the lines, also in a group that the character has left', async () => {
        const left = make('group', ['Orion.png', 'Pip.png'], {
            chats: [{ id: 'main', name: 'Main', records: [header(), memberLine('a', 'Old line', OLD, 1), memberLine('b', 'Orion line', 'Orion.png', 2)] }],
        });

        const result = await renameCharacterInConversations(user, OLD, NEW);

        const records = loadChat(user, left.id, 'main');
        expect(records[1].extra.member_avatar).toBe(NEW);
        expect(records[2].extra.member_avatar).toBe('Orion.png');
        expect(records[0].chat_metadata.integrity).toMatch(/^[0-9a-f-]{36}$/);
        expect(result).toMatchObject({ chats: 1, failed: 0 });
    });

    test('saves a changed chat through the save path, so that it has a backup, and leaves the others as they were', async () => {
        const changed = make('group', ['Orion.png', 'Pip.png'], { chats: [{ id: 'main', records: [header(), memberLine('a', 'x', OLD, 1)] }] });
        const untouched = make('group', ['Orion.png', 'Pip.png'], { chats: [{ id: 'main', records: [header(), memberLine('a', 'x', 'Orion.png', 1)] }] });
        const untouchedBefore = fs.readFileSync(chatFile(untouched.id), 'utf8');

        await renameCharacterInConversations(user, OLD, NEW);

        expect(listBackups(user, `chat_${getBackupKey(getConversationBackupName(changed.id, 'main'))}_`).length).toBeGreaterThan(0);
        expect(listBackups(user, `chat_${getBackupKey(getConversationBackupName(untouched.id, 'main'))}_`)).toHaveLength(0);
        expect(fs.readFileSync(chatFile(untouched.id), 'utf8')).toBe(untouchedBefore);
    });

    test('changes only the field that names who wrote a line, and only when it is the whole name', async () => {
        const lines = [
            header(),
            { ...line('a', `I am ${OLD} and my file is "${OLD}"`, { minute: 1 }), extra: { member_avatar: 'Nova.png.bak', note: OLD } },
            { ...line('b', 'x', { minute: 2 }), extra: { member_avatar: OLD, other: { member_avatar: OLD } } },
            { ...line('c', 'y', { minute: 3 }), extra: {} },
        ];
        const chat = make('group', ['Orion.png', 'Pip.png'], { chats: [{ id: 'main', records: lines }] });

        await renameCharacterInConversations(user, OLD, NEW);

        const [, first, second, third] = loadChat(user, chat.id, 'main');
        expect(first).toEqual(lines[1]);
        expect(second.extra).toEqual({ member_avatar: NEW, other: { member_avatar: OLD } });
        expect(third).toEqual(lines[3]);
    });

    test('finds a name that JSON writes with an escape', async () => {
        const odd = 'Nova "the" Star.png';
        const chat = make('group', ['Orion.png', 'Pip.png'], { chats: [{ id: 'main', records: [header(), memberLine('a', 'x', odd, 1)] }] });

        await renameCharacterInConversations(user, odd, 'Star.png');

        expect(loadChat(user, chat.id, 'main')[1].extra.member_avatar).toBe('Star.png');
    });

    test('a second run changes nothing', async () => {
        make('group', ['Orion.png', OLD], { chats: [{ id: 'main', records: [header(), memberLine('a', 'x', OLD, 1)] }] });
        await renameCharacterInConversations(user, OLD, NEW);
        const files = folderNames().map(id => fs.readFileSync(chatFile(id), 'utf8'));

        const result = await renameCharacterInConversations(user, OLD, NEW);

        expect(result).toMatchObject({ conversations: 0, chats: 0, failed: 0 });
        expect(folderNames().map(id => fs.readFileSync(chatFile(id), 'utf8'))).toEqual(files);
    });

    test('goes on with the other conversations when one fails, and says how many failed', async () => {
        const first = make('group', ['Orion.png', OLD]);
        const second = make('group', ['Pip.png', OLD]);
        const write = fs.renameSync;
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (String(to).endsWith(path.join(first.id, 'conversation.json'))) {
                throw new Error('disk exploded');
            }
            return write(from, to);
        });

        const result = await renameCharacterInConversations(user, OLD, NEW);

        expect(result.failed).toBeGreaterThanOrEqual(1);
        expect(readConversation(user, second.id).characters).toEqual(['Pip.png', NEW]);
    });

    test('does nothing for a user with no conversations folder, for equal names and for names that are not avatars', async () => {
        make('direct', [OLD]);

        await expect(renameCharacterInConversations(user, OLD, OLD)).resolves.toMatchObject({ conversations: 0 });
        await expect(renameCharacterInConversations(user, OLD, '../x.png')).resolves.toMatchObject({ conversations: 0 });
        await expect(renameCharacterInConversations(user, 5, NEW)).resolves.toMatchObject({ conversations: 0 });
        fs.rmSync(user.directories.conversations, { recursive: true, force: true });
        await expect(renameCharacterInConversations(user, OLD, NEW)).resolves.toMatchObject({ conversations: 0 });
    });

    test('deduplicates group members and extras and updates reminders when renaming onto an existing member', () => {
        const trio = make('group', [OLD, 'Orion.png', 'Pip.png'], {
            reminders: [{ id: 'r1', avatar: OLD, chatId: 'main', text: 'Ping', triggerAt: 5 }],
        });
        const directWithExtras = make('direct', ['Orion.png'], { extras: [OLD, 'Pip.png'] });

        expect(renameAvatarInConversation(user, trio.id, OLD, 'Orion.png')).toBe(true);
        expect(readConversation(user, trio.id).characters).toEqual(['Orion.png', 'Pip.png']);
        expect(readConversation(user, trio.id).reminders[0].avatar).toBe('Orion.png');

        expect(renameAvatarInConversation(user, directWithExtras.id, OLD, 'Orion.png')).toBe(true);
        expect(readConversation(user, directWithExtras.id).extras).toEqual(['Pip.png']);
    });

    test('converts a two-member group into a direct conversation when renaming collapses its members to one', () => {
        const duo = make('group', [OLD, 'Orion.png'], {
            name: 'Duo',
            reminders: [{ id: 'r1', avatar: OLD, chatId: 'main', text: 'Ping', triggerAt: 5 }],
        });

        expect(renameAvatarInConversation(user, duo.id, OLD, 'Orion.png')).toBe(true);

        const [remainingId] = folderNames();
        expect(remainingId).not.toBe(duo.id);
        const converted = readConversation(user, remainingId);
        expect(converted).toMatchObject({ kind: 'direct', characters: ['Orion.png'] });
        expect(converted.reminders).toEqual([{ id: 'r1', avatar: 'Orion.png', chatId: 'main', text: 'Ping', triggerAt: 5 }]);
    });
});

describe('deleteConversationsOfPersona', () => {
    test('deletes every conversation of the persona, direct and group, and keeps the others', () => {
        const direct = make('direct', ['Nova.png']);
        const group = make('group', ['Nova.png', 'Orion.png']);
        const ofOther = make('direct', ['Nova.png'], { personaId: PERSONA_TWO });

        const result = deleteConversationsOfPersona(user, PERSONA);

        expect(folderNames()).toEqual([ofOther.id]);
        expect(result).toMatchObject({ deleted: 2, failed: 0 });
        expect([direct.id, group.id].some(id => fs.existsSync(folder(id)))).toBe(false);
    });

    test('drops the index rows, and leaves the backups of the chats', () => {
        const direct = make('direct', ['Nova.png']);
        listConversations(user);
        const stat = fs.statSync(chatFile(direct.id));
        expect(conversationIndex.get(chatFile(direct.id), stat, '')).toBeDefined();

        deleteConversationsOfPersona(user, PERSONA);

        expect(conversationIndex.get(chatFile(direct.id), stat, '')).toBeUndefined();
    });

    test('goes on when one conversation cannot be deleted', () => {
        const first = make('direct', ['Nova.png']);
        const second = make('direct', ['Orion.png']);
        const remove = fs.rmSync;
        jest.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
            if (String(target).endsWith(first.id)) {
                throw new Error('disk exploded');
            }
            return remove(target, ...rest);
        });

        const result = deleteConversationsOfPersona(user, PERSONA);

        expect(result).toMatchObject({ deleted: 1, failed: 1 });
        expect(fs.existsSync(folder(second.id))).toBe(false);
    });

    test('does nothing for a persona that has no conversation, for a name that is not a persona, and for no folder', () => {
        const direct = make('direct', ['Nova.png']);

        expect(deleteConversationsOfPersona(user, 'nobody.png')).toMatchObject({ deleted: 0 });
        expect(deleteConversationsOfPersona(user, '')).toMatchObject({ deleted: 0 });
        expect(deleteConversationsOfPersona(user, ['x'])).toMatchObject({ deleted: 0 });
        expect(deleteConversationsOfPersona({ ...user, directories: { ...user.directories, conversations: undefined } }, PERSONA)).toMatchObject({ deleted: 0 });
        expect(fs.existsSync(folder(direct.id))).toBe(true);
    });
});
