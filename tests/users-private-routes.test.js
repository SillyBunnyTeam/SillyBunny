import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import storage from 'node-persist';
import yauzl from 'yauzl';

import { DEFAULT_USER } from '../src/constants.js';
import { keyToEnv } from '../src/util.js';
import { ADMIN, MEMBER, OPEN_MEMBER, lastLoggedCode, readReply, startAccountServer } from './util/user-account-harness.js';

// The limiters keep their counts in module state and every test here shares one client address, so a limit of 0 turns them off in this file.
const harness = await startAccountServer({
    config: {
        'rateLimiting.accountsLoginMaxAttempts': 0,
        'rateLimiting.accountsResetMaxAttempts': 0,
    },
});

// An account reset copies the default content again, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

const PRIVATE_ROUTES = [
    ['POST', '/logout'],
    ['GET', '/me'],
    ['POST', '/change-avatar'],
    ['POST', '/change-password'],
    ['POST', '/backup'],
    ['POST', '/import-sillytavern/folder'],
    ['POST', '/import-sillytavern/extensions'],
    ['POST', '/import-sillytavern/zip'],
    ['POST', '/reset-settings'],
    ['POST', '/change-name'],
    ['POST', '/reset-step1'],
    ['POST', '/reset-step2'],
];
const CODE_LIFETIME_MS = 5 * 60 * 1000;
const DEFAULT_SETTINGS_PATH = fileURLToPath(new URL('../default/content/settings.json', import.meta.url));
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function writeUserFiles(handle, files) {
    const root = harness.userRoot(handle);
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function readUserJson(handle, relativePath) {
    return JSON.parse(fs.readFileSync(path.join(harness.userRoot(handle), relativePath), 'utf8'));
}

function readDefaultSettings() {
    return JSON.parse(fs.readFileSync(DEFAULT_SETTINGS_PATH, 'utf8'));
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

beforeEach(() => harness.reset());

afterAll(() => harness.close());

describe('session checks in front of the private routes', () => {
    test.each(PRIVATE_ROUTES)('%s %s answers 403 without a session', async (method, route) => {
        const response = await harness.client().request(method, `/api/users${route}`);

        expect(response.status).toBe(403);
    });

    test('a session with a stale version gets 403 and loses its cookie', async () => {
        const member = await harness.loginAs(MEMBER);
        const admin = await harness.loginAs(DEFAULT_USER);
        await admin.post('/api/users/change-password', { handle: MEMBER.handle, newPassword: 'changed-secret' });

        const response = await member.get('/api/users/me');

        expect(response.status).toBe(403);
        expect(response.headers.getSetCookie().join()).toMatch(/expires=Thu, 01 Jan 1970/i);
        expect(member.hasSession).toBe(false);
    });

    test('a session cookie with a wrong signature gets 403', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        client.useTamperedSession({ handle: DEFAULT_USER.handle });

        const response = await client.get('/api/users/me');

        expect(response.status).toBe(403);
    });

    test('a session of a removed account gets 403', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        await storage.removeItem(harness.users.toKey(OPEN_MEMBER.handle));

        const response = await client.get('/api/users/me');

        expect(response.status).toBe(403);
    });
});

describe('POST /api/users/logout', () => {
    test('ends the session', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const logout = await client.post('/api/users/logout');
        const me = await client.get('/api/users/me');

        expect(logout.status).toBe(204);
        expect(client.hasSession).toBe(false);
        expect(me.status).toBe(403);
    });
});

describe('GET /api/users/me', () => {
    test('describes the current account without password data', async () => {
        const client = await harness.loginAs(MEMBER);

        const reply = await readReply(await client.get('/api/users/me'));

        expect(reply).toEqual({
            status: 200,
            body: {
                handle: MEMBER.handle,
                name: MEMBER.name,
                avatar: '/img/default-user.png',
                admin: false,
                password: true,
                created: MEMBER.created,
            },
        });
    });
});

describe('POST /api/users/change-avatar', () => {
    test('stores a data URL for the current account', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const response = await client.post('/api/users/change-avatar', { handle: OPEN_MEMBER.handle, avatar: PNG_DATA_URL });
        const me = await readReply(await client.get('/api/users/me'));

        expect(response.status).toBe(204);
        expect(me.body.avatar).toBe(PNG_DATA_URL);
    });

    test('clears the avatar with an empty string', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        await client.post('/api/users/change-avatar', { handle: OPEN_MEMBER.handle, avatar: PNG_DATA_URL });

        const response = await client.post('/api/users/change-avatar', { handle: OPEN_MEMBER.handle, avatar: '' });
        const me = await readReply(await client.get('/api/users/me'));

        expect(response.status).toBe(204);
        expect(me.body.avatar).toBe('/img/default-user.png');
    });

    test('lets an admin change the avatar of another account', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const response = await admin.post('/api/users/change-avatar', { handle: OPEN_MEMBER.handle, avatar: PNG_DATA_URL });

        expect(response.status).toBe(204);
        expect(await storage.getItem(harness.users.toAvatarKey(OPEN_MEMBER.handle))).toBe(PNG_DATA_URL);
    });

    test('answers 400 for a value that is not an image data URL', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/change-avatar', { handle: OPEN_MEMBER.handle, avatar: 'https://example.com/a.png' }));

        expect(reply).toEqual({ status: 400, body: { error: 'Invalid data URL' } });
        expect(await storage.getItem(harness.users.toAvatarKey(OPEN_MEMBER.handle))).toBeUndefined();
    });

    test('answers 400 without a handle', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/change-avatar', { avatar: PNG_DATA_URL }));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('answers 403 to a non-admin who names another account', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/change-avatar', { handle: MEMBER.handle, avatar: PNG_DATA_URL }));

        expect(reply).toEqual({ status: 403, body: { error: 'Unauthorized' } });
        expect(await storage.getItem(harness.users.toAvatarKey(MEMBER.handle))).toBeUndefined();
    });

    test('answers 404 for an unknown user', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const reply = await readReply(await admin.post('/api/users/change-avatar', { handle: 'no-such-user', avatar: PNG_DATA_URL }));

        expect(reply).toEqual({ status: 404, body: { error: 'User not found' } });
    });
});

describe('POST /api/users/change-password', () => {
    test('needs the old password, then replaces it and keeps the session of this client', async () => {
        const client = await harness.loginAs(MEMBER);

        const response = await client.post('/api/users/change-password', {
            handle: MEMBER.handle,
            oldPassword: MEMBER.password,
            newPassword: 'changed-secret',
        });

        expect(response.status).toBe(204);
        expect((await client.get('/api/users/me')).status).toBe(200);
        expect((await harness.client().login(MEMBER.handle, 'changed-secret')).status).toBe(200);
        expect((await harness.client().login(MEMBER.handle, MEMBER.password)).status).toBe(403);
    });

    test('ends the other sessions of the account', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const other = await harness.loginAs(OPEN_MEMBER);

        await client.post('/api/users/change-password', { handle: OPEN_MEMBER.handle, newPassword: 'changed-secret' });

        expect((await other.get('/api/users/me')).status).toBe(403);
    });

    test('refuses a wrong old password and keeps the password', async () => {
        const client = await harness.loginAs(MEMBER);
        const before = await harness.account(MEMBER.handle);

        const reply = await readReply(await client.post('/api/users/change-password', {
            handle: MEMBER.handle,
            oldPassword: 'wrong-secret',
            newPassword: 'changed-secret',
        }));

        expect(reply).toEqual({ status: 403, body: { error: 'Incorrect password' } });
        expect(await harness.account(MEMBER.handle)).toEqual(before);
    });

    test('clears the password when no new password is given', async () => {
        const client = await harness.loginAs(MEMBER);

        const response = await client.post('/api/users/change-password', { handle: MEMBER.handle, oldPassword: MEMBER.password });

        expect(response.status).toBe(204);
        expect(await harness.account(MEMBER.handle)).toMatchObject({ password: '', salt: '' });
        expect((await client.get('/api/users/me')).status).toBe(200);
    });

    test('lets an admin replace the password of another account without the old one', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const response = await admin.post('/api/users/change-password', { handle: MEMBER.handle, newPassword: 'changed-secret' });

        expect(response.status).toBe(204);
        expect((await harness.client().login(MEMBER.handle, 'changed-secret')).status).toBe(200);
        expect((await admin.get('/api/users/me')).status).toBe(200);
    });

    test('answers 400 without a handle', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/change-password', { newPassword: 'changed-secret' }));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('answers 403 to a non-admin who names another account', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const before = await harness.account(MEMBER.handle);

        const reply = await readReply(await client.post('/api/users/change-password', {
            handle: MEMBER.handle,
            oldPassword: MEMBER.password,
            newPassword: 'changed-secret',
        }));

        expect(reply).toEqual({ status: 403, body: { error: 'Unauthorized' } });
        expect(await harness.account(MEMBER.handle)).toEqual(before);
    });

    test('answers 404 for an unknown user', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const reply = await readReply(await admin.post('/api/users/change-password', { handle: 'no-such-user', newPassword: 'changed-secret' }));

        expect(reply).toEqual({ status: 404, body: { error: 'User not found' } });
    });

    test('answers 403 for a disabled user', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);
        await admin.post('/api/users/disable', { handle: OPEN_MEMBER.handle });

        const reply = await readReply(await admin.post('/api/users/change-password', { handle: OPEN_MEMBER.handle, newPassword: 'changed-secret' }));

        expect(reply).toEqual({ status: 403, body: { error: 'User is disabled' } });
    });
});

describe('POST /api/users/backup', () => {
    const allowBackupKey = keyToEnv('backups.allowFullDataBackup');

    afterEach(() => {
        delete process.env[allowBackupKey];
    });

    test('streams a ZIP of the account folder, hidden files included and secrets left out', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        writeUserFiles(OPEN_MEMBER.handle, {
            'settings.json': '{"name":"open"}',
            'chats/Ada/first.jsonl': '{}',
            '.hidden-file': 'hidden',
            'secrets.json': '{"api_key":"synthetic"}',
            'backups/secrets_migration_1.json': '{"api_key":"synthetic"}',
        });

        const response = await client.post('/api/users/backup', { handle: OPEN_MEMBER.handle });
        const entries = await readZipEntries(Buffer.from(await response.arrayBuffer()));

        expect(response.status).toBe(200);
        expect(response.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="${OPEN_MEMBER.handle}-.+\\.zip"$`));
        expect(entries.get('settings.json')).toBe('{"name":"open"}');
        expect(entries.get('chats/Ada/first.jsonl')).toBe('{}');
        expect(entries.get('.hidden-file')).toBe('hidden');
        expect(entries.has('secrets.json')).toBe(false);
        expect(entries.has('backups/secrets_migration_1.json')).toBe(false);
    });

    test('lets an admin back up another account', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);
        writeUserFiles(OPEN_MEMBER.handle, { 'settings.json': '{"name":"open"}' });

        const response = await admin.post('/api/users/backup', { handle: OPEN_MEMBER.handle });
        const entries = await readZipEntries(Buffer.from(await response.arrayBuffer()));

        expect(response.status).toBe(200);
        expect(entries.get('settings.json')).toBe('{"name":"open"}');
    });

    test('answers 403 to a non-admin who names another account', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/backup', { handle: MEMBER.handle }));

        expect(reply).toEqual({ status: 403, body: { error: 'Unauthorized' } });
    });

    test('answers 400 without a handle', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/backup', {}));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('answers 403 when backups.allowFullDataBackup is off', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        process.env[allowBackupKey] = 'false';

        const reply = await readReply(await client.post('/api/users/backup', { handle: OPEN_MEMBER.handle }));

        expect(reply).toEqual({ status: 403, body: { error: 'Full data backup is disabled' } });
    });
});

describe('POST /api/users/reset-settings', () => {
    test('restores the default settings when the password is correct', async () => {
        const client = await harness.loginAs(MEMBER);
        writeUserFiles(MEMBER.handle, { 'settings.json': '{"custom":true}' });

        const response = await client.post('/api/users/reset-settings', { password: MEMBER.password });

        expect(response.status).toBe(204);
        expect(readUserJson(MEMBER.handle, 'settings.json')).toEqual(readDefaultSettings());
    });

    test('restores the default settings each time it runs', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        await client.post('/api/users/reset-settings');
        writeUserFiles(OPEN_MEMBER.handle, { 'settings.json': '{"custom":true}' });

        const response = await client.post('/api/users/reset-settings');

        expect(response.status).toBe(204);
        expect(readUserJson(OPEN_MEMBER.handle, 'settings.json')).toEqual(readDefaultSettings());
    });

    test('refuses a wrong password and keeps the settings', async () => {
        const client = await harness.loginAs(MEMBER);
        writeUserFiles(MEMBER.handle, { 'settings.json': '{"custom":true}' });

        const reply = await readReply(await client.post('/api/users/reset-settings', { password: 'wrong-secret' }));

        expect(reply).toEqual({ status: 403, body: { error: 'Incorrect password' } });
        expect(readUserJson(MEMBER.handle, 'settings.json')).toEqual({ custom: true });
    });
});

describe('POST /api/users/change-name', () => {
    test('renames the current account', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const response = await client.post('/api/users/change-name', { handle: OPEN_MEMBER.handle, name: 'Renamed' });
        const me = await readReply(await client.get('/api/users/me'));

        expect(response.status).toBe(204);
        expect(me.body.name).toBe('Renamed');
    });

    test('lets an admin rename another account', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const response = await admin.post('/api/users/change-name', { handle: OPEN_MEMBER.handle, name: 'Renamed' });

        expect(response.status).toBe(204);
        expect(await harness.account(OPEN_MEMBER.handle)).toMatchObject({ name: 'Renamed' });
    });

    test.each([
        ['a name', { handle: OPEN_MEMBER.handle }],
        ['a handle', { name: 'Renamed' }],
    ])('answers 400 without %s', async (_field, body) => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/change-name', body));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('answers 403 to a non-admin who names another account', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/change-name', { handle: MEMBER.handle, name: 'Renamed' }));

        expect(reply).toEqual({ status: 403, body: { error: 'Unauthorized' } });
        expect(await harness.account(MEMBER.handle)).toMatchObject({ name: MEMBER.name });
    });

    test('answers 404 for an unknown user', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const reply = await readReply(await admin.post('/api/users/change-name', { handle: 'no-such-user', name: 'Renamed' }));

        expect(reply).toEqual({ status: 404, body: { error: 'User not found' } });
    });

    test('answers 500 when storage fails', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        harness.failStorageOnce('setItem');

        const response = await client.post('/api/users/change-name', { handle: OPEN_MEMBER.handle, name: 'Renamed' });

        expect(response.status).toBe(500);
    });
});

describe('account reset', () => {
    async function requestResetCode(client) {
        const response = await client.post('/api/users/reset-step1');
        expect(response.status).toBe(204);
        return lastLoggedCode();
    }

    test('step 1 prints a six-digit code', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        expect(await requestResetCode(client)).toMatch(/^\d{6}$/);
    });

    test('step 2 with the correct code replaces the account data with the defaults', async () => {
        const client = await harness.loginAs(MEMBER);
        const code = await requestResetCode(client);
        writeUserFiles(MEMBER.handle, { 'settings.json': '{"custom":true}', 'chats/Ada/first.jsonl': '{}' });
        writeUserFiles(OPEN_MEMBER.handle, { 'chats/Ada/other.jsonl': '{}' });

        const response = await client.post('/api/users/reset-step2', { code, password: MEMBER.password });

        expect(response.status).toBe(204);
        expect(readUserJson(MEMBER.handle, 'settings.json')).toEqual(readDefaultSettings());
        expect(fs.existsSync(path.join(harness.userRoot(MEMBER.handle), 'chats', 'Ada'))).toBe(false);
        expect(fs.existsSync(harness.users.getUserDirectories(MEMBER.handle).chats)).toBe(true);
        expect(fs.existsSync(path.join(harness.userRoot(OPEN_MEMBER.handle), 'chats', 'Ada', 'other.jsonl'))).toBe(true);
    });

    test('step 2 accepts a code only once', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const code = await requestResetCode(client);

        const first = await client.post('/api/users/reset-step2', { code });
        const second = await client.post('/api/users/reset-step2', { code });

        expect(first.status).toBe(204);
        expect(second.status).toBe(400);
    });

    test('step 2 answers 400 without a code', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/reset-step2', {}));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('step 2 refuses a wrong password and keeps the account data', async () => {
        const client = await harness.loginAs(MEMBER);
        const code = await requestResetCode(client);
        writeUserFiles(MEMBER.handle, { 'settings.json': '{"custom":true}' });

        const reply = await readReply(await client.post('/api/users/reset-step2', { code, password: 'wrong-secret' }));

        expect(reply).toEqual({ status: 400, body: { error: 'Incorrect password' } });
        expect(readUserJson(MEMBER.handle, 'settings.json')).toEqual({ custom: true });
    });

    test('step 2 refuses a wrong code and keeps the account data', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const code = await requestResetCode(client);
        const wrongCode = code === '000000' ? '000001' : '000000';
        writeUserFiles(OPEN_MEMBER.handle, { 'settings.json': '{"custom":true}' });

        const reply = await readReply(await client.post('/api/users/reset-step2', { code: wrongCode }));

        expect(reply).toEqual({ status: 400, body: { error: 'Incorrect code' } });
        expect(readUserJson(OPEN_MEMBER.handle, 'settings.json')).toEqual({ custom: true });
    });

    test('step 2 refuses a code when none was requested', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/reset-step2', { code: '123456' }));

        expect(reply).toEqual({ status: 400, body: { error: 'Incorrect code' } });
    });

    test('step 2 refuses a code issued for another account', async () => {
        const member = await harness.loginAs(OPEN_MEMBER);
        const code = await requestResetCode(member);
        const admin = await harness.loginAs(ADMIN);

        const reply = await readReply(await admin.post('/api/users/reset-step2', { code, password: ADMIN.password }));

        expect(reply).toEqual({ status: 400, body: { error: 'Incorrect code' } });
    });

    test('step 2 accepts a code until it is five minutes old', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const issuedAt = Date.now();
        const code = await requestResetCode(client);
        const clock = jest.spyOn(Date, 'now').mockReturnValue(issuedAt + CODE_LIFETIME_MS - 1000);

        const response = await client.post('/api/users/reset-step2', { code });
        clock.mockRestore();

        expect(response.status).toBe(204);
    });

    test('step 2 refuses a code older than five minutes', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const code = await requestResetCode(client);
        const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + CODE_LIFETIME_MS + 1000);

        const response = await client.post('/api/users/reset-step2', { code });
        clock.mockRestore();

        expect(response.status).toBe(400);
    });
});
