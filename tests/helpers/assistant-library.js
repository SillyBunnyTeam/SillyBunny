import { BUNDLED_CARD_AVATARS } from '../../public/scripts/sillybunny-home/bundled-cards.js';
import { fetchJsonOrSkip } from './route-fetch.js';

export const REISEN_AVATAR = 'default_AssistantReisen.png';
export const TEWI_AVATAR = 'default_AssistantTewi.png';

const BUNDLED_ASSISTANT_AVATARS = ['default_AssistantReisen.png', 'default_AssistantTewi.png', 'default_AssistantNahida.png'];

/**
 * A card as `/api/characters/all` lists it, made up for a spec.
 * @param {string} avatar
 * @param {string} [name]
 */
export function makeCharacterCard(avatar, name = avatar.replace(/^default_/, '').replace(/\.png$/, '')) {
    const data = {
        name, description: '', personality: '', scenario: '', first_mes: `Fixture greeting of ${name}.`, mes_example: '',
        creator_notes: '', creator: '', character_version: '', alternate_greetings: [], group_only_greetings: [],
        tags: [], extensions: { fav: false, talkativeness: 0.5 },
    };
    return { ...data, avatar, data, shallow: false, chat: `qa-${avatar}`, create_date: 1, json_data: JSON.stringify({ data }) };
}

/**
 * Account storage that keeps the assistant pointer of the maintainer out of Home: no character is pointed at, and the
 * pointer migration counts as done, so it does not move the pointer when a spec's library holds Reisen.
 * Pass it to `installFixtureChats` as `accountStorage`.
 */
export const PINNED_ASSISTANT_ACCOUNT = Object.freeze({ assistant: null, WelcomePage_AssistantPointerMigrated: 'true' });

/**
 * The account storage without what Home reads about the assistants: the pointer, its migration and the marks of
 * deleted or renamed bundled cards. A spec that boots on the account of the maintainer starts from this, so its
 * Home does not depend on which characters that account has chosen.
 * @param {Record<string, string>} accountStorage
 * @returns {Record<string, string>}
 */
export function withoutAssistantAccount(accountStorage) {
    return Object.fromEntries(Object.entries(accountStorage ?? {})
        .filter(([key]) => key !== 'assistant' && key !== 'WelcomePage_AssistantPointerMigrated' && !key.startsWith('bundledAssistant')));
}

/**
 * Makes the library hold the bundled assistants that a spec names and no others, whatever the server holds, so a Home
 * card has a file or not by the spec's choice and not by what the data root happens to contain. The other characters
 * stay as the server lists them.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} avatars The avatars of the assistant cards that the library holds.
 * @param {{ bundledOnly?: boolean }} [options] `bundledOnly` also drops every character that does not ship with
 *   SillyBunny, as `installFixtureChats` does with its option of that name. Register this route after it: a route that
 *   fetches the real response does not pass through the ones before it.
 */
export async function stubAssistantCards(page, avatars, { bundledOnly = false } = {}) {
    await page.route('**/api/characters/all', async (route) => {
        const real = await fetchJsonOrSkip(route);
        if (!real) return;
        const others = real.filter(entry => !BUNDLED_ASSISTANT_AVATARS.includes(entry.avatar) && (!bundledOnly || BUNDLED_CARD_AVATARS.includes(entry.avatar)));
        return route.fulfill({ json: [...others, ...avatars.map(avatar => makeCharacterCard(avatar, `Assistant ${avatar.replace(/^default_Assistant/, '').replace(/\.png$/, '')}`))] });
    });
}
