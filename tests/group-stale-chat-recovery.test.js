import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { prepareEnvironment, USER_HANDLE } from './util/hostile-file-names-harness.js';

const CHAT_HEADER = JSON.stringify({ user_name: 'User', character_name: 'Group', create_date: '2026-04-10', chat_metadata: {} });
const chatLine = text => JSON.stringify({ name: 'Alice', mes: text, is_user: false, send_date: '2026-04-10' });

let environment;
let server;
let baseUrl;
let directories;
let getChatData;

beforeAll(async () => {
    environment = prepareEnvironment();
    const { getUserDirectories } = await import('../src/users.js');
    directories = getUserDirectories(USER_HANDLE);

    const chatsModule = await import('../src/endpoints/chats.js');
    const groupsModule = await import('../src/endpoints/groups.js');
    getChatData = chatsModule.getChatData;

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: USER_HANDLE, name: 'group-recovery', admin: false }, directories };
        next();
    });
    app.use('/api/chats', chatsModule.router);
    app.use('/api/groups', groupsModule.router);

    server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 120_000);

beforeEach(() => {
    fs.rmSync(directories.root, { recursive: true, force: true, maxRetries: 5 });
    for (const directory of Object.values(directories)) {
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

async function postJson(endpoint, body = {}) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        // Leave json null for non-JSON responses.
    }
    return { status: response.status, text, json };
}

function writeFile(targetPath, contents, mtimeMs = null) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contents, 'utf8');
    if (mtimeMs !== null) {
        const date = new Date(mtimeMs);
        fs.utimesSync(targetPath, date, date);
    }
}

describe('stale group chat ID recovery (1527a1d29)', () => {
    test('POST /api/groups/all drops stale chat IDs, deduplicates numeric IDs and resets stale chat_id to the latest existing .jsonl', async () => {
        const olderTime = Date.UTC(2026, 3, 1, 10, 0, 0);
        const newerTime = Date.UTC(2026, 3, 2, 12, 0, 0);
        writeFile(
            path.join(directories.groupChats, '101.jsonl'),
            [CHAT_HEADER, chatLine('Older chat')].join('\n'),
            olderTime,
        );
        writeFile(
            path.join(directories.groupChats, 'newer-chat.jsonl'),
            [CHAT_HEADER, chatLine('Newer chat')].join('\n'),
            newerTime,
        );
        writeFile(
            path.join(directories.groups, 'grp-1.json'),
            JSON.stringify({
                id: 'grp-1',
                name: 'Stale Group',
                members: ['alice.png'],
                chat_id: 'stale-missing-chat',
                chats: [101, 'stale-missing-chat', '101', 'newer-chat', 'another-missing'],
            }),
        );

        const result = await postJson('/api/groups/all');

        expect(result.status).toBe(200);
        expect(result.json).toHaveLength(1);
        expect(result.json[0].chats).toEqual(['101', 'newer-chat']);
        expect(result.json[0].chat_id).toBe('newer-chat');
        expect(result.json[0].date_last_chat).toBe(newerTime);
        expect(result.json[0].chat_size).toBeGreaterThan(0);
    });

    test('POST /api/chats/group/info responds with 404 not_found when the group chat .jsonl is missing', async () => {
        const result = await postJson('/api/chats/group/info', { id: 'missing-group-chat' });

        expect(result.status).toBe(404);
        expect(result.json).toEqual({ error: 'not_found' });
    });

    test('getChatData stays quiet for a missing chat file and warns only when an existing file is empty', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const missingPath = path.join(directories.groupChats, 'does-not-exist.jsonl');
            expect(getChatData(missingPath)).toEqual([]);
            expect(warnSpy).not.toHaveBeenCalled();

            const emptyPath = path.join(directories.groupChats, 'empty.jsonl');
            writeFile(emptyPath, '');
            expect(getChatData(emptyPath)).toEqual([]);
            expect(warnSpy).toHaveBeenCalledWith(`Chat file is empty: ${emptyPath}.`);
        } finally {
            warnSpy.mockRestore();
        }
    });
});
