/**
 * What deleting messages from a conversation chat has to keep true besides the messages themselves. The functions take
 * the data module and the send queue as arguments, so that a test reaches them without a page.
 */

import { removeQueueItems } from './deletion-guards.js';

/**
 * The read marker that stays valid after messages are deleted. A marker that names a deleted message would make the
 * summary count every message as read (`summarizeChat` treats an unknown id as "all read"), so it moves back to the
 * nearest earlier message that stays. The messages after the old marker stay unread.
 * @param {{ id: string }[]} messages The messages before the deletion.
 * @param {string} readThrough The id the chat has now. Empty means that nothing was read.
 * @param {Iterable<string>} deletedIds
 * @returns {string} The id to keep, or an empty string when no earlier message stays.
 */
export function getReadThroughAfterDeletion(messages, readThrough, deletedIds) {
    const doomed = new Set(deletedIds);
    if (!readThrough || !doomed.has(readThrough)) {
        return readThrough;
    }
    const markerIndex = messages.findIndex(message => message.id === readThrough);
    for (let index = markerIndex - 1; index >= 0; index--) {
        if (!doomed.has(messages[index].id)) {
            return messages[index].id;
        }
    }
    return '';
}

/**
 * Removes, in place, the queued items that a deleted message triggered. Such an item would answer a message that no
 * longer exists, and the queue's own check of its trigger messages cannot tell a deleted message from an edited one.
 * @param {{ messageIds?: string[], chatId?: string }[]} queue
 * @param {{ chatId: string, messageIds: Iterable<string> }} deletion
 * @returns {object[]} The items that were removed.
 */
export function dropQueueItemsOfDeletedMessages(queue, { chatId, messageIds }) {
    const doomed = new Set(messageIds);
    if (!doomed.size) {
        return [];
    }
    return removeQueueItems(queue, item => item?.chatId === chatId && Array.isArray(item.messageIds) && item.messageIds.some(id => doomed.has(String(id))));
}

/**
 * Deletes messages from a loaded chat in one commit, on purpose: the save carries `allowShrink`, so the server's guard
 * against an accidental empty save lets it through. The read marker moves first, so that the summary the commit
 * recomputes (preview, count, unread) is right at once and once.
 * @param {ReturnType<typeof import('./conversation-data.js').createConversationData>} data
 * @param {{ conversationId: string, chatId: string }} address
 * @param {Iterable<string>} messageIds
 * @returns {string[]} The ids that were in the chat and are gone, in the order of the chat.
 */
export function removeChatMessages(data, address, messageIds) {
    const loaded = data.chat(address);
    if (!loaded) {
        return [];
    }
    const requested = new Set(messageIds);
    const removed = loaded.messages.filter(message => requested.has(message.id)).map(message => message.id);
    if (!removed.length) {
        return [];
    }

    const doomed = new Set(removed);
    const entry = data.get(address.conversationId)?.chats.find(item => item.id === address.chatId);
    const readThrough = getReadThroughAfterDeletion(loaded.messages, entry?.readThrough ?? '', doomed);
    if (entry && readThrough !== (entry.readThrough ?? '')) {
        data.patchConversation(address.conversationId, { chats: { [address.chatId]: { readThrough } } });
    }
    data.commitChat(address, (draft) => {
        draft.messages.splice(0, draft.messages.length, ...draft.messages.filter(message => !doomed.has(message.id)));
    }, { shrink: true });
    return removed;
}
