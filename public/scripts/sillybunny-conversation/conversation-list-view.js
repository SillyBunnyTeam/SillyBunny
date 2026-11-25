/**
 * The DOM of the conversation list: a Favorites section (shown only while it holds a row, or while a row is dragged
 * toward it) and a Conversations section. A row is built once and kept for as long as its conversation is listed, so a
 * row that changes sections or places keeps its node, its focus and its tab stop.
 */

import { createStatusPage } from '../sillybunny-editor/status-page.js';
import { renderConversationParticipantStack } from './media.js';
import {
    SECTION_CONVERSATIONS,
    SECTION_FAVORITES,
    buildListSections,
    describeConversationRow,
} from './conversation-list-model.js';

const MOVED_HIGHLIGHT_MS = 1600;
const HEADINGS = Object.freeze({ [SECTION_FAVORITES]: 'Favorites', [SECTION_CONVERSATIONS]: 'Conversations' });

/**
 * @typedef {object} ListRowEntry
 * @property {string} id
 * @property {string} name
 * @property {boolean} favorite
 * @property {boolean} muted
 * @property {number} unread
 * @property {string} badge The unread count as the badge writes it.
 * @property {string} preview
 * @property {string} lastMessageRole
 * @property {boolean} active
 * @property {string} avatar The avatar file of the character that anchors the conversation.
 * @property {string} characterIndex
 * @property {string} groupId
 * @property {object[]} participants
 * @property {string} status
 */

const viewState = { query: '', favoritesCollapsed: false, movedId: '', movedTimer: 0, scrolledToMovedId: '' };

/** @type {WeakMap<HTMLElement, { rows: Map<string, HTMLElement>, sections: Record<string, HTMLElement>, empty: HTMLElement, status: HTMLElement }>} */
const parts = new WeakMap();

/** @returns {boolean} Whether the query changed. */
export function setConversationListQuery(query) {
    if (viewState.query === query) {
        return false;
    }
    viewState.query = query;
    return true;
}

export function isFavoritesCollapsed() {
    return viewState.favoritesCollapsed;
}

export function setFavoritesCollapsed(collapsed) {
    viewState.favoritesCollapsed = Boolean(collapsed);
}

/** What the render must see change besides the data: the query, the collapsed section and the row that shows the highlight. */
export function getConversationListViewKey() {
    return [viewState.query, viewState.favoritesCollapsed ? '1' : '0', viewState.movedId].join('\u001f');
}

/** Gives a row that has just moved a short highlight. The class falls off by itself; the list need not render again. */
export function highlightMovedRow(list, id) {
    clearTimeout(viewState.movedTimer);
    viewState.movedId = id;
    viewState.scrolledToMovedId = '';
    list.querySelector('.is-just-moved')?.classList.remove('is-just-moved');
    findRow(list, id)?.classList.add('is-just-moved');
    viewState.movedTimer = setTimeout(() => {
        viewState.movedId = '';
        list.querySelector('.is-just-moved')?.classList.remove('is-just-moved');
    }, MOVED_HIGHLIGHT_MS);
}

export function findRow(list, id) {
    return parts.get(list)?.rows.get(id) ?? null;
}

/** The control of a row that takes focus: the row's button. */
export function getRowControl(row) {
    return row?.querySelector('.sb-conversation-list-item') ?? null;
}

function createHeading(section) {
    const heading = document.createElement('div');
    heading.className = 'sb-conversation-list-heading';
    heading.setAttribute('role', 'heading');
    heading.setAttribute('aria-level', '2');
    if (section === SECTION_FAVORITES) {
        // Only Favorites collapses, so only its heading is a row of the roving list; the other heading is a label.
        heading.dataset.sbListKey = 'heading:favorites';
        heading.innerHTML = `
            <button type="button" class="sb-conversation-list-heading-button" aria-expanded="true">
                <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                <span class="sb-conversation-list-heading-label"></span>
                <span class="sb-conversation-list-heading-badge" aria-hidden="true" hidden></span>
            </button>`;
    } else {
        heading.innerHTML = '<span class="sb-conversation-list-heading-label"></span>';
    }
    heading.querySelector('.sb-conversation-list-heading-label').textContent = HEADINGS[section];
    return heading;
}

function createSection(section) {
    const element = document.createElement('section');
    element.className = 'sb-conversation-list-section';
    element.dataset.section = section;
    element.append(createHeading(section));
    const rows = document.createElement('div');
    rows.className = 'sb-conversation-list-rows';
    rows.setAttribute('role', 'list');
    rows.setAttribute('aria-label', HEADINGS[section]);
    element.append(rows);
    if (section === SECTION_FAVORITES) {
        const hint = document.createElement('p');
        hint.className = 'sb-conversation-list-zone-hint';
        hint.textContent = 'Drop here to add to Favorites';
        element.append(hint);
    }
    return element;
}

function ensureParts(list) {
    let existing = parts.get(list);
    if (existing) {
        return existing;
    }
    const sections = {
        [SECTION_FAVORITES]: createSection(SECTION_FAVORITES),
        [SECTION_CONVERSATIONS]: createSection(SECTION_CONVERSATIONS),
    };
    // One status page is kept and shown for whichever empty state applies, so its node is not rebuilt on each render.
    const empty = document.createElement('div');
    empty.className = 'sb-conversation-list-empty';
    const status = document.createElement('div');
    empty.append(status);
    sections[SECTION_CONVERSATIONS].append(empty);
    list.replaceChildren(sections[SECTION_FAVORITES], sections[SECTION_CONVERSATIONS]);
    existing = { rows: new Map(), sections, empty, status };
    parts.set(list, existing);
    return existing;
}

function createRow() {
    const row = document.createElement('div');
    row.className = 'sb-conversation-list-row';
    row.setAttribute('role', 'listitem');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-conversation-list-item';
    button.innerHTML = `
        <span class="sb-conversation-list-item-avatar"></span>
        <span class="sb-conversation-list-item-copy">
            <span class="sb-conversation-list-item-name-row">
                <span class="sb-conversation-list-item-name"></span>
                <i class="fa-solid fa-bell-slash sb-conversation-list-item-muted" aria-hidden="true" hidden></i>
            </span>
            <span class="sb-conversation-list-item-preview"></span>
        </span>
        <span class="sb-conversation-list-item-unread" aria-hidden="true"></span>`;
    row.append(button);
    return row;
}

function participantsKey(entry) {
    return [entry.status, ...entry.participants.map(participant => `${participant?.avatar || ''}:${participant?.name || ''}`)].join('|');
}

function updateRow(row, entry) {
    row.dataset.conversationId = entry.id;
    row.dataset.sbListKey = entry.id;
    row.classList.toggle('is-selected', entry.active);
    row.classList.toggle('is-just-moved', viewState.movedId === entry.id);
    const button = getRowControl(row);
    button.dataset.avatar = entry.avatar;
    button.dataset.characterIndex = entry.characterIndex;
    button.dataset.groupId = entry.groupId;
    button.dataset.unread = String(entry.unread > 0);
    button.dataset.muted = String(entry.muted);
    button.setAttribute('aria-current', String(entry.active));
    // A row with nothing to report is named by its own text, so its preview is read with it.
    if (entry.unread > 0 || entry.muted) {
        button.setAttribute('aria-label', describeConversationRow(entry));
    } else {
        button.removeAttribute('aria-label');
    }
    const stack = button.querySelector('.sb-conversation-list-item-avatar');
    const key = participantsKey(entry);
    if (stack.dataset.sbParticipants !== key) {
        stack.dataset.sbParticipants = key;
        renderConversationParticipantStack(stack, entry.participants, { status: entry.status, max: 3, groupId: entry.groupId });
    }
    button.querySelector('.sb-conversation-list-item-name').textContent = entry.name;
    button.querySelector('.sb-conversation-list-item-muted').hidden = !entry.muted;
    button.querySelector('.sb-conversation-list-item-preview').textContent = entry.preview;
    const badge = button.querySelector('.sb-conversation-list-item-unread');
    badge.textContent = entry.badge;
    badge.hidden = entry.unread <= 0;
}

/**
 * Puts `rows` in a container in the given order with the fewest moves; a row that is already in place is not touched.
 * Rows that remain after the last one leave the container but are not destroyed: the view keeps them for the pass that
 * shows them again.
 */
function placeRows(container, rows) {
    let cursor = container.firstElementChild;
    for (const row of rows) {
        if (row === cursor) {
            cursor = cursor.nextElementSibling;
        } else {
            container.insertBefore(row, cursor);
        }
    }
    while (cursor) {
        const next = cursor.nextElementSibling;
        cursor.remove();
        cursor = next;
    }
}

function updateFavoritesHeading(section, entries, collapsed) {
    const button = section.querySelector('.sb-conversation-list-heading-button');
    button.setAttribute('aria-expanded', String(!collapsed));
    const unread = entries.reduce((total, entry) => total + (entry.muted ? 0 : entry.unread), 0);
    const badge = button.querySelector('.sb-conversation-list-heading-badge');
    badge.textContent = collapsed && unread > 0 ? String(unread) : '';
    badge.hidden = !(collapsed && unread > 0);
}

/**
 * Draws the list. Rows are keyed by conversation id and reused; a row that leaves the list is removed. Focus that a
 * move of a node drops is put back on the same control.
 * @param {HTMLElement} list The scroller that holds the sections.
 * @param {ListRowEntry[]} entries In the order of the data module.
 */
export function renderConversationListView(list, entries) {
    const view = ensureParts(list);
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const sections = buildListSections(entries, { query: viewState.query });

    const wanted = new Set();
    for (const entry of entries) {
        let row = view.rows.get(entry.id);
        if (!row) {
            row = createRow();
            view.rows.set(entry.id, row);
        }
        wanted.add(entry.id);
        updateRow(row, entry);
    }
    for (const section of [SECTION_FAVORITES, SECTION_CONVERSATIONS]) {
        const shown = sections[section];
        const element = view.sections[section];
        placeRows(element.querySelector('.sb-conversation-list-rows'), shown.map(entry => view.rows.get(entry.id)));
        element.dataset.empty = String(shown.length === 0);
        element.dataset.collapsed = String(section === SECTION_FAVORITES && viewState.favoritesCollapsed);
    }
    for (const [id, row] of view.rows) {
        if (!wanted.has(id)) {
            row.remove();
            view.rows.delete(id);
        }
    }
    updateFavoritesHeading(view.sections[SECTION_FAVORITES], sections.favorites, viewState.favoritesCollapsed);

    list.dataset.searching = String(sections.searching);
    list.dataset.hasFavorites = String(sections.favorites.length > 0);
    const noRows = sections.favorites.length + sections.conversations.length === 0;
    view.empty.hidden = !noRows;
    if (noRows) {
        const title = sections.searching ? 'No Conversations Found' : 'Use + to Start a Conversation';
        const current = view.status.firstElementChild;
        if (current?.dataset.sbListEmptyTitle !== title) {
            const page = createStatusPage({ state: 'empty', icon: 'comments', title, compact: true }).element;
            page.dataset.sbListEmptyTitle = title;
            view.status.replaceChildren(page);
        }
    }

    if (focused && focused.isConnected && document.activeElement !== focused) {
        focused.focus({ preventScroll: true });
    }
    // A move of sections can leave the row outside the scrolled part of the list, with nothing to show where it went.
    const moved = viewState.movedId && viewState.scrolledToMovedId !== viewState.movedId ? view.rows.get(viewState.movedId) : null;
    if (moved?.isConnected) {
        viewState.scrolledToMovedId = viewState.movedId;
        moved.scrollIntoView?.({ block: 'nearest' });
    }
}
