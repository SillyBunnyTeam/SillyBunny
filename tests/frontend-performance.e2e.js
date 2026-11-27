/* global globalThis */
import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import {
    createStreamingReasoningFixture,
    measureIdleActivity,
    measureSettingsInteractions,
    measureStreamingWithReasoning,
} from '../scripts/measure-frontend-performance.js';

const coreAssetPaths = [
    '/script.js',
    '/scripts/sillybunny-tabs.js',
    '/style.css',
    '/css/sillybunny-mobile-shell.css',
];

// Guards against growth in the number of requests a start makes. Lower it when a start makes fewer requests; raise it
// only when a change adds a request on purpose.
const STARTUP_RESOURCE_LIMIT = 854;
const STARTUP_JS_BYTE_LIMIT = 13 * 1024 * 1024;

// `querySelectorAll` calls over a 20-step stream that follows a large reasoning block. Page timers and observers run
// during the stream, so the count is page-wide. The limit lies between the count of a build that re-queries the
// message DOM on every streamed update and the count of a build that does not, with room for run-to-run variation.
const STREAMING_QUERY_SELECTOR_ALL_LIMIT = 800;

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

    test('keeps idle recalc and DOM mutations quiet behind open Settings', async ({ page, context }) => {
        test.setTimeout(90_000);
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await waitForAppReady(page, { timeout: 60000 });
        await page.waitForFunction(() => (
            globalThis.document.readyState === 'complete'
            && globalThis.document.getElementById('preloader') === null
            && Boolean(globalThis.SillyBunnyShell?.openTab)
        ), null, { timeout: 60000 });

        let cdpSession = null;
        try {
            cdpSession = await context.newCDPSession(page);
        } catch {
            cdpSession = null;
        }

        try {
            await page.evaluate(async () => {
                await globalThis.SillyBunnyShell.openTab('right', 'appearance');
                await new Promise(resolve => globalThis.setTimeout(resolve, 600));
            });

            const idle = await measureIdleActivity(page, { cdpSession, durationMs: 1500 });
            expect(idle.available).toBe(true);
            expect(idle.runningAnimations).toBe(0);
            expect(idle.mutationCallbacks).toBeLessThanOrEqual(10);
            expect(idle.cdp?.recalcStyleCount ?? 0).toBeLessThanOrEqual(6);
            expect(idle.cdp?.layoutCount ?? 0).toBeLessThanOrEqual(6);
            expect(pageErrors).toEqual([]);
        } finally {
            await cdpSession?.detach().catch(() => {});
        }
    });

    test('bounds layout reads and style recalc during streaming after a large reasoning block', async ({ page, context }) => {
        test.setTimeout(90_000);
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await waitForAppReady(page, { timeout: 60000 });
        await page.waitForFunction(() => (
            globalThis.document.readyState === 'complete'
            && globalThis.document.getElementById('preloader') === null
            && typeof globalThis.SillyTavern?.getContext === 'function'
        ), null, { timeout: 60000 });

        let cdpSession = null;
        try {
            cdpSession = await context.newCDPSession(page);
        } catch {
            cdpSession = null;
        }

        try {
            const fixture = createStreamingReasoningFixture({ stepCount: 20, reasoningRepeat: 320, responseRepeat: 24 });
            const stream = await measureStreamingWithReasoning(page, fixture, { cdpSession });
            expect(stream.available, `streaming measurement unavailable: ${stream.reason}`).toBe(true);
            expect(stream.reasoningBytes).toBeGreaterThan(8000);
            // The reasoning UI must have run on every step and rendered the reasoning, or the counters below measure
            // a loop that never reached the code under guard.
            expect(stream.reasoningUpdateCount).toBe(fixture.stepCount);
            expect(stream.reasoningRenderedChars).toBeGreaterThan(8000);
            expect(stream.getBoundingClientRectCount).toBeLessThanOrEqual(250);
            expect(stream.querySelectorAllCount).toBeLessThanOrEqual(STREAMING_QUERY_SELECTOR_ALL_LIMIT);
            expect(stream.cdp?.recalcStyleCount ?? 0).toBeLessThanOrEqual(120);
            expect(pageErrors).toEqual([]);
        } finally {
            await cdpSession?.detach().catch(() => {});
        }
    });

    test('keeps Settings, Extensions, and search interactions bounded without page errors', async ({ page, context }) => {
        test.setTimeout(90_000);
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));

        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await waitForAppReady(page, { timeout: 60000 });
        await page.waitForFunction(() => (
            globalThis.document.readyState === 'complete'
            && globalThis.document.getElementById('preloader') === null
            && Boolean(globalThis.SillyBunnyShell?.openTab)
        ), null, { timeout: 60000 });

        let cdpSession = null;
        try {
            cdpSession = await context.newCDPSession(page);
        } catch {
            cdpSession = null;
        }

        try {
            const interaction = await measureSettingsInteractions(page, { cdpSession, idleDurationMs: 1000 });
            expect(interaction.available).toBe(true);
            expect(interaction.tabsVisited).toEqual(expect.arrayContaining(['extensions', 'editor', 'appearance']));
            expect(interaction.idleBehindSettings?.available).toBe(true);
            expect(interaction.idleBehindSettings.runningAnimations).toBe(0);
            expect(interaction.idleBehindSettings.mutationCallbacks).toBeLessThanOrEqual(10);
            expect(interaction.idleBehindSettings.cdp?.recalcStyleCount ?? 0).toBeLessThanOrEqual(6);
            expect(interaction.idleBehindSettings.cdp?.layoutCount ?? 0).toBeLessThanOrEqual(6);
            expect(pageErrors).toEqual([]);
        } finally {
            await cdpSession?.detach().catch(() => {});
        }
    });
});
