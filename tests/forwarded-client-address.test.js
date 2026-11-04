/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Buffer } from 'node:buffer';
import express from 'express';

import {
    callMiddleware,
    closeApps,
    createTempDirectory,
    removeTempDirectory,
    resetServerModules,
    seedAccounts,
    startApp,
    writeErrorPage,
} from './util/middleware-harness.js';

const LOCAL = '127.0.0.1';
const LISTED = '192.0.2.10';
const CLIENT = '203.0.113.9';
const OTHER_CLIENT = '203.0.113.10';
const PREFER_REAL_IP = { SILLYTAVERN_RATELIMITING_PREFERREALIPHEADER: 'true' };

async function loadWhitelist(entries, env = {}) {
    await resetServerModules({
        SILLYTAVERN_WHITELIST: JSON.stringify(entries),
        SILLYTAVERN_ENABLEFORWARDEDWHITELIST: 'true',
        SILLYTAVERN_WHITELISTDOCKERHOSTS: 'false',
        ...env,
    });
    const { default: getWhitelistMiddleware } = await import('../src/middleware/whitelist.js');
    return getWhitelistMiddleware();
}

describe('whitelist with forwarded headers', () => {
    let dataRoot;
    let app;

    beforeAll(async () => {
        dataRoot = createTempDirectory('sillybunny-forwarded-whitelist-');
        writeErrorPage(dataRoot, 'forbidden-by-whitelist.html', 'blocked: {{ipDetails}}');
        globalThis.DATA_ROOT = dataRoot;
        app = await startApp(await loadWhitelist([LOCAL, LISTED], { SILLYTAVERN_FORWARDEDHEADERS_CFCONNECTINGIP: 'true' }));
    });

    beforeEach(() => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        await closeApps();
        removeTempDirectory(dataRoot);
    });

    test.each([
        ['a listed address in front of the address that the proxy added', { 'X-Forwarded-For': `${LOCAL}, ${CLIENT}` }],
        ['listed proxies on both sides of the client address', { 'X-Forwarded-For': `${LISTED}, ${CLIENT}, ${LOCAL}` }],
        ['a listed X-Real-IP next to an unlisted X-Forwarded-For', { 'X-Real-IP': LOCAL, 'X-Forwarded-For': CLIENT }],
        ['a listed CF-Connecting-IP next to an unlisted X-Forwarded-For', { 'CF-Connecting-IP': LOCAL, 'X-Forwarded-For': CLIENT }],
    ])('blocks and names the unlisted client for %s', async (_name, headers) => {
        const response = await fetch(app.url, { headers });

        expect(response.status).toBe(403);
        expect(await response.text()).toBe(`blocked: ${LOCAL} (forwarded from ${CLIENT})`);
    });

    test('still checks X-Real-IP when X-Forwarded-For is also present', async () => {
        const response = await fetch(app.url, { headers: { 'X-Real-IP': CLIENT, 'X-Forwarded-For': LISTED } });

        expect(response.status).toBe(403);
        expect(await response.text()).toBe(`blocked: ${LOCAL} (forwarded from ${CLIENT})`);
    });

    test.each([
        ['a listed client behind a listed proxy', { 'X-Forwarded-For': `${LISTED}, ${LOCAL}` }],
        ['an IPv4-mapped form of a listed address in X-Forwarded-For', { 'X-Forwarded-For': `::ffff:${LISTED}` }],
        ['an IPv4-mapped form of a listed address in X-Real-IP', { 'X-Real-IP': `::ffff:${LISTED}` }],
    ])('lets through %s', async (_name, headers) => {
        const response = await fetch(app.url, { headers });

        expect(response.status).toBe(200);
    });

    test.each([
        ['text', 'X-Forwarded-For', 'garbage'],
        ['markup', 'X-Real-IP', '<b>x</b>'],
        ['an address with a port', 'X-Forwarded-For', `${LOCAL}:443`],
    ])('answers 403 instead of an error to a forwarded value that is %s', async (_name, header, value) => {
        const response = await fetch(app.url, { headers: { [header]: value } });

        expect(response.status).toBe(403);
    });

    test('answers 403 instead of an error to a socket without an address', async () => {
        const middleware = await loadWhitelist([LOCAL]);

        const result = await callMiddleware(middleware, { socket: {}, headers: {}, path: '/' });

        expect(result.status).toBe(403);
        expect(result.body).toBe('blocked: unknown');
    });
});

describe('client address for rate limits', () => {
    let getIpAddress;

    beforeAll(async () => {
        await resetServerModules({ SILLYTAVERN_WHITELIST: JSON.stringify([LOCAL]) });
        ({ getIpAddress } = await import('../src/express-common.js'));
    });

    function fromAddress(remoteAddress, headers) {
        return { socket: { remoteAddress }, headers };
    }

    test.each([
        ['the address that a listed proxy added to X-Forwarded-For', LOCAL, { 'x-forwarded-for': `198.51.100.7, ${CLIENT}` }, `${LOCAL} (forwarded: ${CLIENT})`],
        ['the socket address when X-Real-IP and X-Forwarded-For name different clients', LOCAL, { 'x-real-ip': '198.51.100.7', 'x-forwarded-for': CLIENT }, LOCAL],
        ['the socket address when the socket is not listed', '198.51.100.20', { 'x-real-ip': '198.51.100.7' }, '198.51.100.20'],
        ['one address when the headers name it in different forms', LOCAL, { 'x-real-ip': `::ffff:${CLIENT}`, 'x-forwarded-for': CLIENT }, `${LOCAL} (forwarded: ${CLIENT})`],
        ['the socket address when a forwarded value is not an IP address', LOCAL, { 'x-real-ip': 'garbage' }, LOCAL],
    ])('uses %s', (_name, remoteAddress, headers, expected) => {
        expect(getIpAddress(fromAddress(remoteAddress, headers), true)).toBe(expected);
    });

    test('keeps a separate address for each client behind a listed proxy', () => {
        expect(getIpAddress(fromAddress(LOCAL, { 'x-forwarded-for': CLIENT }), true)).toBe(`${LOCAL} (forwarded: ${CLIENT})`);
        expect(getIpAddress(fromAddress(LOCAL, { 'x-forwarded-for': OTHER_CLIENT }), true)).toBe(`${LOCAL} (forwarded: ${OTHER_CLIENT})`);
    });
});

describe('rate limits behind a proxy', () => {
    let dataRoot;

    beforeAll(() => {
        dataRoot = createTempDirectory('sillybunny-forwarded-rate-limit-');
        globalThis.DATA_ROOT = dataRoot;
    });

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        await closeApps();
        removeTempDirectory(dataRoot);
    });

    describe('basic auth', () => {
        const WRONG_CREDENTIALS = `Basic ${Buffer.from('test-user:wrong-password', 'utf8').toString('base64')}`;

        async function startBasicAuth(whitelist = [LOCAL]) {
            await resetServerModules({
                SILLYTAVERN_BASICAUTHUSER_USERNAME: 'test-user',
                SILLYTAVERN_BASICAUTHUSER_PASSWORD: 'test-password',
                SILLYTAVERN_RATELIMITING_BASICAUTHMAXATTEMPTS: '1',
                SILLYTAVERN_WHITELIST: JSON.stringify(whitelist),
                ...PREFER_REAL_IP,
            });
            const { default: basicAuthMiddleware } = await import('../src/middleware/basicAuth.js');
            return startApp(basicAuthMiddleware);
        }

        async function failWith(app, headers) {
            return (await fetch(app.url, { headers: { ...headers, Authorization: WRONG_CREDENTIALS } })).status;
        }

        test('counts failures against the address that the proxy added when the entries before it change', async () => {
            const app = await startBasicAuth();

            expect(await failWith(app, { 'X-Forwarded-For': `198.51.100.1, ${CLIENT}` })).toBe(401);
            expect(await failWith(app, { 'X-Forwarded-For': `198.51.100.2, ${CLIENT}` })).toBe(429);
        });

        test('counts failures against the proxy when X-Real-IP and X-Forwarded-For name different clients', async () => {
            const app = await startBasicAuth();

            expect(await failWith(app, { 'X-Real-IP': '198.51.100.1', 'X-Forwarded-For': CLIENT })).toBe(401);
            expect(await failWith(app, { 'X-Real-IP': '198.51.100.2', 'X-Forwarded-For': CLIENT })).toBe(429);
        });

        test('counts failures against the socket address when the socket is not listed', async () => {
            const app = await startBasicAuth([LISTED]);

            expect(await failWith(app, { 'X-Real-IP': '198.51.100.1' })).toBe(401);
            expect(await failWith(app, { 'X-Real-IP': '198.51.100.2' })).toBe(429);
        });

        test('keeps separate counts for clients behind a listed proxy', async () => {
            const app = await startBasicAuth();

            expect(await failWith(app, { 'X-Forwarded-For': CLIENT })).toBe(401);
            expect(await failWith(app, { 'X-Forwarded-For': CLIENT })).toBe(429);
            expect(await failWith(app, { 'X-Forwarded-For': OTHER_CLIENT })).toBe(401);
        });
    });

    describe('account login', () => {
        let accountsRoot;

        beforeAll(() => {
            accountsRoot = createTempDirectory('sillybunny-forwarded-accounts-');
        });

        afterAll(() => {
            removeTempDirectory(accountsRoot);
        });

        test('counts attempts against the proxy when X-Real-IP and X-Forwarded-For name different clients', async () => {
            await resetServerModules({
                SILLYTAVERN_RATELIMITING_ACCOUNTSLOGINMAXATTEMPTS: '2',
                SILLYTAVERN_WHITELIST: JSON.stringify([LOCAL]),
                ...PREFER_REAL_IP,
            });
            await seedAccounts(accountsRoot);
            const { router } = await import('../src/endpoints/users-public.js');
            const app = await startApp(express.json(), router);
            const logIn = async realIp => (await fetch(`${app.url}login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Real-IP': realIp, 'X-Forwarded-For': CLIENT },
                body: JSON.stringify({ handle: 'alice', password: 'wrong-password' }),
            })).status;

            expect(await logIn('198.51.100.1')).toBe(403);
            expect(await logIn('198.51.100.2')).toBe(403);
            expect(await logIn('198.51.100.3')).toBe(429);
        });
    });
});
