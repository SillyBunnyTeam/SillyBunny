import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_USER } from '../src/constants.js';
import { readReply, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer();

// A sync checks the default content of the account, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

const sourceRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-extension-swap-'));
const targetExtension = () => path.join(harness.userRoot(DEFAULT_USER.handle), 'extensions', 'sample');
const realRename = fs.promises.rename;

let admin;

function writeTree(root, files) {
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function leftoverSyncFolders() {
    return fs.readdirSync(path.dirname(targetExtension())).filter(name => name.includes('-sync-'));
}

async function syncWithRenames(configure) {
    const rename = jest.spyOn(fs.promises, 'rename');
    configure(rename);
    try {
        return await readReply(await admin.post('/api/users/import-sillytavern/extensions', { sourcePath: sourceRoot }));
    } finally {
        rename.mockRestore();
    }
}

beforeEach(async () => {
    await harness.reset();
    fs.rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 5 });
    writeTree(sourceRoot, {
        'settings.json': '{}',
        'extensions/sample/manifest.json': JSON.stringify({ js: 'index.js' }),
        'extensions/sample/index.js': 'export const version = "new";',
    });
    writeTree(targetExtension(), { 'manifest.json': JSON.stringify({ js: 'index.js' }), 'index.js': 'export const version = "old";' });
    admin = await harness.loginAs(DEFAULT_USER);
});

afterAll(async () => {
    await harness.close();
    fs.rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe('POST /api/users/import-sillytavern/extensions', () => {
    test('keeps the existing extension when the first rename of the sync fails', async () => {
        const reply = await syncWithRenames(rename => rename.mockRejectedValueOnce(new Error('rename failure')));

        expect(reply.status).toBe(200);
        expect(reply.body.results[0]).toMatchObject({ name: 'sample', status: 'failed', error: 'rename failure' });
        expect(fs.readFileSync(path.join(targetExtension(), 'index.js'), 'utf8')).toBe('export const version = "old";');
        expect(leftoverSyncFolders()).toEqual([]);
    });

    test('puts the existing extension back when the synced copy cannot be moved into place', async () => {
        const reply = await syncWithRenames(rename => rename
            .mockImplementationOnce((...args) => realRename(...args))
            .mockRejectedValueOnce(new Error('rename failure')));

        expect(reply.status).toBe(200);
        expect(reply.body.results[0]).toMatchObject({ name: 'sample', status: 'failed', error: 'rename failure' });
        expect(fs.readFileSync(path.join(targetExtension(), 'index.js'), 'utf8')).toBe('export const version = "old";');
        expect(leftoverSyncFolders()).toEqual([]);
    });
});
