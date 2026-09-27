import { expect, test } from '@playwright/test';
import path from 'node:path';

const deferredScripts = ['sillybunny-server-tools.js', 'sillybunny-settings-tabs.js', 'data-maid-dialog.js'];
test.use({ serviceWorkers: 'block' });

async function openApp(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function');
}

async function saveFirstUseScreenshot(page, viewport) {
    const directory = process.env.SILLYBUNNY_STARTUP_SCREENSHOT_DIR;
    if (!directory) return;
    await page.evaluate(() => {
        for (const key of ['Theme Colors', 'Auto-swipe', 'Auto-Continue']) {
            document.querySelector(`[data-i18n="${key}"]`).textContent = key;
        }
    });
    await page.screenshot({
        path: path.join(directory, viewport.width > 600 ? 'startup-desktop.png' : 'startup-mobile.png'),
        animations: 'disabled',
    });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    test.describe(`on-demand startup at ${viewport.width}px`, () => {
        test.use({ viewport });

        test('loads settings and sampling on use while preserving controls and saved appearance', async ({ page }) => {
            const requestedScripts = [];
            page.on('request', request => {
                const pathname = new URL(request.url()).pathname;
                if (deferredScripts.some(script => pathname.endsWith(`/${script}`))) requestedScripts.push(pathname);
            });
            await openApp(page);
            for (const script of deferredScripts) {
                expect(requestedScripts).not.toContain(`/scripts/${script}`);
            }
            await expect(page.locator('#sb-theme-card')).toHaveCount(0);
            await expect(page.locator('#sb-sampling-openai')).toHaveCount(0);
            const before = await page.evaluate(() => ({
                theme: window.SillyBunnyShell.getTheme(),
                temperature: document.getElementById('temp_openai').value,
                source: document.getElementById('chat_completion_source').value,
            }));
            await page.evaluate(() => {
                for (const key of ['Theme Colors', 'Auto-swipe', 'Auto-Continue']) {
                    document.querySelector(`[data-i18n="${key}"]`).textContent = 'Übersetzte Überschrift';
                }
            });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
            await expect(page.locator('#sb-settings-tabs')).toBeVisible();
            await expect(page.locator('#sb-theme-card')).toHaveCount(1);
            for (const drawerId of ['sb-theme-colors-drawer', 'sb-auto-swipe-drawer', 'sb-auto-continue-drawer']) {
                await expect(page.locator(`#${drawerId}`)).toHaveCount(1);
            }
            await saveFirstUseScreenshot(page, viewport);
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'sampling'));
            await expect(page.locator('[data-sb-panel="sampling"] [data-sb-sampling-control]')).not.toHaveCount(0);
            const after = await page.evaluate(() => ({
                theme: window.SillyBunnyShell.getTheme(),
                temperature: document.getElementById('temp_openai').value,
                source: document.getElementById('chat_completion_source').value,
            }));
            expect(after).toEqual(before);
            await expect(page.locator('#temp_openai')).toHaveCount(1);
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
            await expect(page.locator('#sb-settings-tabs')).toHaveCount(1);
            expect(requestedScripts).not.toContain('/scripts/sillybunny-server-tools.js');
        });

        test('search finds unopened server controls without starting server requests', async ({ page }) => {
            const adminRequests = [];
            page.on('request', request => {
                if (new URL(request.url()).pathname.startsWith('/api/server-admin/')) adminRequests.push(request.url());
            });
            await openApp(page);
            adminRequests.length = 0;
            await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
            const search = page.locator('#sb-universal-search input');
            await search.fill('Thumbnail Quality');
            await expect(page.locator('.sb-search-result')).not.toHaveCount(0);
            await expect(page.locator('.sb-search-result').first()).toContainText('Thumbnail Quality');
            expect(adminRequests).toHaveLength(0);
            await search.fill('config.yaml');
            await search.fill('no-such-startup-setting-982734');
            await expect(page.locator('.sb-search-result')).toHaveCount(0);
            await expect(page.locator('#sb-universal-search')).toContainText('no-such-startup-setting-982734');
        });
    });
}

test('failed optional import can be retried without reloading the app', async ({ page }) => {
    let attempts = 0;
    await page.route('**/sillybunny-server-tools.js*', async route => {
        attempts += 1;
        if (attempts === 1) await route.abort('failed');
        else await route.continue();
    });
    await openApp(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'server'));
    const panel = page.locator('[data-sb-panel="server"]');
    await panel.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(panel.locator('.sb-server-column')).toHaveCount(1);
    expect(attempts).toBe(2);
});

test('failed settings import can be retried by reopening the panel', async ({ page }) => {
    let attempts = 0;
    await page.route('**/sillybunny-settings-tabs.js*', async route => {
        attempts += 1;
        if (attempts === 1) await route.abort('failed');
        else await route.continue();
    });
    await openApp(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
    await expect(page.locator('.toast-error')).toBeVisible();
    await expect(page.locator('#sb-settings-tabs')).toHaveCount(0);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
    await expect(page.locator('#sb-settings-tabs')).toBeVisible();
    expect(attempts).toBe(2);
});

test('failed cleanup import can be retried by opening the tool again', async ({ page }) => {
    let attempts = 0;
    await page.route('**/data-maid-dialog.js*', async route => {
        attempts += 1;
        if (attempts === 1) await route.abort('failed');
        else await route.continue();
    });
    await openApp(page);
    await page.evaluate(() => document.getElementById('data_maid_button').click());
    await expect(page.locator('.toast-error')).toBeVisible();
    await expect(page.locator('#data_maid_button')).not.toHaveAttribute('aria-busy');
    await page.evaluate(() => document.getElementById('data_maid_button').click());
    await expect(page.locator('dialog[open]')).toBeVisible();
    expect(attempts).toBe(2);
});

test('a delayed custom quick action preserves later navigation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
        localStorage.setItem('sb-mobile-quick-actions-v2', JSON.stringify([{
            type: 'custom', shellKey: 'right', tabId: 'server',
            label: 'Delayed server', displayText: 'Thumbnail Quality', dedupeKey: 'thumbnail-quality',
        }]));
    });
    let releaseImport;
    const importGate = new Promise(resolve => { releaseImport = resolve; });
    await page.route('**/sillybunny-server-tools.js*', async route => {
        await importGate;
        await route.continue();
    });
    await openApp(page);
    const importStarted = page.waitForRequest('**/sillybunny-server-tools.js');
    await page.locator('#sb-mobile-nav button[aria-label="Open Delayed server"]').evaluate(button => button.click());
    await importStarted;
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
    releaseImport();
    await expect(page.locator('[data-sb-panel="server"] .sb-server-column')).toHaveCount(1);
    await expect(page.locator('[data-sb-panel="extensions"]')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('[data-sb-panel="server"]')).toHaveAttribute('aria-hidden', 'true');
});
