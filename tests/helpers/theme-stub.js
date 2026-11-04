import { applyHomeTestSettings } from './getting-started-state.js';
import { fetchJsonOrSkip } from './route-fetch.js';

/**
 * Answers `/api/settings/get` with the palette of one bundled theme copied into the account's settings, as if the user had
 * picked it. The settings save stays the caller's business.
 * @param {import('@playwright/test').Page} page
 * @param {string} themeName The `name` of a file in `default/content/themes`.
 * @param {{ tint?: string }} [options] `tint` replaces the chat tint of the palette.
 */
export async function stubTheme(page, themeName, { tint } = {}) {
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings, { firstRun: false });
        const palette = { ...data.themes.find(entry => entry.name === themeName) };
        delete palette.name;
        if (tint) {
            palette.chat_tint_color = tint;
        }
        settings.power_user = { ...settings.power_user, ...palette, theme: themeName, world_import_dialog: false };
        settings.extension_settings = settings.extension_settings || {};
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
}
