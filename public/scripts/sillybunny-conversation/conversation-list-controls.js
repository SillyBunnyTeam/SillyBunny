/**
 * The behaviour of the conversation list that is not drawing: the row menu (right-click, long press, Shift+F10 and the
 * Menu key), the keyboard moves between sections, the Favorites heading, and the drag. Rows are found by their
 * conversation id, and every change goes through the data module, so a row never keeps a state of its own.
 */

import { openActionMenu } from '../sillybunny-action-menu.js';
import { bindListKeyboard } from '../sillybunny-editor/list-rows.js';
import { CHROME_IDS } from './constants.js';
import { conversationData } from './conversation-data-browser.js';
import { bindRowDrag } from './conversation-list-drag.js';
import { markConversationUnread, setConversationFavorite, setConversationMuted } from './conversation-list-actions.js';
import { buildRowMenuSections } from './conversation-list-menu.js';
import { SECTION_FAVORITES, getSectionForMove, isFavoriteSection } from './conversation-list-model.js';
import {
    findRow,
    getRowControl,
    highlightMovedRow,
    isFavoritesCollapsed,
    setFavoritesCollapsed,
} from './conversation-list-view.js';
import { markConversationRead } from './notifications.js';

const ROW_SELECTOR = '.sb-conversation-list-row';
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
 */
export function bindConversationListControls(list, { getEntries, runAction, openDetails, render }) {
    if (list.dataset.sbConversationListBound === 'true') {
        return;
    }
    list.dataset.sbConversationListBound = 'true';

    const aside = document.getElementById(CHROME_IDS.conversationList);
    const region = aside?.querySelector('.sb-conversation-list-status') ?? null;
    let lastTouchAt = 0;

    const announce = (text) => {
        if (!region) {
            return;
        }
        region.textContent = '';
        requestAnimationFrame(() => {
            region.textContent = text;
        });
    };
    const entryOf = row => getEntries().find(entry => entry.id === row.dataset.conversationId) ?? null;
    const isSearching = () => list.dataset.searching === 'true';

    function moveToSection(entry, favorite) {
        if (entry.favorite === favorite || !setConversationFavorite(conversationData, entry.id, favorite)) {
            return false;
        }
        highlightMovedRow(list, entry.id);
        announce(`${entry.name} ${favorite ? 'added to' : 'removed from'} Favorites`);
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

    const rowActions = {
        markRead: entry => void markConversationRead(entry.avatar, { groupId: entry.groupId }),
        markUnread: entry => void markConversationUnread(conversationData, entry.id),
        setFavorite: (entry, favorite) => void moveToSection(entry, favorite),
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
        openActionMenu({ trigger, title: entry.name, sections: buildRowMenuSections(entry, rowActions), point, keyboard, bounds: aside });
    }

    // Alt with an arrow is the fork's move key (DESIGN.md, Reordering). The sections sort themselves, so a move is a
    // change of section: up and to the first place go to Favorites, down and to the last place go to Conversations.
    bindListKeyboard(list, {
        rowSelector: '[data-sb-list-key]',
        keySourceSelector: `${MENU_KEYS_SELECTOR}, .sb-conversation-list-heading-button`,
        onMove: (row, direction) => {
            const entry = row.dataset.conversationId && !isSearching() ? entryOf(row) : null;
            return entry ? moveToSection(entry, isFavoriteSection(getSectionForMove(direction))) : false;
        },
    });

    window.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'touch') {
            lastTouchAt = Date.now();
        }
    }, true);

    list.addEventListener('contextmenu', (event) => {
        const row = event.target instanceof Element ? event.target.closest(ROW_SELECTOR) : null;
        if (!(row instanceof HTMLElement)) {
            return;
        }
        event.preventDefault();
        // A long press on a touch screen can send this event too. The press itself opens the menu on release.
        if (Date.now() - lastTouchAt < TOUCH_CONTEXTMENU_WINDOW_MS) {
            return;
        }
        openRowMenu(row, { point: { x: event.clientX, y: event.clientY } });
    });

    // Shift+F10 and the Menu key come from the keyboard, so the menu opens on the focused row with its first item focused.
    list.addEventListener('keydown', (event) => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) {
            return;
        }
        const control = event.target instanceof Element ? event.target.closest(MENU_KEYS_SELECTOR) : null;
        const row = control?.closest(ROW_SELECTOR);
        if (!(row instanceof HTMLElement)) {
            return;
        }
        event.preventDefault();
        openRowMenu(row, { keyboard: true });
    });

    list.addEventListener('click', (event) => {
        if (event.target instanceof Element && event.target.closest('.sb-conversation-list-heading-button')) {
            setFavoritesCollapsed(!isFavoritesCollapsed());
            render();
        }
    });

    bindRowDrag(list, {
        rowSelector: ROW_SELECTOR,
        sectionSelector: SECTION_SELECTOR,
        canDrag: () => !isSearching(),
        getSectionOfRow: row => row.closest(SECTION_SELECTOR)?.dataset.section ?? '',
        onDrop: (row, section) => {
            const entry = entryOf(row);
            if (entry && moveToSection(entry, isFavoriteSection(section))) {
                getRowControl(row)?.focus({ preventScroll: true });
            }
        },
        onMenu: (row, point) => openRowMenu(row, { point }),
        onHoldOver: (section) => {
            if (section === SECTION_FAVORITES && isFavoritesCollapsed()) {
                setFavoritesCollapsed(false);
                render();
            }
        },
        announce,
    });
}
