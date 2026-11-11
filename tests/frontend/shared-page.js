import { test as base, expect } from '@playwright/test';
import { testSetup as appSetup } from './frontent-test-utils.js';

export { expect };

/** @type {WeakMap<import('@playwright/test').Page, string>} */
const bootStates = new WeakMap();

/**
 * Copies the chat metadata and the global variables of the page, and marks the page as booted.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
async function readBootState(page) {
    return await page.evaluate(async () => {
        const { chat_metadata } = await import('/script.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        window.sillyBunnySharedPage = true;
        return JSON.stringify({
            chatMetadata: chat_metadata,
            globalVariables: extension_settings.variables?.global ?? {},
        });
    });
}

/**
 * Puts back the chat metadata, which holds the local variables, and the global variables of the boot.
 * @param {import('@playwright/test').Page} page
 */
async function restoreBootState(page) {
    const booted = await page.evaluate(async snapshot => {
        if (window.sillyBunnySharedPage !== true) {
            return false;
        }
        const { chat_metadata } = await import('/script.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const { chatMetadata, globalVariables } = JSON.parse(snapshot);
        for (const key of Object.keys(chat_metadata)) {
            if (!Object.hasOwn(chatMetadata, key)) {
                delete chat_metadata[key];
            }
        }
        Object.assign(chat_metadata, chatMetadata);
        if (extension_settings.variables) {
            extension_settings.variables.global = globalVariables;
        }
        return true;
    }, bootStates.get(page));
    if (!booted) {
        throw new Error('The shared page loaded a new document after its boot. Tests that use shared-page.js must not navigate.');
    }
}

/**
 * A `test` whose `page` is booted once for each worker and shared by the tests of every file that imports it.
 * Before each test, the page gets back the chat metadata and the global variables of its boot. Playwright replaces
 * the worker after a failed test, so a failure does not pass its state on.
 *
 * Only files that leave no other state behind, that do not navigate and that set no `test.use()` options may
 * import it. The page takes only `baseURL` and `extraHTTPHeaders` from the config.
 */
export const test = base.extend({
    sharedPage: [async ({ browser }, use, workerInfo) => {
        const { baseURL, extraHTTPHeaders } = workerInfo.project.use;
        const context = await browser.newContext({ baseURL, extraHTTPHeaders });
        const page = await context.newPage();
        await appSetup.awaitST({ page });
        // The page lives longer than the settings save debounce. Its saves would race the saves of other workers
        // on the same server, and the loser gets the settings conflict prompt and no more saves.
        let settingsVersion = Date.now();
        await page.route('**/api/settings/save', route => {
            let sentVersion = 0;
            try {
                sentVersion = Number(route.request().postDataJSON()?._version) || 0;
            } catch {
                // A compressed request body is not JSON. The start value is higher than any server version.
            }
            settingsVersion = Math.max(settingsVersion, sentVersion) + 1;
            return route.fulfill({ status: 200, json: { version: settingsVersion } });
        });
        bootStates.set(page, await readBootState(page));
        await use(page);
        await context.close();
    }, { scope: 'worker', timeout: 60_000 }],

    page: async ({ sharedPage }, use) => {
        await restoreBootState(sharedPage);
        await use(sharedPage);
    },
});

/**
 * The shared page has booted already, so the setup steps of a test have nothing to load.
 */
export const testSetup = {
    ...appSetup,
    goST: async () => {},
    awaitST: async () => {},
};
