import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

test.use({ serviceWorkers: 'block' });

const PROVIDER = 'OpenAI Compatible';
const MODEL = 'sb-module-identity-model';

/**
 * Keeps the settings of this page in this page: the server's copy never changes.
 * @param {import('@playwright/test').Page} page
 * @param {(settings: any) => void} [change] Edits the settings that the server sends
 */
async function isolateSettings(page, change) {
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        if (change) {
            const settings = JSON.parse(body.settings);
            change(settings);
            body.settings = JSON.stringify(settings);
        }
        await route.fulfill({ response, json: body });
    });
    await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
}

/**
 * Records every JavaScript file the page loads as a script, with its query string.
 * A prefetch hint is not a script, so it does not count.
 * @param {import('@playwright/test').Page} page
 * @returns {string[]} The list fills while the page loads
 */
function recordScriptRequests(page) {
    const requested = [];
    page.on('request', request => {
        const url = new URL(request.url());
        if (request.resourceType() === 'script' && /\.m?js$/.test(url.pathname)) {
            requested.push(url.pathname + url.search);
        }
    });
    return requested;
}

/**
 * Groups URLs by path and keeps the paths that load under more than one query string.
 * @param {string[]} urls Paths with their query strings
 * @returns {{ path: string, queries: string[] }[]}
 */
function findPathsLoadedTwice(urls) {
    const queriesByPath = new Map();
    for (const url of urls) {
        const [pathname, query = ''] = url.split('?');
        if (!queriesByPath.has(pathname)) {
            queriesByPath.set(pathname, new Set());
        }
        queriesByPath.get(pathname).add(query);
    }
    return [...queriesByPath]
        .filter(([, queries]) => queries.size > 1)
        .map(([pathname, queries]) => ({ path: pathname, queries: [...queries] }));
}

test('a TTS provider setting is saved by the one tts/index.js module', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const requested = recordScriptRequests(page);
    await isolateSettings(page);

    await testSetup.awaitST({ page });
    // The Extensions page shows each extension as a row that opens its settings page, and the provider select is a
    // select row that picks through the shared picker, so the provider is chosen there and not on the native select.
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
    await page.locator('button[data-sb-settings-tab="extensions"]').evaluate(element => element.click());
    const panel = page.locator('[data-sb-panel="extensions"]');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    const row = panel.locator('.sb-subpage-row', { hasText: 'TTS' }).first();
    await expect(row).toBeAttached({ timeout: 30000 });
    await row.evaluate(element => element.click());
    const tts = panel.locator('.sb-subpage-detail-content');
    await expect(tts).toHaveCount(1);
    await tts.locator('.ds-select-row:has(#tts_provider) .ds-select-row__trigger').click();
    await page.locator('.sb-picker:visible, .sb-picker-sheet:visible').last().getByRole('option', { name: PROVIDER, exact: true }).click();

    const model = page.locator('#openai_compatible_model');
    await expect(model).toBeVisible();
    const saveRequest = page.waitForRequest(request => request.url().endsWith('/api/settings/save'));
    await model.fill(MODEL);

    await expect.poll(() => errors).toEqual([]);
    await expect.poll(() => page.evaluate(
        provider => window.SillyTavern.getContext().extensionSettings.tts?.[provider]?.model,
        PROVIDER,
    )).toBe(MODEL);
    const saved = (await saveRequest).postDataJSON();
    expect(saved.extension_settings.tts[PROVIDER].model).toBe(MODEL);

    expect(requested.filter(url => url.split('?')[0] === '/scripts/extensions/tts/index.js')).toHaveLength(1);
});

test('no bundled extension module loads under two URLs', async ({ page }) => {
    test.setTimeout(120000);
    // The default buffer holds 250 entries, and a boot loads about 500 files.
    await page.addInitScript(() => performance.setResourceTimingBufferSize(100000));
    const requested = recordScriptRequests(page);
    // Every bundled extension is on. An opt-in extension starts off on the first boot of a profile,
    // so the settings also say that this boot is not its first.
    await isolateSettings(page, settings => {
        settings.extension_settings ??= {};
        settings.extension_settings.disabledExtensions = [];
        settings.extension_settings.lockedExtensionsUnlockApplied = true;
        settings.extension_settings.bundledOptInProcessedExtensions = ['sillybunny-debugger'];
    });

    await testSetup.awaitST({ page });
    const bundled = await page.evaluate(async () => {
        const response = await fetch('/api/extensions/discover');
        const extensions = await response.json();
        return extensions.filter(extension => extension.type !== 'global' && extension.type !== 'local').map(extension => extension.name);
    });
    expect(bundled.length).toBeGreaterThan(0);
    // APP_READY does not wait for every extension script.
    const expectedIds = bundled.map(name => `${name.replace(/[^a-z0-9_-]/gi, '_')}-js`);
    await expect.poll(async () => {
        const ids = await page.evaluate(() => [...document.querySelectorAll('script[type="module"][id$="-js"]')].map(script => script.id));
        return expectedIds.filter(id => !ids.includes(id));
    }).toEqual([]);
    let lastCount = -1;
    await expect.poll(() => {
        const stable = requested.length === lastCount;
        lastCount = requested.length;
        return stable;
    }, { intervals: [1000], timeout: 30000 }).toBe(true);

    const resources = await page.evaluate(() => performance.getEntriesByType('resource')
        .filter(entry => entry.initiatorType !== 'link')
        .map(entry => new URL(entry.name))
        .filter(url => url.origin === location.origin && /\.m?js$/.test(url.pathname))
        .map(url => url.pathname + url.search));

    const extensionUrls = list => list.filter(url => url.startsWith('/scripts/extensions/'));
    expect(findPathsLoadedTwice(extensionUrls(requested))).toEqual([]);
    expect(findPathsLoadedTwice(extensionUrls(resources))).toEqual([]);
});
