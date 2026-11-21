import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { APP_URL, dismissOpenDialogIfPresent } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { keepSavesInPage } from './helpers/saves-in-page.js';
import { keepWelcomeClosed } from './helpers/welcome-dialog.js';

test.use({ serviceWorkers: 'block' });

const DOCS_HOST = 'https://horde-docs.invalid';
const DOCS_URL = `${DOCS_HOST}/models/with-link?tab=details`;
const HORDE_MODELS = [
    { name: 'koboldcpp/With Link', display_name: 'koboldcpp/With Link', url: DOCS_URL, style: 'story', tags: ['popular'], description: 'Has a page.', eta: 1, performance: 3, queued: 0, count: 1, is_whitelisted: 1 },
    { name: 'No Link', eta: 1, performance: 2, queued: 0, count: 1, is_whitelisted: 1 },
    { name: 'Unsafe Link', url: 'javascript:window.__hordeInjected = true', eta: 1, performance: 1, queued: 0, count: 1, is_whitelisted: 1 },
];

for (const mobile of [false, true]) {
    test.describe(`Horde model row ${mobile ? 'on mobile' : 'on desktop'}`, () => {
        test.use({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
            isMobile: mobile,
            hasTouch: mobile,
        });

        test('links to the model page without choosing the model, and only when the catalogue gives a safe address', async ({ page, baseURL }) => {
            const origin = new URL(baseURL).origin;
            expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
            await protectMaintainerServer(page);
            await keepSavesInPage(page);
            await keepWelcomeClosed(page.context());
            const requested = [];
            await page.context().route('**/*', async route => {
                const url = new URL(route.request().url());
                if (url.origin === DOCS_HOST) {
                    requested.push(url.href);
                    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Model page</title>' });
                }
                if (url.origin !== origin) return route.abort();
                if (url.pathname === '/api/horde/text-models') return route.fulfill({ json: HORDE_MODELS });
                if (url.pathname.startsWith('/api/') && !/^\/api\/(settings|secrets|presets|characters|chats|groups|avatars|backgrounds|worldinfo|content|themes|quick-replies|users|stats|tokenizers)\//.test(url.pathname)
                    && !['/api/ping', '/api/extensions/discover'].includes(url.pathname)) {
                    return route.abort();
                }
                return route.fallback();
            });
            await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
            await testSetup.waitForAppReady({ page });
            await dismissOpenDialogIfPresent(page);
            await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function');
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'api'));
            await expect(page.locator('#main_api')).toBeVisible();
            await page.locator('#main_api').selectOption('koboldhorde');
            await page.evaluate(async () => (await import('/scripts/horde.js')).getHordeModels(true));
            await expect(page.locator('#horde_model option')).toHaveCount(HORDE_MODELS.length);

            const trigger = page.locator('[data-sb-editor-field="horde_model"] .ds-select-row__trigger');
            await trigger.click();
            const surface = page.locator(mobile ? '.sb-picker-sheet' : '.sb-picker');
            await expect(surface).toBeVisible();
            const optionFor = name => surface.getByRole('option').filter({ hasText: name });
            await expect(optionFor('With Link').locator('a')).toHaveCount(1);
            await expect(optionFor('No Link').locator('a')).toHaveCount(0);
            await expect(optionFor('Unsafe Link').locator('a')).toHaveCount(0);
            expect(await page.evaluate(() => window.__hordeInjected)).toBeUndefined();

            const link = optionFor('With Link').locator('a');
            await expect(link).toHaveAttribute('href', DOCS_URL);
            await expect(link).toHaveAttribute('target', '_blank');
            await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
            await expect(link).toHaveAttribute('aria-label', 'Details');
            await expect(link).toHaveAttribute('title', 'Details');
            const popupPromise = page.waitForEvent('popup');
            await link.click();
            const popup = await popupPromise;
            await popup.waitForLoadState('domcontentloaded');
            expect(popup.url()).toBe(DOCS_URL);
            await popup.close();
            expect(requested).toEqual([DOCS_URL]);

            // The press followed the link only: nothing was chosen and the picker is still open.
            await expect(surface).toBeVisible();
            await expect(page.locator('#horde_model option:checked')).toHaveCount(0);
            await expect(optionFor('With Link')).toHaveAttribute('aria-selected', 'false');

            // The rest of the option still chooses it.
            await optionFor('With Link').locator('.sb-picker__label').click();
            await expect(page.locator('#horde_model option:checked')).toHaveCount(1);
            await expect(optionFor('With Link')).toHaveAttribute('aria-selected', 'true');
        });
    });
}
