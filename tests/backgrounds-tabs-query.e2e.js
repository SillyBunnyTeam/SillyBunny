import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const PANEL_IDS = ['bg_global_tab', 'bg_chat_tab'];

/** Boots the app past first run, which is when `initBackgrounds()` runs. */
async function skipFirstRun(page) {
    await page.route('**/api/settings/get', async route => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        applyWelcomeSettings(settings);
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
}

/**
 * Records every request that is not a navigation and that asks for the app document.
 * The initial navigation is excluded; a tab load of the page itself is not.
 */
function recordDocumentRequests(page) {
    const state = { requests: [], pending: new Set() };
    page.on('request', request => {
        if (request.isNavigationRequest() || new URL(request.url()).pathname !== '/') return;
        state.requests.push(request.url());
        state.pending.add(request);
    });
    const settle = request => state.pending.delete(request);
    page.on('requestfinished', settle);
    page.on('requestfailed', settle);
    return state;
}

async function openApp(page, path) {
    await protectMaintainerServer(page);
    await skipFirstRun(page);
    const documentRequests = recordDocumentRequests(page);
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#bg_tabs.ui-tabs')).toBeAttached({ timeout: STARTUP_TIMEOUT });
    return documentRequests;
}

async function openBackgroundsPage(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
    await page.locator('button[data-sb-settings-tab="appearance"]').evaluate(button => button.click());
    await expect(page.locator('#bg_tabs')).toBeVisible();
}

/** Checks that the page holds one app and the tabs sit on their own panels, after any stray load of the app document has ended. */
async function expectStandaloneTabs(page, documentRequests) {
    await expect.poll(() => documentRequests.pending.size, { timeout: STARTUP_TIMEOUT }).toBe(0);
    await expect(page.locator('[id="sheld"]')).toHaveCount(1);
    await expect(page.locator('[id="chat"]')).toHaveCount(1);
    await expect(page.locator('#bg_tabs > .ui-tabs-panel')).toHaveCount(PANEL_IDS.length);
    expect(await page.locator('#bg_tabs > .ui-tabs-panel').evaluateAll(panels => panels.map(panel => panel.id))).toEqual(PANEL_IDS);
    await expect(page.locator('.ui-tabs-panel[id^="ui-id-"]')).toHaveCount(0);
    await expect(page.locator('#bg_tabs > .ui-tabs-panel[aria-live]')).toHaveCount(0);
}

async function expectActivePanel(page, activeId) {
    for (const id of PANEL_IDS) {
        const panel = page.locator(`#bg_tabs > #${id}`);
        if (id === activeId) await expect(panel).toBeVisible();
        else await expect(panel).toBeHidden();
    }
}

async function switchTab(page, documentRequests, panelId) {
    await page.locator(`#bg_tabs a[href="#${panelId}"]`).click();
    await expectActivePanel(page, panelId);
    await expectStandaloneTabs(page, documentRequests);
}

test.describe('Backgrounds tabs with a query string', () => {
    test('a query string leaves the Backgrounds tabs on their own panels', async ({ page }) => {
        const documentRequests = await openApp(page, '/?x=1');
        await expectStandaloneTabs(page, documentRequests);
        expect(documentRequests.requests).toEqual([]);
    });

    test('tabs keep working after the URL loses its query string', async ({ page }) => {
        const documentRequests = await openApp(page, '/?x=1');
        await expectStandaloneTabs(page, documentRequests);
        await page.evaluate(() => history.replaceState({}, '', '/'));
        await openBackgroundsPage(page);

        await switchTab(page, documentRequests, 'bg_chat_tab');
        await switchTab(page, documentRequests, 'bg_global_tab');
        expect(documentRequests.requests).toEqual([]);
    });

    test('tabs keep working after the URL gains a query string', async ({ page }) => {
        const documentRequests = await openApp(page, '/');
        await expectStandaloneTabs(page, documentRequests);
        await page.evaluate(() => history.replaceState({}, '', '/?x=1'));
        await openBackgroundsPage(page);

        await switchTab(page, documentRequests, 'bg_chat_tab');
        await switchTab(page, documentRequests, 'bg_global_tab');
        expect(documentRequests.requests).toEqual([]);
    });

    test('without a query string the tabs stay on their own panels', async ({ page }) => {
        const documentRequests = await openApp(page, '/');
        await expectStandaloneTabs(page, documentRequests);
        await openBackgroundsPage(page);

        await switchTab(page, documentRequests, 'bg_chat_tab');
        await switchTab(page, documentRequests, 'bg_global_tab');
        expect(documentRequests.requests).toEqual([]);
    });
});
