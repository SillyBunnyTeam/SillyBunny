import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';

import { DEFAULT_USER } from '../src/constants.js';
import { ADMIN, MEMBER, OPEN_MEMBER, readReply, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer();

// A successful import copies the default content into the account, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

const outsideRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-import-guards-'));
const FORBIDDEN = { status: 403, body: 'Forbidden' };
const SOURCE_FILES = {
    'settings.json': '{"owner":"source"}',
    'secrets.json': '{"api_key_openai":"source-key"}',
    'chats/Ada/private.jsonl': '{"private":true}',
    'extensions/source-extension/manifest.json': '{"js":"index.js"}',
    'extensions/source-extension/index.js': 'export {};',
};

let nextFolder = 1;
let member;
let admin;

function writeTree(root, files) {
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function outsideSource() {
    const folder = path.join(outsideRoot, `source-${nextFolder++}`);
    writeTree(folder, SOURCE_FILES);
    return folder;
}

function accountFile(account, ...segments) {
    return path.join(harness.userRoot(account.handle), ...segments);
}

function expectNothingImportedInto(account) {
    expect(fs.existsSync(accountFile(account, 'secrets.json'))).toBe(false);
    expect(fs.existsSync(accountFile(account, 'chats', 'Ada', 'private.jsonl'))).toBe(false);
    expect(fs.existsSync(accountFile(account, 'extensions', 'source-extension'))).toBe(false);
}

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

beforeEach(async () => {
    await harness.reset();
    writeTree(harness.userRoot(ADMIN.handle), SOURCE_FILES);
    writeTree(harness.userRoot(MEMBER.handle), SOURCE_FILES);
    member = await harness.loginAs(OPEN_MEMBER);
    admin = await harness.loginAs(DEFAULT_USER);
});

afterAll(async () => {
    await harness.close();
    fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5 });
});

const MEMBER_SOURCES = [
    ['a folder outside the data root', () => outsideSource()],
    ['its own folder', () => harness.userRoot(OPEN_MEMBER.handle)],
    ['the folder of another account', () => harness.userRoot(ADMIN.handle)],
    ['the data root', () => harness.dataRoot],
    ['no path', () => undefined],
];

describe.each([
    ['/api/users/import-sillytavern/folder'],
    ['/api/users/import-sillytavern/extensions'],
])('POST %s', route => {
    test.each(MEMBER_SOURCES)('answers 403 to a member for %s, and imports nothing', async (_title, sourcePath) => {
        const reply = await readReply(await member.post(route, { sourcePath: sourcePath() }));

        expect(reply).toEqual(FORBIDDEN);
        expectNothingImportedInto(OPEN_MEMBER);
    });
});

describe('server folder imports by an admin', () => {
    test('an admin imports a folder from outside the data root', async () => {
        const reply = await readReply(await admin.post('/api/users/import-sillytavern/folder', { sourcePath: outsideSource() }));

        expect(reply.status).toBe(200);
        expect(fs.readFileSync(accountFile(DEFAULT_USER, 'secrets.json'), 'utf8')).toBe(SOURCE_FILES['secrets.json']);
        expect(fs.readFileSync(accountFile(DEFAULT_USER, 'chats', 'Ada', 'private.jsonl'), 'utf8')).toBe(SOURCE_FILES['chats/Ada/private.jsonl']);
    });

    test('an admin imports the folder of another account', async () => {
        const reply = await readReply(await admin.post('/api/users/import-sillytavern/folder', { sourcePath: harness.userRoot(MEMBER.handle) }));

        expect(reply.status).toBe(200);
        expect(fs.readFileSync(accountFile(DEFAULT_USER, 'settings.json'), 'utf8')).toBe(SOURCE_FILES['settings.json']);
    });

    test('an admin syncs the extensions of a folder outside the data root', async () => {
        const reply = await readReply(await admin.post('/api/users/import-sillytavern/extensions', { sourcePath: outsideSource() }));

        expect(reply.status).toBe(200);
        expect(reply.body.readyCount).toBe(1);
        expect(fs.readFileSync(accountFile(DEFAULT_USER, 'extensions', 'source-extension', 'index.js'), 'utf8')).toBe('export {};');
    });
});

describe('POST /api/users/import-sillytavern/zip', () => {
    test('a member still imports a backup ZIP', async () => {
        const zip = await createZip({ 'settings.json': '{"owner":"zip"}', 'chats/Ada/first.jsonl': '{}' });

        const reply = await readReply(await member.upload('/api/users/import-sillytavern/zip', 'backup.zip', zip));

        expect(reply.status).toBe(200);
        expect(fs.readFileSync(accountFile(OPEN_MEMBER, 'settings.json'), 'utf8')).toBe('{"owner":"zip"}');
        expect(fs.readFileSync(accountFile(OPEN_MEMBER, 'chats', 'Ada', 'first.jsonl'), 'utf8')).toBe('{}');
    });
});
