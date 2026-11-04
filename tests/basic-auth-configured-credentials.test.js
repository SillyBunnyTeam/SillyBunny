/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

import { closeApps, createTempDirectory, removeTempDirectory, resetServerModules, startApp } from './util/middleware-harness.js';
import { MODULE_RELOAD_TIMEOUT_MS } from './util/module-reload-timeout.js';

const USERNAME = 'test-user';
const PASSWORD = 'test-password';

function basicHeader(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function startBasicAuth(username, password) {
    await resetServerModules({
        SILLYTAVERN_BASICAUTHUSER_USERNAME: username,
        SILLYTAVERN_BASICAUTHUSER_PASSWORD: password,
        SILLYTAVERN_RATELIMITING_BASICAUTHMAXATTEMPTS: '0',
    });
    const { default: basicAuthMiddleware } = await import('../src/middleware/basicAuth.js');
    return startApp(basicAuthMiddleware);
}

async function statusFor(app, username, password) {
    return (await fetch(app.url, { headers: { Authorization: basicHeader(username, password) } })).status;
}

describe('basic auth configured credentials', () => {
    let dataRoot;

    beforeAll(() => {
        dataRoot = createTempDirectory('sillybunny-basic-auth-credentials-');
        globalThis.DATA_ROOT = dataRoot;
    });

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        await closeApps();
        removeTempDirectory(dataRoot);
    });

    test.each([
        ['an empty username and password', '', ''],
        ['an empty username', '', PASSWORD],
        ['an empty password', USERNAME, ''],
    ])('answers 401 to the configured values when the configured user has %s', async (_name, username, password) => {
        const app = await startBasicAuth(username, password);

        expect(await statusFor(app, username, password)).toBe(401);
    }, MODULE_RELOAD_TIMEOUT_MS);

    describe('comparison', () => {
        let app;

        beforeAll(async () => {
            app = await startBasicAuth(USERNAME, PASSWORD);
        }, MODULE_RELOAD_TIMEOUT_MS);

        test.each([
            ['a wrong username of another length', 'someone-else', PASSWORD, 401],
            ['a wrong password of another length', USERNAME, 'a-much-longer-wrong-password', 401],
            ['the configured credentials', USERNAME, PASSWORD, 200],
        ])('compares both configured values with crypto.timingSafeEqual for %s', async (_name, username, password, status) => {
            const timingSafeEqual = jest.spyOn(crypto, 'timingSafeEqual');

            expect(await statusFor(app, username, password)).toBe(status);
            expect(timingSafeEqual).toHaveBeenCalledTimes(2);
        });
    });
});
