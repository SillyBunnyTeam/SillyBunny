import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

async function openSearch(page, baseURL) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let version = Date.now();
    const readEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/extensions/discover') {
            const response = await route.fetch();
            return route.fulfill({ json: (await response.json()).filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            settings.power_user.auto_connect = false;
            settings.extension_settings['quick-image-gen'] = { setupWizardSeen: true };
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
    // The context option keeps the mobile settings slide transitions off, so captures stay settled.
    expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    await expect(page.locator('#sb-settings-page')).toBeHidden();
    await page.locator('#sb-topbar-search-toggle').click();
    await page.locator('#sb-universal-search input').fill('Show Bottom Chat Bar');
    return page.locator('#sb-universal-search-results').getByRole('group', { name: 'Customize · Interface', exact: true });
}

async function expectDeviceResults(group, device) {
    await expect(group).toBeVisible();
    const opposite = device === 'Mobile' ? 'Desktop' : 'Mobile';
    await expect(group.getByRole('option', { name: new RegExp(`^${opposite} `) })).toHaveCount(0);
    await expect(group.getByRole('option', { name: `${device} Show Bottom Chat Bar Jump to setting`, exact: true })).toBeVisible();
}

for (const [device, width] of [['Desktop', 1440], ['Mobile', 390]]) {
    test(`cold global search only offers reachable ${device} settings`, async ({ page, baseURL }, testInfo) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width, height: 1000 });
        const group = await openSearch(page, baseURL);
        await expectDeviceResults(group, device);
        await group.getByRole('option', { name: `${device} Show Bottom Chat Bar Jump to setting`, exact: true }).click();
        await expect(page.locator(`#sb-${device.toLowerCase()}-bottom-bar-visible-input`)).toBeVisible();
        await expect(page.locator(`#sb-${device.toLowerCase()}-bottom-bar-visible-input`)).toBeInViewport();
        await expect(page.locator('button[data-sb-settings-tab="interface"]')).toHaveAttribute('aria-selected', 'true');
        await page.screenshot({ path: testInfo.outputPath(`${device.toLowerCase()}-destination.png`) });
    });
}

test('mobile search result shows the content pane when the tab is already hosted', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 390, height: 1000 });
    const group = await openSearch(page, baseURL);
    const result = group.getByRole('option', { name: 'Mobile Show Bottom Chat Bar Jump to setting', exact: true });
    await result.click();
    await expect(page.locator('#sb-mobile-bottom-bar-visible-input')).toBeInViewport();
    // Back returns to the mobile sidebar while the Interface tab stays hosted in the page.
    await page.locator('#sb-settings-back').click();
    await expect(page.locator('#sb-settings-page')).not.toHaveClass(/sb-settings-page--content/);
    await expect(page.locator('#sb-settings-page')).toBeVisible();
    await expect(page.locator('button[data-sb-settings-tab="interface"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#sb-topbar-search-toggle').click();
    await page.locator('#sb-universal-search input').fill('Show Bottom Chat Bar');
    await result.click();
    await expect(page.locator('#sb-settings-page')).toHaveClass(/sb-settings-page--content/);
    await expect(page.locator('#sb-mobile-bottom-bar-visible-input')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('mobile-rehosted-destination.png') });
});

test('open search refreshes device matches across the breakpoint without losing cached entries', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const group = await openSearch(page, baseURL);
    await expect(group).toBeVisible();
    for (const [device, width] of [['Mobile', 390], ['Desktop', 1440], ['Mobile', 768], ['Desktop', 769]]) {
        await page.setViewportSize({ width, height: 1000 });
        await expectDeviceResults(group, device);
        await expect(page.locator('#sb-universal-search input')).toHaveValue('Show Bottom Chat Bar');
    }
    await group.getByRole('option', { name: 'Desktop Show Bottom Chat Bar Jump to setting', exact: true }).click();
    await expect(page.locator('#sb-desktop-bottom-bar-visible-input')).toBeVisible();
    await expect(page.locator('#sb-desktop-bottom-bar-visible-input')).toBeInViewport();
});
