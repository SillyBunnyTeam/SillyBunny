/* global globalThis */
import { expect, test } from '@playwright/test';

const coreAssetPaths = [
    '/script.js',
    '/scripts/sillybunny-tabs.js',
    '/style.css',
    '/css/sillybunny-mobile-shell.css',
];

// Guards against growth in the number of requests a start makes. Lower it when a start makes fewer requests; raise it
// only when a change adds a request on purpose.
const STARTUP_RESOURCE_LIMIT = 873;
const STARTUP_JS_BYTE_LIMIT = 13 * 1024 * 1024;

// The first start of a day for an admin account asks the server for the install type and then saves the notice stamp
// to the account settings (`sillybunny-install-notice.js`), so a start that runs before any other start of that
// account makes two more requests (`/api/server-admin/install-type`, `/api/settings/save`). Which test sees them
// depends on which start of a shared server came first. This start runs in a separate browser context until the
// stamp is stored, so the measured start is a repeat start and its count is the same on every run.
async function storeFirstStartState(browser, baseURL) {
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
    try {
        const page = await context.newPage();
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('load', { timeout: 60000 });
        await expect.poll(() => page.evaluate(async () => {
            const { token } = await (await fetch('/csrf-token')).json();
            const response = await fetch('/api/settings/get', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                body: '{}',
            });
            const body = await response.json();
            return Boolean(JSON.parse(body.settings || '{}').accountStorage?.sillybunny_install_notice);
        }), { timeout: 30000, intervals: [500] }).toBe(true);
    } finally {
        await context.close();
    }
}

async function waitForResourceStability(page) {
    let previousCount = -1;
    let stableSamples = 0;

    await expect.poll(async () => {
        const resourceCount = await page.evaluate(() => globalThis.performance.getEntriesByType('resource').length);
        stableSamples = resourceCount > 0 && resourceCount === previousCount ? stableSamples + 1 : 0;
        previousCount = resourceCount;
        return stableSamples;
    }, {
        timeout: 15000,
        intervals: [250, 250, 500, 500],
    }).toBeGreaterThanOrEqual(3);
}

test.describe('frontend performance smoke', () => {
    // The byte budgets are for compressed transfers, which browsers ask for. A test run can ask for uncompressed
    // responses to save server time, and then the same assets transfer more bytes.
    test.use({ extraHTTPHeaders: { 'Accept-Encoding': 'gzip, deflate, br' } });

    test('mobile shell exposes core performance marks and bounded assets', async ({ page, browser, baseURL }) => {
        // Two starts (the first stores the daily notice stamp), each allowed 60s to load under a busy machine.
        test.setTimeout(150_000);
        await storeFirstStartState(browser, baseURL);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.addInitScript(() => globalThis.performance.setResourceTimingBufferSize(1000));
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('load', { timeout: 60000 });
        await page.waitForFunction(() => {
            const browserGlobal = globalThis;
            return browserGlobal.document.readyState === 'complete'
                && browserGlobal.document.getElementById('preloader') === null
                && typeof browserGlobal.SillyTavern?.getContext === 'function'
                && Boolean(browserGlobal.SillyBunnyShell);
        }, null, { timeout: 60000 });
        await waitForResourceStability(page);

        const snapshot = await page.evaluate((expectedCoreAssetPaths) => {
            const browserGlobal = globalThis;
            const resources = browserGlobal.performance.getEntriesByType('resource');
            const jsBytes = resources
                .filter(entry => /\.m?js(?:\?|$)/i.test(entry.name))
                .reduce((total, entry) => total + (entry.transferSize || entry.encodedBodySize || 0), 0);
            const cssBytes = resources
                .filter(entry => /\.css(?:\?|$)/i.test(entry.name))
                .reduce((total, entry) => total + (entry.transferSize || entry.encodedBodySize || 0), 0);
            const fontRequests = resources.filter(entry => /\.(?:woff2?|ttf)(?:\?|$)/i.test(entry.name)).length;
            const coreAssetBytes = Object.fromEntries(expectedCoreAssetPaths.map(assetPath => [assetPath, 0]));

            for (const resource of resources) {
                const assetPath = new browserGlobal.URL(resource.name).pathname;
                if (Object.prototype.hasOwnProperty.call(coreAssetBytes, assetPath)) {
                    coreAssetBytes[assetPath] = Math.max(
                        coreAssetBytes[assetPath],
                        resource.transferSize || resource.encodedBodySize || resource.decodedBodySize || 0,
                    );
                }
            }

            return {
                title: browserGlobal.document.title,
                hasShell: Boolean(browserGlobal.SillyBunnyShell),
                resourceCount: resources.length,
                jsBytes,
                cssBytes,
                fontRequests,
                coreAssetBytes,
            };
        }, coreAssetPaths);

        expect(snapshot.title).toBe('SillyBunny');
        expect(snapshot.hasShell).toBe(true);
        expect(snapshot.resourceCount).toBeLessThanOrEqual(STARTUP_RESOURCE_LIMIT);
        expect(snapshot.jsBytes).toBeGreaterThan(0);
        expect(snapshot.jsBytes).toBeLessThan(STARTUP_JS_BYTE_LIMIT);
        expect(snapshot.cssBytes).toBeGreaterThan(0);
        expect(snapshot.cssBytes).toBeLessThan(2 * 1024 * 1024);
        expect(snapshot.fontRequests).toBeLessThan(18);
        for (const assetPath of coreAssetPaths) {
            expect(snapshot.coreAssetBytes[assetPath]).toBeGreaterThan(0);
        }
    });
});
