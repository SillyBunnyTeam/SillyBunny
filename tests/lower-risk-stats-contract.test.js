import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';

import { initContractConfig } from './util/lower-risk-contract-harness.js';

const originalDataRoot = global.DATA_ROOT;
const tempDataRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-stats-contract-'));
global.DATA_ROOT = tempDataRoot;

const contractConfig = await initContractConfig('sillybunny-stats-cfg-');

const { initUserStorage, getUserDirectories } = await import('../src/users.js');
await initUserStorage(tempDataRoot);

const {
    router: statsRouter,
    init: statsInit,
    onExit: statsOnExit,
    recreateStats,
} = await import('../src/endpoints/stats.js');

const DEFAULT_HANDLE = 'default-user';

function ensureUserDirs(handle = DEFAULT_HANDLE) {
    const dirs = getUserDirectories(handle);
    fs.mkdirSync(dirs.root, { recursive: true });
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    return dirs;
}

function resetUserFiles(handle = DEFAULT_HANDLE) {
    const dirs = getUserDirectories(handle);
    if (fs.existsSync(dirs.root)) {
        fs.rmSync(dirs.root, { recursive: true, force: true, maxRetries: 5 });
    }
    return ensureUserDirs(handle);
}

describe('Usage statistics endpoint contract', () => {
    let server;
    let baseUrl;
    let activeHandle = DEFAULT_HANDLE;
    let activeDirs;

    beforeAll(async () => {
        activeDirs = resetUserFiles(DEFAULT_HANDLE);

        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((req, _res, next) => {
            req.user = {
                profile: { handle: activeHandle },
                directories: activeDirs,
            };
            next();
        });
        app.use('/api/stats', statsRouter);

        server = await new Promise((resolve, reject) => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
            listener.once('error', reject);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        activeHandle = DEFAULT_HANDLE;
        activeDirs = resetUserFiles(DEFAULT_HANDLE);
    });

    afterAll(async () => {
        server?.closeAllConnections?.();
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        global.DATA_ROOT = originalDataRoot;
        fs.rmSync(tempDataRoot, { recursive: true, force: true, maxRetries: 5 });
        contractConfig.cleanup();
    });

    async function postStats(route, body = {}) {
        const res = await fetch(`${baseUrl}/api/stats${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
        return { status: res.status, text, json };
    }

    test('returns empty object for an uninitialized user handle and isolates handles on update', async () => {
        activeHandle = 'isolated-user-a';
        const initial = await postStats('/get');
        expect(initial.status).toBe(200);
        expect(initial.json).toEqual({});

        const updateRes = await postStats('/update', {
            'Alice.png': {
                total_gen_time: 1200,
                user_word_count: 10,
                non_user_word_count: 25,
                user_msg_count: 1,
                non_user_msg_count: 1,
                total_swipe_count: 0,
            },
        });
        expect(updateRes.status).toBe(200);

        const readA = await postStats('/get');
        expect(readA.status).toBe(200);
        expect(readA.json['Alice.png'].user_word_count).toBe(10);
        expect(typeof readA.json.timestamp).toBe('number');

        activeHandle = 'isolated-user-b';
        const readB = await postStats('/get');
        expect(readB.status).toBe(200);
        expect(readB.json).toEqual({});
    });

    test('recreates stats across characters, chats, swipes, deduplicated lines, malformed lines, and timestamp formats', async () => {
        fs.writeFileSync(path.join(activeDirs.characters, 'Alice.png'), Buffer.from('png'));
        fs.writeFileSync(path.join(activeDirs.characters, 'EmptyChar.png'), Buffer.from('png'));
        fs.writeFileSync(path.join(activeDirs.characters, 'notes.txt'), 'not a character');

        const aliceChats = path.join(activeDirs.chats, 'Alice');
        fs.mkdirSync(aliceChats, { recursive: true });

        const chat1Lines = [
            JSON.stringify({ chat_metadata: { note: 'header' } }),
            // Earliest timestamp via ST humanized format with ms
            JSON.stringify({
                is_user: true,
                mes: 'Hello world today',
                send_date: '2024-07-12@01h31m37s123ms',
            }),
            // Assistant reply with swipes + swipe_info
            JSON.stringify({
                is_user: false,
                mes: 'First reply words',
                gen_started: '2024-07-12T01:31:38.000Z',
                gen_finished: '2024-07-12T01:31:40.000Z',
                swipes: ['First reply words', 'Second swipe has four words'],
                swipe_info: [
                    { gen_started: '2024-07-12T01:31:38.000Z', gen_finished: '2024-07-12T01:31:40.000Z' },
                    { gen_started: '2024-07-12T01:31:41.000Z', gen_finished: '2024-07-12T01:31:44.000Z' },
                ],
            }),
            // Assistant reply with swipes and NO swipe_info (estimates genTime * swipes.length in addition to base genTime)
            JSON.stringify({
                is_user: false,
                mes: 'Estimated base',
                gen_started: '2024-07-12T01:32:00.000Z',
                gen_finished: '2024-07-12T01:32:01.000Z',
                swipes: ['Estimated base', 'Alt one'],
            }),
            '{malformed json line that should be skipped}',
        ];
        const chat1Path = path.join(aliceChats, 'chat1.jsonl');
        fs.writeFileSync(chat1Path, chat1Lines.join('\n'), 'utf8');

        const chat2Lines = [
            // Duplicate message text from chat1 -> skipped by SHA-256 deduplication
            JSON.stringify({
                is_user: true,
                mes: 'Hello world today',
                send_date: '2025-01-01T00:00:00.000Z',
            }),
            // Earlier user message with Unix numeric timestamp
            JSON.stringify({
                is_user: true,
                mes: 'Earlier ping',
                send_date: 1700000000000,
            }),
            // Meridiem timestamp format (two-digit month parses cleanly; single-digit months lack zero-padding)
            JSON.stringify({
                is_user: true,
                mes: 'Meridiem check',
                send_date: 'October 19, 2023 2:20pm',
            }),
            // Humanized format with space before @
            JSON.stringify({
                is_user: true,
                mes: 'Spaced humanized check',
                send_date: '2024-6-5 @14h 56m 50s 682ms',
            }),
        ];
        const chat2Path = path.join(aliceChats, 'chat2.jsonl');
        fs.writeFileSync(chat2Path, chat2Lines.join('\n'), 'utf8');

        const recreateRes = await postStats('/recreate');
        expect(recreateRes.status).toBe(200);

        const getRes = await postStats('/get');
        expect(getRes.status).toBe(200);
        expect(getRes.json).not.toHaveProperty('notes.txt');

        const alice = getRes.json['Alice.png'];
        expect(alice).toBeDefined();
        // User messages: 'Hello world today' (3) + 'Earlier ping' (2) + 'Meridiem check' (2) + 'Spaced humanized check' (3) = 10 words, 4 msgs
        expect(alice.user_word_count).toBe(10);
        expect(alice.user_msg_count).toBe(4);
        // Non-user: 'First reply words' (3) + 'Second swipe has four words' (5) + 'Estimated base' (2) + 'Alt one' (2) = 12 words, 4 msgs
        expect(alice.non_user_word_count).toBe(12);
        expect(alice.non_user_msg_count).toBe(4);
        // Swipes: (2 - 1) + (2 - 1) = 2
        expect(alice.total_swipe_count).toBe(2);
        // Gen time: 2000 + 3000 + (1000 + 1000 * 2) = 8000ms
        expect(alice.total_gen_time).toBe(8000);
        // Chat file byte sizes summed
        const expectedSize = fs.statSync(chat1Path).size + fs.statSync(chat2Path).size;
        expect(alice.chat_size).toBe(expectedSize);
        expect(alice.date_last_chat).toBeGreaterThan(0);
        // October 19, 2023 2:20pm is earlier than 1700000000000 (Nov 2023) and 2024 timestamps
        expect(alice.date_first_chat).toBe(new Date('2023-10-19T14:20:00').getTime());

        // Character with no chats folder gets zeroed entry
        const emptyChar = getRes.json['EmptyChar.png'];
        expect(emptyChar).toMatchObject({
            total_gen_time: 0,
            user_word_count: 0,
            non_user_word_count: 0,
            user_msg_count: 0,
            non_user_msg_count: 0,
            total_swipe_count: 0,
            chat_size: 0,
            date_last_chat: 0,
            date_first_chat: new Date('9999-12-31T23:59:59.999Z').getTime(),
        });

        // Persisted to temp stats.json inside isolated user directory
        const statsFilePath = path.join(activeDirs.root, 'stats.json');
        expect(fs.existsSync(statsFilePath)).toBe(true);
        const persisted = JSON.parse(fs.readFileSync(statsFilePath, 'utf8'));
        expect(persisted['Alice.png']).toEqual(alice);
    });

    test('parses ISO 8601, numeric string, short humanized, and invalid send_date timestamps', async () => {
        fs.writeFileSync(path.join(activeDirs.characters, 'Clock.png'), Buffer.from('png'));
        const clockDir = path.join(activeDirs.chats, 'Clock');
        fs.mkdirSync(clockDir, { recursive: true });
        fs.writeFileSync(path.join(clockDir, 'c.jsonl'), [
            JSON.stringify({ is_user: true, mes: 'iso msg', send_date: '2024-03-01T10:00:00.000Z' }),
            JSON.stringify({ is_user: true, mes: 'num str msg', send_date: '1705000000000' }),
            JSON.stringify({ is_user: true, mes: 'short humanized', send_date: '2024-7-12@01h31m37s' }),
        ].join('\n'), 'utf8');

        const res = await postStats('/recreate');
        expect(res.status).toBe(200);
        const stats = (await postStats('/get')).json['Clock.png'];
        // 1705000000000 is Jan 11, 2024 (earliest of the three)
        expect(stats.date_first_chat).toBe(1705000000000);

        // Unparseable send_date returns 0 from parseTimestamp, which becomes the minimum
        fs.writeFileSync(path.join(clockDir, 'c2.jsonl'), JSON.stringify({
            is_user: true,
            mes: 'bad date msg',
            send_date: 'not-a-timestamp',
        }), 'utf8');
        await postStats('/recreate');
        const statsAfterInvalid = (await postStats('/get')).json['Clock.png'];
        expect(statsAfterInvalid.date_first_chat).toBe(0);
    });

    test('persists updated stats on onExit and skips unchanged saves', async () => {
        const statsFilePath = path.join(activeDirs.root, 'stats.json');
        await postStats('/update', { 'Persisted.png': { user_msg_count: 7 } });
        await statsOnExit();

        expect(fs.existsSync(statsFilePath)).toBe(true);
        const saved = JSON.parse(fs.readFileSync(statsFilePath, 'utf8'));
        expect(saved['Persisted.png']).toEqual({ user_msg_count: 7 });

        // Overwrite file externally without bumping timestamp; a second onExit should skip rewriting.
        fs.writeFileSync(statsFilePath, '{"sentinel":true}', 'utf8');
        await statsOnExit();
        expect(JSON.parse(fs.readFileSync(statsFilePath, 'utf8'))).toEqual({ sentinel: true });
    });

    test('init loads valid stats.json and recreates missing or malformed stats.json without leaking timers', async () => {
        const intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(() => /** @type {any} */ ({ unref() {} }));
        try {
            const statsFilePath = path.join(activeDirs.root, 'stats.json');

            // 1. Valid stats.json loaded directly
            fs.writeFileSync(statsFilePath, JSON.stringify({ 'Loaded.png': { user_msg_count: 42 }, timestamp: 12345 }), 'utf8');
            await statsInit();
            expect((await postStats('/get')).json['Loaded.png']).toEqual({ user_msg_count: 42 });

            // 2. Missing stats.json recreated from characters dir
            fs.unlinkSync(statsFilePath);
            fs.writeFileSync(path.join(activeDirs.characters, 'Rebuilt.png'), Buffer.from('png'));
            await statsInit();
            expect((await postStats('/get')).json).toHaveProperty(['Rebuilt.png']);
            expect(fs.existsSync(statsFilePath)).toBe(true);

            // 3. Corrupted JSON stats.json recreated
            fs.writeFileSync(statsFilePath, '{corrupt json', 'utf8');
            await statsInit();
            expect((await postStats('/get')).json).toHaveProperty(['Rebuilt.png']);
            expect(() => JSON.parse(fs.readFileSync(statsFilePath, 'utf8'))).not.toThrow();
        } finally {
            intervalSpy.mockRestore();
        }
    });

    test('returns 500 when characters directory is missing during /recreate', async () => {
        fs.rmSync(activeDirs.characters, { recursive: true, force: true });
        const res = await postStats('/recreate');
        expect(res.status).toBe(500);

        await expect(recreateStats(DEFAULT_HANDLE, activeDirs.chats, activeDirs.characters)).rejects.toThrow();
    });
});
