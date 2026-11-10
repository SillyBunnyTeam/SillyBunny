import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import storage from 'node-persist';

import { DEFAULT_USER } from '../src/constants.js';
import { ADMIN, DISABLED_MEMBER, MEMBER, OPEN_MEMBER, readReply, startAccountServer } from './util/user-account-harness.js';

// The login limiter keeps its count in module state and every test here shares one client address, so a limit of 0 turns it off in this file.
const harness = await startAccountServer({ config: { 'rateLimiting.accountsLoginMaxAttempts': 0 } });

// Creating an account copies its default content, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

const ADMIN_ROUTES = [
    ['/get', {}],
    ['/disable', { handle: MEMBER.handle }],
    ['/enable', { handle: DISABLED_MEMBER.handle }],
    ['/promote', { handle: MEMBER.handle }],
    ['/demote', { handle: ADMIN.handle }],
    ['/create', { handle: 'new-account', name: 'New Account' }],
    ['/delete', { handle: MEMBER.handle }],
    ['/slugify', { text: 'Some Text' }],
];

const TARGETED_ROUTES = ['/disable', '/enable', '/promote', '/demote'];

let admin;

async function allAccounts() {
    const accounts = await storage.values(item => item.key.startsWith(harness.users.KEY_PREFIX));
    return accounts.sort((left, right) => left.handle.localeCompare(right.handle));
}

beforeEach(async () => {
    await harness.reset();
    admin = await harness.loginAs(DEFAULT_USER);
});

afterAll(() => harness.close());

describe('access to the admin routes', () => {
    test.each(ADMIN_ROUTES)('POST %s answers 403 to a non-admin session and changes nothing', async (route, body) => {
        const member = await harness.loginAs(OPEN_MEMBER);
        const before = await allAccounts();

        const response = await member.post(`/api/users${route}`, body);

        expect(response.status).toBe(403);
        expect(await allAccounts()).toEqual(before);
    });

    test.each(ADMIN_ROUTES)('POST %s answers 403 without a session and changes nothing', async (route, body) => {
        const before = await allAccounts();

        const response = await harness.client().post(`/api/users${route}`, body);

        expect(response.status).toBe(403);
        expect(await allAccounts()).toEqual(before);
    });
});

describe('POST /api/users/get', () => {
    test('lists every account, oldest first, with its flags and without password data', async () => {
        const avatar = 'data:image/png;base64,c3RvcmVk';
        await storage.setItem(harness.users.toAvatarKey(MEMBER.handle), avatar);

        const { status, body } = await readReply(await admin.post('/api/users/get'));

        expect(status).toBe(200);
        expect(body.map(user => user.handle)).toEqual([ADMIN.handle, MEMBER.handle, OPEN_MEMBER.handle, DISABLED_MEMBER.handle, DEFAULT_USER.handle]);
        expect(body[1]).toEqual({
            handle: MEMBER.handle,
            name: MEMBER.name,
            avatar,
            admin: false,
            enabled: true,
            created: MEMBER.created,
            password: true,
        });
        expect(body[3].enabled).toBe(false);
        expect(body[0].admin).toBe(true);
    });

    test('answers 500 when storage fails', async () => {
        harness.failStorageOnce('values');

        const response = await admin.post('/api/users/get');

        expect(response.status).toBe(500);
    });
});

describe('POST /api/users/disable', () => {
    test('disables the account, which ends its session and refuses its login', async () => {
        const member = await harness.loginAs(OPEN_MEMBER);

        const response = await admin.post('/api/users/disable', { handle: OPEN_MEMBER.handle });

        expect(response.status).toBe(204);
        expect(await harness.account(OPEN_MEMBER.handle)).toMatchObject({ enabled: false });
        expect((await member.get('/api/users/me')).status).toBe(403);
        expect((await harness.client().login(OPEN_MEMBER.handle)).status).toBe(403);
    });

    test('refuses to disable the current account', async () => {
        const reply = await readReply(await admin.post('/api/users/disable', { handle: DEFAULT_USER.handle }));

        expect(reply).toEqual({ status: 400, body: { error: 'Cannot disable yourself' } });
        expect(await harness.account(DEFAULT_USER.handle)).toMatchObject({ enabled: true });
    });
});

describe('POST /api/users/enable', () => {
    test('enables the account, which can then log in', async () => {
        const response = await admin.post('/api/users/enable', { handle: DISABLED_MEMBER.handle });

        expect(response.status).toBe(204);
        expect(await harness.account(DISABLED_MEMBER.handle)).toMatchObject({ enabled: true });
        expect((await harness.client().login(DISABLED_MEMBER.handle)).status).toBe(200);
    });
});

describe('POST /api/users/promote', () => {
    test('gives the account admin access at once', async () => {
        const member = await harness.loginAs(OPEN_MEMBER);

        const response = await admin.post('/api/users/promote', { handle: OPEN_MEMBER.handle });

        expect(response.status).toBe(204);
        expect(await harness.account(OPEN_MEMBER.handle)).toMatchObject({ admin: true });
        expect((await member.post('/api/users/get')).status).toBe(200);
    });
});

describe('POST /api/users/demote', () => {
    test('removes the admin access of the account at once', async () => {
        const otherAdmin = await harness.loginAs(ADMIN);

        const response = await admin.post('/api/users/demote', { handle: ADMIN.handle });

        expect(response.status).toBe(204);
        expect(await harness.account(ADMIN.handle)).toMatchObject({ admin: false });
        expect((await otherAdmin.post('/api/users/get')).status).toBe(403);
    });

    test('refuses to demote the current account', async () => {
        const reply = await readReply(await admin.post('/api/users/demote', { handle: DEFAULT_USER.handle }));

        expect(reply).toEqual({ status: 400, body: { error: 'Cannot demote yourself' } });
        expect(await harness.account(DEFAULT_USER.handle)).toMatchObject({ admin: true });
    });
});

describe.each(TARGETED_ROUTES)('POST /api/users%s', route => {
    test('answers 400 without a handle', async () => {
        const reply = await readReply(await admin.post(`/api/users${route}`, {}));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('answers 404 for an unknown user', async () => {
        const reply = await readReply(await admin.post(`/api/users${route}`, { handle: 'no-such-user' }));

        expect(reply).toEqual({ status: 404, body: { error: 'User not found' } });
        expect(await harness.account('no-such-user')).toBeUndefined();
    });

    test('answers 500 when storage fails', async () => {
        harness.failStorageOnce('setItem');

        const response = await admin.post(`/api/users${route}`, { handle: OPEN_MEMBER.handle });

        expect(response.status).toBe(500);
    });
});

describe('POST /api/users/create', () => {
    test('creates an account with a password, its data folder and its default settings', async () => {
        const before = Date.now();

        const reply = await readReply(await admin.post('/api/users/create', {
            handle: 'New Account',
            name: 'New Person',
            password: 'new-secret',
        }));

        expect(reply).toEqual({ status: 200, body: { handle: 'new-account' } });
        const record = await harness.account('new-account');
        expect(record).toMatchObject({ handle: 'new-account', name: 'New Person', admin: false, enabled: true });
        expect(record.created).toBeGreaterThanOrEqual(before);
        expect(record.password).toBe(harness.users.getPasswordHash('new-secret', record.salt));
        expect(fs.existsSync(path.join(harness.userRoot('new-account'), 'settings.json'))).toBe(true);
        expect((await harness.client().login('new-account', 'new-secret')).status).toBe(200);
        expect((await harness.client().login('new-account', 'other-secret')).status).toBe(403);
    });

    test('creates an admin account without a password', async () => {
        const reply = await readReply(await admin.post('/api/users/create', { handle: 'open-admin', name: 'Open Admin', admin: true }));

        expect(reply).toEqual({ status: 200, body: { handle: 'open-admin' } });
        expect(await harness.account('open-admin')).toMatchObject({ admin: true, password: '' });
    });

    test('answers 400 when the handle has no letters or digits', async () => {
        const reply = await readReply(await admin.post('/api/users/create', { handle: '!!!', name: 'No Handle' }));

        expect(reply).toEqual({ status: 400, body: { error: 'Invalid handle' } });
    });

    test.each([
        ['a handle', { name: 'No Handle' }],
        ['a name', { handle: 'no-name' }],
    ])('answers 400 without %s', async (_field, body) => {
        const reply = await readReply(await admin.post('/api/users/create', body));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('answers 409 when the handle slugifies to an existing account', async () => {
        const before = await harness.account(MEMBER.handle);

        const reply = await readReply(await admin.post('/api/users/create', { handle: 'Member User', name: 'Second Member' }));

        expect(reply).toEqual({ status: 409, body: { error: 'User already exists' } });
        expect(await harness.account(MEMBER.handle)).toEqual(before);
    });

    test('answers 500 when storage fails', async () => {
        harness.failStorageOnce('setItem');

        const response = await admin.post('/api/users/create', { handle: 'new-account', name: 'New Person' });

        expect(response.status).toBe(500);
    });
});

describe('POST /api/users/delete', () => {
    function writeUserFile(handle) {
        const root = harness.userRoot(handle);
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'settings.json'), '{}');
        return path.join(root, 'settings.json');
    }

    test('removes the account and keeps its data folder', async () => {
        const member = await harness.loginAs(OPEN_MEMBER);
        const userFile = writeUserFile(OPEN_MEMBER.handle);

        const response = await admin.post('/api/users/delete', { handle: OPEN_MEMBER.handle });

        expect(response.status).toBe(204);
        expect(await harness.account(OPEN_MEMBER.handle)).toBeUndefined();
        expect(fs.existsSync(userFile)).toBe(true);
        expect((await member.get('/api/users/me')).status).toBe(403);
        expect((await harness.client().login(OPEN_MEMBER.handle)).status).toBe(403);
    });

    test('with purge, also removes the data folder of that account only', async () => {
        const memberFile = writeUserFile(OPEN_MEMBER.handle);
        const otherFile = writeUserFile(MEMBER.handle);

        const response = await admin.post('/api/users/delete', { handle: OPEN_MEMBER.handle, purge: true });

        expect(response.status).toBe(204);
        expect(await harness.account(OPEN_MEMBER.handle)).toBeUndefined();
        expect(fs.existsSync(path.dirname(memberFile))).toBe(false);
        expect(fs.existsSync(otherFile)).toBe(true);
    });

    test('answers 400 without a handle', async () => {
        const reply = await readReply(await admin.post('/api/users/delete', {}));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('refuses to delete the current account', async () => {
        const reply = await readReply(await admin.post('/api/users/delete', { handle: DEFAULT_USER.handle, purge: true }));

        expect(reply).toEqual({ status: 400, body: { error: 'Cannot delete yourself' } });
        expect(await harness.account(DEFAULT_USER.handle)).toBeDefined();
    });

    test('refuses to delete the default user from another admin account', async () => {
        const otherAdmin = await harness.loginAs(ADMIN);

        const { status, body } = await readReply(await otherAdmin.post('/api/users/delete', { handle: DEFAULT_USER.handle }));

        expect(status).toBe(400);
        expect(body.error).toContain('default user cannot be deleted');
        expect(await harness.account(DEFAULT_USER.handle)).toBeDefined();
    });

    test('answers 500 when storage fails', async () => {
        harness.failStorageOnce('removeItem');

        const response = await admin.post('/api/users/delete', { handle: OPEN_MEMBER.handle });

        expect(response.status).toBe(500);
    });
});

describe('POST /api/users/slugify', () => {
    test('lowercases, removes accents and joins words with hyphens', async () => {
        const reply = await readReply(await admin.post('/api/users/slugify', { text: '  Ünï/Çödé  Näme! ' }));

        expect(reply).toEqual({ status: 200, body: 'uni-code-name' });
    });

    test('answers 400 without text', async () => {
        const reply = await readReply(await admin.post('/api/users/slugify', {}));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('refuses a value that cannot become text', async () => {
        const response = await admin.post('/api/users/slugify', { text: { toString: null } });

        expect(response.ok).toBe(false);
    });
});
