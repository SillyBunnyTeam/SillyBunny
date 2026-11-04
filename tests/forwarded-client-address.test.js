/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    callMiddleware,
    closeApps,
    createTempDirectory,
    removeTempDirectory,
    resetServerModules,
    startApp,
    writeErrorPage,
} from './util/middleware-harness.js';

const LOCAL = '127.0.0.1';
const LISTED = '192.0.2.10';
const CLIENT = '203.0.113.9';

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
