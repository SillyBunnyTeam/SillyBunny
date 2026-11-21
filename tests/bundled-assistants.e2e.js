import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' }, viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

const REISEN = 'default_AssistantReisen.png';
const TEWI = 'default_AssistantTewi.png';
const NAHIDA = 'default_AssistantNahida.png';
/** The Bunny Guide is no longer shipped. A user who got it from an earlier version still has the card, as an ordinary character. */
const GUIDE = 'default_SillyBunnyGuide.png';
const SERAPHINA = 'default_Seraphina.png';
const MIGRATED_KEY = 'WelcomePage_AssistantPointerMigrated';
const POINTER_KEY = 'assistant';

/** A library as a server holds it before the assistant cards of 5.5 ship: the default content only. */
const TODAY = [SERAPHINA];
/** A library that the server seeded with Reisen and Tewi, and where Nahida was never installed. Nahida ships no more. */
const SEEDED = [SERAPHINA, REISEN, TEWI];

function card(avatar) {
    const name = avatar.replace(/^default_/, '').replace(/\.png$/, '');
    const data = {
        name, description: '', personality: '', scenario: '', first_mes: 'QA greeting', mes_example: '',
        creator_notes: '', creator: '', character_version: '', alternate_greetings: [], group_only_greetings: [],
        tags: [], extensions: { fav: false, talkativeness: 0.5 },
    };
    return { ...data, avatar, data, shallow: false, chat: `qa-${avatar}`, create_date: 1, json_data: JSON.stringify({ data }) };
}

/**
 * Starts the app on Home with a library that the test names and an account storage that it seeds, both in memory.
 * The routes that import or create a character only record the call, so no spec reaches the data root of the server.
 * @param {import('@playwright/test').Page} page
 * @param {{ library: string[], accountStorage?: Record<string, string> }} options Avatars of the bundled cards in the library.
 */
async function boot(page, { library, accountStorage = {} }) {
    const world = { library: new Set(library), imports: [], creates: [] };
    const bundled = [REISEN, TEWI, NAHIDA, GUIDE, SERAPHINA];

    page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() !== 'POST') return;
        if (pathname === '/api/characters/import') world.imports.push(request.url());
        if (pathname === '/api/characters/create') world.creates.push(request.url());
    });

    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await page.route('**/api/characters/all', async (route) => {
        const real = await fetchJsonOrSkip(route);
        if (!real) return;
        return route.fulfill({ json: [...real.filter(entry => !bundled.includes(entry.avatar)), ...[...world.library].map(card)] });
    });
    await page.route('**/api/characters/import', (route) => {
        world.library.add(NAHIDA);
        return route.fulfill({ json: { file_name: NAHIDA.replace(/\.png$/, '') } });
    });
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.accountStorage = { ...withoutAssistantAccount(settings.accountStorage), ...accountStorage };
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await testSetup.waitForAppReady({ page });
    // The emitter records app_ready only after every listener has finished, so the ensure loop and the pointer migration
    // are done by now: what a test finds not to have happened did not happen at startup, and no wait is needed.
    expect(await page.evaluate(async () => {
        const { eventSource, event_types } = await import('/scripts/events.js');
        return eventSource.autoFireLastArgs.has(event_types.APP_READY);
    })).toBe(true);
    return world;
}

const stored = (page, key) => page.evaluate(async storageKey => (await import('/scripts/util/AccountStorage.js')).accountStorage.getItem(storageKey), key);
const defaultAvatar = page => page.evaluate(async () => (await import('/scripts/welcome-screen.js')).getPermanentAssistantAvatar());
const libraryAvatars = page => page.evaluate(async () => (await import('/script.js')).characters.map(entry => entry.avatar));

test.describe('the bundled assistants at startup', () => {
    test('a fresh install does not import Nahida', async ({ page }) => {
        const world = await boot(page, { library: SEEDED });

        expect(await stored(page, MIGRATED_KEY)).toBe('true');
        expect(world.imports).toEqual([]);
        expect(world.creates).toEqual([]);
        expect(await libraryAvatars(page)).not.toContain(NAHIDA);
    });

    test('an existing Nahida stays, untouched by the startup', async ({ page }) => {
        const world = await boot(page, { library: [...SEEDED, NAHIDA] });

        expect(await stored(page, MIGRATED_KEY)).toBe('true');
        expect(world.imports).toEqual([]);
        expect(await libraryAvatars(page)).toContain(NAHIDA);
        expect(await stored(page, 'bundledAssistantNahidaDeleted')).toBeNull();
    });

    test.describe('a user who installed Nahida with an earlier version', () => {
        const HER_KEYS = {
            bundledAssistantNahidaAvatar: 'My Nahida.png',
            bundledAssistantNahidaIdentityAvatar: 'My Nahida.png',
            bundledAssistantNahidaDeleted: 'true',
        };
        const herKeys = page => Promise.all(Object.keys(HER_KEYS).map(key => stored(page, key)));

        test('keeps the three account keys of her, and the startup reads and writes none of them', async ({ page }) => {
            await boot(page, { library: [...SEEDED, NAHIDA], accountStorage: HER_KEYS });

            expect(await herKeys(page)).toEqual(Object.values(HER_KEYS));
        });

        test('keeps them when her card is renamed or deleted, because no listener of the app knows her any more', async ({ page }) => {
            await boot(page, { library: [...SEEDED, NAHIDA], accountStorage: { bundledAssistantNahidaAvatar: HER_KEYS.bundledAssistantNahidaAvatar, bundledAssistantNahidaIdentityAvatar: HER_KEYS.bundledAssistantNahidaIdentityAvatar } });

            await page.evaluate(async ({ avatar }) => {
                const { eventSource, event_types } = await import('/script.js');
                await eventSource.emit(event_types.CHARACTER_RENAMED, avatar, 'Renamed Nahida.png');
                await eventSource.emit(event_types.CHARACTER_DELETED, { character: { avatar: 'Renamed Nahida.png', name: 'Assistant Nahida' } });
            }, { avatar: NAHIDA });

            expect(await herKeys(page)).toEqual(['My Nahida.png', 'My Nahida.png', null]);
        });

        test('keeps them when the card that her keys name, under the name the user gave it, is renamed or deleted', async ({ page }) => {
            const userAvatar = HER_KEYS.bundledAssistantNahidaAvatar;
            await boot(page, { library: [...SEEDED, userAvatar], accountStorage: HER_KEYS });

            await page.evaluate(async ({ avatar }) => {
                const { eventSource, event_types } = await import('/script.js');
                await eventSource.emit(event_types.CHARACTER_RENAMED, avatar, 'Renamed My Nahida.png');
                await eventSource.emit(event_types.CHARACTER_DELETED, { character: { avatar: 'Renamed My Nahida.png', name: 'My Nahida' } });
                await eventSource.emit(event_types.CHARACTER_DELETED, { character: { avatar, name: 'My Nahida' } });
            }, { avatar: userAvatar });

            expect(await herKeys(page)).toEqual(Object.values(HER_KEYS));
        });

        test('has her card in the library as an ordinary character that is not an assistant', async ({ page }) => {
            await boot(page, { library: [...SEEDED, NAHIDA] });

            expect(await libraryAvatars(page)).toContain(NAHIDA);
            expect(await defaultAvatar(page)).toBe(REISEN);
        });
    });

    test('looks for Reisen and Tewi without creating or importing them when their cards are missing', async ({ page }) => {
        const world = await boot(page, { library: TODAY });

        expect(world.imports).toEqual([]);
        expect(world.creates).toEqual([]);
        expect(await libraryAvatars(page)).not.toContain(REISEN);
        expect(await libraryAvatars(page)).not.toContain(TEWI);
    });

    test.describe('the default assistant', () => {
        test('is Reisen while her card is missing, and the account is left as it was', async ({ page }) => {
            await boot(page, { library: TODAY });

            expect(await defaultAvatar(page)).toBe(REISEN);
            expect(await stored(page, MIGRATED_KEY)).toBeNull();
            expect(await stored(page, POINTER_KEY)).toBeNull();
        });

        test('opens no card as the assistant card while Reisen has none, and does not take the kept Guide for her', async ({ page }) => {
            const world = await boot(page, { library: [...TODAY, GUIDE] });

            await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).openPermanentAssistantCard());

            expect(await page.evaluate(async () => {
                const app = await import('/script.js');
                return app.characters[app.this_chid]?.avatar ?? null;
            })).toBeNull();
            expect(world.creates).toEqual([]);
            expect(world.imports).toEqual([]);
        });

        test('opens the card of Reisen as the assistant card once she is in the library', async ({ page }) => {
            await boot(page, { library: SEEDED });

            await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).openPermanentAssistantCard());

            await expect.poll(() => page.evaluate(async () => {
                const app = await import('/script.js');
                return app.characters[app.this_chid]?.avatar ?? null;
            })).toBe(REISEN);
        });

        test('is Reisen once her card is in the library, and a pointer that names the kept Guide is moved to her', async ({ page }) => {
            await boot(page, { library: [...SEEDED, GUIDE], accountStorage: { [POINTER_KEY]: GUIDE } });

            expect(await stored(page, MIGRATED_KEY)).toBe('true');
            expect(await stored(page, POINTER_KEY)).toBe(REISEN);
            expect(await defaultAvatar(page)).toBe(REISEN);
        });

        test('keeps a pointer at the kept Guide while Reisen has no card, because the pointer is not stale', async ({ page }) => {
            await boot(page, { library: [...TODAY, GUIDE], accountStorage: { [POINTER_KEY]: GUIDE } });

            expect(await stored(page, POINTER_KEY)).toBe(GUIDE);
            expect(await stored(page, MIGRATED_KEY)).toBeNull();
            expect(await defaultAvatar(page)).toBe(GUIDE);
        });

        test('is Reisen by her card alone when the account is migrated and holds no pointer', async ({ page }) => {
            await boot(page, { library: SEEDED, accountStorage: { [MIGRATED_KEY]: 'true' } });

            expect(await stored(page, POINTER_KEY)).toBeNull();
            expect(await defaultAvatar(page)).toBe(REISEN);
        });

        test('stays Reisen when the account is migrated and her card has been removed from the library', async ({ page }) => {
            await boot(page, { library: [...TODAY, GUIDE], accountStorage: { [MIGRATED_KEY]: 'true' } });

            expect(await defaultAvatar(page)).toBe(REISEN);
        });

        test('moves a pointer that names a card of the user, because the choice was made without Reisen', async ({ page }) => {
            await boot(page, { library: [...SEEDED, 'Alice.png'], accountStorage: { [POINTER_KEY]: 'Alice.png' } });

            expect(await stored(page, MIGRATED_KEY)).toBe('true');
            expect(await defaultAvatar(page)).toBe(REISEN);
        });

        test('leaves the pointer alone once the account has been migrated', async ({ page }) => {
            await boot(page, { library: [...SEEDED, 'Alice.png'], accountStorage: { [POINTER_KEY]: 'Alice.png', [MIGRATED_KEY]: 'true' } });

            expect(await stored(page, POINTER_KEY)).toBe('Alice.png');
            expect(await defaultAvatar(page)).toBe('Alice.png');
        });

        test('waits for Reisen: a pointer stays where it is while her card is missing', async ({ page }) => {
            await boot(page, { library: [...TODAY, 'Alice.png'], accountStorage: { [POINTER_KEY]: 'Alice.png' } });

            expect(await stored(page, POINTER_KEY)).toBe('Alice.png');
            expect(await stored(page, MIGRATED_KEY)).toBeNull();
        });
    });

    test.describe('deleting the card that the assistant pointer names', () => {
        const DELETED_KEYS = ['bundledAssistantReisenDeleted', 'bundledAssistantTewiDeleted', 'bundledAssistantNahidaDeleted'];
        const markersOf = page => Promise.all(DELETED_KEYS.map(key => stored(page, key)));

        /** The errors that the event emitter logs when a listener throws, without the failed loads of the made-up thumbnails. */
        function collectListenerErrors(page) {
            const errors = [];
            page.on('console', (message) => {
                if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text());
            });
            page.on('pageerror', error => errors.push(error.message));
            return errors;
        }

        const deleteCard = (page, avatar) => page.evaluate(async (target) => {
            const { eventSource, event_types } = await import('/script.js');
            await eventSource.emit(event_types.CHARACTER_DELETED, { character: { avatar: target, name: target } });
        }, avatar);

        test('a card of the user sets no deleted marker for any assistant, and no listener throws', async ({ page }) => {
            const errors = collectListenerErrors(page);
            await boot(page, { library: [...SEEDED, 'Alice.png'], accountStorage: { [POINTER_KEY]: 'Alice.png', [MIGRATED_KEY]: 'true' } });

            await deleteCard(page, 'Alice.png');

            expect(errors).toEqual([]);
            expect(await markersOf(page)).toEqual([null, null, null]);
        });

        test('Tewi is still marked as deleted when the pointer names her card, which Reisen shares the key of', async ({ page }) => {
            const errors = collectListenerErrors(page);
            await boot(page, { library: SEEDED, accountStorage: { [POINTER_KEY]: TEWI, [MIGRATED_KEY]: 'true' } });

            await deleteCard(page, TEWI);

            expect(errors).toEqual([]);
            expect(await markersOf(page)).toEqual([null, 'true', null]);
        });
    });

    test('deletes the keys that no code reads any more, from the account and from the browser', async ({ page }) => {
        const RETIRED_ACCOUNT = {
            WelcomePage_DeckView: 'wide',
            WelcomePage_TutorialStatus: 'done',
            WelcomePage_TutorialIndex: '3',
            bundledAssistantGuideAvatar: 'My Guide.png',
            bundledAssistantGuideDeleted: 'true',
        };
        await page.addInitScript(() => {
            window.localStorage.setItem('sb-frontend-icon', 'badge');
            window.localStorage.setItem('WelcomePage_DeckView', 'wide');
        });

        await boot(page, { library: SEEDED, accountStorage: { ...RETIRED_ACCOUNT, WelcomePage_PanelMode: 'compact' } });

        expect(await Promise.all(Object.keys(RETIRED_ACCOUNT).map(key => stored(page, key)))).toEqual([null, null, null, null, null]);
        expect(await stored(page, 'WelcomePage_PanelMode')).toBe('compact');
        expect(await page.evaluate(() => ['sb-frontend-icon', 'WelcomePage_DeckView'].map(key => window.localStorage.getItem(key)))).toEqual([null, null]);
    });

    test('the deleted marker of Reisen and Tewi follows the deletion of their cards', async ({ page }) => {
        await boot(page, { library: SEEDED });

        await page.evaluate(async ({ reisen, tewi }) => {
            const { eventSource, event_types } = await import('/script.js');
            await eventSource.emit(event_types.CHARACTER_DELETED, { character: { avatar: reisen, name: 'Reisen' } });
            await eventSource.emit(event_types.CHARACTER_DELETED, { character: { avatar: tewi, name: 'Tewi' } });
        }, { reisen: REISEN, tewi: TEWI });

        expect(await stored(page, 'bundledAssistantReisenDeleted')).toBe('true');
        expect(await stored(page, 'bundledAssistantTewiDeleted')).toBe('true');
    });
});
