/*
 * Surfaces and boot helpers for the dialog accessibility spec. They live here, not in the spec, so the
 * spec holds only the checks. Where a step before a trigger is programmatic, the surface says why.
 */

import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { OPEN_ACTION_SHEET } from './action-sheet.js';
import { makeCharacterCard, withoutAssistantAccount } from './assistant-library.js';
import {
    bootArchive,
    dialog as archiveDialog,
    drawerButton,
    isCollapsed,
    linkedRow,
    openMenuItem,
    rows,
    showCharacterList,
    waitForDetail,
} from './chats-archive.js';
import { installProbes, settleTransitions } from './dialog-accessibility.js';
import { applyHomeTestSettings } from './getting-started-state.js';
import { protectMaintainerServer } from './maintainer-server.js';
import { bootMiscDialogs, openMiscFixtureChat } from './misc-dialogs.js';
import { fetchJsonOrSkip } from './route-fetch.js';

export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };
export const TEXT_SCALE = 2;

const ALICE = [{ name: 'Alice', avatar: 'Alice.png' }];
const ARCHIVE_NAMES = ['Alice - First chat', 'Alice - Second chat', 'Alice - Third chat', 'Alice - Fourth chat'];
const TAG_CHARACTER = 'misc-dialog-character.png';
const PANEL_ID = 'floatingPrompt';

// Reads that the boot makes, so the guard lets them through to the isolated test server.
const READ_ONLY_POSTS = new Set([
    '/api/settings/get', '/api/presets/defaults', '/api/avatars/get', '/api/backgrounds/folders',
    '/api/backgrounds/all', '/api/image-metadata/all', '/api/tokenizers/openai/count', '/api/groups/all',
    '/api/server-admin/install-type', '/api/server-admin/config/get', '/api/server-admin/config/thumbnail-settings/get',
    '/api/server-admin/config/chat-completions/get', '/api/server-admin/status', '/api/secrets/read',
    '/api/in-chat-agents/groups/list', '/api/openrouter/providers', '/api/nanogpt/providers', '/api/sd/comfy/workflows',
    '/api/chats/recent',
]);

/**
 * Refuses every request that could write or leave the test server. It is registered before the helpers'
 * own stubs, so theirs run first and this only sees what they do not answer.
 */
async function guardWrites(page, baseURL) {
    const origin = new URL(baseURL).origin;
    await page.context().route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
        if (request.method() === 'POST' && READ_ONLY_POSTS.has(url.pathname)) return route.continue();
        return route.abort();
    });
    await page.route('**/api/quick-replies/save', route => route.fulfill({ body: 'ok' }));
}

/**
 * The intercepted settings for a boot. `motion` turns animations on; `fontScale` is the app's own text scale. `guard` is off
 * for a boot that reads the account the way Home does, which the guard of the misc fixture would cut off.
 */
async function prepareBoot(page, baseURL, { motion = false, fontScale = 1, guard = true } = {}) {
    if (guard) await guardWrites(page, baseURL);
    const context = { destructiveRequests: [] };
    await page.route('**/api/cookies/clear', route => {
        context.destructiveRequests.push(route.request().url());
        return route.fulfill({ json: { success: true, expirationAttempts: 0 } });
    });
    return {
        context,
        configureSettings(settings) {
            settings.power_user.reduced_motion = !motion;
            settings.power_user.font_scale = fontScale;
        },
        reducedMotion: motion ? 'no-preference' : 'reduce',
    };
}

export async function bootMisc(page, baseURL, viewport, options) {
    const { context, configureSettings, reducedMotion } = await prepareBoot(page, baseURL, options);
    await bootMiscDialogs(page, viewport, { configureSettings, reducedMotion });
    await installProbes(page);
    return context;
}

/**
 * Boots the misc fixture and opens its character's chat, because Home has no composer. The surfaces that start from the
 * composer's Options menu open it at once, and the composer focus that follows a chat load would close it.
 */
export async function bootMiscWithChat(page, baseURL, viewport, options) {
    const context = await bootMisc(page, baseURL, viewport, options);
    await openMiscFixtureChat(page, { waitForAutofocus: true });
    return context;
}

async function bootArchiveApp(page, baseURL, viewport, options) {
    const { context, configureSettings, reducedMotion } = await prepareBoot(page, baseURL, options);
    const fixture = {
        rows: ARCHIVE_NAMES.map(name => linkedRow(name)),
        orphans: [],
        organization: null,
        characters: ALICE,
        groups: [],
    };
    await bootArchive(page, viewport, { fixture, configureSettings, reducedMotion });
    await installProbes(page);
    return context;
}

const HOME_READY_TIMEOUT = 30_000;
const OPEN_DIALOG = 'dialog[open]:not([closing])';
/** The shown page of the open dialog: not the pages under it, and not one that is leaving. */
const SHOWN_PAGE = 'dialog.sb-dialog-host:not([closing]) .sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving)';

const ASSISTANT_LIBRARY = [
    ['default_AssistantReisen.png', 'Assistant Reisen'],
    ['default_AssistantTewi.png', 'Assistant Tewi'],
    ['Alice.png', 'Alice'],
    ['Bob.png', 'Bob'],
    ['Carol.png', 'Carol'],
];
const BUNDLED_CARD_FILES = ['default_AssistantReisen.png', 'default_AssistantTewi.png'];
const ASSISTANT_THUMBNAIL = readFileSync(new URL('../../public/img/ai4.png', import.meta.url));

/**
 * Makes the assistant cards of Home the same on every data root: the library is the one above, the pointer is the one the
 * surface names, and the migration of the pointer counts as done, so the third card is the same on every run.
 */
async function pinAssistants(page, { pointer, absent = [], account = {}, managed: managedAtStart = {} }) {
    // Each boot starts from the same status, because the routes below change it.
    const managed = structuredClone(managedAtStart);
    const library = ASSISTANT_LIBRARY.filter(([avatar]) => !absent.includes(avatar));
    await page.route('**/thumbnail?*', route => route.fulfill({ contentType: 'image/png', body: ASSISTANT_THUMBNAIL }));
    await page.route('**/api/characters/all', route => route.fulfill({ json: library.map(([avatar, name]) => makeCharacterCard(avatar, name)) }));
    // The managed content of the server: what it says of the two bundled cards, and a Restore that puts the card back.
    await page.route('**/api/sillybunny/managed-content/status', route => route.fulfill({
        json: { items: BUNDLED_CARD_FILES.map(filename => ({ filename, type: 'character', version: 1, status: 'current', updateAvailable: false, ...managed[filename] })) },
    }));
    await page.route(/\/api\/sillybunny\/managed-content\/(?:apply|restore)$/, (route) => {
        const { filename } = route.request().postDataJSON();
        managed[filename] = { status: 'current', updateAvailable: false };
        const entry = ASSISTANT_LIBRARY.find(([avatar]) => avatar === filename);
        if (entry && !library.some(([avatar]) => avatar === filename)) library.push(entry);
        return route.fulfill({ json: { backup: 'managed/backup' } });
    });
    return (settings) => {
        settings.accountStorage = {
            ...withoutAssistantAccount(settings.accountStorage),
            WelcomePage_AssistantPointerMigrated: 'true',
            ...account,
            ...(pointer === null ? {} : { assistant: pointer }),
        };
    };
}

/**
 * Boots the app on Home with the account of a spec about Home, and Welcome shut. `firstRun` boots an account that has never
 * met Welcome instead: its dialog is the first thing on the page, and the app is not ready until the persona has a name.
 * `assistants` pins the library and the assistant pointer (`null` for none), so the third assistant card is known. `absent`
 * names the bundled cards that the library lacks, `account` adds account storage keys, and `managed` says what the server
 * reports of a bundled file.
 */
async function bootHome(page, baseURL, viewport, options, { firstRun = false, assistants = null } = {}) {
    const { context, configureSettings, reducedMotion } = await prepareBoot(page, baseURL, { ...options, guard: false });
    await protectMaintainerServer(page);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion });
    const pinAccount = assistants ? await pinAssistants(page, assistants) : () => {};
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        // A first run has no stored checklist, which is how Getting Started tells it from an old account.
        applyHomeTestSettings(settings, firstRun ? { firstRun: true, value: null, welcome: 'never-seen' } : {});
        configureSettings(settings);
        pinAccount(settings);
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.goto('/');
    if (firstRun) {
        await expect(page.locator(OPEN_DIALOG)).toBeVisible({ timeout: HOME_READY_TIMEOUT });
    } else {
        await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: HOME_READY_TIMEOUT });
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: HOME_READY_TIMEOUT });
        await expect(page.locator('#chat > .welcomePanel .sbHomeTile').first()).toBeVisible();
    }
    await installProbes(page);
    context.firstRun = firstRun;
    return context;
}

const bootHomeFirstRun = (page, baseURL, viewport, options) => bootHome(page, baseURL, viewport, options, { firstRun: true });
const bootHomeWithAssistants = (pointer, more = {}) => (page, baseURL, viewport, options) => bootHome(page, baseURL, viewport, options, { assistants: { pointer, ...more } });

/** Reisen was deleted: her card is not in the library, the account recorded it, and the server reports the bundled file as deleted. */
export const bootHomeWithDeletedReisen = bootHomeWithAssistants(null, {
    absent: ['default_AssistantReisen.png'],
    account: { bundledAssistantReisenDeleted: 'true' },
    managed: { 'default_AssistantReisen.png': { status: 'deleted' } },
});

/** Reisen was edited, and the bundled card has a newer version. */
const bootHomeWithEditedReisen = bootHomeWithAssistants(null, {
    managed: { 'default_AssistantReisen.png': { status: 'modified', updateAvailable: true, version: 2 } },
});

async function waitForSettled(page) {
    await page.waitForFunction(() => !document.querySelector('dialog[open][opening], dialog[open][closing]'));
    await settleTransitions(page);
}

async function waitForSurface(page, locator) {
    await expect(locator).toBeVisible();
    await waitForSettled(page);
}

export async function pressKey(page, key) {
    await page.keyboard.press(key);
    await settleTransitions(page);
}

// --- Setup shared by several surfaces -------------------------------------------------------------------

// Opening the character list has no single-key route, so the shell opens it after the toggle is pressed.
async function openCharacterList(page) {
    await page.locator('#sb-character-toggle').focus();
    await pressKey(page, 'Enter');
    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
    await expect(page.locator('.sb-character-list [data-action-id="more"]')).toBeVisible();
}

async function openCharacterListMenu(page) {
    const trigger = page.locator('.sb-character-list [data-action-id="more"]');
    await trigger.focus();
    await pressKey(page, 'Enter');
    return trigger;
}

async function prepareTags(page) {
    await page.evaluate(async avatar => {
        const tags = await import('/scripts/tags.js');
        const app = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        const state = await import('/scripts/sillybunny-character-list-state.js');
        tags.tags.splice(0, tags.tags.length,
            { id: 'qa-tag-alpha', name: 'QA Alpha', color: 'rgb(90, 160, 220)', color2: '', folder_type: 'NONE', sort_order: 0 },
            { id: 'qa-tag-beta', name: 'QA Beta', color: '', color2: '', folder_type: 'NONE', sort_order: 1 },
        );
        for (const key of Object.keys(tags.tag_map)) delete tags.tag_map[key];
        tags.tag_map[avatar] = ['qa-tag-alpha'];
        power_user.bogus_folders = false;
        power_user.charListGrid = false;
        power_user.tag_sort_mode = 'manual';
        document.body.classList.remove('charListGrid');
        await state.switchCharacterListView('characters');
        for (const type of ['fav', 'folder', 'group']) app.entitiesFilter.setFilterData(type, 'UNDEFINED', true);
        app.entitiesFilter.setFilterData('tag', { selected: [], excluded: [] }, true);
        app.entitiesFilter.setFilterData('search', '', true);
        app.entitiesFilter.clearFuzzySearchCaches();
        document.getElementById('character_search_bar').value = '';
        await app.printCharacters(false);
    }, TAG_CHARACTER);
}

const tagRow = page => page.locator('#tag_view_list .tag_view_item[id="qa-tag-alpha"]');
const PANEL_SELECTOR = `.sb-side-panel[data-sb-side-panel-id="${PANEL_ID}"]`;
const sidePanel = page => page.locator(PANEL_SELECTOR);

/**
 * The archive keeps a sidebar and a list side by side on a wide frame. On a narrow one the sidebar is the
 * first page and the list is pushed.
 */
export async function openArchiveList(page) {
    if (await isCollapsed(page)) {
        await page.locator('.sbca-location').first().focus();
        await pressKey(page, 'Enter');
    }
    await expect(rows(page).first()).toBeVisible();
    await settleTransitions(page);
}

async function pushTagMembersPage(page) {
    await tagRow(page).focus();
    await pressKey(page, 'Enter');
    await expect(page.locator('#tag_view_list .sb-tag-manager__members')).toBeVisible();
    await settleTransitions(page);
}

// --- Setup of the windows that Home opens --------------------------------------------------------------

const homeTile = (page, key) => page.locator(`#chat > .welcomePanel .sbHomeTile[data-sb-home-key="${key}"]`);
const shown = page => page.locator(SHOWN_PAGE);
const homeMenuButton = page => page.locator('#chat > .welcomePanel .sbHomeMenuButton');

/** A tile is a button, so the keyboard user reaches the window with Enter and the window returns focus to the tile. */
async function openFromTile(page, key) {
    const opener = homeTile(page, key);
    await opener.focus();
    await pressKey(page, 'Enter');
    await waitForSurface(page, page.locator(OPEN_DIALOG));
    return opener;
}

/** The main menu opens with Enter on its button, and an item is chosen with Enter once it has focus. */
async function openFromMenu(page, label) {
    const opener = homeMenuButton(page);
    await opener.focus();
    await pressKey(page, 'Enter');
    const item = page.getByRole('menuitem', { name: label, exact: true });
    await expect(item).toBeVisible();
    await item.focus();
    await pressKey(page, 'Enter');
    await waitForSurface(page, page.locator(OPEN_DIALOG));
    return opener;
}

const assistantCardPart = (page, selector) => page.locator(`#chat > .welcomePanel .sbHomeCard[data-sb-home-key="assistant-own"] ${selector}`);
const assistantMenuButton = page => assistantCardPart(page, '.sbHomeRowMenu');

/** The card that chooses is a button, so it opens the picker with Enter, and the window gives the focus back to it. */
async function openPickerFromChooseCard(page) {
    const opener = assistantCardPart(page, '.sbHomeCardOpen');
    await opener.focus();
    await pressKey(page, 'Enter');
    await waitForSurface(page, page.locator(OPEN_DIALOG));
    return opener;
}

/** The menu button of the chosen card holds the focus when the picker opens, so it is where the window returns the focus. */
async function openPickerFromCardMenu(page) {
    const opener = assistantMenuButton(page);
    await opener.focus();
    await pressKey(page, 'Enter');
    const item = page.getByRole('menuitem', { name: 'Choose Another Assistant…', exact: true });
    await expect(item).toBeVisible();
    await item.focus();
    await pressKey(page, 'Enter');
    await waitForSurface(page, page.locator(OPEN_DIALOG));
    return opener;
}

const reisenCardPart = (page, selector) => page.locator(`#chat > .welcomePanel .sbHomeCard[data-sb-home-key="assistant-reisen"] ${selector}`);

/** The menu of the edited card has Update Available after its chat item, and the question opens over Home. */
async function openUpdateQuestionFromCardMenu(page) {
    const opener = reisenCardPart(page, '.sbHomeRowMenu');
    await opener.focus();
    await pressKey(page, 'Enter');
    const item = page.getByRole('menuitem', { name: 'Update Available', exact: true });
    await expect(item).toBeVisible();
    await item.focus();
    await pressKey(page, 'Enter');
    await waitForSurface(page, page.locator(OPEN_DIALOG));
    return opener;
}

/** Remembers the control that has the focus, so a step can name it after a page above it closes. */
async function markFocusedControl(page, context) {
    await page.evaluate(() => {
        document.querySelectorAll('[data-qa-return-focus]').forEach(node => node.removeAttribute('data-qa-return-focus'));
        document.activeElement?.setAttribute('data-qa-return-focus', '');
    });
    context.returnFocus = page.locator('[data-qa-return-focus]');
}

async function pushShortcutsOverHelp(page, context) {
    await markFocusedControl(page, context);
    await pressKey(page, 'Control+?');
    await expect(page.locator(`${OPEN_DIALOG} .sbShortcutsDialog`)).toBeVisible();
    await settleTransitions(page);
}

/** A topic is two steps from the front page: a section of the list, then its first topic. */
async function openFirstTopic(page) {
    await page.locator('dialog[open] button[data-sb-editor-field^="help-nav-"]:not([data-sb-editor-field="help-nav-overview"])').first().focus();
    await pressKey(page, 'Enter');
    await expect(page.locator('dialog[open] .sbHelpPage[data-sb-help-view="section"]')).toBeVisible();
    await settleTransitions(page);
    await page.locator('dialog[open] button[data-sb-editor-field^="help-section-topic-"]').first().focus();
    await pressKey(page, 'Enter');
    await expect(page.locator('dialog[open] .sbHelpPage[data-sb-help-view="topic"]')).toBeVisible();
    await settleTransitions(page);
}

/** The pages of About open from its main page, so a state that follows another page goes back first. */
async function backToAbout(page) {
    const title = shown(page).locator('.sb-dialog__title');
    if ((await title.innerText()) === 'About SillyBunny') return;
    await pressKey(page, 'Escape');
    await expect(title).toHaveText('About SillyBunny');
    await settleTransitions(page);
}

async function pushAboutPage(page, context, rowField, title) {
    await backToAbout(page);
    const row = page.locator(`dialog[open] [data-sb-editor-field="${rowField}"]`);
    await row.focus();
    await markFocusedControl(page, context);
    await pressKey(page, 'Enter');
    await expect(shown(page).locator('.sb-dialog__title')).toHaveText(title);
    await settleTransitions(page);
}

const pushTroubleshooting = (page, context) => pushAboutPage(page, context, 'about-troubleshooting-row', 'Troubleshooting');
const pushCredits = (page, context) => pushAboutPage(page, context, 'about-credits', 'Credits');

const welcomeNext = page => shown(page).getByRole('button', { name: 'Next', exact: true });

/** Next on the first page pushes the persona page; a first run keeps Next off until the name is typed. */
async function pushWelcomePersona(page, context) {
    await welcomeNext(page).focus();
    await markFocusedControl(page, context);
    await pressKey(page, 'Enter');
    await expect(shown(page).locator('.sb-dialog__title')).toHaveText('Your Persona');
    await settleTransitions(page);
}

async function typeFirstRunName(page) {
    const name = shown(page).getByRole('textbox', { name: 'Your Name' });
    await name.fill('Test User');
    await expect(welcomeNext(page)).toBeEnabled();
}

/** From the persona page to What's Next. A first run needs its name first, which the page asks for. */
async function pushWhatsNext(page, context) {
    if (context.firstRun) await typeFirstRunName(page);
    await welcomeNext(page).focus();
    await markFocusedControl(page, context);
    await pressKey(page, 'Enter');
    await expect(shown(page).locator('.sb-dialog__title')).toHaveText('What’s Next');
    await settleTransitions(page);
}

// --- Surfaces -------------------------------------------------------------------------------------------

/**
 * One entry per surface.
 *  - `rootSelector` holds the focus (a modal) or is the surface (a panel); `frameSelector` is the box with the border.
 *  - `open` returns the element that should hold the focus once the surface closes.
 *  - `escapes` has one entry per Escape press: `closes`, the `focus` the press leaves, and a `check` on the result.
 *  - `isOpen` finds what must be gone after the last press.
 *  - `states` are the views the forced-colours and 200% checks visit, in order. `enter` moves from the previous one.
 */
export const SURFACES = [
    {
        id: 'popup-alert',
        structure: { name: 'Delete this prompt?', role: 'alertdialog' },
        title: 'Popup Alert (destructive confirm)',
        viewports: [DESKTOP, PHONE],
        modal: true,
        rootSelector: 'dialog[open]',
        frameSelector: 'dialog[open].sb-dialog',
        isOpen: page => page.locator('dialog[open]:not([closing])'),
        boot: bootMiscWithChat,
        // The Popup destructive confirms sit behind data-dependent triggers (prompts, backups, attachments), so
        // the test calls Popup with the option set those callers pass.
        async open(page) {
            const opener = page.locator('#send_textarea');
            await opener.focus();
            await page.evaluate(async () => {
                const { Popup, POPUP_RESULT } = await import('/scripts/popup.js');
                window.sbA11yResult = undefined;
                Popup.show.confirm('Delete this prompt?', 'This cannot be undone.', {
                    okButton: 'Delete',
                    defaultResult: POPUP_RESULT.NEGATIVE,
                    onBeforePaint: popup => popup.okButton.classList.add('is-destructive'),
                }).then(result => { window.sbA11yResult = result; });
            });
            await waitForSurface(page, page.locator('dialog.popup[open]'));
            return opener;
        },
        cancel: page => page.locator('dialog.popup[open] .popup-button-cancel'),
        async wasConfirmed(page) {
            return (await page.evaluate(() => window.sbA11yResult)) === 1;
        },
        escapes: [{ closes: true, async check(page) {
            await expect.poll(() => page.evaluate(() => window.sbA11yResult)).not.toBeUndefined();
            expect(await page.evaluate(() => window.sbA11yResult)).not.toBe(1);
        } }],
        states: [{ name: 'alert', async enter() {} }],
    },
    {
        id: 'open-alert',
        structure: { name: 'Clear cookies & cache?', role: 'alertdialog' },
        title: 'openAlert (destructive confirm)',
        viewports: [DESKTOP, PHONE],
        modal: true,
        rootSelector: 'dialog[open]',
        frameSelector: 'dialog[open] .sb-dialog',
        isOpen: page => page.locator('dialog[open]:not([closing])'),
        boot: bootMisc,
        // The Data & Security tab opens through the shell, which has no keyboard path to a tab from here.
        async open(page) {
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            const opener = page.locator('#clear_cookies_cache_button');
            await expect(opener).toBeVisible();
            // The button listens only after the tab binds it.
            await page.waitForFunction(() => document.getElementById('clear_cookies_cache_button')?.dataset.sbCookiesCacheBound === 'true');
            await opener.focus();
            await pressKey(page, 'Enter');
            await waitForSurface(page, page.getByRole('alertdialog'));
            return opener;
        },
        cancel: page => page.locator('dialog[open] [data-response="cancel"]'),
        async wasConfirmed(page, context) {
            return context.destructiveRequests.length > 0;
        },
        escapes: [{ closes: true, async check(page, context) {
            expect(context.destructiveRequests).toEqual([]);
        } }],
        states: [{ name: 'alert', async enter() {} }],
    },
    {
        id: 'popup-dialog',
        structure: { name: 'Change Password' },
        title: 'Popup Dialog (form) over its parent',
        viewports: [DESKTOP, PHONE],
        modal: true,
        rootSelector: 'dialog[open]',
        frameSelector: 'dialog[open] .sb-dialog, dialog[open].sb-dialog',
        isOpen: page => page.locator('dialog[open]:not([closing])'),
        boot: bootMisc,
        // Account Info is a Popup Dialog and Change Password is a form Popup shown over it. The settings tab
        // opens through the shell, which has no keyboard path to a tab from here.
        async open(page) {
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            const accountButton = page.locator('#account_button');
            await expect(accountButton).toBeVisible();
            await accountButton.focus();
            await pressKey(page, 'Enter');
            const changePassword = page.locator('dialog[open] .userChangePasswordButton');
            await waitForSurface(page, changePassword);
            await changePassword.focus();
            await pressKey(page, 'Enter');
            await waitForSurface(page, page.locator('dialog[open] input[name="confirm"]'));
            return accountButton;
        },
        escapes: [
            { focus: page => page.locator('dialog[open] .userChangePasswordButton'), async check(page) {
                await expect(page.locator('dialog[open] input[name="confirm"]')).toHaveCount(0);
                await expect(page.locator('dialog[open] .userResetAllButton')).toBeVisible();
            } },
            { closes: true, async check() {} },
        ],
        states: [{ name: 'form', async enter() {} }],
    },
    {
        id: 'tag-manager',
        structure: { name: 'Tag Management' },
        title: 'Window with a pushed page (Tag Manager)',
        viewports: [DESKTOP, PHONE],
        modal: true,
        rootSelector: 'dialog[open]',
        frameSelector: 'dialog[open] .sb-dialog',
        isOpen: page => page.locator('dialog[open]:not([closing])'),
        async boot(page, baseURL, viewport, options) {
            const context = await bootMisc(page, baseURL, viewport, options);
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
            await prepareTags(page);
            return context;
        },
        // The character list opens through the shell. The menu, its item and the tag row are pressed from the keyboard.
        async open(page) {
            await openCharacterList(page);
            const opener = await openCharacterListMenu(page);
            const item = page.getByRole('menuitem', { name: 'Manage tags', exact: true });
            await expect(item).toBeVisible();
            await item.focus();
            await pressKey(page, 'Enter');
            await waitForSurface(page, page.locator('#tag_view_list'));
            return opener;
        },
        escapes: [
            { focus: page => tagRow(page), async check(page) {
                await expect(page.locator('#tag_view_list .sb-tag-manager__members')).toBeHidden();
            } },
            { closes: true, async check() {} },
        ],
        pushPage: pushTagMembersPage,
        states: [
            { name: 'list', async enter() {} },
            { name: 'member page', title: 'QA Alpha', enter: pushTagMembersPage },
        ],
    },
    {
        id: 'menu-sheet',
        title: 'Action-menu sheet',
        viewports: [PHONE],
        modal: true,
        rootSelector: '.sb-action-sheet',
        frameSelector: '.sb-action-sheet',
        isOpen: page => page.locator(OPEN_ACTION_SHEET),
        boot: bootMisc,
        async open(page) {
            await openCharacterList(page);
            const opener = await openCharacterListMenu(page);
            await waitForSurface(page, page.locator(OPEN_ACTION_SHEET));
            return opener;
        },
        escapes: [{ closes: true, async check() {} }],
        states: [{ name: 'sheet', async enter() {} }],
    },
    {
        id: 'side-panel',
        title: 'Side panel (Author\'s Note)',
        viewports: [DESKTOP, PHONE],
        modal: false,
        rootSelector: PANEL_SELECTOR,
        frameSelector: PANEL_SELECTOR,
        isOpen: page => page.locator(`${PANEL_SELECTOR}:visible`),
        boot: bootMiscWithChat,
        // The Options menu items sit far from the menu button in tab order, so the item takes focus directly.
        async open(page) {
            await page.evaluate(value => document.documentElement.style.setProperty('--sheldWidth', value), '55vw');
            const menuButton = page.locator('#options_button');
            await menuButton.focus();
            await pressKey(page, 'Enter');
            const opener = page.locator('#option_toggle_AN');
            await expect(opener).toBeVisible();
            await opener.focus();
            await pressKey(page, 'Enter');
            await expect(sidePanel(page)).toBeVisible();
            await settleTransitions(page);
            // The menu item is hidden once its menu closes, so focus returns to the menu button that opened it.
            return menuButton;
        },
        escapes: [{ closes: true, async check() {} }],
        states: [{ name: 'panel', async enter() {} }],
    },
    {
        id: 'chat-archive',
        structure: { name: 'Chat Archive' },
        title: 'Chat Archive',
        viewports: [DESKTOP, PHONE],
        modal: true,
        rootSelector: 'dialog[open]',
        frameSelector: '.sbca-dialog',
        isOpen: page => page.locator('dialog[open]:not([closing])'),
        boot: bootArchiveApp,
        // The character list opens through the shell, then the archive button is pressed from the keyboard.
        async open(page) {
            await showCharacterList(page);
            const opener = drawerButton(page);
            await opener.focus();
            await pressKey(page, 'Enter');
            await archiveDialog(page).waitFor();
            await waitForSettled(page);
            await expect(page.locator('.sbca-location').or(rows(page)).first()).toBeVisible();
            return opener;
        },
        escapes: [{ closes: true, async check() {} }],
        states: [
            { name: 'sidebar', async enter() {} },
            // A phone shows the list as a page of its own, so the window takes that page's name.
            { name: 'list', title: (page, viewport) => viewport.width < 600 ? 'All Chats' : 'Chat Archive', async enter(page) { await openArchiveList(page); } },
            {
                name: 'selection',
                title: '1 selected',
                async enter(page) {
                    await openMenuItem(page, 'Select Chats');
                    await rows(page).first().click();
                    await expect(page.locator('.sbca-row .sb-selection-check:checked')).toHaveCount(1);
                    await settleTransitions(page);
                },
            },
            {
                name: 'detail',
                title: 'Alice - First chat',
                async enter(page) {
                    await pressKey(page, 'Escape');
                    await expect(page.locator('.sbca-row .sb-selection-check')).toHaveCount(0);
                    await rows(page).first().focus();
                    await pressKey(page, 'Enter');
                    await waitForDetail(page);
                    await settleTransitions(page);
                },
            },
        ],
    },
];

// --- The windows that Home opens ------------------------------------------------------------------------
// Each is reached the way a keyboard user reaches it: a tile or a main menu item, pressed with Enter. Home is on screen,
// and the opener is the control that the window must give the focus back to.

const HOME_WINDOW = {
    viewports: [DESKTOP, PHONE],
    modal: true,
    rootSelector: 'dialog[open]',
    frameSelector: 'dialog[open] .sb-dialog, dialog[open].sb-dialog',
    isOpen: page => page.locator(OPEN_DIALOG),
    boot: bootHome,
};

const stayOnFirstPage = {
    // Escape on the first page does nothing, so the window stays and the focus stays where it was.
    stays: true,
    focus: (page, context) => context.returnFocus,
    async check(page) {
        await expect(page.locator(OPEN_DIALOG)).toHaveCount(1);
        await expect(shown(page).locator('.sb-dialog__title')).toHaveText('Welcome');
    },
};

const popToFirstWelcomePage = {
    focus: (page, context) => context.returnFocus,
    async check(page) {
        await expect(shown(page).locator('.sb-dialog__title')).toHaveText('Welcome');
    },
};

const welcomeStates = [
    { name: 'hello', title: 'Welcome', async enter() {} },
    { name: 'persona', title: 'Your Persona', enter: pushWelcomePersona },
    { name: 'whats-next', title: 'What’s Next', enter: pushWhatsNext },
];

SURFACES.push(
    {
        ...HOME_WINDOW,
        id: 'help',
        title: 'Help window (a topic page, Keyboard Shortcuts pushed over it)',
        structure: { name: 'Help' },
        open: page => openFromTile(page, 'help'),
        pushPage: pushShortcutsOverHelp,
        escapes: [
            { focus: (page, context) => context.returnFocus, async check(page) {
                await expect(page.locator(`${OPEN_DIALOG} .sbShortcutsDialog`)).toBeHidden();
                await expect(page.locator(`${OPEN_DIALOG} .sbHelpDialog`)).toBeVisible();
            } },
            { closes: true, async check() {} },
        ],
        states: [
            { name: 'overview', title: 'Help', async enter() {} },
            // Help lists a topic beside its sections on a desktop, so the window keeps its name. A phone pushes the topic as a page.
            { name: 'topic', enter: page => openFirstTopic(page), title: (page, viewport) => viewport.width < 600 ? shown(page).locator('.sb-dialog__title').innerText() : 'Help' },
            { name: 'shortcuts page', title: 'Keyboard Shortcuts', enter: pushShortcutsOverHelp },
        ],
    },
    {
        ...HOME_WINDOW,
        id: 'about',
        title: 'About window (Troubleshooting pushed)',
        structure: { name: 'About SillyBunny' },
        open: page => openFromMenu(page, 'About SillyBunny'),
        pushPage: pushTroubleshooting,
        escapes: [
            { focus: (page, context) => context.returnFocus, async check(page) {
                await expect(page.locator('dialog[open] textarea.sbDebugInfo')).toHaveCount(0);
            } },
            { closes: true, async check() {} },
        ],
        states: [
            { name: 'about', title: 'About SillyBunny', async enter() {} },
            { name: 'credits', title: 'Credits', enter: pushCredits },
            { name: 'troubleshooting', title: 'Troubleshooting', enter: pushTroubleshooting },
        ],
    },
    {
        ...HOME_WINDOW,
        id: 'shortcuts',
        title: 'Keyboard Shortcuts window',
        structure: { name: 'Keyboard Shortcuts' },
        open: page => openFromMenu(page, 'Keyboard Shortcuts'),
        escapes: [{ closes: true, async check() {} }],
        states: [{ name: 'shortcuts', title: 'Keyboard Shortcuts', async enter() {} }],
    },
    {
        ...HOME_WINDOW,
        id: 'welcome-reopen',
        title: 'Welcome (reopened from the main menu)',
        structure: { name: 'Welcome' },
        open: page => openFromMenu(page, 'Show Welcome'),
        pushPage: pushWelcomePersona,
        escapes: [
            popToFirstWelcomePage,
            stayOnFirstPage,
            // The reopened dialog has a Close button on its first page, and it is the only way out of that page.
            { closes: true, async act(page) {
                const close = shown(page).getByRole('button', { name: 'Close', exact: true });
                await close.focus();
                await pressKey(page, 'Enter');
            }, async check() {} },
        ],
        states: welcomeStates,
    },
    {
        ...HOME_WINDOW,
        id: 'welcome-first-run',
        title: 'Welcome (first run)',
        boot: bootHomeFirstRun,
        structure: { name: 'Welcome' },
        // The dialog is on the page at boot, so there is no control that opened it, and the focus ends in the document.
        async open(page) {
            await waitForSurface(page, page.locator(OPEN_DIALOG));
            return page.locator('body');
        },
        pushPage: pushWelcomePersona,
        escapes: [
            popToFirstWelcomePage,
            stayOnFirstPage,
            // A first run ends only once the persona has a name, and it ends on Start of the last page.
            { closes: true, async act(page, context) {
                await pushWelcomePersona(page, context);
                await pushWhatsNext(page, context);
                const start = shown(page).getByRole('button', { name: 'Start', exact: true });
                await start.focus();
                await pressKey(page, 'Enter');
            }, async check() {} },
        ],
        states: welcomeStates,
    },
    {
        ...HOME_WINDOW,
        id: 'getting-started',
        title: 'Getting Started window',
        structure: { name: 'Getting Started' },
        open: page => openFromTile(page, 'getting-started'),
        escapes: [{ closes: true, async check() {} }],
        states: [{ name: 'steps', title: 'Getting Started', async enter() {} }],
    },
    {
        ...HOME_WINDOW,
        id: 'bundled-extras',
        title: 'Bundled Extras window',
        structure: { name: 'Bundled Extras' },
        open: page => openFromTile(page, 'extras'),
        escapes: [{ closes: true, async check() {} }],
        states: [{ name: 'extras', title: 'Bundled Extras', async enter() {} }],
    },
    {
        ...HOME_WINDOW,
        id: 'assistant-picker',
        title: 'Choose Assistant window (opened from the Choose Assistant card)',
        boot: bootHomeWithAssistants(null),
        structure: { name: 'Choose Assistant' },
        open: openPickerFromChooseCard,
        escapes: [{ closes: true, async check() {} }],
        states: [{ name: 'characters', title: 'Choose Assistant', async enter() {} }],
    },
    {
        ...HOME_WINDOW,
        id: 'assistant-picker-from-menu',
        title: 'Choose Assistant window (opened from Choose Another Assistant in the menu of the chosen card)',
        boot: bootHomeWithAssistants('Alice.png'),
        structure: { name: 'Choose Assistant' },
        open: openPickerFromCardMenu,
        escapes: [{ closes: true, async check() {} }],
        states: [{ name: 'characters', title: 'Choose Assistant', async enter() {} }],
    },
    {
        ...HOME_WINDOW,
        id: 'managed-update-alert',
        title: 'Update Available alert (opened from the menu of an edited assistant card)',
        boot: bootHomeWithEditedReisen,
        structure: { name: 'Update Reisen?', role: 'alertdialog' },
        frameSelector: 'dialog[open] .sb-dialog',
        open: openUpdateQuestionFromCardMenu,
        // The tab order is the two answers, so Escape is the way out that neither updates nor keeps.
        escapes: [{ closes: true, async check() {} }],
        states: [{ name: 'alert', async enter() {} }],
    },
    {
        id: 'assistant-menu-sheet',
        title: 'Assistant menu sheet (the chosen assistant card)',
        viewports: [PHONE],
        modal: true,
        rootSelector: '.sb-action-sheet',
        frameSelector: '.sb-action-sheet',
        isOpen: page => page.locator(OPEN_ACTION_SHEET),
        boot: bootHomeWithAssistants('Alice.png'),
        async open(page) {
            const opener = assistantMenuButton(page);
            await opener.focus();
            await pressKey(page, 'Enter');
            await waitForSurface(page, page.locator(OPEN_ACTION_SHEET));
            return opener;
        },
        escapes: [{ closes: true, async check() {} }],
        states: [{ name: 'sheet', async enter() {} }],
    },
);
