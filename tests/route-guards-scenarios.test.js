import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { OUTSIDE_FILE_TEXT, prepareEnvironment, USER_HANDLE } from './util/hostile-file-names-harness.js';

// A request that the route never answers fails at this deadline instead of at the test timeout.
const REQUEST_TIMEOUT_MS = 3_000;

const ROUTERS = {
    '/api/files': () => import('../src/endpoints/files.js'),
    '/api/chats': () => import('../src/endpoints/chats.js'),
    '/api/groups': () => import('../src/endpoints/groups.js'),
};

const CHAT_HEADER = JSON.stringify({ user_name: 'user', character_name: 'seed', create_date: '2026-01-01', chat_metadata: {} });
const chatMessage = mes => JSON.stringify({ name: 'seed', mes, is_user: false, send_date: '2026-01-01' });

let environment;
let server;
let baseUrl;
let directories;
let outsideRoot;

beforeAll(async () => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
        jest.spyOn(console, method).mockImplementation(() => {});
    }
    environment = prepareEnvironment();
    const { getUserDirectories } = await import('../src/users.js');
    directories = getUserDirectories(USER_HANDLE);
    outsideRoot = path.join(environment.dataRoot, 'outside');

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((request, _response, next) => {
        request.user = { profile: { handle: USER_HANDLE, name: 'guards', admin: false }, directories };
        next();
    });
    for (const [mount, loadRouter] of Object.entries(ROUTERS)) {
        app.use(mount, (await loadRouter()).router);
    }
    server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 120_000);

beforeEach(() => {
    for (const root of [directories.root, outsideRoot]) {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
    for (const directory of [...Object.values(directories), outsideRoot]) {
        fs.mkdirSync(directory, { recursive: true });
    }
});

afterAll(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    environment?.restore();
    jest.restoreAllMocks();
});

function write(target, content) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

async function post(target, body, { form = false } = {}) {
    const response = await fetch(`${baseUrl}${target}`, {
        method: 'POST',
        headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, text: await response.text() };
}

const toRequestPath = target => path.relative(directories.root, target).replaceAll(path.sep, '/');

describe('file routes and a sibling of the files folder', () => {
    let keptFile;
    let siblingFile;

    beforeEach(() => {
        keptFile = path.join(directories.files, 'kept.txt');
        siblingFile = path.join(`${directories.files}-old`, 'sibling.txt');
        write(keptFile, 'kept');
        write(siblingFile, OUTSIDE_FILE_TEXT);
    });

    test('POST /delete refuses a file in a sibling folder whose name starts with the files folder name', async () => {
        const sibling = await post('/api/files/delete', { path: toRequestPath(siblingFile) });
        const kept = await post('/api/files/delete', { path: toRequestPath(keptFile) });

        expect(sibling.status).toBe(400);
        expect(fs.existsSync(siblingFile)).toBe(true);
        expect(kept.status).toBe(200);
        expect(fs.existsSync(keptFile)).toBe(false);
    });

    test('POST /verify leaves out a file in a sibling folder whose name starts with the files folder name', async () => {
        const result = await post('/api/files/verify', { urls: [toRequestPath(siblingFile), toRequestPath(keptFile)] });

        expect(result.status).toBe(200);
        expect(JSON.parse(result.text)).toEqual({ [toRequestPath(keptFile)]: true });
    });
});

describe('group chat IDs', () => {
    let groupFile;
    let outsideChatId;

    const writeGroup = chats => write(groupFile, JSON.stringify({ id: 'grp', name: 'grp', members: [], chat_id: 'seedchat', chats }));
    const readStoredChats = () => JSON.parse(fs.readFileSync(groupFile, 'utf8')).chats;
    const groupChatNames = text => JSON.parse(text).filter(chat => chat.group === 'grp').map(chat => chat.file_name);

    beforeEach(() => {
        groupFile = path.join(directories.groups, 'grp.json');
        writeGroup(['seedchat']);
        write(path.join(directories.groupChats, 'seedchat.jsonl'), `${CHAT_HEADER}\n${chatMessage('seed message')}`);
        write(path.join(outsideRoot, 'outside-chat.jsonl'), `${CHAT_HEADER}\n${chatMessage(OUTSIDE_FILE_TEXT)}`);
        outsideChatId = path.relative(directories.groupChats, path.join(outsideRoot, 'outside-chat')).replaceAll(path.sep, '/');
    });

    test('POST /api/groups/edit stores chat IDs inside the group chats folder and refuses an ID whose path leaves it', async () => {
        const insideChats = ['seedchat', 'Before/After', 1700000000000];
        const inside = await post('/api/groups/edit', { id: 'grp', name: 'grp', members: [], chat_id: 'seedchat', chats: insideChats });
        const leaving = await post('/api/groups/edit', { id: 'grp', name: 'grp', members: [], chat_id: 'seedchat', chats: ['seedchat', outsideChatId] });

        expect(inside.status).toBe(200);
        expect(leaving.status).toBe(400);
        expect(readStoredChats()).toEqual(insideChats);
    });

    test.each([
        ['an object', { toString: 1 }],
        ['null', null],
    ])('POST /api/groups/edit refuses a chat ID that is %s', async (_label, chatId) => {
        const result = await post('/api/groups/edit', { id: 'grp', name: 'grp', members: [], chat_id: 'seedchat', chats: ['seedchat', chatId] });

        expect(result.status).toBe(400);
        expect(readStoredChats()).toEqual(['seedchat']);
    });

    test('POST /api/groups/create refuses a chat list with an ID whose path leaves the group chats folder', async () => {
        const result = await post('/api/groups/create', { name: 'created', members: [], chat_id: 'created', chats: [outsideChatId] });

        expect(result.status).toBe(400);
        expect(fs.readdirSync(directories.groups)).toEqual(['grp.json']);
        expect(fs.readdirSync(directories.groupChats)).toEqual(['seedchat.jsonl']);
    });

    test('POST /api/chats/search leaves out a stored chat ID whose path leaves the group chats folder', async () => {
        writeGroup(['seedchat', outsideChatId]);

        const result = await post('/api/chats/search', { group_id: 'grp' });

        expect(result.status).toBe(200);
        expect(JSON.parse(result.text).map(chat => chat.file_name)).toEqual(['seedchat']);
        expect(result.text).not.toContain(OUTSIDE_FILE_TEXT);
    });

    test('POST /api/chats/search skips a stored chat ID that is not a string or a number', async () => {
        writeGroup([{ toString: 1 }, 'seedchat']);

        const result = await post('/api/chats/search', { group_id: 'grp' });

        expect(result.status).toBe(200);
        expect(JSON.parse(result.text).map(chat => chat.file_name)).toEqual(['seedchat']);
    });

    test('POST /api/chats/recent leaves out a stored chat ID whose path leaves the group chats folder', async () => {
        writeGroup(['seedchat', outsideChatId]);

        const result = await post('/api/chats/recent', { max: 50 });

        expect(result.status).toBe(200);
        expect(groupChatNames(result.text)).toEqual(['seedchat.jsonl']);
        expect(result.text).not.toContain(OUTSIDE_FILE_TEXT);
    });

    test('POST /api/chats/recent keeps the other chats of a group whose list holds a chat ID that is not a string or a number', async () => {
        writeGroup([{ toString: 1 }, 'seedchat']);

        const result = await post('/api/chats/recent', { max: 50 });

        expect(result.status).toBe(200);
        expect(groupChatNames(result.text)).toEqual(['seedchat.jsonl']);
    });
});
