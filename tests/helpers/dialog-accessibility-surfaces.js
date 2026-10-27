/*
 * Surfaces and boot helpers for the dialog accessibility spec. They live here, not in the spec, so the
 * spec holds only the checks. Where a step before a trigger is programmatic, the surface says why.
 */

import { expect } from '@playwright/test';
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
import { bootMiscDialogs } from './misc-dialogs.js';

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

/** The intercepted settings for a boot. `motion` turns animations on; `fontScale` is the app's own text scale. */
async function prepareBoot(page, baseURL, { motion = false, fontScale = 1 } = {}) {
    await guardWrites(page, baseURL);
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
        title: 'Popup Alert (destructive confirm)',
        viewports: [DESKTOP, PHONE],
        modal: true,
        rootSelector: 'dialog[open]',
        frameSelector: 'dialog[open].sb-dialog',
        isOpen: page => page.locator('dialog[open]:not([closing])'),
        boot: bootMisc,
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
                    onOpen: popup => popup.okButton.classList.add('is-destructive'),
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
        title: 'openAlert (destructive confirm)',
        viewports: [DESKTOP, PHONE],
        modal: true,
        rootSelector: 'dialog[open]',
        frameSelector: 'dialog[open] .sb-dialog',
        isOpen: page => page.locator('dialog[open]:not([closing])'),
        boot: bootMisc,
        // The Data & Security tab opens through the shell. The trigger is a real button, so Space presses it.
        async open(page) {
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            const opener = page.locator('#clear_cookies_cache_button');
            await expect(opener).toBeVisible();
            // The button listens only after the tab binds it.
            await page.waitForFunction(() => document.getElementById('clear_cookies_cache_button')?.dataset.sbCookiesCacheBound === 'true');
            await opener.focus();
            await page.keyboard.press('Space');
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
        title: 'Popup Dialog (form) over its parent',
        viewports: [DESKTOP, PHONE],
        modal: true,
        rootSelector: 'dialog[open]',
        frameSelector: 'dialog[open] .sb-dialog, dialog[open].sb-dialog',
        isOpen: page => page.locator('dialog[open]:not([closing])'),
        boot: bootMisc,
        // Account Info is a Popup Dialog and Change Password is a form Popup shown over it. The settings tab
        // opens through the shell, and Change Password is a real button, so Space presses it.
        async open(page) {
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            const accountButton = page.locator('#account_button');
            await expect(accountButton).toBeVisible();
            await accountButton.focus();
            await pressKey(page, 'Enter');
            const changePassword = page.locator('dialog[open] .userChangePasswordButton');
            await waitForSurface(page, changePassword);
            await changePassword.focus();
            await page.keyboard.press('Space');
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
            { name: 'member page', enter: pushTagMembersPage },
        ],
    },
    {
        id: 'menu-sheet',
        title: 'Action-menu sheet',
        viewports: [PHONE],
        modal: true,
        rootSelector: '.sb-action-sheet',
        frameSelector: '.sb-action-sheet',
        isOpen: page => page.locator('.sb-action-sheet:visible'),
        boot: bootMisc,
        async open(page) {
            await openCharacterList(page);
            const opener = await openCharacterListMenu(page);
            await waitForSurface(page, page.locator('.sb-action-sheet'));
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
        boot: bootMisc,
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
            return opener;
        },
        escapes: [{ closes: true, async check() {} }],
        states: [{ name: 'panel', async enter() {} }],
    },
    {
        id: 'chat-archive',
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
            { name: 'list', async enter(page) { await openArchiveList(page); } },
            {
                name: 'selection',
                async enter(page) {
                    await openMenuItem(page, 'Select Chats');
                    await rows(page).first().click();
                    await expect(page.locator('.sbca-row .sb-selection-check:checked')).toHaveCount(1);
                    await settleTransitions(page);
                },
            },
            {
                name: 'detail',
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
