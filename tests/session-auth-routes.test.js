import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
    closeApps,
    createTempDirectory,
    removeTempDirectory,
    resetServerModules,
    seedAccounts,
    startApp,
    writeErrorPage,
} from './util/middleware-harness.js';
import { MODULE_RELOAD_TIMEOUT_MS } from './util/module-reload-timeout.js';

const USERNAME = 'test-user';
const PASSWORD = 'test-password';
const CONFIGURED_USER = {
    SILLYTAVERN_SESSIONAUTH_ENABLED: 'true',
    SILLYTAVERN_BASICAUTHUSER_USERNAME: USERNAME,
    SILLYTAVERN_BASICAUTHUSER_PASSWORD: PASSWORD,
};
const ACCOUNT_PASSWORDS = {
    SILLYTAVERN_PERUSERBASICAUTH: 'true',
    SILLYTAVERN_ENABLEUSERACCOUNTS: 'true',
};
const WHITELIST_PAGE = 'blocked by the ip whitelist';
const HOST_PAGE = 'blocked by the host whitelist';

let dataRoot;
const originalDataRoot = global.DATA_ROOT;

/**
 * Loads the session auth module with a fresh configuration and serves its routes on port 0.
 * @param {object} [options] Options
 * @param {Record<string, string>} [options.env] SILLYTAVERN_* variables on top of the configured single user
 * @param {boolean} [options.whitelistMode] Value passed as the IP whitelist switch
 * @param {boolean} [options.accounts] Whether to seed the test accounts
 */
async function startSessionRoutes({ env = {}, whitelistMode = false, accounts = false } = {}) {
    await resetServerModules({ ...CONFIGURED_USER, ...env });
    if (accounts) {
        await seedAccounts(dataRoot);
    }
    const sessionAuth = await import('../src/middleware/sessionAuth.js');
    const { default: storage } = await import('node-persist');
    const router = express.Router();
    await sessionAuth.registerSessionAuthRoutes(router, { whitelistMode });
    const { port } = await startApp(express.json(), router);
    return { sessionAuth, storage, port, base: `http://127.0.0.1:${port}` };
}

async function post(base, route, body, headers = {}) {
    const response = await fetch(base + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = text;
    try {
        parsed = JSON.parse(text);
    } catch {
        // The whitelist pages are HTML.
    }
    return { status: response.status, body: parsed, retryAfter: response.headers.get('retry-after') };
}

function login(base, body, headers) {
    return post(base, '/api/auth/login', body, headers);
}

/**
 * fetch replaces a Host header with the address in the URL, so the host whitelist cases use node:http.
 */
function loginWithHost(port, host, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const request = http.request({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/auth/login',
            agent: false,
            headers: { Host: host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, response => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                text += chunk;
            });
            response.once('end', () => resolve({ status: response.statusCode, body: text }));
        });
        request.once('error', reject);
        request.end(payload);
    });
}

async function repeatLogin(times, base, body, headers) {
    const statuses = [];
    for (let attempt = 0; attempt < times; attempt++) {
        statuses.push((await login(base, body, headers)).status);
    }
    return statuses;
}

beforeAll(() => {
    dataRoot = createTempDirectory('sillybunny-session-routes-');
    global.DATA_ROOT = dataRoot;
    writeErrorPage(dataRoot, 'forbidden-by-whitelist.html', WHITELIST_PAGE);
    writeErrorPage(dataRoot, 'host-not-allowed.html', HOST_PAGE);
});

beforeEach(() => {
    for (const method of ['warn', 'error', 'info', 'log']) {
        jest.spyOn(console, method).mockImplementation(() => {});
    }
});

afterEach(async () => {
    await closeApps();
    jest.restoreAllMocks();
});

afterAll(() => {
    global.DATA_ROOT = originalDataRoot;
    removeTempDirectory(dataRoot);
});

describe('POST /api/auth/login', () => {
    test('gives a token for the configured credentials, and the token is a live session', async () => {
        const { sessionAuth, base } = await startSessionRoutes();

        const reply = await login(base, { username: USERNAME, password: PASSWORD });

        expect(reply.status).toBe(200);
        expect(sessionAuth.validateSession(reply.body.token)?.username).toBe(USERNAME);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('answers 401 to wrong credentials and gives no token', async () => {
        const { base } = await startSessionRoutes();

        const reply = await login(base, { username: USERNAME, password: 'wrong-password' });

        expect(reply).toMatchObject({ status: 401, body: { error: 'Invalid credentials.' } });
    }, MODULE_RELOAD_TIMEOUT_MS);

    test.each([
        ['no fields', {}],
        ['no password', { username: USERNAME }],
        ['no username', { password: PASSWORD }],
        ['an object password', { username: USERNAME, password: {} }],
        ['a number password', { username: USERNAME, password: 12345 }],
        ['an array username', { username: [USERNAME], password: PASSWORD }],
    ])('answers 400 to a request with %s', async (_title, body) => {
        const { base } = await startSessionRoutes();

        const reply = await login(base, body);

        expect(reply).toMatchObject({ status: 400, body: { error: 'Username and password are required.' } });
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('answers 400 to an object password for an account that has a password, and keeps answering', async () => {
        const { base } = await startSessionRoutes({ env: ACCOUNT_PASSWORDS, accounts: true });

        const reply = await login(base, { username: 'alice', password: {} });
        const next = await login(base, { username: 'alice', password: 'alice-pass' });

        expect(reply.status).toBe(400);
        expect(next.status).toBe(200);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('answers 500 when the account storage fails', async () => {
        const { storage, base } = await startSessionRoutes({ env: ACCOUNT_PASSWORDS, accounts: true });
        jest.spyOn(storage, 'keys').mockRejectedValueOnce(new Error('storage failure'));

        const reply = await login(base, { username: 'alice', password: 'alice-pass' });

        expect(reply.status).toBe(500);
    }, MODULE_RELOAD_TIMEOUT_MS);
});

describe('the session login limit', () => {
    const limitOfThree = { SILLYTAVERN_RATELIMITING_BASICAUTHMAXATTEMPTS: '3' };
    const wrong = { username: USERNAME, password: 'wrong-password' };
    const right = { username: USERNAME, password: PASSWORD };

    test('answers 429 with Retry-After once the failed logins reach rateLimiting.basicAuthMaxAttempts, even to the right password', async () => {
        const { base } = await startSessionRoutes({ env: limitOfThree });

        const failures = await repeatLogin(3, base, wrong);
        const limited = await login(base, right);

        expect(failures).toEqual([401, 401, 401]);
        expect(limited.status).toBe(429);
        expect(limited.body).toEqual({ error: 'Too many attempts. Try again later or contact your admin.' });
        expect(Number(limited.retryAfter)).toBeGreaterThan(0);
        expect(Number(limited.retryAfter)).toBeLessThanOrEqual(60);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('allows five failed logins by default', async () => {
        const { base } = await startSessionRoutes();

        const failures = await repeatLogin(5, base, wrong);
        const limited = await login(base, right);

        expect(failures).toEqual(Array(5).fill(401));
        expect(limited.status).toBe(429);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('a successful login clears the count', async () => {
        const { base } = await startSessionRoutes({ env: limitOfThree });

        await repeatLogin(2, base, wrong);
        const success = await login(base, right);
        const failures = await repeatLogin(3, base, wrong);
        const limited = await login(base, right);

        expect(success.status).toBe(200);
        expect(failures).toEqual([401, 401, 401]);
        expect(limited.status).toBe(429);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('does not count a request that answers 400', async () => {
        const { base } = await startSessionRoutes({ env: limitOfThree });

        const malformed = await repeatLogin(5, base, { username: USERNAME });
        const success = await login(base, right);

        expect(malformed).toEqual(Array(5).fill(400));
        expect(success.status).toBe(200);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('counts a socket address once, whatever forwarded address the client names', async () => {
        const { base } = await startSessionRoutes({ env: limitOfThree });

        for (let attempt = 1; attempt <= 3; attempt++) {
            await login(base, wrong, { 'X-Real-IP': `203.0.113.${attempt}`, 'X-Forwarded-For': `198.51.100.${attempt}` });
        }
        const limited = await login(base, right, { 'X-Real-IP': '203.0.113.99' });

        expect(limited.status).toBe(429);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('a limit of 0 turns the limit off', async () => {
        const { base } = await startSessionRoutes({ env: { SILLYTAVERN_RATELIMITING_BASICAUTHMAXATTEMPTS: '0' } });

        const failures = await repeatLogin(8, base, wrong);
        const success = await login(base, right);

        expect(failures).toEqual(Array(8).fill(401));
        expect(success.status).toBe(200);
    }, MODULE_RELOAD_TIMEOUT_MS);
});

describe('whitelist checks on the session routes', () => {
    test('a client outside the IP whitelist gets the whitelist page and no token for the right credentials', async () => {
        const { base } = await startSessionRoutes({ env: { SILLYTAVERN_WHITELIST: '["192.0.2.1"]' }, whitelistMode: true });

        const reply = await login(base, { username: USERNAME, password: PASSWORD });

        expect(reply).toEqual({ status: 403, body: WHITELIST_PAGE, retryAfter: null });
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('a client outside the IP whitelist gets the whitelist page before its request is read', async () => {
        const { base } = await startSessionRoutes({ env: { ...ACCOUNT_PASSWORDS, SILLYTAVERN_WHITELIST: '["192.0.2.1"]' }, whitelistMode: true, accounts: true });

        const reply = await login(base, { username: 'alice', password: {} });

        expect(reply.status).toBe(403);
        expect(reply.body).toBe(WHITELIST_PAGE);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('a client outside the IP whitelist keeps getting the whitelist page, not 429', async () => {
        const env = { SILLYTAVERN_WHITELIST: '["192.0.2.1"]', SILLYTAVERN_RATELIMITING_BASICAUTHMAXATTEMPTS: '1' };
        const blocked = await startSessionRoutes({ env, whitelistMode: true });

        const statuses = await repeatLogin(3, blocked.base, { username: USERNAME, password: 'wrong-password' });

        expect(statuses).toEqual([403, 403, 403]);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('a client inside the IP whitelist can log in', async () => {
        const { base } = await startSessionRoutes({ env: { SILLYTAVERN_WHITELIST: '["127.0.0.1"]' }, whitelistMode: true });

        const reply = await login(base, { username: USERNAME, password: PASSWORD });

        expect(reply.status).toBe(200);
        expect(typeof reply.body.token).toBe('string');
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('the IP whitelist is not checked when whitelist mode is off', async () => {
        const { base } = await startSessionRoutes({ env: { SILLYTAVERN_WHITELIST: '["192.0.2.1"]' }, whitelistMode: false });

        const reply = await login(base, { username: USERNAME, password: PASSWORD });

        expect(reply.status).toBe(200);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('logout answers a client outside the IP whitelist with the whitelist page and keeps the session', async () => {
        const { sessionAuth, base } = await startSessionRoutes({ env: { SILLYTAVERN_WHITELIST: '["192.0.2.1"]' }, whitelistMode: true });
        const token = sessionAuth.createSession(USERNAME);

        const reply = await post(base, '/api/auth/logout', {}, { Authorization: `Bearer ${token}` });

        expect(reply.status).toBe(403);
        expect(sessionAuth.validateSession(token)).not.toBeNull();
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('a request for a host outside the host whitelist gets the host page before its credentials are read', async () => {
        const env = { SILLYTAVERN_HOSTWHITELIST_ENABLED: 'true', SILLYTAVERN_HOSTWHITELIST_HOSTS: '["allowed.example"]' };
        const { port } = await startSessionRoutes({ env });

        const blocked = await loginWithHost(port, 'blocked.example', { username: USERNAME, password: PASSWORD });
        const allowed = await loginWithHost(port, 'allowed.example', { username: USERNAME, password: PASSWORD });

        expect(blocked).toEqual({ status: 403, body: HOST_PAGE });
        expect(allowed.status).toBe(200);
        expect(typeof JSON.parse(allowed.body).token).toBe('string');
    }, MODULE_RELOAD_TIMEOUT_MS);
});

describe('POST /api/auth/logout', () => {
    test('ends the session of the Bearer token it gets', async () => {
        const { sessionAuth, base } = await startSessionRoutes();
        const { body } = await login(base, { username: USERNAME, password: PASSWORD });

        const reply = await post(base, '/api/auth/logout', {}, { Authorization: `Bearer ${body.token}` });

        expect(reply).toMatchObject({ status: 200, body: { success: true } });
        expect(sessionAuth.validateSession(body.token)).toBeNull();
    }, MODULE_RELOAD_TIMEOUT_MS);
});

describe('validateCredentials', () => {
    let accountsRoot;

    beforeAll(() => {
        accountsRoot = createTempDirectory('sillybunny-session-credentials-');
    });

    afterAll(() => {
        removeTempDirectory(accountsRoot);
    });

    test.each([
        ['an object', {}],
        ['an array', ['alice-pass']],
        ['a number', 12345],
    ])('refuses %s as the password of an account', async (_title, password) => {
        await resetServerModules({ ...CONFIGURED_USER, ...ACCOUNT_PASSWORDS });
        await seedAccounts(accountsRoot);
        const { validateCredentials } = await import('../src/middleware/sessionAuth.js');

        await expect(validateCredentials('alice', password)).resolves.toBe(false);
    }, MODULE_RELOAD_TIMEOUT_MS);
});

describe('empty basicAuthUser credentials', () => {
    const credentialWarnings = () => console.warn.mock.calls.filter(([message]) => String(message).includes('basicAuthUser'));

    test.each([
        ['both are empty', '', '', '', ''],
        ['the password is empty', USERNAME, '', USERNAME, ''],
        ['the username is empty', '', PASSWORD, '', PASSWORD],
    ])('validateCredentials refuses the configured values when %s', async (_title, configUsername, configPassword, username, password) => {
        await resetServerModules({
            SILLYTAVERN_BASICAUTHUSER_USERNAME: configUsername,
            SILLYTAVERN_BASICAUTHUSER_PASSWORD: configPassword,
        });
        const { validateCredentials } = await import('../src/middleware/sessionAuth.js');

        await expect(validateCredentials(username, password)).resolves.toBe(false);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('registering the session routes logs one warning when a configured value is empty', async () => {
        await startSessionRoutes({ env: { SILLYTAVERN_BASICAUTHUSER_PASSWORD: '' } });

        expect(credentialWarnings()).toHaveLength(1);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('registering the session routes logs no such warning when both values are set', async () => {
        await startSessionRoutes();

        expect(credentialWarnings()).toHaveLength(0);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('registering the session routes logs no such warning when logins use the account passwords', async () => {
        await startSessionRoutes({ env: { ...ACCOUNT_PASSWORDS, SILLYTAVERN_BASICAUTHUSER_PASSWORD: '' } });

        expect(credentialWarnings()).toHaveLength(0);
    }, MODULE_RELOAD_TIMEOUT_MS);
});

describe('basicAuthUser comparison', () => {
    test.each([
        ['a wrong username of another length', 'someone-else', PASSWORD, 401],
        ['a wrong password of another length', USERNAME, 'a-much-longer-wrong-password', 401],
        ['the configured credentials', USERNAME, PASSWORD, 200],
    ])('login compares both configured values with crypto.timingSafeEqual for %s', async (_title, username, password, status) => {
        const { base } = await startSessionRoutes();
        const timingSafeEqual = jest.spyOn(crypto, 'timingSafeEqual');

        const reply = await login(base, { username, password });

        expect(reply.status).toBe(status);
        expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    }, MODULE_RELOAD_TIMEOUT_MS);

    test('validateCredentials refuses the configured values when the password in the config file is a number', async () => {
        const configPath = path.join(dataRoot, 'number-password.yaml');
        fs.writeFileSync(configPath, `basicAuthUser:\n  username: ${USERNAME}\n  password: 12345\n`);
        await resetServerModules({}, configPath);
        const { validateCredentials } = await import('../src/middleware/sessionAuth.js');

        await expect(validateCredentials(USERNAME, '12345')).resolves.toBe(false);
    }, MODULE_RELOAD_TIMEOUT_MS);
});
