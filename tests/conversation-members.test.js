import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { addCharacters, createSandboxUser, header, line, PERSONA } from './util/conversation-store-sandbox.js';

const {
    addMembers,
    ConversationStoreError,
    createConversation,
    listConversations,
    loadChat,
    readConversation,
    removeExtra,
    removeMember,
    saveChat,
} = await import('../src/conversation-store.js');
const { conversationIndex } = await import('../src/conversation-index.js');

const GROUP_ID = 'conv_1700000000000_group00001';
const DIRECT_ID = 'conv_1700000000001_direct0001';

let sandbox;
let user;

beforeEach(() => {
    // The regular chat backup is throttled, and a second save inside the window would leave a timer that would fire after the test.
    jest.useFakeTimers();
    sandbox = createSandboxUser();
    user = sandbox.user;
    addCharacters(user, ['Nova.png', 'Orion.png', 'Pip.png', 'Quill.png']);
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    sandbox.cleanup();
});

const folder = id => path.join(user.directories.conversations, id);
const chatFile = (id, chatId = 'main') => path.join(folder(id), 'chats', `${chatId}.jsonl`);
const readText = filePath => fs.readFileSync(filePath, 'utf8');
const folderNames = () => fs.readdirSync(user.directories.conversations).sort();

function errorOf(operation) {
    try {
        operation();
    } catch (error) {
        return error;
    }
    return undefined;
}

function codeOf(operation) {
    const error = errorOf(operation);
    return error instanceof ConversationStoreError ? error.code : error;
}

/** A line that a group chat holds: the member who wrote it is in `extra.member_avatar`. */
function memberLine(id, text, avatar, minute) {
    return { ...line(id, text, { minute }), role: 'member', extra: { member_avatar: avatar } };
}

const MAIN_MEMORY = { memory_summary: 'They planned the trip.', memory_message_count: 3, memory_updated_at: 5 };

function makeGroup(overrides = {}) {
    return createConversation(user, {
        id: GROUP_ID,
        kind: 'group',
        personaId: PERSONA,
        characters: ['Nova.png', 'Orion.png'],
        name: 'Weekend plans',
        favorite: true,
        settings: { authors_note: 'Keep it light.' },
        reminders: [{ id: 'r1', avatar: 'Nova.png', chatId: 'trip', text: 'Pack', triggerAt: 10 }],
        activeChatId: 'trip',
        chats: [
            {
                id: 'main',
                name: 'Main',
                createdAt: 100,
                readThrough: 'a3',
                records: [header({ sb_conversation: MAIN_MEMORY }), line('a1', 'Hello', { user: true, minute: 1 }), memberLine('a2', 'Hi!', 'Nova.png', 2), memberLine('a3', 'Hey', 'Orion.png', 3)],
            },
            {
                id: 'trip',
                name: 'Trip',
                createdAt: 200,
                records: [header(), line('b1', 'Where to?', { user: true, minute: 10 }), memberLine('b2', 'The coast', 'Orion.png', 11)],
            },
        ],
        ...overrides,
    }).conversation;
}

function makeDirect(overrides = {}) {
    return createConversation(user, {
        id: DIRECT_ID,
        kind: 'direct',
        personaId: PERSONA,
        characters: ['Nova.png'],
        chats: [{ id: 'main', name: 'Main', createdAt: 50, records: [header(), line('d1', 'Earlier', { user: true, minute: 0 })] }],
        ...overrides,
    }).conversation;
}

describe('addMembers on a group', () => {
    test('adds the characters after the members it has, and writes nothing to the chats', () => {
        makeGroup();
        const chatBefore = readText(chatFile(GROUP_ID));

        const { conversation, created } = addMembers(user, GROUP_ID, ['Pip.png', 'Quill.png']);

        expect(created).toBe(false);
        expect(conversation.characters).toEqual(['Nova.png', 'Orion.png', 'Pip.png', 'Quill.png']);
        expect(readConversation(user, GROUP_ID).characters).toEqual(conversation.characters);
        expect(readText(chatFile(GROUP_ID))).toBe(chatBefore);
        expect(folderNames()).toEqual([GROUP_ID]);
    });

    test.each([
        ['an empty list', []],
        ['a character twice', ['Pip.png', 'Pip.png']],
        ['a character that is a member already', ['Nova.png']],
        ['a character that does not exist', ['Ghost.png']],
        ['a file that is not a card', ['notes.txt']],
        ['a name that is a path', ['../Pip.png']],
        ['a name with a separator', ['sub/Pip.png']],
        ['a name that is a backslash path', ['..\\Pip.png']],
        ['a name with a NUL byte', ['Pip.png\u0000']],
        ['a number', [5]],
        ['an object', [{ toString: 'Pip.png' }]],
        ['a string instead of a list', 'Pip.png'],
        ['null', null],
    ])('refuses %s and changes nothing', (_name, avatars) => {
        makeGroup();
        const before = readText(path.join(folder(GROUP_ID), 'conversation.json'));

        expect(codeOf(() => addMembers(user, GROUP_ID, avatars))).toBe('invalid_input');
        expect(readText(path.join(folder(GROUP_ID), 'conversation.json'))).toBe(before);
    });

    test('is not_found for a conversation that does not exist, and invalid_id for an id that is not one', () => {
        expect(codeOf(() => addMembers(user, 'conv_9_abcdef', ['Pip.png']))).toBe('not_found');
        expect(codeOf(() => addMembers(user, '../x', ['Pip.png']))).toBe('invalid_id');
        expect(codeOf(() => addMembers(user, 5, ['Pip.png']))).toBe('invalid_id');
    });

    test('refuses a group of more than 64 members', () => {
        const names = Array.from({ length: 63 }, (_, index) => `Extra${index}.png`);
        addCharacters(user, names);
        makeGroup();

        expect(codeOf(() => addMembers(user, GROUP_ID, names))).toBe('invalid_input');
        expect(readConversation(user, GROUP_ID).characters).toEqual(['Nova.png', 'Orion.png']);
    });
});

describe('addMembers on a direct conversation', () => {
    test('starts a new group with that character and the chosen ones, and leaves the direct conversation as it is', () => {
        makeDirect();
        const before = readText(path.join(folder(DIRECT_ID), 'conversation.json'));
        const chatBefore = readText(chatFile(DIRECT_ID));

        const { conversation, created } = addMembers(user, DIRECT_ID, ['Orion.png', 'Pip.png']);

        expect(created).toBe(true);
        expect(conversation).toMatchObject({ kind: 'group', personaId: PERSONA, characters: ['Nova.png', 'Orion.png', 'Pip.png'], name: '', extras: [] });
        expect(conversation.id).not.toBe(DIRECT_ID);
        expect(conversation.chats).toHaveLength(1);
        expect(loadChat(user, conversation.id, conversation.chats[0].id)).toEqual([header()]);
        expect(readText(path.join(folder(DIRECT_ID), 'conversation.json'))).toBe(before);
        expect(readText(chatFile(DIRECT_ID))).toBe(chatBefore);
        expect(folderNames()).toEqual([DIRECT_ID, conversation.id].sort());
    });

    test('lets the characters of the new group react, as a group that the app makes does', () => {
        makeDirect();

        const { conversation } = addMembers(user, DIRECT_ID, ['Orion.png']);

        expect(conversation.settings).toEqual({ characters_react: true });
        expect(readConversation(user, conversation.id).settings).toEqual({ characters_react: true });
    });

    test('a second call starts a second group', () => {
        makeDirect();

        const first = addMembers(user, DIRECT_ID, ['Orion.png']).conversation;
        const second = addMembers(user, DIRECT_ID, ['Orion.png']).conversation;

        expect(second.id).not.toBe(first.id);
    });

    test.each([
        ['no one', []],
        ['the character of the conversation', ['Nova.png']],
        ['a character twice', ['Orion.png', 'Orion.png']],
        ['a character that does not exist', ['Ghost.png']],
        ['a name that is a path', ['../Orion.png']],
    ])('refuses %s and creates nothing', (_name, avatars) => {
        makeDirect();

        expect(codeOf(() => addMembers(user, DIRECT_ID, avatars))).toBe('invalid_input');
        expect(folderNames()).toEqual([DIRECT_ID]);
    });
});

describe('removeMember', () => {
    test('takes a member out of a group that keeps at least two, and the past messages stay', () => {
        makeGroup({ characters: ['Nova.png', 'Orion.png', 'Pip.png'] });
        const chatBefore = readText(chatFile(GROUP_ID));

        const result = removeMember(user, GROUP_ID, 'Orion.png');

        expect(result.converted).toBe(false);
        expect(result.conversation).toMatchObject({ id: GROUP_ID, kind: 'group', characters: ['Nova.png', 'Pip.png'] });
        expect(readConversation(user, GROUP_ID).characters).toEqual(['Nova.png', 'Pip.png']);
        expect(readText(chatFile(GROUP_ID))).toBe(chatBefore);
        expect(folderNames()).toEqual([GROUP_ID]);
    });

    test.each([
        ['a character that is not a member', 'Quill.png', 'not_found'],
        ['a name that is a path', '../Nova.png', 'invalid_input'],
        ['a name with a NUL byte', 'Nova.png\u0000', 'invalid_input'],
        ['a number', 5, 'invalid_input'],
        ['an object', { toString: 'Nova.png' }, 'invalid_input'],
        ['nothing', undefined, 'invalid_input'],
    ])('refuses %s', (_name, avatar, code) => {
        makeGroup({ characters: ['Nova.png', 'Orion.png', 'Pip.png'] });
        const before = readText(path.join(folder(GROUP_ID), 'conversation.json'));

        expect(codeOf(() => removeMember(user, GROUP_ID, avatar))).toBe(code);
        expect(readText(path.join(folder(GROUP_ID), 'conversation.json'))).toBe(before);
    });

    test('refuses a direct conversation, which has no members to remove', () => {
        makeDirect();

        expect(codeOf(() => removeMember(user, DIRECT_ID, 'Nova.png'))).toBe('invalid_input');
    });

    test('refuses the last member of a group that lists one, and leaves the group', () => {
        makeGroup({ characters: ['Nova.png', 'Orion.png'] });
        const file = path.join(folder(GROUP_ID), 'conversation.json');
        fs.writeFileSync(file, JSON.stringify({ ...readConversation(user, GROUP_ID), characters: ['Nova.png'] }));

        expect(codeOf(() => removeMember(user, GROUP_ID, 'Nova.png'))).toBe('invalid_input');
        expect(fs.existsSync(folder(GROUP_ID))).toBe(true);
    });

    test('is not_found for a conversation that does not exist, and invalid_id for an id that is not one', () => {
        expect(codeOf(() => removeMember(user, 'conv_9_abcdef', 'Nova.png'))).toBe('not_found');
        expect(codeOf(() => removeMember(user, '../x', 'Nova.png'))).toBe('invalid_id');
    });
});

describe('removing the second-to-last member converts the group', () => {
    test.each([true, false])('keeps what the group said about Characters React (%s)', (value) => {
        makeGroup({ settings: { characters_react: value } });

        const direct = removeMember(user, GROUP_ID, 'Orion.png').conversation;

        expect(direct.settings).toEqual({ characters_react: value });
    });

    test('creates the direct conversation of the remaining character, with the chats named after the group', () => {
        makeGroup();

        const result = removeMember(user, GROUP_ID, 'Orion.png');

        expect(result.converted).toBe(true);
        expect(result.removedId).toBe(GROUP_ID);
        const direct = result.conversation;
        expect(direct).toMatchObject({ kind: 'direct', personaId: PERSONA, characters: ['Nova.png'], favorite: true, settings: { authors_note: 'Keep it light.' }, name: '' });
        expect(direct.id).not.toBe(GROUP_ID);
        expect(readConversation(user, direct.id)).toEqual(direct);
        expect(direct.chats.map(item => [item.id, item.name, item.readThrough])).toEqual([['main', 'Weekend plans', 'a3'], ['trip', 'Weekend plans - Trip', '']]);
        expect(direct.activeChatId).toBe('trip');
        expect(direct.reminders).toEqual([{ id: 'r1', avatar: 'Nova.png', chatId: 'trip', text: 'Pack', triggerAt: 10 }]);
        expect(folderNames()).toEqual([direct.id]);
        expect(codeOf(() => readConversation(user, GROUP_ID))).toBe('not_found');
    });

    test('keeps every message of every chat, with who wrote it, and the memory summary of the chat', () => {
        makeGroup();

        const { conversation: direct } = removeMember(user, GROUP_ID, 'Orion.png');

        expect(loadChat(user, direct.id, 'main')).toEqual([
            header({ sb_conversation: MAIN_MEMORY }),
            line('a1', 'Hello', { user: true, minute: 1 }),
            memberLine('a2', 'Hi!', 'Nova.png', 2),
            memberLine('a3', 'Hey', 'Orion.png', 3),
        ]);
        expect(loadChat(user, direct.id, 'trip').slice(1)).toEqual([line('b1', 'Where to?', { user: true, minute: 10 }), memberLine('b2', 'The coast', 'Orion.png', 11)]);
    });

    test('takes the slug off the copies, so that their first save assigns one, and keeps the memory header otherwise', async () => {
        makeGroup();
        const saved = await saveChat(user, GROUP_ID, 'main', [...loadChat(user, GROUP_ID, 'main'), memberLine('a4', 'More', 'Nova.png', 4)]);
        expect(saved.integrity).toBeTruthy();
        expect(loadChat(user, GROUP_ID, 'main')[0].chat_metadata.integrity).toBe(saved.integrity);

        const { conversation: direct } = removeMember(user, GROUP_ID, 'Orion.png');

        const copy = loadChat(user, direct.id, 'main');
        expect(copy).toHaveLength(5);
        expect(copy[0].chat_metadata.integrity).toBeUndefined();
        expect(copy[0].chat_metadata.sb_conversation).toEqual(MAIN_MEMORY);
        await expect(saveChat(user, direct.id, 'main', [...copy, line('a5', 'Back again', { minute: 5 })])).resolves.toMatchObject({ integrity: expect.any(String) });
    });

    test('names a chat that has no name of its own, or Main, after the group, and leaves the names alone for a group with no name', () => {
        makeGroup({ name: '' });

        const { conversation: direct } = removeMember(user, GROUP_ID, 'Orion.png');

        expect(direct.chats.map(item => item.name)).toEqual(['Main', 'Trip']);
    });

    test('adds the chats to the direct conversation that the character has, and leaves what it holds', () => {
        const existing = makeDirect({ reminders: [{ id: 'r0', chatId: 'main', text: 'Old', triggerAt: 5 }] });
        makeGroup();
        const existingChat = readText(chatFile(DIRECT_ID));

        const result = removeMember(user, GROUP_ID, 'Orion.png');

        expect(result.conversation.id).toBe(existing.id);
        const direct = readConversation(user, DIRECT_ID);
        expect(direct.chats.map(item => [item.id, item.name])).toEqual([['main', 'Main'], ['main_2', 'Weekend plans'], ['trip', 'Weekend plans - Trip']]);
        expect(direct.activeChatId).toBe('trip');
        expect(direct.reminders.map(item => [item.id, item.chatId])).toEqual([['r0', 'main'], ['r1', 'trip']]);
        expect(readText(chatFile(DIRECT_ID))).toBe(existingChat);
        expect(loadChat(user, DIRECT_ID, 'main_2').slice(1)).toHaveLength(3);
        expect(folderNames()).toEqual([DIRECT_ID]);
    });

    test('keeps the name, settings and favourite of the direct conversation that it adds to', () => {
        makeDirect({ name: 'Nova', favorite: false, settings: { authors_note: 'Mine' } });
        makeGroup();

        removeMember(user, GROUP_ID, 'Orion.png');

        expect(readConversation(user, DIRECT_ID)).toMatchObject({ name: 'Nova', favorite: false, settings: { authors_note: 'Mine' } });
    });

    test('converts to the direct conversation of the persona of the group only', () => {
        makeDirect({ id: 'conv_1700000000002_other00001', personaId: 'someone-else.png' });
        makeGroup();

        const { conversation: direct } = removeMember(user, GROUP_ID, 'Orion.png');

        expect(direct.personaId).toBe(PERSONA);
        expect(direct.id).not.toBe('conv_1700000000002_other00001');
        expect(readConversation(user, 'conv_1700000000002_other00001').chats).toHaveLength(1);
    });

    test('lands on the other character when that one is removed', () => {
        makeGroup();

        const { conversation: direct } = removeMember(user, GROUP_ID, 'Nova.png');

        expect(direct.characters).toEqual(['Orion.png']);
    });

    test('drops the index rows of the chats of the group', () => {
        makeGroup();
        listConversations(user);
        const stat = fs.statSync(chatFile(GROUP_ID, 'main'));
        const file = chatFile(GROUP_ID, 'main');
        expect(conversationIndex.get(file, stat, 'a3')).toBeDefined();

        removeMember(user, GROUP_ID, 'Orion.png');

        expect(conversationIndex.get(file, stat, 'a3')).toBeUndefined();
        expect(listConversations(user).conversations.map(item => item.id)).not.toContain(GROUP_ID);
    });

    test('a chat whose file is gone is carried as a blank chat, and a chat that cannot be read stops the conversion', () => {
        makeGroup();
        fs.rmSync(chatFile(GROUP_ID, 'trip'));

        const { conversation: direct } = removeMember(user, GROUP_ID, 'Orion.png');

        expect(loadChat(user, direct.id, 'trip')).toEqual([header()]);
    });

    test('stops, with the group as it was, at a chat that cannot be read', () => {
        makeGroup();
        fs.writeFileSync(chatFile(GROUP_ID, 'trip'), 'not json');
        const before = folderNames();

        expect(codeOf(() => removeMember(user, GROUP_ID, 'Orion.png'))).toBe('corrupt');
        expect(folderNames()).toEqual(before);
        expect(readConversation(user, GROUP_ID).characters).toEqual(['Nova.png', 'Orion.png']);
        expect(readText(chatFile(GROUP_ID, 'trip'))).toBe('not json');
    });

    describe('when a step fails', () => {
        function failOn(method, matches, code = 'EIO') {
            const original = fs[method];
            return jest.spyOn(fs, method).mockImplementation((...args) => {
                if (matches(...args)) {
                    throw Object.assign(new Error('disk exploded at /secret/path'), { code });
                }
                return original(...args);
            });
        }

        const isGroupFolder = value => String(value).endsWith(GROUP_ID);
        const snapshot = () => Object.fromEntries(fs.readdirSync(user.directories.conversations, { recursive: true })
            .map(name => [name, fs.statSync(path.join(user.directories.conversations, name)).isDirectory() ? null : readText(path.join(user.directories.conversations, name))]));

        test('the group is as it was and no direct conversation is left, when the group cannot be taken out of the list', () => {
            makeGroup();
            const before = snapshot();
            jest.spyOn(console, 'error').mockImplementation(() => {});
            failOn('renameSync', from => isGroupFolder(from));

            const error = errorOf(() => removeMember(user, GROUP_ID, 'Orion.png'));

            expect(error).toBeInstanceOf(ConversationStoreError);
            expect(error.code).toBe('conversion_failed');
            expect(error.message).not.toContain('secret');
            jest.restoreAllMocks();
            expect(snapshot()).toEqual(before);
        });

        test('the direct conversation that existed is as it was, and its new chat files are gone, when the group cannot be taken out of the list', () => {
            makeDirect();
            makeGroup();
            const before = snapshot();
            jest.spyOn(console, 'error').mockImplementation(() => {});
            failOn('renameSync', from => isGroupFolder(from));

            expect(codeOf(() => removeMember(user, GROUP_ID, 'Orion.png'))).toBe('conversion_failed');

            jest.restoreAllMocks();
            expect(snapshot()).toEqual(before);
        });

        test('the group is as it was and no direct conversation is left, when a chat of the new conversation cannot be written', () => {
            makeGroup();
            const before = snapshot();
            jest.spyOn(console, 'error').mockImplementation(() => {});
            failOn('openSync', (target, flags) => flags === 'wx' && String(target).endsWith(path.join('chats', 'trip.jsonl')), 'ENOSPC');

            expect(codeOf(() => removeMember(user, GROUP_ID, 'Orion.png'))).toBe('conversion_failed');

            jest.restoreAllMocks();
            expect(snapshot()).toEqual(before);
        });

        test('the direct conversation that existed is as it was, and the first copy is taken back, when a later copy cannot be written', () => {
            makeDirect();
            makeGroup();
            const before = snapshot();
            jest.spyOn(console, 'error').mockImplementation(() => {});
            failOn('openSync', (target, flags) => flags === 'wx' && String(target).endsWith(path.join('chats', 'trip.jsonl')), 'ENOSPC');

            expect(codeOf(() => removeMember(user, GROUP_ID, 'Orion.png'))).toBe('conversion_failed');

            jest.restoreAllMocks();
            expect(snapshot()).toEqual(before);
        });

        /** Cuts every chat file that the conversion writes to the direct conversation short, as a full disk would. */
        function truncateCopies() {
            const copies = new Set();
            const open = fs.openSync;
            const sync = fs.fsyncSync;
            jest.spyOn(fs, 'openSync').mockImplementation((...args) => {
                const descriptor = open(...args);
                if (args[1] === 'wx' && String(args[0]).endsWith('.jsonl') && !String(args[0]).includes(GROUP_ID)) {
                    copies.add(descriptor);
                }
                return descriptor;
            });
            jest.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
                if (copies.has(descriptor)) {
                    fs.ftruncateSync(descriptor, 20);
                }
                return sync(descriptor);
            });
        }

        test('the group is as it was and no direct conversation is left, when a copy does not read back as the original', () => {
            makeGroup();
            const before = snapshot();
            jest.spyOn(console, 'error').mockImplementation(() => {});
            truncateCopies();

            expect(codeOf(() => removeMember(user, GROUP_ID, 'Orion.png'))).toBe('conversion_failed');

            jest.restoreAllMocks();
            expect(snapshot()).toEqual(before);
        });

        test('the direct conversation that existed is as it was when a copy does not read back as the original', () => {
            makeDirect();
            makeGroup();
            const before = snapshot();
            jest.spyOn(console, 'error').mockImplementation(() => {});
            truncateCopies();

            expect(codeOf(() => removeMember(user, GROUP_ID, 'Orion.png'))).toBe('conversion_failed');

            jest.restoreAllMocks();
            expect(snapshot()).toEqual(before);
        });

        test('a conversion that failed can be run again and then succeeds', () => {
            makeGroup();
            jest.spyOn(console, 'error').mockImplementation(() => {});
            const spy = failOn('renameSync', from => isGroupFolder(from));
            expect(codeOf(() => removeMember(user, GROUP_ID, 'Orion.png'))).toBe('conversion_failed');
            spy.mockRestore();

            const { converted, conversation } = removeMember(user, GROUP_ID, 'Orion.png');

            expect(converted).toBe(true);
            expect(folderNames()).toEqual([conversation.id]);
        });

        test('a copy that an earlier run left in the direct conversation is replaced, not repeated, when the group is converted again', () => {
            makeGroup();
            const { conversation: direct } = removeMember(user, GROUP_ID, 'Orion.png');
            // The state of a run that was stopped before the group was taken out of the list: the copies are there and the group too.
            const stopped = makeGroupAgainFrom(direct);

            const again = removeMember(user, stopped.id, 'Orion.png').conversation;

            expect(again.id).toBe(direct.id);
            expect(again.chats.map(item => [item.id, item.legacyId])).toEqual([['main_2', `${stopped.id}/main`], ['trip_2', `${stopped.id}/trip`]]);
            expect(fs.readdirSync(path.join(folder(direct.id), 'chats')).sort()).toEqual(['main_2.jsonl', 'trip_2.jsonl']);
        });

        function makeGroupAgainFrom(direct) {
            const group = makeGroup({ id: 'conv_1700000000009_group00002' });
            const marked = readConversation(user, direct.id);
            marked.chats = marked.chats.map(item => ({ ...item, legacyId: `${group.id}/${item.id}` }));
            fs.writeFileSync(path.join(folder(direct.id), 'conversation.json'), JSON.stringify(marked));
            return group;
        }
    });
});

describe('removeExtra', () => {
    test('takes an extra off a direct conversation, and the messages of that character stay', () => {
        makeDirect({ extras: ['Orion.png', 'Pip.png'] });
        const chatBefore = readText(chatFile(DIRECT_ID));

        const { conversation } = removeExtra(user, DIRECT_ID, 'Orion.png');

        expect(conversation.extras).toEqual(['Pip.png']);
        expect(readConversation(user, DIRECT_ID).extras).toEqual(['Pip.png']);
        expect(readText(chatFile(DIRECT_ID))).toBe(chatBefore);
    });

    test.each([
        ['an avatar that is not an extra', 'Quill.png', 'not_found'],
        ['the character of the conversation', 'Nova.png', 'not_found'],
        ['a name that is a path', '../Orion.png', 'invalid_input'],
        ['a number', 5, 'invalid_input'],
        ['nothing', undefined, 'invalid_input'],
    ])('refuses %s', (_name, avatar, code) => {
        makeDirect({ extras: ['Orion.png'] });

        expect(codeOf(() => removeExtra(user, DIRECT_ID, avatar))).toBe(code);
        expect(readConversation(user, DIRECT_ID).extras).toEqual(['Orion.png']);
    });

    test('refuses a group, which has members and no extras', () => {
        makeGroup();

        expect(codeOf(() => removeExtra(user, GROUP_ID, 'Orion.png'))).toBe('invalid_input');
    });

    test('is not_found for a conversation that does not exist', () => {
        expect(codeOf(() => removeExtra(user, 'conv_9_abcdef', 'Orion.png'))).toBe('not_found');
    });
});
