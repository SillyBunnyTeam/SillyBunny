/**
 * The DOM of the conversation list: a Favorites section (shown only while it holds a row, or while a row is dragged
 * toward it), one section for each folder of the persona, and a Conversations section. A row is built once and kept for as
 * long as its conversation is listed, so a row that changes sections or places keeps its node, its focus and its tab stop.
 * The rows of a closed section are not in the document; the view keeps their nodes for the pass that opens it.
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

/**
 * @typedef {object} ListRowEntry
 * @property {string} id
 * @property {string} name
 * @property {boolean} favorite
 * @property {string} folderId
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

/**
 * @typedef {object} ListLayout
 * @property {readonly import('./conversation-list-model.js').ListFolder[]} folders The folders of the persona in their order.
 * @property {boolean} favoritesExpanded
 */

/** @type {ListLayout} */
const NO_FOLDERS = Object.freeze({ folders: Object.freeze([]), favoritesExpanded: true });

const viewState = { query: '', openKeys: new Set(), movedId: '', movedTimer: 0, scrolledToMovedId: '' };

/** @type {WeakMap<HTMLElement, { rows: Map<string, HTMLElement>, sections: Map<string, HTMLElement>, empty: HTMLElement, status: HTMLElement }>} */
const parts = new WeakMap();

/** @returns {boolean} Whether the query changed. */
export function setConversationListQuery(query) {
    if (viewState.query === query) {
        return false;
    }
    viewState.query = query;
    return true;
}

/**
 * Shows a section open for now, without its stored state changing: the hover of a drag, or a row that an Alt key moved into
 * a closed folder.
 * @returns {boolean} Whether the set of sections that show open for now changed.
 */
export function setTemporaryOpen(key, open) {
    if (viewState.openKeys.has(key) === open) {
        return false;
    }
    viewState.openKeys[open ? 'add' : 'delete'](key);
    return true;
}

export function getTemporaryOpenKeys() {
    return [...viewState.openKeys];
}

/** @returns {boolean} Whether any section was showing open for now. */
export function clearTemporaryOpen() {
    const had = viewState.openKeys.size > 0;
    viewState.openKeys.clear();
    return had;
}

/** What the render must see change besides the data: the query, the sections that show open for now and the row that shows the highlight. */
export function getConversationListViewKey() {
    return [viewState.query, [...viewState.openKeys].sort().join(','), viewState.movedId].join('\u001f');
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

/** The button of a section's heading, which is the control of that row of the list; Conversations has none. */
export function getHeadingControl(list, key) {
    return parts.get(list)?.sections.get(key)?.querySelector('.sb-conversation-list-heading-button') ?? null;
}

function createHeading(kind) {
    const heading = document.createElement('div');
    heading.className = 'sb-conversation-list-heading';
    heading.setAttribute('role', 'heading');
    heading.setAttribute('aria-level', '2');
    if (kind === 'conversations') {
        heading.innerHTML = '<span class="sb-conversation-list-heading-label"></span>';
        return heading;
    }
    // Only a section that opens and closes has a heading that is a button, and so a row of the roving list.
    const folderParts = kind === 'folder' ? '<span class="sb-conversation-list-folder-dot" aria-hidden="true"></span>' : '';
    const count = kind === 'folder' ? '<span class="sb-conversation-list-heading-count"></span>' : '';
    heading.innerHTML = `
        <button type="button" class="sb-conversation-list-heading-button" aria-expanded="true">
            <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
            ${folderParts}
            <span class="sb-conversation-list-heading-label"></span>
            ${count}
            <span class="sb-conversation-list-heading-badge" hidden></span>
        </button>`;
    return heading;
}

function createSection(key, kind) {
    const element = document.createElement('section');
    element.className = 'sb-conversation-list-section';
    element.dataset.section = key;
    element.dataset.kind = kind;
    const heading = createHeading(kind);
    if (kind !== 'conversations') {
        heading.dataset.sbListKey = `heading:${key}`;
    }
    element.append(heading);
    const rows = document.createElement('div');
    rows.className = 'sb-conversation-list-rows';
    rows.setAttribute('role', 'list');
    element.append(rows);
    const hint = document.createElement('p');
    hint.className = 'sb-conversation-list-zone-hint';
    hint.setAttribute('aria-hidden', 'true');
    element.append(hint);
    return element;
}

function sectionTitle(section) {
    if (section.kind === 'folder') {
        return section.folder.name;
    }
    return section.kind === 'favorites' ? 'Favorites' : 'Conversations';
}

function dropHint(section) {
    if (section.kind === 'folder') {
        return `Drop here to add to ${section.folder.name}`;
    }
    return section.kind === 'favorites' ? 'Drop here to add to Favorites' : 'Drop here to remove from its folder';
}

function setText(node, text) {
    if (node.textContent !== text) {
        node.textContent = text;
    }
}

/** The unread number is visible; the word after it is for assistive technology, so the heading's name holds the number in context. */
function writeBadge(badge, unread) {
    badge.replaceChildren(String(unread));
    const word = document.createElement('span');
    word.className = 'sr-only';
    word.textContent = ' unread';
    badge.append(word);
}

function updateHeading(element, section, { hideBadge }) {
    const label = element.querySelector('.sb-conversation-list-heading-label');
    setText(label, sectionTitle(section));
    const button = element.querySelector('.sb-conversation-list-heading-button');
    if (!button) {
        return;
    }
    button.setAttribute('aria-expanded', String(section.expanded));
    button.dataset.collapsible = String(section.collapsible);
    if (section.kind === 'folder') {
        const dot = element.querySelector('.sb-conversation-list-folder-dot');
        if (section.folder.color) {
            dot.style.setProperty('--sb-folder-color', section.folder.color);
        } else {
            dot.style.removeProperty('--sb-folder-color');
        }
        setText(element.querySelector('.sb-conversation-list-heading-count'), String(section.entries.length));
    }
    const badge = button.querySelector('.sb-conversation-list-heading-badge');
    const showBadge = !hideBadge && !section.expanded && section.unread > 0;
    badge.hidden = !showBadge;
    if (showBadge && badge.dataset.unread !== String(section.unread)) {
        badge.dataset.unread = String(section.unread);
        writeBadge(badge, section.unread);
    } else if (!showBadge) {
        delete badge.dataset.unread;
        badge.replaceChildren();
    }
}

function ensureParts(list) {
    let existing = parts.get(list);
    if (existing) {
        return existing;
    }
    // One status page is kept and shown for whichever empty state applies, so its node is not rebuilt on each render.
    const empty = document.createElement('div');
    empty.className = 'sb-conversation-list-empty';
    const status = document.createElement('div');
    empty.append(status);
    existing = { rows: new Map(), sections: new Map(), empty, status };
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

/**
 * Draws the list. Rows are keyed by conversation id and reused; a row that leaves the list is removed. Focus that a
 * move of a node drops is put back on the same control.
 * @param {HTMLElement} list The scroller that holds the sections.
 * @param {ListRowEntry[]} entries In the order of the data module.
 * @param {ListLayout} [layout] The folders of the persona and the open state of Favorites.
 */
export function renderConversationListView(list, entries, layout = NO_FOLDERS) {
    const view = ensureParts(list);
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const model = buildListSections(entries, {
        query: viewState.query,
        folders: layout.folders,
        favoritesExpanded: layout.favoritesExpanded,
        openKeys: viewState.openKeys,
    });

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

    const shownRows = model.sections.reduce((total, section) => total + section.entries.length, 0);
    const noRows = model.searching ? shownRows === 0 : entries.length === 0;
    const keys = new Set(model.sections.map(section => section.key));
    const elements = [];
    for (const section of model.sections) {
        let element = view.sections.get(section.key);
        if (!element) {
            element = createSection(section.key, section.kind);
            view.sections.set(section.key, element);
        }
        elements.push(element);
        placeRows(element.querySelector('.sb-conversation-list-rows'), section.expanded ? section.entries.map(entry => view.rows.get(entry.id)) : []);
        element.dataset.empty = String(section.entries.length === 0);
        element.dataset.collapsed = String(section.collapsible && !section.expanded);
        // Favorites hides while it is empty; Conversations hides while it is empty and the other sections hold the rows,
        // and a search hides every section that holds no match. A list with nothing to show keeps Conversations, which holds the status page.
        const hideWhenEmpty = section.kind === 'favorites'
            || (model.searching && section.kind !== 'conversations')
            || (section.kind === 'conversations' && !noRows && (model.searching || shownRows > 0));
        element.dataset.hideEmpty = String(hideWhenEmpty);
        element.querySelector('.sb-conversation-list-rows').setAttribute('aria-label', sectionTitle(section));
        setText(element.querySelector('.sb-conversation-list-zone-hint'), dropHint(section));
        updateHeading(element.querySelector('.sb-conversation-list-heading'), section, { hideBadge: model.searching });
    }
    for (const [key, element] of view.sections) {
        if (!keys.has(key)) {
            element.remove();
            view.sections.delete(key);
        }
    }
    placeRows(list, elements);
    const conversations = view.sections.get(SECTION_CONVERSATIONS);
    if (conversations.lastElementChild !== view.empty) {
        conversations.append(view.empty);
    }

    for (const [id, row] of view.rows) {
        if (!wanted.has(id)) {
            row.remove();
            view.rows.delete(id);
        }
    }

    const favorites = model.sections.find(section => section.key === SECTION_FAVORITES);
    list.dataset.searching = String(model.searching);
    list.dataset.hasFavorites = String(favorites.entries.length > 0);
    view.empty.hidden = !noRows;
    if (noRows) {
        const title = model.searching ? 'No Conversations Found' : 'Use + to Start a Conversation';
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
