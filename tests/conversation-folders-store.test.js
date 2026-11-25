import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createSandboxUser, PERSONA, PERSONA_TWO } from './util/conversation-store-sandbox.js';

const {
    ConversationStoreError,
    createConversation,
    readConversationFolders,
    updateConversationFolders,
} = await import('../src/conversation-store.js');
const { acquireChatFileLock } = await import('../src/chat-file-lock.js');
const { getFoldersJsonPath } = await import('../src/conversation-paths.js');

const FOLDER_A = 'fld_1764000000000_a1b2c3d4e5f6';
const FOLDER_B = 'fld_1764000000001_b1b2c3d4e5f6';

let sandbox;
let user;
let filePath;

beforeEach(() => {
    sandbox = createSandboxUser();
    user = sandbox.user;
    filePath = path.join(user.directories.conversations, 'folders.json');
});

afterEach(() => {
    sandbox.cleanup();
});

const direct = (personaId = PERSONA, avatar = 'Nova.png') => createConversation(user, { kind: 'direct', personaId, characters: [avatar] }).conversation;
const create = (id, name = 'Work') => ({ op: 'createFolder', id, name });
const readStored = () => JSON.parse(fs.readFileSync(filePath, 'utf8'));

function codeOf(work) {
    try {
        work();
    } catch (error) {
        return error instanceof ConversationStoreError ? error.code : error;
    }
    return undefined;
}

describe('readConversationFolders', () => {
    test('answers no personas for a user whose folders.json is not there, and does not create it', () => {
        expect(readConversationFolders(user)).toEqual({ version: 1, personas: {} });
        expect(fs.existsSync(filePath)).toBe(false);
    });

    test('reads a hand-edited file leniently: what does not fit is dropped and the rest is kept', () => {
        fs.writeFileSync(filePath, JSON.stringify({
            version: 7,
            personas: {
                [PERSONA]: { folders: [{ id: FOLDER_A, name: 'Kept' }, { id: 'bad', name: 'Dropped' }], members: { conv_1_abcd: FOLDER_A, conv_2_abcd: FOLDER_B } },
                '../outside': { folders: [{ id: FOLDER_A, name: 'Hostile' }] },
            },
        }));
        expect(readConversationFolders(user)).toEqual({
            version: 1,
            personas: { [PERSONA]: { folders: [{ id: FOLDER_A, name: 'Kept', color: '', expanded: true }], members: { conv_1_abcd: FOLDER_A } } },
        });
    });

    test('sets a file that is not JSON aside, starts empty, and writes a new file at the next change', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        fs.writeFileSync(filePath, '{not json');
        expect(readConversationFolders(user)).toEqual({ version: 1, personas: {} });
        expect(fs.existsSync(filePath)).toBe(false);
        expect(fs.readdirSync(user.directories.conversations).some(name => name.startsWith('folders.json.corrupt-'))).toBe(true);

        updateConversationFolders(user, PERSONA, [create(FOLDER_A)]);
        expect(readStored().personas[PERSONA].folders).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});

describe('updateConversationFolders', () => {
    test('writes the file, answers the record of the persona, and keeps the file as pretty JSON of the stored form', () => {
        const record = updateConversationFolders(user, PERSONA, [create(FOLDER_A, 'Work'), { op: 'setFavoritesExpanded', expanded: false }]);
        expect(record).toEqual({ favoritesExpanded: false, folders: [{ id: FOLDER_A, name: 'Work', color: '', expanded: true }], members: {} });
        expect(readStored()).toEqual({
            version: 1,
            personas: { [PERSONA]: { favoritesExpanded: false, folders: [{ id: FOLDER_A, name: 'Work', color: '', expanded: true }], members: {} } },
        });
        expect(fs.readFileSync(filePath, 'utf8')).toContain('\n    "personas"');
    });

    test('files a conversation of the persona and unfiles it again', () => {
        const conversation = direct();
        updateConversationFolders(user, PERSONA, [create(FOLDER_A)]);
        const filed = updateConversationFolders(user, PERSONA, [{ op: 'setMembers', ids: [conversation.id], folderId: FOLDER_A }]);
        expect(filed.members).toEqual({ [conversation.id]: FOLDER_A });
        expect(updateConversationFolders(user, PERSONA, [{ op: 'setMembers', ids: [conversation.id], folderId: null }]).members).toEqual({});
    });

    test('refuses to file a conversation that does not exist, or that belongs to another persona, and writes nothing', () => {
        const other = direct(PERSONA_TWO);
        updateConversationFolders(user, PERSONA, [create(FOLDER_A)]);
        const before = fs.readFileSync(filePath, 'utf8');
        expect(codeOf(() => updateConversationFolders(user, PERSONA, [{ op: 'setMembers', ids: ['conv_1_abcdefgh'], folderId: FOLDER_A }]))).toBe('not_found');
        expect(codeOf(() => updateConversationFolders(user, PERSONA, [{ op: 'setMembers', ids: [other.id], folderId: FOLDER_A }]))).toBe('invalid_input');
        expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    });

    test('unfiles a conversation that no longer exists, because that needs no conversation', () => {
        updateConversationFolders(user, PERSONA, [create(FOLDER_A)]);
        expect(() => updateConversationFolders(user, PERSONA, [{ op: 'setMembers', ids: ['conv_1_abcdefgh'], folderId: null }])).not.toThrow();
    });

    test('is all or nothing: one operation that cannot apply leaves the file as it was', () => {
        updateConversationFolders(user, PERSONA, [create(FOLDER_A)]);
        const before = fs.readFileSync(filePath, 'utf8');
        expect(codeOf(() => updateConversationFolders(user, PERSONA, [create(FOLDER_B, 'New'), { op: 'deleteFolder', id: 'fld_1_zzzzzzzz' }]))).toBe('not_found');
        expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    });

    test('writes nothing when a request changes nothing, and creates no file for a request that ends empty', () => {
        updateConversationFolders(user, PERSONA, [{ op: 'setFavoritesExpanded', expanded: true }]);
        expect(fs.existsSync(filePath)).toBe(false);
        updateConversationFolders(user, PERSONA, [create(FOLDER_A)]);
        const stat = fs.statSync(filePath, { bigint: true });
        updateConversationFolders(user, PERSONA, [{ op: 'updateFolder', id: FOLDER_A, name: 'Work' }]);
        expect(fs.statSync(filePath, { bigint: true }).mtimeNs).toBe(stat.mtimeNs);
    });

    test('removes the entry of a persona whose last folder is deleted', () => {
        updateConversationFolders(user, PERSONA, [create(FOLDER_A)]);
        updateConversationFolders(user, PERSONA_TWO, [create(FOLDER_B)]);
        updateConversationFolders(user, PERSONA, [{ op: 'deleteFolder', id: FOLDER_A }]);
        expect(Object.keys(readStored().personas)).toEqual([PERSONA_TWO]);
    });

    test('keeps the folders of two personas apart, in one file', () => {
        updateConversationFolders(user, PERSONA, [create(FOLDER_A, 'One')]);
        const second = updateConversationFolders(user, PERSONA_TWO, [create(FOLDER_A, 'Two')]);
        expect(second.folders.map(folder => folder.name)).toEqual(['Two']);
        expect(readConversationFolders(user).personas[PERSONA].folders.map(folder => folder.name)).toEqual(['One']);
    });

    test('refuses a persona id that cannot be a file name as invalid_id, and writes nothing', () => {
        for (const personaId of ['', '../x', 'a/b', '__proto__', 'constructor', 5, null, undefined, { toString: () => PERSONA }, ' x']) {
            expect(codeOf(() => updateConversationFolders(user, personaId, [create(FOLDER_A)]))).toBe('invalid_id');
        }
        expect(fs.existsSync(filePath)).toBe(false);
    });

    test('adds the folders of two requests one after the other, each reading the file the other wrote', () => {
        updateConversationFolders(user, PERSONA, [create(FOLDER_A, 'One')]);
        updateConversationFolders(user, PERSONA, [create(FOLDER_B, 'Two')]);
        expect(readConversationFolders(user).personas[PERSONA].folders.map(folder => folder.name)).toEqual(['One', 'Two']);
    });

    test('does not write while another writer holds the lock of the file, and writes once it is released', () => {
        const release = acquireChatFileLock(getFoldersJsonPath(user.directories));
        try {
            const attempt = () => updateConversationFolders(user, PERSONA, [create(FOLDER_A)]);
            // The lock is not reentrant inside one process, so a second holder fails at once and nothing is written.
            expect(codeOf(attempt)).toMatchObject({ code: 'ELOCKED' });
            expect(fs.existsSync(filePath)).toBe(false);
        } finally {
            release();
        }
        expect(() => updateConversationFolders(user, PERSONA, [create(FOLDER_A)])).not.toThrow();
    });

    test('does not follow a link that leads out of the conversations folder', () => {
        const outside = path.join(sandbox.root, 'outside.json');
        fs.writeFileSync(outside, '{"personas":{}}');
        fs.symlinkSync(outside, filePath);
        expect(() => readConversationFolders(user)).toThrow();
        expect(fs.readFileSync(outside, 'utf8')).toBe('{"personas":{}}');
    });

    test('has no handle on a user with no conversations folder', () => {
        expect(codeOf(() => readConversationFolders({ profile: { handle: 'x' }, directories: {} }))).toBe('unavailable');
    });
});
