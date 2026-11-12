import { IMPORT_PENDING_KEY, SEEN_VERSION_KEY, SHOW_AT_STARTUP_KEY } from '../../public/scripts/sillybunny-welcome-startup.js';
import { fetchJsonOrSkip } from './route-fetch.js';

export { IMPORT_PENDING_KEY, SEEN_VERSION_KEY, SHOW_AT_STARTUP_KEY };

/** The Welcome dialog of a boot, by the class its surface carries. */
export const WELCOME_SELECTOR = 'dialog[open] .sbWelcomeDialog';

/**
 * What a boot says about Welcome:
 * - `closed`: the account has met Welcome and turned Show at Startup off, which keeps it shut.
 * - `show-at-startup`: Show at Startup is on, so Welcome opens once the app is ready.
 * - `never-seen`: the account has never met Welcome, so it opens once.
 * @typedef {'closed' | 'show-at-startup' | 'never-seen'} WelcomeState
 */

/**
 * Makes the settings of a spec say whether Welcome opens at startup. A spec that is not about Welcome keeps the
 * default, `closed`, so the dialog does not cover the page it tests. `firstRun` is not touched: a first run opens
 * Welcome whatever these keys say, and `answerFirstRunWelcome` ends it.
 * @param {Record<string, any>} settings The parsed `settings` of `/api/settings/get`, changed in place.
 * @param {{ welcome?: WelcomeState }} [options]
 */
export function applyWelcomeSettings(settings, { welcome = 'closed' } = {}) {
    const accountStorage = { ...settings.accountStorage };
    delete accountStorage[SHOW_AT_STARTUP_KEY];
    delete accountStorage[SEEN_VERSION_KEY];
    if (welcome !== 'never-seen') {
        accountStorage[SEEN_VERSION_KEY] = 'qa';
        accountStorage[SHOW_AT_STARTUP_KEY] = welcome === 'show-at-startup' ? 'true' : 'false';
    }
    settings.accountStorage = accountStorage;
}

/**
 * Keeps Welcome closed for every page of a context that has no `/api/settings/get` route of its own. A page route
 * answers first and, when it fetches the real response, this one is never asked: such a spec uses
 * `applyWelcomeSettings` itself.
 * @param {import('@playwright/test').BrowserContext} context
 */
export async function keepWelcomeClosed(context) {
    await context.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyWelcomeSettings(settings);
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
}

/**
 * Ends the Welcome dialog of a first run by naming the persona. Show at Startup is turned off on the way out, because
 * the first run turns it on and a later boot of the same data root would otherwise open Welcome again.
 * @param {import('@playwright/test').Page} page
 * @param {{ name?: string, showAtStartup?: boolean }} [options]
 */
export async function answerFirstRunWelcome(page, { name = 'Test User', showAtStartup = false } = {}) {
    const host = page.locator('dialog.sb-dialog-host:not([closing])');
    const shown = host.locator('.sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving)');
    await shown.getByRole('button', { name: 'Next', exact: true }).click();
    await shown.getByRole('textbox', { name: 'Your Name' }).fill(name);
    await shown.getByRole('button', { name: 'Next', exact: true }).click();
    if (!showAtStartup) {
        await shown.getByRole('switch', { name: 'Show at Startup' }).uncheck();
    }
    await shown.getByRole('button', { name: 'Start', exact: true }).click();
    await host.waitFor({ state: 'detached' });
}
