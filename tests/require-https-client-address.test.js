import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { callMiddleware, closeApps, resetServerModules, sendRequest, startApp } from './util/middleware-harness.js';

const REMOTE = '198.51.100.20';
const LISTED_PROXY = '192.0.2.50';
const CLIENT = '203.0.113.9';

function fromAddress(ip, hostname, headers = {}) {
    return { ip, hostname, secure: false, headers: { host: hostname, ...headers } };
}

describe('requireHttps client address', () => {
    let middleware;
    let app;

    beforeAll(async () => {
        await resetServerModules({
            SILLYTAVERN_REQUIREHTTPS: 'true',
            SILLYTAVERN_WHITELIST: JSON.stringify(['127.0.0.1', LISTED_PROXY]),
        });
        ({ default: middleware } = await import('../src/middleware/requireHttps.js'));
        app = await startApp(middleware);
    });

    afterAll(async () => {
        await closeApps();
    });

    test.each([
        ['localhost', 'localhost'],
        ['a name that starts with 127.', '127.app.example'],
    ])('answers 403 to plain HTTP from a remote client whose Host header is %s', async (_name, hostname) => {
        const result = await callMiddleware(middleware, fromAddress(REMOTE, hostname));

        expect(result.passed).toBe(false);
        expect(result.status).toBe(403);
    });

    test('answers 403 to X-Forwarded-Proto from a client that is not a listed proxy', async () => {
        const result = await callMiddleware(middleware, fromAddress(REMOTE, 'app.example', { 'x-forwarded-proto': 'https' }));

        expect(result.status).toBe(403);
    });

    test('lets through X-Forwarded-Proto from a listed proxy on another machine', async () => {
        const result = await callMiddleware(middleware, fromAddress(LISTED_PROXY, 'app.example', { 'x-forwarded-proto': 'https', 'x-forwarded-for': CLIENT }));

        expect(result.passed).toBe(true);
    });

    test.each([
        ['a remote host name', 'app.example'],
        ['a bracketed IPv6 loopback literal', '[::1]'],
        ['a bracketed IPv6 loopback literal with a port', '[::1]:8080'],
    ])('lets through plain HTTP from this machine with %s in the Host header', async (_name, host) => {
        const response = await sendRequest(app.port, { Host: host });

        expect(response.status).toBe(200);
    });

    test('answers 403 to plain HTTP that a proxy on this machine forwards, whatever the Host header says', async () => {
        const response = await sendRequest(app.port, { Host: 'localhost', 'X-Forwarded-For': CLIENT });

        expect(response.status).toBe(403);
    });

    test('lets through a forwarded request when the first X-Forwarded-Proto value is https', async () => {
        const response = await sendRequest(app.port, { Host: 'app.example', 'X-Forwarded-For': CLIENT, 'X-Forwarded-Proto': 'https, http' });

        expect(response.status).toBe(200);
    });

    test('answers 403 to a forwarded request that a proxy on this machine marks as HTTP', async () => {
        const response = await sendRequest(app.port, { Host: 'app.example', 'X-Forwarded-For': CLIENT, 'X-Forwarded-Proto': 'http' });

        expect(response.status).toBe(403);
    });
});
