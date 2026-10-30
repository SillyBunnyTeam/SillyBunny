import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { dismissOpenDialogIfPresent, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const COLOR_KEYS = [
    'main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color',
    'blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color', 'shadow_color', 'border_color',
];
const TEXT_KEYS = COLOR_KEYS.slice(0, 4);
const THEME = 'Everforest Dark';

const readTheme = url => JSON.parse(readFileSync(url, 'utf8'));
const revised = readTheme(new URL(`../default/content/themes/${THEME}.json`, import.meta.url));
/** The file as it shipped before the text colors were raised, which is what these users selected. */
const previous = readTheme(new URL(`./fixtures/stale-bundled-themes/${THEME}.json`, import.meta.url));

/**
 * Answers the settings read for a user who selected Everforest Dark before the revision: the old colors and CSS saved next to
 * the theme name. The theme list carries the revised file, as the server's list does once it has replaced an unmodified copy.
 */
async function stubSavedTheme(page, { palette = {}, customCss = previous.custom_css, revision } = {}) {
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        settings.power_user = {
            ...settings.power_user,
            ...Object.fromEntries(COLOR_KEYS.map(key => [key, previous[key]])),
            ...palette,
            custom_css: customCss,
            theme: THEME,
            world_import_dialog: false,
        };
        delete settings.power_user.sb_theme_text_revision;
        if (revision !== undefined) {
            settings.power_user.sb_theme_text_revision = revision;
        }
        settings.extension_settings = settings.extension_settings || {};
        settings.extension_settings['quick-image-gen'] = { ...settings.extension_settings['quick-image-gen'], setupWizardSeen: true };
        const themes = [revised, ...data.themes.filter(theme => theme.name !== THEME)];
        return route.fulfill({ json: { ...data, themes, settings: JSON.stringify(settings) } });
    });
}

/** Records what the page tries to save, and answers as the server would. protectMaintainerServer stubs the write itself. */
async function captureSettingsSaves(page) {
    const saves = [];
    await page.route('**/api/settings/save', (route) => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        saves.push(payload);
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    return saves;
}

const REVISIONS_MODULE = '**/scripts/sillybunny-theme-revisions.js*';

/** Boots as the stubbed user. `moduleRequests` lists every request for the repair module, and `blockModule` makes them fail. */
async function boot(page, stub, { blockModule = false } = {}) {
    await protectMaintainerServer(page);
    const saves = await captureSettingsSaves(page);
    const moduleRequests = [];
    page.on('request', (request) => {
        if (request.url().includes('/sillybunny-theme-revisions.js')) {
            moduleRequests.push(request.url());
        }
    });
    if (blockModule) {
        await page.route(REVISIONS_MODULE, route => route.abort());
    }
    await stubSavedTheme(page, stub);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await dismissOpenDialogIfPresent(page);
    expect(await page.evaluate(() => window.SillyTavern.getContext().powerUserSettings.theme)).toBe(THEME);
    return { saves, moduleRequests };
}

const applied = page => page.evaluate(keys => {
    const settings = window.SillyTavern.getContext().powerUserSettings;
    const root = getComputedStyle(document.documentElement);
    return {
        saved: Object.fromEntries(keys.map(key => [key, settings[key]])),
        css: settings.custom_css,
        marker: settings.sb_theme_text_revision,
        emVariable: root.getPropertyValue('--SmartThemeEmColor').trim(),
        bodyVariable: root.getPropertyValue('--SmartThemeBodyColor').trim(),
        appliedStyle: document.getElementById('custom-style')?.innerHTML ?? '',
    };
}, TEXT_KEYS);

/** Picks another theme the way the theme list does. */
const pickTheme = (page, name) => page.evaluate((themeName) => { window.$('#themes').val(themeName).trigger('change'); }, name);
const currentTheme = page => page.evaluate(() => window.SillyTavern.getContext().powerUserSettings.theme);

const textOf = theme => Object.fromEntries(TEXT_KEYS.map(key => [key, theme[key]]));
const lastSave = saves => saves.at(-1)?.power_user;

test.describe('saved text colors of a theme that was revised', () => {
    test('an unmodified old palette and old CSS become the new ones, are saved with the marker, and switching themes asks nothing', async ({ page }) => {
        const emptyKeyNotes = [];
        page.on('console', (message) => {
            if (message.text().includes('Empty theme key')) {
                emptyKeyNotes.push(message.text());
            }
        });
        const { saves } = await boot(page, {});

        const state = await applied(page);
        expect(state.saved).toEqual(textOf(revised));
        expect(state.css).toBe(revised.custom_css);
        expect(state.marker).toBe(1);
        expect(emptyKeyNotes).toEqual([]);
        // The six colors the repair leaves alone are written back as they were saved.
        expect(await page.evaluate(keys => keys.map(key => window.SillyTavern.getContext().powerUserSettings[key]), COLOR_KEYS.slice(4))).toEqual(COLOR_KEYS.slice(4).map(key => previous[key]));
        expect(state.emVariable.replace(/\s/g, '')).toBe(revised.italics_text_color.replace(/\s/g, ''));
        expect(state.appliedStyle).toContain('--customThemeColor-hover-text');

        await expect.poll(() => lastSave(saves)?.sb_theme_text_revision, { timeout: 10_000 }).toBe(1);
        expect(textOf(lastSave(saves))).toEqual(textOf(revised));
        expect(lastSave(saves).custom_css).toBe(revised.custom_css);

        await pickTheme(page, 'Plum');
        await expect.poll(() => currentTheme(page)).toBe('Plum');
        await expect(page.locator('dialog[open]')).toHaveCount(0);
    });

    test('an old palette with CSS the user edited takes the new text colors and keeps its CSS', async ({ page }) => {
        const editedCss = `${previous.custom_css}\n#chat { gap: 2px; }`;
        const { saves } = await boot(page, { customCss: editedCss });

        const state = await applied(page);
        expect(state.saved).toEqual(textOf(revised));
        expect(state.css).toBe(editedCss);
        await expect.poll(() => lastSave(saves)?.sb_theme_text_revision, { timeout: 10_000 }).toBe(1);
        expect(lastSave(saves).custom_css).toBe(editedCss);
    });

    test('a palette the user edited is left as it is, and the marker is still recorded', async ({ page }) => {
        const palette = { italics_text_color: 'rgba(200, 120, 90, 0.5)' };
        const { saves } = await boot(page, { palette });

        const state = await applied(page);
        expect(state.saved).toEqual({ ...textOf(previous), ...palette });
        expect(state.css).toBe(previous.custom_css);
        await expect.poll(() => lastSave(saves)?.sb_theme_text_revision, { timeout: 10_000 }).toBe(1);
        expect(lastSave(saves).italics_text_color).toBe(palette.italics_text_color);
        expect(lastSave(saves).custom_css).toBe(previous.custom_css);
    });

    test('a settings file that has already been through the repair is not touched again', async ({ page }) => {
        const { saves, moduleRequests } = await boot(page, { revision: 1 });

        const state = await applied(page);
        expect(state.saved).toEqual(textOf(previous));
        expect(state.css).toBe(previous.custom_css);
        expect(moduleRequests).toEqual([]);
        expect(saves.filter(save => save.power_user?.italics_text_color === revised.italics_text_color)).toHaveLength(0);

        // The old CSS is stored in no theme now, so a switch still asks before it drops it: this is what the repair spares.
        await pickTheme(page, 'Plum');
        await expect(page.locator('dialog[open]')).not.toHaveCount(0);
        expect(await currentTheme(page)).toBe(THEME);
    });

    test('a repair module that fails to load leaves the colors alone and the marker unset, so the next start retries', async ({ page }) => {
        const warnings = [];
        page.on('console', (message) => {
            if (message.text().includes('Could not repair the saved theme text colors')) {
                warnings.push(message.text());
            }
        });
        const { saves, moduleRequests } = await boot(page, {}, { blockModule: true });

        await expect.poll(() => warnings.length, { timeout: 10_000 }).toBe(1);
        expect(moduleRequests.length).toBeGreaterThan(0);

        // Force a save, so that the captured payload shows what the page would write after the failed repair.
        await page.evaluate(() => window.SillyTavern.getContext().saveSettingsDebounced());
        await expect.poll(() => saves.length, { timeout: 10_000 }).toBeGreaterThan(0);

        const state = await applied(page);
        expect(state.saved).toEqual(textOf(previous));
        expect(state.css).toBe(previous.custom_css);
        expect(state.marker).toBeUndefined();
        expect(saves.filter(save => save.power_user?.sb_theme_text_revision !== undefined)).toHaveLength(0);
        expect(saves.filter(save => save.power_user?.italics_text_color !== previous.italics_text_color)).toHaveLength(0);
    });
});
