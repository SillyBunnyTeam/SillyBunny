import { expect, test } from '@playwright/test';
import { dismissOpenDialogIfPresent, openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { PINNED_ASSISTANT_ACCOUNT, REISEN_AVATAR, stubAssistantCards, TEWI_AVATAR } from './helpers/assistant-library.js';
import { installFixtureChats, pickFixtureCharacters } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' }, viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/**
 * Records what each ResizeObserver and MutationObserver watches, and what `document.fonts` listens to, so that a test
 * can ask whether anything still follows an element after it left the document. It runs before the app does, and it
 * wraps the constructors, so it counts the observers of every browser in the same way.
 */
function trackObservers() {
    const records = [];
    for (const kind of ['ResizeObserver', 'MutationObserver']) {
        const Native = window[kind];
        window[kind] = class extends Native {
            #targets = new Set();

            constructor(callback) {
                super(callback);
                records.push({ kind, targets: this.#targets });
            }

            observe(target, options) {
                this.#targets.add(target);
                return super.observe(target, options);
            }

            unobserve(target) {
                this.#targets.delete(target);
                return super.unobserve(target);
            }

            disconnect() {
                this.#targets.clear();
                return super.disconnect();
            }
        };
    }

    const fontListeners = new Map();
    let sequence = 0;
    const { fonts } = document;
    const add = fonts.addEventListener.bind(fonts);
    const remove = fonts.removeEventListener.bind(fonts);
    fonts.addEventListener = (type, listener, options) => {
        if (type === 'loadingdone') fontListeners.set(listener, ++sequence);
        return add(type, listener, options);
    };
    fonts.removeEventListener = (type, listener, options) => {
        if (type === 'loadingdone') fontListeners.delete(listener);
        return remove(type, listener, options);
    };

    window.qaObservers = {
        /** How many of `elements` an observer of the kind still watches, counting each observer that watches one. */
        watching(kind, elements) {
            let count = 0;
            for (const record of records) {
                if (record.kind !== kind) continue;
                for (const target of record.targets) {
                    if (elements.includes(target)) count++;
                }
            }
            return count;
        },
        /** A point in the order of added `loadingdone` listeners, for `liveFontListenersSince`. */
        fontMark: () => sequence,
        /** How many `loadingdone` listeners added after the mark are still on `document.fonts`. */
        liveFontListenersSince: mark => [...fontListeners.values()].filter(added => added > mark).length,
    };
}

const homePanel = page => page.locator('#chat > .welcomePanel');

async function expectHome(page) {
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(homePanel(page)).toBeAttached({ timeout: STARTUP_TIMEOUT });
}

async function renderHome(page, items) {
    await page.route('**/api/chats/recent', route => route.fulfill({ json: items }));
    await page.evaluate(async () => {
        const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
        await openWelcomeScreen({ force: true });
    });
    await expectHome(page);
}

function recentChatEntries(characters) {
    return characters.map((character, index) => ({
        file_name: `${character.chat}.jsonl`,
        avatar: character.avatar,
        last_mes: Date.now() - index * 60_000,
        mes: `Preview ${index}`,
        chat_items: 3,
        file_size: '1kb',
    }));
}

/** Keeps the panel that is shown now, so a test can look at it after the page has dropped it. */
function holdPanel(page) {
    return page.evaluate(() => {
        window.qaPanel = document.querySelector('#chat > .welcomePanel');
    });
}

/**
 * What still follows the held panel: the elements that the footer and header fits observe, which are the cards with a
 * footer, the header, the title and the version.
 */
function readHeldPanel(page) {
    return page.evaluate(() => {
        const panel = window.qaPanel;
        const header = panel.querySelector('.sbHomeHeader');
        const fitted = [...panel.querySelectorAll('.sbHomeCard, .sbHomeHeader, .sbHomeTitle, .sbHomeVersion')];
        return {
            connected: panel.isConnected,
            resize: window.qaObservers.watching('ResizeObserver', fitted),
            headerMutation: window.qaObservers.watching('MutationObserver', [header]),
        };
    });
}

/** Marks where the font listeners of the Home that the test renders next begin, so that other listeners are not counted. */
function markFontListeners(page) {
    return page.evaluate(() => {
        window.qaFontMark = window.qaObservers.fontMark();
    });
}

const readFontListeners = page => page.evaluate(() => window.qaObservers.liveFontListenersSince(window.qaFontMark));

async function openConversationOverHome(page) {
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const character = context.characters.find(entry => entry?.avatar);
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        if (!openConversationWorkspaceForAvatar(character.avatar, { showToast: false, enable: true })) {
            throw new Error('Could not open the Conversation workspace.');
        }
    });
    await expect(page.locator('#sheld[data-sb-conversation-mode="on"]')).toBeAttached({ timeout: STARTUP_TIMEOUT });
}

const countCompactCards = page => page.evaluate(() => document.querySelectorAll('#chat > .welcomePanel .sbHomeCard[data-sb-footer-compact]').length);
const countFooterCards = page => page.evaluate(() => document.querySelectorAll('#chat > .welcomePanel .sbHomeCard:not(.sbHomeCard--choose)').length);

/** Lengthens the version until it just touches the menu button, which is the shortest version that has to move below the title. */
async function lengthenVersionToTouchButton(page) {
    await page.evaluate(() => {
        const version = document.querySelector('#chat > .welcomePanel [data-sb-home-version]');
        const button = document.querySelector('#chat > .welcomePanel .sbHomeMenuButton');
        // Below the title the version has no width, so only its place beside the title says when it touches.
        document.querySelector('#chat > .welcomePanel .sbHomeHeader').removeAttribute('data-sb-version-below');
        version.textContent = 'v2';
        while (version.getBoundingClientRect().right + 8 <= button.getBoundingClientRect().left && version.textContent.length < 600) {
            version.textContent += 'x';
        }
    });
}

const isVersionBelow = page => page.evaluate(() => document.querySelector('#chat > .welcomePanel .sbHomeHeader').hasAttribute('data-sb-version-below'));

test.describe('Home observers', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(trackObservers);
        await protectMaintainerServer(page);
        await installFixtureChats(page, { accountStorage: PINNED_ASSISTANT_ACCOUNT });
        // The footers belong to the assistant cards, so the library holds Reisen and Tewi whatever the data root holds.
        await stubAssistantCards(page, [REISEN_AVATAR, TEWI_AVATAR]);
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await expectHome(page);
    });

    test('opening a chat from Home leaves nothing observing the old panel, and gives back its font listeners', async ({ page }) => {
        const characters = await pickFixtureCharacters(page, 1);
        await markFontListeners(page);
        await renderHome(page, recentChatEntries(characters));
        await holdPanel(page);
        const shown = await readHeldPanel(page);
        // Each card with a footer, the header, the title and the version are observed while the panel is shown.
        expect(shown.resize).toBeGreaterThanOrEqual(5);
        expect(shown.headerMutation).toBeGreaterThanOrEqual(1);
        expect(await readFontListeners(page), 'the fits of the panel listen for fonts').toBeGreaterThan(0);

        await page.locator('.welcomePanel .recentChat button.recentChatOpen').first().click();
        await dismissOpenDialogIfPresent(page);
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/, { timeout: STARTUP_TIMEOUT });
        await expect(homePanel(page)).toHaveCount(0);

        await expect.poll(() => readHeldPanel(page), { timeout: 5000 }).toEqual({ connected: false, resize: 0, headerMutation: 0 });
        await expect.poll(() => readFontListeners(page), { timeout: 5000 }).toBe(0);
    });

    test('a render in place stops what followed the panel it replaces, and the new panel is followed', async ({ page }) => {
        const characters = await pickFixtureCharacters(page, 1);
        await markFontListeners(page);
        await renderHome(page, recentChatEntries(characters));
        await holdPanel(page);
        const shownFontListeners = await readFontListeners(page);
        expect(shownFontListeners).toBeGreaterThan(0);

        await renderHome(page, recentChatEntries(characters));
        await expect.poll(() => page.evaluate(() => window.qaPanel !== document.querySelector('#chat > .welcomePanel'))).toBe(true);

        await expect.poll(() => readHeldPanel(page), { timeout: 5000 }).toMatchObject({ connected: false, resize: 0, headerMutation: 0 });
        const nextResize = await page.evaluate(() => window.qaObservers.watching('ResizeObserver', [...document.querySelectorAll('#chat > .welcomePanel :is(.sbHomeCard, .sbHomeHeader, .sbHomeTitle, .sbHomeVersion)')]));
        expect(nextResize).toBeGreaterThanOrEqual(5);
        await expect.poll(() => readFontListeners(page), { message: 'the new panel listens in place of the old one' }).toBe(shownFontListeners);
    });

    test('Conversation over Home keeps the panel followed, and the labels and the version still follow a resize after it closes', async ({ page }) => {
        await expect.poll(() => countFooterCards(page)).toBeGreaterThan(0);
        await expect.poll(() => countCompactCards(page), { message: 'at 1440 both labels fit' }).toBe(0);
        await holdPanel(page);
        const shown = await readHeldPanel(page);
        expect(shown.resize).toBeGreaterThanOrEqual(5);

        await openConversationOverHome(page);
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/);
        await waitForAnimationFrames(page, 3);
        expect(await readHeldPanel(page), 'the Home state is off, the panel is still in the chat').toEqual(shown);

        await page.evaluate(() => window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace')));
        await expectHome(page);
        expect(await page.evaluate(() => window.qaPanel === document.querySelector('#chat > .welcomePanel')), 'Home came back as the same panel').toBe(true);
        expect(await readHeldPanel(page)).toEqual(shown);

        await page.setViewportSize(PHONE);
        const cards = await countFooterCards(page);
        await expect.poll(() => countCompactCards(page), { message: 'the labels hide when the cards narrow' }).toBe(cards);

        await lengthenVersionToTouchButton(page);
        await expect.poll(() => isVersionBelow(page), { message: 'the version moves below the title when it touches the button' }).toBe(true);

        await page.setViewportSize(DESKTOP);
        await expect.poll(() => countCompactCards(page), { message: 'the labels come back when the cards widen' }).toBe(0);
        await expect.poll(() => isVersionBelow(page), { message: 'the version comes back beside the title when the header widens' }).toBe(false);
    });

    test('a chat that opens under Conversation, which leaves the Home state off, still stops what followed the panel', async ({ page }) => {
        await holdPanel(page);
        await openConversationOverHome(page);
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/);
        expect((await readHeldPanel(page)).resize).toBeGreaterThanOrEqual(5);

        await page.evaluate(async () => {
            const { clearChat } = await import('/script.js');
            await clearChat();
        });
        await expect(homePanel(page)).toHaveCount(0);

        await expect.poll(() => readHeldPanel(page), { timeout: 5000 }).toMatchObject({ connected: false, resize: 0, headerMutation: 0 });
    });
});
