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

const entryIds = ['entry-rest', 'entry-filled', 'entry-focus', 'entry-error', 'entry-disabled', 'entry-password'];

// Resolves a custom property to the value the browser computes for a property, so a state is compared with its token.
function resolved(page, property, value) {
    return page.evaluate(([name, token]) => {
        const probe = document.createElement('div');
        probe.style.setProperty(name, token);
        document.body.append(probe);
        const computed = getComputedStyle(probe).getPropertyValue(name);
        probe.remove();
        return computed;
    }, [property, value]);
}

async function expectEntryRows(page) {
    for (const compact of [false, true]) {
        await page.evaluate(value => document.documentElement.dataset.sbCompactMode = String(value), compact);
        const token = parseFloat(await resolved(page, 'min-height', 'var(--sb-field-min-height)'));
        for (const id of entryIds) {
            const height = (await page.locator(`#${id}`).boundingBox()).height;
            expect(height, `${id} takes its height from --sb-field-min-height (compact ${compact})`).toBeGreaterThanOrEqual(token);
            expect(height, `${id} does not outgrow --sb-field-min-height (compact ${compact})`).toBeLessThanOrEqual(token + 1);
        }
    }
    await page.evaluate(() => delete document.documentElement.dataset.sbCompactMode);

    const border = id => page.locator(`#${id}`).evaluate(input => getComputedStyle(input).borderTopColor);
    const danger = await resolved(page, 'color', 'var(--sb-color-danger)');
    expect(await border('entry-rest')).toBe('rgba(0, 0, 0, 0)');
    expect(await border('entry-error')).toBe(danger);
    const error = page.locator('#entry-error');
    await expect(error).toHaveAttribute('aria-invalid', 'true');
    const caption = page.locator('.ds-row-entry__error');
    await expect(caption).toHaveText('Name is already taken');
    await expect(caption).toHaveCSS('color', danger);
    expect(await error.getAttribute('aria-describedby')).toContain(await caption.getAttribute('id'));
    await expect(page.locator('#entry-rest')).not.toHaveAttribute('aria-invalid', /.*/);

    const focusBorder = await resolved(page, 'border-top-color', 'var(--sb-entry-focus-border)');
    const focusRing = await resolved(page, 'box-shadow', 'var(--sb-entry-focus-ring)');
    await page.locator('#entry-focus').focus();
    await expect(page.locator('#entry-focus')).toHaveCSS('border-top-color', focusBorder);
    await expect(page.locator('#entry-focus')).toHaveCSS('box-shadow', focusRing);
    await page.locator('#entry-error').focus();
    await expect(page.locator('#entry-error')).toHaveCSS('border-top-color', danger);
    await expect(page.locator('#entry-error')).toHaveCSS('box-shadow', /inset/);
    await page.locator('#entry-error').blur();

    const disabled = page.locator('#entry-disabled');
    await expect(disabled).toBeDisabled();
    await disabled.evaluate(input => input.focus());
    await expect(disabled).not.toBeFocused();
    await expect(page.locator('.ds-row-entry--floating:has(#entry-disabled)')).toHaveCSS('opacity', '0.5');
    await expect(page.locator('.ds-row-entry--floating:has(#entry-disabled) label.ds-row-entry__title')).toBeVisible();
    await expect(page.locator('.ds-row-entry--floating:has(#entry-rest)')).toHaveCSS('opacity', '1');

    const password = page.locator('#entry-password');
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).not.toHaveClass(/is-masked/);
    await expect(password).toHaveCSS('-webkit-text-security', 'disc');
    await expect(page.locator('.ds-row-entry--floating:has(#entry-password) .ds-row-entry__reveal')).toHaveCount(0);
}

const searchIds = ['search-rest', 'search-filled', 'search-bar'];

async function expectSearchEntries(page, isMobile) {
    const entry = id => page.locator(`.sb-search-entry:has(#${id})`);
    const clear = id => entry(id).locator('.sb-search-entry__clear');

    for (const compact of [false, true]) {
        await page.evaluate(value => document.documentElement.dataset.sbCompactMode = String(value), compact);
        const field = parseFloat(await resolved(page, 'height', 'var(--sb-field-min-height)'));
        const control = parseFloat(await resolved(page, 'height', 'var(--sb-control-min-height)'));
        for (const id of ['search-rest', 'search-filled']) {
            expect((await entry(id).boundingBox()).height, `${id} takes its height from --sb-field-min-height (compact ${compact})`).toBeCloseTo(field, 0);
        }
        expect((await entry('search-bar').boundingBox()).height, `a bar entry takes its height from --sb-control-min-height (compact ${compact})`).toBeCloseTo(control, 0);
        if (isMobile) {
            const target = await clear('search-filled').boundingBox();
            expect(target.width, `the clear button is 44px wide on touch (compact ${compact})`).toBeGreaterThanOrEqual(44);
            expect(target.height, `the clear button is 44px tall on touch (compact ${compact})`).toBeGreaterThanOrEqual(44);
        }
    }
    await page.evaluate(() => delete document.documentElement.dataset.sbCompactMode);

    const radius = await resolved(page, 'border-top-left-radius', 'var(--sb-radius-control)');
    for (const id of searchIds) await expect(entry(id)).toHaveCSS('border-top-left-radius', radius);
    await expect(entry('search-rest')).toHaveCSS('background-color', await resolved(page, 'background-color', 'var(--sb-input-bg)'));
    await expect(entry('search-rest')).toHaveCSS('border-top-color', await resolved(page, 'border-top-color', 'var(--sb-input-border)'));
    await expect(entry('search-bar')).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');

    await expect(clear('search-rest')).toBeHidden();
    await expect(clear('search-filled')).toBeVisible();
    await expect(clear('search-filled')).toHaveAccessibleName('Clear');
    await expect(clear('search-filled')).toHaveAttribute('title', 'Clear');
    await expect(page.locator('#search-rest')).toHaveAccessibleName('Search settings');

    await page.locator('#search-rest').fill('abc');
    await expect(clear('search-rest')).toBeVisible();
    await page.locator('#search-rest').press('Escape');
    await expect(page.locator('#search-rest')).toHaveValue('');
    await expect(page.locator('#search-rest')).toBeFocused();
    await expect(clear('search-rest')).toBeHidden();

    await page.locator('#search-rest').fill('abc');
    await clear('search-rest').click();
    await expect(page.locator('#search-rest')).toHaveValue('');
    await expect(page.locator('#search-rest')).toBeFocused();
    await expect(clear('search-rest')).toBeHidden();

    await page.locator('#search-rest').focus();
    await expect(entry('search-rest')).toHaveCSS('border-top-color', await resolved(page, 'border-top-color', 'var(--sb-entry-focus-border)'));
    await expect(entry('search-rest')).toHaveCSS('box-shadow', await resolved(page, 'box-shadow', 'var(--sb-entry-focus-ring)'));
    await expect(page.locator('#search-rest')).toHaveCSS('box-shadow', 'none');
    await expect(page.locator('#search-rest')).toHaveCSS('border-top-width', '0px');
    await page.locator('#search-bar').focus();
    await expect(entry('search-bar')).toHaveCSS('box-shadow', await resolved(page, 'box-shadow', 'var(--sb-focus-ring-inset)'));
    await expect(page.locator('#search-bar')).toHaveCSS('box-shadow', 'none');
    await page.locator('#search-bar').blur();
}

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
        await expect(page.locator('.menu_button[aria-disabled]')).toHaveCSS('cursor', 'not-allowed');
        await expect(page.locator('[aria-busy]')).toHaveCSS('cursor', 'progress');

        await expectEntryRows(page);
        await expectSearchEntries(page, isMobile);

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
        await expect(page.locator('label[for="entry-rest"]')).toHaveCSS('transition-duration', '0s');
        await page.addStyleTag({ content: ':root { --sb-radius-button: 7px; --sb-focus-ring: #ffadba; }' });
        await expect(page.locator('#secondary')).toHaveCSS('border-radius', '7px');
    });
}

test('application shell baseline and reduced motion', async ({ page }, testInfo) => {
    await page.route('**/api/settings/save', route => route.fulfill({ json: {} }));
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'presets'));
    const settingsPage = page.locator('#sb-settings-page');
    await expect(settingsPage).toBeVisible();
    await expect(settingsPage).not.toHaveAttribute('hidden');
    await expect(page.locator('#left-nav-panel')).toHaveClass(/sb-settings-active-root/);
    await page.screenshot({ path: testInfo.outputPath('shell.png') });
    await testInfo.attach('shell', { path: testInfo.outputPath('shell.png'), contentType: 'image/png' });
    if (process.env.SB_UI_CAPTURE_ONLY === '1') return;
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const shellRoot = page.locator('#left-nav-panel');
    const motion = await shellRoot.evaluate(element => {
        const style = getComputedStyle(element);
        return { duration: style.animationDuration, delay: style.animationDelay };
    });
    expect(motion).toEqual({ duration: '0s', delay: '0s' });
    await page.locator('#sb-settings-close').click();
    await expect(settingsPage).toHaveAttribute('hidden', '');
    await expect(page.locator('#left-nav-panel')).not.toHaveClass(/sb-settings-active-root/);
});
