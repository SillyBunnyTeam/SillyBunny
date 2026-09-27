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
    ArchiveMetadataCache,
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
        ArchiveInventoryService.CREATION_LOCKS.clear();
        ArchiveMetadataCache.ENTRIES.clear();
        ArchiveReadTokenService.TOKENS.clear();
        DataMaidService.TOKENS.clear();
        createArchiveFixtures();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        ArchiveInventoryService.INVENTORIES.clear();
        ArchiveInventoryService.CREATION_LOCKS.clear();
        ArchiveMetadataCache.ENTRIES.clear();
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
        expect(pages.every(page => page.total === 4)).toBe(true);
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

    test('bounds cached last-message previews', async () => {
        const filePath = path.join(directories.chats, 'large-preview.jsonl');
        const preview = 'x'.repeat(4096);
        fs.writeFileSync(filePath, [
            JSON.stringify({ chat_metadata: { complete: true } }),
            JSON.stringify({ mes: preview, send_date: '2026-02-04T04:05:06.000Z' }),
        ].join('\n'));

        const metadata = await readArchiveChatMetadata(filePath);

        expect(metadata.mes).toHaveLength(512);
    });

    test('serializes concurrent inventory creation before enforcing per-user limits', async () => {
        for (let index = 0; index < 8; index++) {
            await ArchiveInventoryService.create('alice', directories, 'archive');
        }

        await Promise.all([
            ArchiveInventoryService.create('alice', directories, 'archive'),
            ArchiveInventoryService.create('alice', directories, 'archive'),
        ]);

        expect([...ArchiveInventoryService.INVENTORIES.values()]
            .filter(entry => entry.handle === 'alice')).toHaveLength(8);
    });

    test('rejects an opened file handle that does not match the validated in-root path', async () => {
        const inRootPath = path.join(directories.chats, 'root-chat.jsonl');
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-chat-archive-race-'));
        const outsidePath = path.join(outsideRoot, 'outside.jsonl');
        fs.writeFileSync(outsidePath, jsonl('outside replacement', 4));
        const originalOpen = fs.promises.open.bind(fs.promises);
        jest.spyOn(fs.promises, 'open').mockImplementation((filePath, flags, mode) => (
            path.resolve(filePath) === path.resolve(inRootPath)
                ? originalOpen(outsidePath, flags, mode)
                : originalOpen(filePath, flags, mode)
        ));

        try {
            await expect(readArchiveChatMetadata(inRootPath, undefined, directories.root)).rejects.toMatchObject({
                code: 'ARCHIVE_PATH_FORBIDDEN',
            });
        } finally {
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    test('rejects an opened identity mismatch when procfs descriptor paths are unavailable', async () => {
        const inRootPath = path.join(directories.chats, 'root-chat.jsonl');
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-chat-archive-fallback-'));
        const outsidePath = path.join(outsideRoot, 'outside.jsonl');
        fs.writeFileSync(outsidePath, jsonl('fallback replacement', 3));
        const originalOpen = fs.promises.open.bind(fs.promises);
        const originalRealpath = fs.promises.realpath.bind(fs.promises);
        jest.spyOn(fs.promises, 'open').mockImplementation((filePath, flags, mode) => (
            path.resolve(filePath) === path.resolve(inRootPath)
                ? originalOpen(outsidePath, flags, mode)
                : originalOpen(filePath, flags, mode)
        ));
        jest.spyOn(fs.promises, 'realpath').mockImplementation(filePath => {
            if (path.resolve(filePath) === path.resolve('/proc/self/fd')) {
                return Promise.reject(Object.assign(new Error('procfs unavailable'), { code: 'ENOENT' }));
            }
            return originalRealpath(filePath);
        });

        try {
            await expect(readArchiveChatMetadata(inRootPath, undefined, directories.root)).rejects.toMatchObject({
                code: 'ARCHIVE_PATH_FORBIDDEN',
            });
        } finally {
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    test('rejects symlinks that resolve outside the canonical archive root', async () => {
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-chat-archive-symlink-'));
        const outsidePath = path.join(outsideRoot, 'outside.jsonl');
        const linkedPath = path.join(directories.chats, 'outside-link.jsonl');
        fs.writeFileSync(outsidePath, jsonl('outside symlink', 1));
        fs.symlinkSync(outsidePath, linkedPath);

        try {
            await expect(readArchiveChatMetadata(linkedPath, undefined, directories.root)).rejects.toMatchObject({
                code: 'ARCHIVE_PATH_FORBIDDEN',
            });
        } finally {
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    test('reuses unchanged metadata on refresh and rereads files whose metadata changed', async () => {
        const probe = await fs.promises.open(path.join(directories.chats, 'root-chat.jsonl'), 'r');
        const fileHandlePrototype = Object.getPrototypeOf(probe);
        await probe.close();
        const readSpy = jest.spyOn(fileHandlePrototype, 'read');

        const firstRows = (await collectInventory('archive', MAX_ARCHIVE_PAGE_SIZE)).flatMap(page => page.rows);
        const readsAfterFirstRefresh = readSpy.mock.calls.length;
        const secondRows = (await collectInventory('archive', MAX_ARCHIVE_PAGE_SIZE)).flatMap(page => page.rows);

        expect(readsAfterFirstRefresh).toBeGreaterThan(0);
        expect(readSpy).toHaveBeenCalledTimes(readsAfterFirstRefresh);
        expect(secondRows).toEqual(firstRows);

        const rootChatPath = path.join(directories.chats, 'root-chat.jsonl');
        fs.writeFileSync(rootChatPath, jsonl('root changed', 4));
        const changedTime = new Date(Date.now() + 2_000);
        fs.utimesSync(rootChatPath, changedTime, changedTime);

        const changedRows = (await collectInventory('archive', MAX_ARCHIVE_PAGE_SIZE)).flatMap(page => page.rows);
        const changedRoot = changedRows.find(row => row.file_name === 'root-chat.jsonl');
        expect(readSpy.mock.calls.length).toBeGreaterThan(readsAfterFirstRefresh);
        expect(changedRoot).toMatchObject({
            chat_items: 4,
            chat_metadata: { label: 'root changed' },
            mes: 'root changed message 3',
        });
    });

    test('rereads metadata when a path is replaced with the same size and mtime', async () => {
        const filePath = path.join(directories.chats, 'cached-replacement.jsonl');
        const replacementPath = path.join(directories.chats, 'cached-replacement.next.jsonl');
        const originalContents = jsonl('original', 2);
        const replacementContents = jsonl('replaced', 2);
        const fixedTime = new Date('2026-03-04T05:06:07.000Z');
        expect(Buffer.byteLength(replacementContents)).toBe(Buffer.byteLength(originalContents));
        fs.writeFileSync(filePath, originalContents);
        fs.utimesSync(filePath, fixedTime, fixedTime);

        const originalStats = fs.statSync(filePath, { bigint: true });
        const originalMetadata = await readArchiveChatMetadata(filePath);

        fs.writeFileSync(replacementPath, replacementContents);
        fs.utimesSync(replacementPath, fixedTime, fixedTime);
        fs.renameSync(replacementPath, filePath);
        const replacementStats = fs.statSync(filePath, { bigint: true });
        expect(replacementStats.size).toBe(originalStats.size);
        expect(replacementStats.mtimeMs).toBe(originalStats.mtimeMs);
        expect(replacementStats.dev).toBe(originalStats.dev);
        expect(replacementStats.ino).not.toBe(originalStats.ino);

        const replacementMetadata = await readArchiveChatMetadata(filePath);

        expect(originalMetadata).toMatchObject({
            chat_metadata: { label: 'original' },
            mes: 'original message 1',
        });
        expect(replacementMetadata).toMatchObject({
            chat_metadata: { label: 'replaced' },
            mes: 'replaced message 1',
        });
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

    test('limits metadata reads to eight concurrent files', async () => {
        const cursor = 'c'.repeat(64);
        const descriptors = Array.from({ length: 24 }, (_, index) => ({
            avatar: 'Concurrency.png',
            chatFolder: 'Concurrency',
            fileName: `${String(index).padStart(2, '0')}.jsonl`,
            filePath: `/virtual/${index}.jsonl`,
            orphanType: null,
        }));
        ArchiveInventoryService.INVENTORIES.set(cursor, {
            handle: 'concurrency-user',
            scope: 'archive',
            descriptors,
            offset: 0,
            readToken: null,
            root: directories.root,
            busy: false,
            expiresAt: Date.now() + 60_000,
        });
        let active = 0;
        let maxActive = 0;
        const metadataReader = async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setImmediate(resolve));
            active--;
            return { file_size: '1 B', chat_items: 0, last_mes: 0, mes: '' };
        };

        const page = await ArchiveInventoryService.page(
            cursor,
            'concurrency-user',
            MAX_ARCHIVE_PAGE_SIZE,
            undefined,
            undefined,
            metadataReader,
        );

        expect(page.rows).toHaveLength(descriptors.length);
        expect(page.total).toBe(descriptors.length);
        expect(maxActive).toBe(8);
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
