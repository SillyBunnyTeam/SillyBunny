import { applyHomeTestSettings } from './getting-started-state.js';
import { fetchJsonOrSkip } from './route-fetch.js';

/**
 * The settings the app reads, with the palette of one bundled theme copied into the user's settings, so a test can see a
 * surface in a dark and in a light theme.
 * @param {import('@playwright/test').Page} page
 * @param {string} themeName The name of a bundled theme, such as `Libadwaita Light`.
 */
export async function stubTheme(page, themeName) {
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings, { firstRun: false });
        const palette = { ...data.themes.find(entry => entry.name === themeName) };
        delete palette.name;
        settings.power_user = { ...settings.power_user, ...palette, theme: themeName, world_import_dialog: false };
        settings.extension_settings = settings.extension_settings || {};
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
}
