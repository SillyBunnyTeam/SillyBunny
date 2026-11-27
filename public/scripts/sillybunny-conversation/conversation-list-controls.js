/**
 * The behaviour of the conversation list that is not drawing: the row menu (right-click, long press, Shift+F10 and the
 * Menu key), the keyboard moves between sections, the headings that open and close a section, and the drag. Rows are
 * found by their conversation id, and every change goes through the data module (the favourite) or the folders module
 * (the folder and the open state of a section), so a row never keeps a state of its own.
 */

import { openActionMenu } from '../sillybunny-action-menu.js';
import { bindListKeyboard } from '../sillybunny-editor/list-rows.js';
import { CHROME_IDS } from './constants.js';
import { conversationData } from './conversation-data-browser.js';
import { bindRowDrag } from './conversation-list-drag.js';
import { markConversationUnread, setConversationFavorite, setConversationFolder, setConversationMuted } from './conversation-list-actions.js';
import { buildRowMenuSections } from './conversation-menus.js';
import {
    SECTION_CONVERSATIONS,
    SECTION_FAVORITES,
    adjacentSectionKey,
    describeSectionMove,
    folderIdOfSection,
    folderSectionKey,
    getEntrySectionKey,
    getSectionKeys,
    planSectionMove,
} from './conversation-list-model.js';
import {
    announceInList,
    clearTemporaryOpen,
    findRow,
    getRowControl,
    getTemporaryOpenKeys,
    highlightMovedRow,
    setTemporaryOpen,
} from './conversation-list-view.js';
import { createListFolderActions } from './conversation-list-folders.js';
import { markConversationRead } from './notifications.js';

const ROW_SELECTOR = '.sb-conversation-list-row';
// The heading of a folder is the only heading with a menu; Favorites has none.
const FOLDER_HEADING_SELECTOR = '.sb-conversation-list-section[data-kind="folder"] .sb-conversation-list-heading-button';
const SECTION_SELECTOR = '.sb-conversation-list-section';
const MENU_KEYS_SELECTOR = '.sb-conversation-list-item';
const TOUCH_CONTEXTMENU_WINDOW_MS = 1500;
// About a second of frames for the alert to finish closing and the list to draw before focus is given up on.
const FOCUS_RETURN_FRAMES = 60;

/**
 * @param {HTMLElement} list The scroller of the list; it is bound once.
 * @param {object} deps
 * @param {() => import('./conversation-list-view.js').ListRowEntry[]} deps.getEntries The rows as the list shows them now.
 * @param {(action: string, data?: Record<string, string|undefined>) => unknown} deps.runAction `runConversationAction` of `chrome.js`.
 * @param {(conversationId: string) => unknown} deps.openDetails `openConversationDetails` of `chrome.js`.
 * @param {() => void} deps.render Asks for the list to be drawn.
 * @param {ReturnType<typeof import('./conversation-folders.js').createConversationFolders>} deps.folders The folders of the user.
 * @param {() => string} deps.getPersonaId The persona whose list is drawn.
 */
export function bindConversationListControls(list, { getEntries, runAction, openDetails, render, folders, getPersonaId }) {
    if (list.dataset.sbConversationListBound === 'true') {
        return;
    }
    list.dataset.sbConversationListBound = 'true';

    const aside = document.getElementById(CHROME_IDS.conversationList);
    let lastTouchAt = 0;

    const announce = announceInList;
    const entryOf = row => getEntries().find(entry => entry.id === row.dataset.conversationId) ?? null;
    const isSearching = () => list.dataset.searching === 'true';

    const getLayout = () => folders.layout(getPersonaId());

    /** Whether a section shows open now: stored open, or open for the length of a drag or of a key move. */
    function isSectionOpen(key) {
        if (key === SECTION_CONVERSATIONS) {
            return true;
        }
        const layout = getLayout();
        const stored = key === SECTION_FAVORITES ? layout.favoritesExpanded : layout.folders.find(folder => folder.id === folderIdOfSection(key))?.expanded;
        return stored === true || getTemporaryOpenKeys().includes(key);
    }

    /** Stores the open state of Favorites or of a folder. The folders module throws while it is not loaded, and the list is not drawn then. */
    function storeSectionOpen(key, open) {
        try {
            if (key === SECTION_FAVORITES) {
                folders.setFavoritesExpanded(getPersonaId(), open);
            } else {
                folders.updateFolder(getPersonaId(), folderIdOfSection(key), { expanded: open });
            }
        } catch (error) {
            console.warn('Conversation Mode: a section could not be opened or closed', error);
        }
    }

    /**
     * The section that the last Alt move opened for now, and the row that moved into it. A closed section that a row enters
     * by an Alt key shows open so that the row stays in sight, and closes again when the same row leaves it by the next Alt
     * key, so that stepping a row through closed folders leaves them as they were. Anything else that happens makes the row
     * stay, and the open is stored (`commitKeyOpen`).
     * @type {{ rowId: string, key: string } | null}
     */
    let keyOpened = null;

    function commitKeyOpen() {
        if (!keyOpened) {
            return;
        }
        const { key } = keyOpened;
        keyOpened = null;
        storeSectionOpen(key, true);
        setTemporaryOpen(key, false);
        render();
    }

    function toggleSection(key) {
        if (keyOpened && keyOpened.key !== key) {
            commitKeyOpen();
        }
        if (getTemporaryOpenKeys().includes(key)) {
            // What shows open is not what is stored: a click closes what the user sees.
            keyOpened = keyOpened?.key === key ? null : keyOpened;
            setTemporaryOpen(key, false);
        } else {
            storeSectionOpen(key, !isSectionOpen(key));
        }
        render();
    }

    /**
     * Moves a row to a section, and announces it. Alt, a drop and the row's menu all come here, so the favourite flag and the
     * folder change together, as `planSectionMove()` says.
     * @returns {boolean} False when the row is there already, or the change could not be made.
     */
    function moveToSection(entry, targetKey, { byKey = false } = {}) {
        const plan = planSectionMove(entry, targetKey);
        if (!plan) {
            return false;
        }
        // The next Alt move of the row that a key moved into a closed section takes it out again, and the section closes as it was.
        const leaving = byKey && keyOpened?.rowId === entry.id && keyOpened.key === getEntrySectionKey(entry) ? keyOpened.key : '';
        if (!byKey || (keyOpened && !leaving)) {
            commitKeyOpen();
        }
        if (plan.favorite !== entry.favorite && !setConversationFavorite(conversationData, entry.id, plan.favorite)) {
            return false;
        }
        if (plan.folderId !== entry.folderId && !setConversationFolder(folders, getPersonaId(), entry.id, plan.folderId)) {
            return false;
        }
        if (leaving) {
            setTemporaryOpen(leaving, false);
            keyOpened = null;
        }
        if (byKey && !isSectionOpen(targetKey)) {
            setTemporaryOpen(targetKey, true);
            keyOpened = { rowId: entry.id, key: targetKey };
        }
        highlightMovedRow(list, entry.id);
        announce(describeSectionMove(entry, plan, getLayout().folders));
        render();
        return true;
    }

    /**
     * Add to Favorites and Remove From Favorites change the flag and nothing else: a favourite keeps its folder, so that the
     * row returns to it when it is not one any more.
     */
    function setFavoriteFlag(entry, favorite) {
        if (entry.favorite === favorite || !setConversationFavorite(conversationData, entry.id, favorite)) {
            return false;
        }
        const home = favorite ? null : getLayout().folders.find(folder => folder.id === entry.folderId);
        const destKey = favorite ? SECTION_FAVORITES : (home ? folderSectionKey(home.id) : SECTION_CONVERSATIONS);
        if (!isSectionOpen(destKey)) {
            storeSectionOpen(destKey, true);
        }
        highlightMovedRow(list, entry.id);
        announce(favorite ? `${entry.name} added to Favorites` : home ? `${entry.name} moved to ${home.name}` : `${entry.name} removed from Favorites`);
        render();
        return true;
    }

    /**
     * Deletes after the alert. The row that had focus is gone then, and the dialog's return of focus finds nothing, so focus
     * goes to the next row (the one before it for the last row) once the dialog has closed and the list has drawn again.
     */
    async function removeConversation(entry) {
        const rows = [...list.querySelectorAll(ROW_SELECTOR)];
        const index = rows.findIndex(row => row.dataset.conversationId === entry.id);
        const neighbourId = (rows[index + 1] ?? rows[index - 1])?.dataset.conversationId;
        await runAction('delete-conversation', { avatar: entry.avatar, groupId: entry.groupId });
        if (conversationData.get(entry.id) || !neighbourId) {
            return;
        }
        for (let frame = 0; frame < FOCUS_RETURN_FRAMES; frame++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const target = findRow(list, neighbourId);
            const settled = !findRow(list, entry.id)?.isConnected && !document.querySelector('dialog[open]');
            if (!target || list.contains(document.activeElement)) {
                return;
            }
            if (settled) {
                getRowControl(target)?.focus();
                return;
            }
        }
    }

    const folderActions = createListFolderActions({
        list, aside, folders, getPersonaId, getLayout, announce, render, isSectionOpen, storeSectionOpen, commitKeyOpen,
    });

    const rowActions = {
        markRead: entry => void markConversationRead(entry.avatar, { groupId: entry.groupId }),
        markUnread: entry => void markConversationUnread(conversationData, entry.id),
        setFavorite: (entry, favorite) => void setFavoriteFlag(entry, favorite),
        setMuted: (entry, muted) => {
            setConversationMuted(conversationData, entry.id, muted);
            render();
        },
        openDetails: entry => void openDetails(entry.id),
        remove: entry => void removeConversation(entry),
    };

    function openRowMenu(row, { point = null, keyboard = false } = {}) {
        const entry = entryOf(row);
        const trigger = getRowControl(row);
        if (!entry || !trigger) {
            return;
        }
        const actions = { ...rowActions, moveToFolder: chosen => folderActions.openMoveMenu(row, chosen, { keyboard }) };
        openActionMenu({ trigger, title: entry.name, sections: buildRowMenuSections(entry, actions), point, keyboard, bounds: aside });
    }

    // Whatever the user does after a key moved a row into a closed section, except moving that row again, makes the row stay.
    document.addEventListener('focusin', (event) => {
        if (keyOpened && !(event.target instanceof Element && event.target.closest(`[data-conversation-id="${keyOpened.rowId}"]`))) {
            commitKeyOpen();
        }
    });
    list.addEventListener('pointerdown', () => commitKeyOpen(), true);

    // Alt with an arrow is the fork's move key (DESIGN.md, Reordering). The sections sort themselves, so a move is a
    // change of section: to the one above or below in the order of the list, or with Home and End to the first or the last.
    bindListKeyboard(list, {
        rowSelector: '[data-sb-list-key]',
        keySourceSelector: `${MENU_KEYS_SELECTOR}, .sb-conversation-list-heading-button`,
        onMove: (row, direction) => {
            const entry = row.dataset.conversationId && !isSearching() ? entryOf(row) : null;
            if (!entry) {
                return false;
            }
            const target = adjacentSectionKey(getSectionKeys(getLayout().folders), getEntrySectionKey(entry), direction);
            return target ? moveToSection(entry, target, { byKey: true }) : false;
        },
    });

    window.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'touch') {
            lastTouchAt = Date.now();
        }
    }, true);

    list.addEventListener('contextmenu', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const row = target?.closest(ROW_SELECTOR);
        const heading = row ? null : target?.closest(FOLDER_HEADING_SELECTOR);
        if (!(row instanceof HTMLElement) && !(heading instanceof HTMLElement)) {
            return;
        }
        event.preventDefault();
        // A long press on a touch screen can send this event too. The press itself opens the menu on release.
        if (Date.now() - lastTouchAt < TOUCH_CONTEXTMENU_WINDOW_MS) {
            return;
        }
        const point = { x: event.clientX, y: event.clientY };
        if (row instanceof HTMLElement) {
            openRowMenu(row, { point });
        } else {
            folderActions.openFolderMenu(heading, { point });
        }
    });

    // Shift+F10 and the Menu key come from the keyboard, so the menu opens on the focused row with its first item focused.
    list.addEventListener('keydown', (event) => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) {
            return;
        }
        const target = event.target instanceof Element ? event.target : null;
        const row = target?.closest(MENU_KEYS_SELECTOR)?.closest(ROW_SELECTOR);
        const heading = row ? null : target?.closest(FOLDER_HEADING_SELECTOR);
        if (row instanceof HTMLElement) {
            event.preventDefault();
            openRowMenu(row, { keyboard: true });
        } else if (heading instanceof HTMLElement) {
            event.preventDefault();
            folderActions.openFolderMenu(heading, { keyboard: true });
        }
    });

    list.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('.sb-conversation-list-heading-button') : null;
        // While a search filters, every section that shows is open and its heading does not toggle.
        if (button instanceof HTMLElement && button.dataset.collapsible !== 'false') {
            toggleSection(button.closest(SECTION_SELECTOR)?.dataset.section ?? '');
        }
    });

    bindRowDrag(list, {
        rowSelector: ROW_SELECTOR,
        sectionSelector: SECTION_SELECTOR,
        canDrag: () => !isSearching(),
        getSectionOfRow: row => row.closest(SECTION_SELECTOR)?.dataset.section ?? '',
        onDrop: (row, section) => {
            const entry = entryOf(row);
            if (!entry || !planSectionMove(entry, section)) {
                return;
            }
            // A drop into a closed section opens it, and the open is stored, so that the row stays in sight with its highlight.
            if (!isSectionOpen(section) || getTemporaryOpenKeys().includes(section)) {
                storeSectionOpen(section, true);
            }
            clearTemporaryOpen();
            if (moveToSection(entry, section)) {
                getRowControl(row)?.focus({ preventScroll: true });
            }
        },
        onMenu: (row, point) => openRowMenu(row, { point }),
        menuOnlySelector: FOLDER_HEADING_SELECTOR,
        onMenuOnly: (heading, point) => folderActions.openFolderMenu(heading, { point }),
        // Resting on a closed section shows it open for the length of the drag, so that the stored state of a section that
        // the pointer only crossed does not change.
        onHoldOver: (section) => {
            if (!isSectionOpen(section) && setTemporaryOpen(section, true)) {
                render();
            }
        },
        onDragEnd: () => {
            if (clearTemporaryOpen()) {
                render();
            }
        },
        announce,
    });
}
