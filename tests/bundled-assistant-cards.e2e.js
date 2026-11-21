import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { assertIsolatedServer, protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

/**
 * The cards that ship in `default/content`, read through the real server: nothing here stubs the library, so a
 * spec of this file sees what the seeding of a data root made. It needs a data root that holds only the cards that
 * ship with SillyBunny, which a fresh one does.
 */
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const REISEN = 'default_AssistantReisen.png';
const TEWI = 'default_AssistantTewi.png';
const LEXICON = 'SillyBunny Lexicon';
const STARTUP_TIMEOUT = 30_000;

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

const cardOf = (page, key) => page.locator(`#chat > .welcomePanel .sbHomeCard[data-sb-home-key="${key}"]`);
const gettingStartedProgress = page => page.locator('#chat > .welcomePanel .sbHomeTile[data-sb-home-key="getting-started"] .sbHomeTileSub');
const stored = (page, key) => page.evaluate(async storageKey => (await import('/scripts/util/AccountStorage.js')).accountStorage.getItem(storageKey), key);

test.beforeEach(({ baseURL }) => {
    assertIsolatedServer(baseURL, 'Bundled assistant cards');
});

/**
 * Starts the app on Home with an account that has never chosen an assistant, so the pointer migration has work to do.
 * Saved settings never reach the server.
 * @param {import('@playwright/test').Page} page
 */
async function boot(page) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.accountStorage = withoutAssistantAccount(settings.accountStorage);
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await testSetup.waitForAppReady({ page });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(cardOf(page, 'assistant-reisen')).toBeVisible({ timeout: STARTUP_TIMEOUT });
}

for (const { name, options } of VIEWPORTS) {
    test.describe(`the cards of Reisen and Tewi that the server seeded, at ${name}`, () => {
        test.use(options);

        test('Home lists both as usable cards with both chat buttons, and offers no Restore', async ({ page }) => {
            await boot(page);

            for (const key of ['assistant-reisen', 'assistant-tewi']) {
                const card = cardOf(page, key);
                await expect(card.locator('.sbHomeCardOpen'), key).toBeEnabled();
                await expect(card.locator('.sbHomeFootButton'), key).toHaveCount(2);
                await expect(card.locator('.sbHomeFootButton').first(), key).toBeEnabled();
                await expect(card.locator('.sbHomeFootButton').last(), key).toBeEnabled();
                await expect(card.locator('.sbHomeFootButton', { hasText: 'Restore' }), key).toHaveCount(0);
            }
        });

        test('moves the pointer of an account that never chose to the card of Reisen, and asks for nothing', async ({ page }) => {
            await boot(page);

            await expect.poll(() => stored(page, 'assistant')).toBe(REISEN);
            expect(await stored(page, 'WelcomePage_AssistantPointerMigrated')).toBe('true');
            await expect(page.locator('dialog[open], .popup')).toHaveCount(0);
        });

        test('are not the character of the user, so Getting Started has no step done', async ({ page }) => {
            await boot(page);

            await expect(gettingStartedProgress(page)).toHaveText('0 of 4');
        });
    });
}

test.describe('the cards in the library', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('link the SillyBunny Lexicon, which the server holds as a world, and bring no book of their own', async ({ page }) => {
        await boot(page);

        const library = await page.evaluate(async ([avatars]) => {
            const { characters } = await import('/script.js');
            return avatars.map(avatar => {
                const card = characters.find(entry => entry.avatar === avatar);
                return { avatar, world: card?.data?.extensions?.world ?? null, hasBook: Boolean(card?.data?.character_book) };
            });
        }, [[REISEN, TEWI]]);
        const world = await page.evaluate(async (worldName) => {
            const { getRequestHeaders } = await import('/script.js');
            const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: worldName }) });
            const { entries = {} } = response.ok ? await response.json() : {};
            return { ok: response.ok, overview: Object.values(entries).some(entry => /^A0 /.test(entry.comment)) };
        }, LEXICON);

        expect(library).toEqual([{ avatar: REISEN, world: LEXICON, hasBook: false }, { avatar: TEWI, world: LEXICON, hasBook: false }]);
        expect(world).toEqual({ ok: true, overview: true });
    });
});
