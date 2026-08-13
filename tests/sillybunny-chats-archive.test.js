/* eslint-disable playwright/no-conditional-in-test */
/* global globalThis */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
    ARCHIVE_PAGE_SIZE,
    createTimedSignal,
    exportChat,
    fetchArchiveFile,
    fetchArchiveInventory,
    fetchOrganization,
    iterateArchiveInventoryPages,
    ORGANIZATION_FILE_NAME,
    releaseArchiveSession,
    saveOrganization,
    searchScope,
} from '../public/scripts/extensions/sillybunny-chats-archive/src/api.js';
import {
    buildSearchScopes,
    createDefaultOrganization,
    deepResultToRecentRow,
    filterRows,
    findMatchingMessageIndex,
    findMatchingSnippet,
    findMatchingSnippetInJsonl,
    findMatchingSnippetInJsonlAsync,
    formatBytes,
    groupRows,
    normalizeRow,
    normalizeOrganization,
    normalizeSavedView,
    matchesQueryFragments,
    ownerFilterKey,
    parseChatJsonl,
    parseHumanSize,
    parseJsonl,
    parseLastMes,
    parseOwnerFilter,
    parseOrganization,
    physicalChatKey,
    recordsToText,
    shapeChatRecords,
    sortRows,
} from '../public/scripts/extensions/sillybunny-chats-archive/src/core.js';
import { navigateAndConfirm } from '../public/scripts/extensions/sillybunny-chats-archive/src/ui.js';

jest.unstable_mockModule('../src/endpoints/chats.js', () => ({ CHAT_BACKUPS_PREFIX: 'chat_' }));
jest.unstable_mockModule('../src/endpoints/settings.js', () => ({ getSettingsBackupFilePrefix: () => 'settings_' }));
jest.unstable_mockModule('../src/util.js', () => ({
    isPathUnderParent: () => true,
    recoverFileWriteSync: () => {},
    tryParse: value => JSON.parse(value),
}));

const { DataMaidService } = await import('../src/endpoints/data-maid.js');

const extensionRoot = new URL('../public/scripts/extensions/sillybunny-chats-archive/', import.meta.url);
const [entry, ui, manifestText, extensionsEndpoint] = await Promise.all([
    readFile(new URL('index.js', extensionRoot), 'utf8'),
    readFile(new URL('src/ui.js', extensionRoot), 'utf8'),
    readFile(new URL('manifest.json', extensionRoot), 'utf8'),
    readFile(new URL('../src/endpoints/extensions.js', import.meta.url), 'utf8'),
]);
const manifest = JSON.parse(manifestText);
const entryModule = await import('../public/scripts/extensions/sillybunny-chats-archive/index.js');
const originalFetch = globalThis.fetch;
const originalAbortSignalAny = Object.getOwnPropertyDescriptor(AbortSignal, 'any');

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAbortSignalAny) {
        Object.defineProperty(AbortSignal, 'any', originalAbortSignalAny);
    } else {
        delete AbortSignal.any;
    }
    jest.useRealTimers();
});

describe('SillyBunny Chats Archive API', () => {
    test('loads every bounded archive page through one inventory endpoint', async () => {
        const cursor = 'a'.repeat(64);
        const requests = [];
        const progress = jest.fn();
        const pages = [
            { rows: [{ file_name: 'one.jsonl' }], cursor, read_token: null, errors: 1, total: 3 },
            { rows: [{ file_name: 'two.jsonl' }, { file_name: 'three.jsonl' }], cursor: null, read_token: null, errors: 0, total: 3 },
        ];
        globalThis.fetch = async (url, options) => {
            requests.push({ url, options });
            return { ok: true, status: 200, json: async () => pages.shift() };
        };

        const result = await fetchArchiveInventory(
            { getRequestHeaders: () => ({ authorization: 'test' }) },
            'archive',
            undefined,
            progress,
        );

        expect(result).toEqual({
            rows: [
                { file_name: 'one.jsonl' },
                { file_name: 'two.jsonl' },
                { file_name: 'three.jsonl' },
            ],
            errors: 1,
            readToken: null,
        });
        expect(requests.map(request => request.url)).toEqual([
            '/api/chats/archive/inventory',
            '/api/chats/archive/inventory',
        ]);
        expect(requests.map(request => JSON.parse(request.options.body))).toEqual([
            { scope: 'archive', page_size: ARCHIVE_PAGE_SIZE },
            { scope: 'archive', page_size: ARCHIVE_PAGE_SIZE, cursor },
        ]);
        expect(progress.mock.calls).toEqual([
            [expect.objectContaining({ loaded: 1, errors: 1, total: 3 })],
            [expect.objectContaining({ loaded: 3, errors: 1, total: 3 })],
        ]);
    });

    test('delivers the first inventory page before a later request resolves and releases early iteration', async () => {
        const cursor = 'e'.repeat(64);
        let resolveLaterPage;
        let laterRequestStarted;
        const laterRequest = new Promise(resolve => { laterRequestStarted = resolve; });
        const released = [];
        let inventoryRequests = 0;
        globalThis.fetch = async (url, options) => {
            if (url === '/api/chats/archive/release') {
                released.push(JSON.parse(options.body));
                return { ok: true, status: 204 };
            }
            inventoryRequests++;
            if (inventoryRequests === 1) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        rows: [{ file_name: 'first.jsonl' }],
                        cursor,
                        read_token: null,
                        errors: 0,
                        total: 2,
                    }),
                };
            }
            laterRequestStarted();
            return new Promise(resolve => { resolveLaterPage = resolve; });
        };

        const pages = iterateArchiveInventoryPages({ getRequestHeaders: () => ({}) }, 'archive');
        await expect(pages.next()).resolves.toMatchObject({
            done: false,
            value: { loaded: 1, total: 2, rows: [{ file_name: 'first.jsonl' }] },
        });
        const pendingLaterPage = pages.next();
        await laterRequest;
        let laterPageSettled = false;
        void pendingLaterPage.finally(() => { laterPageSettled = true; });
        await Promise.resolve();
        expect(laterPageSettled).toBe(false);

        resolveLaterPage({
            ok: true,
            status: 200,
            json: async () => ({
                rows: [{ file_name: 'second.jsonl' }],
                cursor: null,
                read_token: null,
                errors: 0,
                total: 2,
            }),
        });
        await expect(pendingLaterPage).resolves.toMatchObject({
            value: { loaded: 2, rows: [{ file_name: 'second.jsonl' }] },
        });

        const earlyPages = iterateArchiveInventoryPages({ getRequestHeaders: () => ({}) }, 'archive');
        inventoryRequests = 0;
        await earlyPages.next();
        await earlyPages.return();
        expect(released).toContainEqual({ cursor });
    });

    test('sorts and filters complete metadata from beyond the first archive page', async () => {
        const cursor = 'd'.repeat(64);
        const firstPage = Array.from({ length: ARCHIVE_PAGE_SIZE }, (_, index) => ({
            avatar: 'Scale.png',
            file_name: `chat-${String(index).padStart(3, '0')}.jsonl`,
            file_size: '1KB',
            chat_items: 1,
            last_mes: index + 1,
            mes: '',
        }));
        const qualifying = {
            avatar: 'Scale.png',
            file_name: 'qualifying.jsonl',
            file_size: '8MB',
            chat_items: 900,
            last_mes: 50_000,
            mes: 'late page metadata',
        };
        const pages = [
            { rows: firstPage, cursor, read_token: null, errors: 0, total: ARCHIVE_PAGE_SIZE + 1 },
            { rows: [qualifying], cursor: null, read_token: null, errors: 0, total: ARCHIVE_PAGE_SIZE + 1 },
        ];
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => pages.shift() });

        const inventory = await fetchArchiveInventory({ getRequestHeaders: () => ({}) }, 'archive');
        const rows = inventory.rows.map(row => normalizeRow(row, [{ avatar: 'Scale.png', name: 'Scale' }], []));
        const filtered = filterRows(rows, {
            minDate: 40_000,
            minMessages: 500,
            minSize: 4 * 1024 * 1024,
        });

        expect(filtered.map(row => row.file_id)).toEqual(['qualifying']);
        expect(sortRows(rows, 'count')[0].file_id).toBe('qualifying');
        expect(sortRows(rows, 'recent')[0].file_id).toBe('qualifying');
        expect(sortRows(rows, 'size')[0].file_id).toBe('qualifying');
    });

    test('POST failures preserve HTTP status for lazy missing-file handling', async () => {
        globalThis.fetch = async () => ({
            ok: false,
            status: 404,
            json: async () => ({ message: 'missing chat' }),
        });

        await expect(exportChat({ getRequestHeaders: () => ({}) }, {})).rejects.toMatchObject({
            message: 'missing chat',
            status: 404,
        });
    });

    test('organization sidecar GET distinguishes first use from failures', async () => {
        const signal = new AbortController().signal;
        const requests = [];
        let response = { ok: false, status: 404 };
        globalThis.fetch = async (url, options) => {
            requests.push({ url, options });
            return response;
        };
        const ctx = { getRequestHeaders: () => ({ 'x-test': 'yes' }) };

        await expect(fetchOrganization(ctx, signal)).resolves.toBeNull();
        expect(requests[0].url).toBe(`/user/files/${ORGANIZATION_FILE_NAME}`);
        expect(requests[0].options).toEqual({
            method: 'GET',
            headers: { 'x-test': 'yes' },
            cache: 'no-store',
            signal,
        });

        response = { ok: false, status: 503 };
        await expect(fetchOrganization(ctx)).rejects.toThrow(/_sbca_organization\.json failed with status 503/);

        response = { ok: true, status: 200, json: async () => { throw new SyntaxError('bad sidecar'); } };
        await expect(fetchOrganization(ctx)).rejects.toThrow(SyntaxError);
    });

    test('organization upload round-trips Unicode through browser base64 APIs', async () => {
        let request;
        globalThis.fetch = async (url, options) => {
            request = { url, options };
            return { ok: true, status: 200, json: async () => ({ uploaded: true }) };
        };
        const organization = { version: 1, name: '兔子 café', tags: ['竜', '🙂'] };

        await expect(saveOrganization(
            { getRequestHeaders: () => ({ 'x-csrf-token': 'token' }) },
            organization,
        )).resolves.toEqual({ uploaded: true });

        expect(request.url).toBe('/api/files/upload');
        expect(request.options.headers).toEqual({ 'x-csrf-token': 'token' });
        const upload = JSON.parse(request.options.body);
        expect(upload.name).toBe(ORGANIZATION_FILE_NAME);
        const binary = atob(upload.data);
        const decoded = new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
        expect(JSON.parse(decoded)).toEqual(organization);
        expect(decoded).toBe(JSON.stringify(organization));
    });

    test('organization uploads are bounded and caller-cancellable without AbortSignal.any', async () => {
        Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined, writable: true });
        let requestSignal;
        const ctx = { getRequestHeaders: () => ({}) };
        const caller = new AbortController();
        globalThis.fetch = (_url, options) => {
            requestSignal = options.signal;
            return new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            });
        };
        const pending = saveOrganization(ctx, { version: 1 }, caller.signal);
        expect(requestSignal).not.toBe(caller.signal);
        caller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(requestSignal.aborted).toBe(true);
    });

    test('composes caller cancellation and timeouts when AbortSignal.any is absent', async () => {
        Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined, writable: true });
        const caller = new AbortController();
        const callerRequest = createTimedSignal(caller.signal, 10_000);
        const reason = new DOMException('cancelled', 'AbortError');
        caller.abort(reason);
        expect(callerRequest.signal.aborted).toBe(true);
        expect(callerRequest.signal.reason).toBe(reason);
        callerRequest.cleanup();

        jest.useFakeTimers();
        const timedRequest = createTimedSignal(undefined, 25);
        jest.advanceTimersByTime(25);
        expect(timedRequest.signal.aborted).toBe(true);
        expect(timedRequest.signal.reason).toMatchObject({ name: 'TimeoutError' });
        timedRequest.cleanup();
    });

    test('cancels a later inventory page and releases its cursor and read token', async () => {
        Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined, writable: true });
        const cursor = 'b'.repeat(64);
        const readToken = 'c'.repeat(64);
        const controller = new AbortController();
        let requestCount = 0;
        const releases = [];
        let secondRequestStarted;
        const secondRequest = new Promise(resolve => { secondRequestStarted = resolve; });
        globalThis.fetch = async (url, options) => {
            if (url === '/api/chats/archive/release') {
                releases.push(JSON.parse(options.body));
                return { ok: true, status: 204 };
            }
            requestCount++;
            if (requestCount === 1) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ rows: [{ file_name: 'one.jsonl' }], cursor, read_token: readToken, errors: 0, total: 2 }),
                };
            }
            secondRequestStarted();
            return await new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        };

        const pending = fetchArchiveInventory({ getRequestHeaders: () => ({}) }, 'orphans', controller.signal);
        await secondRequest;
        controller.abort();

        await expect(pending).rejects.toMatchObject({
            name: 'AbortError',
            archiveCursor: cursor,
            archiveReadToken: readToken,
        });
        expect(requestCount).toBe(2);
        expect(releases).toEqual([{ token: readToken, cursor }]);
    });

    test('views and releases orphan files only through the archive namespace', async () => {
        const requests = [];
        globalThis.fetch = async (url, options = {}) => {
            requests.push({ url: String(url), options });
            if (String(url).includes('/view?')) {
                return { ok: true, status: 200, text: async () => 'chat body' };
            }
            return { ok: true, status: 204 };
        };
        const ctx = { getRequestHeaders: () => ({ 'x-test': 'yes' }) };
        const signal = new AbortController().signal;

        await expect(fetchArchiveFile(ctx, 'token', 'hash', signal)).resolves.toBe('chat body');
        await releaseArchiveSession(ctx, { token: 'token', cursor: 'cursor' }, signal);

        expect(requests[0].url).toBe('/api/chats/archive/view?token=token&hash=hash');
        expect(requests[0].options.signal).toBe(signal);
        expect(requests[1].url).toBe('/api/chats/archive/release');
        expect(JSON.parse(requests[1].options.body)).toEqual({ token: 'token', cursor: 'cursor' });
        expect(requests.every(request => !request.url.includes('/api/data-maid'))).toBe(true);
    });

    test('successful list endpoints reject malformed JSON and response shapes', async () => {
        const ctx = { getRequestHeaders: () => ({ 'x-test': 'yes' }) };
        globalThis.fetch = async (_url, options) => {
            expect(options.method).toBe('POST');
            expect(options.headers).toEqual({ 'x-test': 'yes' });
            return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } };
        };
        await expect(fetchArchiveInventory(ctx, 'archive')).rejects.toThrow(SyntaxError);

        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
        await expect(fetchArchiveInventory(ctx, 'archive')).rejects.toThrow(/invalid response/);
        await expect(searchScope(ctx, 'x', {})).rejects.toThrow(/invalid response/);
    });

    test('body-read aborts remain aborts', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => { throw new DOMException('aborted', 'AbortError'); },
        });
        await expect(fetchArchiveInventory({ getRequestHeaders: () => ({}) }, 'archive')).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('SillyBunny Chats Archive core', () => {
    const characters = [
        { avatar: 'Seraphina.png', name: 'Seraphina' },
        { avatar: 'Nahida.png', name: 'Nahida' },
    ];
    const groups = [
        { id: 'group-1', name: 'Tavern Night' },
    ];
    const recentRows = [
        { avatar: 'Seraphina.png', file_id: 'dragon tavern', file_name: 'dragon tavern.jsonl', file_size: '1.5MB', chat_items: 142, last_mes: 3000, mes: 'The dragon grins.' },
        { avatar: 'Missing.png', file_id: 'lost chat', file_name: 'lost chat.jsonl', file_size: '800B', chat_items: 3, last_mes: 2000, mes: 'Hello?' },
        { group: 'group-1', file_id: 'abc-123', file_name: 'abc-123.jsonl', file_size: '2KB', chat_items: 38, last_mes: 4000, mes: 'Cheers!' },
        { file_id: 'stray', file_name: 'stray.jsonl', file_size: '12B', chat_items: 0, last_mes: 1000, mes: '[The chat is empty]' },
    ];
    const normalized = recentRows.map(row => normalizeRow(row, characters, groups));

    test('parseHumanSize handles the host formats', () => {
        expect(parseHumanSize('800B')).toBe(800);
        expect(parseHumanSize('1.5MB')).toBe(1.5 * 1024 * 1024);
        expect(parseHumanSize('1.2 KB')).toBe(1.2 * 1024);
        expect(parseHumanSize('1.2.3MB')).toBe(0);
        expect(parseHumanSize(`${Number.MAX_VALUE}TB`)).toBe(0);
        expect(parseHumanSize('garbage')).toBe(0);
        expect(parseHumanSize(undefined)).toBe(0);
    });

    test('formatBytes handles known and invalid byte counts', () => {
        expect(formatBytes(0)).toBe('0B');
        expect(formatBytes(1536)).toBe('1.5KB');
        expect(formatBytes(2 * 1024 * 1024)).toBe('2MB');
        expect(formatBytes(undefined)).toBe('');
    });

    test('parseLastMes handles mtimeMs numbers, ISO strings, host formats via toMoment, and garbage', () => {
        expect(parseLastMes(12345)).toBe(12345);
        expect(parseLastMes('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
        expect(parseLastMes(undefined)).toBe(0);
        expect(parseLastMes('not a date')).toBe(0);
        expect(parseLastMes(8_640_000_000_000_001)).toBe(0);
        const toMoment = value => ({ isValid: () => value === 'June 2, 2026 7:49pm', valueOf: () => 777 });
        expect(parseLastMes('June 2, 2026 7:49pm', toMoment)).toBe(777);
        expect(parseLastMes('2026-01-01T00:00:00.000Z', toMoment)).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
        expect(parseLastMes('too large', () => ({ isValid: () => true, valueOf: () => 1e100 }))).toBe(0);
    });

    test('normalizeRow uses toMoment for string last_mes', () => {
        const toMoment = () => ({ isValid: () => true, valueOf: () => 999 });
        const row = normalizeRow({ avatar: 'Seraphina.png', file_id: 'x', last_mes: 'June 2, 2026 7:49pm' }, characters, groups, toMoment);
        expect(row.mtime).toBe(999);
    });

    test('normalizeRow classifies solo, group, and both orphan causes', () => {
        expect(normalized[0].kind).toBe('solo');
        expect(normalized[0].ownerName).toBe('Seraphina');
        expect(normalized[1].kind).toBe('orphan');
        expect(normalized[1].ownerName).toBe('Missing');
        expect(normalized[1].avatar).toBe('Missing.png');
        expect(normalized[1].orphanType).toBe('missing-character');
        expect(normalized[2].kind).toBe('group');
        expect(normalized[2].ownerName).toBe('Tavern Night');
        expect(normalized[3].kind).toBe('orphan');
        expect(normalized[3].avatar).toBeNull();
        expect(normalized[3].orphanType).toBe('root');
    });

    test('normalizeRow accepts legacy numeric group IDs', () => {
        const row = normalizeRow({ group: 42, file_id: 'legacy' }, [], [{ id: '42', name: 'Legacy group' }]);
        expect(row.kind).toBe('group');
        expect(row.groupId).toBe('42');
        expect(row.ownerName).toBe('Legacy group');
    });

    test('normalizeRow accepts indexed owner maps', () => {
        const characterMap = new Map(characters.map(character => [character.avatar, character]));
        const groupMap = new Map(groups.map(group => [String(group.id), group]));
        expect(normalizeRow({ avatar: 'Seraphina.png', file_id: 'solo' }, characterMap, groupMap).ownerName).toBe('Seraphina');
        expect(normalizeRow({ group: 'group-1', file_id: 'group' }, characterMap, groupMap).ownerName).toBe('Tavern Night');
    });

    test('normalizeRow derives file_id from file_name when missing', () => {
        const row = normalizeRow({ file_name: 'plain.jsonl' }, [], []);
        expect(row.file_id).toBe('plain');
        expect(row.count).toBeNull();
        expect(row.snippet).toBe('');
    });

    test('normalizeRow turns available message text into a visible one-line preview', () => {
        expect(normalizeRow({ file_id: 'text', mes: '\n  First line\n\nSecond line  ' }).snippet).toBe('First line Second line');
        expect(normalizeRow({ file_id: 'blank', mes: ' \n\t ' }).snippet).toBe('');
        expect(normalizeRow({ file_id: 'long', mes: 'x'.repeat(500) }).snippet).toBe(`${'x'.repeat(397)}...`);
    });

    test('normalizers reject malformed records and keep file identity consistent', () => {
        expect(normalizeRow(null)).toBeNull();
        expect(normalizeRow({ avatar: 1, file_id: 'bad' })).toBeNull();
        expect(normalizeRow({ orphan_type: 'invalid', file_name: 'bad.jsonl' })).toBeNull();
        expect(deepResultToRecentRow('bad', {})).toBeNull();
        const row = normalizeRow({ file_id: 'wrong', file_name: 'actual.jsonl', chat_items: -3 });
        expect(row.file_id).toBe('actual');
        expect(row.count).toBe(0);
    });

    test('deepResultToRecentRow maps search results into the recent-row shape', () => {
        const mapped = deepResultToRecentRow(
            { file_name: 'found chat', file_size: '2KB', message_count: 7, last_mes: 5000, preview_message: '…tavern…' },
            { avatar_url: 'Seraphina.png' },
        );
        const row = normalizeRow(mapped, characters, groups);
        expect(row.kind).toBe('solo');
        expect(row.file_id).toBe('found chat');
        expect(row.count).toBe(7);
        expect(row.snippet).toBe('…tavern…');
        expect(row.source).toBe('search');
    });

    test('search scopes cover both wire types for legacy numeric group IDs', () => {
        expect(buildSearchScopes(
            [{ avatar: 'Seraphina.png' }],
            [{ id: '42' }, { id: 'group-1' }, { id: '0042' }, { id: '0' }],
        )).toEqual([
            { avatar_url: 'Seraphina.png' },
            { group_id: '42' },
            { group_id: 42 },
            { group_id: 'group-1' },
            { group_id: '0042' },
            { group_id: '0' },
        ]);
    });

    test('search scopes can be restricted to the selected owner', () => {
        expect(buildSearchScopes(characters, groups, 'Seraphina')).toEqual([
            { avatar_url: 'Seraphina.png' },
        ]);
        expect(buildSearchScopes(characters, groups, 'Tavern Night')).toEqual([
            { group_id: 'group-1' },
        ]);
        expect(buildSearchScopes(characters, groups, 'missing')).toEqual([]);
    });

    test('typed owner filters keep duplicate names and owner kinds distinct', () => {
        const duplicateCharacters = [
            { avatar: 'Alex.png', name: 'Alex' },
            { avatar: 'Alex_2.png', name: 'Alex' },
        ];
        const duplicateGroups = [{ id: 'alex-group', name: 'Alex' }];
        const rows = [
            normalizeRow({ avatar: 'Alex.png', file_id: 'first' }, duplicateCharacters, duplicateGroups),
            normalizeRow({ avatar: 'Alex_2.png', file_id: 'second' }, duplicateCharacters, duplicateGroups),
            normalizeRow({ group: 'alex-group', file_id: 'group' }, duplicateCharacters, duplicateGroups),
            normalizeRow({
                _source: 'archive-orphan',
                archive_hash: 'hash',
                chatFolder: 'Alex',
                file_name: 'missing.jsonl',
                orphan_type: 'missing-character',
            }),
        ];
        const first = ownerFilterKey(rows[0]);
        const second = ownerFilterKey(rows[1]);
        const group = ownerFilterKey(rows[2]);

        expect(first).toBe('@sbca:["character","Alex"]');
        expect(first).not.toBe(second);
        expect(parseOwnerFilter(group)).toEqual({ kind: 'group', id: 'alex-group' });
        expect(parseOwnerFilter('Alex')).toBeNull();
        expect(parseOwnerFilter('["group","alex-group"]')).toBeNull();
        expect(filterRows(rows, { owner: first }).map(row => row.file_id)).toEqual(['first', 'missing']);
        expect(filterRows(rows, { owner: second }).map(row => row.file_id)).toEqual(['second']);
        expect(filterRows(rows, { owner: group }).map(row => row.file_id)).toEqual(['group']);
        expect(filterRows(rows, { owner: 'Alex' })).toHaveLength(4);
        expect(buildSearchScopes(duplicateCharacters, duplicateGroups, second)).toEqual([{ avatar_url: 'Alex_2.png' }]);
        expect(buildSearchScopes(duplicateCharacters, duplicateGroups, group)).toEqual([{ group_id: 'alex-group' }]);
        expect(normalizeSavedView({ owner: second }).owner).toBe(second);
    });

    test('normalizeRow preserves archive orphan source details', () => {
        const row = normalizeRow({
            _source: 'archive-orphan',
            archive_hash: 'abc',
            chatFolder: 'Deleted',
            file_name: 'lost.jsonl',
            file_size: '2KB',
            last_mes: 123,
            orphan_type: 'missing-character',
        });
        expect(row.kind).toBe('orphan');
        expect(row.orphanType).toBe('missing-character');
        expect(row.ownerName).toBe('Deleted');
        expect(row.chatFolder).toBe('Deleted');
        expect(row.file_id).toBe('lost');
        expect(row.sizeText).toBe('2KB');
        expect(row.count).toBeNull();
        expect(row.archiveHash).toBe('abc');
    });

    test('physicalChatKey follows physical file scope instead of owner or archive token identity', () => {
        const linkedGroup = normalizeRow({ group: 'group-1', file_id: 'shared' }, [], groups);
        const missingGroup = normalizeRow({ group: 'deleted-group', file_id: 'shared' });
        const unlinkedGroup = normalizeRow({
            _source: 'archive-orphan',
            archive_hash: 'temporary-a',
            file_name: 'shared.jsonl',
            orphan_type: 'unlinked-group',
        });
        expect(physicalChatKey(linkedGroup)).toBe(physicalChatKey(missingGroup));
        expect(physicalChatKey(missingGroup)).toBe(physicalChatKey(unlinkedGroup));

        const linkedCharacter = normalizeRow({ avatar: 'Seraphina.png', file_id: 'solo' }, characters);
        const missingCharacter = normalizeRow({
            _source: 'archive-orphan',
            archive_hash: 'temporary-b',
            chatFolder: 'Seraphina',
            file_name: 'solo.jsonl',
            orphan_type: 'missing-character',
        });
        expect(linkedCharacter.chatFolder).toBe('Seraphina');
        expect(physicalChatKey(linkedCharacter)).toBe(physicalChatKey(missingCharacter));
        expect(physicalChatKey({ ...missingCharacter, archiveHash: 'different' })).toBe(physicalChatKey(missingCharacter));

        expect(physicalChatKey({ kind: 'solo', chatFolder: 'a:b', file_id: 'c' }))
            .not.toBe(physicalChatKey({ kind: 'solo', chatFolder: 'a', file_id: 'b:c' }));
        expect(physicalChatKey({ kind: 'orphan', orphanType: 'root', file_id: 'solo' })).toBe('["root","solo"]');
    });

    test('organization normalization is strict, sparse, stable, and reference-safe', () => {
        expect(createDefaultOrganization()).toEqual({
            version: 1,
            lastView: {},
            views: [],
            folders: [],
            collections: [],
            chats: {},
        });
        expect(() => normalizeOrganization(null)).toThrow(/root must be an object/);
        expect(() => normalizeOrganization([])).toThrow(/root must be an object/);
        expect(() => normalizeOrganization({})).toThrow(/Unsupported organization version/);
        expect(() => normalizeOrganization({ version: 2 })).toThrow(/version: 2/);

        const normalizedOrganization = normalizeOrganization({
            version: 1,
            unknown: true,
            lastView: {
                query: '  tavern  ',
                kinds: ['solo', 'solo', 'invalid', 'group'],
                sort: ' oldest ',
                group: ' folder ',
                density: ' compact ',
                favorite: false,
                folder: ' f1 ',
                collection: 'missing',
                minSize: 0,
                maxMessages: 20,
                minDate: '2026-01-01',
                results: [{ deep: true }],
            },
            views: [
                { id: ' view-1 ', name: ' Work ', view: { owner: ' Seraphina ', collection: 'c1', tag: ' Dragon ' } },
                { id: 'view-2', name: 'work', view: {} },
                { id: 'view-3', name: 'Broken' },
            ],
            folders: [
                { id: ' f1 ', name: ' Work ' },
                { id: 'f2', name: 'work' },
                { id: 'f1', name: 'Other' },
            ],
            collections: [
                { id: 'c1', name: ' Lore ' },
                { id: 'c2', name: 'lore' },
                { id: 'c3', name: 'Archive' },
            ],
            chats: {
                ' keep ': {
                    favorite: true,
                    folder: ' f1 ',
                    collections: ['c1', 'c1', 'missing'],
                    tags: [' Dragon ', 'dragon', 'Lore'],
                    ignored: true,
                },
                stale: { favorite: false, folder: 'missing', collections: ['missing'], tags: [] },
                retainedWithoutRows: { tags: [' Keep me '] },
            },
        });

        expect(normalizedOrganization).toEqual({
            version: 1,
            lastView: {
                query: 'tavern',
                kinds: ['solo', 'group'],
                sort: 'oldest',
                group: 'folder',
                density: 'compact',
                favorite: false,
                folder: 'f1',
                minSize: 0,
                maxMessages: 20,
                minDate: '2026-01-01',
            },
            views: [{
                id: 'view-1',
                name: 'Work',
                view: { owner: 'Seraphina', collection: 'c1', tag: 'Dragon' },
            }],
            folders: [{ id: 'f1', name: 'Work' }],
            collections: [{ id: 'c1', name: 'Lore' }, { id: 'c3', name: 'Archive' }],
            chats: {
                keep: { favorite: true, folder: 'f1', collections: ['c1'], tags: ['Dragon', 'Lore'] },
                retainedWithoutRows: { tags: ['Keep me'] },
            },
        });
        expect(parseOrganization(JSON.stringify(normalizedOrganization))).toEqual(normalizedOrganization);
    });

    test('normalizeSavedView retains only bounded browse state', () => {
        expect(normalizeSavedView({
            query: '   ',
            kinds: [],
            sort: 'invalid',
            group: 'owner',
            density: 'minimal',
            charSort: 'new',
            owner: ' Alice ',
            orphan: 'root',
            favorite: false,
            folder: null,
            collection: ' c1 ',
            tag: ' History ',
            minDate: 10,
            maxDate: '2026-12-31',
            minSize: 0,
            maxSize: Infinity,
            minMessages: 0,
            maxMessages: 2.5,
            selection: ['chat'],
            page: 4,
            viewer: { raw: true },
        }, { folders: [], collections: [{ id: 'c1' }] })).toEqual({
            kinds: [],
            group: 'owner',
            density: 'minimal',
            owner: 'Alice',
            orphan: 'root',
            favorite: false,
            folder: null,
            collection: 'c1',
            tag: 'History',
            minSize: 0,
            minMessages: 0,
            minDate: 10,
            maxDate: '2026-12-31',
        });
    });

    test('filterRows matches file name, owner, and snippet case-insensitively', () => {
        expect(filterRows(normalized, { text: 'DRAGON' })).toHaveLength(1);
        expect(filterRows(normalized, { text: 'seraphina' })[0].file_id).toBe('dragon tavern');
        expect(filterRows(normalized, { text: 'cheers' })[0].kind).toBe('group');
        expect(filterRows(normalized, { text: '' })).toHaveLength(4);
    });

    test('filterRows applies kind filters', () => {
        expect(filterRows(normalized, { kinds: ['orphan'] })).toHaveLength(2);
        expect(filterRows(normalized, { kinds: ['solo', 'group'] })).toHaveLength(2);
        expect(filterRows(normalized, { text: 'lost', kinds: ['solo'] })).toHaveLength(0);
    });

    test('filterRows applies organization labels, facets, and metadata bounds', () => {
        const organization = {
            folders: [{ id: 'quests', name: 'Heroic Quests' }],
            collections: [{ id: 'lore', name: 'Lore Shelf' }],
            chats: {
                [physicalChatKey(normalized[0])]: {
                    favorite: true,
                    folder: 'quests',
                    collections: ['lore'],
                    tags: ['Ancient Dragon'],
                },
            },
        };
        for (const text of ['heroic quests', 'LORE SHELF', 'ancient dragon']) {
            expect(filterRows(normalized, { text }, organization).map(row => row.file_id)).toEqual(['dragon tavern']);
        }
        expect(filterRows(normalized, {
            kinds: ['solo'],
            owner: 'Seraphina',
            favorite: true,
            folder: 'quests',
            collection: 'lore',
            tag: 'ANCIENT DRAGON',
            minDate: 2500,
            maxDate: 3500,
            minSize: 1024,
            maxSize: 2 * 1024 * 1024,
            minMessages: 100,
            maxMessages: 200,
        }, organization).map(row => row.file_id)).toEqual(['dragon tavern']);
        expect(filterRows(normalized, { orphan: 'missing-character' }).map(row => row.file_id)).toEqual(['lost chat']);
        expect(filterRows(normalized, { folder: null }, organization)).toHaveLength(3);
        expect(filterRows(normalized, { favorite: false }, organization)).toHaveLength(3);

        const unknown = normalizeRow({ file_id: 'unknown' });
        expect(filterRows([unknown])).toHaveLength(1);
        expect(filterRows([unknown], { minDate: 0 })).toHaveLength(0);
        expect(filterRows([unknown], { minSize: 0 })).toHaveLength(0);
        expect(filterRows([unknown], { minMessages: 0 })).toHaveLength(0);
    });

    test('sortRows sorts by all four keys', () => {
        expect(sortRows(normalized, 'recent').map(row => row.file_id)).toEqual(['abc-123', 'dragon tavern', 'lost chat', 'stray']);
        expect(sortRows(normalized, 'size').map(row => row.file_id)).toEqual(['dragon tavern', 'abc-123', 'lost chat', 'stray']);
        expect(sortRows(normalized, 'count').map(row => row.file_id)).toEqual(['dragon tavern', 'abc-123', 'lost chat', 'stray']);
        expect(sortRows(normalized, 'name').map(row => row.file_id)).toEqual(['abc-123', 'dragon tavern', 'lost chat', 'stray']);
    });

    test('sortRows supports reverse sorts and keeps unknown metadata last', () => {
        expect(sortRows(normalized, 'oldest').map(row => row.file_id)).toEqual(['stray', 'lost chat', 'dragon tavern', 'abc-123']);
        expect(sortRows(normalized, 'smallest').map(row => row.file_id)).toEqual(['stray', 'lost chat', 'abc-123', 'dragon tavern']);
        expect(sortRows(normalized, 'fewest').map(row => row.file_id)).toEqual(['stray', 'lost chat', 'abc-123', 'dragon tavern']);
        expect(sortRows(normalized, 'name-reverse').map(row => row.file_id)).toEqual(['stray', 'lost chat', 'dragon tavern', 'abc-123']);
        expect(sortRows(normalized, 'owner').map(row => row.file_id)).toEqual(['stray', 'lost chat', 'dragon tavern', 'abc-123']);

        const rows = [
            { file_id: 'known-high', mtime: 20, sizeBytes: 20, count: 20 },
            { file_id: 'z-unknown', mtime: null, sizeBytes: null, count: null },
            { file_id: 'known-low', mtime: 10, sizeBytes: 10, count: 10 },
            { file_id: 'a-unknown' },
        ];
        for (const key of ['recent', 'size', 'count']) {
            expect(sortRows(rows, key).map(row => row.file_id)).toEqual(['known-high', 'known-low', 'a-unknown', 'z-unknown']);
        }
        for (const key of ['oldest', 'smallest', 'fewest']) {
            expect(sortRows(rows, key).map(row => row.file_id)).toEqual(['known-low', 'known-high', 'a-unknown', 'z-unknown']);
        }
    });

    test('groupRows preserves sorted first-occurrence group order', () => {
        const rows = [normalized[2], normalized[0], normalized[3], normalized[1]];
        const organization = {
            folders: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
            collections: [],
            chats: {
                [physicalChatKey(normalized[2])]: { folder: 'beta' },
                [physicalChatKey(normalized[0])]: { folder: 'alpha' },
                [physicalChatKey(normalized[3])]: { folder: 'beta' },
            },
        };

        expect(groupRows(rows, 'type').map(group => [group.label, group.rows.map(row => row.file_id)])).toEqual([
            ['group', ['abc-123']],
            ['solo', ['dragon tavern']],
            ['orphan', ['stray', 'lost chat']],
        ]);
        expect(groupRows(rows, 'folder', organization).map(group => [group.label, group.rows.map(row => row.file_id)])).toEqual([
            ['Beta', ['abc-123', 'stray']],
            ['Alpha', ['dragon tavern']],
            ['Unfiled', ['lost chat']],
        ]);
        expect(groupRows(rows, 'owner').map(group => group.label)).toEqual(['Tavern Night', 'Seraphina', 'Unknown owner', 'Missing']);
        expect(groupRows(rows, 'flat').map(group => group.rows)).toEqual([rows]);
    });

    test('shapeChatRecords splits header from messages and shapes them', () => {
        const records = [
            { user_name: 'unused', chat_metadata: { integrity: 'uuid', MacroEnhanced: {} } },
            { name: 'You', is_user: true, send_date: '2026-01-01T00:00:00.000Z', mes: 'Hi' },
            { name: 'Seraphina', is_user: false, mes: 'Hello', swipe_id: 1, swipes: [null, 'Hello', 'Hey'], extra: { model: 'x', api: 'y' } },
            { name: 'System', is_system: true, mes: 'note' },
        ];
        const shaped = shapeChatRecords(records);
        expect(shaped.metadataKeys).toEqual(['integrity', 'MacroEnhanced']);
        expect(shaped.messages).toHaveLength(3);
        expect(shaped.messages[0].isUser).toBe(true);
        expect(shaped.messages[1].swipeCount).toBe(1);
        expect(shaped.messages[1].alternatives).toEqual(['Hey']);
        expect(shaped.messages[1].extra).toEqual({ model: 'x', api: 'y' });
        expect(shaped.messages[2].isSystem).toBe(true);
    });

    test('parseJsonl handles BOMs and blank lines and identifies corrupt lines', () => {
        expect(parseJsonl('\uFEFF{"chat_metadata":{}}\n\n{"name":"You","mes":"Hi"}\r\n')).toEqual([
            { chat_metadata: {} },
            { name: 'You', mes: 'Hi' },
        ]);
        expect(() => parseJsonl('{"ok":true}\nnot json')).toThrow(/line 2/);
    });

    test('findMatchingSnippet uses cross-message AND fragment semantics', () => {
        const records = [
            { name: 'A', mes: 'The red dragon left.' },
            { name: 'B', mes: 'Meet me at the tavern.' },
            { name: 'C', mes: 'This final preview has neither term.' },
        ];
        expect(findMatchingSnippet(records, 'dragon tavern')).toBe('The red dragon left.');
        expect(findMatchingSnippet(records, 'dragon castle')).toBeNull();
        expect(findMatchingSnippet([{ mes: '\n  dragon\n\narrives  ' }], 'dragon')).toBe('dragon arrives');
    });

    test('findMatchingMessageIndex points to the first preview match only when the whole query matches', () => {
        const messages = [
            { mes: 'The red dragon left.' },
            { mes: 'Meet me at the tavern.' },
        ];
        expect(findMatchingMessageIndex(messages, 'dragon tavern')).toBe(0);
        expect(findMatchingMessageIndex(messages, 'dragon castle')).toBe(-1);
        expect(findMatchingMessageIndex(messages, '   ')).toBe(-1);
    });

    test('matchesQueryFragments applies host-style AND matching to filenames', () => {
        expect(matchesQueryFragments('dragon at the tavern', 'DRAGON tavern')).toBe(true);
        expect(matchesQueryFragments('dragon at the inn', 'dragon tavern')).toBe(false);
        expect(matchesQueryFragments('anything', '   ')).toBe(false);
    });

    test('JSONL search keeps readable messages around a corrupt line', () => {
        const raw = '{"name":"A","mes":"red dragon"}\nnot json\n{"name":"B","mes":"the tavern"}';
        expect(findMatchingSnippetInJsonl(raw, 'dragon tavern')).toEqual({ snippet: 'red dragon', invalidLines: 1 });
        expect(findMatchingSnippetInJsonl(raw, 'dragon castle')).toEqual({ snippet: null, invalidLines: 1 });
    });

    test('chunked JSONL parsing and search preserve behavior and honor cancellation', async () => {
        const raw = '\uFEFF{"chat_metadata":{"integrity":"ok"}}\n{"name":"A","mes":"red dragon"}\n{"name":"B","mes":"the tavern"}';
        await expect(parseChatJsonl(raw, { linesPerChunk: 1 })).resolves.toEqual(shapeChatRecords(parseJsonl(raw)));
        await expect(findMatchingSnippetInJsonlAsync(`${raw}\nnot json`, 'dragon tavern', { linesPerChunk: 1 }))
            .resolves.toEqual({ snippet: 'red dragon', invalidLines: 1 });

        const controller = new AbortController();
        const pending = findMatchingSnippetInJsonlAsync(raw.repeat(100), 'dragon', {
            signal: controller.signal,
            linesPerChunk: 1,
        });
        setTimeout(() => controller.abort(), 0);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

        const parseController = new AbortController();
        const parsing = parseChatJsonl('{"mes":"ok"}\nnot json', {
            signal: parseController.signal,
            linesPerChunk: 1,
        });
        parseController.abort();
        await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('recordsToText skips system messages and honors display text', () => {
        const text = recordsToText([
            { name: 'System', is_system: true, mes: 'hidden' },
            { name: 'You', mes: 'raw', extra: { display_text: 'shown' } },
            { name: 'You', mes: 'fallback', extra: { display_text: '' } },
            { name: 'Bot', mes: 'reply' },
        ]);
        expect(text).toBe('You: shown\n\nYou: fallback\n\nBot: reply');
    });

    test('shapeChatRecords tolerates malformed and empty input', () => {
        expect(shapeChatRecords(null).messages).toEqual([]);
        expect(shapeChatRecords([]).metadataKeys).toEqual([]);
        const noHeader = shapeChatRecords([{ name: 'You', mes: 'orphan line' }, null, 'junk']);
        expect(noHeader.header).toBeNull();
        expect(noHeader.messages).toHaveLength(1);
    });
});

describe('SillyBunny Chats Archive navigation', () => {
    function context() {
        return {
            eventSource: new EventEmitter(),
            eventTypes: { CHAT_CHANGED: 'chat-changed' },
        };
    }

    test('navigation resolves only after the requested host event', async () => {
        const ctx = context();
        await navigateAndConfirm(ctx, 'wanted', async () => {
            ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED, 'other');
            ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED, 'wanted');
        });
        expect(ctx.eventSource.listenerCount(ctx.eventTypes.CHAT_CHANGED)).toBe(0);
    });

    test('navigation rejects immediately when the host action finishes unconfirmed', async () => {
        const ctx = context();
        await expect(navigateAndConfirm(ctx, 'wanted', async () => {})).rejects.toThrow(/did not confirm/);
        expect(ctx.eventSource.listenerCount(ctx.eventTypes.CHAT_CHANGED)).toBe(0);
    });

    test('navigation timeout rejects and removes the host listener when the action hangs', async () => {
        const ctx = context();
        let actionSignal;
        await expect(navigateAndConfirm(ctx, 'wanted', signal => {
            actionSignal = signal;
            return new Promise(() => {});
        }, { timeout: 5 })).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(actionSignal.aborted).toBe(true);
        expect(ctx.eventSource.listenerCount(ctx.eventTypes.CHAT_CHANGED)).toBe(0);
    });

    test('navigation abort rejects and removes the host listener', async () => {
        const ctx = context();
        const controller = new AbortController();
        const pending = navigateAndConfirm(ctx, 'wanted', signal => (
            new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        ), { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(ctx.eventSource.listenerCount(ctx.eventTypes.CHAT_CHANGED)).toBe(0);
    });
});

describe('SillyBunny Chats Archive integration', () => {
    test('entry point is one host-sized native dialog button, not a fake tab', () => {
        expect(entry).toMatch(/createElement\('button'\)/);
        expect(entry).toMatch(/createElement\('i'\)/);
        expect(entry).toMatch(/fa-box-archive/);
        expect(entry).toMatch(/aria-haspopup', 'dialog'/);
        expect(entry).not.toMatch(/role', 'tab'/);
        expect(entry).not.toMatch(/data-sb-character-tab/);
        expect(entry).toMatch(/button\.className = 'menu_button sbca-drawer-button'/);
    });

    test('archive exposes labels, live state, selection, and cancellable work', () => {
        expect(ui).toMatch(/setAttribute\('role', 'status'\)/);
        expect(ui).toMatch(/aria-labelledby/);
        expect(ui).toMatch(/aria-current/);
        expect(ui).toMatch(/new AbortController\(\)/);
        expect(ui).toMatch(/eventTypes\.CHAT_CHANGED/);
        expect(ui).toMatch(/setActive(?:Character|Group)/);
        expect(ui).toMatch(/aria-expanded/);
        expect(ui).toMatch(/aria-pressed/);
        expect(ui).toMatch(/state\.deepRows === null \? ui\.search\.value : ''/);
        expect(ui).toMatch(/ORGANIZATION_FILE_NAME/);
        expect(ui).toMatch(/Do not delete \{name\} through host Data Maid/);
        expect(ui).toMatch(/sbca-selection-toggle/);
        expect(ui).toMatch(/sbca-organizer/);
        expect(ui).toMatch(/physicalChatKey/);
        expect(ui).toMatch(/'Character or group'/);
        expect(ui).toMatch(/'All characters and groups'/);
        expect(ui).toMatch(/sbca-owner-selector/);
        expect(ui).toMatch(/const ownerField = ownerControl\(ctx\)/);
        expect(ui).toMatch(/ownerFilterKey\(row\)/);
        expect(ui).toMatch(/getThumbnailUrl\('avatar', choice\.avatar\)/);
        expect(ui).toMatch(/Search characters and groups/);
        expect(ui).toMatch(/Character: \{name\}/);
        expect(ui).toMatch(/listToolsPanel\.append\(ownerField\.wrap, sortPills, selectionBar\)/);
        expect(ui).toMatch(/listTop\.append\(listHeading, listTools\)/);
        expect(ui).toMatch(/listPanel\.append\(listTop, list\)/);
        expect(ui).toMatch(/sbca-list-tools/);
        expect(ui).toMatch(/listTools\.open = true/);
        expect(ui).toMatch(/option\.addEventListener\('pointerdown', event => \{\s*if \(event\.button !== 0 \|\| event\.pointerType === 'touch'\)/);
        expect(ui).toMatch(/option\.addEventListener\('click', select\)/);
        expect(ui).toMatch(/sbca-sortpill/);
        expect(ui).not.toMatch(/characterChips|sbca-charstrip|sbca-charchip|charSort/);
        expect(ui).toMatch(/enterKeyHint = 'search'/);
        expect(ui).toMatch(/SEARCH_DEBOUNCE_MS = 150/);
        expect(ui).toMatch(/search\.addEventListener\('input', \(\) => \{\s*exitDeepSearch\(ctx, state, ui\);\s*noteViewEdit\(\);/);
        expect(ui).toMatch(/buildSearchScopes\(ctx\.characters, ctx\.groups, ui\.owner\.value\)/);
        expect(ui).toMatch(/findMatchingMessageIndex/);
        expect(ui).toMatch(/First search match/);
        expect(ui).toMatch(/Latest messages/);
        expect(ui).toMatch(/event\.key !== 'ArrowDown'/);
        expect(ui).toMatch(/event\.isComposing/);
        expect(ui).toMatch(/more\.click\(\)/);
        expect(ui).toMatch(/showPage\(shaped\.messages\.length - MESSAGE_PAGE_SIZE\)/);
        expect(ui).toMatch(/state\.deepRows !== null && state\.deepQuery === matchQuery/);
        expect(ui).toMatch(/search result verification failed/);
        expect(ui).toMatch(/search items had errors/);
        expect(ui).toMatch(/allRows\(state\)\.filter\(row => row\.kind === 'orphan'\)/);
        expect(ui).not.toMatch(/row\.kind === 'orphan' \|\| row\.source === 'inventory'/);
        expect(ui).toMatch(/findMatchingSnippetInJsonlAsync\(raw, query, \{ signal \}\)/);
        expect(ui).not.toMatch(/findExistingGroupFiles/);
        expect(ui).toMatch(/sbca-browse-options/);
        expect(ui).toMatch(/Clear filters/);
        expect(ui).not.toMatch(/sbca-row-selection-label/);
        expect(ui).not.toMatch(/\browKey\(/);
        expect(ui).not.toMatch(/menu_button/);
        expect(ui).not.toMatch(/el\('div', 'sbca-action/);
    });

    test('archive preserves focus and exposes item-specific actions', () => {
        expect(ui).toMatch(/function preserveArchiveFocus\(ui, update\)/);
        expect(ui).toMatch(/organizationFocusKey\('manager', type, item\.id, 'rename'\)/);
        expect(ui).toMatch(/organizationFocusKey\('organizer', key, 'favorite'\)/);
        expect(ui).toMatch(/control\.dataset\.sbcaFocusKey === snapshot\.fallback/);
        expect(ui).toMatch(/snapshot\.viewer \? ui\.viewerTitle : snapshot\.list \? ui\.listHeading/);
        expect(ui).toMatch(/preserveArchiveFocus\(ui, \(\) => \{\s*refreshOrganizationUI/s);
        expect(ui).toMatch(/Rename \{name\}/);
        expect(ui).toMatch(/Delete \{name\}/);
        expect(ui).toMatch(/Select \{name\} for \{owner\}/);
        expect(ui).toMatch(/Delete saved view \{name\}\?/);
        expect(ui).toMatch(/const active = document\.activeElement;\s*const focusInBrowse = browseStrip\.contains\(active\);\s*browseOptions\.open/s);
        expect(ui).toMatch(/focusInBrowse\) \{\s*browseSummary\.focus/s);
        expect(ui).toMatch(/active === browseSummary\) \{\s*groupField\.select\.focus/s);
        const cancelViewer = ui.slice(ui.indexOf('function cancelViewer'), ui.indexOf('function cancelNavigation'));
        expect(cancelViewer).toMatch(/state\.viewerAbort\?\.abort\(\)/);
        expect(cancelViewer).not.toMatch(/state\.viewerAbort = null/);
    });

    test('message lists, grouping, scans, and search retain their safety contracts', () => {
        const searchStart = ui.indexOf('search.addEventListener(\'keydown\'', ui.indexOf('const flushQuery'));
        const searchHandler = ui.slice(searchStart, ui.indexOf('\n    });', searchStart));
        expect(searchHandler).toMatch(/event\.key !== 'Enter' \|\| event\.isComposing/);
        expect(searchHandler).toMatch(/flushQuery\(\)/);
        expect(searchHandler).not.toMatch(/runDeepSearch/);
        expect(ui).toMatch(/deepButton\.addEventListener\('click',[\s\S]*?runDeepSearch/);
        expect(ui).toMatch(/const messageList = el\('div', 'sbca-message-list'\);/);
        expect(ui).toMatch(/messageList\.setAttribute\('role', 'list'\)/);
        expect(ui).toMatch(/messages\.append\(messageList, el\('p', 'sbca-placeholder'/);
        expect(ui).toMatch(/appendMessagePage\(ctx, shaped\.messages, messageList, messages/);
        expect(ui).toMatch(/list\.append\(card\)/);
        expect(ui).toMatch(/controls\.append\(more\)/);
        expect(ui).toMatch(/showPage\(end\)\?\.focus/);
        expect(ui).toMatch(/Raw preview truncated\. Download the original file/);
        expect(ui).toMatch(/const shownRows = new Set\(rows\.slice\(0, state\.visibleLimit\)\)/);
        expect(ui).toMatch(/groupRows\(rows, ui\.group\.value, state\.organization\)/);
        expect(ui).toMatch(/group\.rows\.filter\(row => shownRows\.has\(row\)\)/);
        expect(ui).toMatch(/group\.rows\.length/);
        expect(ui).toMatch(/for \(const row of shownGroupRows\)/);
        expect(ui).toMatch(/ui\.status\.setAttribute\('aria-busy', 'true'\)/);
        expect(ui).toMatch(/ui\.status\.removeAttribute\('aria-busy'\)/);
    });

    test('manifest hooks resolve to exported lifecycle functions', () => {
        expect(manifest.hooks).toEqual({ activate: 'activate', enable: 'enable', disable: 'disable' });
        expect(manifest).not.toHaveProperty('bundled_opt_in');
        expect(manifest).not.toHaveProperty('minimum_client_version');
        for (const hook of Object.values(manifest.hooks)) {
            expect(typeof entryModule[hook]).toBe('function');
        }
        expect(extensionsEndpoint).toMatch(/const CORE_EXTENSIONS = new Set\(\[[\s\S]*?'sillybunny-chats-archive',[\s\S]*?\]\);/);
        expect(ui).toContain('import(\'../../../../script.js\')');
        expect(ui).toContain('import(\'../../../group-chats.js\')');
    });

    test('entry observer narrows from the document body when the host panel appears', () => {
        expect(entry).toMatch(/const target = document\.querySelector\(PANEL_SELECTOR\) \?\? document\.body/);
        expect(entry).toMatch(/observerTarget !== target/);
        expect(entry).toMatch(/observer\.observe\(target\.parentElement, \{ childList: true \}\)/);
        expect(entry).toMatch(/pending = setTimeout\(\(\) => \{\s*pending = null;\s*install\(\);/);
    });

});

describe('Data Maid Chat Archive integration', () => {
    test('keeps the organization sidecar out of loose user files', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-archive-'));
        const directories = {
            root,
            userImages: path.join(root, 'user-images'),
            files: path.join(root, 'files'),
            chats: path.join(root, 'chats'),
            groupChats: path.join(root, 'group-chats'),
            groups: path.join(root, 'groups'),
            characters: path.join(root, 'characters'),
            thumbnailsAvatar: path.join(root, 'thumbnails-avatar'),
            backgrounds: path.join(root, 'backgrounds'),
            thumbnailsBg: path.join(root, 'thumbnails-bg'),
            thumbnailsBgMobile: path.join(root, 'thumbnails-bg-mobile'),
            avatars: path.join(root, 'avatars'),
            thumbnailsPersona: path.join(root, 'thumbnails-persona'),
            backups: path.join(root, 'backups'),
        };

        try {
            await Promise.all(Object.values(directories).map(directory => mkdir(directory, { recursive: true })));
            const sidecar = path.join(directories.files, ORGANIZATION_FILE_NAME);
            const ordinaryFile = path.join(directories.files, 'notes.txt');
            await Promise.all([
                writeFile(sidecar, '{"version":1}'),
                writeFile(ordinaryFile, 'loose file'),
            ]);

            const report = await new DataMaidService('test-user', directories).generateReport();

            expect(report.files).toEqual([ordinaryFile]);
            expect(report.files).not.toContain(sidecar);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
