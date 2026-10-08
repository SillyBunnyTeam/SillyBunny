import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const settingsModules = [
    'sillybunny-settings-presentation.js',
    'sillybunny-settings-subpage.js',
    'sillybunny-settings-subpage-descriptors.js',
];

const legacyNavigationAttributes = [
    'data-sb-mobile-nav-layout',
    'data-sb-mobile-nav-mode',
    'data-sb-mobile-nav-customize',
    'data-sb-mobile-nav-quick-actions',
    'data-sb-mobile-nav-replacement',
    'data-sb-desktop-nav-layout',
    'data-sb-desktop-nav-mode',
    'data-sb-desktop-nav-customize',
    'data-sb-desktop-nav-quick-actions',
    'data-sb-desktop-nav-replacement',
];

async function exerciseUpgrade({ page, baseURL, settings, desktopIconsOnly, mobileIconsOnly }) {
    const settingsResponses = [];
    page.on('response', response => {
        const pathname = new URL(response.url()).pathname;
        if (settingsModules.some(name => pathname.endsWith(`/${name}`))) {
            settingsResponses.push({ pathname, status: response.status() });
        }
    });

    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin
        ? route.continue()
        : route.abort());
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        const serverSettings = JSON.parse(data.settings);
        serverSettings.firstRun = false;
        await route.fulfill({ response, json: { ...data, settings: JSON.stringify(serverSettings) } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ storage, legacyAttributes }) => {
        for (const attribute of legacyAttributes) {
            document.documentElement.setAttribute(attribute, 'legacy');
        }
        for (const mode of ['desktop', 'mobile']) {
            localStorage.setItem(`sb-${mode}-nav-layout`, 'vertical');
            localStorage.setItem(`sb-${mode}-nav-icon-only`, 'true');
            localStorage.setItem(`sb-${mode}-nav-show-customize`, 'false');
            localStorage.setItem(`sb-${mode}-nav-show-quick-actions`, 'false');
            localStorage.setItem(`sb-${mode}-nav-replace-quick-actions`, 'true');
            localStorage.setItem(`sb-${mode}-nav-replacement-target`, 'right:settings');
        }
        localStorage.setItem('sb-left-tab', 'api');
        localStorage.setItem('sb-right-tab', 'settings');
        for (const [key, value] of Object.entries(storage)) {
            localStorage.setItem(key, value);
        }
    }, { storage: settings, legacyAttributes: legacyNavigationAttributes });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function');
    await expect(page.locator('#preloader')).toHaveCount(0);
    await expect(page.locator('#sb-topbar-inner')).toBeVisible();
    for (const attribute of legacyNavigationAttributes) {
        await expect(page.locator('html')).not.toHaveAttribute(attribute);
    }
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    await page.getByRole('dialog', { name: 'Set up Quick Image Gen' })
        .getByRole('button', { name: 'Close dialog' })
        .click({ timeout: 1000 })
        .catch(() => {});
    await page.evaluate(() => {
        for (const dialog of document.querySelectorAll('dialog[open]')) {
            dialog.close();
        }
    });
    await expect(page.locator('dialog[open]')).toHaveCount(0);

    for (const name of settingsModules) {
        expect(settingsResponses).toContainEqual({ pathname: `/scripts/${name}`, status: 200 });
    }

    const iconsOnly = page.viewportSize().width <= 768 ? mobileIconsOnly : desktopIconsOnly;
    await expect(page.locator('html')).toHaveAttribute('data-sb-topbar-icons-only', String(iconsOnly));
    const entryPoints = iconsOnly
        ? [
            { selector: '[data-sb-topbar-page="left:connections"]', tabId: 'connections' },
            { selector: '[data-sb-topbar-page="right:appearance"]', tabId: 'appearance' },
        ]
        : [
            { selector: '#sb-left-shell-toggle', tabId: 'connections' },
            { selector: '#sb-right-shell-toggle', tabId: 'appearance' },
        ];

    for (const entryPoint of entryPoints) {
        const button = page.locator(entryPoint.selector);
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeVisible();
        await button.click();
        await expect(page.locator('#sb-settings-page')).toBeVisible();
        await expect(page.locator(`button[data-sb-settings-tab="${entryPoint.tabId}"]`)).toHaveAttribute('aria-selected', 'true');
        await page.locator('#sb-settings-close').click();
        await expect(page.locator('#sb-settings-page')).toBeHidden();
    }

    await expect(page.locator('#sb-home-toggle')).toBeVisible();
    await expect(page.locator('#sb-character-toggle')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sb-mobile-nav-show-customize'))).toBe('false');
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    test.describe(`top menu after an upgrade at ${viewport.width}px`, () => {
        test.use({ viewport });

        test('keeps the top menu available with retired navigation preferences', async ({ page, baseURL }) => {
            await exerciseUpgrade({
                page,
                baseURL,
                settings: {},
                desktopIconsOnly: false,
                mobileIconsOnly: false,
            });
            await expect(page.locator('#sb-topbar-inner')).toBeVisible();
        });

        test('keeps the legacy icons-only topbar available', async ({ page, baseURL }) => {
            await exerciseUpgrade({
                page,
                baseURL,
                settings: { 'sb-topbar-icons-only': 'true' },
                desktopIconsOnly: true,
                mobileIconsOnly: true,
            });
            await expect(page.locator('#sb-topbar-inner')).toBeVisible();
        });

        test('keeps device-specific topbar preferences independent', async ({ page, baseURL }) => {
            await exerciseUpgrade({
                page,
                baseURL,
                settings: {
                    'sb-topbar-icons-only': 'true',
                    'sb-desktop-topbar-icons-only': 'false',
                    'sb-mobile-topbar-icons-only': 'true',
                },
                desktopIconsOnly: false,
                mobileIconsOnly: true,
            });
            await expect(page.locator('#sb-topbar-inner')).toBeVisible();
        });
    });
}
