import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { addCharacters, createSandboxUser, header, line, PERSONA, PERSONA_TWO } from './util/conversation-store-sandbox.js';

const {
    createConversation,
    deleteConversation,
    readConversationFolders,
    removeMember,
    updateConversationFolders,
} = await import('../src/conversation-store.js');
const { deleteConversationsOfCharacter, deleteConversationsOfPersona } = await import('../src/conversation-cleanup.js');

const FOLDER_A = 'fld_1764000000000_a1b2c3d4e5f6';
const FOLDER_B = 'fld_1764000000001_b1b2c3d4e5f6';

let sandbox;
let user;
let filePath;

beforeEach(() => {
    jest.useFakeTimers();
    sandbox = createSandboxUser();
    user = sandbox.user;
    filePath = path.join(user.directories.conversations, 'folders.json');
    addCharacters(user, ['Nova.png', 'Orion.png', 'Pip.png']);
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    sandbox.cleanup();
});

function make(kind, characters, overrides = {}) {
    return createConversation(user, {
        kind,
        personaId: PERSONA,
        characters,
        chats: [{ id: 'main', name: 'Main', createdAt: 50, records: [header(), line('m1', 'Hello', { user: true, minute: 1 })] }],
        ...overrides,
    }).conversation;
}

const file = () => readConversationFolders(user);
const folderOf = (conversation, personaId = PERSONA) => file().personas[personaId]?.members[conversation.id];
const folders = (personaId = PERSONA) => file().personas[personaId]?.folders ?? [];
const fileText = () => fs.readFileSync(filePath, 'utf8');

/** Two folders for the persona, with the conversations filed in the first. */
function file_(...conversations) {
    updateConversationFolders(user, PERSONA, [
        { op: 'createFolder', id: FOLDER_A, name: 'Work' },
        { op: 'createFolder', id: FOLDER_B, name: 'Friends' },
        ...(conversations.length ? [{ op: 'setMembers', ids: conversations.map(conversation => conversation.id), folderId: FOLDER_A }] : []),
    ]);
}

describe('a deleted conversation', () => {
    test('leaves its folder: the entry goes and the other entries and the folders stay', () => {
        const first = make('direct', ['Nova.png']);
        const second = make('direct', ['Orion.png']);
        file_(first, second);

        deleteConversation(user, first.id);

        expect(file().personas[PERSONA].members).toEqual({ [second.id]: FOLDER_A });
        expect(folders().map(folder => folder.id)).toEqual([FOLDER_A, FOLDER_B]);
    });

    test('writes nothing when the conversation was not in a folder, and takes no lock for a user with no folders', () => {
        const filed = make('direct', ['Nova.png']);
        const loose = make('direct', ['Orion.png']);
        file_(filed);
        const before = fileText();

        deleteConversation(user, loose.id);

        expect(fileText()).toBe(before);
        const other = make('direct', ['Pip.png']);
        fs.rmSync(filePath);
        deleteConversation(user, other.id);
        expect(fs.existsSync(filePath)).toBe(false);
    });

    test('is deleted all the same when the folders file cannot be written, and the failure is logged and not thrown', () => {
        const conversation = make('direct', ['Nova.png']);
        file_(conversation);
        fs.rmSync(filePath);
        fs.mkdirSync(filePath);

        expect(() => deleteConversation(user, conversation.id)).not.toThrow();
        expect(fs.existsSync(path.join(user.directories.conversations, conversation.id))).toBe(false);
    });

    test('takes the entry out of the persona that has it and no other', () => {
        const mine = make('direct', ['Nova.png']);
        const theirs = make('direct', ['Nova.png'], { personaId: PERSONA_TWO });
        file_(mine);
        updateConversationFolders(user, PERSONA_TWO, [{ op: 'createFolder', id: FOLDER_A, name: 'Theirs' }, { op: 'setMembers', ids: [theirs.id], folderId: FOLDER_A }]);

        deleteConversation(user, mine.id);

        expect(file().personas[PERSONA].members).toEqual({});
        expect(file().personas[PERSONA_TWO].members).toEqual({ [theirs.id]: FOLDER_A });
    });
});

describe('a deleted character', () => {
    test('takes the direct conversations of the card out of their folders', () => {
        const nova = make('direct', ['Nova.png']);
        const orion = make('direct', ['Orion.png']);
        file_(nova, orion);

        const result = deleteConversationsOfCharacter(user, 'Nova.png');

        expect(result.deleted).toBe(1);
        expect(file().personas[PERSONA].members).toEqual({ [orion.id]: FOLDER_A });
    });

    test('converts a group of two into a direct conversation that keeps the folder of the group', () => {
        const group = make('group', ['Nova.png', 'Orion.png']);
        file_(group);

        const result = deleteConversationsOfCharacter(user, 'Nova.png');

        expect(result.converted).toBe(1);
        const [direct] = fs.readdirSync(user.directories.conversations).filter(name => name.startsWith('conv_'));
        expect(file().personas[PERSONA].members).toEqual({ [direct]: FOLDER_A });
    });
});

describe('a deleted persona', () => {
    test('loses its folders and its filed conversations, and leaves the folders of another persona', () => {
        const mine = make('direct', ['Nova.png']);
        const theirs = make('direct', ['Orion.png'], { personaId: PERSONA_TWO });
        file_(mine);
        updateConversationFolders(user, PERSONA_TWO, [{ op: 'createFolder', id: FOLDER_B, name: 'Theirs' }, { op: 'setMembers', ids: [theirs.id], folderId: FOLDER_B }]);

        expect(deleteConversationsOfPersona(user, PERSONA)).toEqual({ deleted: 1, failed: 0 });

        expect(Object.keys(file().personas)).toEqual([PERSONA_TWO]);
        expect(file().personas[PERSONA_TWO].members).toEqual({ [theirs.id]: FOLDER_B });
    });

    test('loses its folders when it had no conversation to file in them', () => {
        file_();

        expect(deleteConversationsOfPersona(user, PERSONA)).toEqual({ deleted: 0, failed: 0 });

        expect(fs.existsSync(filePath) ? file().personas : {}).toEqual({});
    });

    test('counts a folders file that cannot be changed as a failure, and still deletes the conversations', () => {
        const conversation = make('direct', ['Nova.png']);
        file_(conversation);
        fs.rmSync(filePath);
        fs.mkdirSync(filePath);

        expect(deleteConversationsOfPersona(user, PERSONA)).toEqual({ deleted: 1, failed: 1 });
    });

    test('does nothing for a user with no folders file', () => {
        make('direct', ['Nova.png']);

        expect(deleteConversationsOfPersona(user, PERSONA)).toEqual({ deleted: 1, failed: 0 });
        expect(fs.existsSync(filePath)).toBe(false);
    });
});

describe('a group that is converted into a direct conversation', () => {
    test('gives a direct conversation that the conversion made the folder of the group, as it gives it the favourite', () => {
        const group = make('group', ['Nova.png', 'Orion.png'], { favorite: true });
        file_(group);

        const { conversation: direct, converted } = removeMember(user, group.id, 'Orion.png');

        expect(converted).toBe(true);
        expect(direct.favorite).toBe(true);
        expect(file().personas[PERSONA].members).toEqual({ [direct.id]: FOLDER_A });
    });

    test('leaves a direct conversation that existed in its own folder, and drops the entry of the group', () => {
        const existing = make('direct', ['Nova.png']);
        const group = make('group', ['Nova.png', 'Orion.png']);
        updateConversationFolders(user, PERSONA, [
            { op: 'createFolder', id: FOLDER_A, name: 'Work' },
            { op: 'createFolder', id: FOLDER_B, name: 'Friends' },
            { op: 'setMembers', ids: [existing.id], folderId: FOLDER_B },
            { op: 'setMembers', ids: [group.id], folderId: FOLDER_A },
        ]);

        const { conversation: direct } = removeMember(user, group.id, 'Orion.png');

        expect(direct.id).toBe(existing.id);
        expect(file().personas[PERSONA].members).toEqual({ [existing.id]: FOLDER_B });
    });

    test('leaves an existing direct conversation that was in no folder in none, whatever folder the group was in', () => {
        const existing = make('direct', ['Nova.png']);
        const group = make('group', ['Nova.png', 'Orion.png']);
        file_(group);

        removeMember(user, group.id, 'Orion.png');

        expect(folderOf(existing)).toBeUndefined();
        expect(file().personas[PERSONA].members).toEqual({});
    });

    test('keeps no folder for a group that was in none', () => {
        const group = make('group', ['Nova.png', 'Orion.png']);
        file_();

        const { conversation: direct } = removeMember(user, group.id, 'Orion.png');

        expect(folderOf(direct)).toBeUndefined();
    });

    test('leaves a group with three members in its folder when one member leaves', () => {
        const group = make('group', ['Nova.png', 'Orion.png', 'Pip.png']);
        file_(group);

        removeMember(user, group.id, 'Pip.png');

        expect(folderOf(group)).toBe(FOLDER_A);
    });

    test('is still converted when the folders file cannot be changed, and the group is gone', () => {
        const group = make('group', ['Nova.png', 'Orion.png']);
        file_(group);
        fs.rmSync(filePath);
        fs.mkdirSync(filePath);

        const { converted, removedId } = removeMember(user, group.id, 'Orion.png');

        expect(converted).toBe(true);
        expect(fs.existsSync(path.join(user.directories.conversations, removedId))).toBe(false);
    });
});
