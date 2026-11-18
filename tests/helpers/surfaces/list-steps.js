/**
 * Open and wait steps of the list family. No Playwright import, so the registry loads in Jest.
 *
 * Every opener puts its list in the state "as found" (no search, no filter, nothing selected, no folder collapsed), because
 * the states of an entry are opened one after the other on the same page and each begins with the entry's `open`. A list
 * inside a dialog is closed and opened again for the same reason. Each opener names the spec it was taken from.
 */

import { openAuditChat } from './panel-steps.js';
import { chooseMenuItem, isBottomBarChipRow, openCharactersTab, openSettingsTab, selectBackend, settle } from './steps.js';

export const shown = (page, selector) => page.locator(selector).first().waitFor({ state: 'visible' });
export const gone = (page, selector) => page.locator(selector).first().waitFor({ state: 'hidden' });

/** An action menu or popover, in both forms (the popover of a desktop window, the sheet under the overlay breakpoint). */
export const MENU_ROOT = '.sb-action-popover, .sb-action-sheet:not([hidden])';

/** Waits until the animations inside `selector` have ended (one that repeats forever, such as a hover spin, is ignored), so that a measured box is the settled one. */
export async function settled(page, selector) {
    await page.waitForFunction(selector => {
        const root = document.querySelector(selector);
        return Boolean(root) && root.getAnimations({ subtree: true }).every(animation => animation.playState === 'finished' || !Number.isFinite(animation.effect?.getComputedTiming?.().endTime));
    }, selector);
    await settle(page);
}

/** Closes the action menu, popover or picker that is open, without the exit animation. */
export async function closeOverlays(page) {
    await page.evaluate(async () => {
        const menu = await import('/scripts/sillybunny-action-menu.js');
        const picker = await import('/scripts/sillybunny-editor/picker.js');
        menu.closeActionMenu({ animate: false, restoreFocus: false });
        picker.closePicker({ animate: false, restoreFocus: false });
    });
}

/** Closes every open dialog by hand: a welcome or import popup would cover the surface under test. */
export async function dismissDialogs(page) {
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
}

/** Clicks the element when it is shown. */
export async function clickIfShown(page, selector) {
    const target = page.locator(selector).first();
    if (await target.isVisible()) {
        await target.click();
        return true;
    }
    return false;
}

/** Scrolls an element of a long settings page into view, so that the list is inside the viewport. */
export async function scrollIntoView(page, selector) {
    // The page header of a settings page is sticky, so the list is stopped below it.
    await page.locator(selector).first().evaluate(node => {
        node.style.scrollMarginTop = '160px';
        node.scrollIntoView({ block: 'start', behavior: 'instant' });
        node.style.removeProperty('scroll-margin-top');
    });
    await settle(page);
}

/** Goes back from a detail pane that covers its list, when one is open. */
export async function leaveDetail(page, back) {
    const button = page.locator(back).first();
    if (await button.isVisible()) {
        await button.click();
        await button.waitFor({ state: 'hidden' });
    }
}

/**
 * An empty search closes on a press outside it. The field is `hidden` and its `data-state` is `closed` at once, but it keeps
 * its box while its exit animation runs, so a step that reads or toggles the search waits until the animation has ended.
 */
async function settledSearch(page, input) {
    await page.waitForFunction(selector => {
        const field = document.querySelector(selector)?.closest('[data-state]');
        return !field || (!['opening', 'closing'].includes(field.dataset.state) && field.getAnimations().length === 0);
    }, input);
}

/**
 * Opens the search of a list: its toggle button, or where the header has no room for the button, the overflow menu.
 * @param {object} target
 * @param {string} target.input The search field.
 * @param {string} target.toggle The header button that shows and hides the field.
 */
export async function openSearch(page, { input, toggle }) {
    await settledSearch(page, input);
    if (await page.locator(input).first().isVisible()) {
        return;
    }
    await page.locator(toggle).first().evaluate(button => button.click());
    await shown(page, input);
    await settle(page);
}

const countVisibleRows = (page, rows) => page.evaluate(rows => [...document.querySelectorAll(rows)].filter(row => row.getClientRects().length > 0 && !row.hidden).length, rows);

/** The rows a list showed before its search was typed, by page and search field: what clearing the search must bring back. */
const unfilteredRows = new WeakMap();

/** Types a query and waits until the list shows no more than `atMost` rows (the filter runs after a debounce). */
export async function searchFor(page, { input, toggle, query, rows, atMost }) {
    await openSearch(page, { input, toggle });
    const field = page.locator(input).first();
    if (await field.inputValue() === '') {
        const counts = unfilteredRows.get(page) ?? new Map();
        counts.set(input, await countVisibleRows(page, rows));
        unfilteredRows.set(page, counts);
    }
    await field.fill(query);
    await waitForRowCount(page, { rows, atMost });
}

/** Waits until the list shows between one row and `atMost` rows (a filter runs after a debounce). */
export async function waitForRowCount(page, { rows, atMost }) {
    try {
        await page.waitForFunction(({ rows, atMost }) => {
            const count = [...document.querySelectorAll(rows)].filter(row => row.getClientRects().length > 0 && !row.hidden).length;
            return count >= 1 && count <= atMost;
        }, { rows, atMost }, { timeout: 15_000 });
    } catch {
        const counted = await countVisibleRows(page, rows);
        throw new Error(`${rows} shows ${counted} rows after the search, not between 1 and ${atMost}.`);
    }
    await settle(page);
}

/**
 * Empties the search field of a list and closes it, so that a later step finds the list unfiltered: it waits until the rows
 * are back to the count the list showed before the search was typed.
 */
export async function clearSearch(page, { input, toggle, rows }) {
    const field = page.locator(input).first();
    await settledSearch(page, input);
    if (!await field.isVisible()) {
        return;
    }
    await field.fill('');
    const wanted = unfilteredRows.get(page)?.get(input);
    if (wanted === undefined) {
        await settle(page);
    } else {
        await page.waitForFunction(({ rows, wanted }) => [...document.querySelectorAll(rows)].filter(row => row.getClientRects().length > 0 && !row.hidden).length >= wanted, { rows, wanted });
    }
    // The toggle closes an open field and opens a closed one, and the field may have closed itself in the meantime.
    await settledSearch(page, input);
    if (await field.isVisible()) {
        await page.locator(toggle).first().evaluate(button => button.click());
    }
    await field.waitFor({ state: 'hidden' });
}

/** Clicks a header action of a list, or its item in the More menu where the header has no room for the button. */
export async function openHeaderAction(page, { scope, action, more = 'more', label }) {
    const button = page.locator(`${scope} [data-action-id="${action}"]`).first();
    if (await button.isVisible()) {
        await button.click();
        return;
    }
    await chooseMenuItem(page, `${scope} [data-action-id="${more}"]`, label);
}

// ---------------------------------------------------------------------------------------------------------------------
// Characters and Groups
// ---------------------------------------------------------------------------------------------------------------------

export const CHARACTER_LIST = '.sb-character-list[data-mounted="true"]';

/**
 * Shows the Characters or the Groups list with its search, tag filter, grid view, selection and folder state reset. From
 * `character-list.e2e.js` (`prepareList`, `showView`).
 * @param {'characters' | 'groups'} view
 */
export async function openCharacterListView(page, view) {
    await closeOverlays(page);
    await dismissDialogs(page);
    await page.evaluate(view => window.SillyBunnyShell.openTab('characters', view), view);
    await page.locator(`${CHARACTER_LIST}[data-view="${view}"]`).waitFor({ state: 'visible' });
    await clickIfShown(page, '.sb-character-list .sb-selection-cancel');
    await page.evaluate(async () => {
        const app = await import('/script.js');
        const folders = await import('/scripts/sillybunny-folders.js');
        const tags = await import('/scripts/tags.js');
        const { power_user } = await import('/scripts/power-user.js');
        if (power_user.charListGrid) {
            document.querySelector('#charListGridToggle')?.click();
        }
        for (const scope of ['characters', 'groups']) {
            for (const folder of folders.getFolders(scope)) {
                if (folder.expanded !== true) {
                    folders.setFolderExpanded(scope, folder.id, true);
                }
            }
        }
        for (const type of ['fav', 'folder', 'group']) {
            app.entitiesFilter.setFilterData(type, 'UNDEFINED', true);
        }
        app.entitiesFilter.setFilterData('tag', { selected: [], excluded: [] }, true);
        app.entitiesFilter.setFilterData('search', '', true);
        app.entitiesFilter.clearFuzzySearchCaches();
        document.getElementById('character_search_bar').value = '';
        await app.printCharacters(false);
        tags.printTagFilters(tags.tag_filter_type.character);
    });
    if (await page.locator('.sb-character-list__search').first().isVisible()) {
        await page.locator('.sb-character-list [data-action-id="search"]').first().evaluate(button => button.click());
        await page.locator('.sb-character-list__search').first().waitFor({ state: 'hidden' });
    }
    await shown(page, `.sb-character-list ${view === 'groups' ? '.group_select' : '.character_select'}`);
    await settle(page);
}

export const characterSearch = { input: '#character_search_bar', toggle: '.sb-character-list [data-action-id="search"]' };

/** Selection mode of the Characters or Groups list, with the first two rows selected. */
export async function selectCharacterRows(page, rowSelector) {
    await chooseMenuItem(page, '.sb-character-list [data-action-id="more"]', 'Select');
    await shown(page, '.sb-character-list__selection-header .sb-selection-header');
    await page.locator(`.sb-character-list ${rowSelector} .ch_name`).nth(0).click();
    await page.locator(`.sb-character-list ${rowSelector} .ch_name`).nth(1).click();
    await shown(page, '.sb-character-list__selection-bar [data-action-id="folder"], .sb-character-list__selection-bar [data-action-id="tag"]');
    await settle(page);
}

// ---------------------------------------------------------------------------------------------------------------------
// World Info
// ---------------------------------------------------------------------------------------------------------------------

export const WORLD_INFO = '#WorldInfo';
export const worldInfoSearch = { input: `${WORLD_INFO} .sb-wi-search`, toggle: `${WORLD_INFO} .sb-wi-list-header button[aria-label="Search"]`, rows: `${WORLD_INFO} .sb-wi-row` };

/**
 * Opens a book in the World Info editor and puts its list in the state as found: no search, no selection, the default
 * sort and the "All" filter. From `world-info-editor.e2e.js` (`openBook`).
 */
export async function openWorldInfoEntries(page, name) {
    await closeOverlays(page);
    await page.evaluate(async name => {
        await window.SillyBunnyShell.openTab('characters', 'world-info');
        const { openWorldInfoEditor } = await import('/scripts/world-info.js');
        await openWorldInfoEditor(name);
    }, name);
    await leaveDetail(page, `${WORLD_INFO} .sb-wi-entry .sb-wi-detail-back`);
    await shown(page, `${WORLD_INFO} .sb-wi-editor .sb-wi-row`);
    await clickIfShown(page, `${WORLD_INFO} .sb-selection-cancel`);
    await clearSearch(page, worldInfoSearch);
    await page.evaluate(() => {
        const sort = document.getElementById('world_info_sort_order');
        if (sort && sort.value !== '0') {
            sort.value = '0';
            sort.dispatchEvent(new Event('change', { bubbles: true }));
        }
        document.querySelector('.world_info_view_filter[data-filter="all"]:not(.is-active)')?.click();
    });
    await shown(page, `${WORLD_INFO} .sb-wi-editor .sb-wi-row`);
    await settle(page);
}

// ---------------------------------------------------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------------------------------------------------

export const PERSONAS = '#PersonaManagement';
export const personaSearch = { input: `${PERSONAS} .sb-persona-search`, toggle: `${PERSONAS} .sb-persona-list-header button[aria-label="Search"]`, rows: `${PERSONAS} .sb-persona-row` };

/** Shows the Persona list. From `persona-editor.e2e.js` (`openList`). */
export async function openPersonaList(page) {
    await closeOverlays(page);
    await openCharactersTab(page, 'persona');
    await leaveDetail(page, `${PERSONAS} .sb-persona-detail-back`);
    await shown(page, `${PERSONAS} .sb-persona-row`);
    await clearSearch(page, personaSearch);
    await settle(page);
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------------------------------

export const promptSearch = { input: '.sb-prompt-editor .sb-prompt-search', toggle: '.sb-prompt-editor button[aria-label="Search Prompts"]', rows: '.sb-prompt-editor .sb-prompt-row' };

/**
 * Opens Backend > Editor and shows the prompt list. From `prompt-manager-characterization.e2e.js`; the text completion
 * backend shows the prompt templates in the same list.
 */
export async function openPromptList(page, backend) {
    await closeOverlays(page);
    await selectBackend(page, backend);
    await openSettingsTab(page, { shell: 'left', tab: 'editor' });
    await leaveDetail(page, '.sb-prompt-detail .sb-prompt-detail-header [aria-label="Back to prompt list"]');
    await shown(page, '.sb-prompt-editor .sb-prompt-list-header');
    await clearSearch(page, promptSearch);
    await shown(page, '.sb-prompt-editor .sb-prompt-row:visible');
    await settle(page);
}

// ---------------------------------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------------------------------

export const AGENTS = '.ica-agents-editor';
export const agentSearch = { input: `${AGENTS} .ica-agents-search-input`, toggle: `${AGENTS} button[aria-label="Search Agents"]`, rows: `${AGENTS} [data-saved="true"]` };

/** Shows the agent list. From `in-chat-agents-list.e2e.js`. */
export async function openAgentList(page) {
    await closeOverlays(page);
    await openSettingsTab(page, { shell: 'left', tab: 'agents' });
    await leaveDetail(page, `${AGENTS} .ica-agent-detail .sb-persona-detail-back`);
    await clickIfShown(page, `${AGENTS} .sb-selection-cancel`);
    await shown(page, `${AGENTS} .sb-list-header, ${AGENTS} .sb-selection-header`);
    await clearSearch(page, agentSearch);
    await shown(page, `${AGENTS} [data-saved="true"]`);
    await settle(page);
}

// ---------------------------------------------------------------------------------------------------------------------
// Windows that list rows
// ---------------------------------------------------------------------------------------------------------------------

/** The Tag Manager Window, opened from the character list menu. From `tag-manager.e2e.js` (`openFromList`). */
export const TAG_MANAGER = '#tag_view_list';
export const FOLDER_MANAGER = '.sb-dialog-host[open]:has(> .sb-folder-manager)';

export async function closeManager(page, root) {
    await closeOverlays(page);
    if (await page.locator(root).first().isVisible()) {
        await page.locator(`${root} .sb-dialog__header:visible .sb-dialog__close`).last().click();
        await gone(page, root);
    }
}

/** Opens a manager Window from the character list menu, closing a copy that is open so that its search and pages are reset. */
export async function openManager(page, { item, root }) {
    await closeManager(page, root);
    await openCharacterListView(page, 'characters');
    await chooseMenuItem(page, '.sb-character-list [data-action-id="more"]', item);
    await shown(page, root);
    await settled(page, root);
}

export const ARCHIVE = '.sbca-dialog';

export async function closeArchive(page) {
    await closeOverlays(page);
    if (await page.locator(ARCHIVE).first().isVisible()) {
        await page.locator(`${ARCHIVE} .sb-dialog__header:visible .sb-dialog__close`).first().click();
        await gone(page, ARCHIVE);
    }
}

/** Opens the Chats Archive and shows its chat list. From `helpers/chats-archive.js` (`openArchive`, `showList`). */
export async function openArchiveList(page) {
    await closeArchive(page);
    await openCharacterListView(page, 'characters');
    await page.locator('#sbca_drawer_button').click();
    await shown(page, ARCHIVE);
    await page.waitForFunction(() => !document.querySelector('.sbca-dialog[opening]'));
    await shown(page, '.sbca-location, .sbca-row');
    if (!await page.locator('.sbca-row').first().isVisible()) {
        await page.locator('.sbca-location').first().click();
    }
    await shown(page, '.sbca-row');
    await settled(page, ARCHIVE);
}

export const CHAT_HISTORY = '.sb-chat-history-dialog';
export const CHAT_HISTORY_HOST = '.sb-dialog-host[data-tier="window"]:has(.sb-chat-history-dialog)';

export async function closeChatHistory(page) {
    await closeOverlays(page);
    if (await page.locator(CHAT_HISTORY).first().isVisible()) {
        await page.locator(`${CHAT_HISTORY_HOST} .sb-dialog__close`).first().click();
        await gone(page, CHAT_HISTORY);
    }
}

/**
 * Opens Chat History, the Window that lists the chat files of the open chat. From `sillybunny-overlays.e2e.js`: a desktop
 * window has the chat bar's actions, a phone opens them from the chat chip.
 */
export async function openChatHistory(page) {
    await closeChatHistory(page);
    await openAuditChat(page);
    const paged = await isBottomBarChipRow(page);
    if (paged) {
        await page.locator('.sb-bottom-chat-chip').click();
    }
    const actions = page.locator(paged ? '#sb-bottom-chat-sheet .sb-bottom-chat-sheet-actions' : '#sb-bottom-chat-bar .sb-bottom-chat-management-actions');
    await actions.getByRole('button', { name: 'View chat files', exact: true }).click();
    await shown(page, CHAT_HISTORY);
    await shown(page, '.sb-chat-history-row');
    await settled(page, CHAT_HISTORY);
}

export const EXTENSIONS_MANAGER = 'dialog.popup[open]:has(.extensions-header-menus)';

export async function closeExtensionsManager(page) {
    await closeOverlays(page);
    if (await page.locator(EXTENSIONS_MANAGER).first().isVisible()) {
        await page.locator(`${EXTENSIONS_MANAGER} .sb-dialog__close`).first().click();
        await gone(page, EXTENSIONS_MANAGER);
    }
}

/** Opens the Extensions manager Window from Customize > Extensions. From `window-tools-dialogs.e2e.js`. */
export async function openExtensionsManager(page) {
    await closeExtensionsManager(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
    await shown(page, '#extensions_details');
    // A click of Playwright would scroll the button into view, and with it the page behind the Window.
    await page.locator('#extensions_details').evaluate(button => button.click());
    await shown(page, `${EXTENSIONS_MANAGER} .extension_block`);
    await settled(page, EXTENSIONS_MANAGER);
}

export const DATA_BANK = 'dialog.popup[open]:has(.dataBankAttachments)';

export async function closeDataBank(page) {
    await closeOverlays(page);
    if (await page.locator(DATA_BANK).first().isVisible()) {
        await page.locator(`${DATA_BANK} .sb-dialog__close`).first().click();
        await gone(page, DATA_BANK);
    }
}

/** Opens the Data Bank Window of the open chat's character. From `helpers/window-dialogs.js` (`openDataBank`). */
export async function openDataBank(page) {
    await closeDataBank(page);
    await openAuditChat(page);
    await page.locator('#manageAttachments').dispatchEvent('click');
    await shown(page, '.dataBankAttachments');
    await shown(page, '.attachmentListItem');
    await settled(page, DATA_BANK);
}

export const SWIPE_PICKER = 'dialog[open].sb-dialog--window:has(.swipe_picker_div)';

export async function closeSwipePicker(page) {
    await closeOverlays(page);
    if (await page.locator(SWIPE_PICKER).first().isVisible()) {
        await page.locator(`${SWIPE_PICKER} .sb-dialog__close`).first().click();
        await gone(page, SWIPE_PICKER);
    }
}

/** Opens the swipe picker of a message that has 52 swipes. From `swipe-picker.e2e.js` (`createSwipeFixture`). */
export async function openSwipePicker(page) {
    await closeSwipePicker(page);
    await openAuditChat(page);
    const messageId = await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const count = 52;
        const message = {
            name: 'Assistant', is_user: false, is_system: false, send_date: new Date(Date.UTC(2026, 0, 6, 9, 0, 0)).toISOString(),
            mes: 'Swipe 1 preview text', extra: {},
            swipes: Array.from({ length: count }, (_, index) => `Swipe ${index + 1} preview text`),
            swipe_id: 1,
            swipe_info: Array.from({ length: count }, () => ({ send_date: Date.UTC(2026, 0, 6, 9, 0, 0), extra: { token_count: 4 } })),
        };
        context.chat.push(message);
        await context.addOneMessage(message);
        const id = context.chat.length - 1;
        document.querySelector(`.mes[mesid="${id}"] .swipes-counter`)?.classList.add('swipe-picker-enabled');
        return id;
    });
    await page.locator(`.mes[mesid="${messageId}"] .swipes-counter.swipe-picker-enabled`).click();
    await shown(page, SWIPE_PICKER);
    await shown(page, '.swipe_picker_footer');
    await page.waitForFunction(() => !document.querySelector('dialog[open].sb-dialog--window[opening]'));
    // The click that opened the picker leaves the pointer over a row, whose icon spins while it is hovered.
    await page.mouse.move(0, 0);
    await settled(page, SWIPE_PICKER);
}

// ---------------------------------------------------------------------------------------------------------------------
// Lists inside Customize pages
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Opens a block of Customize > Extensions that the page shows as a subpage (Regex, Quick Reply), and scrolls its list into
 * view. From `helpers/window-dialogs.js` (`openRegex`).
 */
export async function openExtensionBlock(page, { row, container, list }) {
    await openSettingsTab(page, { shell: 'right', tab: 'extensions' });
    const section = page.locator(container);
    if (!await section.isVisible()) {
        await page.locator(`[data-sb-subpage-row="${row}"]`).click();
        await section.waitFor({ state: 'visible' });
    }
    await shown(page, list);
    await scrollIntoView(page, list);
}

/** Opens Customize > Appearance and scrolls the backgrounds list into view. From `backgrounds-tabs-query.e2e.js`. */
export async function openBackgrounds(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
    await page.locator('button[data-sb-settings-tab="appearance"]').evaluate(button => button.click());
    await shown(page, '#bg_tabs');
    await shown(page, '#bg_menu_content .bg_example');
    await scrollIntoView(page, '#bg_menu_content');
}

// ---------------------------------------------------------------------------------------------------------------------
// Lists inside the Sampling page
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Opens Backend > Sampling for a backend and scrolls a list of the page into view, opening the drawer that holds it. From
 * `sillybunny-backend-settings.e2e.js`.
 */
export async function openSamplingList(page, { backend, list, rows }) {
    await selectBackend(page, backend);
    await openSettingsTab(page, { shell: 'left', tab: 'sampling' });
    await page.locator(list).first().evaluate(node => {
        const drawer = node.closest('.inline-drawer');
        const content = drawer?.querySelector(':scope > .inline-drawer-content');
        if (content && getComputedStyle(content).display === 'none') {
            drawer.querySelector(':scope > .inline-drawer-toggle')?.click();
        }
    });
    await shown(page, rows);
    await scrollIntoView(page, list);
}
