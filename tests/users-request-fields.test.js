import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import storage from 'node-persist';

import { DEFAULT_USER } from '../src/constants.js';
import { MEMBER, OPEN_MEMBER, lastLoggedCode, readReply, startAccountServer } from './util/user-account-harness.js';

// The limiters keep their counts in module state and every test here shares one client address, so a limit of 0 turns them off in this file.
const harness = await startAccountServer({
    config: {
        'rateLimiting.accountsLoginMaxAttempts': 0,
        'rateLimiting.accountsRecoverMaxAttempts': 0,
        'rateLimiting.accountsResetMaxAttempts': 0,
    },
});

// An account reset copies the default content again, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

const MISSING_FIELDS = { error: 'Missing required fields' };
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function writeSettings(handle, content) {
    const root = harness.userRoot(handle);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.json'), content);
}

function readSettings(handle) {
    return fs.readFileSync(path.join(harness.userRoot(handle), 'settings.json'), 'utf8');
}

beforeEach(() => harness.reset());

afterAll(() => harness.close());

describe('POST /api/users/login', () => {
    test('answers 400 to a handle that is not a string and opens no session', async () => {
        const client = harness.client();

        const reply = await readReply(await client.post('/api/users/login', { handle: [MEMBER.handle], password: MEMBER.password }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(client.hasSession).toBe(false);
    });

    test('answers 400 to a password that is not a string', async () => {
        const reply = await readReply(await harness.client().post('/api/users/login', { handle: MEMBER.handle, password: {} }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
    });

    test('answers a missing password for an account that has one as it answers an unknown handle', async () => {
        const client = harness.client();

        const missing = await readReply(await client.post('/api/users/login', { handle: MEMBER.handle }));
        const unknown = await readReply(await harness.client().post('/api/users/login', { handle: 'no-such-user' }));

        expect(missing).toEqual({ status: 403, body: { error: 'Incorrect credentials' } });
        expect(unknown).toEqual(missing);
        expect(client.hasSession).toBe(false);
    });
});

describe('password recovery', () => {
    test('step 1 answers 400 to a handle that is not a string and prints no code', async () => {
        const reply = await readReply(await harness.client().post('/api/users/recover-step1', { handle: [MEMBER.handle] }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(() => lastLoggedCode()).toThrow();
    });

    test('step 2 answers 400 to a handle that is not a string and keeps the password', async () => {
        const client = harness.client();
        await client.post('/api/users/recover-step1', { handle: MEMBER.handle });
        const code = lastLoggedCode();
        const before = await harness.account(MEMBER.handle);

        const reply = await readReply(await client.post('/api/users/recover-step2', { handle: [MEMBER.handle], code }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(await harness.account(MEMBER.handle)).toEqual(before);
    });

    test('step 2 answers 400 to a new password that is not a string and keeps the password', async () => {
        const client = harness.client();
        await client.post('/api/users/recover-step1', { handle: MEMBER.handle });
        const code = lastLoggedCode();
        const before = await harness.account(MEMBER.handle);

        const reply = await readReply(await client.post('/api/users/recover-step2', { handle: MEMBER.handle, code, newPassword: { value: 'x' } }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(await harness.account(MEMBER.handle)).toEqual(before);
    });
});

describe('POST /api/users/change-avatar', () => {
    test.each([
        ['without an avatar', { handle: OPEN_MEMBER.handle }],
        ['to an avatar that is not a string', { handle: OPEN_MEMBER.handle, avatar: { url: PNG_DATA_URL } }],
    ])('answers 400 %s', async (_title, body) => {
        const client = await harness.loginAs(OPEN_MEMBER);

        const reply = await readReply(await client.post('/api/users/change-avatar', body));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(await storage.getItem(harness.users.toAvatarKey(OPEN_MEMBER.handle))).toBeUndefined();
    });

    test('answers 400 to an admin that sends a handle that is not a string', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const reply = await readReply(await admin.post('/api/users/change-avatar', { handle: [OPEN_MEMBER.handle], avatar: PNG_DATA_URL }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(await storage.getItem(harness.users.toAvatarKey(OPEN_MEMBER.handle))).toBeUndefined();
    });
});

describe('POST /api/users/change-password', () => {
    test.each([
        ['without the old password', { handle: MEMBER.handle, newPassword: 'changed-secret' }],
        ['to an old password that is not a string', { handle: MEMBER.handle, oldPassword: [MEMBER.password], newPassword: 'changed-secret' }],
    ])('answers 400 %s and keeps the password', async (_title, body) => {
        const client = await harness.loginAs(MEMBER);
        const before = await harness.account(MEMBER.handle);

        const reply = await readReply(await client.post('/api/users/change-password', body));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(await harness.account(MEMBER.handle)).toEqual(before);
    });

    test.each([
        ['a handle that is not a string', { handle: [MEMBER.handle], newPassword: 'changed-secret' }],
        ['a new password that is not a string', { handle: MEMBER.handle, newPassword: { value: 'changed-secret' } }],
    ])('answers 400 to an admin that sends %s and keeps the password', async (_title, body) => {
        const admin = await harness.loginAs(DEFAULT_USER);
        const before = await harness.account(MEMBER.handle);

        const reply = await readReply(await admin.post('/api/users/change-password', body));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(await harness.account(MEMBER.handle)).toEqual(before);
    });
});

describe('account resets', () => {
    test('reset-settings answers 400 without a password and keeps the settings', async () => {
        const client = await harness.loginAs(MEMBER);
        writeSettings(MEMBER.handle, '{"custom":true}');

        const reply = await readReply(await client.post('/api/users/reset-settings', {}));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(readSettings(MEMBER.handle)).toBe('{"custom":true}');
    });

    test('reset-step2 answers 400 to a code without a password and keeps the account data', async () => {
        const client = await harness.loginAs(MEMBER);
        await client.post('/api/users/reset-step1');
        const code = lastLoggedCode();
        writeSettings(MEMBER.handle, '{"custom":true}');

        const reply = await readReply(await client.post('/api/users/reset-step2', { code }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(readSettings(MEMBER.handle)).toBe('{"custom":true}');
    });
});

describe('other private routes', () => {
    test('backup answers 400 to an admin that sends a handle that is not a string', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const reply = await readReply(await admin.post('/api/users/backup', { handle: [OPEN_MEMBER.handle] }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
    });

    test('change-name answers 400 to an admin that sends a handle that is not a string', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const reply = await readReply(await admin.post('/api/users/change-name', { handle: [OPEN_MEMBER.handle], name: 'Renamed' }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(await harness.account(OPEN_MEMBER.handle)).toMatchObject({ name: OPEN_MEMBER.name });
    });
});

describe('admin routes', () => {
    test.each(['/disable', '/demote', '/delete'])('POST %s answers 400 to a handle that is not a string and leaves the current admin as it is', async route => {
        const admin = await harness.loginAs(DEFAULT_USER);
        const before = await harness.account(DEFAULT_USER.handle);

        const reply = await readReply(await admin.post(`/api/users${route}`, { handle: [DEFAULT_USER.handle] }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(await harness.account(DEFAULT_USER.handle)).toEqual(before);
    });

    test.each(['/enable', '/promote'])('POST %s answers 400 to a handle that is not a string and changes nothing', async route => {
        const admin = await harness.loginAs(DEFAULT_USER);
        const before = await harness.account(OPEN_MEMBER.handle);

        const reply = await readReply(await admin.post(`/api/users${route}`, { handle: [OPEN_MEMBER.handle] }));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(await harness.account(OPEN_MEMBER.handle)).toEqual(before);
    });

    test.each([
        ['a handle that is not a string', { handle: ['new-account'], name: 'New Account' }],
        ['a password that is not a string', { handle: 'new-account', name: 'New Account', password: { value: 'new-secret' } }],
    ])('POST /create answers 400 to %s and creates no account', async (_title, body) => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const reply = await readReply(await admin.post('/api/users/create', body));

        expect(reply).toEqual({ status: 400, body: MISSING_FIELDS });
        expect(await harness.account('new-account')).toBeUndefined();
    });
});
