/**
 * The header family: the bars that sit at the top of a surface. Each entry's `root` is the header element itself, not the
 * surface under it, so that the tools measure and scan the bar and nothing else.
 *
 * The top bar has two modes (labels, and icons only), and each mode has a state with a character whose name is long,
 * because the title is the element that truncates. Both modes show the title.
 */

import { showSettingsSidebar } from '../settings-phone-pane.js';
import { seedConversation } from '../conversation-seed.js';
import { FIXTURES } from './fixture-data.js';
import {
    AGENTS, LONG_TITLE, discardEdits, enterAgentSelection, enterCharacterSelection, enterWorldInfoSelection, gone, leaveSelection,
    makeDirty, openAgentDetail, openAgentList, openCharacterCreate, openCharacterEditor, openCharacterList, openGlobalSettingsPane,
    openGroupEditor, openPersonaDetail, openPersonaList, openPromptDetail, openPromptList, openWorldInfoBook, openWorldInfoEntry, shown,
} from './header-steps.js';
import {
    MOBILE_LAYOUT_VIEWPORTS, PROPERTY_SHEETS, WIDE_LAYOUT_VIEWPORTS, closeBottomChatSheet, closePropertySheet,
    closeSidePanelById, openBottomChatSheet, openPropertySheet, openSidePanelById,
} from './panel-steps.js';
import { chooseMenuItem, openSettingsTab, settle } from './steps.js';

const SCRIPTS = 'public/scripts';
const CSS = 'public/css';

/** Matches an element by its text, which is how a title that is not an input is told from another one. */
const withText = (selector, text) => `${selector}:has-text(${JSON.stringify(text)})`;

/** Selects a character of the server, as the character list does, and returns once the top bar names it. */
async function selectCharacter(page, { avatar, name }) {
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const index = context.characters.findIndex(character => character.avatar === avatar);
        if (index < 0) {
            throw new Error(`The audit character ${avatar} is not on the server.`);
        }
        await context.selectCharacterById(index, { switchMenu: false });
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    }, avatar);
    await page.waitForFunction(name => document.getElementById('sb-topbar-title')?.textContent === name, name);
    await settle(page);
}

/** Closes the open chat, which returns the app to Home. */
async function showHome(page) {
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        if (context.groupId || (context.characterId !== undefined && context.characterId !== null)) {
            await context.closeCurrentChat();
        }
    });
    await page.waitForFunction(() => document.getElementById('sb-topbar-title')?.textContent === 'Home');
}

// ---------------------------------------------------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Shows Home with the top bar in one of its two modes, with its search closed. Only the desktop bar has an icons-only
 * mode: the phone bar has no labels, so the phone reads no icons-only value. The top bar cannot be closed, so this step
 * is also the reset: it puts back what the other mode and the states changed.
 */
async function openTopBar(page, { iconsOnly }) {
    await showHome(page);
    await page.evaluate(iconsOnly => {
        window.SillyBunnyShell.setTopbarIconsOnly('desktop', iconsOnly);
        if (document.getElementById('sb-topbar-search-row')?.classList.contains('is-open')) {
            document.getElementById('sb-topbar-search-toggle').click();
        }
    }, iconsOnly);
    await page.waitForFunction(value => document.documentElement.dataset.sbTopbarIconsOnly === value, String(iconsOnly));
    await shown(page, '#top-bar #sb-topbar-inner');
    await settle(page);
}

function topBar({ id, title, iconsOnly, viewports }) {
    const long = FIXTURES['characters-many'].characters[2];
    const { name } = long;
    return {
        id: `header.topbar.${id}`,
        family: 'header',
        owner: 'A',
        title,
        root: '#top-bar',
        ...(viewports ? { viewports } : {}),
        // The top bar is there before `open` runs. Both modes show the page title and the Backend button, so `open` waits for the mode itself.
        ready: [withText('#top-bar #sb-topbar-title', 'Home'), '#top-bar #sb-left-shell-toggle'],
        open: page => openTopBar(page, { iconsOnly }),
        states: [
            {
                id: 'long-title',
                // The title names the open chat in both modes: it is truncated by its own ellipsis, so its text is still the whole name.
                ready: withText('#top-bar #sb-topbar-title', name),
                async open(page) {
                    await selectCharacter(page, long);
                },
            },
            {
                id: 'search-open',
                ready: '#sb-topbar-search-row.is-open .sb-universal-search-field',
                async open(page) {
                    await page.locator('#sb-topbar-search-toggle').click();
                    await page.locator('#sb-topbar-search-row.is-open').waitFor({ state: 'visible' });
                    await settle(page);
                },
            },
        ],
        needs: ['characters-many'],
        sources: [`${SCRIPTS}/sillybunny-tabs.js`, `${CSS}/sillybunny-tabs.css`, `${CSS}/sillybunny-mobile-shell.css`],
        primaryFlow: true,
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------------------------------------------------

const SETTINGS_PAGE = '#sb-settings-page';
const EXTENSIONS_PANEL = '[data-sb-panel="extensions"]';

async function openSettingsPage(page) {
    await openSettingsTab(page, { shell: 'right', tab: 'appearance' });
    await shown(page, '#sb-settings-content-header');
}

async function closeSettingsPage(page) {
    // The Close button sits in the page, which is off screen and inert while a phone shows the sidebar; Escape closes from there.
    if (await page.locator('#sb-settings-content[inert]').count() > 0) {
        await page.keyboard.press('Escape');
    } else {
        await page.locator('#sb-settings-close').click();
    }
    await gone(page, SETTINGS_PAGE);
}

/** On a phone the sidebar is a page of its own, which the content header's Back button returns to. */
async function openSettingsSidebar(page) {
    await openSettingsPage(page);
    await showSettingsSidebar(page);
    await shown(page, '#sb-settings-sidebar-header');
    await settle(page);
}

// ---------------------------------------------------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------------------------------------------------

/** Opens the Conversation workspace for the audit character, or for the audit group, with its thread saved on the device. */
async function openConversation(page, { group = false } = {}) {
    const day = Date.UTC(2026, 0, 1, 12, 0, 0);
    const solo = FIXTURES.chat.messages.map((text, number) => ({
        id: `audit-${number}`, role: number % 2 === 0 ? 'character' : 'user', name: number % 2 === 0 ? FIXTURES.character.name : 'Audit User',
        mes: text, send_date: new Date(day + number * 60_000).toISOString(), created_at: day + number * 60_000, extra: {},
    }));
    // The other members of the group answer as members of the conversation, next to the first one.
    const names = new Map([[FIXTURES.character.avatar, FIXTURES.character.name], ...FIXTURES['characters-many'].characters.map(entry => [entry.avatar, entry.name])]);
    const grouped = FIXTURES['group-chat'].turns.map((turn, number) => ({
        id: `audit-group-${number}`, role: !turn.speaker ? 'user' : turn.speaker === FIXTURES.character.avatar ? 'character' : 'member',
        name: turn.speaker ? names.get(turn.speaker) : FIXTURES['group-chat'].userName, mes: turn.text,
        send_date: new Date(day + number * 60_000).toISOString(), created_at: day + number * 60_000,
        extra: turn.speaker && turn.speaker !== FIXTURES.character.avatar ? { member_avatar: turn.speaker, original_avatar: turn.speaker } : {},
    }));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace')));
    await page.evaluate(async (avatar) => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const index = context.characters.findIndex(character => character.avatar === avatar);
        if (index < 0) {
            throw new Error(`The audit character ${avatar} is not on the server.`);
        }
        await context.selectCharacterById(index, { switchMenu: false });
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    }, FIXTURES.character.avatar);
    // The audit group is a group conversation of the audit character and the other members of the group of the same name.
    const members = group ? FIXTURES.group.members.filter(avatar => avatar !== FIXTURES.character.avatar) : [];
    const { conversationId } = await seedConversation(page, { avatar: FIXTURES.character.avatar, members, name: group ? FIXTURES.group.name : '', chats: [{ messages: group ? grouped : solo }] });
    await page.evaluate(async ({ avatar, groupId }) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        if (!await openConversationWorkspaceForAvatar(avatar, { showToast: false, enable: true, groupId })) {
            throw new Error(`Could not open the Conversation workspace for ${avatar}.`);
        }
    }, { avatar: FIXTURES.character.avatar, groupId: group ? conversationId : null });
    await page.locator('#sheld[data-sb-conversation-mode="on"]').waitFor({ state: 'visible' });
    await page.locator('#sb_conversation_timeline .sb-conversation-message').first().waitFor({ state: 'visible' });
}

const isConversationPages = page => page.locator('#sheld').getAttribute('data-sb-conversation-layout').then(layout => layout === 'pages');

async function closeConversation(page) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace')));
    await gone(page, '#sheld[data-sb-conversation-mode="on"]');
}

async function openConversationSidebar(page) {
    await openConversation(page);
    if (await isConversationPages(page)) {
        await page.locator('#sb_conversation_list_toggle').click();
        await page.locator('#sheld[data-sb-conversation-page="list"]').waitFor();
    }
    await shown(page, '#sb_conversation_list .sb-conversation-rail-header');
    await settle(page);
}

// ---------------------------------------------------------------------------------------------------------------------
// Editor and list headers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The header of an editor. `dirtyState` types a long title (or, where the title cannot be edited, changes the content) so
 * that the dirty indicator, Cancel and Save are all shown with the longest title; `cancel` is the Cancel button that drops
 * those changes. An editor stays in the page when it is left, so there is no `close`: `open` drops the unsaved changes of
 * an earlier state first.
 */
function editorHeader({ id, title, root, ready, open, cancel, dirtyState, extraStates = [], masks, needs, sources, primaryFlow = false }) {
    return {
        id: `header.editor.${id}`,
        family: 'header',
        owner: 'A',
        title,
        root,
        ready,
        async open(page, ctx) {
            if (dirtyState) {
                await discardEdits(page, { dirty: dirtyState.dirty, cancel });
            }
            await open(page, ctx);
        },
        ...(masks && { masks }),
        // The dirty state is last: a later state would have to leave an editor that has unsaved changes.
        states: [...extraStates, ...(dirtyState ? [{
            id: dirtyState.id ?? 'dirty-long-title',
            // A title that is an input has no text to match, so only the renamed header proves the long title.
            ready: [dirtyState.dirty, ...(dirtyState.title ? [withText(dirtyState.title, LONG_TITLE)] : []), ...(dirtyState.only ? [dirtyState.only] : [])],
            open: page => makeDirty(page, dirtyState),
        }] : [])],
        needs,
        sources,
        ...(primaryFlow && { primaryFlow }),
    };
}

/** A list header: the title row of a list pane, with its actions. `selectionCancel` leaves the selection mode that a state turned on. */
function listHeader({ id, title, root, ready, open, selectionCancel, states = [], needs, sources, primaryFlow = false }) {
    return {
        id: `header.list.${id}`,
        family: 'header',
        owner: 'A',
        title,
        root,
        ready,
        async open(page, ctx) {
            if (selectionCancel) {
                await leaveSelection(page, selectionCancel);
            }
            await open(page, ctx);
        },
        ...(states.length && { states }),
        needs,
        sources,
        ...(primaryFlow && { primaryFlow }),
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Dialog and Window headers
// ---------------------------------------------------------------------------------------------------------------------

const POPUP = 'dialog.popup[open]';

async function closePopups(page) {
    await page.evaluate(() => {
        for (const dialog of document.querySelectorAll('dialog.popup[open]')) {
            dialog.close();
        }
    });
    await page.locator(POPUP).first().waitFor({ state: 'detached' });
}

/** Shows a Popup in a tier, which is how every Alert, Dialog and Window of the app is framed. `type` is a key of `POPUP_TYPE`. */
async function openPopup(page, options) {
    await closePopups(page);
    await page.evaluate(async ({ type, tier, title, ok, cancel }) => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        void new Popup('<p>The body of the audit dialog.</p>', POPUP_TYPE[type], '', { tier, title, okButton: ok, cancelButton: cancel }).show();
    }, options);
    await shown(page, `${POPUP} .sb-dialog__header`);
    await settle(page, { root: POPUP });
}

/** Opens the Tag Manager window from the character list menu. */
async function openTagManager(page) {
    await openCharacterList(page);
    await chooseMenuItem(page, '.sb-character-list [data-action-id="more"]', 'Manage Tags');
    await shown(page, '#tag_view_list');
    await settle(page, { root: '#tag_view_list' });
}

const ARCHIVE = '.sbca-dialog';
const ARCHIVE_MENU = `${ARCHIVE} .sb-dialog__header:visible .sb-dialog__menu`;

async function closeArchive(page) {
    await page.locator(`${ARCHIVE} .sb-dialog__header:visible .sb-dialog__close`).first().click();
    await gone(page, ARCHIVE);
}

/** Opens the Chats Archive and shows its chat list. */
async function openArchiveList(page) {
    if (await page.locator(ARCHIVE).first().isVisible()) {
        await closeArchive(page);
    }
    await openCharacterList(page);
    await page.locator('#sbca_drawer_button').click();
    await shown(page, ARCHIVE);
    await page.waitForFunction(() => !document.querySelector('.sbca-dialog[opening]'));
    await shown(page, '.sbca-location, .sbca-row');
    if (!await page.locator('.sbca-row').first().isVisible()) {
        await page.locator('.sbca-location').first().click();
    }
    await shown(page, '.sbca-row');
    await settle(page, { root: ARCHIVE });
}

/**
 * The header of the sheet that a list-content editor opens for its properties once it has collapsed its property bar. The
 * root is the header bar, not the sheet, so the sheet's own sizes and steps are the ones in `PROPERTY_SHEETS`.
 */
function propertySheetHeader({ id, title, editor, header, heading = `${header} .sb-dialog__title`, closeButton, needs, sources }) {
    const sheet = PROPERTY_SHEETS[editor];
    return {
        id: `header.sheet.${id}`,
        family: 'header',
        owner: 'A',
        title,
        root: header,
        ready: [heading, closeButton],
        overlay: true,
        open: page => openPropertySheet(page, sheet),
        close: page => closePropertySheet(page, sheet),
        viewports: sheet.viewports,
        needs,
        sources,
    };
}

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    topBar({ id: 'labelled', title: 'Top bar with labels', iconsOnly: false }),
    topBar({ id: 'icons-only', title: 'Top bar, icons only', iconsOnly: true, viewports: WIDE_LAYOUT_VIEWPORTS }),
    {
        id: 'header.settings.content',
        family: 'header',
        owner: 'A',
        title: 'Settings page: content header',
        root: '#sb-settings-content-header',
        ready: ['#sb-settings-content-title:not(:empty)', '#sb-settings-close'],
        open: openSettingsPage,
        close: closeSettingsPage,
        needs: [],
        sources: ['public/index.html', `${SCRIPTS}/sillybunny-tabs.js`, `${CSS}/sillybunny-tabs.css`],
        primaryFlow: true,
    },
    {
        id: 'header.settings.sidebar',
        family: 'header',
        owner: 'A',
        title: 'Settings page: sidebar header',
        root: '#sb-settings-sidebar-header',
        ready: ['#sb-settings-sidebar-title:not(:empty)', '#sb-settings-search-toggle'],
        open: openSettingsSidebar,
        close: closeSettingsPage,
        states: [{
            id: 'search-open',
            root: '#sb-settings-sidebar',
            ready: '#sb-settings-search-input',
            async open(page) {
                await page.locator('#sb-settings-search-toggle').click();
                await page.locator('#sb-settings-search-row[aria-hidden="false"]').waitFor({ state: 'visible' });
                await settle(page);
            },
        }],
        needs: [],
        sources: ['public/index.html', `${SCRIPTS}/sillybunny-tabs.js`, `${CSS}/sillybunny-tabs.css`],
        primaryFlow: true,
    },
    {
        id: 'header.settings.subpage',
        family: 'header',
        owner: 'A',
        title: 'Settings page: subpage detail bar (Extensions)',
        root: `${EXTENSIONS_PANEL} .sb-subpage-detail[aria-hidden="false"] .sb-subpage-detail-bar`,
        ready: `${EXTENSIONS_PANEL} .sb-subpage-detail[aria-hidden="false"] .sb-subpage-detail-title:not(:empty)`,
        async open(page) {
            await openSettingsTab(page, { shell: 'right', tab: 'extensions' });
            await page.locator(`${EXTENSIONS_PANEL} .sb-subpage-row:visible`).first().click();
            await shown(page, `${EXTENSIONS_PANEL} .sb-subpage-detail[aria-hidden="false"]`);
            await settle(page);
        },
        close: closeSettingsPage,
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-settings-subpage.js`, `${SCRIPTS}/sillybunny-settings-subpage-descriptors.js`, `${CSS}/sillybunny-tabs.css`],
    },
    {
        id: 'header.conversation.content',
        family: 'header',
        owner: 'A',
        title: 'Conversation: content header',
        root: '#sb_conversation_header',
        ready: withText('#sb_conversation_header [data-sb-conversation-name]', FIXTURES.character.name),
        async open(page) {
            await openConversation(page);
            await shown(page, '#sb_conversation_header');
            await settle(page);
        },
        close: closeConversation,
        masks: ['#sb_conversation_header .sb-conversation-header-status'],
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-conversation/chrome.js`, `${CSS}/sillybunny-conversation.css`],
        primaryFlow: true,
    },
    {
        id: 'header.conversation.group',
        family: 'header',
        owner: 'A',
        title: 'Conversation: content header of a group conversation',
        root: '#sb_conversation_header',
        // The header names a group as the list does: by the name that it was given, which a direct conversation has not.
        ready: withText('#sb_conversation_header [data-sb-conversation-name]', FIXTURES.group.name),
        async open(page) {
            await openConversation(page, { group: true });
            await shown(page, '#sb_conversation_header');
            await settle(page);
        },
        close: closeConversation,
        masks: ['#sb_conversation_header .sb-conversation-header-status'],
        needs: ['character', 'group', 'group-chat'],
        sources: [`${SCRIPTS}/sillybunny-conversation/chrome.js`, `${SCRIPTS}/sillybunny-conversation/interface.js`, `${CSS}/sillybunny-conversation.css`],
    },
    {
        id: 'header.conversation.sidebar',
        family: 'header',
        owner: 'A',
        title: 'Conversation: sidebar header',
        root: '#sb_conversation_list .sb-conversation-rail-header',
        ready: ['#sb_conversation_list .sb-conversation-rail-new-button', '#sb_conversation_list .sb-conversation-rail-main-menu-button'],
        open: openConversationSidebar,
        close: closeConversation,
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-conversation/timeline-render.js`, `${CSS}/sillybunny-conversation.css`],
    },
    {
        id: 'header.side-panel.authors-note',
        family: 'header',
        owner: 'A',
        title: 'Side panel header (Author\'s Note)',
        root: '.sb-side-panel[data-sb-side-panel-id="floatingPrompt"] .sb-side-panel__header',
        ready: ['.sb-side-panel[data-sb-side-panel-id="floatingPrompt"] .sb-side-panel__title', '.sb-side-panel[data-sb-side-panel-id="floatingPrompt"] .sb-side-panel__close'],
        overlay: true,
        open: page => openSidePanelById(page, { id: 'floatingPrompt', trigger: '#option_toggle_AN' }),
        close: page => closeSidePanelById(page, 'floatingPrompt'),
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/sillybunny-editor/side-panel.js`, `${SCRIPTS}/sillybunny-editor/adapters/side-panels.js`, `${CSS}/sillybunny-side-panel.css`],
        primaryFlow: true,
    },
    {
        id: 'header.side-panel.chat-sidebar',
        family: 'header',
        owner: 'A',
        title: 'Side panel header (chat sidebar)',
        root: '.sb-side-panel[data-sb-side-panel-id="sb-chat-sidebar"] .sb-side-panel__header',
        ready: ['.sb-side-panel[data-sb-side-panel-id="sb-chat-sidebar"] .sb-side-panel__title', '.sb-side-panel[data-sb-side-panel-id="sb-chat-sidebar"] .sb-side-panel__close'],
        overlay: true,
        open: page => openSidePanelById(page, { id: 'sb-chat-sidebar' }),
        close: page => closeSidePanelById(page, 'sb-chat-sidebar'),
        viewports: WIDE_LAYOUT_VIEWPORTS,
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/sillybunny-editor/side-panel.js`, `${SCRIPTS}/sillybunny-tabs.js`, `${CSS}/sillybunny-side-panel.css`],
    },
    {
        id: 'header.dialog.bottom-chat-sheet',
        family: 'header',
        owner: 'A',
        title: 'Dialog header (Chat Actions sheet of the bottom chat bar)',
        root: '.sb-bottom-chat-sheet .sb-dialog__header',
        ready: ['.sb-bottom-chat-sheet .sb-dialog__title', '.sb-bottom-chat-sheet-close'],
        overlay: true,
        open: openBottomChatSheet,
        close: closeBottomChatSheet,
        viewports: MOBILE_LAYOUT_VIEWPORTS,
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/sillybunny-mobile-bottom-bar.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`, `${CSS}/sillybunny-tabs.css`],
    },
    {
        id: 'header.dialog.explicit',
        family: 'header',
        owner: 'A',
        title: 'Dialog header with Cancel and an affirmative action',
        root: `${POPUP} .sb-dialog__header`,
        ready: [withText(`${POPUP} .sb-dialog__title`, 'Dialog Title'), `${POPUP} .sb-dialog__header .popup-button-ok`],
        overlay: true,
        open: page => openPopup(page, { type: 'CONFIRM', tier: 'dialog', title: 'Dialog Title', ok: 'Save', cancel: 'Cancel' }),
        close: closePopups,
        states: [{
            id: 'long-title',
            ready: [withText(`${POPUP} .sb-dialog__title`, LONG_TITLE), `${POPUP} .sb-dialog__header .popup-button-ok`],
            open: page => openPopup(page, { type: 'CONFIRM', tier: 'dialog', title: LONG_TITLE, ok: 'Save', cancel: 'Cancel' }),
        }],
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-editor/popup-frame.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`, `${CSS}/sillybunny-theme.css`],
        primaryFlow: true,
    },
    {
        id: 'header.dialog.window-close',
        family: 'header',
        owner: 'A',
        title: 'Window header with Close',
        root: `${POPUP} .sb-dialog__header`,
        ready: [withText(`${POPUP} .sb-dialog__title`, 'Window Title'), `${POPUP} .sb-dialog__header .sb-dialog__close`],
        overlay: true,
        open: page => openPopup(page, { type: 'DISPLAY', tier: 'window', title: 'Window Title' }),
        close: closePopups,
        states: [{
            id: 'long-title',
            ready: [withText(`${POPUP} .sb-dialog__title`, LONG_TITLE), `${POPUP} .sb-dialog__header .sb-dialog__close`],
            open: page => openPopup(page, { type: 'DISPLAY', tier: 'window', title: LONG_TITLE }),
        }],
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-editor/popup-frame.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`, `${CSS}/sillybunny-theme.css`],
    },
    {
        id: 'header.dialog.tag-manager',
        family: 'header',
        owner: 'A',
        title: 'Window header of the Tag Manager (menu, Add, Close)',
        root: '#tag_view_list .sb-dialog__header',
        ready: ['#tag_view_list .sb-dialog__title', '#tag_view_list .sb-dialog__close'],
        overlay: true,
        open: openTagManager,
        async close(page) {
            await page.locator('#tag_view_list .sb-dialog__close').first().click();
            await gone(page, '#tag_view_list');
        },
        needs: ['character', 'tags'],
        sources: [`${SCRIPTS}/sillybunny-tag-manager.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`, `${CSS}/sillybunny-tag-manager.css`],
    },
    {
        id: 'header.dialog.archive',
        family: 'header',
        owner: 'C',
        title: 'Window header of the Chats Archive (search, menu, Close; selection mode)',
        root: `${ARCHIVE} .sb-dialog__header:visible`,
        ready: `${ARCHIVE} .sb-dialog__header:visible .sb-dialog__title`,
        overlay: true,
        open: openArchiveList,
        close: closeArchive,
        states: [
            {
                id: 'search-open',
                ready: `${ARCHIVE} .sb-dialog__search[data-state="open"] .sb-dialog__search-input`,
                async open(page) {
                    // When the archive stacks its panes (a phone), the search is in the header of the page that lists the locations.
                    const toggle = page.locator(`${ARCHIVE} .sb-dialog__header:visible .sb-dialog__search-toggle`).first();
                    if (!await toggle.isVisible()) {
                        await page.locator(`${ARCHIVE} .sb-dialog__header:visible .sb-dialog__back`).first().click();
                        await toggle.waitFor({ state: 'visible' });
                        await settle(page, { root: ARCHIVE });
                    }
                    await toggle.click();
                    await shown(page, `${ARCHIVE} .sb-dialog__search[data-state="open"] .sb-dialog__search-input`);
                    await settle(page, { root: ARCHIVE });
                },
            },
            {
                id: 'selection-mode',
                root: `${ARCHIVE} .sb-dialog__header.is-selection-mode`,
                ready: [`${ARCHIVE} .sb-dialog__header.is-selection-mode .sb-selection-cancel`, `${ARCHIVE} .sb-dialog__header.is-selection-mode .sb-dialog__selection-title`],
                async open(page) {
                    await page.locator(ARCHIVE_MENU).last().click();
                    await page.getByRole('menuitem', { name: 'Select Chats' }).click();
                    await shown(page, `${ARCHIVE} .sb-dialog__header.is-selection-mode`);
                    await settle(page, { root: ARCHIVE });
                },
            },
        ],
        needs: ['character', 'characters-many', 'archived-chats'],
        sources: ['public/scripts/extensions/sillybunny-chats-archive/src/ui/selection.js', `${SCRIPTS}/sillybunny-editor/selection-mode.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`],
    },
    editorHeader({
        id: 'character',
        title: 'Character editor header',
        root: '#sb_character_editor_header',
        ready: withText('#sb_character_editor_title', FIXTURES.character.name),
        open: openCharacterEditor,
        cancel: '#sb_character_editor_cancel',
        // The header is shared with the form of a new character, so the dirty state also names the menu type of an existing one.
        dirtyState: { rename: '#sb_character_editor_title_button', dirty: '#sb_character_editor_dirty:not([hidden])', title: '#sb_character_editor_title', only: '#right-nav-panel[data-menu-type="character_edit"]' },
        // The title of the top bar names the open chat once that chat has loaded, which is before the capture in some boots and after it in others.
        masks: ['#sb_character_editor_header .sb-editor-tokens', '#sb_character_editor_toolbar .sb-editor-tokens--row', '#sb-topbar-title'],
        extraStates: [{
            id: 'create-mode',
            ready: [withText('#sb_character_editor_title', 'Create New Character'), '#right-nav-panel[data-menu-type="create"]'],
            open: openCharacterCreate,
        }],
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-character-editor.js`, `${SCRIPTS}/sillybunny-editor/chrome.js`, `${CSS}/sillybunny-character-editor.css`],
        primaryFlow: true,
    }),
    editorHeader({
        id: 'group',
        title: 'Group editor header',
        root: '#sb_group_editor_header',
        ready: withText('#sb_group_editor_title', FIXTURES.group.name),
        open: openGroupEditor,
        cancel: '#sb_group_editor_cancel',
        dirtyState: { rename: '#sb_group_editor_title_button', dirty: '#sb_group_editor_dirty:not([hidden])', title: '#sb_group_editor_title' },
        needs: ['group'],
        sources: [`${SCRIPTS}/sillybunny-group-editor.js`, `${SCRIPTS}/sillybunny-editor/chrome.js`, `${CSS}/sillybunny-character-editor.css`],
    }),
    editorHeader({
        id: 'worldinfo-entry',
        title: 'World Info entry header',
        root: '#WorldInfo .sb-wi-entry .sb-wi-entry-header',
        ready: '#WorldInfo .sb-wi-entry .sb-wi-entry-title',
        open: openWorldInfoEntry,
        cancel: '#WorldInfo .sb-wi-entry .sb-wi-entry-cancel',
        dirtyState: { field: '#WorldInfo .sb-wi-entry .sb-wi-entry-title', dirty: '#WorldInfo .sb-wi-entry .sb-wi-entry-dirty:not([hidden])' },
        masks: ['#WorldInfo .sb-wi-entry .sb-wi-entry-tokens', '#WorldInfo .sb-wi-entry .sb-editor-tokens--row'],
        needs: ['lorebook'],
        sources: [`${SCRIPTS}/sillybunny-world-info-entry.js`, `${SCRIPTS}/sillybunny-editor/chrome.js`, `${CSS}/sillybunny-world-info-editor.css`],
    }),
    editorHeader({
        id: 'persona',
        title: 'Persona detail header',
        root: '#PersonaManagement .sb-persona-editor .sb-persona-entry-header',
        ready: '#PersonaManagement .sb-persona-editor .sb-persona-entry-name',
        open: openPersonaDetail,
        cancel: '#PersonaManagement .sb-persona-entry-cancel',
        dirtyState: { field: '#PersonaManagement .sb-persona-entry-name', dirty: '#PersonaManagement .sb-persona-entry-dirty:not([hidden])' },
        needs: ['persona'],
        sources: [`${SCRIPTS}/sillybunny-persona-detail.js`, `${SCRIPTS}/sillybunny-editor/chrome.js`, `${CSS}/sillybunny-persona-detail.css`],
    }),
    editorHeader({
        id: 'prompt',
        title: 'Prompt editor header',
        root: '.sb-prompt-detail .sb-prompt-detail-header',
        ready: '.sb-prompt-detail .sb-prompt-detail-header .sb-prompt-title',
        open: openPromptDetail,
        cancel: '.sb-prompt-detail .sb-prompt-cancel',
        dirtyState: { id: 'dirty', field: '#sb-prompt-form_prompt', dirty: '.sb-prompt-detail .sb-prompt-dirty:not([hidden])', value: 'Changed prompt text.' },
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, `${CSS}/sillybunny-prompt-editor.css`],
    }),
    editorHeader({
        id: 'agent',
        title: 'Agent editor header',
        root: `${AGENTS} .ica-agent-detail .sb-persona-entry-header`,
        ready: `${AGENTS} .ica-agent-detail .sb-persona-entry-name`,
        open: openAgentDetail,
        cancel: `${AGENTS} .sb-persona-entry-cancel`,
        dirtyState: { field: `${AGENTS} .sb-persona-entry-header input[data-sb-editor-field="name"]`, dirty: `${AGENTS} .sb-persona-entry-dirty:not([hidden])` },
        needs: ['agents'],
        sources: ['public/scripts/extensions/in-chat-agents/ui/agent-editor.js', `${SCRIPTS}/sillybunny-editor/chrome.js`, `${CSS}/sillybunny-persona-detail.css`],
    }),
    editorHeader({
        id: 'worldinfo-settings',
        title: 'World Info Global Settings header',
        root: '#WorldInfo .sb-wi-settings-header',
        ready: '#WorldInfo .sb-wi-settings-header .sb-wi-settings-title',
        open: openGlobalSettingsPane({ tab: 'world-info', host: '#WorldInfo', trigger: '.sb-wi-book-actions', root: '.sb-wi-settings' }),
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-world-info-settings.js`, `${CSS}/sillybunny-world-info-editor.css`],
    }),
    editorHeader({
        id: 'persona-settings',
        title: 'Persona Global Settings header',
        root: '#PersonaManagement .sb-persona-settings-header',
        ready: '#PersonaManagement .sb-persona-settings-header .sb-persona-settings-title',
        open: openGlobalSettingsPane({ tab: 'persona', host: '#PersonaManagement', trigger: '.sb-persona-list-menu', root: '.sb-persona-settings' }),
        needs: ['persona'],
        sources: [`${SCRIPTS}/sillybunny-persona-settings.js`, `${CSS}/sillybunny-persona-editor.css`],
    }),
    propertySheetHeader({
        id: 'worldinfo-properties',
        title: 'World Info entry properties sheet header',
        editor: 'worldInfo',
        header: '.sb-world-info-properties-dialog .sb-dialog__header',
        closeButton: '.sb-world-info-properties-dialog .sb-dialog__close',
        needs: ['lorebook'],
        sources: [`${SCRIPTS}/sillybunny-world-info-entry.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`, `${CSS}/sillybunny-world-info-editor.css`],
    }),
    propertySheetHeader({
        id: 'persona-properties',
        title: 'Persona properties sheet header',
        editor: 'persona',
        header: '.sb-persona-properties-dialog .sb-dialog__header',
        closeButton: '.sb-persona-properties-dialog .sb-dialog__close',
        needs: ['persona'],
        sources: [`${SCRIPTS}/sillybunny-persona-detail.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`, `${CSS}/sillybunny-persona-detail.css`],
    }),
    propertySheetHeader({
        id: 'prompt-properties',
        title: 'Prompt properties sheet header',
        editor: 'prompt',
        header: '.sb-prompt-properties-dialog .sb-dialog__header',
        closeButton: '.sb-prompt-properties-dialog .sb-dialog__close',
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`, `${CSS}/sillybunny-prompt-editor.css`],
    }),
    propertySheetHeader({
        id: 'agent-properties',
        title: 'Agent properties sheet header',
        editor: 'agent',
        header: '.ica-agent-properties-dialog .sb-dialog__header',
        closeButton: '.ica-agent-properties-dialog .sb-dialog__close',
        needs: ['agents'],
        sources: ['public/scripts/extensions/in-chat-agents/ui/agent-editor-properties.js', `${SCRIPTS}/sillybunny-editor/dialog.js`, `${CSS}/sillybunny-prompt-editor.css`],
    }),
    listHeader({
        id: 'characters',
        title: 'Character list header',
        root: '.sb-character-list__header',
        ready: '.sb-character-list__header .sb-list-header__title',
        open: openCharacterList,
        selectionCancel: '.sb-character-list__selection-header .sb-selection-cancel',
        states: [{
            id: 'selection-mode',
            root: '.sb-character-list__selection-header',
            ready: ['.sb-character-list__selection-header .sb-selection-cancel', '.sb-character-list__selection-header .sb-selection-title'],
            open: enterCharacterSelection,
        }],
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-character-list.js`, `${SCRIPTS}/sillybunny-editor/list-header.js`, `${CSS}/sillybunny-character-list.css`],
        primaryFlow: true,
    }),
    listHeader({
        id: 'worldinfo',
        title: 'World Info list header',
        root: '#WorldInfo .sb-wi-list-header',
        ready: withText('#WorldInfo .sb-wi-list-header .sb-wi-book-name', FIXTURES.lorebook.name),
        open: page => openWorldInfoBook(page, FIXTURES.lorebook.name),
        selectionCancel: '#WorldInfo .sb-wi-selection-header .sb-selection-cancel',
        states: [{
            id: 'selection-mode',
            root: '#WorldInfo .sb-wi-selection-header',
            ready: ['#WorldInfo .sb-wi-selection-header .sb-selection-cancel', '#WorldInfo .sb-wi-selection-header .sb-selection-title'],
            open: enterWorldInfoSelection,
        }],
        needs: ['lorebook'],
        sources: [`${SCRIPTS}/sillybunny-world-info-editor.js`, `${CSS}/sillybunny-world-info-editor.css`],
    }),
    listHeader({
        id: 'persona',
        title: 'Persona list header',
        root: '#PersonaManagement .sb-persona-list-header',
        ready: '#PersonaManagement .sb-persona-list-header .sb-persona-list-title',
        open: openPersonaList,
        needs: ['persona'],
        sources: [`${SCRIPTS}/sillybunny-persona-editor.js`, `${CSS}/sillybunny-persona-editor.css`],
    }),
    listHeader({
        id: 'prompt',
        title: 'Prompt list header',
        root: '.sb-prompt-editor .sb-prompt-list-header',
        ready: '.sb-prompt-editor .sb-prompt-list-header .sb-list-header__title',
        open: openPromptList,
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, `${CSS}/sillybunny-prompt-editor.css`],
    }),
    listHeader({
        id: 'agents',
        title: 'Agent list header',
        root: `${AGENTS} .sb-list-header`,
        ready: `${AGENTS} .sb-list-header .sb-list-header__title`,
        open: openAgentList,
        selectionCancel: `${AGENTS} .sb-selection-header .sb-selection-cancel`,
        states: [{
            id: 'selection-mode',
            root: `${AGENTS} .ica-agents-selection-header`,
            ready: [`${AGENTS} .sb-selection-header .sb-selection-cancel`, `${AGENTS} .sb-selection-header .sb-selection-title`],
            open: enterAgentSelection,
        }],
        needs: ['agents'],
        sources: ['public/scripts/extensions/in-chat-agents/ui/agent-list.js', `${SCRIPTS}/sillybunny-editor/list-header.js`],
    }),
];
