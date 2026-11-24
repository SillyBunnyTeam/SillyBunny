import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { createSandboxUser, header, IMAGES, line, PERSONA, PERSONA_TWO, readJson } from './util/conversation-store-sandbox.js';

const {
    ConversationStoreError,
    createConversation,
    deleteConversation,
    findDirectConversation,
    getConversationAvatarFile,
    listConversations,
    loadChat,
    readCharacterState,
    readConversation,
    removeConversationAvatar,
    setConversationAvatar,
    summarizeChatRecords,
    updateCharacterState,
    updateConversation,
} = await import('../src/conversation-store.js');
const { getChatRecoveryPaths, loadActiveChatWithRecovery } = await import('../src/chat-recovery.js');
const { resolveConversationChatTarget } = await import('../src/conversation-paths.js');

let sandbox;
let user;

beforeEach(() => {
    sandbox = createSandboxUser();
    user = sandbox.user;
});

afterEach(() => {
    sandbox.cleanup();
});

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

const direct = (overrides = {}) => ({ kind: 'direct', personaId: PERSONA, characters: ['Nova.png'], ...overrides });
const group = (overrides = {}) => ({ kind: 'group', personaId: PERSONA, characters: ['Nova.png', 'Orion.png'], ...overrides });

describe('createConversation', () => {
    test('writes a direct conversation with one blank chat and the layout of the plan', () => {
        const { conversation, created } = createConversation(user, direct());

        expect(created).toBe(true);
        expect(conversation.id).toMatch(/^conv_\d+_[0-9a-f]{10}$/);
        expect(conversation).toMatchObject({
            version: 1,
            kind: 'direct',
            personaId: PERSONA,
            characters: ['Nova.png'],
            extras: [],
            name: '',
            description: '',
            avatar: '',
            favorite: false,
            settings: {},
            activeChatId: 'main',
            reminders: [],
            legacyKey: '',
        });
        expect(conversation.chats).toHaveLength(1);
        expect(conversation.chats[0]).toMatchObject({ id: 'main', name: '', readThrough: '', followupCount: 0, lastAutoMessageAt: 0, lastActivity: 0, sessionMarkers: {} });
        expect(conversation.createdAt).toBe(conversation.updatedAt);

        const directory = path.join(user.directories.conversations, conversation.id);
        expect(readJson(path.join(directory, 'conversation.json'))).toEqual(conversation);
        expect(fs.readFileSync(path.join(directory, 'chats', 'main.jsonl'), 'utf8')).toBe(JSON.stringify(header()));
    });

    test('returns the direct conversation of the same persona and character instead of a second one', () => {
        const first = createConversation(user, direct());
        const second = createConversation(user, direct({ name: 'ignored' }));

        expect(second.created).toBe(false);
        expect(second.conversation.id).toBe(first.conversation.id);
        expect(second.conversation.name).toBe('');
        expect(fs.readdirSync(user.directories.conversations)).toHaveLength(1);
    });

    test('keeps a direct conversation per persona and per character', () => {
        const ids = new Set([
            createConversation(user, direct()).conversation.id,
            createConversation(user, direct({ personaId: PERSONA_TWO })).conversation.id,
            createConversation(user, direct({ characters: ['Orion.png'] })).conversation.id,
        ]);

        expect(ids.size).toBe(3);
    });

    test('findDirectConversation finds it by persona and character', () => {
        const { conversation } = createConversation(user, direct());
        createConversation(user, group());

        expect(findDirectConversation(user, PERSONA, 'Nova.png').id).toBe(conversation.id);
        expect(findDirectConversation(user, PERSONA_TWO, 'Nova.png')).toBeNull();
        expect(findDirectConversation(user, PERSONA, 'Orion.png')).toBeNull();
    });

    test('allows several groups with the same members', () => {
        const first = createConversation(user, group({ name: 'One' }));
        const second = createConversation(user, group({ name: 'Two' }));

        expect(first.created && second.created).toBe(true);
        expect(first.conversation.id).not.toBe(second.conversation.id);
    });

    test('writes a group with its name and description', () => {
        const { conversation } = createConversation(user, group({ name: '  Weekend  ', description: 'Plans.' }));

        expect(conversation).toMatchObject({ kind: 'group', characters: ['Nova.png', 'Orion.png'], name: 'Weekend', description: 'Plans.' });
    });

    test('takes ids, chats and state that the migration brings, and writes each chat file', () => {
        const records = [header({ sb_conversation: { memorySummary: 'S' } }), line('a', 'one'), line('b', 'two', { user: true })];
        const { conversation } = createConversation(user, group({
            id: 'conv_1700000000000_abcdef0123',
            createdAt: 1700000000000,
            updatedAt: 1700000001000,
            favorite: true,
            legacyKey: 'persona:x:group:g:Nova.png',
            extras: [],
            settings: { proactive_messaging: true },
            reminders: [{ id: 'rem_1', avatar: 'Nova.png', chatId: 'trip', triggerAt: 5, text: 'pills', fired: false, createdAt: 4 }],
            activeChatId: 'trip',
            chats: [
                { id: 'main', name: 'Main', createdAt: 1, records: [header()] },
                { id: 'trip', name: 'Trip', createdAt: 2, readThrough: 'a', followupCount: 2, lastAutoMessageAt: 9, lastActivity: 8, sessionMarkers: { seen_at: 7 }, legacyId: 'br_old', records },
            ],
        }));

        expect(conversation).toMatchObject({
            id: 'conv_1700000000000_abcdef0123',
            createdAt: 1700000000000,
            updatedAt: 1700000001000,
            favorite: true,
            legacyKey: 'persona:x:group:g:Nova.png',
            settings: { proactive_messaging: true },
            activeChatId: 'trip',
        });
        expect(conversation.chats.map(item => item.id)).toEqual(['main', 'trip']);
        expect(conversation.chats[1]).toMatchObject({ name: 'Trip', readThrough: 'a', followupCount: 2, lastAutoMessageAt: 9, lastActivity: 8, sessionMarkers: { seen_at: 7 }, legacyId: 'br_old' });
        const tripFile = path.join(user.directories.conversations, conversation.id, 'chats', 'trip.jsonl');
        expect(fs.readFileSync(tripFile, 'utf8')).toBe(records.map(record => JSON.stringify(record)).join('\n'));
    });

    test('refuses an id that is already taken, and leaves the first conversation as it was', () => {
        const input = group({ id: 'conv_1_abcd' });
        const first = createConversation(user, input).conversation;

        expect(codeOf(() => createConversation(user, group({ id: 'conv_1_abcd', name: 'Other' })))).toBe('exists');
        expect(readConversation(user, 'conv_1_abcd')).toEqual(first);
    });

    test('removes what it wrote when a chat of the batch cannot be written', () => {
        expect(codeOf(() => createConversation(user, group({
            id: 'conv_2_abcd',
            chats: [{ id: 'main', records: [header()] }, { id: 'broken', records: [header(), 'not an object'] }],
        })))).toBe('invalid_input');

        expect(fs.readdirSync(user.directories.conversations)).toEqual([]);
    });

    test.each([
        ['no kind', { personaId: PERSONA, characters: ['Nova.png'] }],
        ['an unknown kind', direct({ kind: 'channel' })],
        ['no persona', direct({ personaId: '' })],
        ['a persona that is not a string', direct({ personaId: 7 })],
        ['a persona with a slash', direct({ personaId: '../x.png' })],
        ['a direct conversation with two characters', direct({ characters: ['Nova.png', 'Orion.png'] })],
        ['a direct conversation with none', direct({ characters: [] })],
        ['a group with one character', group({ characters: ['Nova.png'] })],
        ['a group that names a character twice', group({ characters: ['Nova.png', 'Nova.png'] })],
        ['a character that is not a string', direct({ characters: [7] })],
        ['a character with a slash', direct({ characters: ['a/b.png'] })],
        ['a character with a backslash', direct({ characters: ['a\\b.png'] })],
        ['a character with a control character', direct({ characters: ['a\u0000.png'] })],
        ['a reserved character name', direct({ characters: ['__proto__'] })],
        ['a character name over 255 characters', direct({ characters: [`${'a'.repeat(256)}.png`] })],
        ['more than 64 characters in a group', group({ characters: Array.from({ length: 65 }, (_, index) => `c${index}.png`) })],
        ['a name over 200 characters', direct({ name: 'n'.repeat(201) })],
        ['a name that is not a string', direct({ name: 5 })],
        ['a description over 8000 characters', direct({ description: 'd'.repeat(8001) })],
        ['a chat id with a slash', direct({ chats: [{ id: 'a/b' }] })],
        ['a chat id that is a device name', direct({ chats: [{ id: 'nul' }] })],
        ['a chat id twice', direct({ chats: [{ id: 'main' }, { id: 'main' }] })],
        ['an active chat that is not in the batch', direct({ chats: [{ id: 'main' }], activeChatId: 'other' })],
        ['an empty list of chats', direct({ chats: [] })],
        ['chat records without a header', direct({ chats: [{ id: 'main', records: [line('a', 'x')] }] })],
        ['chat records that are not an array', direct({ chats: [{ id: 'main', records: 'x' }] })],
        ['a setting with an object value', direct({ settings: { proactive_messaging: { on: true } } })],
        ['a setting key with a capital', direct({ settings: { Proactive: true } })],
        ['a reserved setting key', direct({ settings: { constructor: true } })],
        ['a favorite that is not a boolean', direct({ favorite: 'yes' })],
        ['a field that does not exist', direct({ unknown: 1 })],
        ['a body that is an array', ['direct']],
    ])('refuses %s', (_name, input) => {
        expect(codeOf(() => createConversation(user, input))).toBe('invalid_input');
        expect(fs.readdirSync(user.directories.conversations)).toEqual([]);
    });

    test.each(['../escape', 'conv_1_a/../b', 'conversation_1_abcd', 7])('refuses the id %p', (id) => {
        expect(codeOf(() => createConversation(user, direct({ id })))).toBe('invalid_id');
        expect(fs.readdirSync(user.directories.conversations)).toEqual([]);
    });

    test('a user without a conversations folder gets an unavailable error, not a path outside', () => {
        const noFolder = { profile: user.profile, directories: { backups: user.directories.backups } };
        expect(codeOf(() => createConversation(noFolder, direct()))).toBe('unavailable');
    });
});

describe('readConversation', () => {
    test('reads what was written', () => {
        const { conversation } = createConversation(user, direct());
        expect(readConversation(user, conversation.id)).toEqual(conversation);
    });

    test('is not_found for a conversation that does not exist', () => {
        expect(codeOf(() => readConversation(user, 'conv_1_abcd'))).toBe('not_found');
    });

    test.each(['../x', 'conv_1_a/b', '', 'characters.json', 5, null, undefined, { toString: () => 'conv_1_abcd' }])('is invalid_id for %p', (id) => {
        expect(codeOf(() => readConversation(user, id))).toBe('invalid_id');
    });

    test('is corrupt for a file that is not JSON, and for one that is not an object', () => {
        const { conversation } = createConversation(user, direct());
        const file = path.join(user.directories.conversations, conversation.id, 'conversation.json');

        fs.writeFileSync(file, '{ not json');
        expect(codeOf(() => readConversation(user, conversation.id))).toBe('corrupt');

        fs.writeFileSync(file, '[1,2]');
        expect(codeOf(() => readConversation(user, conversation.id))).toBe('corrupt');
    });

    test('is corrupt when the id inside the file is not the name of its folder', () => {
        const { conversation } = createConversation(user, direct());
        const file = path.join(user.directories.conversations, conversation.id, 'conversation.json');
        fs.writeFileSync(file, JSON.stringify({ ...conversation, id: 'conv_9_other' }));

        expect(codeOf(() => readConversation(user, conversation.id))).toBe('corrupt');
    });

    test('fills a field that an older file lacks and keeps a field that it does not know', () => {
        const { conversation } = createConversation(user, direct());
        const file = path.join(user.directories.conversations, conversation.id, 'conversation.json');
        const older = { ...conversation, futureField: { a: 1 } };
        delete older.favorite;
        delete older.reminders;
        fs.writeFileSync(file, JSON.stringify(older));

        const read = readConversation(user, conversation.id);

        expect(read.favorite).toBe(false);
        expect(read.reminders).toEqual([]);
        expect(read.futureField).toEqual({ a: 1 });
    });

    test('does not read a conversation folder that is a link out of the conversations folder', () => {
        const outside = path.join(sandbox.root, 'outside');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'conversation.json'), JSON.stringify({ id: 'conv_1_abcd', kind: 'direct' }));
        fs.symlinkSync(outside, path.join(user.directories.conversations, 'conv_1_abcd'), 'dir');

        expect(codeOf(() => readConversation(user, 'conv_1_abcd'))).toBe('invalid_id');
    });
});

describe('summarizeChatRecords', () => {
    const records = [
        header(),
        line('a', 'first', { minute: 1 }),
        line('b', '<b>Second</b>   line\nbreak', { user: true, minute: 2 }),
        line('c', 'reply one', { minute: 3 }),
        line('d', 'note', { system: true, minute: 4 }),
        line('e', 'reply two', { minute: 5 }),
    ];

    test('counts messages, takes the last one for time and preview, and counts unread after the read-through message', () => {
        expect(summarizeChatRecords(records, 'b')).toEqual({
            messageCount: 5,
            lastMessageAt: Date.UTC(2026, 0, 1, 0, 5),
            preview: 'reply two',
            unread: 2,
            lastMessageRole: 'character',
            hasUserMessage: true,
        });
    });

    test('names the role of the last message, whatever it is', () => {
        const role = list => summarizeChatRecords([header(), ...list], '').lastMessageRole;
        expect(role([line('a', 'hi', { user: true })])).toBe('user');
        expect(role([line('a', 'hi', { system: true })])).toBe('system');
        expect(role([line('a', 'hi')])).toBe('character');
        expect(role([{ ...line('a', 'hi'), role: 'member' }])).toBe('member');
        expect(role([line('a', 'hi', { user: true }), line('b', 'hello')])).toBe('character');
        expect(role([{ name: 'A', mes: 'x', role: 'user' }])).toBe('user');
    });

    test('says whether the user wrote anything, apart from system notes', () => {
        const has = list => summarizeChatRecords([header(), ...list], '').hasUserMessage;
        expect(has([line('a', 'x'), line('b', 'y', { system: true })])).toBe(false);
        expect(has([line('a', 'x'), line('b', 'y', { user: true })])).toBe(true);
        expect(has([{ name: 'A', mes: 'x', role: 'user' }])).toBe(true);
    });

    test('an empty read-through marker means that nothing was read yet', () => {
        expect(summarizeChatRecords(records, '').unread).toBe(3);
    });

    test('a read-through marker that names no message counts no unread message', () => {
        expect(summarizeChatRecords(records, 'gone').unread).toBe(0);
    });

    test('messages from the user and system notes are never unread', () => {
        expect(summarizeChatRecords(records, 'a').unread).toBe(2);
    });

    test('strips markup and collapses whitespace in the preview, and cuts it at 160 characters', () => {
        expect(summarizeChatRecords([header(), line('x', '<b>Second</b>   line\nbreak')], 'x').preview).toBe('Second line break');
        expect(summarizeChatRecords([header(), line('x', 'w'.repeat(500))], 'x').preview).toHaveLength(160);
    });

    test('a chat with only its header is empty', () => {
        expect(summarizeChatRecords([header()], '')).toEqual({ messageCount: 0, lastMessageAt: 0, preview: '', unread: 0, lastMessageRole: '', hasUserMessage: false });
    });

    test('takes the time from send_date when a message has no created_at', () => {
        const stamped = { name: 'A', is_user: false, mes: 'x', send_date: '2026-03-04T05:06:07.000Z' };
        expect(summarizeChatRecords([header(), stamped], '').lastMessageAt).toBe(Date.parse('2026-03-04T05:06:07.000Z'));
    });
});

describe('listConversations', () => {
    test('an empty folder lists nothing', () => {
        expect(listConversations(user)).toEqual({ conversations: [], problems: [] });
    });

    test('lists every conversation, newest message first, with counts for each chat and in total', () => {
        const older = createConversation(user, direct({
            id: 'conv_1_olderrr',
            chats: [{ id: 'main', readThrough: 'a', records: [header(), line('a', 'old', { minute: 1 }), line('b', 'older reply', { minute: 2 })] }],
        })).conversation;
        const newer = createConversation(user, group({
            id: 'conv_2_newerrr',
            activeChatId: 'second',
            chats: [
                { id: 'main', records: [header(), line('c', 'x', { minute: 10 })] },
                { id: 'second', readThrough: '', records: [header(), line('d', 'newest', { minute: 30 }), line('e', 'again', { minute: 31 })] },
            ],
        })).conversation;
        const empty = createConversation(user, direct({ characters: ['Orion.png'], id: 'conv_3_emptyyy' })).conversation;

        const { conversations, problems } = listConversations(user);

        expect(problems).toEqual([]);
        expect(conversations.map(item => item.id)).toEqual([newer.id, older.id, empty.id]);
        expect(conversations[0]).toMatchObject({
            kind: 'group',
            messageCount: 3,
            lastMessageAt: Date.UTC(2026, 0, 1, 0, 31),
            preview: 'again',
            unread: 3,
            lastMessageRole: 'character',
            hasUserMessage: false,
        });
        expect(conversations[0].chats.map(item => [item.id, item.messageCount, item.unread])).toEqual([['main', 1, 1], ['second', 2, 2]]);
        expect(conversations[1]).toMatchObject({ messageCount: 2, preview: 'older reply', unread: 1 });
        expect(conversations[2]).toMatchObject({ messageCount: 0, lastMessageAt: 0, preview: '', unread: 0, lastMessageRole: '', hasUserMessage: false });
    });

    test('a chat that is listed but has no file counts as empty', () => {
        const { conversation } = createConversation(user, direct());
        fs.rmSync(path.join(user.directories.conversations, conversation.id, 'chats', 'main.jsonl'));

        const { conversations } = listConversations(user);

        expect(conversations[0].messageCount).toBe(0);
    });

    test('skips a corrupt conversation, a folder that is not a conversation and stray files, and reports the first kind', () => {
        const good = createConversation(user, direct()).conversation;
        const broken = createConversation(user, direct({ characters: ['Orion.png'] })).conversation;
        fs.writeFileSync(path.join(user.directories.conversations, broken.id, 'conversation.json'), '{ nope');
        fs.mkdirSync(path.join(user.directories.conversations, 'not-a-conversation'));
        fs.writeFileSync(path.join(user.directories.conversations, 'stray.txt'), 'x');
        fs.mkdirSync(path.join(user.directories.conversations, 'conv_5_emptyfolder'));

        const { conversations, problems } = listConversations(user);

        expect(conversations.map(item => item.id)).toEqual([good.id]);
        expect(problems).toHaveLength(2);
        expect(problems).toEqual(expect.arrayContaining([
            { id: broken.id, error: 'corrupt' },
            { id: 'conv_5_emptyfolder', error: 'not_found' },
        ]));
    });

    test('lists nothing when the folder does not exist yet', () => {
        fs.rmSync(user.directories.conversations, { recursive: true });
        expect(listConversations(user)).toEqual({ conversations: [], problems: [] });
    });
});

describe('updateConversation', () => {
    let conversation;

    beforeEach(() => {
        conversation = createConversation(user, group({
            id: 'conv_1_abcdef',
            chats: [{ id: 'main', records: [header(), line('a', 'x')] }, { id: 'other' }],
            extras: [],
        })).conversation;
    });

    test('changes the plain fields and moves updatedAt forward', async () => {
        await new Promise(resolve => setTimeout(resolve, 5));

        const updated = updateConversation(user, conversation.id, { name: ' Renamed ', description: 'New text', favorite: true, activeChatId: 'other' });

        expect(updated).toMatchObject({ name: 'Renamed', description: 'New text', favorite: true, activeChatId: 'other' });
        expect(updated.updatedAt).toBeGreaterThan(conversation.updatedAt);
        expect(readConversation(user, conversation.id)).toEqual(updated);
    });

    test('merges settings, and a null removes a key so that the stored settings stay sparse', () => {
        updateConversation(user, conversation.id, { settings: { proactive_messaging: true, authors_note: 'Stay.' } });
        const updated = updateConversation(user, conversation.id, { settings: { authors_note: null, inactivity_threshold: 90 } });

        expect(updated.settings).toEqual({ proactive_messaging: true, inactivity_threshold: 90 });
    });

    test('changes the state of one chat and leaves the others', () => {
        const updated = updateConversation(user, conversation.id, {
            chats: { main: { readThrough: 'a', name: 'Renamed chat', followupCount: 2, lastAutoMessageAt: 11, lastActivity: 12, sessionMarkers: { seen_at: 3 } } },
        });

        expect(updated.chats[0]).toMatchObject({ id: 'main', name: 'Renamed chat', readThrough: 'a', followupCount: 2, lastAutoMessageAt: 11, lastActivity: 12, sessionMarkers: { seen_at: 3 } });
        expect(updated.chats[1]).toMatchObject({ id: 'other', name: '', readThrough: '' });
    });

    test('replaces the reminders', () => {
        const reminders = [{ id: 'rem_1', avatar: 'Nova.png', chatId: 'main', triggerAt: 5, text: 'pills', fired: false, createdAt: 4 }];

        expect(updateConversation(user, conversation.id, { reminders }).reminders).toEqual(reminders);
        expect(updateConversation(user, conversation.id, { reminders: [] }).reminders).toEqual([]);
    });

    test('changes the members of a group, and keeps at least two', () => {
        const updated = updateConversation(user, conversation.id, { characters: ['Nova.png', 'Orion.png', 'Lyra.png'] });
        expect(updated.characters).toEqual(['Nova.png', 'Orion.png', 'Lyra.png']);

        expect(codeOf(() => updateConversation(user, conversation.id, { characters: ['Nova.png'] }))).toBe('invalid_input');
    });

    test('lets extras be removed and never added', () => {
        const withExtras = createConversation(user, direct({ id: 'conv_2_abcdef', extras: ['Vega.png', 'Cass.png'] })).conversation;

        expect(updateConversation(user, withExtras.id, { extras: ['Cass.png'] }).extras).toEqual(['Cass.png']);
        expect(codeOf(() => updateConversation(user, withExtras.id, { extras: ['Cass.png', 'Lyra.png'] }))).toBe('invalid_input');
    });

    test('does not change the character of a direct conversation', () => {
        const solo = createConversation(user, direct({ id: 'conv_3_abcdef' })).conversation;
        expect(codeOf(() => updateConversation(user, solo.id, { characters: ['Orion.png'] }))).toBe('invalid_input');
    });

    test('returns the conversation without a write when nothing changes', () => {
        const file = path.join(user.directories.conversations, conversation.id, 'conversation.json');
        const before = fs.statSync(file).mtimeMs;

        const same = updateConversation(user, conversation.id, { name: conversation.name, favorite: false });

        expect(same).toEqual(conversation);
        expect(fs.statSync(file).mtimeMs).toBe(before);
    });

    test('two updates one after the other both stay', () => {
        updateConversation(user, conversation.id, { name: 'First' });
        updateConversation(user, conversation.id, { favorite: true });

        expect(readConversation(user, conversation.id)).toMatchObject({ name: 'First', favorite: true });
    });

    test.each([
        ['an active chat that does not exist', { activeChatId: 'gone' }],
        ['a state for a chat that does not exist', { chats: { gone: { readThrough: 'a' } } }],
        ['a state for a chat id that is a path', { chats: { '../main': { readThrough: 'a' } } }],
        ['an avatar field', { avatar: 'avatar.png' }],
        ['an id field', { id: 'conv_9_other' }],
        ['a kind field', { kind: 'direct' }],
        ['a persona field', { personaId: PERSONA_TWO }],
        ['a created time', { createdAt: 5 }],
        ['a field that does not exist', { nothing: 1 }],
        ['a name over 200 characters', { name: 'n'.repeat(201) }],
        ['a favorite that is not a boolean', { favorite: 1 }],
        ['a setting that is an array', { settings: { authors_note: ['a'] } }],
        ['a setting string over 64 KiB', { settings: { authors_note: 'x'.repeat(65537) } }],
        ['more than 128 settings', { settings: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key_${index}`, true])) }],
        ['a setting key that is a path', { settings: { '../a': true } }],
        ['a reminder with a field that does not exist', { reminders: [{ id: 'rem_1', unknown: 1 }] }],
        ['a reminder text over 4096 characters', { reminders: [{ id: 'rem_1', text: 't'.repeat(4097) }] }],
        ['more than 500 reminders', { reminders: Array.from({ length: 501 }, (_, index) => ({ id: `rem_${index}` })) }],
        ['reminders that are not an array', { reminders: {} }],
        ['a marker value that is an object', { chats: { main: { sessionMarkers: { seen_at: {} } } } }],
        ['a negative counter', { chats: { main: { followupCount: -1 } } }],
        ['a read-through marker that is not a string', { chats: { main: { readThrough: 5 } } }],
        ['a patch that is an array', []],
        ['a patch that is null', null],
    ])('refuses %s', (_name, patch) => {
        expect(codeOf(() => updateConversation(user, conversation.id, patch))).toBe('invalid_input');
        expect(readConversation(user, conversation.id)).toEqual(conversation);
    });

    test('is not_found for a conversation that does not exist and invalid_id for a bad id', () => {
        expect(codeOf(() => updateConversation(user, 'conv_9_abcdef', { name: 'x' }))).toBe('not_found');
        expect(codeOf(() => updateConversation(user, '../x', { name: 'x' }))).toBe('invalid_id');
    });
});

describe('deleteConversation', () => {
    test('removes the folder with every chat, and the recovery copies of its chats go with it', () => {
        const { conversation } = createConversation(user, group({ chats: [{ id: 'main' }, { id: 'second' }] }));
        const recoveryTargets = ['main', 'second'].map(chatId => resolveConversationChatTarget(user.directories, { conversationId: conversation.id, chatId }, 25).recoveryTarget);
        for (const chatId of ['main', 'second']) {
            loadChat(user, conversation.id, chatId);
        }
        for (const target of recoveryTargets) {
            expect(fs.existsSync(getChatRecoveryPaths(target).latestPath)).toBe(true);
        }

        deleteConversation(user, conversation.id);

        expect(fs.existsSync(path.join(user.directories.conversations, conversation.id))).toBe(false);
        for (const target of recoveryTargets) {
            expect(fs.existsSync(getChatRecoveryPaths(target).latestPath)).toBe(false);
            expect(loadActiveChatWithRecovery(target).status).toBe('missing');
        }
        expect(codeOf(() => readConversation(user, conversation.id))).toBe('not_found');
        expect(listConversations(user).conversations).toEqual([]);
    });

    test('leaves other conversations, the character file and the backups alone', () => {
        const keep = createConversation(user, direct({ characters: ['Orion.png'] })).conversation;
        const { conversation } = createConversation(user, direct());
        updateCharacterState(user, 'Nova.png', { statusOverride: 'dnd' });
        fs.writeFileSync(path.join(user.directories.backups, 'chat_conversation_keep.jsonl'), '{}');

        deleteConversation(user, conversation.id);

        expect(readConversation(user, keep.id)).toEqual(keep);
        expect(readCharacterState(user).characters['Nova.png']).toEqual({ statusOverride: 'dnd' });
        expect(fs.existsSync(path.join(user.directories.backups, 'chat_conversation_keep.jsonl'))).toBe(true);
    });

    test('is not_found the second time, and invalid_id for a bad id', () => {
        const { conversation } = createConversation(user, direct());
        deleteConversation(user, conversation.id);

        expect(codeOf(() => deleteConversation(user, conversation.id))).toBe('not_found');
        expect(codeOf(() => deleteConversation(user, '..'))).toBe('invalid_id');
        expect(codeOf(() => deleteConversation(user, 'conv_1_abcd/../..'))).toBe('invalid_id');
    });

    test('removes a folder that has no readable conversation.json too, so that a broken folder can be cleaned up', () => {
        const { conversation } = createConversation(user, direct());
        fs.writeFileSync(path.join(user.directories.conversations, conversation.id, 'conversation.json'), '{ nope');

        deleteConversation(user, conversation.id);

        expect(fs.existsSync(path.join(user.directories.conversations, conversation.id))).toBe(false);
    });

    test('does not remove what a link in the conversations folder points to', () => {
        const outside = path.join(sandbox.root, 'outside');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
        fs.symlinkSync(outside, path.join(user.directories.conversations, 'conv_1_abcd'), 'dir');

        expect(codeOf(() => deleteConversation(user, 'conv_1_abcd'))).toBe('invalid_id');
        expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('x');
    });
});

describe('the avatar of a group', () => {
    let conversation;

    beforeEach(() => {
        conversation = createConversation(user, group()).conversation;
    });

    test.each([['png', 'avatar.png', 'image/png'], ['jpeg', 'avatar.jpg', 'image/jpeg'], ['gif', 'avatar.gif', 'image/gif'], ['webp', 'avatar.webp', 'image/webp']])('stores %s data under a name that the server chooses', (type, fileName, contentType) => {
        const updated = setConversationAvatar(user, conversation.id, IMAGES[type]);

        expect(updated.avatar).toBe(fileName);
        expect(fs.readFileSync(path.join(user.directories.conversations, conversation.id, fileName))).toEqual(IMAGES[type]);
        expect(getConversationAvatarFile(user, conversation.id)).toEqual({
            filePath: path.join(user.directories.conversations, conversation.id, fileName),
            contentType,
        });
        expect(readConversation(user, conversation.id).avatar).toBe(fileName);
    });

    test('a new picture replaces the old one and removes its file', () => {
        setConversationAvatar(user, conversation.id, IMAGES.png);
        const updated = setConversationAvatar(user, conversation.id, IMAGES.jpeg);

        expect(updated.avatar).toBe('avatar.jpg');
        expect(fs.readdirSync(path.join(user.directories.conversations, conversation.id)).sort()).toEqual(['avatar.jpg', 'chats', 'conversation.json']);
    });

    test('removing it clears the field and the file, and removing again changes nothing', () => {
        setConversationAvatar(user, conversation.id, IMAGES.png);

        expect(removeConversationAvatar(user, conversation.id).avatar).toBe('');
        expect(fs.existsSync(path.join(user.directories.conversations, conversation.id, 'avatar.png'))).toBe(false);
        expect(getConversationAvatarFile(user, conversation.id)).toBeNull();
        expect(removeConversationAvatar(user, conversation.id).avatar).toBe('');
    });

    test.each([
        ['text', Buffer.from('hello world, not an image at all')],
        ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
        ['an HTML page', Buffer.from('<html><script>alert(1)</script></html>')],
        ['an empty buffer', Buffer.alloc(0)],
        ['a RIFF file that is not WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(16)])],
        ['a string', 'data'],
        ['more than 5 MiB', Buffer.concat([IMAGES.png, Buffer.alloc(5 * 1024 * 1024)])],
    ])('refuses %s and keeps the picture that was there', (_name, data) => {
        setConversationAvatar(user, conversation.id, IMAGES.png);

        expect(codeOf(() => setConversationAvatar(user, conversation.id, data))).toBe('invalid_input');
        expect(readConversation(user, conversation.id).avatar).toBe('avatar.png');
    });

    test('a direct conversation has no avatar of its own', () => {
        const solo = createConversation(user, direct()).conversation;
        expect(codeOf(() => setConversationAvatar(user, solo.id, IMAGES.png))).toBe('invalid_input');
    });

    test('a conversation file that names another avatar file is not trusted', () => {
        const file = path.join(user.directories.conversations, conversation.id, 'conversation.json');
        fs.writeFileSync(file, JSON.stringify({ ...conversation, avatar: '../../../etc/passwd' }));

        expect(readConversation(user, conversation.id).avatar).toBe('');
        expect(getConversationAvatarFile(user, conversation.id)).toBeNull();
    });

    test('is not_found for a conversation that does not exist', () => {
        expect(codeOf(() => setConversationAvatar(user, 'conv_9_abcdef', IMAGES.png))).toBe('not_found');
    });
});

describe('the state of characters', () => {
    test('is empty at first', () => {
        expect(readCharacterState(user)).toEqual({ version: 1, characters: {} });
    });

    test('keeps a routine and a status override for each character', () => {
        const routine = { enabled: true, text: 'Weekdays: work', generatedAt: 1700000000000 };

        expect(updateCharacterState(user, 'Nova.png', { routine, statusOverride: 'dnd' })).toEqual({ routine, statusOverride: 'dnd' });
        updateCharacterState(user, 'Orion.png', { statusOverride: 'offline' });

        expect(readCharacterState(user)).toEqual({
            version: 1,
            characters: { 'Nova.png': { routine, statusOverride: 'dnd' }, 'Orion.png': { statusOverride: 'offline' } },
        });
        expect(readJson(path.join(user.directories.conversations, 'characters.json'))).toEqual(readCharacterState(user));
    });

    test('a patch changes only the fields it names, and null clears one', () => {
        updateCharacterState(user, 'Nova.png', { routine: { enabled: true, text: 'a', generatedAt: 1 }, statusOverride: 'dnd' });

        expect(updateCharacterState(user, 'Nova.png', { statusOverride: null })).toEqual({ routine: { enabled: true, text: 'a', generatedAt: 1 } });
        expect(updateCharacterState(user, 'Nova.png', { routine: { enabled: false } })).toEqual({ routine: { enabled: false, text: 'a', generatedAt: 1 } });
        expect(updateCharacterState(user, 'Nova.png', { routine: null })).toEqual({});
        expect(readCharacterState(user).characters).toEqual({});
    });

    test.each([
        ['an avatar with a slash', 'a/b.png', { statusOverride: 'dnd' }],
        ['a reserved avatar', '__proto__', { statusOverride: 'dnd' }],
        ['an empty avatar', '', { statusOverride: 'dnd' }],
        ['a status that does not exist', 'Nova.png', { statusOverride: 'asleep' }],
        ['a field that does not exist', 'Nova.png', { mood: 'happy' }],
        ['a routine text over 64 KiB', 'Nova.png', { routine: { text: 'x'.repeat(65537) } }],
        ['a routine that is a string', 'Nova.png', { routine: 'x' }],
        ['a routine field that does not exist', 'Nova.png', { routine: { extra: 1 } }],
        ['a routine time that is not a number', 'Nova.png', { routine: { generatedAt: 'now' } }],
        ['a patch that is an array', 'Nova.png', []],
    ])('refuses %s', (_name, avatar, patch) => {
        expect(codeOf(() => updateCharacterState(user, avatar, patch))).toBe('invalid_input');
        expect(readCharacterState(user)).toEqual({ version: 1, characters: {} });
    });

    test('a file that cannot be read is set aside and the state starts empty', () => {
        const file = path.join(user.directories.conversations, 'characters.json');
        fs.writeFileSync(file, '{ not json');

        expect(readCharacterState(user)).toEqual({ version: 1, characters: {} });
        expect(fs.existsSync(file)).toBe(false);
        expect(fs.readdirSync(user.directories.conversations).some(name => name.startsWith('characters.json.corrupt-'))).toBe(true);
    });

    test('drops entries of a stored file that are not valid, and keeps the valid ones', () => {
        const file = path.join(user.directories.conversations, 'characters.json');
        fs.writeFileSync(file, JSON.stringify({
            version: 1,
            characters: { 'Nova.png': { statusOverride: 'dnd', junk: 1 }, 'a/b.png': { statusOverride: 'dnd' }, 'Orion.png': 'x' },
        }));

        expect(readCharacterState(user).characters).toEqual({ 'Nova.png': { statusOverride: 'dnd' } });
    });
});
