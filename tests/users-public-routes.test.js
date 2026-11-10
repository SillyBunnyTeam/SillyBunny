import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import storage from 'node-persist';

import { DEFAULT_USER } from '../src/constants.js';
import { ADMIN, DISABLED_MEMBER, MEMBER, OPEN_MEMBER, lastLoggedCode, readReply, startAccountServer } from './util/user-account-harness.js';

// The limiters keep their counts in module state and every test here shares one client address, so a limit of 0 turns them off in this file.
const harness = await startAccountServer({
    config: {
        'rateLimiting.accountsLoginMaxAttempts': 0,
        'rateLimiting.accountsRecoverMaxAttempts': 0,
    },
});

const CODE_LIFETIME_MS = 5 * 60 * 1000;

beforeEach(() => harness.reset());

afterAll(() => harness.close());

async function requestRecoveryCode(client, handle) {
    const response = await client.post('/api/users/recover-step1', { handle });
    expect(response.status).toBe(204);
    return lastLoggedCode();
}

describe('POST /api/users/list', () => {
    test('lists enabled accounts, oldest first, without password data', async () => {
        const { status, body } = await readReply(await harness.client().post('/api/users/list'));

        expect(status).toBe(200);
        expect(body.map(user => user.handle)).toEqual([ADMIN.handle, MEMBER.handle, OPEN_MEMBER.handle, DEFAULT_USER.handle]);
        expect(body[1]).toEqual({
            handle: MEMBER.handle,
            name: MEMBER.name,
            created: MEMBER.created,
            avatar: '/img/default-user.png',
            password: true,
        });
        expect(body[2].password).toBe(false);
    });

    test('shows a stored avatar, then the persona image from settings, then the default image', async () => {
        const avatars = {
            stored: 'data:image/png;base64,c3RvcmVk',
            persona: `data:image/png;base64,${Buffer.from('persona').toString('base64')}`,
        };
        await storage.setItem(harness.users.toAvatarKey(MEMBER.handle), avatars.stored);

        const { root, avatars: personaFolder } = harness.users.getUserDirectories(OPEN_MEMBER.handle);
        fs.mkdirSync(personaFolder, { recursive: true });
        fs.writeFileSync(path.join(personaFolder, 'face.png'), 'persona');
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ power_user: { default_persona: 'face.png' } }));

        const adminRoot = harness.userRoot(ADMIN.handle);
        fs.mkdirSync(adminRoot, { recursive: true });
        fs.writeFileSync(path.join(adminRoot, 'settings.json'), JSON.stringify({ user_avatar: 'missing.png' }));

        const defaultRoot = harness.userRoot(DEFAULT_USER.handle);
        fs.mkdirSync(defaultRoot, { recursive: true });
        fs.writeFileSync(path.join(defaultRoot, 'settings.json'), 'not json');

        const { body } = await readReply(await harness.client().post('/api/users/list'));
        const avatarByHandle = Object.fromEntries(body.map(user => [user.handle, user.avatar]));

        expect(avatarByHandle).toEqual({
            [MEMBER.handle]: avatars.stored,
            [OPEN_MEMBER.handle]: avatars.persona,
            [ADMIN.handle]: '/img/default-user.png',
            [DEFAULT_USER.handle]: '/img/default-user.png',
        });
    });

    test('answers 500 when storage fails', async () => {
        harness.failStorageOnce('values');

        const response = await harness.client().post('/api/users/list');

        expect(response.status).toBe(500);
    });
});

describe('POST /api/users/login', () => {
    test('opens a session for the correct password', async () => {
        const client = harness.client();

        const login = await readReply(await client.login(MEMBER.handle, MEMBER.password));
        const me = await readReply(await client.get('/api/users/me'));

        expect(login).toEqual({ status: 200, body: { handle: MEMBER.handle } });
        expect(me.status).toBe(200);
        expect(me.body.handle).toBe(MEMBER.handle);
    });

    test('opens a session for an account without a password', async () => {
        const client = harness.client();

        const login = await readReply(await client.login(OPEN_MEMBER.handle));

        expect(login).toEqual({ status: 200, body: { handle: OPEN_MEMBER.handle } });
        expect(client.hasSession).toBe(true);
    });

    test('compares passwords after Unicode normalization', async () => {
        const composed = 'caf\u00e9-secret';
        const decomposed = 'cafe\u0301-secret';
        const salt = harness.users.getPasswordSalt();
        const record = await harness.account(MEMBER.handle);
        await storage.setItem(harness.users.toKey(MEMBER.handle), {
            ...record,
            salt,
            password: harness.users.getPasswordHash(composed, salt),
        });

        const response = await harness.client().login(MEMBER.handle, decomposed);

        expect(response.status).toBe(200);
    });

    test('refuses a wrong password and opens no session', async () => {
        const client = harness.client();

        const login = await readReply(await client.login(MEMBER.handle, 'wrong-secret'));

        expect(login).toEqual({ status: 403, body: { error: 'Incorrect credentials' } });
        expect(client.hasSession).toBe(false);
    });

    test('gives an unknown user the same answer as a wrong password', async () => {
        const client = harness.client();

        const login = await readReply(await client.login('no-such-user', 'any-secret'));

        expect(login).toEqual({ status: 403, body: { error: 'Incorrect credentials' } });
        expect(client.hasSession).toBe(false);
    });

    test('refuses a disabled user and opens no session', async () => {
        const client = harness.client();

        const login = await readReply(await client.login(DISABLED_MEMBER.handle));

        expect(login).toEqual({ status: 403, body: { error: 'User is disabled' } });
        expect(client.hasSession).toBe(false);
    });

    test('answers 400 without a handle', async () => {
        const login = await readReply(await harness.client().login(undefined, MEMBER.password));

        expect(login).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('answers 500 when storage fails', async () => {
        harness.failStorageOnce('getItem');

        const response = await harness.client().login(MEMBER.handle, MEMBER.password);

        expect(response.status).toBe(500);
    });

    test('never answers 429 when the login limit is 0', async () => {
        const client = harness.client();
        const statuses = [];

        for (let attempt = 0; attempt < 7; attempt++) {
            statuses.push((await client.login('no-such-user')).status);
        }

        expect(statuses).toEqual(Array(7).fill(403));
    });
});

describe('POST /api/users/recover-step1', () => {
    test('prints a six-digit code for an enabled account', async () => {
        const code = await requestRecoveryCode(harness.client(), MEMBER.handle);

        expect(code).toMatch(/^\d{6}$/);
    });

    test('answers 400 without a handle', async () => {
        const reply = await readReply(await harness.client().post('/api/users/recover-step1', {}));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('answers 404 for an unknown user', async () => {
        const reply = await readReply(await harness.client().post('/api/users/recover-step1', { handle: 'no-such-user' }));

        expect(reply).toEqual({ status: 404, body: { error: 'User not found' } });
    });

    test('answers 403 for a disabled user and prints no code', async () => {
        const reply = await readReply(await harness.client().post('/api/users/recover-step1', { handle: DISABLED_MEMBER.handle }));

        expect(reply).toEqual({ status: 403, body: { error: 'User is disabled' } });
        expect(() => lastLoggedCode()).toThrow();
    });

    test('answers 500 when storage fails', async () => {
        harness.failStorageOnce('getItem');

        const response = await harness.client().post('/api/users/recover-step1', { handle: MEMBER.handle });

        expect(response.status).toBe(500);
    });

    test('never answers 429 when the recovery limit is 0', async () => {
        const client = harness.client();
        const statuses = [];

        for (let attempt = 0; attempt < 7; attempt++) {
            statuses.push((await client.post('/api/users/recover-step1', { handle: 'no-such-user' })).status);
        }

        expect(statuses).toEqual(Array(7).fill(404));
    });
});

describe('POST /api/users/recover-step2', () => {
    test('sets the new password and ends the use of the old one', async () => {
        const client = harness.client();
        const code = await requestRecoveryCode(client, MEMBER.handle);

        const response = await client.post('/api/users/recover-step2', { handle: MEMBER.handle, code, newPassword: 'recovered-secret' });

        expect(response.status).toBe(204);
        expect((await harness.client().login(MEMBER.handle, 'recovered-secret')).status).toBe(200);
        expect((await harness.client().login(MEMBER.handle, MEMBER.password)).status).toBe(403);
    });

    test('clears the password when no new password is given', async () => {
        const client = harness.client();
        const code = await requestRecoveryCode(client, MEMBER.handle);

        const response = await client.post('/api/users/recover-step2', { handle: MEMBER.handle, code });

        expect(response.status).toBe(204);
        expect(await harness.account(MEMBER.handle)).toMatchObject({ password: '', salt: '' });
        expect((await harness.client().login(MEMBER.handle)).status).toBe(200);
    });

    test('keeps the session of the recovering client and ends other sessions of the account', async () => {
        const recovering = await harness.loginAs(OPEN_MEMBER);
        const other = await harness.loginAs(OPEN_MEMBER);
        const code = await requestRecoveryCode(recovering, OPEN_MEMBER.handle);

        const response = await recovering.post('/api/users/recover-step2', { handle: OPEN_MEMBER.handle, code, newPassword: 'recovered-secret' });

        expect(response.status).toBe(204);
        expect((await recovering.get('/api/users/me')).status).toBe(200);
        expect((await other.get('/api/users/me')).status).toBe(403);
    });

    test('keeps the session of a client that recovers another account', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const code = await requestRecoveryCode(client, MEMBER.handle);

        const response = await client.post('/api/users/recover-step2', { handle: MEMBER.handle, code, newPassword: 'recovered-secret' });

        expect(response.status).toBe(204);
        expect((await client.get('/api/users/me')).status).toBe(200);
    });

    test('refuses a wrong code and keeps the password', async () => {
        const client = harness.client();
        const code = await requestRecoveryCode(client, MEMBER.handle);
        const wrongCode = code === '000000' ? '000001' : '000000';
        const before = await harness.account(MEMBER.handle);

        const reply = await readReply(await client.post('/api/users/recover-step2', { handle: MEMBER.handle, code: wrongCode, newPassword: 'other-secret' }));

        expect(reply).toEqual({ status: 403, body: { error: 'Incorrect code' } });
        expect(await harness.account(MEMBER.handle)).toEqual(before);
    });

    test('refuses a code when none was requested', async () => {
        const reply = await readReply(await harness.client().post('/api/users/recover-step2', { handle: ADMIN.handle, code: '123456' }));

        expect(reply).toEqual({ status: 403, body: { error: 'Incorrect code' } });
    });

    test('refuses a code issued for another account', async () => {
        const client = harness.client();
        const code = await requestRecoveryCode(client, MEMBER.handle);

        const reply = await readReply(await client.post('/api/users/recover-step2', { handle: OPEN_MEMBER.handle, code }));

        expect(reply).toEqual({ status: 403, body: { error: 'Incorrect code' } });
    });

    test('accepts a code only once', async () => {
        const client = harness.client();
        const code = await requestRecoveryCode(client, OPEN_MEMBER.handle);

        const first = await client.post('/api/users/recover-step2', { handle: OPEN_MEMBER.handle, code });
        const second = await client.post('/api/users/recover-step2', { handle: OPEN_MEMBER.handle, code });

        expect(first.status).toBe(204);
        expect(second.status).toBe(403);
    });

    test('accepts a code until it is five minutes old', async () => {
        const client = harness.client();
        const issuedAt = Date.now();
        const code = await requestRecoveryCode(client, OPEN_MEMBER.handle);
        const clock = jest.spyOn(Date, 'now').mockReturnValue(issuedAt + CODE_LIFETIME_MS - 1000);

        const response = await client.post('/api/users/recover-step2', { handle: OPEN_MEMBER.handle, code });
        clock.mockRestore();

        expect(response.status).toBe(204);
    });

    test('refuses a code older than five minutes', async () => {
        const client = harness.client();
        const code = await requestRecoveryCode(client, OPEN_MEMBER.handle);
        const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + CODE_LIFETIME_MS + 1000);

        const response = await client.post('/api/users/recover-step2', { handle: OPEN_MEMBER.handle, code });
        clock.mockRestore();

        expect(response.status).toBe(403);
    });

    test.each([
        ['a handle', { code: '123456' }],
        ['a code', { handle: MEMBER.handle }],
    ])('answers 400 without %s', async (_field, body) => {
        const reply = await readReply(await harness.client().post('/api/users/recover-step2', body));

        expect(reply).toEqual({ status: 400, body: { error: 'Missing required fields' } });
    });

    test('answers 404 for an unknown user', async () => {
        const reply = await readReply(await harness.client().post('/api/users/recover-step2', { handle: 'no-such-user', code: '123456' }));

        expect(reply).toEqual({ status: 404, body: { error: 'User not found' } });
    });

    test('answers 403 for a disabled user', async () => {
        const reply = await readReply(await harness.client().post('/api/users/recover-step2', { handle: DISABLED_MEMBER.handle, code: '123456' }));

        expect(reply).toEqual({ status: 403, body: { error: 'User is disabled' } });
    });

    test('answers 500 when storage fails', async () => {
        const client = harness.client();
        const code = await requestRecoveryCode(client, OPEN_MEMBER.handle);
        harness.failStorageOnce('setItem');

        const response = await client.post('/api/users/recover-step2', { handle: OPEN_MEMBER.handle, code });

        expect(response.status).toBe(500);
    });
});
