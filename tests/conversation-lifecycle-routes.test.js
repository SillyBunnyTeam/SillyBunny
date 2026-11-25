import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { startConversationRouter, snapshotTree } from './util/conversation-route-harness.js';
import { addCharacters, chat, createSandboxUser, header, IMAGES, line, listBackups, PERSONA } from './util/conversation-store-sandbox.js';

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

const HOSTILE_IDS = [
    ['a path', '../../etc/passwd'],
    ['dot segments', '..'],
    ['a path inside the folder', 'conv_1_abcdef/../conv_1_abcdef'],
    ['the character file', 'characters.json'],
    ['a backslash path', '..\\..\\x'],
    ['a NUL byte', 'conv_1_abcdef\u0000'],
    ['an encoded path', '%2e%2e%2f%2e%2e%2fetc'],
    ['an empty string', ''],
    ['a number', 5],
    ['null', null],
    ['an array', ['conv_1_abcdef']],
    ['an object', { toString: 'conv_1_abcdef', valueOf: 'x' }],
    ['a boolean', true],
    ['a Windows device name', 'nul'],
];

const HOSTILE_AVATARS = [
    ['a path', '../../etc/passwd.png'],
    ['a separator', 'sub/Nova.png'],
    ['a backslash path', '..\\Nova.png'],
    ['dot segments', '..'],
    ['a NUL byte', 'Nova.png\u0000'],
    ['a prototype key', '__proto__'],
    ['constructor', 'constructor'],
    ['an empty string', ''],
    ['a long name', `${'a'.repeat(300)}.png`],
    ['a number', 5],
    ['null', null],
    ['a list', ['Nova.png']],
    ['an object', { toString: 'Nova.png' }],
];

describe('the member routes', () => {
    const GROUP = 'conv_1_abcdef';
    const DIRECT = 'conv_2_abcdef';

    beforeEach(() => {
        addCharacters(user, ['Nova.png', 'Orion.png', 'Pip.png', 'Quill.png']);
    });

    function makeGroup(overrides = {}) {
        return createConversation(user, {
            id: GROUP,
            kind: 'group',
            personaId: PERSONA,
            characters: ['Nova.png', 'Orion.png'],
            name: 'Weekend plans',
            chats: [{ id: 'main', name: 'Main', records: [header(), line('a1', 'Hello', { user: true }), line('a2', 'Hi', { minute: 1 })] }],
            ...overrides,
        }).conversation;
    }

    describe('POST /members/add', () => {
        test('adds characters to a group', async () => {
            makeGroup();

            const { status, json } = await post('/members/add', { id: GROUP, characters: ['Pip.png'] });

            expect(status).toBe(200);
            expect(json).toMatchObject({ created: false, conversation: { id: GROUP, characters: ['Nova.png', 'Orion.png', 'Pip.png'] } });
        });

        test('starts a new group from a direct conversation, and leaves the direct conversation', async () => {
            const direct = makeDirect({ id: DIRECT });
            const before = fs.readFileSync(path.join(user.directories.conversations, DIRECT, 'conversation.json'), 'utf8');

            const { status, json } = await post('/members/add', { id: DIRECT, characters: ['Orion.png'] });

            expect(status).toBe(200);
            expect(json).toMatchObject({ created: true, conversation: { kind: 'group', characters: ['Nova.png', 'Orion.png'], personaId: PERSONA } });
            expect(json.conversation.id).not.toBe(direct.id);
            expect(fs.readFileSync(path.join(user.directories.conversations, DIRECT, 'conversation.json'), 'utf8')).toBe(before);
            expect((await post('/get', { id: json.conversation.id })).json.conversation).toEqual(json.conversation);
        });

        test.each([
            ['no characters', { characters: [] }],
            ['characters that are not a list', { characters: 'Pip.png' }],
            ['a character that is a member already', { characters: ['Nova.png'] }],
            ['a character that does not exist', { characters: ['Ghost.png'] }],
            ['a field that is not for this route', { characters: ['Pip.png'], kind: 'direct' }],
            ['more characters than a group can hold', { characters: Array.from({ length: 5000 }, (_, index) => `C${index}.png`) }],
        ])('refuses %s with 400 and writes nothing', async (_name, extra) => {
            makeGroup();
            const before = tree();

            const { status, json } = await post('/members/add', { id: GROUP, ...extra });

            expect(status).toBe(400);
            expect(json.error).toBe('invalid_input');
            expect(tree()).toEqual(before);
        });

        test.each(HOSTILE_AVATARS)('refuses a character that is %s with 400 and writes nothing', async (_name, avatar) => {
            makeGroup();
            const before = tree();

            const { status, json } = await post('/members/add', { id: GROUP, characters: [avatar] });

            expect(status).toBe(400);
            expect(json.error).toBe('invalid_input');
            expect(tree()).toEqual(before);
        });

        test('is 404 for a conversation that does not exist', async () => {
            expect(await post('/members/add', { id: 'conv_9_abcdef', characters: ['Pip.png'] })).toMatchObject({ status: 404, json: { error: 'not_found' } });
        });
    });

    describe('POST /members/remove', () => {
        test('takes a member out of a group that keeps two, and the messages stay', async () => {
            makeGroup({ characters: ['Nova.png', 'Orion.png', 'Pip.png'] });
            const chatBefore = fs.readFileSync(path.join(user.directories.conversations, GROUP, 'chats', 'main.jsonl'), 'utf8');

            const { status, json } = await post('/members/remove', { id: GROUP, avatar: 'Orion.png' });

            expect(status).toBe(200);
            expect(json).toEqual({ converted: false, conversation: expect.objectContaining({ id: GROUP, characters: ['Nova.png', 'Pip.png'] }) });
            expect(fs.readFileSync(path.join(user.directories.conversations, GROUP, 'chats', 'main.jsonl'), 'utf8')).toBe(chatBefore);
        });

        test('converts the group when the second-to-last member goes, and names the conversation to open', async () => {
            makeGroup();

            const { status, json } = await post('/members/remove', { id: GROUP, avatar: 'Orion.png' });

            expect(status).toBe(200);
            expect(json).toMatchObject({ converted: true, removedId: GROUP, conversation: { kind: 'direct', characters: ['Nova.png'] } });
            expect(json.conversation.chats.map(item => item.name)).toEqual(['Weekend plans']);
            expect(await post('/get', { id: GROUP })).toMatchObject({ status: 404 });
            expect((await post('/chat/get', { id: json.conversation.id, chatId: 'main' })).json.chat.slice(1)).toEqual([line('a1', 'Hello', { user: true }), line('a2', 'Hi', { minute: 1 })]);
            const listed = (await post('/list', {})).json.conversations;
            expect(listed.map(item => item.id)).toEqual([json.conversation.id]);
            expect(fs.readdirSync(user.directories.conversations)).toEqual([json.conversation.id]);
        });

        test('answers 500 conversion_failed with no detail, and leaves the group as it was, when the conversion fails', async () => {
            makeGroup();
            const before = snapshotTree(user.directories.conversations);
            jest.spyOn(console, 'error').mockImplementation(() => {});
            const rename = fs.renameSync;
            jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
                if (String(from).endsWith(GROUP)) {
                    throw new Error('disk exploded at /secret/path');
                }
                return rename(from, to);
            });

            const { status, json, text } = await post('/members/remove', { id: GROUP, avatar: 'Orion.png' });

            jest.restoreAllMocks();
            expect(status).toBe(500);
            expect(json).toEqual({ error: 'conversion_failed' });
            expect(text).not.toContain('secret');
            expect(snapshotTree(user.directories.conversations)).toEqual(before);
        });

        test.each([
            ['a character that is not a member', { avatar: 'Quill.png' }, 404, 'not_found'],
            ['no avatar', {}, 400, 'invalid_input'],
            ['a field that is not for this route', { avatar: 'Orion.png', force: true }, 400, 'invalid_input'],
        ])('refuses %s', async (_name, extra, status, code) => {
            makeGroup({ characters: ['Nova.png', 'Orion.png', 'Pip.png'] });
            const before = tree();

            const answer = await post('/members/remove', { id: GROUP, ...extra });

            expect(answer.status).toBe(status);
            expect(answer.json.error).toBe(code);
            expect(tree()).toEqual(before);
        });

        test.each(HOSTILE_AVATARS)('refuses an avatar that is %s with 400 and writes nothing', async (_name, avatar) => {
            makeGroup({ characters: ['Nova.png', 'Orion.png', 'Pip.png'] });
            const before = tree();

            const { status, json } = await post('/members/remove', { id: GROUP, avatar });

            expect(status).toBe(400);
            expect(json.error).toBe('invalid_input');
            expect(tree()).toEqual(before);
        });

        test('refuses a direct conversation', async () => {
            makeDirect({ id: DIRECT });

            expect(await post('/members/remove', { id: DIRECT, avatar: 'Nova.png' })).toMatchObject({ status: 400, json: { error: 'invalid_input' } });
        });
    });

    describe('POST /extras/remove', () => {
        test('takes an extra off a direct conversation', async () => {
            makeDirect({ id: DIRECT, extras: ['Orion.png', 'Pip.png'] });

            const { status, json } = await post('/extras/remove', { id: DIRECT, avatar: 'Orion.png' });

            expect(status).toBe(200);
            expect(json.conversation).toMatchObject({ id: DIRECT, extras: ['Pip.png'] });
        });

        test.each([
            ['an avatar that is not an extra', { avatar: 'Quill.png' }, 404, 'not_found'],
            ['no avatar', {}, 400, 'invalid_input'],
            ['a field that is not for this route', { avatar: 'Orion.png', all: true }, 400, 'invalid_input'],
        ])('refuses %s', async (_name, extra, status, code) => {
            makeDirect({ id: DIRECT, extras: ['Orion.png'] });

            const answer = await post('/extras/remove', { id: DIRECT, ...extra });

            expect(answer.status).toBe(status);
            expect(answer.json.error).toBe(code);
        });

        test.each(HOSTILE_AVATARS)('refuses an avatar that is %s with 400', async (_name, avatar) => {
            makeDirect({ id: DIRECT, extras: ['Orion.png'] });
            const before = tree();

            const { status, json } = await post('/extras/remove', { id: DIRECT, avatar });

            expect(status).toBe(400);
            expect(json.error).toBe('invalid_input');
            expect(tree()).toEqual(before);
        });

        test('refuses a group', async () => {
            makeGroup();

            expect(await post('/extras/remove', { id: GROUP, avatar: 'Orion.png' })).toMatchObject({ status: 400, json: { error: 'invalid_input' } });
        });
    });

    describe('what the member routes refuse', () => {
        test.each(HOSTILE_IDS.flatMap(([name, id]) => [
            [`/members/add with ${name}`, '/members/add', { id, characters: ['Pip.png'] }],
            [`/members/remove with ${name}`, '/members/remove', { id, avatar: 'Orion.png' }],
            [`/extras/remove with ${name}`, '/extras/remove', { id, avatar: 'Orion.png' }],
        ]))('%s answers 400 and writes nothing', async (_title, route, body) => {
            makeGroup({ id: 'conv_1_abcdef' });
            const before = tree();

            const { status, json } = await post(route, body);

            expect(status).toBe(400);
            expect(json.error).toBe('invalid_id');
            expect(tree()).toEqual(before);
        });

        test.each(['/members/add', '/members/remove', '/extras/remove'])('%s refuses a body that is an array, and a body that is not JSON', async (route) => {
            const before = tree();

            expect((await post(route, [])).status).toBe(400);
            expect((await post(route, '{ not json')).status).toBe(400);
            expect(tree()).toEqual(before);
        });
    });
});

describe('editing a group', () => {
    const GROUP = 'conv_1_abcdef';

    beforeEach(() => {
        createConversation(user, { id: GROUP, kind: 'group', personaId: PERSONA, characters: ['Nova.png', 'Orion.png'], name: 'Old name', description: 'Old description' });
    });

    test('changes the name and description through /update, and the next read has them', async () => {
        const { status, json } = await post('/update', { id: GROUP, patch: { name: '  Weekend plans  ', description: 'Who is coming, and when.' } });

        expect(status).toBe(200);
        expect(json.conversation).toMatchObject({ name: 'Weekend plans', description: 'Who is coming, and when.' });
        expect((await post('/get', { id: GROUP })).json.conversation).toMatchObject({ name: 'Weekend plans', description: 'Who is coming, and when.' });
        expect((await post('/list', {})).json.conversations[0]).toMatchObject({ name: 'Weekend plans' });
    });

    test('clears the name and description with empty text', async () => {
        const { json } = await post('/update', { id: GROUP, patch: { name: '', description: '' } });

        expect(json.conversation).toMatchObject({ name: '', description: '' });
    });

    test.each([
        ['a name over 200 characters', { name: 'x'.repeat(201) }],
        ['a name that is a number', { name: 5 }],
        ['a description over 8000 characters', { description: 'x'.repeat(8001) }],
        ['a description with a NUL byte', { description: 'a\u0000b'.replace('\\u0000', '\u0000') }],
        ['a member list that is too short', { characters: ['Nova.png'] }],
    ])('refuses %s with 400 and changes nothing', async (_name, patch) => {
        const before = fs.readFileSync(path.join(user.directories.conversations, GROUP, 'conversation.json'), 'utf8');

        const { status, json } = await post('/update', { id: GROUP, patch });

        expect(status).toBe(400);
        expect(json.error).toBe('invalid_input');
        expect(fs.readFileSync(path.join(user.directories.conversations, GROUP, 'conversation.json'), 'utf8')).toBe(before);
    });

    test('uploads a picture and takes it off, and the group keeps its name through both', async () => {
        const uploaded = await post('/avatar/upload', { id: GROUP, image: IMAGES.png.toString('base64') });
        const removed = await post('/avatar/remove', { id: GROUP });

        expect(uploaded.json.conversation).toMatchObject({ avatar: 'avatar.png', name: 'Old name' });
        expect(removed.json.conversation).toMatchObject({ avatar: '', name: 'Old name' });
        expect(fs.readdirSync(path.join(user.directories.conversations, GROUP)).sort()).toEqual(['chats', 'conversation.json']);
    });
});
