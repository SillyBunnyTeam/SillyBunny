/**
 * What the conversation list shows and what its actions decide, with no DOM and no page imports, so that tests run it
 * as it is. The list has two sections: Favorites (kept only while it holds a row) and Conversations. Each keeps the
 * order the data module gives, newest message first, so a row never has a place of its own to drop into. The name of a
 * conversation and the line under it in the header are decided here too, so that the list and the header cannot differ.
 */

import { isPendingServerReply } from './pending-reply.js';

export const SECTION_FAVORITES = 'favorites';
export const SECTION_CONVERSATIONS = 'conversations';

/**
 * @typedef {object} ListEntry
 * @property {string} id The conversation id; it keys the row.
 * @property {string} name
 * @property {boolean} favorite
 * @property {boolean} muted
 * @property {number} unread Messages after the read marker, over all chats.
 * @property {string} lastMessageRole The role of the last message of the conversation, empty when there is none.
 * @property {boolean} active The conversation is the one open in the workspace.
 */

/**
 * @param {ListEntry[]} entries In the order of the data module.
 * @param {{ query?: string }} [options]
 * @returns {{ searching: boolean, favorites: ListEntry[], conversations: ListEntry[] }}
 * While a search filters, the matches are one list in Conversations, favourites among them, and `searching` turns the
 * drag off: a section that shows only part of its rows has no place that a drop could mean.
 */
export function buildListSections(entries, { query = '' } = {}) {
    const needle = String(query).trim().toLowerCase();
    if (!needle) {
        return {
            searching: false,
            favorites: entries.filter(entry => entry.favorite),
            conversations: entries.filter(entry => !entry.favorite),
        };
    }
    return {
        searching: true,
        favorites: [],
        conversations: entries.filter(entry => entry.name.toLowerCase().includes(needle)),
    };
}

/**
 * The section that Alt with an arrow key names. Up and to the first place go to the section above (Favorites), down
 * and to the last place go to the section below.
 * @param {number} direction -1, 1, -Infinity or Infinity, as `bindListKeyboard` passes it.
 */
export function getSectionForMove(direction) {
    return direction < 0 ? SECTION_FAVORITES : SECTION_CONVERSATIONS;
}

export function isFavoriteSection(section) {
    return section === SECTION_FAVORITES;
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
