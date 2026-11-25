/**
 * The changes that a row of the conversation list makes to its conversation. Each takes the data module as its first
 * argument, so that tests run it on the real routes and the page gives it `conversationData`.
 */

import { getUnreadMarkerFor } from './conversation-list-model.js';

/** @returns {boolean} False when the conversation is not in the cache. */
export function setConversationFavorite(data, conversationId, favorite) {
    return data.patchConversation(conversationId, { favorite: Boolean(favorite) });
}

/**
 * Notifications are All or Muted. The setting is stored only while it differs from the default, so Unmute removes the key.
 * @returns {boolean} False when the conversation is not in the cache.
 */
export function setConversationMuted(data, conversationId, muted) {
    return data.patchConversation(conversationId, { settings: { notifications_muted: muted ? true : null } });
}

/**
 * Leaves the last message of the conversation unread, in the chat that holds it (the chat that the row's preview shows).
 * The chat is loaded first when it is not, because the marker names a message.
 * @returns {Promise<boolean>} False when the conversation is not in the cache or ends with no message of a character.
 */
export async function markConversationUnread(data, conversationId) {
    const view = data.get(conversationId);
    if (!view) {
        return false;
    }
    const latest = view.chats.reduce((best, entry) => ((entry.lastMessageAt ?? 0) > (best?.lastMessageAt ?? -1) ? entry : best), null);
    if (!latest) {
        return false;
    }
    const address = { conversationId, chatId: latest.id };
    const loaded = data.chat(address) ?? await data.loadChat(address);
    const marker = getUnreadMarkerFor(loaded.messages);
    if (!marker) {
        return false;
    }
    return data.patchConversation(conversationId, { chats: { [latest.id]: marker } });
}
