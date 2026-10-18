import { expect, test } from '@playwright/test';
import path from 'node:path';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';

const deferredScripts = new Map([
    ['sillybunny-server-tools.js', /\/sillybunny-server-tools(?:-[a-f0-9]{12})?\.js(?:\?[^#]*)?$/],
    ['data-maid-dialog.js', /\/data-maid-dialog(?:-[a-f0-9]{12})?\.js(?:\?[^#]*)?$/],
]);
const serverToolsScript = deferredScripts.get('sillybunny-server-tools.js');
const cleanupScript = deferredScripts.get('data-maid-dialog.js');
const readOnlyPosts = new Set([
    '/api/settings/get', '/api/presets/defaults', '/api/avatars/get',
    '/api/backgrounds/folders', '/api/image-metadata/all', '/api/tokenizers/openai/count',
    '/api/server-admin/install-type', '/api/server-admin/config/get',
    '/api/server-admin/config/thumbnail-settings/get', '/api/server-admin/config/chat-completions/get',
]);
test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page, baseURL }) => {
    const origin = new URL(baseURL).origin;
    // A small read allowlist keeps installed extensions and future boot writes off the real profile.
    await page.context().route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
        if (request.method() === 'POST' && readOnlyPosts.has(url.pathname)) return route.continue();
        return route.abort();
    });
    await protectMaintainerServer(page);
    await page.context().route(/\/api\/(?:characters\/last-chat|quick-replies\/save)$/, route => route.fulfill({ body: 'ok' }));
    // Status also fetches Git refs and may restore generated install files in the server checkout.
    await page.context().route('**/api/server-admin/status', route => route.fulfill({ json: {} }));
    // These read-like endpoints can recover chats, reconcile entity sidecars, or generate metadata.
    await page.route(/\/api\/(?:characters\/all|groups\/all|chats\/(?:group\/)?get|in-chat-agents\/groups\/list)$/, route => route.fulfill({ json: [] }));
    await page.route('**/api/backgrounds/all', route => route.fulfill({ json: { images: [], config: {} } }));
    await page.route('**/api/secrets/read', route => route.fulfill({ json: {} }));
});

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
                for (const [script, pattern] of deferredScripts) {
                    if (pattern.test(request.url())) requestedScripts.push(script);
                }
            });
            await openApp(page);
            for (const script of deferredScripts.keys()) {
                expect(requestedScripts).not.toContain(script);
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
            await expect(page.locator('.sb-settings-tab-content')).not.toHaveCount(0);
            await expect(page.locator('#sb-theme-card')).toHaveCount(1);
            await expect(page.locator('#sb-appearance-content #AppearanceSection')).toHaveCount(1);
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
            await expect(page.locator('.sb-settings-tab-content')).not.toHaveCount(0);
            expect(requestedScripts).not.toContain('sillybunny-server-tools.js');
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
    await page.route(serverToolsScript, async route => {
        attempts += 1;
        if (attempts === 1) await route.abort('failed');
        else await route.continue();
    });
    await openApp(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
    const panel = page.locator('[data-sb-panel="data-security"]');
    await panel.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(panel.locator('.sb-server-column')).toHaveCount(1);
    expect(attempts).toBe(2);
});

test('Data & Security hosts the Import & Restore drawer', async ({ page }) => {
    await openApp(page);
    // Appearance initializes the settings panel before Data & Security exists; the import card must
    // wait for its own panel instead of falling back into Appearance's theme block.
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
    await expect(page.locator('[data-sb-panel="appearance"] #sb-import-card')).toHaveCount(0);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
    const panel = page.locator('[data-sb-panel="data-security"]');
    await expect(panel.locator('#SillyTavernImportSection')).toHaveCount(1);
    await expect(panel.locator('#sb-import-card')).toHaveCount(1);
    await expect(page.locator('#sb-appearance-content #SillyTavernImportSection')).toHaveCount(0);
});

test('failed cleanup import can be retried by opening the tool again', async ({ page }) => {
    let attempts = 0;
    await page.route(cleanupScript, async route => {
        attempts += 1;
        if (attempts === 1) await route.abort('failed');
        else await route.continue();
    });
    await openApp(page);
    await showToasts(page);
    await page.evaluate(() => document.getElementById('data_maid_button').click());
    await expect(page.locator('.toast-error').filter({ hasText: 'data-maid-dialog' })).toBeVisible();
    await expect(page.locator('#data_maid_button')).not.toHaveAttribute('aria-busy');
    await page.evaluate(() => document.getElementById('data_maid_button').click());
    await expect(page.locator('dialog[open]')).toBeVisible();
    expect(attempts).toBe(2);
});

test('a delayed custom quick action preserves later navigation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
        localStorage.setItem('sb-mobile-quick-actions-v2', JSON.stringify([{
            type: 'custom', shellKey: 'right', tabId: 'data-security',
            label: 'Delayed server', displayText: 'Thumbnail Quality', dedupeKey: 'thumbnail-quality',
        }]));
    });
    let releaseImport;
    const importGate = new Promise(resolve => { releaseImport = resolve; });
    await page.route(serverToolsScript, async route => {
        await importGate;
        await route.continue();
    });
    await openApp(page);
    const importStarted = page.waitForRequest(serverToolsScript);
    await page.locator('#sb-mobile-nav button[aria-label="Open Delayed server"]').evaluate(button => button.click());
    await importStarted;
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
    releaseImport();
    await expect(page.locator('[data-sb-panel="data-security"] .sb-server-column')).toHaveCount(1);
    await expect(page.locator('[data-sb-panel="extensions"]')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('[data-sb-panel="data-security"]')).toHaveAttribute('aria-hidden', 'true');
});
