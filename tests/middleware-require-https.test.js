import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
    PASSED_BODY,
    callMiddleware,
    closeApps,
    createTempDirectory,
    removeTempDirectory,
    resetServerModules,
    sendRequest,
    sendRequestWithoutHost,
    startApp,
} from './util/middleware-harness.js';
import { MODULE_RELOAD_TIMEOUT_MS } from './util/module-reload-timeout.js';

jest.setTimeout(MODULE_RELOAD_TIMEOUT_MS);

const REMOTE_HOST = 'app.example';
// The test requests come from 127.0.0.1, so they name a remote client in X-Forwarded-For, as a reverse proxy on this machine would.
const FROM_REMOTE_CLIENT = { 'X-Forwarded-For': '192.0.2.10' };

async function loadRequireHttps(env, configPath) {
    await resetServerModules(env, configPath);
    const { default: requireHttpsMiddleware } = await import('../src/middleware/requireHttps.js');
    return requireHttpsMiddleware;
}

describe('requireHttps middleware', () => {
    afterAll(async () => {
        await closeApps();
    });

    describe('when on', () => {
        let middleware;
        let app;

        beforeAll(async () => {
            middleware = await loadRequireHttps({ SILLYTAVERN_REQUIREHTTPS: 'true' });
            app = await startApp(middleware);
        });

        test.each([
            ['a remote host', REMOTE_HOST],
            ['a remote host with a port', `${REMOTE_HOST}:8443`],
            ['a remote IPv4 literal', '192.0.2.10:8443'],
        ])('answers 403 with a JSON error to plain HTTP from a remote client for %s', async (_name, host) => {
            const response = await sendRequest(app.port, { Host: host, ...FROM_REMOTE_CLIENT });

            expect(response.status).toBe(403);
            expect(response.headers['content-type']).toContain('application/json');
            expect(JSON.parse(response.body).error).toContain('HTTPS is required');
        });

        test.each([
            ['localhost', 'localhost'],
            ['localhost with a port', 'localhost:8443'],
            ['127.0.0.1', '127.0.0.1'],
            ['127.0.0.1 with a port', '127.0.0.1:8443'],
            ['another address in 127.0.0.0/8', '127.1.2.3:8443'],
        ])('lets through plain HTTP for %s', async (_name, host) => {
            const response = await sendRequest(app.port, { Host: host });

            expect(response.status).toBe(200);
            expect(response.body).toBe(PASSED_BODY);
        });

        test('lets through a local request without a Host header because of its client address', async () => {
            const response = await sendRequestWithoutHost(app.port);

            expect(response.status).toBe(200);
            expect(response.body).toBe(PASSED_BODY);
        });

        test('lets through a remote host that a reverse proxy marks as HTTPS', async () => {
            const response = await sendRequest(app.port, { Host: REMOTE_HOST, 'X-Forwarded-Proto': 'https' });

            expect(response.status).toBe(200);
            expect(response.body).toBe(PASSED_BODY);
        });

        test('answers 403 to a remote host that a reverse proxy marks as HTTP', async () => {
            const response = await sendRequest(app.port, { Host: REMOTE_HOST, 'X-Forwarded-Proto': 'http' });

            expect(response.status).toBe(403);
        });

        test('lets through a direct HTTPS connection to a remote host', async () => {
            const result = await callMiddleware(middleware, { hostname: REMOTE_HOST, secure: true, headers: {} });

            expect(result.passed).toBe(true);
        });

        test.each([
            ['127.0.0.1'],
            ['127.1.2.3'],
            ['::1'],
            ['::ffff:127.0.0.1'],
        ])('lets through plain HTTP without a host name from the client address %s', async (ip) => {
            const result = await callMiddleware(middleware, { hostname: undefined, ip, secure: false, headers: {} });

            expect(result.passed).toBe(true);
        });

        test('answers 403 to plain HTTP without a host name from a remote client address', async () => {
            const result = await callMiddleware(middleware, { hostname: undefined, ip: '192.0.2.10', secure: false, headers: {} });

            expect(result.passed).toBe(false);
            expect(result.status).toBe(403);
        });

        test('answers 403 when the request has no host name and no client address', async () => {
            const result = await callMiddleware(middleware, { hostname: undefined, ip: undefined, secure: false, headers: {} });

            expect(result.status).toBe(403);
        });
    });

    describe('when off', () => {
        test.each([
            ['the variable is false', { SILLYTAVERN_REQUIREHTTPS: 'false' }],
            ['the shipped default config does not turn it on', {}],
        ])('lets through plain HTTP for a remote host when %s', async (_name, env) => {
            const app = await startApp(await loadRequireHttps(env));

            const response = await sendRequest(app.port, { Host: REMOTE_HOST });

            expect(response.status).toBe(200);
            expect(response.body).toBe(PASSED_BODY);
        });
    });

    describe('config file', () => {
        let configDirectory;

        beforeAll(() => {
            configDirectory = createTempDirectory('sillybunny-require-https-');
        });

        afterAll(() => {
            removeTempDirectory(configDirectory);
        });

        test.each([
            ['on', 'requireHttps: true\n', 403],
            ['off', 'requireHttps: false\n', 200],
            ['absent', '{}\n', 200],
        ])('applies the requireHttps option when it is %s', async (_name, configText, expectedStatus) => {
            const configPath = path.join(configDirectory, 'config.yaml');
            fs.writeFileSync(configPath, configText);
            const app = await startApp(await loadRequireHttps({}, configPath));

            const response = await sendRequest(app.port, { Host: REMOTE_HOST, ...FROM_REMOTE_CLIENT });

            expect(response.status).toBe(expectedStatus);
        });
    });
});
