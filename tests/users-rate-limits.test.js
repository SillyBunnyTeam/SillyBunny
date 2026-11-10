import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { MEMBER, OPEN_MEMBER, lastLoggedCode, readReply, startAccountServer } from './util/user-account-harness.js';

// A completed account reset copies the default content again, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

// The limiters keep their counts per client address in module state, which lives as long as this file.
// Each test therefore acts as its own client address.
const harness = await startAccountServer();

const LOGIN_WINDOW_SECONDS = 60;
const RECOVER_WINDOW_SECONDS = 300;
const RESET_WINDOW_SECONDS = 300;
const MAX_ATTEMPTS = 5;

let nextAddress = 1;

function ownAddress() {
    return `198.51.100.${nextAddress++}`;
}

function clientWithOwnAddress() {
    return harness.client(ownAddress());
}

async function repeat(times, action) {
    const statuses = [];
    for (let attempt = 0; attempt < times; attempt++) {
        statuses.push((await action()).status);
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

describe('login limiter', () => {
    const failLogin = client => client.login('no-such-user');

    test('answers 429 with Retry-After once the failed attempts pass the limit', async () => {
        const client = clientWithOwnAddress();

        const statuses = await repeat(MAX_ATTEMPTS, () => failLogin(client));
        const limited = await failLogin(client);

        expect(statuses).toEqual(Array(MAX_ATTEMPTS).fill(403));
        expect(limited.status).toBe(429);
        expectRetryAfter(limited, LOGIN_WINDOW_SECONDS);
        expect((await readReply(limited)).body).toEqual({ error: 'Too many attempts. Try again later or recover your password.' });
    });

    test('refuses a correct password while the limit holds', async () => {
        const client = clientWithOwnAddress();
        await repeat(MAX_ATTEMPTS + 1, () => failLogin(client));

        const response = await client.login(MEMBER.handle, MEMBER.password);

        expect(response.status).toBe(429);
        expect(client.hasSession).toBe(false);
    });

    test('counts each client address on its own', async () => {
        const limited = clientWithOwnAddress();
        await repeat(MAX_ATTEMPTS + 1, () => failLogin(limited));

        const response = await failLogin(clientWithOwnAddress());

        expect(response.status).toBe(403);
    });

    test('clears the count after a successful login', async () => {
        const client = clientWithOwnAddress();
        await repeat(MAX_ATTEMPTS - 1, () => failLogin(client));

        const success = await client.login(OPEN_MEMBER.handle);
        const statuses = await repeat(MAX_ATTEMPTS, () => failLogin(client));

        expect(success.status).toBe(200);
        expect(statuses).toEqual(Array(MAX_ATTEMPTS).fill(403));
    });

    test('does not count a request without a handle', async () => {
        const client = clientWithOwnAddress();

        const statuses = await repeat(MAX_ATTEMPTS + 2, () => client.post('/api/users/login', {}));

        expect(statuses).toEqual(Array(MAX_ATTEMPTS + 2).fill(400));
    });
});

describe('recovery limiter', () => {
    const requestCode = (client, handle = MEMBER.handle) => client.post('/api/users/recover-step1', { handle });
    const sendCode = (client, code) => client.post('/api/users/recover-step2', { handle: MEMBER.handle, code });

    test('step 1 answers 429 with Retry-After once the requests pass the limit', async () => {
        const client = clientWithOwnAddress();

        const statuses = await repeat(MAX_ATTEMPTS, () => requestCode(client));
        const limited = await requestCode(client);

        expect(statuses).toEqual(Array(MAX_ATTEMPTS).fill(204));
        expect(limited.status).toBe(429);
        expectRetryAfter(limited, RECOVER_WINDOW_SECONDS);
        expect((await readReply(limited)).body).toEqual({ error: 'Too many attempts. Try again later or contact your admin.' });
    });

    test('step 2 answers 429 with Retry-After once wrong codes pass the limit', async () => {
        const client = clientWithOwnAddress();
        await requestCode(client);
        const wrongCode = lastLoggedCode() === '000000' ? '000001' : '000000';

        const statuses = await repeat(MAX_ATTEMPTS - 1, () => sendCode(client, wrongCode));
        const limited = await sendCode(client, wrongCode);

        expect(statuses).toEqual(Array(MAX_ATTEMPTS - 1).fill(403));
        expect(limited.status).toBe(429);
        expectRetryAfter(limited, RECOVER_WINDOW_SECONDS);
    });

    test('step 2 refuses the correct code once the limit is passed', async () => {
        const client = clientWithOwnAddress();
        await requestCode(client);
        const code = lastLoggedCode();
        const wrongCode = code === '000000' ? '000001' : '000000';
        await repeat(MAX_ATTEMPTS, () => sendCode(client, wrongCode));
        const before = await harness.account(MEMBER.handle);

        const limited = await client.post('/api/users/recover-step2', { handle: MEMBER.handle, code, newPassword: 'other-secret' });

        expect(limited.status).toBe(429);
        expectRetryAfter(limited, RECOVER_WINDOW_SECONDS);
        expect(await harness.account(MEMBER.handle)).toEqual(before);
    });

    test('clears the count after a successful recovery', async () => {
        const client = clientWithOwnAddress();
        await repeat(MAX_ATTEMPTS - 1, () => requestCode(client, OPEN_MEMBER.handle));
        await requestCode(client, OPEN_MEMBER.handle);
        const code = lastLoggedCode();

        const success = await client.post('/api/users/recover-step2', { handle: OPEN_MEMBER.handle, code });
        const statuses = await repeat(MAX_ATTEMPTS, () => requestCode(client));

        expect(success.status).toBe(204);
        expect(statuses).toEqual(Array(MAX_ATTEMPTS).fill(204));
    });

    test('does not count a request without a handle', async () => {
        const client = clientWithOwnAddress();

        const statuses = await repeat(MAX_ATTEMPTS + 2, () => client.post('/api/users/recover-step1', {}));

        expect(statuses).toEqual(Array(MAX_ATTEMPTS + 2).fill(400));
    });
});

describe('account reset limiter', () => {
    const requestCode = client => client.post('/api/users/reset-step1');
    const sendCode = (client, code) => client.post('/api/users/reset-step2', { code });

    test('answers 429 with Retry-After on both steps once wrong codes pass the limit', async () => {
        const client = await harness.loginAs(OPEN_MEMBER, ownAddress());
        await requestCode(client);
        const code = lastLoggedCode();
        const wrongCode = code === '000000' ? '000001' : '000000';

        const statuses = await repeat(MAX_ATTEMPTS, () => sendCode(client, wrongCode));
        const limitedByWrongCode = await sendCode(client, wrongCode);
        const limitedStep2 = await sendCode(client, code);
        const limitedStep1 = await requestCode(client);

        expect(statuses).toEqual(Array(MAX_ATTEMPTS).fill(400));
        expect(limitedByWrongCode.status).toBe(429);
        expectRetryAfter(limitedByWrongCode, RESET_WINDOW_SECONDS);
        expect(limitedStep2.status).toBe(429);
        expectRetryAfter(limitedStep2, RESET_WINDOW_SECONDS);
        expect(limitedStep1.status).toBe(429);
        expectRetryAfter(limitedStep1, RESET_WINDOW_SECONDS);
        expect((await readReply(limitedStep1)).body).toEqual({ error: 'Too many attempts. Try again later or contact your admin.' });
    });

    test('step 1 does not count against the limit', async () => {
        const client = await harness.loginAs(OPEN_MEMBER, ownAddress());

        const statuses = await repeat(MAX_ATTEMPTS + 2, () => requestCode(client));

        expect(statuses).toEqual(Array(MAX_ATTEMPTS + 2).fill(204));
    });

    test('clears the count after a successful reset', async () => {
        const client = await harness.loginAs(OPEN_MEMBER, ownAddress());
        await requestCode(client);
        const code = lastLoggedCode();
        const wrongCode = code === '000000' ? '000001' : '000000';
        await repeat(MAX_ATTEMPTS - 1, () => sendCode(client, wrongCode));

        const success = await sendCode(client, code);
        const statuses = await repeat(MAX_ATTEMPTS, () => sendCode(client, wrongCode));

        expect(success.status).toBe(204);
        expect(statuses).toEqual(Array(MAX_ATTEMPTS).fill(400));
    });
});
