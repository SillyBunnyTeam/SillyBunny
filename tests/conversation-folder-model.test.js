import { describe, expect, test } from '@jest/globals';

import {
    FolderInputError,
    MAX_FOLDERS_PER_PERSONA,
    MAX_FOLDER_NAME_LENGTH,
    MAX_FOLDER_OPS,
    MAX_MEMBER_IDS_PER_OP,
    applyFolderOps,
    emptyFolderRecord,
    folderIdOf,
    getPersonaFolders,
    isConversationIdLike,
    normalizeFolderFile,
    normalizeFolderRecord,
    parseFolderOps,
    withConvertedGroup,
    withPersonaFolders,
    withoutConversation,
    withoutPersona,
} from '../public/scripts/sillybunny-conversation/folder-model.js';
import { CONVERSATION_ID_PATTERN } from '../src/conversation-paths.js';
import { isSafeName } from '../src/conversation-schema.js';

const FOLDER_A = 'fld_1764000000000_a1b2c3d4e5f6';
const FOLDER_B = 'fld_1764000000001_b1b2c3d4e5f6';
const FOLDER_C = 'fld_1764000000002_c1b2c3d4e5f6';
const CONV_1 = 'conv_1764000000000_aaaa1111';
const CONV_2 = 'conv_1764000000001_bbbb2222';
const CONV_3 = 'conv_1764000000002_cccc3333';

const folder = (id, name = 'Work', extra = {}) => ({ id, name, color: '', expanded: true, ...extra });
const record = (folders = [], members = {}, favoritesExpanded = true) => ({ favoritesExpanded, folders, members });
const ids = count => Array.from({ length: count }, (_, index) => `fld_1764000000000_${String(index).padStart(12, 'a')}`);

function errorOf(work) {
    try {
        work();
    } catch (error) {
        return error;
    }
    return undefined;
}

function codeOf(work) {
    const error = errorOf(work);
    return error instanceof FolderInputError ? error.code : error;
}

describe('the conversation id pattern of the model', () => {
    test('is the pattern of the paths module, so that the page and the server agree on what a conversation id is', () => {
        for (const sample of [CONV_1, 'conv_1_abcd', 'conv_12345678901234567_abcd', 'conv_1_abc', 'conv_x_abcd', 'conv_1_abcd/..', '', 'CONV_1_abcd']) {
            expect(isConversationIdLike(sample)).toBe(CONVERSATION_ID_PATTERN.test(sample));
        }
    });

    test('refuses a value that is not a string, even one whose toString gives an id', () => {
        expect(isConversationIdLike({ toString: () => CONV_1 })).toBe(false);
        expect(isConversationIdLike([CONV_1])).toBe(false);
        expect(isConversationIdLike(null)).toBe(false);
    });
});

describe('normalizeFolderRecord', () => {
    test('keeps a good record as it is', () => {
        const stored = record([folder(FOLDER_A, 'Work', { color: '#aabbcc', expanded: false })], { [CONV_1]: FOLDER_A }, false);
        expect(normalizeFolderRecord(stored)).toEqual(stored);
    });

    test('reads anything that is not an object as the empty record', () => {
        for (const raw of [null, undefined, 'x', 5, [], [1]]) {
            expect(normalizeFolderRecord(raw)).toEqual(emptyFolderRecord());
        }
    });

    test('drops a folder with a bad id or a name that is empty, not text or only control characters, and keeps the rest', () => {
        const folders = [
            folder('nope'),
            folder(FOLDER_A, '   '),
            { id: FOLDER_B, name: 7 },
            { id: FOLDER_B, name: '\u0000\u0001' },
            folder(FOLDER_C, 'Kept'),
            null,
            'text',
        ];
        expect(normalizeFolderRecord({ folders }).folders).toEqual([folder(FOLDER_C, 'Kept')]);
    });

    test('cuts a name past the limit, takes control characters out of it and trims it', () => {
        const [cut] = normalizeFolderRecord({ folders: [folder(FOLDER_A, `  ${'x'.repeat(MAX_FOLDER_NAME_LENGTH + 50)}`)] }).folders;
        expect(cut.name).toBe('x'.repeat(MAX_FOLDER_NAME_LENGTH));
        const [clean] = normalizeFolderRecord({ folders: [folder(FOLDER_A, 'Wo\nrk\u0007')] }).folders;
        expect(clean.name).toBe('Work');
    });

    test('keeps the first of two folders that share an id and stops at the most folders a persona may have', () => {
        expect(normalizeFolderRecord({ folders: [folder(FOLDER_A, 'First'), folder(FOLDER_A, 'Second')] }).folders.map(item => item.name)).toEqual(['First']);
        const many = ids(MAX_FOLDERS_PER_PERSONA + 5).map(id => folder(id));
        expect(normalizeFolderRecord({ folders: many }).folders).toHaveLength(MAX_FOLDERS_PER_PERSONA);
    });

    test('drops a colour that is not a hex, rgb or hsl colour, so that no url() or free text reaches a style', () => {
        for (const color of ['url(https://example.test/x)', 'red', 'rgb(0,0,0); background: red', 'javascript:1', 5, '#12', `#${'a'.repeat(70)}`]) {
            expect(normalizeFolderRecord({ folders: [folder(FOLDER_A, 'Work', { color })] }).folders[0].color).toBe('');
        }
        for (const color of ['#abc', '#aabbcc', '#aabbccdd', 'rgba(255, 0, 0, 1)', 'rgb(1,2,3)', 'hsl(120deg 50% 50% / 0.5)']) {
            expect(normalizeFolderRecord({ folders: [folder(FOLDER_A, 'Work', { color })] }).folders[0].color).toBe(color);
        }
    });

    test('reads a dangling folder id as no folder: a member whose folder is gone, whose key is no conversation id or whose folder is not text is dropped', () => {
        const stored = { folders: [folder(FOLDER_A)], members: { [CONV_1]: FOLDER_A, [CONV_2]: FOLDER_B, 'conv_bad': FOLDER_A, [CONV_3]: 5, '../x': FOLDER_A } };
        const read = normalizeFolderRecord(stored);
        expect(read.members).toEqual({ [CONV_1]: FOLDER_A });
        expect(folderIdOf(read, CONV_2)).toBe('');
        expect(folderIdOf(read, CONV_1)).toBe(FOLDER_A);
    });

    test('keeps no prototype key as a member and does not pollute Object.prototype', () => {
        const hostile = JSON.parse(`{"folders":[],"members":{"__proto__":"${FOLDER_A}","constructor":"${FOLDER_A}"}}`);
        const read = normalizeFolderRecord(hostile);
        expect(read.members).toEqual({});
        expect({}.polluted).toBeUndefined();
        expect(folderIdOf(read, '__proto__')).toBe('');
        expect(folderIdOf(read, 'constructor')).toBe('');
    });

    test('reads favoritesExpanded as true unless it is exactly false', () => {
        expect(normalizeFolderRecord({ favoritesExpanded: false }).favoritesExpanded).toBe(false);
        for (const value of [true, 0, 'false', null, undefined]) {
            expect(normalizeFolderRecord({ favoritesExpanded: value }).favoritesExpanded).toBe(true);
        }
    });
});

describe('normalizeFolderFile', () => {
    test('reads a missing, empty or foreign file as no personas', () => {
        for (const raw of [null, undefined, {}, [], 'x', { personas: [] }, { personas: 'x' }, { version: 9 }]) {
            expect(normalizeFolderFile(raw)).toEqual({ version: 1, personas: {} });
        }
    });

    test('keeps a persona only while it has a folder or a closed Favorites, and writes favoritesExpanded only when it is false', () => {
        const file = normalizeFolderFile({
            version: 1,
            personas: {
                'a.png': record([folder(FOLDER_A)], { [CONV_1]: FOLDER_A }),
                'b.png': record([], {}, false),
                'c.png': record([], {}, true),
                'd.png': { members: { [CONV_1]: FOLDER_A } },
            },
        });
        expect(file.personas).toEqual({
            'a.png': { folders: [folder(FOLDER_A)], members: { [CONV_1]: FOLDER_A } },
            'b.png': { favoritesExpanded: false, folders: [], members: {} },
        });
    });

    test('drops a persona key that the predicate or the reserved names refuse, so that a hostile key cannot reach a path or a prototype', () => {
        const hostile = JSON.parse(JSON.stringify({ personas: { 'ok.png': record([folder(FOLDER_A)]) } }).replace('{"personas":{', '{"personas":{"__proto__":{"folders":[{"id":"' + FOLDER_B + '","name":"X"}]},"constructor":{"folders":[{"id":"' + FOLDER_B + '","name":"X"}]},"../x":{"folders":[{"id":"' + FOLDER_B + '","name":"X"}]},'));
        expect(Object.keys(normalizeFolderFile(hostile, { isPersonaKey: isSafeName }).personas)).toEqual(['ok.png']);
        expect(Object.keys(normalizeFolderFile(hostile).personas).sort()).toEqual(['../x', 'ok.png']);
    });

    test('is idempotent: reading what it returned changes nothing', () => {
        const once = normalizeFolderFile({ personas: { 'a.png': record([folder(FOLDER_A)], { [CONV_1]: FOLDER_A, [CONV_2]: FOLDER_B }, false) } });
        expect(normalizeFolderFile(once)).toEqual(once);
    });
});

describe('getPersonaFolders and withPersonaFolders', () => {
    test('give the empty record for a persona with no entry, and a copy that a caller can change', () => {
        const file = normalizeFolderFile({ personas: { 'a.png': record([folder(FOLDER_A)]) } });
        expect(getPersonaFolders(file, 'zzz.png')).toEqual(emptyFolderRecord());
        const copy = getPersonaFolders(file, 'a.png');
        copy.folders.push(folder(FOLDER_B));
        expect(getPersonaFolders(file, 'a.png').folders).toHaveLength(1);
    });

    test('remove the entry of a persona whose record is empty again', () => {
        const file = withPersonaFolders({ version: 1, personas: {} }, 'a.png', record([folder(FOLDER_A)]));
        expect(Object.keys(file.personas)).toEqual(['a.png']);
        expect(withPersonaFolders(file, 'a.png', emptyFolderRecord()).personas).toEqual({});
    });
});

describe('parseFolderOps', () => {
    test('refuses anything that is not a list of 1 to 32 operations', () => {
        for (const input of [undefined, null, {}, 'x', [], Array.from({ length: MAX_FOLDER_OPS + 1 }, () => ({ op: 'deleteFolder', id: FOLDER_A }))]) {
            expect(codeOf(() => parseFolderOps(input))).toBe('invalid_input');
        }
        expect(parseFolderOps(Array.from({ length: MAX_FOLDER_OPS }, () => ({ op: 'deleteFolder', id: FOLDER_A })))).toHaveLength(MAX_FOLDER_OPS);
    });

    test('refuses an operation that is not an object, has no known name, or has a field of another operation', () => {
        for (const op of [null, 'createFolder', [], { op: 'rename' }, { op: 5 }, { op: '__proto__' }, { op: 'constructor' }, { op: 'deleteFolder', id: FOLDER_A, extra: 1 }, { op: 'createFolder', id: FOLDER_A, name: 'x', to: 1 }]) {
            expect(codeOf(() => parseFolderOps([op]))).toBe('invalid_input');
        }
    });

    test('refuses a folder id that is not a folder id as invalid_id, with every hostile shape', () => {
        for (const id of ['', 'x', '../x', '__proto__', 'fld_1_short', `fld_1_${'a'.repeat(40)}`, 5, null, undefined, { toString: () => FOLDER_A }, [FOLDER_A]]) {
            expect(codeOf(() => parseFolderOps([{ op: 'deleteFolder', id }]))).toBe('invalid_id');
        }
    });

    test('refuses a name that is empty, blank, over 100 characters, not text or has a control character, and trims a good one', () => {
        const create = name => parseFolderOps([{ op: 'createFolder', id: FOLDER_A, name }]);
        for (const name of ['', '   ', 'x'.repeat(MAX_FOLDER_NAME_LENGTH + 1), 5, null, undefined, 'a\nb', 'a\u0000b', 'a\u007Fb', { toString: () => 'x' }]) {
            expect(codeOf(() => create(name))).toBe('invalid_input');
        }
        expect(create('  Work  ')[0].name).toBe('Work');
        expect(create('x'.repeat(MAX_FOLDER_NAME_LENGTH))[0].name).toHaveLength(MAX_FOLDER_NAME_LENGTH);
        expect(create('constructor')[0].name).toBe('constructor');
    });

    test('refuses a colour that is not empty or a hex, rgb or hsl colour, and a flag that is not a boolean', () => {
        for (const color of ['url(x)', 'red', 5, null]) {
            expect(codeOf(() => parseFolderOps([{ op: 'createFolder', id: FOLDER_A, name: 'x', color }]))).toBe('invalid_input');
        }
        for (const expanded of ['true', 1, null]) {
            expect(codeOf(() => parseFolderOps([{ op: 'createFolder', id: FOLDER_A, name: 'x', expanded }]))).toBe('invalid_input');
        }
    });

    test('gives a created folder its defaults', () => {
        expect(parseFolderOps([{ op: 'createFolder', id: FOLDER_A, name: 'x' }])).toEqual([{ op: 'createFolder', id: FOLDER_A, name: 'x', color: '', expanded: true }]);
    });

    test('refuses an update that changes nothing', () => {
        expect(codeOf(() => parseFolderOps([{ op: 'updateFolder', id: FOLDER_A }]))).toBe('invalid_input');
        expect(parseFolderOps([{ op: 'updateFolder', id: FOLDER_A, expanded: false }])).toEqual([{ op: 'updateFolder', id: FOLDER_A, expanded: false }]);
    });

    test('refuses a place that is not a whole number from 0 up', () => {
        for (const to of [-1, 1.5, '1', null, undefined, NaN, Infinity, MAX_FOLDERS_PER_PERSONA]) {
            expect(codeOf(() => parseFolderOps([{ op: 'moveFolder', id: FOLDER_A, to }]))).toBe('invalid_input');
        }
    });

    test('refuses member ids that are not a list of 1 to 256 conversation ids, none twice', () => {
        const set = idsValue => parseFolderOps([{ op: 'setMembers', ids: idsValue, folderId: FOLDER_A }]);
        for (const value of [undefined, null, 'x', [], Array.from({ length: MAX_MEMBER_IDS_PER_OP + 1 }, (_, index) => `conv_1_${String(index).padStart(6, 'a')}`)]) {
            expect(codeOf(() => set(value))).toBe('invalid_input');
        }
        for (const value of [['x'], ['../x'], ['__proto__'], [5], [{ toString: () => CONV_1 }], [CONV_1, 'conv_']]) {
            expect(codeOf(() => set(value))).toBe('invalid_id');
        }
        expect(codeOf(() => set([CONV_1, CONV_1]))).toBe('invalid_input');
    });

    test('takes a folder id or null as the folder of the members, and nothing else', () => {
        expect(parseFolderOps([{ op: 'setMembers', ids: [CONV_1], folderId: null }])[0].folderId).toBeNull();
        expect(codeOf(() => parseFolderOps([{ op: 'setMembers', ids: [CONV_1] }]))).toBe('invalid_input');
        expect(codeOf(() => parseFolderOps([{ op: 'setMembers', ids: [CONV_1], folderId: 'x' }]))).toBe('invalid_id');
    });

    test('takes only a boolean for the open state of Favorites', () => {
        expect(parseFolderOps([{ op: 'setFavoritesExpanded', expanded: false }])).toEqual([{ op: 'setFavoritesExpanded', expanded: false }]);
        expect(codeOf(() => parseFolderOps([{ op: 'setFavoritesExpanded', expanded: 'no' }]))).toBe('invalid_input');
        expect(codeOf(() => parseFolderOps([{ op: 'setFavoritesExpanded' }]))).toBe('invalid_input');
    });
});

describe('applyFolderOps', () => {
    const run = (start, ops) => applyFolderOps(start, parseFolderOps(ops));

    test('appends a created folder at the end', () => {
        const next = run(record([folder(FOLDER_A, 'First')]), [{ op: 'createFolder', id: FOLDER_B, name: 'Second', color: '#abc', expanded: false }]);
        expect(next.folders).toEqual([folder(FOLDER_A, 'First'), { id: FOLDER_B, name: 'Second', color: '#abc', expanded: false }]);
    });

    test('refuses a folder id that is taken as exists and the 51st folder as invalid_input', () => {
        expect(codeOf(() => run(record([folder(FOLDER_A)]), [{ op: 'createFolder', id: FOLDER_A, name: 'x' }]))).toBe('exists');
        const full = record(ids(MAX_FOLDERS_PER_PERSONA).map(id => folder(id)));
        expect(codeOf(() => run(full, [{ op: 'createFolder', id: FOLDER_B, name: 'x' }]))).toBe('invalid_input');
        expect(run(record(ids(MAX_FOLDERS_PER_PERSONA - 1).map(id => folder(id))), [{ op: 'createFolder', id: FOLDER_B, name: 'x' }]).folders).toHaveLength(MAX_FOLDERS_PER_PERSONA);
    });

    test('updates only the fields that are named, in the folder that is named', () => {
        const next = run(record([folder(FOLDER_A, 'One'), folder(FOLDER_B, 'Two')]), [{ op: 'updateFolder', id: FOLDER_B, name: 'Renamed', color: '#fff' }]);
        expect(next.folders).toEqual([folder(FOLDER_A, 'One'), folder(FOLDER_B, 'Renamed', { color: '#fff' })]);
        expect(codeOf(() => run(record(), [{ op: 'updateFolder', id: FOLDER_A, name: 'x' }]))).toBe('not_found');
    });

    test('moves a folder to an absolute place, to either end and by one, and refuses a place past the last folder', () => {
        const start = record([folder(FOLDER_A, 'A'), folder(FOLDER_B, 'B'), folder(FOLDER_C, 'C')]);
        const order = ops => run(start, ops).folders.map(item => item.name);
        expect(order([{ op: 'moveFolder', id: FOLDER_C, to: 0 }])).toEqual(['C', 'A', 'B']);
        expect(order([{ op: 'moveFolder', id: FOLDER_A, to: 2 }])).toEqual(['B', 'C', 'A']);
        expect(order([{ op: 'moveFolder', id: FOLDER_B, to: 1 }])).toEqual(['A', 'B', 'C']);
        expect(codeOf(() => order([{ op: 'moveFolder', id: FOLDER_A, to: 3 }]))).toBe('invalid_input');
        expect(codeOf(() => order([{ op: 'moveFolder', id: 'fld_1_zzzzzzzz', to: 0 }]))).toBe('not_found');
    });

    test('deletes a folder with its member entries and leaves the members of other folders', () => {
        const start = record([folder(FOLDER_A), folder(FOLDER_B)], { [CONV_1]: FOLDER_A, [CONV_2]: FOLDER_B });
        const next = run(start, [{ op: 'deleteFolder', id: FOLDER_A }]);
        expect(next.folders.map(item => item.id)).toEqual([FOLDER_B]);
        expect(next.members).toEqual({ [CONV_2]: FOLDER_B });
        expect(codeOf(() => run(next, [{ op: 'deleteFolder', id: FOLDER_A }]))).toBe('not_found');
    });

    test('files and unfiles members, moves one from a folder to another, and refuses a folder that does not exist', () => {
        const start = record([folder(FOLDER_A), folder(FOLDER_B)], { [CONV_1]: FOLDER_A });
        expect(run(start, [{ op: 'setMembers', ids: [CONV_1, CONV_2], folderId: FOLDER_B }]).members).toEqual({ [CONV_1]: FOLDER_B, [CONV_2]: FOLDER_B });
        expect(run(start, [{ op: 'setMembers', ids: [CONV_1, CONV_3], folderId: null }]).members).toEqual({});
        expect(codeOf(() => run(start, [{ op: 'setMembers', ids: [CONV_1], folderId: FOLDER_C }]))).toBe('not_found');
    });

    test('runs the operations in order, so a folder can be created and filled in one request', () => {
        const next = run(record(), [
            { op: 'createFolder', id: FOLDER_A, name: 'New' },
            { op: 'setMembers', ids: [CONV_1], folderId: FOLDER_A },
        ]);
        expect(next.members).toEqual({ [CONV_1]: FOLDER_A });
    });

    test('is all or nothing: a later operation that cannot apply leaves the caller with the record it gave', () => {
        const start = record([folder(FOLDER_A)]);
        const before = JSON.stringify(start);
        expect(codeOf(() => run(start, [{ op: 'createFolder', id: FOLDER_B, name: 'x' }, { op: 'deleteFolder', id: FOLDER_C }]))).toBe('not_found');
        expect(JSON.stringify(start)).toBe(before);
    });

    test('does not change the record it was given when it succeeds', () => {
        const start = record([folder(FOLDER_A)], { [CONV_1]: FOLDER_A });
        const before = JSON.stringify(start);
        run(start, [{ op: 'updateFolder', id: FOLDER_A, name: 'Other' }, { op: 'setMembers', ids: [CONV_1], folderId: null }, { op: 'setFavoritesExpanded', expanded: false }]);
        expect(JSON.stringify(start)).toBe(before);
    });

    test('sets the open state of Favorites', () => {
        expect(run(record(), [{ op: 'setFavoritesExpanded', expanded: false }]).favoritesExpanded).toBe(false);
    });

    test('ends with the empty record when the last folder is deleted, which the file takes as no entry', () => {
        const next = run(record([folder(FOLDER_A)], { [CONV_1]: FOLDER_A }), [{ op: 'deleteFolder', id: FOLDER_A }]);
        expect(withPersonaFolders({ version: 1, personas: { 'a.png': record([folder(FOLDER_A)]) } }, 'a.png', next).personas).toEqual({});
    });
});

describe('what the store does to a whole file', () => {
    const file = normalizeFolderFile({
        personas: {
            'a.png': record([folder(FOLDER_A)], { [CONV_1]: FOLDER_A, [CONV_2]: FOLDER_A }),
            'b.png': record([folder(FOLDER_B)], { [CONV_3]: FOLDER_B }),
        },
    });

    test('withoutConversation removes the entry from whichever persona has it, and returns the same object when none has', () => {
        const next = withoutConversation(file, CONV_1);
        expect(getPersonaFolders(next, 'a.png').members).toEqual({ [CONV_2]: FOLDER_A });
        expect(getPersonaFolders(next, 'b.png').members).toEqual({ [CONV_3]: FOLDER_B });
        expect(withoutConversation(file, 'conv_9_zzzzzzzz')).toBe(file);
    });

    test('withoutPersona removes one persona and nothing else', () => {
        expect(Object.keys(withoutPersona(file, 'a.png').personas)).toEqual(['b.png']);
        expect(withoutPersona(file, 'zzz.png')).toBe(file);
    });

    test('withConvertedGroup gives a new direct conversation the folder of the group, and keeps the folder of one that existed', () => {
        const created = withConvertedGroup(file, 'a.png', CONV_1, 'conv_5_newdirect');
        expect(getPersonaFolders(created, 'a.png').members).toEqual({ [CONV_2]: FOLDER_A, conv_5_newdirect: FOLDER_A });
        const appended = withConvertedGroup(file, 'a.png', CONV_1, '');
        expect(getPersonaFolders(appended, 'a.png').members).toEqual({ [CONV_2]: FOLDER_A });
        expect(withConvertedGroup(file, 'a.png', 'conv_9_zzzzzzzz', 'conv_5_newdirect')).toBe(file);
    });
});
