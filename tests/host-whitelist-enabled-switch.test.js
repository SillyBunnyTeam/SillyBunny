/* global globalThis */
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { closeApps, createTempDirectory, removeTempDirectory, resetServerModules, sendRequest, startApp } from './util/middleware-harness.js';
import { MODULE_RELOAD_TIMEOUT_MS } from './util/module-reload-timeout.js';

describe('host whitelist enabled switch', () => {
    let dataRoot;

    beforeAll(() => {
        dataRoot = createTempDirectory('sillybunny-host-whitelist-switch-');
        globalThis.DATA_ROOT = dataRoot;
    });

    afterAll(async () => {
        await closeApps();
        removeTempDirectory(dataRoot);
    });

    test.each([
        ['false'],
        [' FALSE '],
    ])('lets through an unlisted host when SILLYTAVERN_HOSTWHITELIST_ENABLED is %j', async (value) => {
        await resetServerModules({
            SILLYTAVERN_HOSTWHITELIST_ENABLED: value,
            SILLYTAVERN_HOSTWHITELIST_HOSTS: JSON.stringify(['app.example']),
            SILLYTAVERN_HOSTWHITELIST_SCAN: 'false',
        });
        const { default: hostWhitelistMiddleware } = await import('../src/middleware/hostWhitelist.js');
        const app = await startApp(hostWhitelistMiddleware);

        const response = await sendRequest(app.port, { Host: 'unlisted.example' });

        expect(response.status).toBe(200);
    }, MODULE_RELOAD_TIMEOUT_MS);
});
