/* global globalThis */
import { expect, test } from '@playwright/test';

test.describe('frontend performance smoke', () => {
    test('mobile shell exposes core performance marks and bounded assets', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.addInitScript(() => globalThis.performance.setResourceTimingBufferSize(1000));
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const browserGlobal = globalThis;
            return browserGlobal.document.readyState === 'complete'
                && browserGlobal.performance.getEntriesByType('resource').length > 0;
        });

        const snapshot = await page.evaluate(() => {
            const browserGlobal = globalThis;
            const resources = browserGlobal.performance.getEntriesByType('resource');
            const jsBytes = resources
                .filter(entry => /\.m?js(?:\?|$)/i.test(entry.name))
                .reduce((total, entry) => total + (entry.transferSize || entry.encodedBodySize || 0), 0);
            const cssBytes = resources
                .filter(entry => /\.css(?:\?|$)/i.test(entry.name))
                .reduce((total, entry) => total + (entry.transferSize || entry.encodedBodySize || 0), 0);
            const fontRequests = resources.filter(entry => /\.(?:woff2?|ttf)(?:\?|$)/i.test(entry.name)).length;

            return {
                title: browserGlobal.document.title,
                hasShell: Boolean(browserGlobal.SillyBunnyShell),
                resourceCount: resources.length,
                jsBytes,
                cssBytes,
                fontRequests,
            };
        });

        expect(snapshot.title).toBe('SillyBunny');
        expect(snapshot.hasShell).toBe(true);
        expect(snapshot.resourceCount).toBeLessThan(260);
        expect(snapshot.jsBytes).toBeLessThan(8 * 1024 * 1024);
        expect(snapshot.cssBytes).toBeLessThan(2 * 1024 * 1024);
        expect(snapshot.fontRequests).toBeLessThan(18);
    });
});
