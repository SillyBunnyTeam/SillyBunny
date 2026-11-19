import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { showSettingsSidebar } from './helpers/settings-phone-pane.js';

// Customize > Appearance: Custom CSS is a row of the UI Theme group that opens a Window with the editor, and
// "Reset Theme to Default Libadwaita" asks first and then restores the shipped theme and the look settings beside it.

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

const MESSAGE = 'Theme reset to default Libadwaita';
const BODY = 'Theme settings and custom CSS will be wiped. This is irreversible!';

/** What the page starts with: every key the reset writes is off its default. */
const IN_SCOPE_START = {
    theme: 'Libadwaita Light',
    main_text_color: 'rgba(1, 2, 3, 1)',
    italics_text_color: 'rgba(4, 5, 6, 1)',
    underline_text_color: 'rgba(7, 8, 9, 1)',
    quote_text_color: 'rgba(10, 11, 12, 1)',
    blur_tint_color: 'rgba(13, 14, 15, 0.5)',
    chat_tint_color: 'rgba(16, 17, 18, 0.5)',
    user_mes_blur_tint_color: 'rgba(19, 20, 21, 0.5)',
    bot_mes_blur_tint_color: 'rgba(22, 23, 24, 0.5)',
    shadow_color: 'rgba(25, 26, 27, 0.5)',
    border_color: 'rgba(28, 29, 30, 0.5)',
    custom_css: '.sb-reset-probe { color: red; }',
    'customCSS-bg-blur': 4,
    'customCSS-bg-opacity': 0.5,
    sheldBlurStrength: 3,
    sheldBackgroundColor: 'rgba(1, 1, 1, 0.5)',
    blur_strength: 5,
    shadow_width: 4,
    google_font: 'Inter',
};
/** Settings that are not theme settings: Reset leaves them as they were. */
const OUT_OF_SCOPE_START = {
    chat_width: 70,
    font_scale: 1.2,
    line_spacing: 1.4,
    message_margin_size: 2,
    avatar_style: 1,
    chat_display: 1,
    reduced_motion: true,
    fast_ui_mode: false,
    noShadows: true,
    waifuMode: true,
};
const RESET = {
    theme: 'Libadwaita',
    main_text_color: 'rgba(255, 255, 255, 1)',
    italics_text_color: 'rgba(170, 170, 172, 1)',
    underline_text_color: 'rgba(170, 170, 172, 1)',
    quote_text_color: 'rgba(129, 208, 255, 1)',
    blur_tint_color: 'rgba(34, 34, 38, 0.9)',
    chat_tint_color: 'rgba(29, 29, 32, 0.9)',
    user_mes_blur_tint_color: 'rgba(29, 29, 32, 0.9)',
    bot_mes_blur_tint_color: 'rgba(29, 29, 32, 0.9)',
    shadow_color: 'rgba(0, 0, 6, 0.36)',
    border_color: 'rgba(0, 0, 6, 0.5)',
    custom_css: '',
    'customCSS-bg-blur': 0,
    'customCSS-bg-opacity': 1,
    sheldBlurStrength: 0,
    sheldBackgroundColor: 'transparent',
    blur_strength: 13,
    shadow_width: 2,
    google_font: '',
};

async function loadSettings(page, baseURL, { powerUser = {}, editSavedLibadwaita = false } = {}) {
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    const saved = [];
    const themeSaves = [];
    let version = 1_000_000_000_000_000;
    await page.route('**/api/settings/save', route => {
        saved.push(route.request().postDataJSON());
        return route.fulfill({ json: { result: 'ok', version: ++version } });
    });
    await page.route('**/api/themes/save', route => {
        themeSaves.push(route.request().postDataJSON());
        return route.fulfill({ json: { result: 'ok' } });
    });
    await page.route('**/api/settings/get', async route => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        applyWelcomeSettings(settings);
        Object.assign(settings.power_user, powerUser);
        if (editSavedLibadwaita) {
            // The server never overwrites an edited copy of a bundled theme, so a user's "Libadwaita" can differ from the shipped file.
            data.themes = data.themes.map(theme => theme.name === 'Libadwaita'
                ? { ...theme, quote_text_color: 'rgba(200, 0, 0, 1)', main_text_color: 'rgba(9, 9, 9, 1)', custom_css: '.edited { color: red; }' }
                : theme);
        }
        data.request_compression = { ...data.request_compression, enabled: false };
        data.settings = JSON.stringify(settings);
        return route.fulfill({ response, json: data });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout: 60000 });
    return { saved, themeSaves };
}

async function openAppearance(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
    await page.locator('button[data-sb-settings-tab="appearance"]').evaluate(element => element.click());
    const panel = page.locator('[data-sb-panel="appearance"]');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    return panel;
}

const themeGroup = panel => panel.locator('[data-sb-category="ui-theme"]');
const cssRow = panel => themeGroup(panel).locator('[data-sb-editor-field="custom-css"]');
const resetRow = panel => themeGroup(panel).locator('[data-sb-editor-field="theme-reset"]');
const cssWindow = page => page.locator('.sb-custom-css-window');
const alertOf = page => page.locator('[role="alertdialog"]');
const bodyColor = page => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').trim());

/** The `power_user` of the last settings save a test saw, or undefined before one. */
const lastSaved = saved => saved.at(-1)?.power_user;

async function openWindow(page, panel) {
    await cssRow(panel).scrollIntoViewIfNeeded();
    await cssRow(panel).click();
    await expect(cssWindow(page)).toBeVisible();
}

async function confirmReset(page, panel, response) {
    await resetRow(panel).scrollIntoViewIfNeeded();
    await resetRow(panel).click();
    await expect(alertOf(page)).toBeVisible();
    await alertOf(page).getByRole('button', { name: response, exact: true }).click();
    await expect(alertOf(page)).toHaveCount(0);
}

for (const viewport of VIEWPORTS) {
    test.describe(`at ${viewport.width}x${viewport.height}`, () => {
        test.use({ viewport });

        test('the UI Theme group lists Custom CSS and then the reset row, and the old Custom CSS group is gone', async ({ page, baseURL }) => {
            await loadSettings(page, baseURL);
            const panel = await openAppearance(page);
            const rows = themeGroup(panel).locator('> .ds-pref-group > .ds-row');
            await expect(rows.last()).toHaveAttribute('data-sb-editor-field', 'theme-reset');
            await expect(rows.nth(-2)).toHaveAttribute('data-sb-editor-field', 'custom-css');
            await expect(cssRow(panel)).toContainText('Custom CSS');
            await expect(cssRow(panel).locator('.ds-row__chevron')).toHaveCount(1);
            await expect(resetRow(panel)).toContainText('Reset Theme to Default Libadwaita');
            await expect(panel.locator('[data-sb-category="custom-css"]')).toHaveCount(0);
            await expect(page.locator('#customCSS')).toHaveCount(1);
            await expect(page.locator('#customCSS')).toBeHidden();
        });

        test('the row opens a Window whose editor edits and saves #customCSS, with the wand and the save state in its header bar', async ({ page, baseURL }) => {
            const { themeSaves } = await loadSettings(page, baseURL);
            const panel = await openAppearance(page);
            await openWindow(page, panel);
            const dialog = cssWindow(page);

            await expect(dialog.getByRole('heading', { name: 'Custom CSS' })).toBeVisible();
            const editor = dialog.locator('#customCSS');
            await expect(editor).toBeVisible();
            const size = await editor.evaluate(node => ({ height: node.getBoundingClientRect().height, family: getComputedStyle(node).fontFamily }));
            expect(size.height).toBeGreaterThan(viewport.height * 0.4);
            expect(size.family.toLowerCase()).toContain('mono');
            await expect(dialog.locator('.ds-row-textarea__expand')).toBeHidden();

            const header = dialog.locator('.sb-dialog__header-end');
            await expect(header.locator('#custom_css_ai_wand')).toBeVisible();
            await expect(header.locator('#custom_css_save_state')).toBeVisible();

            await editor.fill('.sb-window-probe { color: rgb(1, 2, 3); }');
            await expect(page.locator('#custom-style')).toHaveJSProperty('textContent', '.sb-window-probe { color: rgb(1, 2, 3); }');
            await expect(header.locator('#custom_css_save_state')).toHaveClass(/custom_css_save_state_dirty/);
            await header.locator('#custom_css_save_state').click();
            await expect.poll(() => themeSaves.at(-1)?.custom_css).toBe('.sb-window-probe { color: rgb(1, 2, 3); }');
            await expect(header.locator('#custom_css_save_state')).not.toHaveClass(/custom_css_save_state_dirty/);

            await header.locator('#custom_css_ai_wand').click();
            await expect(page.getByRole('heading', { name: 'Generate Custom CSS' })).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(page.getByRole('heading', { name: 'Generate Custom CSS' })).toBeHidden();
            await expect(dialog).toBeVisible();
        });

        test('Escape and Close return focus to the row, and #customCSS keeps its value while the Window is closed', async ({ page, baseURL }) => {
            await loadSettings(page, baseURL);
            const panel = await openAppearance(page);
            await openWindow(page, panel);
            await cssWindow(page).locator('#customCSS').fill('.sb-keep { color: blue; }');

            await page.keyboard.press('Escape');
            await expect(cssWindow(page)).toHaveCount(0);
            await expect(cssRow(panel)).toBeFocused();
            await expect(page.locator('#customCSS')).toBeHidden();
            await expect(page.locator('#customCSS')).toHaveValue('.sb-keep { color: blue; }');
            await expect(page.locator('#custom-style')).toHaveJSProperty('textContent', '.sb-keep { color: blue; }');

            await cssRow(panel).click();
            await expect(cssWindow(page).locator('#customCSS')).toHaveValue('.sb-keep { color: blue; }');
            await cssWindow(page).getByRole('button', { name: 'Close' }).click();
            await expect(cssWindow(page)).toHaveCount(0);
            await expect(cssRow(panel)).toBeFocused();
        });

        test('settings search finds Custom CSS and leaves its row showing', async ({ page, baseURL }) => {
            await loadSettings(page, baseURL);
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
            await expect(page.locator('button[data-sb-settings-tab="appearance"]')).toHaveAttribute('aria-selected', 'true');
            await showSettingsSidebar(page);
            const toggle = page.locator('#sb-settings-search-toggle');
            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            await page.locator('#sb-settings-search-input').fill('Custom CSS');
            const panel = page.locator('[data-sb-panel="appearance"]');
            await expect(page.locator('button[data-sb-settings-tab="appearance"] .sb-settings-tab-badge')).toHaveText(/^[1-9]\d*$/);
            await expect(cssRow(panel)).not.toHaveClass(/sb-settings-row--filtered/);
            await expect(resetRow(panel)).toHaveClass(/sb-settings-row--filtered/);
        });

        test('Cancel and Escape on the reset confirmation change nothing', async ({ page, baseURL }) => {
            const { saved } = await loadSettings(page, baseURL, { powerUser: { ...IN_SCOPE_START, ...OUT_OF_SCOPE_START } });
            const panel = await openAppearance(page);
            await resetRow(panel).scrollIntoViewIfNeeded();
            await resetRow(panel).click();
            const alert = alertOf(page);
            await expect(alert.getByRole('heading', { name: 'Reset Theme?' })).toBeVisible();
            await expect(alert).toContainText(BODY);
            await expect(alert.getByRole('button', { name: 'Cancel' })).toBeVisible();
            await expect(alert.getByRole('button', { name: 'Reset', exact: true })).toBeVisible();
            const before = saved.length;

            await alert.getByRole('button', { name: 'Cancel' }).click();
            await expect(alert).toHaveCount(0);
            await resetRow(panel).click();
            await expect(alert).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(alert).toHaveCount(0);

            await expect(page.locator('#customCSS')).toHaveValue(IN_SCOPE_START.custom_css);
            await expect(page.locator('#themes')).toHaveValue('Libadwaita Light');
            expect(await bodyColor(page)).toBe(IN_SCOPE_START.main_text_color);
            await expect(page.locator('#toast-container .toast-message', { hasText: MESSAGE })).toHaveCount(0);
            expect(saved.slice(before).filter(body => body.power_user.custom_css !== IN_SCOPE_START.custom_css)).toEqual([]);
        });

        test('Reset restores every key in scope, clears Custom CSS, leaves the other settings and shows the notice', async ({ page, baseURL }) => {
            const { saved } = await loadSettings(page, baseURL, { powerUser: { ...IN_SCOPE_START, ...OUT_OF_SCOPE_START } });
            const panel = await openAppearance(page);
            await confirmReset(page, panel, 'Reset');

            await expect(page.locator('#toast-container .toast-message', { hasText: MESSAGE })).toHaveCount(1);
            await expect(page.locator('#customCSS')).toHaveValue('');
            await expect(page.locator('#custom-style')).toHaveJSProperty('textContent', '');
            await expect(page.locator('#themes')).toHaveValue('Libadwaita');
            await expect(themeGroup(panel).locator('.ds-select-row__value')).toHaveText('Libadwaita');
            await expect(page.locator('#blur_strength')).toHaveValue('13');
            await expect(page.locator('#shadow_width')).toHaveValue('2');
            expect(await bodyColor(page)).toBe(RESET.main_text_color);

            await expect.poll(() => lastSaved(saved)?.custom_css).toBe('');
            const power = lastSaved(saved);
            for (const [key, value] of Object.entries(RESET)) expect(power[key], key).toBe(value);
            for (const [key, value] of Object.entries(OUT_OF_SCOPE_START)) expect(power[key], key).toBe(value);
        });

        test('Reset takes the shipped theme, not the user\'s edited copy of Libadwaita', async ({ page, baseURL }) => {
            const { saved } = await loadSettings(page, baseURL, { powerUser: { ...IN_SCOPE_START }, editSavedLibadwaita: true });
            const panel = await openAppearance(page);
            await confirmReset(page, panel, 'Reset');
            await expect.poll(() => lastSaved(saved)?.quote_text_color).toBe(RESET.quote_text_color);
            expect(lastSaved(saved).main_text_color).toBe(RESET.main_text_color);
            expect(lastSaved(saved).custom_css).toBe('');
        });
    });
}
