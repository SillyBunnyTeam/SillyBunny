import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// The phone rule for `.sb-shell-panel-scroller .menu_button` and the compact-mode rule exclude status-page actions.
// That exclusion must not add specificity, or both rules override the more specific size rules of single controls.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'connections'));
    await expect(page.locator('.sb-shell-panel-scroller #customize_additional_parameters')).toBeAttached();
});

// The Connections panel stays mounted but hidden while another page is open, so sizes are read from computed style.
const computed = (page, selector, properties) => page.locator(selector).evaluateAll(
    (elements, names) => elements.map(element => Object.fromEntries(names.map(name => [name, getComputedStyle(element)[name]]))),
    properties,
);

test.describe('Shell panel button sizes on a coarse pointer', () => {
    test('a button row keeps its 44px touch target', async ({ page }) => {
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        expect(await computed(page, '.sb-shell-panel-scroller #customize_additional_parameters.ds-button-row', ['minHeight'])).toEqual([{ minHeight: '44px' }]);
    });

    test('icon-only buttons keep the size from mobile-styles.css', async ({ page }) => {
        const sizes = await computed(page, '.sb-shell-panel-scroller .menu_button:is(.fa-solid, .fa-regular):empty:not([class*="qr-"])', ['minHeight']);
        expect(sizes.length).toBeGreaterThan(0);
        for (const size of sizes) expect(size).toEqual({ minHeight: '44px' });
    });

    test('chat completion config actions keep their own size', async ({ page }) => {
        const sizes = await computed(page, '.sb-shell-panel-scroller .sb-chat-completion-config-actions button.menu_button_icon', ['minHeight', 'paddingTop', 'paddingLeft']);
        expect(sizes).toHaveLength(3);
        for (const size of sizes) expect(size).toEqual({ minHeight: '34px', paddingTop: '7px', paddingLeft: '10px' });
    });

    test('accent preset swatches stay 24px', async ({ page }) => {
        const sizes = await computed(page, '.sb-shell-panel-scroller button.sb-accent-preset', ['minHeight', 'height']);
        expect(sizes.length).toBeGreaterThan(0);
        for (const size of sizes) expect(size).toEqual({ minHeight: '24px', height: '24px' });
    });

    test('compact mode keeps at least 40px on a full-width panel button', async ({ page }) => {
        await page.evaluate(() => { document.documentElement.dataset.sbCompactMode = 'true'; });
        const [size] = await computed(page, '.sb-shell-panel-scroller #openai_logit_bias_new_entry.menu_button.wide100p', ['minHeight']);
        expect(parseFloat(size.minHeight)).toBeGreaterThanOrEqual(40);
    });
});
