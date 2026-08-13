import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const {
    ArchiveInventoryService,
    ArchiveReadTokenService,
    MAX_ARCHIVE_PAGE_SIZE,
    readArchiveChatMetadata,
    router: archiveRouter,
} = await import('../src/endpoints/chat-archive.js');
const { DataMaidService, router: dataMaidRouter } = await import('../src/endpoints/data-maid.js');

const jsonl = (label, messages = 2) => [
    JSON.stringify({ chat_metadata: { label }, user_name: 'User', character_name: 'Character' }),
    ...Array.from({ length: messages }, (_, index) => JSON.stringify({
        name: index % 2 ? 'Character' : 'User',
        is_user: index % 2 === 0,
        mes: `${label} message ${index}`,
        send_date: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    })),
].join('\n');

function createAbortingMetadataReader(controller, abortAt) {
    let reads = 0;
    return async () => {
        reads++;
        if (reads === abortAt) {
            controller.abort();
        }
        return { file_size: '1 B', chat_items: 0, last_mes: 0, mes: '' };
    };
}

describe('Chat Archive endpoint', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            if (request.get('x-test-no-user') === 'true') {
                return next();
            }
            request.user = {
                profile: { handle: request.get('x-test-user') || 'alice' },
                directories,
            };
            next();
        });
        app.use('/api/chats/archive', archiveRouter);
        app.use('/api/data-maid', dataMaidRouter);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-chat-archive-endpoint-'));
        directories = {
            root: tempRoot,
            avatars: path.join(tempRoot, 'avatars'),
            backups: path.join(tempRoot, 'backups'),
            backgrounds: path.join(tempRoot, 'backgrounds'),
            characters: path.join(tempRoot, 'characters'),
            chats: path.join(tempRoot, 'chats'),
            files: path.join(tempRoot, 'files'),
            groupChats: path.join(tempRoot, 'group-chats'),
            groups: path.join(tempRoot, 'groups'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails-avatar'),
            thumbnailsBg: path.join(tempRoot, 'thumbnails-bg'),
            thumbnailsBgMobile: path.join(tempRoot, 'thumbnails-bg-mobile'),
            thumbnailsPersona: path.join(tempRoot, 'thumbnails-persona'),
            userImages: path.join(tempRoot, 'user-images'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        ArchiveInventoryService.INVENTORIES.clear();
        ArchiveReadTokenService.TOKENS.clear();
        DataMaidService.TOKENS.clear();
        createArchiveFixtures();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        ArchiveInventoryService.INVENTORIES.clear();
        ArchiveReadTokenService.TOKENS.clear();
        DataMaidService.TOKENS.clear();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('paginates complete linked character, group, and root metadata without mutating chats', async () => {
        const chatPaths = [
            path.join(directories.chats, 'Alice', 'a-first.jsonl'),
            path.join(directories.chats, 'Alice', 'a-second.jsonl'),
            path.join(directories.chats, 'root-chat.jsonl'),
            path.join(directories.groupChats, 'group-chat.jsonl'),
        ];
        const before = new Map(chatPaths.map(filePath => [filePath, {
            contents: fs.readFileSync(filePath),
            mtimeMs: fs.statSync(filePath).mtimeMs,
        }]));

        const pages = await collectInventory('archive', 2);
        const rows = pages.flatMap(page => page.rows);

        expect(pages).toHaveLength(2);
        expect(pages.every(page => page.rows.length <= 2)).toBe(true);
        expect(rows.map(row => [row.avatar, row.group, row.orphan_type, row.file_name])).toEqual([
            ['Alice.png', undefined, undefined, 'a-first.jsonl'],
            ['Alice.png', undefined, undefined, 'a-second.jsonl'],
            [undefined, undefined, 'root', 'root-chat.jsonl'],
            [undefined, 'group-one', undefined, 'group-chat.jsonl'],
        ]);
        expect(rows.map(row => row.chat_items)).toEqual([2, 3, 1, 2]);
        expect(rows.map(row => row.chat_metadata.label)).toEqual(['alice-first', 'alice-second', 'root', 'group-linked']);
        expect(rows.map(row => row.mes)).toEqual([
            'alice-first message 1',
            'alice-second message 2',
            'root message 0',
            'group-linked message 1',
        ]);
        expect(pages.at(-1).cursor).toBeNull();
        expect(pages.every(page => page.read_token === null)).toBe(true);
        for (const [filePath, snapshot] of before) {
            expect(fs.readFileSync(filePath).equals(snapshot.contents)).toBe(true);
            expect(fs.statSync(filePath).mtimeMs).toBe(snapshot.mtimeMs);
        }
    });

    test('reads only streamed line metadata and tolerates an unparsed middle record', async () => {
        const filePath = path.join(directories.chats, 'streamed.jsonl');
        fs.writeFileSync(filePath, [
            JSON.stringify({ chat_metadata: { complete: true } }),
            '{ this intermediary record is intentionally not parsed',
            JSON.stringify({ mes: 'last preview', send_date: '2026-02-03T04:05:06.000Z' }),
        ].join('\n'));
        const readFileSpy = jest.spyOn(fs.promises, 'readFile');

        const metadata = await readArchiveChatMetadata(filePath);

        expect(metadata).toMatchObject({
            chat_items: 2,
            chat_metadata: { complete: true },
            last_mes: '2026-02-03T04:05:06.000Z',
            mes: 'last preview',
        });
        expect(readFileSpy).not.toHaveBeenCalled();
    });

    test('returns deterministic bounded pages for twenty thousand descriptors', async () => {
        const cursor = 'a'.repeat(64);
        const descriptors = Array.from({ length: 20_000 }, (_, index) => ({
            avatar: 'Scale.png',
            chatFolder: 'Scale',
            fileName: `chat-${String(index).padStart(5, '0')}.jsonl`,
            filePath: `/virtual/chat-${String(index).padStart(5, '0')}.jsonl`,
            orphanType: null,
        }));
        ArchiveInventoryService.INVENTORIES.set(cursor, {
            handle: 'scale-user',
            scope: 'archive',
            descriptors,
            offset: 0,
            readToken: null,
            busy: false,
            expiresAt: Date.now() + 60_000,
        });
        const metadataReader = async filePath => ({
            file_size: '1 KB',
            chat_items: Number(path.basename(filePath).match(/\d+/)[0]),
            last_mes: 1,
            mes: '',
        });
        const rows = [];
        const pageSizes = [];
        let nextCursor = cursor;

        while (nextCursor) {
            const page = await ArchiveInventoryService.page(
                nextCursor,
                'scale-user',
                MAX_ARCHIVE_PAGE_SIZE,
                undefined,
                undefined,
                metadataReader,
            );
            expect(page.status).toBe('ok');
            rows.push(...page.rows);
            pageSizes.push(page.rows.length);
            nextCursor = page.cursor;
        }

        expect(pageSizes).toHaveLength(40);
        expect(new Set(pageSizes)).toEqual(new Set([MAX_ARCHIVE_PAGE_SIZE]));
        expect(rows).toHaveLength(20_000);
        expect(rows[0].file_name).toBe('chat-00000.jsonl');
        expect(rows.at(-1).file_name).toBe('chat-19999.jsonl');
        expect(rows.map(row => row.file_name)).toEqual([...rows.map(row => row.file_name)].sort());
        expect(ArchiveInventoryService.INVENTORIES.has(cursor)).toBe(false);
    });

    test('aborted pages do not advance their cursor offset', async () => {
        const cursor = 'b'.repeat(64);
        const descriptors = Array.from({ length: 20 }, (_, index) => ({
            avatar: 'Abort.png',
            chatFolder: 'Abort',
            fileName: `${String(index).padStart(2, '0')}.jsonl`,
            filePath: `/virtual/${index}.jsonl`,
            orphanType: null,
        }));
        const inventory = {
            handle: 'abort-user',
            scope: 'archive',
            descriptors,
            offset: 0,
            readToken: null,
            busy: false,
            expiresAt: Date.now() + 60_000,
        };
        ArchiveInventoryService.INVENTORIES.set(cursor, inventory);
        const controller = new AbortController();
        const abortingReader = createAbortingMetadataReader(controller, 5);

        await expect(ArchiveInventoryService.page(
            cursor,
            'abort-user',
            10,
            controller.signal,
            undefined,
            abortingReader,
        )).rejects.toMatchObject({ name: 'AbortError' });
        expect(inventory.offset).toBe(0);
        expect(inventory.busy).toBe(false);

        const retried = await ArchiveInventoryService.page(
            cursor,
            'abort-user',
            10,
            undefined,
            undefined,
            async () => ({ file_size: '1 B', chat_items: 0, last_mes: 0, mes: '' }),
        );
        expect(retried.rows.map(row => row.file_name)).toEqual(descriptors.slice(0, 10).map(row => row.fileName));
        expect(inventory.offset).toBe(10);
    });

    test('validates pagination boundaries, cursor ownership, scope, and read paths', async () => {
        expect((await fetch(`${baseUrl}/api/chats/archive/inventory`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-test-no-user': 'true' },
            body: JSON.stringify({ scope: 'archive', page_size: 1 }),
        })).status).toBe(403);
        expect((await fetch(`${baseUrl}/api/chats/archive/view?token=${'a'.repeat(64)}&hash=${'b'.repeat(64)}`, {
            headers: { 'x-test-no-user': 'true' },
        })).status).toBe(403);
        for (const pageSize of [0, MAX_ARCHIVE_PAGE_SIZE + 1, '2']) {
            expect((await postJson('/api/chats/archive/inventory', { scope: 'archive', page_size: pageSize })).status).toBe(400);
        }
        expect((await postJson('/api/chats/archive/inventory', { scope: 'invalid', page_size: 1 })).status).toBe(400);
        expect((await postJson('/api/chats/archive/inventory', { cursor: '../escape', page_size: 1 })).status).toBe(400);

        const first = await postJson('/api/chats/archive/inventory', { scope: 'archive', page_size: 1 });
        const firstPage = await first.json();
        expect(first.status).toBe(200);
        expect(firstPage.cursor).toMatch(/^[a-f0-9]{64}$/);
        expect((await postJson('/api/chats/archive/inventory', {
            cursor: firstPage.cursor,
            scope: 'archive',
            page_size: 1,
        }, 'bob')).status).toBe(403);
        expect((await postJson('/api/chats/archive/inventory', {
            cursor: firstPage.cursor,
            scope: 'orphans',
            page_size: 1,
        })).status).toBe(400);
        expect((await postJson('/api/chats/archive/release', { cursor: firstPage.cursor }, 'bob')).status).toBe(403);
        expect(ArchiveInventoryService.INVENTORIES.has(firstPage.cursor)).toBe(true);
        expect((await postJson('/api/chats/archive/release', { cursor: firstPage.cursor })).status).toBe(204);
        expect(ArchiveInventoryService.INVENTORIES.has(firstPage.cursor)).toBe(false);

        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-chat-archive-outside-'));
        try {
            const outsidePath = path.join(outsideRoot, 'outside.jsonl');
            fs.writeFileSync(outsidePath, jsonl('outside', 1));
            const descriptor = { filePath: outsidePath };
            const token = ArchiveReadTokenService.create('alice', directories.root, [descriptor]);
            expect((await get(`/api/chats/archive/view?token=${token}&hash=${descriptor.hash}`)).status).toBe(403);

            const linkedPath = path.join(directories.chats, 'outside-link.jsonl');
            fs.symlinkSync(outsidePath, linkedPath);
            const linkedDescriptor = { filePath: linkedPath };
            const linkedToken = ArchiveReadTokenService.create('alice', directories.root, [linkedDescriptor]);
            expect((await get(`/api/chats/archive/view?token=${linkedToken}&hash=${linkedDescriptor.hash}`)).status).toBe(403);
        } finally {
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    test('keeps archive read sessions independent from overlapping Data Maid sessions and authorization', async () => {
        const firstArchivePages = await collectInventory('orphans', 1);
        expect(new Set(firstArchivePages.map(page => page.read_token))).toHaveProperty('size', 1);
        const firstArchive = firstArchivePages.at(-1);
        const firstToken = firstArchive.read_token;
        const firstRow = firstArchive.rows[0];
        expect(firstToken).toMatch(/^[a-f0-9]{64}$/);

        const dataMaidResponse = await postJson('/api/data-maid/report', {});
        const dataMaid = await dataMaidResponse.json();
        expect(dataMaidResponse.status).toBe(200);
        expect(dataMaid.token).toMatch(/^[a-f0-9]{64}$/);
        expect(dataMaid.token).not.toBe(firstToken);
        expect((await postJson('/api/chats/archive/release', { token: dataMaid.token })).status).toBe(403);
        expect(DataMaidService.TOKENS.has(dataMaid.token)).toBe(true);
        expect((await get(`/api/chats/archive/view?token=${firstToken}&hash=${firstRow.archive_hash}`)).status).toBe(200);

        const secondArchive = (await collectInventory('orphans', 500)).at(-1);
        const secondToken = secondArchive.read_token;
        expect(secondToken).not.toBe(firstToken);
        expect((await get(`/api/chats/archive/view?token=${firstToken}&hash=${firstRow.archive_hash}`)).status).toBe(200);
        expect((await postJson('/api/data-maid/delete', { token: firstToken, hashes: ['not-authorized'] })).status).toBe(403);
        expect((await postJson('/api/data-maid/finalize', { token: secondToken })).status).toBe(403);
        expect((await get(`/api/chats/archive/view?token=${dataMaid.token}&hash=${firstRow.archive_hash}`)).status).toBe(403);
        expect((await get(`/api/chats/archive/view?token=${firstToken}&hash=${'f'.repeat(64)}`)).status).toBe(404);
        expect((await get(`/api/chats/archive/view?token=${firstToken}&hash=../escape`)).status).toBe(400);
        expect((await get(`/api/chats/archive/view?token=${firstToken}&hash=${firstRow.archive_hash}`, 'bob')).status).toBe(403);

        expect((await postJson('/api/chats/archive/release', { token: firstToken })).status).toBe(204);
        expect((await get(`/api/chats/archive/view?token=${firstToken}&hash=${firstRow.archive_hash}`)).status).toBe(403);
        const secondRow = secondArchive.rows[0];
        expect((await get(`/api/chats/archive/view?token=${secondToken}&hash=${secondRow.archive_hash}`)).status).toBe(200);
        expect((await postJson('/api/data-maid/finalize', { token: dataMaid.token })).status).toBe(204);
        expect(fs.existsSync(path.join(directories.chats, 'Deleted', 'missing-chat.jsonl'))).toBe(true);
    });

    function createArchiveFixtures() {
        fs.writeFileSync(path.join(directories.characters, 'Alice.png'), 'card');
        fs.mkdirSync(path.join(directories.chats, 'Alice'));
        fs.mkdirSync(path.join(directories.chats, 'Deleted'));
        fs.writeFileSync(path.join(directories.chats, 'Alice', 'a-first.jsonl'), jsonl('alice-first', 2));
        fs.writeFileSync(path.join(directories.chats, 'Alice', 'a-second.jsonl'), jsonl('alice-second', 3));
        fs.writeFileSync(path.join(directories.chats, 'Deleted', 'missing-chat.jsonl'), jsonl('missing-character', 2));
        fs.writeFileSync(path.join(directories.chats, 'root-chat.jsonl'), jsonl('root', 1));
        fs.writeFileSync(path.join(directories.groups, 'group-one.json'), JSON.stringify({
            id: 'group-one',
            name: 'Group One',
            chat_id: 'group-chat',
            chats: ['group-chat'],
        }));
        fs.writeFileSync(path.join(directories.groupChats, 'group-chat.jsonl'), jsonl('group-linked', 2));
        fs.writeFileSync(path.join(directories.groupChats, 'unlinked-group.jsonl'), jsonl('group-unlinked', 1));
    }

    async function collectInventory(scope, pageSize) {
        const pages = [];
        let cursor;
        do {
            const response = await postJson('/api/chats/archive/inventory', {
                scope,
                page_size: pageSize,
                ...(cursor ? { cursor } : {}),
            });
            expect(response.status).toBe(200);
            const page = await response.json();
            pages.push(page);
            cursor = page.cursor;
        } while (cursor);
        return pages;
    }

    function postJson(url, body, user = 'alice') {
        return fetch(`${baseUrl}${url}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-test-user': user,
            },
            body: JSON.stringify(body),
        });
    }

    function get(url, user = 'alice') {
        return fetch(`${baseUrl}${url}`, { headers: { 'x-test-user': user } });
    }
});
