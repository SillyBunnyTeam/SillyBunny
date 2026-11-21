import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`the diagnostic report's two actions sit in a row and keep their labels on one line at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto('/');
        await waitForAppReady(page);
        // The extension loader adds the stylesheet of the manifest; calling init() directly does not.
        await page.addStyleTag({ url: '/scripts/extensions/sillybunny-debugger/style.css' });
        await page.evaluate(async () => (await import('/scripts/extensions/sillybunny-debugger/index.js')).init());
        const open = page.locator('[data-extension-name="SillyBunny-Debugger"] .ds-button-row', { hasText: 'Diagnostic report' });
        await open.waitFor({ state: 'attached' });
        await open.evaluate(node => node.click());
        const actions = page.locator('.sbdbg-report .sbdbg-actions > .menu_button');
        await expect(actions).toHaveCount(2);
        const boxes = await actions.evaluateAll(nodes => nodes.map(node => {
            const box = node.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(node);
            const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size;
            return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, lines };
        }));
        expect(boxes[0].lines, 'Copy to clipboard is one line').toBe(1);
        expect(boxes[1].lines, 'Download .md is one line').toBe(1);
        expect(Math.abs(boxes[0].top - boxes[1].top), 'the actions share a row').toBeLessThan(1);
        expect(boxes[1].left - boxes[0].right, 'the actions do not touch').toBeGreaterThanOrEqual(5);
    });
}
