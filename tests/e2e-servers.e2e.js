import { expect, test } from '@playwright/test';
import { SERVER_LIST_VARIABLE, getServerUrl } from './e2e-servers.js';

const servers = process.env[SERVER_LIST_VARIABLE] ? JSON.parse(process.env[SERVER_LIST_VARIABLE]) : null;
const baseUrlAtLoad = process.env.SILLYBUNNY_TEST_BASE_URL;

test.describe('test servers that the config starts', () => {
    // eslint-disable-next-line playwright/no-skipped-test -- A run against one server that runs already has nothing to route.
    test.skip(!servers, 'runs only when SILLYBUNNY_TEST_SERVERS starts the servers');

    // If a Playwright update stops importing the config in each worker, every worker would use the same server.
    test('a worker uses the server of its parallel index', async ({ page, baseURL }, testInfo) => {
        const expected = getServerUrl(servers, testInfo.parallelIndex);
        expect(baseURL).toBe(expected);
        expect(baseUrlAtLoad).toBe(expected);

        const response = await page.goto('/');
        expect(new URL(response.url()).origin).toBe(expected);
    });
});
