import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { waitForAppReady } from './helpers/app-ready.js';

// The page's own requests are the subject, so no service worker may answer them.
test.use({ serviceWorkers: 'block' });

test('the sheets of the Characters list are requested while its module is still loading', async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));

    let releaseModule;
    const moduleHeld = new Promise(resolve => { releaseModule = resolve; });
    const listSheetRequests = [];
    page.on('request', request => {
        if (/\/css\/sillybunny-character-list\.css/.test(request.url())) listSheetRequests.push(request.url());
    });
    await page.route('**/scripts/sillybunny-character-list.js', async route => {
        await moduleHeld;
        await route.continue();
    });

    await page.locator('#sb-character-toggle').click();
    // The sheet waits behind the module and everything the module imports when it is asked for only after they arrive,
    // which is one more round trip before the list can show.
    await expect.poll(() => listSheetRequests.length, { message: 'the list sheet is requested while the module is held' }).toBeGreaterThan(0);

    releaseModule();
    await expect(page.locator('.sb-character-list')).toBeVisible();
});
