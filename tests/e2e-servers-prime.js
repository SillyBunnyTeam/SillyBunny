import { chromium } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { SERVER_LIST_VARIABLE } from './e2e-servers.js';

/**
 * Boots the app once on each server that the config started. The first boot on a fresh data root does the
 * first-run work, and without this boot the first test of each worker runs out of time.
 */
export default async function primeServers() {
    const servers = JSON.parse(process.env[SERVER_LIST_VARIABLE]);
    const browser = await chromium.launch();
    try {
        await Promise.all(servers.map(async ({ url }) => {
            const context = await browser.newContext({ baseURL: url });
            // All servers do their first boot at the same time, which can take longer than the default 30 s.
            context.setDefaultTimeout(180_000);
            await testSetup.awaitST({ page: await context.newPage() });
            await context.close();
        }));
    } finally {
        await browser.close();
    }
}
