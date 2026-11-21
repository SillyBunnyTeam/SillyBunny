import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { makeCharacterCard, withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats, registerFixtureChat } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { sizeFreeTestFor } from './helpers/matrix.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

const REISEN = 'default_AssistantReisen.png';
const TEWI = 'default_AssistantTewi.png';
const NAMES = { [REISEN]: 'Assistant Reisen', [TEWI]: 'Assistant Tewi', 'Alice.png': 'Alice' };
const BOTH = [REISEN, TEWI];
const LIBRARY = [...BOTH, 'Alice.png'];
const MIGRATED = { WelcomePage_AssistantPointerMigrated: 'true', WelcomePage_LastMode: 'roleplay' };
const SUBTITLES = {
    reisen: 'Did you need help with setup or troubleshooting? Leave it to me!',
    pointer: 'Chosen from your character library.',
};
const LABEL = 'Connect a Model';
const ATTRIBUTE = 'data-sb-connection';

const HOME = '#chat > .welcomePanel';
const cardOf = (page, key) => page.locator(`${HOME} .sbHomeCard[data-sb-home-key="${key}"]`);
const overlayOf = card => card.locator('.sbHomeCardOpen');
const linkOf = card => card.locator('.sbHomeCardConnect');
const allLinks = page => page.locator(`${HOME} .sbHomeCardConnect`);
const connectionOf = page => page.locator('html');

/**
 * Records what the page shows, from before the first script runs: every distinct combination of the connection
 * attribute, the number of assistant cards and the number of Connect a Model buttons that are painted. It samples on each
 * frame and on each mutation of the DOM, so a button that shows for one frame, or between two frames, is in the record.
 */
function installRecorder() {
    window.__frames = [];
    let last = '';
    const read = (source) => {
        const buttons = [...document.querySelectorAll('.sbHomeCardConnect')];
        const entry = {
            state: document.documentElement?.getAttribute('data-sb-connection') ?? null,
            cards: document.querySelectorAll('.sbHomeCards .sbHomeCard').length,
            buttons: buttons.length,
            shown: buttons.filter(button => getComputedStyle(button).display !== 'none' && button.getClientRects().length > 0).length,
        };
        const key = JSON.stringify(entry);
        if (key !== last) {
            last = key;
            window.__frames.push({ ...entry, source });
        }
    };
    const frame = () => {
        read('frame');
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new MutationObserver(() => read('mutation')).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-sb-connection', 'class', 'hidden'] });
}

const framesOf = page => page.evaluate(() => window.__frames);

/**
 * Starts the app on Home with a library that the test names, in memory. Every write is answered without reaching the server.
 * @param {import('@playwright/test').Page} page
 * @param {object} options
 * @param {string[]} options.library
 * @param {Record<string, string>} [options.accountStorage]
 * @param {'none' | 'held'} [options.connection] `none`: no key is saved, so no check starts, and the status route fails if
 *   anything asks it. `held`: a key is saved, so the boot starts a check, and the status route holds each request until
 *   `world.answerStatus()` answers.
 */
async function boot(page, { library, accountStorage = {}, connection = 'none' }) {
    const world = { chatSaves: [], lastChats: [], statusRequests: 0, held: [] };
    const bundled = [REISEN, TEWI];

    page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() !== 'POST') return;
        if (pathname === '/api/chats/save') world.chatSaves.push(request.url());
        if (pathname === '/api/characters/last-chat') world.lastChats.push(request.postDataJSON());
    });

    await page.addInitScript(installRecorder);
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    for (const avatar of library) {
        registerFixtureChat(page, { avatar, name: NAMES[avatar] ?? avatar, chat: `qa-${avatar}` });
    }
    await page.route('**/thumbnail?*', route => route.fulfill({ status: 404, body: '' }));
    await page.route('**/api/characters/all', async (route) => {
        const real = await fetchJsonOrSkip(route);
        if (!real) return;
        return route.fulfill({ json: [...real.filter(entry => !bundled.includes(entry.avatar)), ...library.map(avatar => makeCharacterCard(avatar, NAMES[avatar] ?? avatar))] });
    });
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.accountStorage = { ...withoutAssistantAccount(settings.accountStorage), ...MIGRATED, ...accountStorage };
        if (connection === 'held') {
            settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'deepseek' };
        }
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/secrets/read', async (route) => {
        const secrets = await fetchJsonOrSkip(route);
        if (!secrets) return;
        return route.fulfill({ json: connection === 'held' ? { api_key_deepseek: true } : {} });
    });
    await page.route('**/api/backends/chat-completions/status', async (route) => {
        world.statusRequests += 1;
        if (connection !== 'held') {
            return route.fulfill({ json: { error: true } });
        }
        await new Promise(resolve => world.held.push(resolve));
        return route.fulfill({ json: world.answer ?? { error: true } });
    });
    /** Answers every held status request: `ok` is a model list, `fail` is the provider's error. */
    world.answerStatus = (kind) => {
        world.answer = kind === 'ok' ? { data: [{ id: 'stub-model' }] } : { error: true };
        world.held.splice(0).forEach(release => release());
    };

    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(page.locator(HOME)).toBeAttached({ timeout: STARTUP_TIMEOUT });
    await expect(page.locator(`${HOME} .sbHomeCards > .sbHomeCard`)).toHaveCount(3, { timeout: STARTUP_TIMEOUT });
    // The cards are first drawn before the library has loaded, and drawn again once it has.
    for (const [key, avatar] of [['assistant-reisen', REISEN], ['assistant-tewi', TEWI]]) {
        if (library.includes(avatar)) {
            await expect(overlayOf(cardOf(page, key))).toBeEnabled({ timeout: STARTUP_TIMEOUT });
        }
    }
    return world;
}

const currentChat = page => page.evaluate(async () => (await import('/script.js')).getCurrentChatId());
const currentAvatar = page => page.evaluate(async () => {
    const script = await import('/script.js');
    return script.characters[script.this_chid]?.avatar ?? null;
});
const setStatus = (page, status) => page.evaluate(async value => (await import('/script.js')).setOnlineStatus(value), status);
const chooseMode = async (page, label) => {
    await page.locator(`${HOME} .sbHomeMenuButton`).click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    await expect(page.locator(HOME)).toHaveAttribute('data-home-panel-mode', label.toLowerCase());
};
const clickAt = async (page, locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

for (const { name, options } of VIEWPORTS) {
    test.describe(`Connect a Model on the assistant cards at ${name}`, () => {
        test.use(options);
        const sizeFreeTest = sizeFreeTestFor(test, options.viewport);
        const MIN_TARGET = options.hasTouch ? 44 : 24;

        test.describe('offline', () => {
            test('every card that can open a chat has the button, and the Choose Assistant card has none', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {} });

                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'offline');
                for (const key of ['assistant-reisen', 'assistant-tewi']) {
                    await expect(linkOf(cardOf(page, key)), key).toBeVisible();
                    await expect(linkOf(cardOf(page, key)), key).toHaveText(LABEL);
                }
                await expect(cardOf(page, 'assistant-own')).toHaveAttribute('data-sb-assistant-kind', 'choose');
                await expect(linkOf(cardOf(page, 'assistant-own'))).toHaveCount(0);
                await expect(allLinks(page)).toHaveCount(2);
            });

            test('the card of the chosen character has it too, and every one is a button of its own', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: { assistant: 'Alice.png' } });

                await expect(cardOf(page, 'assistant-own')).toHaveAttribute('data-sb-assistant-kind', 'pointer');
                await expect(allLinks(page)).toHaveCount(3);
                for (const link of await allLinks(page).all()) {
                    await expect(link).toBeVisible();
                    await expect(link).toHaveJSProperty('tagName', 'BUTTON');
                    await expect(link).toHaveAttribute('type', 'button');
                }
            });

            test('sits below the subtitle, which keeps its words, and stays out of what the card button is described by', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: { assistant: 'Alice.png' } });
                const reisen = cardOf(page, 'assistant-reisen');

                await expect(reisen.locator('.sbHomeCardSub')).toHaveText(SUBTITLES.reisen);
                await expect(cardOf(page, 'assistant-own').locator('.sbHomeCardSub')).toHaveText(SUBTITLES.pointer);
                await expect(overlayOf(reisen)).toHaveAccessibleDescription(SUBTITLES.reisen);
                await expect(reisen.locator('.sbHomeCardSub').locator('.sbHomeCardConnect')).toHaveCount(0);
                const order = await reisen.evaluate((card) => {
                    const sub = card.querySelector('.sbHomeCardSub').getBoundingClientRect();
                    const link = card.querySelector('.sbHomeCardConnect').getBoundingClientRect();
                    const nodes = [...card.querySelectorAll('.sbHomeCardOpen, .sbHomeCardSub, .sbHomeCardConnect, .sbHomeFootButton')];
                    return { belowSub: link.top >= sub.bottom - 1, classes: nodes.map(node => node.className.split(' ')[0]) };
                });
                expect(order.belowSub).toBe(true);
                expect(order.classes).toEqual(['sbHomeCardOpen', 'sbHomeCardSub', 'sbHomeCardConnect', 'sbHomeFootButton', 'sbHomeFootButton']);
            });

            test('is as tall as a target of the pointer: 44 px on a touch screen, 24 px otherwise', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: { assistant: 'Alice.png' } });

                for (const link of await allLinks(page).all()) {
                    await link.scrollIntoViewIfNeeded();
                    expect((await link.boundingBox()).height).toBeGreaterThanOrEqual(MIN_TARGET);
                }
            });

            test('comes after the card button in the tab order, and before the footer buttons', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {} });
                const reisen = cardOf(page, 'assistant-reisen');

                await overlayOf(reisen).focus();
                await page.keyboard.press('Tab');
                await expect(linkOf(reisen)).toBeFocused();
                await page.keyboard.press('Tab');
                await expect(reisen.locator('.sbHomeFootButton').first()).toBeFocused();
            });

            test('is above the card button: pressing it opens Backend, Connections and starts no chat', async ({ page }) => {
                const world = await boot(page, { library: LIBRARY, accountStorage: {} });

                await linkOf(cardOf(page, 'assistant-reisen')).click();

                await expect(page.getByRole('tab', { name: 'Connections', selected: true })).toBeVisible();
                expect(await currentChat(page)).toBeUndefined();
                expect(await currentAvatar(page)).toBeNull();
                expect(world.chatSaves).toEqual([]);
                expect(world.lastChats).toEqual([]);
                await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
            });

            test('opens Connections from the keyboard as well, and starts no chat', async ({ page }) => {
                const world = await boot(page, { library: LIBRARY, accountStorage: { assistant: 'Alice.png' } });
                const own = cardOf(page, 'assistant-own');

                await linkOf(own).focus();
                await page.keyboard.press('Enter');

                await expect(page.getByRole('tab', { name: 'Connections', selected: true })).toBeVisible();
                expect(await currentAvatar(page)).toBeNull();
                expect(world.chatSaves).toEqual([]);
            });

            test('leaves the rest of the card to the card button: pressing the name still starts a chat', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {} });

                await clickAt(page, cardOf(page, 'assistant-reisen').locator('.sbHomeCardName'));

                await expect.poll(() => currentAvatar(page)).toBe(REISEN);
                await expect.poll(() => currentChat(page)).toMatch(/^Assistant Reisen - /);
            });

            test('leaves the card button working in the pointer card too', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: { assistant: 'Alice.png' } });

                await clickAt(page, cardOf(page, 'assistant-own').locator('.sbHomeCardName'));

                await expect.poll(() => currentAvatar(page)).toBe('Alice.png');
            });

            test('shows in Compact mode too, below the subtitle, and opens Connections there', async ({ page }) => {
                const world = await boot(page, { library: LIBRARY, accountStorage: { assistant: 'Alice.png' } });
                await chooseMode(page, 'Compact');

                await expect(allLinks(page)).toHaveCount(3);
                for (const link of await allLinks(page).all()) {
                    await expect(link).toBeVisible();
                }
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardSub')).toHaveText(SUBTITLES.reisen);
                await linkOf(cardOf(page, 'assistant-tewi')).click();
                await expect(page.getByRole('tab', { name: 'Connections', selected: true })).toBeVisible();
                expect(await currentAvatar(page)).toBeNull();
                expect(world.chatSaves).toEqual([]);
            });

            test('keeps every card of a line the same height, with or without the button on it', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {} });
                const heights = () => page.locator(`${HOME} .sbHomeCards > .sbHomeCard`).evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().height)));
                await expect(allLinks(page)).toHaveCount(2);
                const offline = await heights();

                await setStatus(page, 'Valid');
                await expect(allLinks(page).first()).toBeHidden();
                const online = await heights();

                expect(Math.max(...offline) - Math.min(...offline)).toBeLessThanOrEqual(1);
                expect(Math.max(...online) - Math.min(...online)).toBeLessThanOrEqual(1);
            });
        });

        test.describe('a card with no file', () => {
            sizeFreeTest('has no button: Restore is its action, and it has no chat to open', async ({ page }) => {
                await boot(page, { library: [REISEN], accountStorage: {} });

                await expect(overlayOf(cardOf(page, 'assistant-tewi'))).toBeDisabled();
                await expect(linkOf(cardOf(page, 'assistant-tewi'))).toHaveCount(0);
                await expect(linkOf(cardOf(page, 'assistant-reisen'))).toBeVisible();
            });
        });

        test.describe('the connection changes while Home is open', () => {
            sizeFreeTest('going online hides every button, and going offline again shows them', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: { assistant: 'Alice.png' } });
                await expect(allLinks(page).first()).toBeVisible();

                await setStatus(page, 'Valid');
                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'online');
                for (const link of await allLinks(page).all()) {
                    await expect(link).toBeHidden();
                }

                await setStatus(page, 'no_connection');
                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'offline');
                for (const link of await allLinks(page).all()) {
                    await expect(link).toBeVisible();
                }
            });

            sizeFreeTest('a hidden button is out of the tab order and the accessibility tree', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {} });
                await expect(allLinks(page)).toHaveCount(2);
                await setStatus(page, 'Valid');
                const reisen = cardOf(page, 'assistant-reisen');
                await expect(linkOf(reisen)).toBeHidden();

                await expect(reisen.getByRole('button', { name: LABEL })).toHaveCount(0);
                await overlayOf(reisen).focus();
                await page.keyboard.press('Tab');
                await expect(reisen.locator('.sbHomeFootButton').first()).toBeFocused();
            });

            sizeFreeTest('a status that lets the user send, such as a saved key, shows no button', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {} });

                for (const status of ['Key saved; press "Test Message" to verify.', 'Status check bypassed', 'Valid']) {
                    await setStatus(page, status);
                    await expect(connectionOf(page), status).toHaveAttribute(ATTRIBUTE, 'online');
                    await expect(allLinks(page).first(), status).toBeHidden();
                }
            });

            sizeFreeTest('a check that starts shows no button until it ends, and a failed one shows it', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {} });
                await expect(allLinks(page).first()).toBeVisible();

                await page.evaluate(async () => (await import('/script.js')).startStatusLoading());
                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'connecting');
                await expect(allLinks(page).first()).toBeHidden();
                await page.evaluate(async () => (await import('/script.js')).resultCheckStatus());

                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'offline');
                await expect(allLinks(page).first()).toBeVisible();
            });

            sizeFreeTest('a Horde check, which starts no spinner, still reads as connecting until it ends', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {} });
                let release;
                const held = new Promise((resolve) => { release = resolve; });
                await page.route('**/api/horde/status', async (route) => {
                    await held;
                    return route.fulfill({ json: { ok: true } });
                });
                await page.route(/\/api\/horde\/(?!status)/, route => route.fulfill({ json: [] }));
                await expect(allLinks(page).first()).toBeVisible();

                await page.evaluate(async () => (await import('/script.js')).changeMainAPI('koboldhorde'));

                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'connecting');
                await expect(allLinks(page).first()).toBeHidden();
                release();
                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'online');
                await expect(allLinks(page).first()).toBeHidden();
            });

            sizeFreeTest('Cancel on a pending check ends it, so the button comes back', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {} });
                await page.evaluate(async () => (await import('/script.js')).startStatusLoading());
                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'connecting');

                await page.evaluate(() => document.querySelector('.api_loading').click());

                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'offline');
                await expect(allLinks(page).first()).toBeVisible();
            });

            sizeFreeTest('is a state of the page, not of the render: a change leaves the cards as they are, and a Home that renders again shows the current state', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {} });
                const reisen = await cardOf(page, 'assistant-reisen').elementHandle();
                const renderHome = () => page.evaluate(async () => (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true }));

                await setStatus(page, 'Valid');
                await expect(allLinks(page).first()).toBeHidden();
                expect(await reisen.evaluate(card => card.isConnected), 'the card was not rendered again').toBe(true);

                await renderHome();
                await expect(cardOf(page, 'assistant-reisen')).toBeAttached();
                await expect(allLinks(page).first()).toBeHidden();

                await setStatus(page, 'no_connection');
                await renderHome();
                await expect(allLinks(page).first()).toBeVisible();
                await expect(allLinks(page)).toHaveCount(2);
            });
        });

        test.describe('at boot', () => {
            sizeFreeTest('a user with no key sees the button from the first frame that has one, and it never goes', async ({ page }) => {
                await boot(page, { library: LIBRARY, accountStorage: {}, connection: 'none' });
                await expect(allLinks(page).first()).toBeVisible();

                const frames = await framesOf(page);
                const firstWithButtons = frames.find(frame => frame.buttons > 0);
                expect(firstWithButtons, JSON.stringify(frames)).toMatchObject({ state: 'offline', buttons: 2, shown: 2 });
                expect(frames.filter(frame => frame.buttons > 0 && frame.shown === 0), JSON.stringify(frames)).toEqual([]);
            });

            sizeFreeTest('a check that is in flight when Home renders never shows the button, in any frame', async ({ page }) => {
                const world = await boot(page, { library: LIBRARY, accountStorage: {}, connection: 'held' });

                await expect.poll(() => world.statusRequests).toBeGreaterThan(0);
                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'connecting');
                await expect(allLinks(page)).toHaveCount(2);
                for (const link of await allLinks(page).all()) {
                    await expect(link).toBeHidden();
                }
                // Let several frames pass with Home on screen and the check still open.
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

                const held = await framesOf(page);
                expect(held.some(frame => frame.cards > 0 && frame.state === 'connecting' && frame.buttons === 2 && frame.shown === 0), JSON.stringify(held)).toBe(true);
                expect(held.filter(frame => frame.shown > 0), JSON.stringify(held)).toEqual([]);
            });

            sizeFreeTest('shows the button once that check has failed, and never before', async ({ page }) => {
                const world = await boot(page, { library: LIBRARY, accountStorage: {}, connection: 'held' });
                await expect.poll(() => world.statusRequests).toBeGreaterThan(0);
                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'connecting');

                world.answerStatus('fail');

                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'offline');
                await expect(allLinks(page)).toHaveCount(2);
                for (const link of await allLinks(page).all()) {
                    await expect(link).toBeVisible();
                }
                const frames = await framesOf(page);
                const firstShown = frames.findIndex(frame => frame.shown > 0);
                expect(firstShown, JSON.stringify(frames)).toBeGreaterThan(-1);
                expect(frames.slice(0, firstShown).every(frame => frame.shown === 0), JSON.stringify(frames)).toBe(true);
                expect(frames.slice(firstShown).every(frame => frame.state === 'offline' || frame.shown === 0), JSON.stringify(frames)).toBe(true);
                expect(frames.filter(frame => frame.shown > 0 && frame.state !== 'offline'), JSON.stringify(frames)).toEqual([]);
            });

            sizeFreeTest('a check that a change of the main API supersedes does not leave the state at connecting', async ({ page }) => {
                const world = await boot(page, { library: LIBRARY, accountStorage: {}, connection: 'held' });
                await expect.poll(() => world.statusRequests).toBeGreaterThan(0);
                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'connecting');

                await page.evaluate(() => $('#main_api').val('textgenerationwebui').trigger('change'));
                world.answerStatus('ok');

                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'offline');
                await expect(allLinks(page).first()).toBeVisible();
                // The superseded check answered after the change, and its answer must not read as a connection.
                expect(await page.evaluate(async () => (await import('/script.js')).online_status)).toBe('no_connection');
            });

            sizeFreeTest('never shows the button when that check connects', async ({ page }) => {
                const world = await boot(page, { library: LIBRARY, accountStorage: {}, connection: 'held' });
                await expect.poll(() => world.statusRequests).toBeGreaterThan(0);

                world.answerStatus('ok');

                await expect(connectionOf(page)).toHaveAttribute(ATTRIBUTE, 'online');
                await expect(allLinks(page).first()).toBeHidden();
                const frames = await framesOf(page);
                expect(frames.some(frame => frame.cards > 0 && frame.state === 'online'), JSON.stringify(frames)).toBe(true);
                expect(frames.filter(frame => frame.shown > 0), JSON.stringify(frames)).toEqual([]);
            });
        });
    });
}
