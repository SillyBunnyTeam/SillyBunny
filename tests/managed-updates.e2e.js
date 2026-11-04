import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { makeCharacterCard, withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats, registerFixtureChat } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const COPY_PLACEHOLDER = 'TODO(copy)';
const DISMISSED_KEY = 'WelcomePage_ManagedDismissed';

const REISEN = 'default_AssistantReisen.png';
const TEWI = 'default_AssistantTewi.png';
const NAMES = { [REISEN]: 'Assistant Reisen', [TEWI]: 'Assistant Tewi' };
const MIGRATED = { WelcomePage_AssistantPointerMigrated: 'true' };

// The files that the server would manage are the ones of the fixture manifest, so the specs name what ships in it.
const FIXTURE_ITEMS = JSON.parse(readFileSync(new URL('./fixtures/managed-content/content/sillybunny-managed.json', import.meta.url), 'utf8'))
    .items.map(({ filename, type, version }) => ({ filename, type, version }));
const SPRITES = 'Assistant Reisen';
const WORLD = 'SillyBunny Lexicon.json';

const HOME = '#chat > .welcomePanel';
const cardOf = (page, key) => page.locator(`${HOME} .sbHomeCard[data-sb-home-key="${key}"]`);
const menuOf = card => card.locator('.sbHomeRowMenu');
const hosts = page => page.locator('dialog.sb-dialog-host:not([closing])');
const alertOf = page => hosts(page).locator('.sb-dialog--alert');
const restoreOf = (page, key = 'assistant-reisen') => cardOf(page, key).locator('.sbHomeFootButton', { hasText: 'Restore' });
const failureToast = page => page.locator('#toast-container .toast-message[data-sb-copy-slot="AS-ACTION-ERROR"]');
const stored = (page, key) => page.evaluate(async storageKey => (await import('/scripts/util/AccountStorage.js')).accountStorage.getItem(storageKey), key);
const renderHome = page => page.evaluate(async () => (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true }));
// The app shows other success toasts of its own at start, so the message is told by its text.
/** A toast stays for a few seconds, so a check that it is absent must look at once: a retrying check would pass when the toast leaves. */
const expectNoToast = async locator => expect(await locator.count()).toBe(0);
const updatedToast = page => page.locator('#toast-container .toast-success .toast-message').filter({ hasText: 'A backup of your version was kept' });
const labelsOfOpenMenu = async (page, key) => {
    await openMenu(page, key);
    const labels = await menuLabels(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    return labels;
};
const openMenu = async (page, key) => {
    await menuOf(cardOf(page, key)).click();
    await expect(page.getByRole('menu')).toBeVisible();
};
const menuLabels = page => page.getByRole('menuitem').allTextContents();

/**
 * Starts the app on Home with a library and a managed content server that the test makes up, in memory. The status
 * the server answers with and the requests it receives are the test's; no file of the data root is read or written.
 * @param {import('@playwright/test').Page} page
 * @param {object} options
 * @param {string[]} options.library The avatars of the cards in the library.
 * @param {Record<string, object>} [options.status] Per bundled filename, what the status says beyond a current file.
 * @param {Record<string, string>} [options.accountStorage]
 * @param {number} [options.statusDelay] How long the server takes to answer the status, in milliseconds.
 * @param {boolean} [options.statusFails] Whether the status route refuses every read.
 * @param {boolean} [options.statusEmpty] Whether the status lists no file, which is what a server with no managed content sends.
 */
async function boot(page, { library, status = {}, accountStorage = {}, statusDelay = 0, statusFails = false, statusEmpty = false }) {
    const world = {
        library: new Set(library),
        status: new Map(Object.entries(status)),
        requests: [],
        refuse: {},
        statusFails,
        statusEmpty,
        statusDelay,
        statusReads: 0,
        statusAnswers: 0,
    };
    const statusOf = filename => ({ status: 'current', updateAvailable: false, ...world.status.get(filename) });

    await protectMaintainerServer(page);
    // Counts how often the card of Reisen is put into the page, which tells a render that made the cards twice from one that made them once.
    await page.addInitScript(() => {
        window.qaCardMounts = 0;
        document.addEventListener('DOMContentLoaded', () => {
            const selector = '.sbHomeCard[data-sb-home-key="assistant-reisen"]';
            new MutationObserver((records) => {
                for (const node of records.flatMap(record => [...record.addedNodes])) {
                    if (node instanceof Element) window.qaCardMounts += node.matches(selector) ? 1 : node.querySelectorAll(selector).length;
                }
            }).observe(document.body, { childList: true, subtree: true });
        }, { once: true });
    });
    await installFixtureChats(page);
    for (const avatar of library) {
        registerFixtureChat(page, { avatar, name: NAMES[avatar] ?? avatar, chat: `qa-${avatar}` });
    }
    await page.route('**/thumbnail?*', route => route.fulfill({ status: 204 }));
    await page.route('**/api/characters/all', async (route) => {
        const real = await fetchJsonOrSkip(route);
        if (!real) return;
        const others = real.filter(entry => ![REISEN, TEWI].includes(entry.avatar));
        return route.fulfill({ json: [...others, ...[...world.library].map(avatar => makeCharacterCard(avatar, NAMES[avatar] ?? avatar))] });
    });
    await page.route('**/api/sillybunny/managed-content/status', async (route) => {
        world.statusReads += 1;
        // The answer describes the files as they are when the read arrives, and the server takes its time to send it.
        const body = { items: world.statusEmpty ? [] : FIXTURE_ITEMS.map(item => ({ ...item, ...statusOf(item.filename) })) };
        await new Promise(resolve => setTimeout(resolve, world.statusDelay));
        world.statusAnswers += 1;
        if (world.statusFails) return route.fulfill({ status: 500, json: { error: 'status_failed' } });
        return route.fulfill({ json: body });
    });
    await page.route(/\/api\/sillybunny\/managed-content\/(?:apply|restore)$/, (route) => {
        const action = new URL(route.request().url()).pathname.split('/').pop();
        const { filename } = route.request().postDataJSON();
        world.requests.push({ action, filename });
        if (world.refuse[action]) return route.fulfill(world.refuse[action]);
        world.status.set(filename, { status: 'current', updateAvailable: false });
        if (action === 'restore' && [REISEN, TEWI].includes(filename)) world.library.add(filename);
        return route.fulfill({ json: { backup: 'managed/backup' } });
    });
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.accountStorage = { ...withoutAssistantAccount(settings.accountStorage), ...MIGRATED, ...accountStorage };
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });

    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(page.locator(HOME)).toBeAttached({ timeout: STARTUP_TIMEOUT });
    await showToasts(page);
    return world;
}

/** More than the first render of Home may wait, so a render that waits for it cannot be missed. */
const SLOW_STATUS = 3000;
/** Well within the time that the first render waits. */
const FAST_STATUS = 100;
/** After the time that the first render waits, so the first answer comes after the cards were made. */
const LATE_STATUS = 700;

/** Marks the card of Reisen in the page, so a test can tell whether Home made the cards again. */
/** Lets the page run for a while, where the test asserts that something does not happen. */
const settle = (page, milliseconds) => page.evaluate(wait => new Promise((resolve) => { setTimeout(resolve, wait); }), milliseconds);
const markCard = page => cardOf(page, 'assistant-reisen').evaluate(card => card.setAttribute('data-qa-made', '1'));
const cardMark = page => page.evaluate(() => document.querySelector('#chat > .welcomePanel .sbHomeCard[data-sb-home-key="assistant-reisen"]')?.getAttribute('data-qa-made') ?? null);

const EDITED = { status: 'modified', updateAvailable: true, version: 2 };
const DELETED = { status: 'deleted', updateAvailable: false };
const REISEN_DELETED_ACCOUNT = { bundledAssistantReisenDeleted: 'true' };

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];


for (const { name, options } of VIEWPORTS) {
    test.describe(`Restore and Update Available at ${name}`, () => {
        test.use(options);

        test.describe('Restore', () => {
            test('is the one control of the footer of a deleted bundled card, which has no menu button', async ({ page }) => {
                await boot(page, { library: [TEWI], status: { [REISEN]: DELETED }, accountStorage: REISEN_DELETED_ACCOUNT });
                const reisen = cardOf(page, 'assistant-reisen');

                await expect(reisen.locator('.sbHomeCardFooter > *')).toHaveCount(1);
                await expect(restoreOf(page)).toBeVisible();
                await expect(restoreOf(page)).toBeEnabled();
                await expect(restoreOf(page)).toHaveAccessibleName('Restore Reisen');
                await expect(restoreOf(page).locator('.sbHomeFootLabel')).toHaveText('Restore');
                await expect(menuOf(reisen)).toHaveCount(0);
                await expect(reisen.locator('.sbHomeCardOpen')).toBeDisabled();
                await expect(cardOf(page, 'assistant-tewi').locator('.sbHomeFootButton')).toHaveCount(2);
            });

            test('puts the bundled card back and renders Home again with the card usable', async ({ page }) => {
                const world = await boot(page, { library: [TEWI], status: { [REISEN]: DELETED }, accountStorage: REISEN_DELETED_ACCOUNT });

                await restoreOf(page).click();

                const reisen = cardOf(page, 'assistant-reisen');
                await expect(reisen.locator('.sbHomeCardOpen')).toBeEnabled();
                await expect(reisen.locator('.sbHomeFootButton')).toHaveCount(2);
                await expect(reisen.locator('.sbHomeFootButton').first()).toBeEnabled();
                await expect(restoreOf(page)).toHaveCount(0);
                expect(world.requests).toEqual([{ action: 'restore', filename: REISEN }]);
                expect(await stored(page, 'bundledAssistantReisenDeleted')).toBeNull();
                await expectNoToast(failureToast(page));
            });

            test('shows no message of its own, because the card coming back is the answer', async ({ page }) => {
                await boot(page, { library: [TEWI], status: { [REISEN]: DELETED }, accountStorage: REISEN_DELETED_ACCOUNT });

                await restoreOf(page).click();
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeEnabled();

                await expectNoToast(page.locator('#toast-container .toast-message').filter({ hasText: /Reisen|backup/ }));
            });

            test('leaves the keyboard on the restored card, at its first chat button, and not on the page', async ({ page }) => {
                await boot(page, { library: [TEWI], status: { [REISEN]: DELETED }, accountStorage: REISEN_DELETED_ACCOUNT });
                await restoreOf(page).focus();

                await page.keyboard.press('Enter');

                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeEnabled();
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeFootButton').first()).toBeFocused();
            });

            test('tells the user with the placeholder toast when the server refuses, and the card stays deleted', async ({ page }) => {
                const world = await boot(page, { library: [TEWI], status: { [REISEN]: DELETED }, accountStorage: REISEN_DELETED_ACCOUNT });
                world.refuse.restore = { status: 500, json: { error: 'write_failed' } };
                const unhandled = [];
                page.on('pageerror', error => unhandled.push(error.message));

                await restoreOf(page).click();

                const toast = failureToast(page);
                await expect(toast).toBeVisible();
                await expect(toast).toHaveAttribute('data-sb-copy-placeholder', 'true');
                await expect(toast).toHaveText(COPY_PLACEHOLDER);
                await expect(restoreOf(page)).toBeEnabled();
                expect(await stored(page, 'bundledAssistantReisenDeleted')).toBe('true');
                expect(unhandled).toEqual([]);
            });

            test('can be tried again after a refusal', async ({ page }) => {
                const world = await boot(page, { library: [TEWI], status: { [REISEN]: DELETED }, accountStorage: REISEN_DELETED_ACCOUNT });
                world.refuse.restore = { status: 500, json: { error: 'write_failed' } };
                await restoreOf(page).click();
                await expect(failureToast(page)).toBeVisible();
                delete world.refuse.restore;

                await restoreOf(page).click();

                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeEnabled();
                expect(world.requests.map(request => request.action)).toEqual(['restore', 'restore']);
            });

            test('is offered for a card whose file went away outside the app, which the account never deleted', async ({ page }) => {
                const world = await boot(page, { library: [TEWI], status: { [REISEN]: DELETED } });
                await expect(restoreOf(page)).toBeVisible();

                await restoreOf(page).click();

                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeEnabled();
                expect(world.requests).toEqual([{ action: 'restore', filename: REISEN }]);
            });

            for (const status of ['current', 'updated', 'modified', 'not-installed']) {
                test(`is not offered for a deleted card whose bundled file the server reports as ${status}`, async ({ page }) => {
                    await boot(page, { library: [TEWI], status: { [REISEN]: { status, updateAvailable: false } }, accountStorage: REISEN_DELETED_ACCOUNT });

                    await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeDisabled();
                    await expect(restoreOf(page)).toHaveCount(0);
                    await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeFootButton')).toHaveCount(2);
                });
            }

            test('is not offered for a card that has its file, even when the server reports the bundled file as deleted', async ({ page }) => {
                await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: DELETED } });

                await expect(restoreOf(page)).toHaveCount(0);
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeEnabled();
            });
        });

        test.describe('Update Available', () => {
            test('is an item after the chat item of an edited card that has a newer bundled version', async ({ page }) => {
                await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });

                await openMenu(page, 'assistant-reisen');

                expect(await menuLabels(page)).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('is not an item of a card that nobody edited, or of a card with no newer version', async ({ page }) => {
                await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: { status: 'modified', updateAvailable: false, version: 1 }, [TEWI]: { status: 'current', updateAvailable: false } } });

                for (const key of ['assistant-reisen', 'assistant-tewi']) {
                    expect(await labelsOfOpenMenu(page, key), key).toEqual(['New Chat in Conversation']);
                }
            });

            test('asks first, with Keep Mine and Update as the answers and the name of the card in the text', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                await openMenu(page, 'assistant-reisen');

                await page.getByRole('menuitem', { name: 'Update Available' }).click();

                const alert = alertOf(page);
                await expect(alert).toBeVisible();
                await expect(alert.getByRole('button')).toHaveText(['Keep Mine', 'Update']);
                await expect(alert.getByRole('heading', { name: 'Update Reisen?' })).toBeVisible();
                await expect(alert.locator('[data-sb-managed-update="body"]')).toHaveText('A newer version of Reisen is available, but you\'ve edited your copy. Would you like to update anyway? Your copy is saved as a backup.');
                await expect(alert.locator('[data-sb-copy-placeholder]')).toHaveCount(0);
                await expect(alert.getByRole('button', { name: 'Keep Mine' })).toBeFocused();
                expect(world.requests).toEqual([]);
            });

            test('Update applies the bundled card, tells the user that a backup was kept, and Home no longer offers an update', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                await openMenu(page, 'assistant-reisen');
                await page.getByRole('menuitem', { name: 'Update Available' }).click();

                await alertOf(page).getByRole('button', { name: 'Update' }).click();

                await expect(hosts(page)).toHaveCount(0);
                expect(world.requests).toEqual([{ action: 'apply', filename: REISEN }]);
                await expect(updatedToast(page)).toHaveText('Updated Reisen. A backup of your version was kept.');
                await expect(updatedToast(page)).not.toHaveAttribute('data-sb-copy-placeholder', 'true');
                await expect.poll(() => labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation']);
                expect(await stored(page, DISMISSED_KEY)).toBeNull();
                await expectNoToast(failureToast(page));
            });

            test('Update shows the card as current at once, before the server answers the status again', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                await openMenu(page, 'assistant-reisen');
                await page.getByRole('menuitem', { name: 'Update Available' }).click();
                world.statusDelay = SLOW_STATUS;

                await alertOf(page).getByRole('button', { name: 'Update' }).click();
                await expect(updatedToast(page)).toBeVisible();

                // The status that was read before the update still says that the file is edited, and a read that would correct it is 3 s away.
                await expect.poll(() => labelsOfOpenMenu(page, 'assistant-reisen'), { timeout: SLOW_STATUS / 2 }).toEqual(['New Chat in Conversation']);
            });

            test('Update of Tewi names Tewi in the message', async ({ page }) => {
                await boot(page, { library: [REISEN, TEWI], status: { [TEWI]: EDITED } });
                await openMenu(page, 'assistant-tewi');
                await page.getByRole('menuitem', { name: 'Update Available' }).click();

                await alertOf(page).getByRole('button', { name: 'Update' }).click();

                await expect(updatedToast(page)).toHaveText('Updated Tewi. A backup of your version was kept.');
            });

            test('Update that went through is not called a failure when showing the result fails', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                const unhandled = [];
                page.on('pageerror', error => unhandled.push(error.message));
                await openMenu(page, 'assistant-reisen');
                await page.getByRole('menuitem', { name: 'Update Available' }).click();
                // Home reads the scroll position of #chat before it renders again, so the render fails after the server did its part.
                await page.evaluate(() => {
                    Object.defineProperty(document.getElementById('chat'), 'scrollTop', { configurable: true, get() { throw new Error('QA render failure'); } });
                });

                await alertOf(page).getByRole('button', { name: 'Update' }).click();

                await expect(updatedToast(page)).toBeVisible();
                await expect(hosts(page)).toHaveCount(0);
                expect(world.requests).toEqual([{ action: 'apply', filename: REISEN }]);
                await settle(page, 300);
                await expectNoToast(failureToast(page));
                expect(unhandled).toEqual([]);
            });

            test('Keep Mine stores the offered version, applies nothing, says nothing and stops the offer', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                await openMenu(page, 'assistant-reisen');
                await page.getByRole('menuitem', { name: 'Update Available' }).click();

                await alertOf(page).getByRole('button', { name: 'Keep Mine' }).click();

                await expect(hosts(page)).toHaveCount(0);
                expect(world.requests).toEqual([]);
                expect(JSON.parse(await stored(page, DISMISSED_KEY))).toEqual({ [REISEN]: 2 });
                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation']);
                await expectNoToast(updatedToast(page));
            });

            test('comes back for a bundled version newer than the one that was kept, and not for the same one', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED }, accountStorage: { [DISMISSED_KEY]: JSON.stringify({ [REISEN]: 2 }) } });
                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation']);

                world.status.set(REISEN, { ...EDITED, version: 3 });
                await renderHome(page);

                await expect.poll(() => labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('keeps only the file that it was kept for', async ({ page }) => {
                await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED, [TEWI]: EDITED }, accountStorage: { [DISMISSED_KEY]: JSON.stringify({ [REISEN]: 2 }) } });

                await openMenu(page, 'assistant-tewi');

                expect(await menuLabels(page)).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('Escape leaves the card as it is and asks again the next time', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                await openMenu(page, 'assistant-reisen');
                await page.getByRole('menuitem', { name: 'Update Available' }).click();
                await expect(alertOf(page)).toBeVisible();

                await page.keyboard.press('Escape');

                await expect(hosts(page)).toHaveCount(0);
                expect(world.requests).toEqual([]);
                expect(await stored(page, DISMISSED_KEY)).toBeNull();
                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('tells the user with the placeholder toast when the update is refused, and the offer stays', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                world.refuse.apply = { status: 500, json: { error: 'backup_failed' } };
                const unhandled = [];
                page.on('pageerror', error => unhandled.push(error.message));
                await openMenu(page, 'assistant-reisen');
                await page.getByRole('menuitem', { name: 'Update Available' }).click();

                await alertOf(page).getByRole('button', { name: 'Update' }).click();

                const toast = failureToast(page);
                await expect(toast).toBeVisible();
                await expect(toast).toHaveAttribute('data-sb-copy-placeholder', 'true');
                await expect(hosts(page)).toHaveCount(0);
                await expectNoToast(updatedToast(page));
                expect(await stored(page, DISMISSED_KEY)).toBeNull();
                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
                expect(unhandled).toEqual([]);
            });

            test('reads the status again when the server says the file is current already, so a stale offer goes', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                world.refuse.apply = { status: 409, json: { error: 'already_current' } };
                await openMenu(page, 'assistant-reisen');
                await page.getByRole('menuitem', { name: 'Update Available' }).click();
                world.status.set(REISEN, { status: 'current', updateAvailable: false });

                await alertOf(page).getByRole('button', { name: 'Update' }).click();

                await expect(failureToast(page)).toBeVisible();
                await expectNoToast(updatedToast(page));
                await expect.poll(() => labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation']);
            });
        });

        test.describe('what stays silent', () => {
            test('is a modified sprite folder or world, and a deleted one, on any card', async ({ page }) => {
                await boot(page, {
                    library: [REISEN, TEWI],
                    status: {
                        [SPRITES]: EDITED,
                        [WORLD]: EDITED,
                        'Assistant Tewi': DELETED,
                    },
                });

                for (const key of ['assistant-reisen', 'assistant-tewi']) {
                    expect(await labelsOfOpenMenu(page, key), key).toEqual(['New Chat in Conversation']);
                }
                await expect(hosts(page)).toHaveCount(0);
                await expectNoToast(failureToast(page));
            });

            test('is every card while the status cannot be read, and Home renders as before', async ({ page }) => {
                await boot(page, { library: [TEWI], status: { [REISEN]: DELETED }, accountStorage: REISEN_DELETED_ACCOUNT, statusFails: true });

                await expect(cardOf(page, 'assistant-tewi').locator('.sbHomeCardOpen')).toBeEnabled();
                await expect(restoreOf(page)).toHaveCount(0);
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeFootButton')).toHaveCount(2);
                await expectNoToast(failureToast(page));
            });

            test('keeps the last status that was read when a later read fails, so the offers stay', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                world.statusFails = true;

                await renderHome(page);

                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
                await expect.poll(() => world.statusAnswers).toBeGreaterThan(1);
                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('is every card when the server has no managed content, which is what the status answers then', async ({ page }) => {
                await boot(page, { library: [REISEN, TEWI] });
                await page.route('**/api/sillybunny/managed-content/status', route => route.fulfill({ json: { items: [] } }));
                await renderHome(page);

                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation']);
            });
        });

        test.describe('the status', () => {
            test('is read for each render of Home, so an edit made elsewhere shows on the next one', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI] });
                const reads = world.statusReads;
                world.status.set(REISEN, EDITED);

                await renderHome(page);

                await expect.poll(() => world.statusReads).toBeGreaterThan(reads);
                await expect.poll(() => labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('is waited for by the first render of Home only briefly, and a slow answer replaces the cards when it arrives', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED }, statusDelay: SLOW_STATUS });

                // Home is on screen while the server is still thinking, so the first render did not wait for all of it.
                expect(world.statusAnswers).toBe(0);
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeEnabled();
                await expect.poll(() => world.statusAnswers).toBe(1);

                await expect.poll(() => labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('makes the cards once when the first answer comes within that time, so they never show without their offers', async ({ page }) => {
                await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED }, statusDelay: FAST_STATUS });
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeEnabled();
                await settle(page, 800);

                expect(await page.evaluate(() => window.qaCardMounts)).toBe(1);
                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            for (const [what, options] of [['is empty', { statusEmpty: true }], ['lists files that all need nothing', {}]]) {
                test(`does not make the cards again when the first answer comes late and ${what}`, async ({ page }) => {
                    await boot(page, { library: [REISEN, TEWI], statusDelay: LATE_STATUS, ...options });
                    await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeEnabled();

                    await settle(page, LATE_STATUS + 600);

                    // The first answer came after the first render, but it changes nothing that a card shows, so a press or a menu click is not lost to a new card.
                    expect(await page.evaluate(() => window.qaCardMounts)).toBe(1);
                });
            }

            test('does not make the cards again when only a file that Home never acts on changes', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI] });
                world.statusDelay = LATE_STATUS;
                world.status.set(SPRITES, EDITED);
                world.status.set(WORLD, EDITED);
                await renderHome(page);
                const mounts = await page.evaluate(() => window.qaCardMounts);

                await expect.poll(() => world.statusAnswers).toBeGreaterThan(1);
                await settle(page, 600);

                expect(await page.evaluate(() => window.qaCardMounts)).toBe(mounts);
            });

            test('never holds up a later render of Home, whatever the server takes', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI] });
                const timeRender = async () => {
                    const started = Date.now();
                    await renderHome(page);
                    return Date.now() - started;
                };
                const quick = Math.min(await timeRender(), await timeRender());
                world.statusDelay = SLOW_STATUS;

                const slow = await timeRender();

                // A render that waited at all, even for the short time of the first one, would take longer by that time.
                expect(slow - quick, `a render took ${slow} ms with a slow status and ${quick} ms with a fast one`).toBeLessThan(150);
                expect(slow, 'the render waited for the status').toBeLessThan(SLOW_STATUS / 2);
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeEnabled();
            });

            test('shows the last known offers at once on a later render, and not the empty cards of a first one', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                world.statusDelay = SLOW_STATUS;

                await renderHome(page);

                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('replaces the cards of a later render when the answer differs, and not when it is the same', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI] });
                world.statusDelay = 600;
                await renderHome(page);
                await markCard(page);
                await expect.poll(() => world.statusAnswers).toBeGreaterThan(1);
                await settle(page, 800);
                expect(await cardMark(page), 'the cards were made again for the same status').toBe('1');

                world.status.set(REISEN, EDITED);
                await renderHome(page);
                await markCard(page);

                await expect.poll(() => cardMark(page), 'the cards were not made again for a new status').toBeNull();
                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('does not replace the cards while a menu is open, and does once it is closed', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI] });
                world.statusDelay = 800;
                world.status.set(REISEN, EDITED);
                await renderHome(page);
                const answers = world.statusAnswers;
                await markCard(page);
                await openMenu(page, 'assistant-tewi');

                await expect.poll(() => world.statusAnswers).toBeGreaterThan(answers);
                await settle(page, 700);

                await expect(page.getByRole('menu')).toBeVisible();
                expect(await cardMark(page), 'the cards were made again under an open menu').toBe('1');
                await page.keyboard.press('Escape');
                await expect.poll(() => cardMark(page)).toBeNull();
                expect(await labelsOfOpenMenu(page, 'assistant-reisen')).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('does not replace the cards while the update alert is open, and does once it is closed', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI], status: { [REISEN]: EDITED } });
                await openMenu(page, 'assistant-reisen');
                await page.getByRole('menuitem', { name: 'Update Available' }).click();
                await expect(alertOf(page)).toBeVisible();
                world.statusDelay = 300;
                world.status.set(TEWI, EDITED);
                const answers = world.statusAnswers;
                await renderHome(page);
                await markCard(page);

                await expect.poll(() => world.statusAnswers).toBeGreaterThan(answers);
                await settle(page, 700);

                await expect(alertOf(page)).toBeVisible();
                expect(await cardMark(page), 'the cards were made again under the alert').toBe('1');
                await page.keyboard.press('Escape');
                await expect(hosts(page)).toHaveCount(0);
                await expect.poll(() => labelsOfOpenMenu(page, 'assistant-tewi')).toEqual(['New Chat in Conversation', 'Update Available']);
            });

            test('keeps the focus on the control of a card that is made again', async ({ page }) => {
                const world = await boot(page, { library: [REISEN, TEWI] });
                world.statusDelay = 800;
                world.status.set(REISEN, EDITED);
                await renderHome(page);
                await markCard(page);
                await cardOf(page, 'assistant-tewi').locator('.sbHomeFootButton').first().focus();

                await expect.poll(() => cardMark(page)).toBeNull();

                await expect(cardOf(page, 'assistant-tewi').locator('.sbHomeFootButton').first()).toBeFocused();
            });
        });
    });
}
