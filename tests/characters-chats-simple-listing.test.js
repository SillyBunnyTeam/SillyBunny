import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { router: charactersRouter } = await import('../src/endpoints/characters.js');

const HEADER = JSON.stringify({ chat_metadata: {}, user_name: 'User', character_name: 'Alice' });

function message(text, sendDate) {
    return JSON.stringify({ name: 'Alice', mes: text, ...(sendDate ? { send_date: sendDate } : {}) });
}

describe('POST /api/characters/chats with simple: true', () => {
    let baseUrl;
    let chatsDirectory;
    let server;
    let tempRoot;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'simple-listing-test-user' },
                directories: {
                    backups: path.join(tempRoot, 'backups'),
                    chats: path.join(tempRoot, 'chats'),
                    characters: path.join(tempRoot, 'characters'),
                },
            };
            next();
        });
        app.use('/api/characters', charactersRouter);
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-simple-listing-'));
        chatsDirectory = path.join(tempRoot, 'chats', 'Alice');
        fs.mkdirSync(chatsDirectory, { recursive: true });
        fs.mkdirSync(path.join(tempRoot, 'backups'), { recursive: true });
        fs.mkdirSync(path.join(tempRoot, 'characters'), { recursive: true });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    function writeChat(name, content, mtimeSeconds) {
        const file = path.join(chatsDirectory, `${name}.jsonl`);
        fs.writeFileSync(file, content);
        fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
    }

    async function list(body) {
        const response = await fetch(`${baseUrl}/api/characters/chats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: 'Alice.png', ...body }),
        });
        expect(response.status).toBe(200);
        return response.json();
    }

    test('gives the date of the last message, not the modification time, so that clients find the newest chat', async () => {
        writeChat('Oldest by date', `${HEADER}\n${message('a', '2026-01-01T10:00:00.000Z')}\n`, 3_000_000_000);
        writeChat('Newest by date', `${HEADER}\n${message('a', '2026-03-01T10:00:00.000Z')}\n`, 1_000_000_000);
        writeChat('Middle by date', `${HEADER}\n${message('a', '2026-02-01T10:00:00.000Z')}\n`, 2_000_000_000);

        const simple = await list({ simple: true });
        const byName = Object.fromEntries(simple.map(chat => [chat.file_name, chat.last_mes]));

        expect(byName).toEqual({
            'Oldest by date.jsonl': '2026-01-01T10:00:00.000Z',
            'Newest by date.jsonl': '2026-03-01T10:00:00.000Z',
            'Middle by date.jsonl': '2026-02-01T10:00:00.000Z',
        });
    });

    test('gives the same last_mes as the full listing for every shape of chat file', async () => {
        const longText = 'long message '.repeat(20_000);
        const header = (extra = '') => `${HEADER}${extra}`;
        const shapes = {
            'dated message': `${header()}\n${message('a', '2026-01-01T10:00:00.000Z')}\n`,
            'message with a date in the app format': `${header()}\n${message('a', 'June 4, 2026 9:15pm')}\n`,
            'message without a date': `${header()}\n${message('a')}\n`,
            'no trailing line break': `${header()}\n${message('a', '2026-01-02T10:00:00.000Z')}`,
            'CRLF line breaks': `${header()}\r\n${message('a', '2026-01-03T10:00:00.000Z')}\r\n`,
            'blank line at the end': `${header()}\n${message('a', '2026-01-04T10:00:00.000Z')}\n\n`,
            'header only': `${header()}\n`,
            'empty file': '',
            'corrupt last line': `${header()}\n${message('a', '2026-01-05T10:00:00.000Z')}\n{"name":"Alice","mes":\n`,
            'last line that is not a message': `${header()}\n${message('a', '2026-01-06T10:00:00.000Z')}\n{"other":1}\n`,
            'last line above the read chunk': `${header()}\n${message(longText, '2026-01-07T10:00:00.000Z')}\n`,
            'multi-byte text in the last line': `${header()}\n${message('日本語 🐇 café', '2026-01-08T10:00:00.000Z')}\n`,
            'one line only': message('a', '2026-01-09T10:00:00.000Z'),
        };
        let mtime = 1_700_000_000;
        for (const [name, content] of Object.entries(shapes)) {
            writeChat(name, content, mtime);
            mtime += 7_777;
        }
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const full = await list({});
        const simple = await list({ simple: true });
        consoleWarn.mockRestore();

        const lastMesOf = listing => Object.fromEntries(listing.map(chat => [chat.file_name, chat.last_mes]));
        expect(Object.keys(lastMesOf(simple)).sort()).toEqual(Object.keys(lastMesOf(full)).sort());
        expect(lastMesOf(simple)).toEqual(lastMesOf(full));
    });

    test('does not read a last line above 8 MiB and gives the modification time instead', async () => {
        const hugeText = 'x'.repeat(9 * 1024 * 1024);
        writeChat('Huge last line', `${HEADER}\n${message(hugeText, '2026-01-01T10:00:00.000Z')}\n`, 1_700_000_000);

        const simple = await list({ simple: true });

        expect(simple).toEqual([{ file_name: 'Huge last line.jsonl', file_id: 'Huge last line', last_mes: 1_700_000_000_000 }]);
    });

    test('keeps the names, the file ids and the recoverable target of the full listing', async () => {
        writeChat('Existing', `${HEADER}\n${message('a', '2026-01-01T10:00:00.000Z')}\n`, 1_700_000_000);

        const simple = await list({ simple: true });

        expect(simple).toEqual([{ file_name: 'Existing.jsonl', file_id: 'Existing', last_mes: '2026-01-01T10:00:00.000Z' }]);
    });
});
