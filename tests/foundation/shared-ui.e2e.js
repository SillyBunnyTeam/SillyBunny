import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const fixture = fs.readFileSync(new URL('./controls.html', import.meta.url), 'utf8');
const themes = {
    dark: { body: '#cfcfc5', panel: '#1d2128', quote: '#c6c197', border: '#454951' },
    light: { body: '#25282d', panel: '#eceef2', quote: '#686344', border: '#747b86' },
    custom: { body: '#e9e7dc', panel: '#25251f', quote: '#f3c985', border: '#78745c' },
};

test.beforeEach(async ({ page, baseURL }) => {
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === baseURL ? route.continue() : route.abort();
    });
});

for (const [name, colors] of Object.entries(themes)) {
    test(`${name} shared controls`, async ({ page, isMobile }, testInfo) => {
        await page.route('**/__foundation', route => route.fulfill({ contentType: 'text/html', body: fixture }));
        await page.goto('/__foundation');
        await page.evaluate(({ body, panel, quote, border }) => {
            const style = document.documentElement.style;
            for (const [token, value] of Object.entries({ SmartThemeBodyColor: body, SmartThemeBlurTintColor: panel, SmartThemeChatTintColor: panel, SmartThemeQuoteColor: quote, SmartThemeBorderColor: border })) style.setProperty(`--${token}`, value);
        }, colors);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: testInfo.outputPath(`${name}-controls.png`), fullPage: true });
        await testInfo.attach(`${name}-controls`, { path: testInfo.outputPath(`${name}-controls.png`), contentType: 'image/png' });

        // Capture the original baseline before enabling assertions for the new contract.
        if (process.env.SB_UI_CAPTURE_ONLY === '1') return;
        await page.keyboard.press('Tab');
        await expect(page.locator('#primary')).toBeFocused();
        await expect(page.locator('#primary')).toHaveCSS('box-shadow', /inset/);
        await page.keyboard.press('Tab');
        await expect(page.locator('#secondary')).toBeFocused();
        await expect(page.locator('[disabled]').first()).toBeDisabled();
        await expect(page.locator('[aria-disabled]')).toHaveCSS('cursor', 'not-allowed');
        await expect(page.locator('[aria-busy]')).toHaveCSS('cursor', 'progress');

        for (const compact of [false, true]) {
            await page.evaluate(value => document.documentElement.dataset.sbCompactMode = String(value), compact);
            if (isMobile) {
                for (const element of await page.locator('.menu_button, .text_pole, select, .checkbox_label').all()) {
                    const bounds = await element.boundingBox();
                    expect(bounds.height).toBeGreaterThanOrEqual(44);
                    expect(bounds.width).toBeGreaterThanOrEqual(44);
                }
            }
            await page.evaluate(() => document.documentElement.style.setProperty('--mainFontSize', '24px'));
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(page.locator('#primary')).toHaveCSS('transition-duration', '0s');
        await expect(page.locator('#primary')).toHaveCSS('transition-delay', '0s');
        await expect(page.locator('#field')).toHaveCSS('transition-duration', '0s');
        await page.addStyleTag({ content: ':root { --sb-radius-button: 7px; --sb-focus-ring: #ffadba; }' });
        await expect(page.locator('#secondary')).toHaveCSS('border-radius', '7px');
    });
}

test('application shell baseline and reduced motion', async ({ page }, testInfo) => {
    await page.route('**/api/settings/save', route => route.fulfill({ json: {} }));
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));
    const setupWizard = page.locator('#qig-setup-wizard');
    if (await setupWizard.isVisible().catch(() => false)) {
        await setupWizard.locator('.qig-close-btn').click({ force: true });
        await expect(setupWizard).toBeHidden({ timeout: 5000 });
    }
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'presets'));
    await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
    await page.screenshot({ path: testInfo.outputPath('shell.png') });
    await testInfo.attach('shell', { path: testInfo.outputPath('shell.png'), contentType: 'image/png' });
    if (process.env.SB_UI_CAPTURE_ONLY === '1') return;
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const shellRoot = page.locator('#left-nav-panel .sb-shell-root, #left-nav-panel.sb-shell-root, #left-nav-panel').first();
    const motion = await shellRoot.evaluate(element => {
        const style = getComputedStyle(element);
        return { duration: style.animationDuration, delay: style.animationDelay };
    });
    expect(motion).toEqual({ duration: '0s', delay: '0s' });
    await shellRoot.locator('.sb-shell-close').click();
    await expect(page.locator('#left-nav-panel')).not.toHaveClass(/openDrawer/);
});
