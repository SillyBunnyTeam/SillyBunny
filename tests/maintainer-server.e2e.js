import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { testSetup } from './frontend/frontent-test-utils.js';

test.use({ serviceWorkers: 'block' });

/**
 * Posts to the last-chat route as the page does. The body is invalid on purpose: the real route answers it with a
 * 400 and writes nothing, so only a stub answers 200.
 * @param {import('@playwright/test').Page} page Page
 */
const postInvalidLastChat = page => page.evaluate(async () => {
    const { getRequestHeaders } = await import('/script.js');
    const response = await fetch('/api/characters/last-chat', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ chat: 'not-a-chat' }),
    });
    return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
});

test.describe('protectMaintainerServer', () => {
    test.beforeEach(async ({ page }) => {
        await protectMaintainerServer(page);
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await testSetup.waitForAppReady({ page });
    });

    test('answers the last-chat route like the server does, without reaching it', async ({ page }) => {
        const result = await postInvalidLastChat(page);

        expect(result).toEqual({ status: 200, type: expect.stringContaining('text/plain'), body: 'OK' });
    });

    test('still lets a spec see the last-chat request', async ({ page }) => {
        const request = page.waitForRequest(candidate => new URL(candidate.url()).pathname === '/api/characters/last-chat');

        await postInvalidLastChat(page);

        expect((await request).postDataJSON()).toEqual({ chat: 'not-a-chat' });
    });
});
