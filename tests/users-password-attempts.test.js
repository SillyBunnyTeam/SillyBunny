import { afterAll, beforeEach, describe, expect, test } from '@jest/globals';
import storage from 'node-persist';

import { lastLoggedCode, readReply, startAccountServer } from './util/user-account-harness.js';

// The limiters keep their counts in module state for as long as this file runs.
// Each test therefore uses accounts and client addresses of its own.
const harness = await startAccountServer();

const MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_SECONDS = 60;
const LIMITED = { error: 'Too many attempts. Try again later or contact your admin.' };

let nextNumber = 1;

function ownAddress() {
    return `198.51.100.${nextNumber++}`;
}

/**
 * Stores a new account with a password, because the limit counts per account and lasts for the whole file.
 * @returns {Promise<{handle: string, password: string}>} Handle and password of the account
 */
async function passwordAccount() {
    const handle = `password-user-${nextNumber++}`;
    const password = `${handle}-secret`;
    const salt = `salt-${handle}`;
    await storage.setItem(harness.users.toKey(handle), {
        handle,
        name: handle,
        created: Date.now(),
        password: harness.users.getPasswordHash(password, salt),
        salt,
        admin: false,
        enabled: true,
    });
    return { handle, password };
}

function changePassword(client, account, oldPassword) {
    return client.post('/api/users/change-password', { handle: account.handle, oldPassword, newPassword: account.password });
}

async function repeat(times, action) {
    const statuses = [];
    for (let attempt = 0; attempt < times; attempt++) {
        statuses.push((await action(attempt)).status);
    }
    return statuses;
}

function expectRetryAfter(response, windowSeconds) {
    const retryAfter = Number(response.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
}

beforeEach(() => harness.reset());

afterAll(() => harness.close());

describe('wrong passwords on the account routes', () => {
    test('after five wrong old passwords, /change-password answers 429 with Retry-After to a wrong and to the right one', async () => {
        const account = await passwordAccount();
        const client = await harness.loginAs(account, ownAddress());
        const before = await harness.account(account.handle);

        const failures = await repeat(MAX_ATTEMPTS, attempt => changePassword(client, account, `wrong-${attempt}`));
        const wrong = await changePassword(client, account, 'wrong-again');
        const right = await changePassword(client, account, account.password);

        expect(failures).toEqual(Array(MAX_ATTEMPTS).fill(403));
        expect(wrong.status).toBe(429);
        expect(right.status).toBe(429);
        expectRetryAfter(right, LOGIN_WINDOW_SECONDS);
        expect((await readReply(right)).body).toEqual(LIMITED);
        expect(await harness.account(account.handle)).toEqual(before);
    });

    test('wrong passwords on /change-password, /reset-settings and /reset-step2 count together', async () => {
        const account = await passwordAccount();
        const client = await harness.loginAs(account, ownAddress());
        await client.post('/api/users/reset-step1');
        const code = lastLoggedCode();

        const failures = [
            (await changePassword(client, account, 'wrong-1')).status,
            (await changePassword(client, account, 'wrong-2')).status,
            (await client.post('/api/users/reset-settings', { password: 'wrong-3' })).status,
            (await client.post('/api/users/reset-settings', { password: 'wrong-4' })).status,
            (await client.post('/api/users/reset-step2', { code, password: 'wrong-5' })).status,
        ];
        const limited = await client.post('/api/users/reset-settings', { password: account.password });

        expect(failures).toEqual([403, 403, 403, 403, 400]);
        expect(limited.status).toBe(429);
        expectRetryAfter(limited, LOGIN_WINDOW_SECONDS);
    });

    test('the count belongs to the account, so a second client of the account meets the same limit', async () => {
        const account = await passwordAccount();
        const first = await harness.loginAs(account, ownAddress());
        const second = await harness.loginAs(account, ownAddress());

        await repeat(3, attempt => changePassword(first, account, `wrong-${attempt}`));
        await repeat(2, attempt => changePassword(second, account, `other-${attempt}`));
        const limited = await changePassword(second, account, account.password);

        expect(limited.status).toBe(429);
    });

    test('a locked account leaves the other accounts unlocked', async () => {
        const locked = await passwordAccount();
        const other = await passwordAccount();
        const lockedClient = await harness.loginAs(locked, ownAddress());
        const otherClient = await harness.loginAs(other, ownAddress());

        await repeat(MAX_ATTEMPTS, attempt => changePassword(lockedClient, locked, `wrong-${attempt}`));
        const lockedReply = await changePassword(lockedClient, locked, locked.password);
        const otherReply = await changePassword(otherClient, other, other.password);

        expect(lockedReply.status).toBe(429);
        expect(otherReply.status).toBe(204);
    });

    test('a correct password clears the count', async () => {
        const account = await passwordAccount();
        const client = await harness.loginAs(account, ownAddress());

        const early = await repeat(MAX_ATTEMPTS - 1, attempt => changePassword(client, account, `wrong-${attempt}`));
        const success = await changePassword(client, account, account.password);
        const late = await repeat(MAX_ATTEMPTS, attempt => changePassword(client, account, `late-${attempt}`));
        const limited = await changePassword(client, account, account.password);

        expect(early).toEqual(Array(MAX_ATTEMPTS - 1).fill(403));
        expect(success.status).toBe(204);
        expect(late).toEqual(Array(MAX_ATTEMPTS).fill(403));
        expect(limited.status).toBe(429);
    });
});

describe('the account reset limit', () => {
    test('once wrong codes pass the limit, /reset-step2 answers 429 to a wrong and to the right password', async () => {
        const account = await passwordAccount();
        const client = await harness.loginAs(account, ownAddress());
        await client.post('/api/users/reset-step1');
        const code = lastLoggedCode();
        const wrongCode = code === '000000' ? '000001' : '000000';

        const lockout = await repeat(MAX_ATTEMPTS + 1, () => client.post('/api/users/reset-step2', { code: wrongCode, password: account.password }));
        const wrongPassword = await client.post('/api/users/reset-step2', { code, password: 'wrong-guess' });
        const rightPassword = await client.post('/api/users/reset-step2', { code, password: account.password });

        expect(lockout).toEqual([...Array(MAX_ATTEMPTS).fill(400), 429]);
        expect(wrongPassword.status).toBe(429);
        expect(rightPassword.status).toBe(429);
    });
});
