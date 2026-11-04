import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';

import { OPEN_MEMBER, readReply, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer();

// A successful import copies the default content into the account, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

const FAILED = 'Failed to import that SillyTavern backup ZIP.';
const SETTINGS = { 'settings.json': '{"owner":"zip"}' };
const CHAT = 'chats/Probe/chat.jsonl';

let member;
// The harness keeps its console mocks for the whole file, so the tests restore only their own spies.
const spies = [];

function createZip(entries) {
    return new Promise((resolve, reject) => {
        const archive = archiver('zip');
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        archive.on('error', reject);
        for (const [name, content] of Object.entries(entries)) {
            archive.append(content, { name });
        }
        archive.finalize();
    });
}

async function importZip(zip) {
    return await readReply(await member.upload('/api/users/import-sillytavern/zip', 'backup.zip', zip));
}

function memberFile(relativePath) {
    return path.join(harness.userRoot(OPEN_MEMBER.handle), ...relativePath.split('/'));
}

beforeEach(async () => {
    await harness.reset();
    member = await harness.loginAs(OPEN_MEMBER);
});

afterEach(() => {
    for (const spy of spies.splice(0)) {
        spy.mockRestore();
    }
});

afterAll(() => harness.close());

describe('POST /api/users/import-sillytavern/zip, entry names', () => {
    test.each([
        ['a NUL character', 'characters/a\u0000b.png'],
        ['a colon in a folder name', 'user/images:x/a.png'],
        ['a colon in a file name', 'characters/a.png:stream'],
        ['a character that Windows refuses', 'characters/what?.png'],
        ['a reserved device name', 'characters/CON.png'],
        ['a reserved device name as a folder', 'characters/nul/a.png'],
        ['a file name that ends with a dot', 'characters/trail.png.'],
        ['a folder name that ends with a space', 'characters/folder /a.png'],
    ])('answers 400 to an entry name with %s, and writes nothing', async (_title, name) => {
        const reply = await importZip(await createZip({ ...SETTINGS, [name]: 'x' }));

        expect(reply).toEqual({ status: 400, body: { error: FAILED } });
        expect(fs.existsSync(memberFile('settings.json'))).toBe(false);
    });

    test('imports names with spaces, accents and inner dots', async () => {
        const entries = {
            ...SETTINGS,
            'chats/Ada Lovelace/Ada Lovelace - 2024-11-05 @12h 30m 15s.jsonl': '{}',
            'characters/Émile.png': 'card',
            'user/images/Ada/picture.v2.png': 'image',
        };

        const reply = await importZip(await createZip(entries));

        expect(reply).toMatchObject({ status: 200, body: { importedFiles: 4 } });
        for (const [name, content] of Object.entries(entries)) {
            expect(fs.readFileSync(memberFile(name), 'utf8')).toBe(content);
        }
    });
});

describe('POST /api/users/import-sillytavern/zip, failures', () => {
    test('answers, and keeps answering, when opening a file throws', async () => {
        const createWriteStream = fs.createWriteStream;
        spies.push(jest.spyOn(fs, 'createWriteStream').mockImplementation((target, ...args) => {
            if (String(target).endsWith('chat.jsonl')) {
                throw Object.assign(new TypeError('The argument \'path\' is not valid.'), { code: 'ERR_INVALID_ARG_VALUE' });
            }
            return createWriteStream(target, ...args);
        }));

        const reply = await importZip(await createZip({ ...SETTINGS, [CHAT]: '{}' }));
        const next = await readReply(await member.get('/api/users/me'));

        expect(reply.status).toBe(400);
        expect(next.status).toBe(200);
    });
});
