import { expect, test } from '@playwright/test';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { showSettingsSidebar } from './helpers/settings-phone-pane.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

async function loadApp(page, baseURL, { viewport }) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let version = Date.now();
    const readEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/extensions/discover') {
            const extensions = await fetchJsonOrSkip(route);
            if (!extensions) return;
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const data = await fetchJsonOrSkip(route);
            if (!data) return;
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            applyWelcomeSettings(settings);
            settings.power_user.auto_connect = false;
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (readEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
            return route.fulfill({ json: url.pathname === '/api/settings/save' ? { version: ++version } : {} });
        }
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
}

const scrollLeftOfPane = page => page.evaluate(() => document.getElementById('sb-settings-inner').scrollLeft);
const focusedPane = page => page.evaluate(() => {
    const active = document.activeElement;
    if (active?.closest('#sb-settings-content')) return 'content';
    if (active?.closest('#sb-settings-sidebar')) return 'sidebar';
    return 'outside';
});

test.describe('phone settings page: the keyboard never enters the pane that is off screen', () => {
    test.beforeEach(async ({ page, baseURL }) => {
        test.setTimeout(120000);
        await loadApp(page, baseURL, { viewport: { width: 390, height: 844 } });
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'sampling'));
        await expect(page.locator('button[data-sb-settings-tab="sampling"]')).toHaveAttribute('aria-selected', 'true');
    });

    test('with the sidebar showing, Tab from the search field never enters the page or scrolls the pane sideways', async ({ page }) => {
        await page.locator('#sb-settings-search-toggle').click();
        await expect(page.locator('#sb-settings-search-input')).toBeFocused();
        const visited = new Set();
        for (let press = 0; press < 16; press++) {
            await page.keyboard.press('Tab');
            visited.add(await focusedPane(page));
            expect(await focusedPane(page)).not.toBe('content');
            expect(await scrollLeftOfPane(page)).toBe(0);
        }
        // The Tab that leaves the sidebar goes on to what follows the page.
        expect(visited.has('sidebar')).toBe(true);
    });

    test('with the sidebar showing, Shift+Tab from the first stop after the page returns to the sidebar, not the page', async ({ page }) => {
        await page.locator('#sb-settings-search-toggle').click();
        await expect(async () => {
            await page.keyboard.press('Tab');
            expect(await focusedPane(page)).toBe('outside');
        }).toPass({ timeout: 15000 });
        await page.keyboard.press('Shift+Tab');
        expect(await focusedPane(page)).toBe('sidebar');
        expect(await scrollLeftOfPane(page)).toBe(0);
    });

    test('with the page showing, Shift+Tab never enters the sidebar', async ({ page }) => {
        await page.locator('button[data-sb-settings-tab="sampling"]').click();
        await expect(page.locator('#sb-settings-page.sb-settings-page--content')).toBeVisible();
        await page.locator('#sb-settings-back').focus();
        for (let press = 0; press < 16; press++) {
            await page.keyboard.press('Shift+Tab');
            expect(await focusedPane(page)).not.toBe('sidebar');
            expect(await scrollLeftOfPane(page)).toBe(0);
        }
    });

    test('Tab inside the pane that is showing is left to the browser', async ({ page }) => {
        await page.locator('button[data-sb-settings-tab="sampling"]').click();
        await page.locator('#sb-settings-back').focus();
        await page.keyboard.press('Tab');
        expect(await focusedPane(page)).toBe('content');
        await expect(page.locator('#sb-settings-back')).not.toBeFocused();
    });

    test('Back and the search field work as a user reaches them, and the sidebar is not cropped', async ({ page }) => {
        await page.locator('button[data-sb-settings-tab="sampling"]').click();
        await page.locator('#sb-settings-back').click();
        await page.locator('#sb-settings-search-toggle').click();
        await expect(page.locator('#sb-settings-search-input')).toBeFocused();
        expect(await scrollLeftOfPane(page)).toBe(0);
        expect((await page.locator('#sb-settings-sidebar').boundingBox()).x).toBe(0);
    });

    test('the audit helper does not press the Back button that is off screen', async ({ page }) => {
        await showSettingsSidebar(page);
        expect(await scrollLeftOfPane(page)).toBe(0);
        await page.locator('button[data-sb-settings-tab="sampling"]').click();
        await showSettingsSidebar(page);
        expect(await scrollLeftOfPane(page)).toBe(0);
    });
});

test('on a desktop width Tab is left to the browser', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await loadApp(page, baseURL, { viewport: { width: 1440, height: 900 } });
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'sampling'));
    await page.locator('#sb-settings-search-toggle').click();
    const panes = new Set();
    for (let press = 0; press < 16; press++) {
        await page.keyboard.press('Tab');
        panes.add(await focusedPane(page));
    }
    expect(panes.has('content')).toBe(true);
});
