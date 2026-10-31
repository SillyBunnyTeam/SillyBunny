import { gunzipSync } from 'node:zlib';
import { BUNDLED_CARD_AVATARS } from '../../public/scripts/sillybunny-home/bundled-cards.js';
import { fetchJsonOrSkip } from './route-fetch.js';

/** The account storage key that holds the progress of Getting Started. */
export const GETTING_STARTED_KEY = 'WelcomePage_GettingStarted';

/**
 * The stored value of Getting Started, as the app writes it.
 * @param {{ hidden?: boolean, hiddenBy?: 'auto' | 'account', steps?: Record<string, 'done' | 'skipped' | null>, characterVariant?: string }} [parts]
 */
export function gettingStartedValue({ hidden = false, hiddenBy, steps = {}, characterVariant } = {}) {
    return JSON.stringify({
        hidden,
        ...(hiddenBy ? { hiddenBy } : {}),
        steps: { connect: null, preset: null, character: null, chat: null, ...steps },
        ...(characterVariant ? { characterVariant } : {}),
    });
}

/**
 * Makes the settings of a spec independent of the account they were saved by. The saved connection of a
 * maintainer's server reports a status at boot, such as "Status check bypassed" for a custom endpoint, and that would
 * finish Connect a Model before the test starts. The bypass is decided before any request goes out, so the settings
 * themselves have to name a source that has none; `stubGettingStarted` also answers the status request with an error.
 * @param {Record<string, any>} settings The parsed `settings` of `/api/settings/get`, changed in place.
 * @param {{ value?: string | null, firstRun?: boolean }} [options] `value` is the stored checklist, and `null` leaves none.
 *   `firstRun` is left as it is when it is not given.
 */
export function applyGettingStartedSettings(settings, { value = gettingStartedValue(), firstRun } = {}) {
    settings.accountStorage = { ...settings.accountStorage };
    if (value === null) {
        delete settings.accountStorage[GETTING_STARTED_KEY];
    } else {
        settings.accountStorage[GETTING_STARTED_KEY] = value;
    }
    if (firstRun !== undefined) {
        settings.firstRun = firstRun;
    }
    settings.main_api = 'openai';
    settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'openai', bypass_status_check: false };
}

/**
 * Decides what the page loads for Getting Started, and keeps the rest of the account out of the way:
 * - the stored checklist: by default shown with every step open, which is what a spec about Home expects (an account
 *   with no stored value is an existing one, and its checklist starts hidden; pass `value: null` for that account);
 * - the saved connection, which is neutralised (see `applyGettingStartedSettings`), and its status request fails;
 * - the library of cards, only with `bundledCardsOnly`: it then holds only the cards that ship with SillyBunny, so a card
 *   of the maintainer does not finish Get a Character Card. A spec that asserts a count of finished steps needs it; a test
 *   that needs another card adds it in the page.
 * Call it after `protectMaintainerServer` and after any other route that reads `/api/settings/get` itself: the last
 * route registered answers first, and a route that fetches the real response does not pass through the others.
 * @param {import('@playwright/test').Page} page
 * @param {{ value?: string | null, firstRun?: boolean, bundledCardsOnly?: boolean }} [options]
 */
export async function stubGettingStarted(page, { value = gettingStartedValue(), firstRun, bundledCardsOnly = false } = {}) {
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyGettingStartedSettings(settings, { value, firstRun });
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/backends/chat-completions/status', route => route.fulfill({ json: { error: true } }));
    if (!bundledCardsOnly) {
        return;
    }
    await page.route('**/api/characters/all', async (route) => {
        const cards = await fetchJsonOrSkip(route);
        if (!cards) return;
        return route.fulfill({ json: cards.filter(card => BUNDLED_CARD_AVATARS.includes(card.avatar)) });
    });
}

/**
 * Records what the app saves into the account storage, without letting it reach the server.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ accountStorage: Record<string, string>, saves: number }>} Updated in place by each save.
 */
export async function captureAccountStorageSaves(page) {
    const captured = { accountStorage: {}, saves: 0 };
    await page.route('**/api/settings/save', (route) => {
        const request = route.request();
        const buffer = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(buffer.toString());
        captured.accountStorage = payload.accountStorage ?? {};
        captured.saves += 1;
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    return captured;
}

/** @param {{ accountStorage: Record<string, string> }} captured */
export function savedGettingStarted(captured) {
    const raw = captured.accountStorage[GETTING_STARTED_KEY];
    return raw === undefined ? null : JSON.parse(raw);
}
