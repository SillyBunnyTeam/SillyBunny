/**
 * What the conversation list shows and what its actions decide, with no DOM and no page imports, so that tests run it
 * as it is. The list has the sections Favorites (kept only while it holds a row), one section per folder of the persona
 * in their stored order, and Conversations. A conversation is in one of them: Favorites if it is a favourite (it keeps its
 * folder, to which it returns when it is not one any more), else its folder, else Conversations. Each section keeps the
 * order the data module gives, newest message first, so a row never has a place of its own to drop into. The name of a
 * conversation and the line under it in the header are decided here too, so that the list and the header cannot differ.
 */

import { isPendingServerReply } from './pending-reply.js';

export const SECTION_FAVORITES = 'favorites';
export const SECTION_CONVERSATIONS = 'conversations';
const FOLDER_SECTION_PREFIX = 'folder:';

/** @param {string} folderId */
export function folderSectionKey(folderId) {
    return `${FOLDER_SECTION_PREFIX}${folderId}`;
}

/** @returns {string} The folder id of a section key, or an empty string for Favorites and Conversations. */
export function folderIdOfSection(key) {
    return typeof key === 'string' && key.startsWith(FOLDER_SECTION_PREFIX) ? key.slice(FOLDER_SECTION_PREFIX.length) : '';
}

/**
 * @typedef {object} ListEntry
 * @property {string} id The conversation id; it keys the row.
 * @property {string} name
 * @property {boolean} favorite
 * @property {string} folderId The id of the folder that holds the conversation, empty for none. It names a folder of the
 * persona, which the data layer checks, so that nothing here has to.
 * @property {boolean} muted
 * @property {number} unread Messages after the read marker, over all chats.
 * @property {string} lastMessageRole The role of the last message of the conversation, empty when there is none.
 * @property {boolean} active The conversation is the one open in the workspace.
 */

/**
 * @typedef {{ id: string, name: string, color: string, expanded: boolean }} ListFolder
 * @typedef {object} ListSection
 * @property {string} key `favorites`, `folder:<id>` or `conversations`.
 * @property {'favorites'|'folder'|'conversations'} kind
 * @property {ListFolder|null} folder
 * @property {ListEntry[]} entries
 * @property {boolean} expanded Whether its rows show. A search opens every section that it shows.
 * @property {boolean} collapsible Whether its heading is a button. Not while a search filters.
 * @property {number} unread The unread messages of the rows it holds, those of muted conversations left out.
 * @property {boolean} visible Whether the section shows when no row is dragged. Favorites hides while it is empty; a folder
 * and Conversations always show, except while a search filters and they hold no match.
 */

/** The keys of the sections in the order of the list, which is the order that Alt+Up and Alt+Down walk. */
export function getSectionKeys(folders) {
    return [SECTION_FAVORITES, ...folders.map(folder => folderSectionKey(folder.id)), SECTION_CONVERSATIONS];
}

/** @param {Pick<ListEntry, 'favorite' | 'folderId'>} entry */
export function getEntrySectionKey({ favorite, folderId }) {
    if (favorite) {
        return SECTION_FAVORITES;
    }
    return folderId ? folderSectionKey(folderId) : SECTION_CONVERSATIONS;
}

function sumUnread(entries) {
    return entries.reduce((total, entry) => total + (entry.muted ? 0 : entry.unread), 0);
}

/**
 * @param {ListEntry[]} entries In the order of the data module.
 * @param {{ query?: string, folders?: ListFolder[], favoritesExpanded?: boolean, openKeys?: Iterable<string> }} [options]
 * `openKeys` are the sections that show open for now without their stored state changing (a hover during a drag, a row that
 * an Alt key just moved into a closed folder).
 * @returns {{ searching: boolean, sections: ListSection[] }}
 * While a search filters, the sections hold only the matches, those with none are not visible, every section that shows is
 * open and its heading does not toggle, and `searching` turns the drag off: a section that shows only part of its rows has
 * no place that a drop could mean.
 */
export function buildListSections(entries, { query = '', folders = [], favoritesExpanded = true, openKeys = [] } = {}) {
    const needle = String(query).trim().toLowerCase();
    const searching = needle !== '';
    const shown = searching ? entries.filter(entry => entry.name.toLowerCase().includes(needle)) : entries;
    const forcedOpen = new Set(openKeys);
    const byFolder = new Map(folders.map(folder => [folder.id, []]));
    const favorites = [];
    const unfiled = [];
    for (const entry of shown) {
        if (entry.favorite) {
            favorites.push(entry);
        } else if (byFolder.has(entry.folderId)) {
            byFolder.get(entry.folderId).push(entry);
        } else {
            unfiled.push(entry);
        }
    }
    const make = (key, kind, folder, rows, storedOpen) => ({
        key,
        kind,
        folder,
        entries: rows,
        expanded: searching || storedOpen || forcedOpen.has(key),
        collapsible: kind !== 'conversations' && !searching,
        unread: sumUnread(rows),
        visible: searching ? rows.length > 0 : kind !== 'favorites' || rows.length > 0,
    });
    return {
        searching,
        sections: [
            make(SECTION_FAVORITES, 'favorites', null, favorites, favoritesExpanded),
            ...folders.map(folder => make(folderSectionKey(folder.id), 'folder', folder, byFolder.get(folder.id), folder.expanded)),
            make(SECTION_CONVERSATIONS, 'conversations', null, unfiled, true),
        ],
    };
}

/**
 * What a move of a row to a section changes: the favourite flag and the folder. To Favorites keeps the folder, to a folder
 * clears the flag and sets the folder, to Conversations clears both.
 * @param {Pick<ListEntry, 'favorite' | 'folderId'>} entry
 * @param {string} targetKey The key of a section.
 * @returns {{ favorite: boolean, folderId: string } | null} Null when the row is there already, or the key is no section.
 */
export function planSectionMove(entry, targetKey) {
    const folderId = folderIdOfSection(targetKey);
    let plan;
    if (targetKey === SECTION_FAVORITES) {
        plan = { favorite: true, folderId: entry.folderId };
    } else if (targetKey === SECTION_CONVERSATIONS) {
        plan = { favorite: false, folderId: '' };
    } else if (folderId) {
        plan = { favorite: false, folderId };
    } else {
        return null;
    }
    return plan.favorite === (entry.favorite === true) && plan.folderId === entry.folderId ? null : plan;
}

/**
 * The section that Alt with an arrow key names: the neighbour above or below in the order of the list, or its first or
 * last place for Home and End.
 * @param {string[]} keys The keys of the sections, as `getSectionKeys()` gives them.
 * @param {string} currentKey The section that the row is in.
 * @param {number} direction -1, 1, -Infinity or Infinity, as `bindListKeyboard` passes it.
 * @returns {string | null} Null when the row is at that end already, or its section is not in the list.
 */
export function adjacentSectionKey(keys, currentKey, direction) {
    const index = keys.indexOf(currentKey);
    if (index < 0) {
        return null;
    }
    const target = direction === Infinity ? keys.length - 1 : direction === -Infinity ? 0 : Math.max(0, Math.min(keys.length - 1, index + Math.sign(direction)));
    return target === index ? null : keys[target];
}

/**
 * The live-region text of a move between sections.
 * @param {Pick<ListEntry, 'name' | 'favorite'>} entry
 * @param {{ favorite: boolean, folderId: string }} plan
 * @param {ListFolder[]} folders
 */
export function describeSectionMove(entry, plan, folders) {
    const folder = folders.find(candidate => candidate.id === plan.folderId);
    if (plan.favorite) {
        return `${entry.name} added to Favorites`;
    }
    if (folder) {
        return `${entry.name} moved to ${folder.name}`;
    }
    return entry.favorite ? `${entry.name} removed from Favorites` : `${entry.name} moved to Conversations`;
}

/**
 * What "Move to Folder" changes: the folder only, so a favourite stays in Favorites and the text says why the row did not move.
 * @param {Pick<ListEntry, 'folderId'>} entry
 * @param {string} folderId The new folder, empty for none.
 * @returns {{ folderId: string } | null} Null when the row has that folder already.
 */
export function planFolderChange(entry, folderId) {
    return entry.folderId === folderId ? null : { folderId };
}

/**
 * @param {Pick<ListEntry, 'name' | 'favorite'>} entry
 * @param {string} folderId
 * @param {ListFolder[]} folders
 */
export function describeFolderChange(entry, folderId, folders) {
    const folder = folders.find(candidate => candidate.id === folderId);
    const where = folder ? `moved to ${folder.name}` : 'moved out of its folder';
    if (entry.favorite) {
        return `${entry.name} ${where}, and stays in Favorites`;
    }
    return folder ? `${entry.name} moved to ${folder.name}` : `${entry.name} moved to Conversations`;
}

/**
 * The name of a conversation: the one it was given, else its members' names (a group), else its character. The active
 * chat's name is not the name of the conversation.
 * @param {{ name?: string, isGroup: boolean, memberNames: string[], characterName: string }} source
 */
export function resolveConversationName({ name, isGroup, memberNames, characterName }) {
    if (name) {
        return name;
    }
    return isGroup && memberNames.length ? memberNames.join(', ') : characterName || 'Character';
}

/**
 * The line under the name in the conversation header. Someone writing replaces it; otherwise a group shows its
 * description and a direct conversation shows what its character is doing.
 * @param {{ typingNames?: string[], isGroup: boolean, description?: string, status?: { label: string, activity?: string, delayed?: boolean } | null }} source
 */
export function describeHeaderSubtitle({ typingNames = [], isGroup, description = '', status = null }) {
    if (typingNames.length > 2) {
        return 'Several People Are Typing…';
    }
    if (typingNames.length === 2) {
        return `${typingNames.join(', ')} Are Writing…`;
    }
    if (typingNames.length === 1) {
        return `${typingNames[0]} Is Writing…`;
    }
    if (isGroup) {
        return description.trim();
    }
    if (!status) {
        return '';
    }
    return [status.label, status.activity, status.delayed ? 'replies may be delayed' : ''].filter(Boolean).join(' · ');
}

/** The name that a screen reader reads for a row: the name, then what the row shows only by a badge or an icon. */
export function describeConversationRow({ name, unread, muted }) {
    return [name, unread > 0 ? `${unread} Unread` : '', muted ? 'Muted' : ''].filter(Boolean).join(', ');
}

/**
 * Which of the two read items a row's menu offers. A row with unread messages offers Mark as Read. A read row offers
 * Mark as Unread only when it ends with a message from a character, which is the message to mark, and is not the open
 * conversation, because the open one is read again as soon as it is shown.
 * @param {Pick<ListEntry, 'unread' | 'lastMessageRole' | 'active'>} entry
 * @returns {'read' | 'unread' | null}
 */
export function getReadToggle({ unread, lastMessageRole, active }) {
    if (unread > 0) {
        return 'read';
    }
    if (active) {
        return null;
    }
    return lastMessageRole === 'character' || lastMessageRole === 'member' ? 'unread' : null;
}

function isLineFromCharacter(message) {
    const isUser = message.is_user === true || message.role === 'user';
    const isSystem = message.is_system === true || message.role === 'system';
    return !isUser && !isSystem;
}

/**
 * The read marker that leaves the last message of a chat unread: the id of the message before it. An empty marker means
 * that nothing was read, which is the answer when the last message is also the first. A reply that the server wrote and
 * no page has split yet is not a message to mark, as for `markRead` in `conversation-data.js`.
 * @param {Record<string, any>[]} messages
 * @returns {{ readThrough: string } | null} Null when the chat ends with a message of the user or the system, or is empty.
 */
export function getUnreadMarkerFor(messages) {
    let lastIndex = messages.length - 1;
    while (lastIndex >= 0 && isPendingServerReply(messages[lastIndex])) {
        lastIndex--;
    }
    if (lastIndex < 0 || !isLineFromCharacter(messages[lastIndex])) {
        return null;
    }
    return { readThrough: messages[lastIndex - 1]?.id ?? '' };
}
