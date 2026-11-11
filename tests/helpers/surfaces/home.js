/**
 * The home family: Home and the windows that open from it (Welcome, Getting Started, Help, About, Troubleshooting,
 * Bundled Extras, Keyboard Shortcuts, the assistant picker), and the two pages that are not part of the booted app: the
 * splash screen and the login page.
 *
 * The windows open the way a user opens them: from the main menu button of Home or from a Home tile or card. Each window
 * is one `openDialog` host, and a second `openDialog` call while one is open pushes a page of it instead of opening another
 * window. So every `open` first closes whatever an earlier state left behind (`closeOverlays`), and it puts the pieces of
 * Home that a state changes (the assistant pointer, the Getting Started progress) back as the boot had them. Pushed pages
 * (the pages of Welcome, About and Help) are states of their window; Troubleshooting is an entry of its own, because it
 * carries run-specific debug text that is masked.
 *
 * States that need other data than the boot has edit it in the page and never on the server: a request is answered in the
 * page (Recent Chats, the managed content status, the current user), or the module state of the app is changed (the
 * persona, the character library, the Welcome account keys). `openHome` and the `close` of every window put all of it
 * back, so the next `open`, and any other family that uses the same page, starts from Home as the boot has it.
 *
 * Only Home sets `primaryFlow`, because it is the page that a chat is opened from. The windows set `overlay`, and the
 * splash screen and the login page set neither.
 *
 * Regions that differ between runs are masked: the version and commit rows, the debug text, the dates of chats, and the
 * art panels, whose figures blink at random times. The splash screen is held still (see `holdSplash`) and its line is masked.
 *
 * The splash screen and the login page leave the booted app: the splash holds the settings request of a reload so that
 * the preloader stays up, and the login page is the static `/login.html`, whose requests for users and logins are
 * answered in the page, because the server of a run has user accounts off and answers none of them.
 */

import { FIXTURES } from './fixture-data.js';
import { chooseMenuItem, settle } from './steps.js';

const SCRIPTS = 'public/scripts';
const HOME_SCRIPTS = `${SCRIPTS}/sillybunny-home`;

const HOME = '#chat > .welcomePanel';
const HOME_MENU_BUTTON = `${HOME} .sbHomeMenuButton`;
const HOST = 'dialog.sb-dialog-host';
const OPEN_HOST = `${HOST}:not([closing])`;
/** The window that is open: its surface holds every page of it. */
const WINDOW = `${OPEN_HOST} section.sb-dialog`;
/** A push marks the covered page and a pop marks the leaving page at once, so one page is left while pages slide. */
const SHOWN_PAGE = `${OPEN_HOST} .sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving)`;
const OPEN_MENU = '.sb-action-popover, .sb-action-sheet:not([hidden]), #sb-mode-menu';

const WHATS_NEW = 'What’s New';
const WHATS_NEXT = 'What’s Next';

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = text => new RegExp(`^${escapeRegExp(text)}$`);

/** The boxed row of a list that carries the label, whatever description or icon sits beside it. */
const rowByLabel = (scope, label) => scope.locator('button.ds-row').filter({ has: scope.page().locator('.ds-row-label', { hasText: exactly(label) }) });

const shownPage = page => page.locator(SHOWN_PAGE);

/** What the smoke needs to see once a page of the open window is shown: its title, and elements of it. */
const onPage = (title, ...inside) => [`${SHOWN_PAGE} .sb-dialog__title:text-is("${title}")`, ...inside.map(selector => `${SHOWN_PAGE} ${selector}`)];

/** Opens the search of the open window (Help, the assistant picker) and types a query into it. */
async function searchWindow(page, query) {
    await page.locator(`${WINDOW} .sb-dialog__search-toggle`).click();
    await page.locator(WINDOW).getByRole('searchbox').fill(query);
    await settle(page);
}

/** Waits until the window has stopped animating and its pictures are in, so a capture is the settled one. */
async function windowSettled(page) {
    await page.locator(WINDOW).first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
        const surface = document.querySelector('dialog.sb-dialog-host:not([closing]) section.sb-dialog');
        if (!surface) {
            return false;
        }
        // A loop that never ends (a spinner, a blink) would hold the wait for ever, so only motion that ends counts.
        const moving = surface.getAnimations({ subtree: true }).some(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
        const waiting = [...surface.querySelectorAll('img')].some((image) => {
            if (image.complete) {
                return false;
            }
            const box = image.getBoundingClientRect();
            return !(image.loading === 'lazy' && (box.bottom < 0 || box.top > innerHeight));
        });
        return !moving && !waiting;
    });
    await settle(page);
}

/** Waits until the shown page of the open window has this title. */
async function waitForPageTitle(page, title) {
    await shownPage(page).locator('.sb-dialog__title').filter({ hasText: exactly(title) }).waitFor({ state: 'visible' });
    await windowSettled(page);
}

/**
 * Closes whatever is open on top of Home: menus, then the window with every page of it. A window opened through its module
 * (the first-run Welcome) leaves its handle in `window.__sbAuditDialog`, because that dialog has no Close and Escape does
 * nothing on its first page. The others close the way a user closes them, with Escape and then Close.
 * @param {import('@playwright/test').Page} page
 */
async function closeOverlays(page) {
    await page.evaluate(async () => {
        const dialog = window.__sbAuditDialog;
        window.__sbAuditDialog = null;
        await dialog?.close('start');
    });
    for (let attempt = 0; attempt < 10; attempt++) {
        if (await page.locator(HOST).count() === 0 && await page.locator(OPEN_MENU).count() === 0) {
            return;
        }
        await page.keyboard.press('Escape');
        await hostGoneWithin(page, 600);
        const close = shownPage(page).getByRole('button', { name: 'Close', exact: true });
        if (await page.locator(OPEN_HOST).count() && await close.first().isVisible()) {
            await close.first().click();
            await hostGoneWithin(page, 600);
        }
    }
    throw new Error(`A window or menu of Home did not close after 10 tries (${await page.locator(HOST).count()} window(s) and ${await page.locator(OPEN_MENU).count()} menu(s) are still there).`);
}

/**
 * Whether no window is left within `timeout` ms. Not being gone yet is an answer and not a failure: Escape on a pushed page
 * goes back one page and leaves the window open, so the loop of `closeOverlays` presses it again, and it throws if the
 * windows are still there after its last try.
 */
const hostGoneWithin = (page, timeout) => page.locator(HOST).waitFor({ state: 'detached', timeout }).then(() => true, () => false);

/** Waits for the pictures and the fitted blocks of Home. */
async function homeSettled(page) {
    await page.locator('#sheld[data-sb-home="on"]').waitFor({ state: 'attached' });
    await page.locator(HOME).waitFor({ state: 'visible' });
    // An image that the page loads lazily and that sits off screen has not started, and would hold the wait for ever.
    await page.waitForFunction(() => [...document.querySelectorAll('#chat > .welcomePanel img')].every((image) => {
        const box = image.getBoundingClientRect();
        return image.complete || (image.loading === 'lazy' && (box.bottom < 0 || box.top > innerHeight));
    }));
    await settle(page);
    await settle(page);
}

/** The requests that a state answers itself, by name. */
const STUB_PATTERNS = {
    recent: '**/api/chats/recent',
    managed: '**/api/sillybunny/managed-content/status',
    me: '**/api/users/me',
};
const stubRoutes = new WeakMap();

/** Answers one of `STUB_PATTERNS` with `answer` (the options of `route.fulfill`), or from the server again with `null`. */
async function stubRoute(page, name, answer) {
    const held = stubRoutes.get(page) ?? {};
    stubRoutes.set(page, held);
    if (held[name]) {
        await page.unroute(STUB_PATTERNS[name], held[name]);
        delete held[name];
    }
    if (answer !== null) {
        const handler = route => route.fulfill(answer);
        await page.route(STUB_PATTERNS[name], handler);
        held[name] = handler;
    }
}

/** Answers the list of Recent Chats from a fixed list, or from the server again with `null`. */
const stubRecentChats = (page, items) => stubRoute(page, 'recent', items === null ? null : { json: items });

function recentChatEntries(count) {
    return Array.from({ length: count }, (_, index) => ({
        file_name: `audit-recent-${index + 1}.jsonl`,
        avatar: FIXTURES.character.avatar,
        last_mes: Date.UTC(2026, 0, 1, 12) - index * 3_600_000,
        mes: `Audit message ${index + 1}`,
        chat_items: 3 + index,
        file_size: '1kb',
    }));
}

/**
 * Notes what a state changes in the page, once, so that the next `openHome` can put it back. Home keeps the assistant pointer
 * in the account storage and the Getting Started progress in one shared state, and both outlive a render. The persona, the
 * character library and the account are module state of the app, which a state edits in the page and never on the server.
 * @param {import('@playwright/test').Page} page
 * @param {{ pointer?: boolean, gettingStarted?: boolean, persona?: boolean, library?: boolean, welcome?: boolean }} what
 * `welcome` is the two account keys that ending the first run of Welcome writes.
 */
async function rememberHomeState(page, { pointer = false, gettingStarted = false, persona = false, library = false, welcome = false }) {
    await page.evaluate(async ({ pointer, gettingStarted, persona, library, welcome }) => {
        const saved = (window.__sbAuditHome ??= {});
        if (welcome && !('welcome' in saved)) {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            const { SHOW_AT_STARTUP_KEY, SEEN_VERSION_KEY } = await import('/scripts/sillybunny-welcome-startup.js');
            saved.welcome = Object.fromEntries([SHOW_AT_STARTUP_KEY, SEEN_VERSION_KEY].map(key => [key, accountStorage.getItem(key)]));
        }
        if (persona && !('persona' in saved)) {
            const { name1 } = await import('/script.js');
            const { power_user: powerUser } = await import('/scripts/power-user.js');
            saved.persona = { name: name1, personas: { ...powerUser.personas }, descriptions: { ...powerUser.persona_descriptions }, defaultPersona: powerUser.default_persona };
        }
        if (library && !('library' in saved)) {
            const { characters } = await import('/script.js');
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            const { getHomeAssistants } = await import('/scripts/sillybunny-home/assistant-registry.js');
            saved.library = {
                characters: [...characters],
                deleted: Object.fromEntries(getHomeAssistants().map(assistant => [assistant.deletedStorageKey, accountStorage.getItem(assistant.deletedStorageKey)])),
            };
        }
        if (pointer && !('pointer' in saved)) {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            saved.pointer = accountStorage.getItem('assistant') ?? null;
        }
        if (gettingStarted && !('hidden' in saved)) {
            const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
            const state = getSharedGettingStartedState();
            saved.hidden = state.isHidden();
            saved.skipped = Object.fromEntries(['connect', 'preset', 'character', 'chat'].map(id => [id, state.isSkipped(id)]));
        }
    }, { pointer, gettingStarted, persona, library, welcome });
}

/**
 * Puts back what `rememberHomeState` noted.
 * @returns {Promise<boolean>} Whether a state had changed anything.
 */
async function restoreHomeState(page) {
    return page.evaluate(async () => {
        const saved = window.__sbAuditHome;
        if (!saved) {
            return false;
        }
        delete window.__sbAuditHome;
        if (saved.accounts) {
            const { setUserControls } = await import('/scripts/user.js');
            await setUserControls(false);
        }
        if (saved.welcome) {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            for (const [key, value] of Object.entries(saved.welcome)) {
                if (value === null) {
                    accountStorage.removeItem(key);
                } else {
                    accountStorage.setItem(key, value);
                }
            }
        }
        if (saved.persona) {
            const { setUserName } = await import('/script.js');
            const { power_user: powerUser } = await import('/scripts/power-user.js');
            setUserName(saved.persona.name, { toastPersonaNameChange: false });
            for (const [key, value] of [['personas', saved.persona.personas], ['persona_descriptions', saved.persona.descriptions]]) {
                Object.keys(powerUser[key]).forEach(entry => delete powerUser[key][entry]);
                Object.assign(powerUser[key], value);
            }
            powerUser.default_persona = saved.persona.defaultPersona;
        }
        if (saved.library) {
            const { characters } = await import('/script.js');
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            characters.splice(0, characters.length, ...saved.library.characters);
            for (const [key, value] of Object.entries(saved.library.deleted)) {
                if (value === null) {
                    accountStorage.removeItem(key);
                } else {
                    accountStorage.setItem(key, value);
                }
            }
        }
        if ('pointer' in saved) {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            if (saved.pointer === null) {
                accountStorage.removeItem('assistant');
            } else {
                accountStorage.setItem('assistant', saved.pointer);
            }
        }
        if ('hidden' in saved) {
            const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
            const state = getSharedGettingStartedState();
            for (const [id, skipped] of Object.entries(saved.skipped)) {
                state.setSkipped(id, skipped);
            }
            state.setHidden(saved.hidden);
        }
        return true;
    });
}

/** Puts back every edit that a state made in the page, and gives the requests that a state answered back to the server. */
async function restoreHome(page) {
    await stubRecentChats(page, null);
    await stubRoute(page, 'managed', null);
    await stubRoute(page, 'me', null);
    return restoreHomeState(page);
}

/** Scrolls a region of Home to the top of the view, so the screenshot of a state that changes it shows the change. */
async function showRegion(page, region) {
    await homeSettled(page);
    await page.locator(`${HOME} [data-sb-home-region="${region}"]`).first().evaluate(node => node.scrollIntoView({ block: 'start' }));
    await settle(page);
}

const DISPLAY_MODES = { full: 'Full', compact: 'Compact', list: 'List Only' };

/** Picks a display mode from the main menu, as the menu's radio items do. */
async function chooseDisplayMode(page, mode) {
    await page.locator(HOME_MENU_BUTTON).click();
    await page.getByRole('menuitemradio', { name: DISPLAY_MODES[mode], exact: true }).click();
    await page.waitForFunction(wanted => document.querySelector('#chat > .welcomePanel')?.dataset.homePanelMode === wanted, mode);
    await homeSettled(page);
}

/**
 * Shows Home as the boot has it: the real list of Recent Chats, the assistant pointer and the Getting Started progress of the
 * boot, and the Full display mode. Closes everything that an earlier state opened.
 * @param {import('@playwright/test').Page} page
 */
async function openHome(page) {
    await closeOverlays(page);
    await restoreHome(page);
    await page.evaluate(async () => {
        const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
        await openWelcomeScreen({ force: true });
    });
    await homeSettled(page);
    if (await page.locator(HOME).getAttribute('data-home-panel-mode') !== 'full') {
        await chooseDisplayMode(page, 'full');
    }
}

/**
 * Makes the app think the account is a signed-in user who is not an admin, which is what Welcome reads when it opens: the
 * server of a run has accounts off, so the answer for the current user is given here and `isAdmin()` follows it.
 */
async function becomeNonAdmin(page) {
    await rememberHomeState(page, {});
    await stubRoute(page, 'me', { json: { handle: 'audit-guest', name: 'Audit Guest', admin: false, enabled: true, created: 1 } });
    const admin = await page.evaluate(async () => {
        window.__sbAuditHome.accounts = true;
        const { setUserControls, isAdmin } = await import('/scripts/user.js');
        await setUserControls(true);
        return isAdmin();
    });
    if (admin) {
        throw new Error('The app still counts the account as an admin.');
    }
}

/** The persona as an account that never chose a name has it, which Welcome offers a name field for. */
async function becomeUntouchedDefaultPersona(page) {
    await rememberHomeState(page, { persona: true });
    await page.evaluate(async () => {
        const { setUserName } = await import('/script.js');
        const { power_user: powerUser } = await import('/scripts/power-user.js');
        const { user_avatar: avatar } = await import('/scripts/personas.js');
        setUserName('User', { toastPersonaNameChange: false });
        delete powerUser.personas[avatar];
        delete powerUser.persona_descriptions[avatar];
        powerUser.default_persona = null;
    });
}

/**
 * Takes characters out of the library that Home reads, in the page only. `bundled` is Reisen and Tewi; `others` is every
 * character that is not one of them.
 * @param {import('@playwright/test').Page} page
 * @param {'bundled' | 'others'} which
 * @param {{ markDeleted?: boolean }} [options] `markDeleted` records the deletion of the bundled cards, as the account does.
 */
async function removeCharacters(page, which, { markDeleted = false } = {}) {
    await rememberHomeState(page, { library: true });
    await page.evaluate(async ({ which, markDeleted }) => {
        const { characters } = await import('/script.js');
        const { accountStorage } = await import('/scripts/util/AccountStorage.js');
        const { getHomeAssistants } = await import('/scripts/sillybunny-home/assistant-registry.js');
        const bundled = getHomeAssistants();
        const isBundled = character => bundled.some(assistant => assistant.defaultAvatar === character.avatar);
        characters.splice(0, characters.length, ...characters.filter(character => (which === 'bundled' ? !isBundled(character) : isBundled(character))));
        if (markDeleted) {
            bundled.forEach(assistant => accountStorage.setItem(assistant.deletedStorageKey, 'true'));
        }
    }, { which, markDeleted });
}

const REISEN_FILE = 'default_AssistantReisen.png';
const TEWI_FILE = 'default_AssistantTewi.png';
const managedItem = (filename, status, extra = {}) => ({ filename, type: 'character', version: 2, status, updateAvailable: false, ...extra });

/** Renders Home again, after a state changed what it reads. */
async function renderHomeAgain(page) {
    await page.evaluate(async () => {
        const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
        await openWelcomeScreen({ force: true });
    });
    await homeSettled(page);
}

/** Opens a window from an item of the main menu of Home. */
async function openFromHomeMenu(page, item) {
    await openHome(page);
    await chooseMenuItem(page, HOME_MENU_BUTTON, item);
    await windowSettled(page);
}

/** Opens a window from a tile of Home. The Getting Started tile is made shown first, in case the boot hid it. */
async function openFromHomeTile(page, key) {
    await openHome(page);
    if (key === 'getting-started') {
        await rememberHomeState(page, { gettingStarted: true });
        await page.evaluate(async () => {
            const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
            getSharedGettingStartedState().setHidden(false);
        });
    }
    await page.locator(`${HOME} .sbHomeTile[data-sb-home-key="${key}"]`).click();
    await windowSettled(page);
}

/** The art of Reisen and Tewi in Home and in the windows: the figures blink and breathe at random times. */
const ART_MASK = '.sbArtPanel';

/** Closes the window, then puts back what its states edited in the page, and shows Home again when something was put back. */
async function closeWindow(page) {
    await closeOverlays(page);
    if (await restoreHome(page)) {
        await renderHomeAgain(page);
    }
}

/** A window of Home that is one entry: the root is its surface, and `close` is the way a user closes it. */
function windowEntry({ id, title, open, ready, states, needs = [], sources, masks, upstreamMarkup }) {
    return {
        id: `home.${id}`,
        family: 'home',
        owner: 'A',
        title,
        root: WINDOW,
        open,
        close: closeWindow,
        ready,
        ...(states && { states }),
        masks: [ART_MASK, ...(masks ?? [])],
        ...(upstreamMarkup && { upstreamMarkup }),
        needs,
        sources,
        // The family is not an overlay family, and a window is not a primary flow.
        overlay: true,
    };
}

// Home.

const MENU_ROOT = '.sb-action-popover, .sb-action-sheet:not([hidden])';
const GETTING_STARTED_TILE = `${HOME} .sbHomeTile[data-sb-home-key="getting-started"]`;
/** The main menu button of the Home panel, while the shell shows Home: `data-sb-home` is on the sheld only then. */
const HOME_SHOWN = '#sheld[data-sb-home="on"] > #chat > .welcomePanel .sbHomeMenuButton';
const assistantCard = id => `${HOME} .sbHomeCard[data-sb-home-key="assistant-${id}"]`;
const RESTORE_BUTTON = `${HOME} .sbHomeFootButton[aria-label^="Restore"]`;

/** Shows the Assistants section of Home with the cards as the library and the managed status of the page have them. */
async function showAssistantCards(page, { status, library }) {
    if (library) {
        await removeCharacters(page, library.which, library);
    }
    await stubRoute(page, 'managed', { json: { items: status } });
    await renderHomeAgain(page);
}

const home = {
    id: 'home.home',
    family: 'home',
    owner: 'A',
    title: 'Home',
    root: HOME,
    open: openHome,
    ready: HOME_SHOWN,
    states: [
        {
            // The boot of a run shows the tile (its checklist has the character step done, which the character fixture
            // makes true), so the state that differs from Home as found is the tile gone. Its `ready` needs the tile gone.
            id: 'getting-started-hidden',
            ready: `${HOME}:not(:has(${GETTING_STARTED_TILE})) .sbHomeTile[data-sb-home-key="help"]`,
            async open(page) {
                if (await page.locator(GETTING_STARTED_TILE).count() === 0) {
                    throw new Error('The boot already hides the Getting Started tile, so this state would be Home as found.');
                }
                await rememberHomeState(page, { gettingStarted: true });
                await page.evaluate(async () => {
                    const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
                    getSharedGettingStartedState().setHidden(true);
                });
                await page.locator(GETTING_STARTED_TILE).waitFor({ state: 'detached' });
                await showRegion(page, 'tiles');
            },
        },
        {
            id: 'compact-mode',
            ready: `${HOME}[data-home-panel-mode="compact"] .sbHomeMenuButton`,
            open: page => chooseDisplayMode(page, 'compact'),
        },
        {
            id: 'list-only-mode',
            ready: `${HOME}[data-home-panel-mode="list"] .sbHomeMenuButton`,
            open: page => chooseDisplayMode(page, 'list'),
        },
        {
            id: 'no-recent-chats',
            ready: `${HOME} .sbHomeEmpty`,
            async open(page) {
                await stubRecentChats(page, []);
                await renderHomeAgain(page);
                await page.locator(`${HOME} .sbHomeEmpty`).first().waitFor({ state: 'visible' });
                await showRegion(page, 'recent-chats');
            },
        },
        {
            id: 'many-recent-chats',
            ready: `${HOME} .recentChat[data-file^="audit-recent-1"]`,
            async open(page) {
                await stubRecentChats(page, recentChatEntries(8));
                await renderHomeAgain(page);
                await page.locator(`${HOME} .recentChat`).first().waitFor({ state: 'visible' });
                await showRegion(page, 'recent-chats');
            },
        },
        {
            id: 'assistant-chosen',
            ready: `${HOME} .sbHomeCard[data-sb-assistant-kind="pointer"]`,
            async open(page) {
                await rememberHomeState(page, { pointer: true });
                await page.evaluate(async (avatar) => {
                    const { setAssistantPointer } = await import('/scripts/welcome-screen.js');
                    await setAssistantPointer(avatar);
                }, FIXTURES.character.avatar);
                await page.locator(`${HOME} .sbHomeCard[data-sb-assistant-kind="pointer"]`).waitFor({ state: 'visible' });
                await showRegion(page, 'assistants');
            },
        },
        {
            id: 'assistant-card-missing',
            ready: `${assistantCard('reisen')}:has(.sbHomeCardOpen:disabled):not(:has(.sbHomeFootButton[aria-label^="Restore"]))`,
            async open(page) {
                await showAssistantCards(page, { status: [], library: { which: 'bundled' } });
                await page.locator(`${assistantCard('reisen')} .sbHomeCardOpen:disabled`).waitFor({ state: 'attached' });
                await showRegion(page, 'assistants');
            },
        },
        {
            id: 'assistant-card-restore',
            ready: RESTORE_BUTTON,
            async open(page) {
                await showAssistantCards(page, {
                    status: [managedItem(REISEN_FILE, 'deleted'), managedItem(TEWI_FILE, 'deleted')],
                    library: { which: 'bundled', markDeleted: true },
                });
                // The first render reads the status that the page had, and the answer of the stub replaces the cards when Home is idle.
                await page.locator(RESTORE_BUTTON).first().waitFor({ state: 'attached' });
                await showRegion(page, 'assistants');
            },
        },
        {
            id: 'assistant-card-update-available',
            root: MENU_ROOT,
            ready: '.sb-action-menu [role="menuitem"]:has-text("Update Available")',
            async open(page) {
                // The offer is in the menu of the card. Home makes the cards again when the answer of the status arrives, so the
                // menu is opened once that answer is in, and a frame has passed for the cards to be replaced.
                const answered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sillybunny/managed-content/status');
                await showAssistantCards(page, { status: [managedItem(REISEN_FILE, 'modified', { updateAvailable: true })] });
                await (await answered).finished();
                await showRegion(page, 'assistants');
                await page.locator(`${assistantCard('reisen')} .sbHomeRowMenu`).click();
                await page.locator('.sb-action-menu').getByRole('menuitem', { name: 'Update Available', exact: true }).waitFor({ state: 'visible' });
                await settle(page);
            },
        },
        {
            id: 'main-menu',
            root: MENU_ROOT,
            ready: '.sb-action-menu [role="menuitemradio"]',
            async open(page) {
                await page.locator(HOME_MENU_BUTTON).click();
                await page.locator(MENU_ROOT).first().waitFor({ state: 'visible' });
                await settle(page);
            },
        },
        {
            id: 'mode-menu',
            root: '#sb-mode-menu',
            ready: '#sb-mode-menu .sb-mode-menu-item',
            async open(page) {
                await page.locator('#sb-mode-toggle').click();
                await page.locator('#sb-mode-menu').waitFor({ state: 'visible' });
                await settle(page);
            },
        },
    ],
    masks: ['[data-sb-home-version]', ART_MASK, `${HOME} .recentChat .chatDate`],
    needs: ['chat'],
    sources: [
        `${SCRIPTS}/welcome-screen.js`,
        `${SCRIPTS}/templates/sillybunnyHome.html`,
        `${HOME_SCRIPTS}/mount.js`,
        `${HOME_SCRIPTS}/tiles-view.js`,
        `${HOME_SCRIPTS}/assistants-view.js`,
        `${HOME_SCRIPTS}/menu.js`,
        'public/css/sillybunny-home.css',
    ],
    primaryFlow: true,
};

// Welcome.

const welcomeSources = [`${SCRIPTS}/sillybunny-welcome.js`, `${SCRIPTS}/sillybunny-welcome-startup.js`, `${HOME_SCRIPTS}/welcome-boot.js`];

/** The pages of Welcome, opened on top of its first page the way the buttons open them. */
function welcomePageStates({ firstRun }) {
    const next = page => shownPage(page).getByRole('button', { name: 'Next', exact: true }).click();
    const personaPage = async (page) => {
        await next(page);
        await waitForPageTitle(page, 'Your Persona');
    };
    const importPage = async (page) => {
        await shownPage(page).getByRole('button', { name: 'Import From SillyTavern' }).click();
        await waitForPageTitle(page, 'Import From SillyTavern');
    };
    /** Closes the window and opens Welcome again from the main menu, for a state that changes what Welcome reads when it opens. */
    const reopen = async (page) => {
        await closeOverlays(page);
        await chooseMenuItem(page, HOME_MENU_BUTTON, 'Show Welcome');
        await windowSettled(page);
    };
    return [
        {
            id: 'persona-page',
            ready: onPage('Your Persona', '[data-sb-editor-field^="welcome-persona-"]'),
            open: personaPage,
        },
        ...(firstRun ? [{
            id: 'persona-named',
            // Next stays off until the persona has a name.
            ready: onPage('Your Persona', '[data-sb-editor-field="welcome-persona-name"]', 'button:not([disabled]):has-text("Next")'),
            async open(page) {
                await personaPage(page);
                await shownPage(page).getByRole('textbox', { name: 'Your Name' }).fill('Ada Lovelace');
                await settle(page);
            },
        }] : [{
            // The persona is the one the account was born with, so Welcome offers the name field, with the default name as its hint.
            id: 'persona-page-default-persona',
            ready: onPage('Your Persona', '[data-sb-editor-field="welcome-persona-name"]', '[data-sb-editor-field="welcome-persona-manage"]'),
            async open(page) {
                await becomeUntouchedDefaultPersona(page);
                await reopen(page);
                await personaPage(page);
            },
        }]),
        {
            id: 'whats-next',
            ready: onPage(WHATS_NEXT, '[data-sb-editor-field="welcome-show-at-startup"]'),
            async open(page) {
                // Next on the persona page can rename the persona and, on a first run, end the first run, which writes two account
                // keys. Both are in the page only (the saves are answered by the guard), and `restoreHomeState` puts them back.
                await rememberHomeState(page, { persona: true, welcome: true });
                await personaPage(page);
                if (firstRun) {
                    await shownPage(page).getByRole('textbox', { name: 'Your Name' }).fill('Ada Lovelace');
                }
                await next(page);
                await waitForPageTitle(page, WHATS_NEXT);
            },
        },
        {
            id: 'import-page',
            ready: onPage('Import From SillyTavern', '[data-sb-editor-field="welcome-import-folder"]', '.sbWindowActions button'),
            open: importPage,
        },
        ...(firstRun ? [] : [{
            // An account that is not an admin cannot import a folder, so the page offers the backup ZIP alone.
            id: 'import-page-non-admin',
            ready: [`${SHOWN_PAGE}:not(:has([data-sb-editor-field="welcome-import-folder"])) .sbWindowActions button`, ...onPage('Import From SillyTavern')],
            async open(page) {
                await becomeNonAdmin(page);
                await reopen(page);
                await importPage(page);
            },
        }]),
    ];
}

const welcomeReopened = windowEntry({
    id: 'welcome.reopened',
    title: 'Welcome, reopened from the main menu',
    open: page => openFromHomeMenu(page, 'Show Welcome'),
    ready: onPage('Welcome', '.sbWelcomeIntro'),
    states: welcomePageStates({ firstRun: false }),
    sources: welcomeSources,
});

const welcomeFirstRun = windowEntry({
    id: 'welcome.first-run',
    title: 'Welcome, first run (the persona needs a name and the window has no Close)',
    async open(page) {
        await openHome(page);
        await page.evaluate(async () => {
            const { openWelcomeDialog } = await import('/scripts/sillybunny-welcome.js');
            window.__sbAuditDialog = await openWelcomeDialog({ firstRun: true });
        });
        await windowSettled(page);
    },
    ready: onPage('Welcome', '.sbWelcomeIntro'),
    states: welcomePageStates({ firstRun: true }),
    sources: welcomeSources,
});

// Getting Started.

const gettingStarted = windowEntry({
    id: 'getting-started',
    title: 'Getting Started',
    open: page => openFromHomeTile(page, 'getting-started'),
    ready: onPage('Getting Started', '[data-sb-editor-field="getting-started-connect"]'),
    states: [{
        id: 'all-skipped',
        // A finished list offers Hide Getting Started.
        ready: onPage('Getting Started', '.sbGettingStartedHide'),
        async open(page) {
            await page.evaluate(async () => {
                const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
                const state = getSharedGettingStartedState();
                for (const id of ['connect', 'preset', 'character', 'chat']) {
                    state.setSkipped(id, true);
                }
            });
            await page.locator(`${WINDOW} .sbGettingStartedHide`).waitFor({ state: 'visible' });
            await windowSettled(page);
        },
    }],
    sources: [`${HOME_SCRIPTS}/getting-started-window.js`, `${HOME_SCRIPTS}/getting-started.js`, `${HOME_SCRIPTS}/step-rows.js`],
});

// Help.

const helpSidebar = page => page.locator(`${WINDOW} .sb-list-editor__sidebar`);
/** The Help page that is shown: beside the sections on a wide window, a pushed page on a narrow one. */
const helpPage = page => page.locator(`${OPEN_HOST} .sbHelpPage:visible`).last();

async function openHelpSection(page, title) {
    await rowByLabel(helpSidebar(page), title).click();
    await page.locator(`${OPEN_HOST} .sbHelpPage[data-sb-help-view="section"]:visible`).waitFor({ state: 'visible' });
    await windowSettled(page);
}

async function openHelpTopic(page, section, topic) {
    await openHelpSection(page, section);
    await rowByLabel(helpPage(page), topic).click();
    await page.locator(`${OPEN_HOST} .sbHelpPage[data-sb-help-view="topic"]:visible`).waitFor({ state: 'visible' });
    await windowSettled(page);
}

const help = windowEntry({
    id: 'help',
    title: 'Help (the sections beside the front page; on a phone the sections alone)',
    async open(page) {
        await openFromHomeTile(page, 'help');
        await helpSidebar(page).locator('[data-sb-help-nav]').first().waitFor({ state: 'visible' });
    },
    ready: onPage('Help', '.sb-list-editor__sidebar [data-sb-help-nav]'),
    states: [
        {
            id: 'front-page',
            ready: `${OPEN_HOST} .sbHelpPage[data-sb-help-view="index"]:visible`,
            async open(page) {
                await rowByLabel(helpSidebar(page), 'Overview').click();
                await page.locator(`${OPEN_HOST} .sbHelpPage[data-sb-help-view="index"]:visible`).waitFor({ state: 'visible' });
                await windowSettled(page);
            },
        },
        {
            id: 'section-page',
            ready: `${OPEN_HOST} .sbHelpPage[data-sb-help-view="section"]:visible`,
            open: page => openHelpSection(page, 'Models and Connections'),
        },
        {
            id: 'topic-page',
            ready: `${OPEN_HOST} .sbHelpPage[data-sb-help-view="topic"]:visible`,
            open: page => openHelpTopic(page, 'Models and Connections', 'Connect to a Model'),
        },
        {
            id: 'search-results',
            ready: `${WINDOW} .sb-list-editor__sidebar [data-sb-help-topic]:visible`,
            async open(page) {
                await searchWindow(page, 'preset');
                await helpSidebar(page).locator('[data-sb-help-topic]').first().waitFor({ state: 'visible' });
            },
        },
        {
            id: 'search-no-match',
            ready: `${WINDOW} .sb-status-page:visible`,
            async open(page) {
                await searchWindow(page, 'zzzz');
                await page.locator(`${WINDOW} .sb-status-page`).first().waitFor({ state: 'visible' });
            },
        },
    ],
    sources: [`${SCRIPTS}/sillybunny-help/help-window.js`, `${SCRIPTS}/sillybunny-help/help-views.js`, `${SCRIPTS}/sillybunny-help/topics.js`],
});

// About and Troubleshooting.

const ABOUT_MASKS = ['about-version', 'about-branch', 'about-commit'].map(field => `[data-sb-editor-field="${field}"]`);

/** Opens About and waits until the server has answered for the branch and commit, so no row shows its stand-in. */
async function openAbout(page) {
    await openFromHomeMenu(page, 'About SillyBunny');
    await page.waitForFunction(() => ['about-branch', 'about-commit'].every((field) => {
        const row = document.querySelector(`[data-sb-editor-field="${field}"]`);
        return row && !row.textContent.includes('…');
    }));
    await windowSettled(page);
}

/** A page that About pushes from one of its rows. */
const aboutPage = (title, button = title) => ({
    id: title === WHATS_NEW ? 'whats-new' : title.toLowerCase(),
    ready: onPage(title),
    async open(page) {
        await page.locator(WINDOW).getByRole('button', { name: button, exact: true }).click();
        await waitForPageTitle(page, title);
    },
});

const about = windowEntry({
    id: 'about',
    title: 'About SillyBunny',
    open: openAbout,
    ready: onPage('About SillyBunny', '[data-sb-editor-field="about-version"]'),
    states: [aboutPage(WHATS_NEW), aboutPage('Credits'), aboutPage('Legal')],
    masks: ABOUT_MASKS,
    sources: [`${SCRIPTS}/sillybunny-about.js`],
});

const troubleshooting = windowEntry({
    id: 'troubleshooting',
    title: 'Troubleshooting (a page of About)',
    async open(page) {
        await openAbout(page);
        await page.locator(WINDOW).getByRole('button', { name: 'Troubleshooting', exact: true }).click();
        await waitForPageTitle(page, 'Troubleshooting');
    },
    ready: onPage('Troubleshooting', '.sbDebugInfo'),
    masks: ['.sbDebugInfo'],
    sources: [`${SCRIPTS}/sillybunny-about.js`],
});

// Bundled Extras, Keyboard Shortcuts, the assistant picker.

const bundledExtras = windowEntry({
    id: 'bundled-extras',
    title: 'Bundled Extras',
    open: page => openFromHomeTile(page, 'extras'),
    ready: onPage('Bundled Extras', '[data-sb-editor-field^="bundled-extra-"]'),
    sources: [`${HOME_SCRIPTS}/bundled-extras-window.js`, `${SCRIPTS}/sillybunny-bundled-extras.js`],
});

const keyboardShortcuts = windowEntry({
    id: 'keyboard-shortcuts',
    title: 'Keyboard Shortcuts',
    open: page => openFromHomeMenu(page, 'Keyboard Shortcuts'),
    ready: onPage('Keyboard Shortcuts', '.ds-row'),
    sources: [`${SCRIPTS}/sillybunny-shortcuts.js`],
});

async function openPickerFromChooseCard(page) {
    await page.locator(`${HOME} .sbHomeCard--choose .sbHomeCardOpen`).click();
    await windowSettled(page);
}

const assistantPicker = windowEntry({
    id: 'assistant-picker',
    title: 'Choose Assistant (the picker of the third assistant slot)',
    async open(page) {
        await openHome(page);
        await openPickerFromChooseCard(page);
    },
    ready: onPage('Choose Assistant', 'button.ds-row'),
    states: [
        {
            id: 'search-results',
            ready: `${WINDOW} [data-sb-assistant-avatar]:visible`,
            async open(page) {
                await searchWindow(page, 'audit');
                await page.locator(`${WINDOW} .ds-row`).first().waitFor({ state: 'visible' });
            },
        },
        {
            id: 'search-no-results',
            ready: `${WINDOW} .sb-status-page:has-text("No results"):visible`,
            async open(page) {
                await searchWindow(page, 'zzzz');
                await page.locator(`${WINDOW} .sb-status-page`).first().waitFor({ state: 'visible' });
            },
        },
        {
            // The library holds Reisen and Tewi alone, who have cards of their own, so the list has nobody to offer.
            id: 'empty-library',
            ready: `${WINDOW} .sb-status-page:has-text("No Characters Yet"):visible`,
            async open(page) {
                await closeOverlays(page);
                await removeCharacters(page, 'others');
                await openPickerFromChooseCard(page);
            },
        },
        {
            // Opened from the menu of the third card while it holds a character, so that character's row is marked.
            id: 'current-choice',
            ready: `${WINDOW} [data-sb-assistant-avatar][aria-current="true"]`,
            async open(page) {
                await closeOverlays(page);
                await rememberHomeState(page, { pointer: true });
                await page.evaluate(async (avatar) => {
                    const { setAssistantPointer } = await import('/scripts/welcome-screen.js');
                    await setAssistantPointer(avatar);
                }, FIXTURES.character.avatar);
                await page.locator(`${HOME} .sbHomeCard[data-sb-assistant-kind="pointer"]`).waitFor({ state: 'visible' });
                await chooseMenuItem(page, '#sb-home-assistant-own-menu', 'Choose Another Assistant…');
                await windowSettled(page);
            },
        },
    ],
    needs: ['character'],
    sources: [`${HOME_SCRIPTS}/assistant-picker.js`, `${HOME_SCRIPTS}/assistant-cards.js`],
});

// The splash screen.

const SPLASH_PICTURE = '#preloader .sb-boot-loop, #preloader .sb-boot-mascot';
/** The picture of a variant: the box that the loop plays in, which holds the still of the variant while the loop runs, or the still itself. */
const splashOf = variant => `#preloader .sb-boot-loop:has(.sb-boot-mascot[data-variant="${variant}"]), #preloader .sb-boot-mascot[data-variant="${variant}"]`;

const SETTINGS_PATTERN = '**/api/settings/get';
/** The splash reads its variant and its motion from the browser storage, because the settings are not loaded yet. */
const SPLASH_STORAGE_KEYS = ['sb-splash-character', 'sb-reduced-motion'];

/**
 * One handler per page answers the settings request, and holds it while the splash is wanted. The reload keeps the viewport,
 * the pointer and the media features of the context, the density (the init script of the boot stores it) and the theme (the
 * app stores the colours of its page when it is left, for the next splash). The text size is not kept, and a user does not
 * have it either: the app applies `--fontScale` from the settings, which this page is still waiting for.
 *
 * The splash is held still: the app's own Reduced Motion marker in the browser storage drops the loop of the picture and
 * the animations of the line, so that two runs show the same picture. `releaseSplash` puts the storage back.
 */
const splashGates = new WeakMap();

async function holdSplash(page, variant) {
    let gate = splashGates.get(page);
    if (!gate) {
        const before = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), SPLASH_STORAGE_KEYS);
        gate = { release: () => {}, released: Promise.resolve(), before, handler: null };
        splashGates.set(page, gate);
        const held = gate;
        held.handler = async (route) => {
            await held.released;
            try {
                await route.fallback();
            } catch {
                // A request of a page that was reloaded meanwhile is already gone.
            }
        };
        await page.route(SETTINGS_PATTERN, held.handler);
    }
    // The request of the page that is still held is let go only after the reload has replaced that page: answering it
    // first would let the old page boot the whole app while the reload waits for it.
    const releaseOld = gate.release;
    gate.released = new Promise((resolve) => { gate.release = resolve; });
    await page.evaluate((chosen) => {
        localStorage.setItem('sb-splash-character', chosen);
        localStorage.setItem('sb-reduced-motion', 'true');
    }, variant);
    await page.reload({ waitUntil: 'domcontentloaded' });
    releaseOld();
    await page.locator(SPLASH_PICTURE).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => {
        const mascot = document.querySelector('#preloader .sb-boot-mascot');
        const letters = [...document.querySelectorAll('#preloader .sb-boot-letter')];
        return (!mascot || mascot.complete) && letters.length > 0 && letters.every(letter => getComputedStyle(letter).opacity === '1');
    });
    await settle(page);
}

/** Lets the boot go on, which removes the preloader once the app is ready, and puts back the browser storage and the route that `holdSplash` changed. */
async function releaseSplash(page) {
    const gate = splashGates.get(page);
    gate?.release();
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60_000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    if (gate) {
        await page.evaluate((before) => {
            for (const [key, value] of Object.entries(before)) {
                if (value === null) {
                    localStorage.removeItem(key);
                } else {
                    localStorage.setItem(key, value);
                }
            }
        }, gate.before);
        await page.unroute(SETTINGS_PATTERN, gate.handler);
        splashGates.delete(page);
    }
}

const splash = {
    id: 'home.splash',
    family: 'home',
    owner: 'A',
    title: 'Splash screen (the preloader, held by a reload)',
    root: '#preloader',
    open: page => holdSplash(page, 'both'),
    close: releaseSplash,
    ready: splashOf('both'),
    states: [
        { id: 'reisen', ready: splashOf('reisen'), open: page => holdSplash(page, 'reisen') },
        { id: 'tewi', ready: splashOf('tewi'), open: page => holdSplash(page, 'tewi') },
    ],
    masks: ['#preloader .sb-boot-line'],
    needs: [],
    sources: [`${SCRIPTS}/sillybunny-splash.js`, `${SCRIPTS}/sillybunny-splash-loop.js`, 'public/css/loader.css'],
};

// The login page.

const LOGIN_ROOT = 'body.login #shadow_popup';
const LOGIN_USERS = [
    { handle: 'audit-user', name: 'Audit User', created: 1, avatar: '/img/ai4.png', password: true },
    { handle: 'audit-guest', name: 'Audit Guest', created: 2, avatar: '/img/ai4.png', password: false },
];

const LOGIN_PATTERN = '**/api/users/*';

/** One handler per page answers the account endpoints of the login page, which the server answers only with accounts on. */
const loginStubs = new WeakMap();

async function stubLoginApi(page, { discreet }) {
    let stub = loginStubs.get(page);
    if (!stub) {
        stub = { discreet, handler: null };
        loginStubs.set(page, stub);
        const current = stub;
        current.handler = (route) => {
            switch (new URL(route.request().url()).pathname) {
                case '/api/users/list':
                    return current.discreet ? route.fulfill({ status: 204 }) : route.fulfill({ json: LOGIN_USERS });
                case '/api/users/login':
                    return route.fulfill({ status: 403, json: { error: 'Incorrect credentials' } });
                case '/api/users/recover-step1':
                    return route.fulfill({ json: {} });
                default:
                    return route.fallback();
            }
        };
        await page.route(LOGIN_PATTERN, current.handler);
    }
    stub.discreet = discreet;
}

async function openLogin(page, { discreet = false } = {}) {
    await stubLoginApi(page, { discreet });
    await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
    // The script shows the page once it has the user list.
    await page.waitForFunction(() => document.getElementById('shadow_popup')?.style.opacity === '');
    await page.locator(discreet ? '#handleEntryBlock' : '#userList .userSelect').first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => [...document.images].every(image => image.complete));
    await settle(page);
}

async function chooseLoginUser(page) {
    await page.locator('#userList .userSelect', { hasText: 'Audit User' }).click();
    await page.locator('#passwordEntryBlock').waitFor({ state: 'visible' });
    await settle(page);
}

/** Back to the booted app, with the account endpoints answered by the server again. */
async function leaveLogin(page) {
    const stub = loginStubs.get(page);
    if (stub) {
        await page.unroute(LOGIN_PATTERN, stub.handler);
        loginStubs.delete(page);
    }
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60_000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
}

const login = {
    id: 'home.login',
    family: 'home',
    owner: 'B',
    title: 'Login page (served with user accounts on; shown here from the static file)',
    root: LOGIN_ROOT,
    open: page => openLogin(page),
    close: leaveLogin,
    ready: '#userList .userSelect',
    states: [
        {
            id: 'password-entry',
            ready: '#passwordEntryBlock',
            open: chooseLoginUser,
        },
        {
            id: 'login-error',
            ready: '#errorMessage:has-text("Incorrect credentials")',
            async open(page) {
                await chooseLoginUser(page);
                await page.locator('#loginButton').click();
                await page.locator('#errorMessage', { hasText: 'Incorrect credentials' }).waitFor({ state: 'visible' });
                await settle(page);
            },
        },
        {
            id: 'password-recovery',
            ready: '#passwordRecoveryBlock',
            async open(page) {
                await chooseLoginUser(page);
                await page.locator('#recoverPassword').click();
                await page.locator('#passwordRecoveryBlock').waitFor({ state: 'visible' });
                await settle(page);
            },
        },
        {
            id: 'discreet-login',
            ready: '#handleEntryBlock',
            open: page => openLogin(page, { discreet: true }),
        },
    ],
    needs: [],
    sources: ['public/login.html', 'public/css/login.css', 'public/scripts/login.js'],
};

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    home,
    welcomeReopened,
    welcomeFirstRun,
    gettingStarted,
    help,
    about,
    troubleshooting,
    bundledExtras,
    keyboardShortcuts,
    assistantPicker,
    splash,
    login,
];
