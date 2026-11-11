/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
    PASSED_BODY,
    closeApps,
    createTempDirectory,
    removeTempDirectory,
    resetServerModules,
    sendRequest,
    sendRequestWithoutHost,
    startApp,
    writeErrorPage,
} from './util/middleware-harness.js';
import { MODULE_RELOAD_TIMEOUT_MS } from './util/module-reload-timeout.js';

jest.setTimeout(MODULE_RELOAD_TIMEOUT_MS);

const BLOCKED_PAGE = '<h1>host not allowed</h1>';
const ALLOWED_HOST = 'app.example';
const UNTRUSTED_HOST = 'rebind.attacker.example';

async function loadHostWhitelist(env, configPath) {
    await resetServerModules(env, configPath);
    const { default: hostWhitelistMiddleware } = await import('../src/middleware/hostWhitelist.js');
    return hostWhitelistMiddleware;
}

describe('host whitelist middleware', () => {
    let dataRoot;
    let warn;

    beforeAll(() => {
        dataRoot = createTempDirectory('sillybunny-host-whitelist-');
        writeErrorPage(dataRoot, 'host-not-allowed.html', BLOCKED_PAGE);
    });

    beforeEach(() => {
        globalThis.DATA_ROOT = dataRoot;
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        await closeApps();
        removeTempDirectory(dataRoot);
    });

    describe('enabled', () => {
        let app;

        beforeAll(async () => {
            app = await startApp(await loadHostWhitelist({
                SILLYTAVERN_HOSTWHITELIST_ENABLED: 'true',
                SILLYTAVERN_HOSTWHITELIST_HOSTS: JSON.stringify([ALLOWED_HOST, '.wild.example']),
                SILLYTAVERN_HOSTWHITELIST_SCAN: 'false',
            }));
        });

        test.each([
            ['an allowed host without a port', ALLOWED_HOST],
            ['an allowed host with a port', `${ALLOWED_HOST}:8443`],
            ['the domain of a dot-prefixed entry', 'wild.example'],
            ['a subdomain of a dot-prefixed entry', 'api.wild.example:8443'],
            ['a bracketed IPv6 literal without a port', '[::1]'],
            ['a bracketed IPv6 literal with a port', '[2001:db8::1]:8443'],
            ['an IPv4 literal', '192.0.2.10:8443'],
            ['localhost', 'localhost:8443'],
            ['a subdomain of localhost', 'app.localhost'],
        ])('lets through %s', async (_name, host) => {
            const response = await sendRequest(app.port, { Host: host });

            expect(response.status).toBe(200);
            expect(response.body).toBe(PASSED_BODY);
        });

        test.each([
            ['an unlisted host', UNTRUSTED_HOST],
            ['an unlisted host with a port', `${UNTRUSTED_HOST}:8443`],
            ['a host that only starts with an allowed host', `${ALLOWED_HOST}.attacker.example`],
            ['a host that only ends with an allowed host', `not${ALLOWED_HOST}`],
            ['a host that only ends with the text of a dot-prefixed entry', 'badwild.example'],
            ['a bracketed literal that is not IPv6', '[not-an-address]:8443'],
            ['an unterminated bracketed literal', '[::1'],
        ])('answers 403 with the error page to %s', async (_name, host) => {
            const response = await sendRequest(app.port, { Host: host });

            expect(response.status).toBe(403);
            expect(response.headers['content-type']).toBe('text/html');
            expect(response.body).toBe(BLOCKED_PAGE);
        });

        test('lets through a request without a Host header', async () => {
            const response = await sendRequestWithoutHost(app.port);

            expect(response.status).toBe(200);
            expect(response.body).toBe(PASSED_BODY);
        });

        test('does not warn while the scan is off', async () => {
            // No other test sends this host, because the scan warns only once per host.
            await sendRequest(app.port, { Host: 'scan-off.attacker.example' });

            expect(warn).not.toHaveBeenCalled();
        });
    });

    test('answers 403 with an empty body when the error page does not exist', async () => {
        globalThis.DATA_ROOT = path.join(dataRoot, 'no-such-folder');
        const app = await startApp(await loadHostWhitelist({
            SILLYTAVERN_HOSTWHITELIST_ENABLED: 'true',
            SILLYTAVERN_HOSTWHITELIST_HOSTS: JSON.stringify([ALLOWED_HOST]),
            SILLYTAVERN_HOSTWHITELIST_SCAN: 'false',
        }));

        const response = await sendRequest(app.port, { Host: UNTRUSTED_HOST });

        expect(response.status).toBe(403);
        expect(response.body).toBe('');
    });

    describe('configuration source', () => {
        let configDirectory;

        beforeAll(() => {
            configDirectory = createTempDirectory('sillybunny-host-whitelist-config-');
        });

        afterAll(() => {
            removeTempDirectory(configDirectory);
        });

        function writeConfig(text) {
            const configPath = path.join(configDirectory, 'config.yaml');
            fs.writeFileSync(configPath, text);
            return configPath;
        }

        test('reads the hosts and the enabled option from a config file', async () => {
            const configPath = writeConfig(`hostWhitelist:\n  enabled: true\n  scan: false\n  hosts:\n    - ${ALLOWED_HOST}\n`);
            const app = await startApp(await loadHostWhitelist({}, configPath));

            const allowed = await sendRequest(app.port, { Host: ALLOWED_HOST });
            const blocked = await sendRequest(app.port, { Host: UNTRUSTED_HOST });

            expect(allowed.status).toBe(200);
            expect(blocked.status).toBe(403);
        });

        test('lets through only IP literals and localhost when no hosts are configured', async () => {
            const configPath = writeConfig('hostWhitelist:\n  enabled: true\n  scan: false\n');
            const app = await startApp(await loadHostWhitelist({}, configPath));

            const literal = await sendRequest(app.port, { Host: '192.0.2.10' });
            const local = await sendRequest(app.port, { Host: 'localhost' });
            const blocked = await sendRequest(app.port, { Host: ALLOWED_HOST });

            expect(literal.status).toBe(200);
            expect(local.status).toBe(200);
            expect(blocked.status).toBe(403);
        });

        test.each([
            ['the shipped default config', undefined],
            ['a config file without the option', '{}\n'],
            ['a config file that turns the option off', 'hostWhitelist:\n  enabled: false\n'],
        ])('lets through an unlisted host with %s', async (_name, configText) => {
            const configPath = configText === undefined ? undefined : writeConfig(configText);
            const app = await startApp(await loadHostWhitelist({ SILLYTAVERN_HOSTWHITELIST_SCAN: 'false' }, configPath));

            const response = await sendRequest(app.port, { Host: UNTRUSTED_HOST });

            expect(response.status).toBe(200);
            expect(response.body).toBe(PASSED_BODY);
        });
    });

    describe('scan', () => {
        const UNTRUSTED_WARNING = 'Request from untrusted host:';

        function warningTexts() {
            return warn.mock.calls.map(call => call.join(' '));
        }

        function untrustedWarnings() {
            return warningTexts().filter(text => text.includes(UNTRUSTED_WARNING));
        }

        function loadScan(env = {}) {
            return loadHostWhitelist({
                SILLYTAVERN_HOSTWHITELIST_SCAN: 'true',
                SILLYTAVERN_HOSTWHITELIST_HOSTS: JSON.stringify([ALLOWED_HOST]),
                ...env,
            });
        }

        test('warns about an untrusted host and lets it through while the check is off', async () => {
            const app = await startApp(await loadScan());

            const response = await sendRequest(app.port, { Host: UNTRUSTED_HOST });

            expect(response.status).toBe(200);
            const warnings = warningTexts();
            expect(warnings[0]).toContain(UNTRUSTED_WARNING);
            expect(warnings[0]).toContain(UNTRUSTED_HOST);
            expect(warnings.some(text => text.includes('hostWhitelist.hosts'))).toBe(true);
            expect(warnings.some(text => text.includes('hostWhitelist.enabled'))).toBe(true);
            expect(warnings.some(text => text.includes('hostWhitelist.scan'))).toBe(true);
            expect(warnings).toHaveLength(4);
        });

        test('warns and blocks while the check is on, without the advice to turn it on', async () => {
            const app = await startApp(await loadScan({ SILLYTAVERN_HOSTWHITELIST_ENABLED: 'true' }));

            const response = await sendRequest(app.port, { Host: UNTRUSTED_HOST });

            expect(response.status).toBe(403);
            const warnings = warningTexts();
            expect(warnings).toHaveLength(3);
            expect(warnings.some(text => text.includes('hostWhitelist.enabled'))).toBe(false);
            expect(warnings.some(text => text.includes('hostWhitelist.scan'))).toBe(true);
        });

        test('warns once per untrusted host and repeats the setup advice only for the first host', async () => {
            const app = await startApp(await loadScan());

            await sendRequest(app.port, { Host: UNTRUSTED_HOST });
            const firstCount = warn.mock.calls.length;
            await sendRequest(app.port, { Host: UNTRUSTED_HOST });
            expect(warn).toHaveBeenCalledTimes(firstCount);

            await sendRequest(app.port, { Host: 'other.attacker.example' });

            expect(warn).toHaveBeenCalledTimes(firstCount + 2);
            expect(untrustedWarnings()).toHaveLength(2);
        });

        test('does not warn about an allowed host or a request without a Host header', async () => {
            const app = await startApp(await loadScan());

            await sendRequest(app.port, { Host: ALLOWED_HOST });
            await sendRequestWithoutHost(app.port);

            expect(warn).not.toHaveBeenCalled();
        });

        test('stops recording untrusted hosts at 1000 distinct values', async () => {
            const middleware = await loadScan();
            const next = jest.fn();
            const response = { writeHead: () => {}, end: () => {} };

            for (let index = 0; index < 1005; index++) {
                middleware({ headers: { host: `host-${index}.attacker.example` } }, response, next);
            }

            expect(next).toHaveBeenCalledTimes(1005);
            expect(untrustedWarnings()).toHaveLength(1000);
        });
    });
});
