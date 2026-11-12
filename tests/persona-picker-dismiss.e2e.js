import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
// The case boots the whole app, which can use most of the default 30 s when several workers share one server.
test.describe.configure({ timeout: 60_000 });

test('the persona menu ignores a click that the app dispatches and closes on a click outside', async ({ page }) => {
    await openQuietChatForSmoke(page);
    const picker = page.locator('#sb-persona-picker');

    await page.locator('#sb-persona-bubble').click();
    await expect(picker).toBeVisible();

    // The app clicks and focuses the message box a moment after a chat loads. That click is the app's, not the user's.
    await page.evaluate(() => document.getElementById('send_textarea').click());
    await expect(picker).toBeVisible();

    await page.locator('#chat').click({ position: { x: 12, y: 12 } });
    await expect(picker).toHaveCount(0);
});
