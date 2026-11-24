import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { chat, createSandboxUser, header, IMAGES, line, listBackups, PERSONA } from './util/conversation-store-sandbox.js';

const { router } = await import('../src/endpoints/sillybunny-conversation.js');
const { createChat, createConversation, loadChat, saveChat } = await import('../src/conversation-store.js');
const { getBackupKey } = await import('../src/endpoints/chats.js');
const { getConversationBackupName } = await import('../src/conversation-paths.js');

const PREFIX = '/api/sillybunny-conversation';

let server;
let baseUrl;
let sandbox;
let user;

beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    // Each request gets its own handle: the regular chat backup is throttled per handle and chat, and a second save
    // inside the window would leave a timer that fires after the test.
    let requests = 0;
    app.use((request, _response, next) => {
        request.user = { ...user, profile: { handle: `${user.profile.handle}-request-${++requests}` } };
        next();
    });
    app.use(PREFIX, router);
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
    sandbox = createSandboxUser();
    user = sandbox.user;
});

afterEach(() => {
    sandbox.cleanup();
});

async function post(route, body) {
    const response = await fetch(`${baseUrl}${PREFIX}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        // The body is not JSON; the test reads `text`.
    }
    return { status: response.status, json, text, headers: response.headers };
}

function makeGroup(overrides = {}) {
    return createConversation(user, {
        kind: 'group',
        personaId: PERSONA,
        characters: ['Nova.png', 'Orion.png'],
        ...overrides,
    }).conversation;
}

/** Every file and folder under the user's root, for a check that a refused request wrote nothing. */
function snapshotTree() {
    const entries = [];
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            entries.push(`${path.relative(sandbox.root, entryPath)}${entry.isDirectory() ? '/' : `:${fs.statSync(entryPath).size}`}`);
            if (entry.isDirectory()) {
                walk(entryPath);
            }
        }
    };
    walk(sandbox.root);
    return entries.sort();
}

describe('POST /list', () => {
    test('lists the conversations with their counts, and what could not be read', async () => {
        const conversation = makeGroup({ id: 'conv_1_aaaaaa', chats: [{ id: 'main', records: [header(), line('a', 'hello', { minute: 1 })] }] });
        fs.mkdirSync(path.join(user.directories.conversations, 'conv_2_bbbbbb'));

        const { status, json } = await post('/list', {});

        expect(status).toBe(200);
        expect(json.conversations.map(item => item.id)).toEqual([conversation.id]);
        expect(json.conversations[0]).toMatchObject({ messageCount: 1, preview: 'hello', unread: 1 });
        expect(json.problems).toEqual([{ id: 'conv_2_bbbbbb', error: 'not_found' }]);
    });
});

describe('POST /create, /get, /update and /delete', () => {
    test('create answers with the conversation, a second create for a direct conversation with the same one', async () => {
        const body = { kind: 'direct', personaId: PERSONA, characters: ['Nova.png'], name: 'Nova', description: 'Friend' };

        const first = await post('/create', body);
        const second = await post('/create', body);

        expect(first.status).toBe(200);
        expect(first.json).toMatchObject({ created: true, conversation: { kind: 'direct', name: 'Nova', description: 'Friend', characters: ['Nova.png'] } });
        expect(second.status).toBe(200);
        expect(second.json).toMatchObject({ created: false, conversation: { id: first.json.conversation.id } });
    });

    test('create does not take the fields that are for the migration', async () => {
        const { status, json } = await post('/create', { kind: 'direct', personaId: PERSONA, characters: ['Nova.png'], id: 'conv_1_abcd' });

        expect(status).toBe(400);
        expect(json.error).toBe('invalid_input');
        expect(fs.readdirSync(user.directories.conversations)).toEqual([]);
    });

    test('get reads a conversation and update changes it', async () => {
        const conversation = makeGroup();

        const read = await post('/get', { id: conversation.id });
        const updated = await post('/update', { id: conversation.id, patch: { name: 'Weekend', favorite: true, settings: { proactive_messaging: true } } });

        expect(read.json.conversation).toEqual(conversation);
        expect(updated.status).toBe(200);
        expect(updated.json.conversation).toMatchObject({ name: 'Weekend', favorite: true, settings: { proactive_messaging: true } });
        expect((await post('/get', { id: conversation.id })).json.conversation).toEqual(updated.json.conversation);
    });

    test('delete removes the conversation, and a second delete is 404', async () => {
        const conversation = makeGroup();

        expect(await post('/delete', { id: conversation.id })).toMatchObject({ status: 200, json: { ok: true } });
        expect(fs.existsSync(path.join(user.directories.conversations, conversation.id))).toBe(false);
        expect(await post('/delete', { id: conversation.id })).toMatchObject({ status: 404, json: { error: 'not_found' } });
        expect(await post('/get', { id: conversation.id })).toMatchObject({ status: 404, json: { error: 'not_found' } });
    });

    test('a conversation file that cannot be read is 422', async () => {
        const conversation = makeGroup();
        fs.writeFileSync(path.join(user.directories.conversations, conversation.id, 'conversation.json'), '{ nope');

        expect(await post('/get', { id: conversation.id })).toMatchObject({ status: 422, json: { error: 'corrupt' } });
    });

    test('update answers 400 with the reason for a patch that is not valid', async () => {
        const conversation = makeGroup();

        const { status, json } = await post('/update', { id: conversation.id, patch: { settings: { authors_note: { a: 1 } } } });

        expect(status).toBe(400);
        expect(json.error).toBe('invalid_input');
        expect(json.message).toMatch(/settings\.authors_note/);
    });
});

describe('the avatar of a group', () => {
    test('upload stores the picture, GET serves it with its own type, and remove clears it', async () => {
        const conversation = makeGroup();

        const upload = await post('/avatar/upload', { id: conversation.id, image: IMAGES.png.toString('base64') });
        expect(upload).toMatchObject({ status: 200, json: { conversation: { avatar: 'avatar.png' } } });

        const served = await fetch(`${baseUrl}${PREFIX}/avatar?id=${conversation.id}`);
        expect(served.status).toBe(200);
        expect(served.headers.get('content-type')).toBe('image/png');
        expect(served.headers.get('x-content-type-options')).toBe('nosniff');
        expect(served.headers.get('content-disposition')).toBeNull();
        expect(Buffer.from(await served.arrayBuffer())).toEqual(IMAGES.png);

        expect(await post('/avatar/remove', { id: conversation.id })).toMatchObject({ status: 200, json: { conversation: { avatar: '' } } });
        expect((await fetch(`${baseUrl}${PREFIX}/avatar?id=${conversation.id}`)).status).toBe(404);
    });

    test('upload takes a data URL as well as plain base64', async () => {
        const conversation = makeGroup();

        const { status, json } = await post('/avatar/upload', { id: conversation.id, image: `data:image/jpeg;base64,${IMAGES.jpeg.toString('base64')}` });

        expect(status).toBe(200);
        expect(json.conversation.avatar).toBe('avatar.jpg');
    });

    test.each([
        ['text', Buffer.from('not an image at all, just words').toString('base64')],
        ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')],
        ['an image over 5 MiB', Buffer.concat([IMAGES.png, Buffer.alloc(5 * 1024 * 1024)]).toString('base64')],
        ['an empty string', ''],
        ['a number', 5],
        ['an object', { data: 'x' }],
    ])('upload refuses %s with 400', async (_name, image) => {
        const conversation = makeGroup();

        const { status, json } = await post('/avatar/upload', { id: conversation.id, image });

        expect(status).toBe(400);
        expect(json.error).toBe('invalid_input');
        expect(fs.readdirSync(path.join(user.directories.conversations, conversation.id)).sort()).toEqual(['chats', 'conversation.json']);
    });

    test.each([
        ['no id', ''],
        ['an id that is a path', '?id=../../etc/passwd'],
        ['an id given twice', '?id=conv_1_abcd&id=conv_2_abcd'],
        ['an id that is an object', '?id[a]=b'],
    ])('GET refuses %s', async (_name, query) => {
        const response = await fetch(`${baseUrl}${PREFIX}/avatar${query}`);
        expect(response.status).toBe(400);
    });

    test('GET is 404 for a conversation without a picture and for one that does not exist', async () => {
        const conversation = makeGroup();

        expect((await fetch(`${baseUrl}${PREFIX}/avatar?id=${conversation.id}`)).status).toBe(404);
        expect((await fetch(`${baseUrl}${PREFIX}/avatar?id=conv_9_abcdef`)).status).toBe(404);
    });
});

describe('the chats of a conversation', () => {
    let conversation;

    beforeEach(() => {
        conversation = makeGroup({ id: 'conv_1_abcdef', chats: [{ id: 'main', name: 'Main' }] });
    });

    test('create adds a blank chat and can open it', async () => {
        const { status, json } = await post('/chat/create', { id: conversation.id, name: 'Trip', activate: true });

        expect(status).toBe(200);
        expect(json.chat).toMatchObject({ name: 'Trip' });
        expect(json.conversation.activeChatId).toBe(json.chat.id);
        expect(json.conversation.chats.map(item => item.id)).toEqual(['main', json.chat.id]);
        expect((await post('/chat/get', { id: conversation.id, chatId: json.chat.id })).json.chat).toEqual([header()]);
    });

    test('create does not take an id or records from the client', async () => {
        const { status } = await post('/chat/create', { id: conversation.id, chatId: 'mine', records: [header(), line('a', 'x')] });

        expect(status).toBe(400);
        expect(loadChat(user, conversation.id, 'main')).toEqual([header()]);
    });

    test('get returns the records of a chat', async () => {
        const records = [header(), line('a', 'hello')];
        createChat(user, conversation.id, { id: 'second', records });

        const { status, json } = await post('/chat/get', { id: conversation.id, chatId: 'second' });

        expect(status).toBe(200);
        expect(json).toEqual({ chat: records });
    });

    test('save writes the chat, and the next save needs the slug that this one returned', async () => {
        const first = await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(3) });
        expect(first.status).toBe(200);
        expect(first.json).toMatchObject({ ok: true });
        expect(first.json.integrity).toMatch(/^[0-9a-f-]{36}$/);

        const second = await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(4, { integrity: first.json.integrity }) });
        expect(second.status).toBe(200);
        expect(second.json.integrity).not.toBe(first.json.integrity);
        expect(loadChat(user, conversation.id, 'main')).toHaveLength(5);
    });

    test('save answers 409 integrity for a stale slug and leaves the chat as it is', async () => {
        const first = await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(3) });
        await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(4, { integrity: first.json.integrity }) });
        const before = loadChat(user, conversation.id, 'main');

        const stale = await post('/chat/save', { id: conversation.id, chatId: 'main', chat: [...chat(3, { integrity: first.json.integrity }), line('late', 'from a stale tab', { minute: 40 })] });

        expect(stale.status).toBe(409);
        expect(stale.json).toEqual({ error: 'integrity' });
        expect(loadChat(user, conversation.id, 'main')).toEqual(before);
    });

    test('save answers 409 destructive for a save that drops most of the chat, and allows it with allowShrink', async () => {
        const first = await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(12) });

        const refused = await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(3, { integrity: first.json.integrity }) });
        expect(refused.status).toBe(409);
        expect(refused.json.error).toBe('destructive');
        expect(typeof refused.json.reason).toBe('string');
        expect(loadChat(user, conversation.id, 'main')).toHaveLength(13);

        const allowed = await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(3, { integrity: first.json.integrity }), allowShrink: true });
        expect(allowed.status).toBe(200);
        expect(loadChat(user, conversation.id, 'main')).toHaveLength(4);
    });

    test('save writes a backup and a recovery copy', async () => {
        const key = getBackupKey(getConversationBackupName(conversation.id, 'main'));

        await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(3) });

        expect(listBackups(user, `chat_pre_write_${key}_`)).toHaveLength(1);
        expect(listBackups(user, `chat_${key}_`)).toHaveLength(1);
        expect(fs.readdirSync(path.join(user.directories.backups, '_chat_recovery')).some(name => name.endsWith('.latest.jsonl'))).toBe(true);
    });

    test('save takes allowShrink, deferBackup and deferSequenceId only as the right types', async () => {
        const { status } = await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(3), allowShrink: 'yes', deferBackup: 1, deferSequenceId: { a: 1 } });

        expect(status).toBe(200);
    });

    test.each([
        ['chat is not an array', { chat: 'text' }],
        ['chat is an empty array', { chat: [] }],
        ['chat has no header', { chat: [line('a', 'x')] }],
        ['chat has a row that is not an object', { chat: [header(), 'x'] }],
        ['chat is missing', {}],
    ])('save answers 400 when %s', async (_name, extra) => {
        const { status, json } = await post('/chat/save', { id: conversation.id, chatId: 'main', ...extra });

        expect(status).toBe(400);
        expect(json.error).toBe('invalid_input');
        expect(loadChat(user, conversation.id, 'main')).toEqual([header()]);
    });

    test('rename changes the name of the chat only', async () => {
        const { status, json } = await post('/chat/rename', { id: conversation.id, chatId: 'main', name: 'Renamed' });

        expect(status).toBe(200);
        expect(json.conversation.chats[0]).toMatchObject({ id: 'main', name: 'Renamed' });
        expect(json.conversation.name).toBe(conversation.name);
        expect((await post('/chat/rename', { id: conversation.id, chatId: 'main', name: 5 })).status).toBe(400);
        expect((await post('/chat/rename', { id: conversation.id, chatId: 'ghost', name: 'x' })).status).toBe(404);
    });

    test('delete removes a chat, and leaves one empty chat when it was the last', async () => {
        const second = (await post('/chat/create', { id: conversation.id })).json.chat.id;

        const afterFirst = await post('/chat/delete', { id: conversation.id, chatId: 'main' });
        expect(afterFirst.json.conversation.chats.map(item => item.id)).toEqual([second]);

        const afterLast = await post('/chat/delete', { id: conversation.id, chatId: second });
        expect(afterLast.status).toBe(200);
        expect(afterLast.json.conversation.chats).toHaveLength(1);
        expect(afterLast.json.conversation.chats[0].id).not.toBe(second);
        expect((await post('/chat/get', { id: conversation.id, chatId: second })).status).toBe(404);
    });

    test('export sends the chat file as a download', async () => {
        await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(2) });

        const response = await fetch(`${baseUrl}${PREFIX}/chat/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: conversation.id, chatId: 'main' }),
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^application\/x-ndjson/);
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="Main.jsonl"');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await response.text()).toBe(fs.readFileSync(path.join(user.directories.conversations, conversation.id, 'chats', 'main.jsonl'), 'utf8'));
    });

    test('a chat file that cannot be read is 422, and a chat that is not listed is 404', async () => {
        fs.writeFileSync(path.join(user.directories.conversations, conversation.id, 'chats', 'main.jsonl'), 'not json');

        expect(await post('/chat/get', { id: conversation.id, chatId: 'main' })).toMatchObject({ status: 422, json: { error: 'corrupt' } });
        expect(await post('/chat/get', { id: conversation.id, chatId: 'ghost' })).toMatchObject({ status: 404, json: { error: 'not_found' } });
        expect(await post('/chat/export', { id: conversation.id, chatId: 'ghost' })).toMatchObject({ status: 404, json: { error: 'not_found' } });
    });

    test('a listed chat that has no file is saved again from the client\'s copy', async () => {
        fs.rmSync(path.join(user.directories.conversations, conversation.id, 'chats', 'main.jsonl'));

        const { status } = await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(2) });

        expect(status).toBe(200);
        expect(loadChat(user, conversation.id, 'main')).toHaveLength(3);
    });
});

describe('the state of characters', () => {
    test('update stores a routine and a status override, and get reads them', async () => {
        const routine = { enabled: true, text: 'Weekdays: work', generatedAt: 1700000000000 };

        const update = await post('/characters/update', { avatar: 'Nova.png', patch: { routine, statusOverride: 'dnd' } });
        const read = await post('/characters/get', {});

        expect(update).toMatchObject({ status: 200, json: { avatar: 'Nova.png', state: { routine, statusOverride: 'dnd' } } });
        expect(read.json).toEqual({ version: 1, characters: { 'Nova.png': { routine, statusOverride: 'dnd' } } });
    });

    test.each([
        ['an avatar that is a path', { avatar: '../Nova.png', patch: { statusOverride: 'dnd' } }],
        ['a status that does not exist', { avatar: 'Nova.png', patch: { statusOverride: 'asleep' } }],
        ['a patch that is a string', { avatar: 'Nova.png', patch: 'dnd' }],
        ['no patch', { avatar: 'Nova.png' }],
    ])('update refuses %s with 400', async (_name, body) => {
        const { status, json } = await post('/characters/update', body);

        expect(status).toBe(400);
        expect(json.error).toBe('invalid_input');
        expect((await post('/characters/get', {})).json.characters).toEqual({});
    });
});

describe('the migration routes', () => {
    test('the status says that nothing has been migrated', async () => {
        expect(await post('/migration/status', {})).toMatchObject({ status: 200, json: { state: 'not_migrated' } });
    });

    test('the legacy import is not there yet', async () => {
        const before = snapshotTree();

        expect(await post('/import-legacy', { store: {} })).toMatchObject({ status: 501, json: { error: 'not_implemented' } });
        expect(snapshotTree()).toEqual(before);
    });
});

describe('what the routes refuse', () => {
    let conversation;

    beforeEach(() => {
        conversation = makeGroup({ id: 'conv_1_abcdef' });
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
    ];

    test.each(HOSTILE_IDS.flatMap(([name, id]) => [
        [`/get with ${name}`, '/get', { id }],
        [`/update with ${name}`, '/update', { id, patch: { name: 'x' } }],
        [`/delete with ${name}`, '/delete', { id }],
        [`/avatar/upload with ${name}`, '/avatar/upload', { id, image: IMAGES.png.toString('base64') }],
        [`/avatar/remove with ${name}`, '/avatar/remove', { id }],
        [`/chat/create with ${name}`, '/chat/create', { id }],
        [`/chat/get with ${name}`, '/chat/get', { id, chatId: 'main' }],
        [`/chat/save with ${name}`, '/chat/save', { id, chatId: 'main', chat: chat(2) }],
        [`/chat/rename with ${name}`, '/chat/rename', { id, chatId: 'main', name: 'x' }],
        [`/chat/delete with ${name}`, '/chat/delete', { id, chatId: 'main' }],
        [`/chat/export with ${name}`, '/chat/export', { id, chatId: 'main' }],
    ]))('%s answers 400 and writes nothing', async (_title, route, body) => {
        const before = snapshotTree();

        const { status, json } = await post(route, body);

        expect(status).toBe(400);
        expect(json.error).toBe('invalid_id');
        expect(snapshotTree()).toEqual(before);
    });

    test.each(HOSTILE_IDS.flatMap(([name, chatId]) => [
        [`/chat/get with the chat id ${name}`, '/chat/get', { chatId }],
        [`/chat/save with the chat id ${name}`, '/chat/save', { chatId, chat: chat(2) }],
        [`/chat/rename with the chat id ${name}`, '/chat/rename', { chatId, name: 'x' }],
        [`/chat/delete with the chat id ${name}`, '/chat/delete', { chatId }],
        [`/chat/export with the chat id ${name}`, '/chat/export', { chatId }],
    ]))('%s answers 400 or 404 and writes nothing', async (_title, route, extra) => {
        const before = snapshotTree();

        const { status } = await post(route, { id: 'conv_1_abcdef', ...extra });

        expect([400, 404]).toContain(status);
        expect(snapshotTree()).toEqual(before);
    });

    test('every route refuses a body that is an array', async () => {
        const routes = ['/get', '/create', '/update', '/delete', '/avatar/upload', '/avatar/remove', '/chat/create', '/chat/get', '/chat/save', '/chat/rename', '/chat/delete', '/chat/export', '/characters/update'];
        const before = snapshotTree();

        for (const route of routes) {
            const { status, json } = await post(route, []);
            expect({ route, status }).toEqual({ route, status: 400 });
            expect(json.error).toMatch(/^invalid_/);
        }
        expect(snapshotTree()).toEqual(before);
    });

    test('a body that is not JSON never reaches a route', async () => {
        const { status } = await post('/get', '{ not json');

        expect(status).toBe(400);
    });

    test('a route with no body at all answers 400, not 500', async () => {
        const response = await fetch(`${baseUrl}${PREFIX}/get`, { method: 'POST' });

        expect(response.status).toBe(400);
    });

    test('a conversation of another user is not there', async () => {
        const other = createSandboxUser('other-user');
        const foreign = createConversation(other.user, { kind: 'direct', personaId: PERSONA, characters: ['Nova.png'] }).conversation;

        expect(await post('/get', { id: foreign.id })).toMatchObject({ status: 404, json: { error: 'not_found' } });
        expect(await post('/delete', { id: foreign.id })).toMatchObject({ status: 404 });
        expect(fs.existsSync(path.join(other.user.directories.conversations, foreign.id))).toBe(true);
        other.cleanup();
    });

    test('a conversation folder that is a link out of the conversations folder is not followed', async () => {
        const outside = path.join(sandbox.root, 'outside');
        fs.mkdirSync(path.join(outside, 'chats'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'conversation.json'), JSON.stringify({ id: 'conv_7_linked', kind: 'direct', chats: [{ id: 'main' }] }));
        fs.writeFileSync(path.join(outside, 'chats', 'main.jsonl'), JSON.stringify(header()));
        fs.symlinkSync(outside, path.join(user.directories.conversations, 'conv_7_linked'), 'dir');

        for (const [route, body] of [['/get', { id: 'conv_7_linked' }], ['/delete', { id: 'conv_7_linked' }], ['/chat/get', { id: 'conv_7_linked', chatId: 'main' }]]) {
            const { status } = await post(route, body);
            expect(status).toBe(400);
        }
        expect(fs.existsSync(path.join(outside, 'conversation.json'))).toBe(true);
    });

    test('a failure inside the store that is not a store error answers 500 with no detail', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const rmSync = jest.spyOn(fs, 'rmSync').mockImplementation(() => {
            throw new Error('disk exploded at /secret/path');
        });
        try {
            const { status, json, text } = await post('/delete', { id: conversation.id });

            expect(status).toBe(500);
            expect(json).toEqual({ error: 'internal' });
            expect(text).not.toContain('secret');
        } finally {
            rmSync.mockRestore();
            jest.restoreAllMocks();
        }
    });
});

describe('the server mounts the routes under one prefix only', () => {
    test('src/server-startup.js mounts the router at /api/sillybunny-conversation and not at the old alias', () => {
        const source = fs.readFileSync(fileURLToPath(new URL('../src/server-startup.js', import.meta.url)), 'utf8');

        expect(source).toContain('app.use(\'/api/sillybunny-conversation\', sillyBunnyConversationRouter)');
        expect(source).not.toContain('/api/sillybunny/conversation');
    });
});

describe('a save that goes through the store and one that goes through the route', () => {
    test('see each other: a slug from the store is accepted by the route', async () => {
        const conversation = makeGroup({ id: 'conv_1_abcdef' });
        const { integrity } = await saveChat(user, conversation.id, 'main', chat(2));

        const { status } = await post('/chat/save', { id: conversation.id, chatId: 'main', chat: chat(3, { integrity }) });

        expect(status).toBe(200);
    });
});
