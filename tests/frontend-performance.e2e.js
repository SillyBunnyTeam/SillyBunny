/* global globalThis */
import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { requireMetric } from './helpers/require-metric.js';
import { IDLE_BEHIND_SETTINGS, runtimeBudgetsFor, STREAMING_REASONING } from './helpers/runtime-budget.js';
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

// The limits of the idle, streaming and Settings tests are read from `scripts/frontend-perf-budget.json`, the file that
// `perf:frontend` uses, so that each of them has one number. The start-up resource count above is not read from there:
// the measure script counts resources with a different wait and viewport, so its `resourceCount` is another
// measurement. The measure script's `mobile` profile is the 390 px wide viewport of the idle and streaming tests, and
// its `desktop` profile is the 1366 px wide viewport of the Settings test.

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

/**
 * Waits until the page has stopped changing: no deferred sheet is waiting for its activation, and nothing in the
 * document has been mutated for `quietMs`. The app starts work after it is ready, and opening a page starts more: the
 * activation of the deferred sheets (a timer that fires late when the machine is busy), the fit of the Home cards once
 * the fonts arrive, the first build of the page. On a slow machine that work runs for seconds and an idle count that
 * starts after a fixed wait measures it. A page that never becomes quiet is what the idle guard is for, so this fails
 * with its own message instead of measuring.
 * @param {import('@playwright/test').Page} page
 */
async function waitForPageQuiet(page, { quietMs = 600, timeout = 20_000 } = {}) {
    await page.evaluate(({ quiet, limit }) => new Promise((resolve, reject) => {
        const browserGlobal = globalThis;
        const started = browserGlobal.performance.now();
        let lastMutation = started;
        const observer = new browserGlobal.MutationObserver(() => { lastMutation = browserGlobal.performance.now(); });
        observer.observe(browserGlobal.document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        const check = () => {
            const now = browserGlobal.performance.now();
            const waiting = browserGlobal.document.querySelectorAll('link[data-sb-deferred-style]:not([data-sb-panel-style]):not([data-sb-style-activated])').length;
            if (waiting === 0 && now - lastMutation >= quiet) {
                observer.disconnect();
                resolve();
            } else if (now - started > limit) {
                observer.disconnect();
                reject(new Error(`the page behind Settings did not become quiet in ${limit} ms (${waiting} deferred sheets waiting, last change ${Math.round(now - lastMutation)} ms ago)`));
            } else {
                browserGlobal.setTimeout(check, 50);
            }
        };
        check();
    }), { quiet: quietMs, limit: timeout });
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

    test.describe('on a phone', () => {
        // The Home hero art runs its motion on a phone, and that motion keeps running behind the Settings page unless
        // the app pauses it. A desktop browser of the same width does not start the motion, so only a phone context
        // can show whether the page behind Settings is quiet.
        test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

        test('keeps idle recalc and DOM mutations quiet behind open Settings', async ({ page, context }) => {
            test.setTimeout(90_000);
            const pageErrors = [];
            page.on('pageerror', error => pageErrors.push(error.message));

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
                // Without moving art there is nothing behind Settings that could keep running, and the counters
                // below would pass for a page that never had the problem.
                await expect.poll(
                    () => page.evaluate(() => globalThis.document.querySelector('[data-sb-art-motion="playing"]') !== null),
                    { message: 'the Home hero art never started to move', timeout: 30_000 },
                ).toBe(true);

                await page.evaluate(() => globalThis.SillyBunnyShell.openTab('right', 'appearance'));
                await waitForPageQuiet(page);

                const idle = await measureIdleActivity(page, { cdpSession, durationMs: 1500 });
                const label = 'idle behind Settings';
                expect(idle.available).toBe(true);
                for (const { metric, limit } of runtimeBudgetsFor('mobile', IDLE_BEHIND_SETTINGS)) {
                    expect(requireMetric(idle, metric, label), `${label}: ${metric}`).toBeLessThanOrEqual(limit);
                }
                expect(pageErrors).toEqual([]);
            } finally {
                await cdpSession?.detach().catch(() => {});
            }
        });
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
            const label = 'streaming after reasoning';
            expect(stream.available, `streaming measurement unavailable: ${stream.reason}`).toBe(true);
            expect(requireMetric(stream, 'reasoningBytes', label)).toBeGreaterThan(8000);
            // The reasoning UI must have run on every step and rendered the reasoning, or the counters below measure
            // a loop that never reached the code under guard.
            expect(requireMetric(stream, 'reasoningUpdateCount', label)).toBe(fixture.stepCount);
            expect(requireMetric(stream, 'reasoningRenderedChars', label)).toBeGreaterThan(8000);
            for (const { metric, limit } of runtimeBudgetsFor('mobile', STREAMING_REASONING)) {
                expect(requireMetric(stream, metric, label), `${label}: ${metric}`).toBeLessThanOrEqual(limit);
            }
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
            const idle = interaction.idleBehindSettings;
            const label = 'idle after Settings interactions';
            for (const { metric, limit } of runtimeBudgetsFor('desktop', IDLE_BEHIND_SETTINGS)) {
                expect(requireMetric(idle, metric, label), `${label}: ${metric}`).toBeLessThanOrEqual(limit);
            }
            expect(pageErrors).toEqual([]);
        } finally {
            await cdpSession?.detach().catch(() => {});
        }
    });
});
