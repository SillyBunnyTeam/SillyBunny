import { expect, test } from '@playwright/test';
import { bootMiscDialogs, MISC_VIEWPORTS } from './helpers/misc-dialogs.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.setTimeout(90000);
test.use({ serviceWorkers: 'block' });

for (const viewport of MISC_VIEWPORTS) {
    test(`the Extensions manager with no installed extension shows the empty status page at ${viewport.width}px`, async ({ page }) => {
        await page.route('**/api/extensions/discover*', async route => {
            const extensions = await fetchJsonOrSkip(route);
            if (!extensions) return;
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        });
        await bootMiscDialogs(page, viewport, { admin: false });
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
        await page.locator('#extensions_details').waitFor({ state: 'visible' });
        await page.locator('#extensions_details').click();
        const installed = page.locator('.extensions_info .sb-extensions-section', { has: page.getByText('Installed Extensions', { exact: true }) });
        await expect(installed.locator('.extension_block')).toHaveCount(0);
        const status = installed.locator('.ds-pref-group > .sb-status-page');
        await expect(status).toBeVisible();
        await expect(status).toHaveAttribute('data-state', 'empty');
        await expect(status.locator('.sb-status-page__title')).toHaveText('No Installed Extensions');
        // With nothing installed there is nothing to bulk toggle.
        await expect(installed.getByText('Toggle extensions', { exact: true })).toBeHidden();
    });
}
