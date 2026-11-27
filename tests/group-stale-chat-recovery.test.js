import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { prepareEnvironment, USER_HANDLE } from './util/hostile-file-names-harness.js';
import { loadDeclarations, readClientModule } from './util/load-declarations.js';

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

    test('validateGroup normalizes numeric IDs, prunes 404 stale chats, retains unknown chats and switches stale chat_id to a present chat', async () => {
        const { ast } = readClientModule('scripts/group-chats.js');
        const hasGroupChatExists = ast.body.some(node => (node.declaration ?? node).id?.name === 'groupChatExists');

        const statusByChatId = new Map([
            ['101', { ok: true, status: 200 }],
            ['stale-active', { ok: false, status: 404 }],
            ['stale-old', { ok: false, status: 404 }],
            ['transient-error', { ok: false, status: 500 }],
        ]);
        const fetchMock = jest.fn(async (_url, options) => {
            const { id } = JSON.parse(options.body);
            return statusByChatId.get(String(id)) ?? { ok: false, status: 404 };
        });
        const editGroup = jest.fn(async () => {});

        const context = vm.createContext({
            Promise,
            Array,
            String,
            JSON,
            console: { warn: jest.fn(), error: jest.fn() },
            characters: [{ name: 'Alice', avatar: 'alice.png' }],
            toastr: { warning: jest.fn(), error: jest.fn() },
            t: (strings, ...values) => strings.reduce((acc, part, idx) => acc + part + (values[idx] ?? ''), ''),
            onlyUnique: (value, index, array) => array.indexOf(value) === index,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            refreshCsrfToken: jest.fn(),
            fetch: fetchMock,
            fetchWithCsrfRetry: (url, buildInit) => fetchMock(url, buildInit()),
            humanizedDateTime: () => '2026-04-10@12h00m00s',
            editGroup,
        });
        loadDeclarations(
            context,
            'scripts/group-chats.js',
            hasGroupChatExists ? ['groupChatExists', 'validateGroup'] : ['validateGroup'],
        );

        const staleGroup = {
            id: 'grp-stale',
            members: ['alice.png'],
            chat_id: 'stale-active',
            chats: [101, '101', 'stale-old', 'stale-active', 'transient-error'],
        };

        await context.validateGroup(staleGroup);

        expect(staleGroup.chats).not.toContain('stale-old');
        expect(staleGroup.chats).toContain('101');
        expect(staleGroup.chats).toContain('transient-error');
        expect(staleGroup.chat_id).toBe('101');
        expect(editGroup).toHaveBeenCalledWith('grp-stale', true, false);

        // Numeric active chat_id is also normalized to a string.
        editGroup.mockClear();
        const numericGroup = {
            id: 'grp-num',
            members: ['alice.png'],
            chat_id: 101,
            chats: [101],
        };
        await context.validateGroup(numericGroup);
        expect(numericGroup.chat_id).toBe('101');
        expect(numericGroup.chats).toEqual(['101']);
        expect(editGroup).toHaveBeenCalledWith('grp-num', true, false);
    });

    test('fetchGroupChatFiles drops 404 stale group chats while keeping present and non-404 entries', async () => {
        const fetchMock = jest.fn(async (_url, options) => {
            const { id } = JSON.parse(options.body);
            if (id === 'stale-404') {
                return { ok: false, status: 404 };
            }
            if (id === 'error-500') {
                return { ok: false, status: 500 };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ file_name: `${id}.jsonl`, last_mes: '2026-04-10' }),
            };
        });

        const context = vm.createContext({
            Promise,
            Array,
            JSON,
            console: { error: jest.fn() },
            getAuthorizedRequestHeadersOrNull: async () => ({ 'Content-Type': 'application/json' }),
            getRequestHeadersFromContext: () => ({ 'Content-Type': 'application/json' }),
            refreshCsrfToken: jest.fn(),
            fetch: fetchMock,
            fetchWithCsrfRetry: (url, buildInit) => fetchMock(url, buildInit()),
            normalizeChatInfo: info => ({
                fileName: String(info?.file_name ?? '').replace(/\.jsonl$/, ''),
                sortTimestamp: info?.last_mes ? 100 : 0,
            }),
        });
        loadDeclarations(context, 'scripts/sillybunny-tabs.js', ['sortChatFiles', 'fetchGroupChatFiles']);

        const files = await context.fetchGroupChatFiles({
            context: {},
            group: { chats: ['present-chat', 'stale-404', 'error-500'] },
        });

        expect(files.map(file => file.fileName)).toEqual(['present-chat', 'error-500']);
    });
});
