import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { WELCOME_SELECTOR, applyWelcomeSettings } from './helpers/welcome-dialog.js';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTER_PRESETS = ['Quick Anime (free)', 'Photoreal (free)', 'Chat Scene (LLM prompt)'];
const wizard = page => page.locator('#qig-setup-wizard');

const waitForExtension = page => page.evaluate(async () => {
    const { getExtensionCapability } = await import('/scripts/sillybunny-conversation/extension-capabilities.js');
    await getExtensionCapability('quick-image-gen').ensureReady();
});

/**
 * Boots an account whose Quick Image Gen settings are `saved` (absent when `undefined`), and waits for the extension
 * to finish starting, because it opens its wizard at the end of its startup. A first run holds startup on the
 * Welcome dialog, which `waitForAppReady` ends; `endWelcome: false` leaves it open for a test that looks under it.
 */
async function bootWithQuickImageGenSettings(page, { firstRun, saved, endWelcome = true }) {
    await protectMaintainerServer(page);
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        settings.firstRun = firstRun;
        applyWelcomeSettings(settings);
        if (saved === undefined) {
            delete settings.extension_settings['quick-image-gen'];
        } else {
            settings.extension_settings['quick-image-gen'] = saved;
        }
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.goto('/');
    await page.waitForFunction('document.getElementById("preloader") === null', undefined, { timeout: 60_000 });
    if (!endWelcome) {
        await expect(page.locator(WELCOME_SELECTOR)).toBeVisible({ timeout: 60_000 });
        await waitForExtension(page);
        return;
    }
    await testSetup.waitForAppReady({ page });
    await waitForExtension(page);
}

test.describe('Quick Image Gen on a first run', () => {
    test('opens no setup wizard, so the first-run dialog is the only one', async ({ page }) => {
        await bootWithQuickImageGenSettings(page, { firstRun: true, saved: undefined, endWelcome: false });

        await expect(wizard(page)).toHaveCount(0);
        await expect(page.locator('dialog[open]')).toHaveCount(1);
        await expect(page.locator(WELCOME_SELECTOR)).toHaveCount(1);
        await testSetup.waitForAppReady({ page });
        await expect(page.locator('dialog[open]:has(#qig-setup-wizard), #qig-setup-wizard:visible')).toHaveCount(0);
    });

    test('still seeds its starter presets', async ({ page }) => {
        await bootWithQuickImageGenSettings(page, { firstRun: true, saved: undefined });

        const options = await page.locator('#qig-config-select option').allTextContents();

        expect(options.filter(label => STARTER_PRESETS.some(name => label.startsWith(name)))).toHaveLength(STARTER_PRESETS.length);
    });

    test('opens the wizard from its own button', async ({ page }) => {
        await bootWithQuickImageGenSettings(page, { firstRun: true, saved: undefined });

        await page.locator('.qig-wizard-btn').first().evaluate(button => button.click());

        await expect(wizard(page)).toBeVisible();
    });

    test('also opens no wizard after a settings reset that left the account with no Quick Image Gen settings', async ({ page }) => {
        await bootWithQuickImageGenSettings(page, { firstRun: false, saved: {} });

        await expect(wizard(page)).toHaveCount(0);
    });

    test('opens no wizard for an existing account that has no Quick Image Gen settings at all', async ({ page }) => {
        await bootWithQuickImageGenSettings(page, { firstRun: false, saved: undefined });

        await expect(wizard(page)).toHaveCount(0);
    });
});

test.describe('Quick Image Gen on an existing account', () => {
    test('keeps its saved settings: no wizard, and no starter presets after the account declined them', async ({ page }) => {
        await bootWithQuickImageGenSettings(page, { firstRun: false, saved: { setupWizardSeen: true, starterPresetsSeeded: true } });

        await expect(wizard(page)).toHaveCount(0);
        await expect(page.locator('#qig-config-select option')).toHaveText(['— Current settings —']);
    });
});
