/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';

import {
    PASSED_BODY,
    callMiddleware,
    closeApps,
    createTempDirectory,
    removeTempDirectory,
    resetServerModules,
    startApp,
    writeErrorPage,
} from './util/middleware-harness.js';
import { MODULE_RELOAD_TIMEOUT_MS } from './util/module-reload-timeout.js';

jest.setTimeout(MODULE_RELOAD_TIMEOUT_MS);

let dockerDetected = false;
jest.unstable_mockModule('is-docker', () => ({ default: () => dockerDetected }));

const LISTED = '192.0.2.10';
const UNLISTED = '203.0.113.9';
const REAL_CLIENT = '127.0.0.1';

async function loadWhitelist(entries, env = {}) {
    await resetServerModules({
        SILLYTAVERN_WHITELIST: JSON.stringify(entries),
        SILLYTAVERN_ENABLEFORWARDEDWHITELIST: 'false',
        SILLYTAVERN_WHITELISTDOCKERHOSTS: 'false',
        ...env,
    });
    const { default: getWhitelistMiddleware } = await import('../src/middleware/whitelist.js');
    return getWhitelistMiddleware();
}

function fromAddress(remoteAddress, overrides = {}) {
    return { socket: { remoteAddress }, headers: {}, path: '/', ...overrides };
}

describe('whitelist middleware', () => {
    let dataRoot;
    let warn;

    beforeAll(() => {
        dataRoot = createTempDirectory('sillybunny-whitelist-');
        writeErrorPage(dataRoot, 'forbidden-by-whitelist.html', 'blocked: {{ipDetails}}');
        globalThis.DATA_ROOT = dataRoot;
    });

    beforeEach(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        await closeApps();
        removeTempDirectory(dataRoot);
    });

    describe('client address table', () => {
        let middleware;

        beforeAll(async () => {
            middleware = await loadWhitelist([
                LISTED,
                '198.51.100.0/24',
                '2001:db8::1',
                '2001:0db8:0000:0000:0000:0000:0000:00ff',
                '2001:db8:1::/48',
                '::1',
            ]);
        });

        test.each([
            ['an address that equals an IPv4 entry', LISTED],
            ['the first address of an IPv4 CIDR entry', '198.51.100.0'],
            ['the last address of an IPv4 CIDR entry', '198.51.100.255'],
            ['a compressed IPv6 address against a compressed entry', '2001:db8::1'],
            ['a full IPv6 address against a compressed entry', '2001:0db8:0000:0000:0000:0000:0000:0001'],
            ['a compressed IPv6 address against a full entry', '2001:db8::ff'],
            ['a full IPv6 address against a full entry', '2001:0db8:0000:0000:0000:0000:0000:00ff'],
            ['an address inside an IPv6 CIDR entry', '2001:db8:1:ffff::1'],
            ['the listed ::1 address', '::1'],
            ['the listed ::1 address in full form', '0:0:0:0:0:0:0:1'],
            ['an IPv4-mapped address against an IPv4 entry', `::ffff:${LISTED}`],
            ['an IPv4-mapped address in hexadecimal form', '::ffff:c000:20a'],
            ['an IPv4-mapped address against an IPv4 CIDR entry', '::ffff:198.51.100.7'],
        ])('lets through %s', async (_name, remoteAddress) => {
            const result = await callMiddleware(middleware, fromAddress(remoteAddress));

            expect(result.passed).toBe(true);
            expect(result.status).toBeUndefined();
        });

        test.each([
            ['the address after an IPv4 entry', '192.0.2.11', '192.0.2.11'],
            ['the address below an IPv4 CIDR entry', '198.51.99.255', '198.51.99.255'],
            ['the address above an IPv4 CIDR entry', '198.51.101.0', '198.51.101.0'],
            ['the address after a compressed IPv6 entry', '2001:db8::2', '2001:db8::2'],
            ['the address before a full IPv6 entry', '2001:db8::fe', '2001:db8::fe'],
            ['an address outside an IPv6 CIDR entry', '2001:db8:2::1', '2001:db8:2::1'],
            ['a different loopback-like IPv6 address', '::2', '::2'],
            ['an IPv4-mapped address without an entry', '::ffff:192.0.2.11', '192.0.2.11'],
            ['127.0.0.1 when only ::1 is listed', '127.0.0.1', '127.0.0.1'],
            ['a mapped 127.0.0.1 when only ::1 is listed', '::ffff:127.0.0.1', '127.0.0.1'],
        ])('answers 403 to %s and names the client', async (_name, remoteAddress, shownAddress) => {
            const result = await callMiddleware(middleware, fromAddress(remoteAddress));

            expect(result.passed).toBe(false);
            expect(result.status).toBe(403);
            expect(result.body).toBe(`blocked: ${shownAddress}`);
        });
    });

    describe('list contents', () => {
        test('blocks every client when the list is empty', async () => {
            const app = await startApp(await loadWhitelist([]));

            const response = await fetch(app.url);

            expect(response.status).toBe(403);
            expect(await response.text()).toBe(`blocked: ${REAL_CLIENT}`);
        });

        test('ignores an invalid entry with a warning and keeps the valid entries', async () => {
            const middleware = await loadWhitelist(['not-an-ip', LISTED]);

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('not-an-ip');
            expect((await callMiddleware(middleware, fromAddress(LISTED))).passed).toBe(true);
            expect((await callMiddleware(middleware, fromAddress(UNLISTED))).status).toBe(403);
        });

        test('lets through the real socket address when it is listed', async () => {
            const app = await startApp(await loadWhitelist([REAL_CLIENT]));

            const response = await fetch(app.url);

            expect(response.status).toBe(200);
            expect(await response.text()).toBe(PASSED_BODY);
        });
    });

    describe('blocked response', () => {
        test('answers 403 with an empty body when the error page does not exist', async () => {
            globalThis.DATA_ROOT = path.join(dataRoot, 'no-such-folder');
            const app = await startApp(await loadWhitelist([]));
            globalThis.DATA_ROOT = dataRoot;

            const response = await fetch(app.url);

            expect(response.status).toBe(403);
            expect(await response.text()).toBe('');
        });

        test('escapes a forwarded value in the shipped error page', async () => {
            const shippedRoot = path.join(dataRoot, 'shipped');
            const shippedPage = new URL('../default/content/errors/forbidden-by-whitelist.html', import.meta.url);
            writeErrorPage(shippedRoot, 'forbidden-by-whitelist.html', fs.readFileSync(shippedPage, 'utf8'));
            globalThis.DATA_ROOT = shippedRoot;
            const app = await startApp(await loadWhitelist([LISTED], { SILLYTAVERN_ENABLEFORWARDEDWHITELIST: 'true' }));
            globalThis.DATA_ROOT = dataRoot;

            const response = await fetch(app.url, { headers: { 'X-Forwarded-For': '<script>alert(1)</script>' } });
            const body = await response.text();

            expect(response.status).toBe(403);
            expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
            expect(body).not.toContain('<script>alert(1)</script>');
        });

        test('logs a blocked connection with its address and user agent', async () => {
            const middleware = await loadWhitelist([LISTED]);

            await callMiddleware(middleware, fromAddress(UNLISTED, { headers: { 'user-agent': 'test-agent' } }));

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain(`Blocked connection from ${UNLISTED}; User Agent: test-agent`);
        });

        test('blocks a favicon request without a log entry', async () => {
            const middleware = await loadWhitelist([LISTED]);

            const result = await callMiddleware(middleware, fromAddress(UNLISTED, { path: '/favicon.ico' }));

            expect(result.status).toBe(403);
            expect(warn).not.toHaveBeenCalled();
        });

        test('does not log an allowed connection', async () => {
            const middleware = await loadWhitelist([LISTED]);

            await callMiddleware(middleware, fromAddress(LISTED));

            expect(warn).not.toHaveBeenCalled();
        });
    });

    describe('forwarding off', () => {
        let listedClient;
        let unlistedClient;

        beforeAll(async () => {
            listedClient = await startApp(await loadWhitelist([REAL_CLIENT]));
            unlistedClient = await startApp(await loadWhitelist([LISTED]));
        });

        test.each([
            ['X-Forwarded-For with one unlisted address', { 'X-Forwarded-For': UNLISTED }],
            ['X-Forwarded-For with several unlisted addresses', { 'X-Forwarded-For': `${UNLISTED}, 203.0.113.10` }],
            ['X-Real-IP with an unlisted address', { 'X-Real-IP': UNLISTED }],
        ])('ignores %s from a listed client', async (_name, headers) => {
            const response = await fetch(listedClient.url, { headers });

            expect(response.status).toBe(200);
            expect(await response.text()).toBe(PASSED_BODY);
        });

        test.each([
            ['X-Forwarded-For with one listed address', { 'X-Forwarded-For': LISTED }],
            ['X-Forwarded-For with several listed addresses', { 'X-Forwarded-For': `${LISTED}, ${LISTED}` }],
            ['X-Real-IP with a listed address', { 'X-Real-IP': LISTED }],
        ])('still blocks an unlisted client that sends %s', async (_name, headers) => {
            const response = await fetch(unlistedClient.url, { headers });

            expect(response.status).toBe(403);
            expect(await response.text()).toBe(`blocked: ${REAL_CLIENT}`);
        });
    });

    describe('forwarding on', () => {
        const FORWARDING = { SILLYTAVERN_ENABLEFORWARDEDWHITELIST: 'true' };
        let listedClient;
        let unlistedClient;

        beforeAll(async () => {
            listedClient = await startApp(await loadWhitelist([REAL_CLIENT, LISTED], FORWARDING));
            unlistedClient = await startApp(await loadWhitelist([LISTED], FORWARDING));
        });

        test.each([
            ['no forwarded header', {}],
            ['X-Forwarded-For with one listed address', { 'X-Forwarded-For': LISTED }],
            ['X-Forwarded-For with several listed addresses', { 'X-Forwarded-For': `${LISTED}, ${REAL_CLIENT}` }],
            ['X-Real-IP with a listed address', { 'X-Real-IP': LISTED }],
            ['CF-Connecting-IP while that header is off', { 'CF-Connecting-IP': UNLISTED }],
        ])('lets through a listed client with %s', async (_name, headers) => {
            const response = await fetch(listedClient.url, { headers });

            expect(response.status).toBe(200);
            expect(await response.text()).toBe(PASSED_BODY);
        });

        test.each([
            ['X-Forwarded-For with one unlisted address', { 'X-Forwarded-For': UNLISTED }],
            ['X-Forwarded-For with an unlisted client and a listed proxy', { 'X-Forwarded-For': `${UNLISTED}, ${LISTED}` }],
            ['X-Real-IP with an unlisted address', { 'X-Real-IP': UNLISTED }],
            ['an unlisted X-Real-IP and a listed X-Forwarded-For', { 'X-Real-IP': UNLISTED, 'X-Forwarded-For': LISTED }],
        ])('blocks a listed client with %s and names both addresses', async (_name, headers) => {
            const response = await fetch(listedClient.url, { headers });

            expect(response.status).toBe(403);
            expect(await response.text()).toBe(`blocked: ${REAL_CLIENT} (forwarded from ${UNLISTED})`);
        });

        test('blocks an unlisted client with a listed forwarded address', async () => {
            const response = await fetch(unlistedClient.url, { headers: { 'X-Forwarded-For': LISTED } });

            expect(response.status).toBe(403);
        });

        test('logs the forwarded address of a blocked connection', async () => {
            await fetch(listedClient.url, { headers: { 'X-Forwarded-For': UNLISTED } });

            expect(warn.mock.calls[0][0]).toContain(`Blocked connection from ${REAL_CLIENT} (forwarded from ${UNLISTED})`);
        });
    });

    describe('forwarded header switches', () => {
        test.each([
            ['X-Real-IP', 'SILLYTAVERN_FORWARDEDHEADERS_XREALIP', { 'X-Real-IP': UNLISTED }],
            ['X-Forwarded-For', 'SILLYTAVERN_FORWARDEDHEADERS_XFORWARDEDFOR', { 'X-Forwarded-For': UNLISTED }],
        ])('ignores %s when its switch is off', async (_name, switchVariable, headers) => {
            const app = await startApp(await loadWhitelist([REAL_CLIENT], {
                SILLYTAVERN_ENABLEFORWARDEDWHITELIST: 'true',
                [switchVariable]: 'false',
            }));

            const response = await fetch(app.url, { headers });

            expect(response.status).toBe(200);
        });

        test('checks CF-Connecting-IP when its switch is on', async () => {
            const app = await startApp(await loadWhitelist([REAL_CLIENT, LISTED], {
                SILLYTAVERN_ENABLEFORWARDEDWHITELIST: 'true',
                SILLYTAVERN_FORWARDEDHEADERS_CFCONNECTINGIP: 'true',
            }));

            const listed = await fetch(app.url, { headers: { 'CF-Connecting-IP': LISTED } });
            const unlisted = await fetch(app.url, { headers: { 'CF-Connecting-IP': UNLISTED } });

            expect(listed.status).toBe(200);
            expect(unlisted.status).toBe(403);
        });
    });

    describe('Docker hosts', () => {
        const DOCKER_HOST = '192.0.2.100';
        const DOCKER_GATEWAY = '192.0.2.101';
        let lookup;

        beforeEach(() => {
            dockerDetected = true;
            lookup = jest.spyOn(dns.promises, 'lookup').mockImplementation(async hostname => ({
                address: hostname === 'host.docker.internal' ? DOCKER_HOST : DOCKER_GATEWAY,
                family: 4,
            }));
        });

        afterEach(() => {
            dockerDetected = false;
        });

        test('adds the addresses of the Docker host names inside Docker', async () => {
            const middleware = await loadWhitelist([], { SILLYTAVERN_WHITELISTDOCKERHOSTS: 'true' });

            expect(lookup.mock.calls.map(([hostname]) => hostname)).toEqual(['host.docker.internal', 'gateway.docker.internal']);
            expect((await callMiddleware(middleware, fromAddress(DOCKER_HOST))).passed).toBe(true);
            expect((await callMiddleware(middleware, fromAddress(DOCKER_GATEWAY))).passed).toBe(true);
            expect((await callMiddleware(middleware, fromAddress(UNLISTED))).status).toBe(403);
        });

        test('warns about a host name that does not resolve and keeps the other address', async () => {
            lookup.mockImplementationOnce(async () => {
                throw new Error('lookup failed');
            });

            const middleware = await loadWhitelist([], { SILLYTAVERN_WHITELISTDOCKERHOSTS: 'true' });

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('host.docker.internal');
            expect((await callMiddleware(middleware, fromAddress(DOCKER_HOST))).status).toBe(403);
            expect((await callMiddleware(middleware, fromAddress(DOCKER_GATEWAY))).passed).toBe(true);
        });

        test('does not resolve the host names when the option is off', async () => {
            const middleware = await loadWhitelist([], { SILLYTAVERN_WHITELISTDOCKERHOSTS: 'false' });

            expect(lookup).not.toHaveBeenCalled();
            expect((await callMiddleware(middleware, fromAddress(DOCKER_HOST))).status).toBe(403);
        });

        test('does not resolve the host names outside Docker', async () => {
            dockerDetected = false;

            await loadWhitelist([], { SILLYTAVERN_WHITELISTDOCKERHOSTS: 'true' });

            expect(lookup).not.toHaveBeenCalled();
        });
    });

    describe('whitelist.txt', () => {
        const originalWorkingDirectory = process.cwd();
        let workingDirectory;

        beforeEach(() => {
            workingDirectory = createTempDirectory('sillybunny-whitelist-txt-');
            process.chdir(workingDirectory);
        });

        afterEach(() => {
            process.chdir(originalWorkingDirectory);
            removeTempDirectory(workingDirectory);
        });

        test('replaces the configured list and warns that it is deprecated', async () => {
            fs.writeFileSync(path.join(workingDirectory, 'whitelist.txt'), '192.0.2.20\r\n\n198.51.100.0/24\n');

            const middleware = await loadWhitelist([LISTED]);

            expect(warn.mock.calls[0][0]).toContain('whitelist.txt is deprecated');
            expect((await callMiddleware(middleware, fromAddress('192.0.2.20'))).passed).toBe(true);
            expect((await callMiddleware(middleware, fromAddress('198.51.100.7'))).passed).toBe(true);
            expect((await callMiddleware(middleware, fromAddress(LISTED))).status).toBe(403);
        });

        test('keeps the configured list when the file cannot be read', async () => {
            fs.mkdirSync(path.join(workingDirectory, 'whitelist.txt'));

            const middleware = await loadWhitelist([LISTED]);

            expect((await callMiddleware(middleware, fromAddress(LISTED))).passed).toBe(true);
            expect((await callMiddleware(middleware, fromAddress(UNLISTED))).status).toBe(403);
        });
    });

    describe('whitelist mode switch', () => {
        let root;

        beforeEach(() => {
            root = createTempDirectory('sillybunny-whitelist-mode-');
        });

        afterEach(() => {
            removeTempDirectory(root);
        });

        async function startAppInMode(configText, args, env) {
            const configPath = path.join(root, 'config.yaml');
            fs.writeFileSync(configPath, configText);
            await resetServerModules({
                SILLYTAVERN_WHITELIST: '[]',
                SILLYTAVERN_WHITELISTDOCKERHOSTS: 'false',
                ...env,
            }, null);
            const { CommandLineParser } = await import('../src/command-line.js');
            const { whitelistMode } = new CommandLineParser().parse([
                'node', 'server.js', '--configPath', configPath, '--dataRoot', path.join(root, 'data'), ...args,
            ]);
            if (!whitelistMode) {
                return startApp();
            }
            const { default: getWhitelistMiddleware } = await import('../src/middleware/whitelist.js');
            return startApp(await getWhitelistMiddleware());
        }

        test.each([
            ['the config file turns the mode off', 'whitelistMode: false\n', [], {}],
            ['the flag turns the mode off over the config file', 'whitelistMode: true\n', ['--whitelist=false'], {}],
            ['the variable turns the mode off over the config file', 'whitelistMode: true\n', [], { SILLYTAVERN_WHITELISTMODE: 'false' }],
        ])('an unlisted client reaches the handler when %s', async (_name, configText, args, env) => {
            const app = await startAppInMode(configText, args, env);

            const response = await fetch(app.url);

            expect(response.status).toBe(200);
            expect(await response.text()).toBe(PASSED_BODY);
        });

        test.each([
            ['the config file turns the mode on', 'whitelistMode: true\n', [], {}],
            ['the flag turns the mode on over the config file', 'whitelistMode: false\n', ['--whitelist'], {}],
            ['the config file does not set the mode', '{}\n', [], {}],
        ])('an unlisted client gets 403 when %s', async (_name, configText, args, env) => {
            const app = await startAppInMode(configText, args, env);

            const response = await fetch(app.url);

            expect(response.status).toBe(403);
        });
    });
});
