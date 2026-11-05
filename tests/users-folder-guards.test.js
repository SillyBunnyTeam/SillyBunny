import { afterAll, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import storage from 'node-persist';

import { DEFAULT_USER } from '../src/constants.js';
import { OPEN_MEMBER, readReply, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer();

// Without the guards, a purge removes the folder that a handle names. This handle names only a temp folder of this file.
const outsideFolder = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-folder-guards-'));
const outsideFile = path.join(outsideFolder, 'keep.txt');
const OUTSIDE_HANDLE = path.relative(harness.dataRoot, outsideFolder).split(path.sep).join('/');
if (path.resolve(harness.dataRoot, OUTSIDE_HANDLE) !== outsideFolder) {
    await harness.close();
    fs.rmSync(outsideFolder, { recursive: true, force: true, maxRetries: 5 });
    throw new Error(`The handle ${OUTSIDE_HANDLE} does not name ${outsideFolder}, so these tests do not run.`);
}

async function storeAccount(handle) {
    await storage.setItem(harness.users.toKey(handle), { handle, name: handle, created: Date.now(), password: '', salt: '', admin: false, enabled: true });
}

function writeMemberFile() {
    const filePath = path.join(harness.userRoot(OPEN_MEMBER.handle), 'settings.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"member":true}');
    return filePath;
}

let admin;

beforeEach(async () => {
    await harness.reset();
    fs.mkdirSync(outsideFolder, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep');
    admin = await harness.loginAs(DEFAULT_USER);
});

afterAll(async () => {
    await harness.close();
    fs.rmSync(outsideFolder, { recursive: true, force: true, maxRetries: 5 });
});

describe('POST /api/users/backup', () => {
    test('answers 404 to an admin that names a handle that is not an account', async () => {
        const reply = await readReply(await admin.post('/api/users/backup', { handle: 'no-such-user' }));

        expect(reply).toEqual({ status: 404, body: { error: 'User not found' } });
    });

    test('answers 404 to an admin that names a folder next to the data root', async () => {
        const reply = await readReply(await admin.post('/api/users/backup', { handle: OUTSIDE_HANDLE }));

        expect(reply).toEqual({ status: 404, body: { error: 'User not found' } });
    });

    test.each([
        ['a folder next to the data root', OUTSIDE_HANDLE],
        ['the data root itself', '.'],
    ])('answers 400 when a stored account names %s', async (_title, handle) => {
        await storeAccount(handle);
        writeMemberFile();

        const reply = await readReply(await admin.post('/api/users/backup', { handle }));

        expect(reply).toEqual({ status: 400, body: { error: 'Invalid handle' } });
    });
});

describe('POST /api/users/delete', () => {
    test('answers 404 for a handle that is not an account', async () => {
        const reply = await readReply(await admin.post('/api/users/delete', { handle: 'no-such-user' }));

        expect(reply).toEqual({ status: 404, body: { error: 'User not found' } });
    });

    test('with purge, answers 404 for a folder next to the data root and keeps that folder', async () => {
        const reply = await readReply(await admin.post('/api/users/delete', { handle: OUTSIDE_HANDLE, purge: true }));

        expect(reply).toEqual({ status: 404, body: { error: 'User not found' } });
        expect(fs.readFileSync(outsideFile, 'utf8')).toBe('keep');
    });

    test('with purge, answers 400 and keeps the account and the folder when a stored account names a folder next to the data root', async () => {
        await storeAccount(OUTSIDE_HANDLE);

        const reply = await readReply(await admin.post('/api/users/delete', { handle: OUTSIDE_HANDLE, purge: true }));

        expect(reply).toEqual({ status: 400, body: { error: 'Invalid handle' } });
        expect(fs.readFileSync(outsideFile, 'utf8')).toBe('keep');
        expect(await harness.account(OUTSIDE_HANDLE)).toBeDefined();
    });

    // Keep this test last: without the guard it removes the data root of this file.
    test('with purge, answers 400 and keeps the data root when a stored account names the data root itself', async () => {
        await storeAccount('.');
        const memberFile = writeMemberFile();

        const reply = await readReply(await admin.post('/api/users/delete', { handle: '.', purge: true }));

        expect(reply).toEqual({ status: 400, body: { error: 'Invalid handle' } });
        expect(fs.readFileSync(memberFile, 'utf8')).toBe('{"member":true}');
        expect(await harness.account('.')).toBeDefined();
    });
});
