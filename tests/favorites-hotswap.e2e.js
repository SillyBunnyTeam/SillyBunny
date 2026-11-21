import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

for (const width of [1440, 768, 375]) {
    test(`favorites use the reachable list filter, not the retired hotswap strip at ${width}px`, async ({ page }) => {
        await protectMaintainerServer(page);
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        await page.waitForFunction(() => !document.getElementById('preloader') && window.SillyBunnyShell);
        for (const tab of ['characters', 'groups', 'editor', 'world-info', 'persona', 'import']) {
            await page.evaluate(async tab => { await window.SillyBunnyShell.openTab('characters', tab); }, tab);
            await expect(page.locator('#CharListButtonAndHotSwaps')).toBeHidden();
        }
        await page.evaluate(async () => { await window.SillyBunnyShell.openTab('characters', 'characters'); });
        const filter = page.locator('.sb-character-list .filterByFavorites');
        await expect(filter).toBeVisible();
        const initial = await filter.getAttribute('class');
        await filter.click();
        await expect(filter).not.toHaveAttribute('class', initial);
        await expect(page.locator('#CharListButtonAndHotSwaps')).toBeHidden();
    });
}
