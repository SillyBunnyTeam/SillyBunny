import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import yauzl from 'yauzl';

import { DEFAULT_USER, USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { OPEN_MEMBER, readReply, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer();

// An import copies the default content into the account, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

const CONVERSATION_ID = 'conv_1700000000000_a1b2c3d4e5';
const FILES = {
    [`conversations/${CONVERSATION_ID}/conversation.json`]: '{"version":1}',
    [`conversations/${CONVERSATION_ID}/chats/main.jsonl`]: '{"chat_metadata":{}}',
    'conversations/characters.json': '{"version":1}',
    // The folders of the persona and the conversations filed in them; they are in `conversations/`, so they travel with it.
    'conversations/folders.json': '{"version":1,"personas":{"user-default.png":{"folders":[{"id":"fld_1764000000000_a1b2c3d4e5f6","name":"Work","color":"","expanded":true}],"members":{"conv_1700000000000_a1b2c3d4e5":"fld_1764000000000_a1b2c3d4e5f6"}}}}',
    // The marker that says the migration ran, and that the browser storage was imported. It must travel with the folders.
    'conversations/migration-done.json': '{"version":1,"migratedAt":1700000000000,"backupFile":"","localStorageImported":true}',
};

function writeUserFiles(handle, files) {
    const root = harness.userRoot(handle);
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function readZipEntries(buffer) {
    return new Promise((resolve, reject) => {
        const entries = new Map();
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipfile) => {
            if (openError) {
                reject(openError);
                return;
            }
            zipfile.on('error', reject);
            zipfile.on('end', () => resolve(entries));
            zipfile.on('entry', entry => {
                zipfile.openReadStream(entry, (streamError, stream) => {
                    if (streamError) {
                        reject(streamError);
                        return;
                    }
                    const chunks = [];
                    stream.on('data', chunk => chunks.push(chunk));
                    stream.on('end', () => {
                        entries.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
                        zipfile.readEntry();
                    });
                });
            });
            zipfile.readEntry();
        });
    });
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

beforeEach(() => harness.reset());

afterAll(() => harness.close());

describe('the conversations folder of a user', () => {
    test('is a directory of the user template', () => {
        expect(USER_DIRECTORY_TEMPLATE.conversations).toBe('conversations');
        expect(harness.users.getUserDirectories(OPEN_MEMBER.handle).conversations)
            .toBe(path.join(harness.userRoot(OPEN_MEMBER.handle), 'conversations'));
    });

    test('is created for every user at startup', async () => {
        await harness.users.ensurePublicDirectoriesExist();

        for (const handle of [OPEN_MEMBER.handle, DEFAULT_USER.handle]) {
            expect(fs.statSync(path.join(harness.userRoot(handle), 'conversations')).isDirectory()).toBe(true);
        }
    });

    test('is part of the account backup ZIP, with the chats, the character file and the migration marker', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        writeUserFiles(OPEN_MEMBER.handle, { 'settings.json': '{}', ...FILES });

        const response = await client.post('/api/users/backup', { handle: OPEN_MEMBER.handle });
        const entries = await readZipEntries(Buffer.from(await response.arrayBuffer()));

        expect(response.status).toBe(200);
        for (const [name, content] of Object.entries(FILES)) {
            expect(entries.get(name)).toBe(content);
        }
    });

    test('is imported from a backup ZIP, and a folder next to it that is not user data is not', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);
        const zip = await createZip({
            'backup/default-user/settings.json': '{"imported":true}',
            ...Object.fromEntries(Object.entries(FILES).map(([name, content]) => [`backup/default-user/${name}`, content])),
            'backup/default-user/not-account-data/file.txt': 'x',
        });

        const { status } = await readReply(await admin.upload('/api/users/import-sillytavern/zip', 'backup.zip', zip));

        expect(status).toBe(200);
        const root = harness.userRoot(DEFAULT_USER.handle);
        for (const [name, content] of Object.entries(FILES)) {
            expect(fs.readFileSync(path.join(root, ...name.split('/')), 'utf8')).toBe(content);
        }
        expect(fs.existsSync(path.join(root, 'not-account-data'))).toBe(false);
    });

    test('is imported from a SillyTavern app folder that has one', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);
        const source = path.join(harness.dataRoot, 'st-source');
        for (const [name, content] of Object.entries({ 'settings.json': '{}', ...FILES })) {
            const filePath = path.join(source, 'data', 'default-user', ...name.split('/'));
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content);
        }

        const { status } = await readReply(await admin.post('/api/users/import-sillytavern/folder', { sourcePath: source }));

        expect(status).toBe(200);
        const root = harness.userRoot(DEFAULT_USER.handle);
        for (const [name, content] of Object.entries(FILES)) {
            expect(fs.readFileSync(path.join(root, ...name.split('/')), 'utf8')).toBe(content);
        }
    });

    test('is removed with the account when the data is purged, and stays with it when it is not', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);
        writeUserFiles(OPEN_MEMBER.handle, FILES);
        writeUserFiles('member-user', FILES);

        expect((await admin.post('/api/users/delete', { handle: 'member-user' })).status).toBe(204);
        expect(fs.existsSync(path.join(harness.userRoot('member-user'), 'conversations'))).toBe(true);

        expect((await admin.post('/api/users/delete', { handle: OPEN_MEMBER.handle, purge: true })).status).toBe(204);
        expect(fs.existsSync(harness.userRoot(OPEN_MEMBER.handle))).toBe(false);
    });
});
