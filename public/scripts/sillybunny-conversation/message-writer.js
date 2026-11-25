import { getConversationGroupIdForAvatar, getConversationPersonaId, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import { isConversationActive, markConversationRead, notifyNewConversationMessage } from './notifications.js';
import { scheduleConversationMemorySummary } from './prompt.js';
import { conversationData } from './conversation-data-browser.js';
import { scheduleInterfaceRefresh, scheduleConversationListRender } from './render-scheduler.js';
import { conversationState } from './state.js';
import { appendConversationChatMessage, ensureConversationChatLoaded, markConversationSeen } from './conversation-store.js';

export async function appendConversationMessage(messageText, { name = getCurrentCharName(), role = 'character', extra = {}, chatId = '', groupId = undefined, personaId = getConversationPersonaId(), id = '' } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return null;
    }

    const resolvedGroupId = groupId !== undefined ? groupId : getConversationGroupIdForAvatar(avatar);
    // The chat may be one that the page has not opened, such as a reply or a reminder for a conversation in the list.
    const address = await ensureConversationChatLoaded(avatar, { chatId, groupId: resolvedGroupId, personaId });
    if (!address) {
        return null;
    }
    const message = appendConversationChatMessage(avatar, {
        role,
        name,
        mes: messageText,
        extra,
        id,
    }, { chatId, groupId: resolvedGroupId, personaId });
    if (!message) {
        return null;
    }

    afterIncomingMessage(avatar, message, { chatId, groupId: resolvedGroupId, personaId, address });
    // A hidden page can be closed at any moment, and a page that is closing sends only requests that carry the keepalive
    // flag. The data module already flushed when the page became hidden; a message that arrives after that needs its own.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        void conversationData.flush({ keepalive: true });
    }
    return message;
}

/**
 * What the page does once a message is in its loaded chat: the read marker, the time it was seen, the redraw, the
 * notification and the memory summary. A message that arrives in the open chat counts as read; one that arrives
 * elsewhere stays unread until the chat is opened. The live path runs this after each bubble it writes. A reply that
 * the server wrote lands as several bubbles at once, so its caller notifies for the last bubble only and schedules the
 * memory summary once, through `notify` and `scheduleMemory`.
 * @param {string} avatar The avatar that names the conversation.
 * @param {{ role?: string }} message The message that was added.
 * @param {object} context
 * @param {{ chatId: string }} context.address The chat that holds the message.
 * @param {string} [context.chatId] The chat id as the caller named it; empty for the active chat.
 * @param {string} [context.groupId]
 * @param {string} [context.personaId]
 * @param {boolean} [context.notify] Whether a message in a chat that is not open raises a sound and a toast.
 * @param {boolean} [context.scheduleMemory]
 */
export function afterIncomingMessage(avatar, message, { address, chatId = '', groupId = undefined, personaId = getConversationPersonaId(), notify = true, scheduleMemory = true }) {
    const isCurrentPersona = personaId === getConversationPersonaId();
    const isIncoming = !['user', 'system'].includes(message.role);
    const isActive = isConversationActive(avatar, groupId, { chatId, personaId });
    const shouldNotify = notify && isCurrentPersona && isIncoming && !isActive;
    if (isIncoming && isActive) {
        void markConversationRead(avatar, { chatId: address.chatId, groupId, personaId });
    }
    if (isIncoming) {
        markConversationSeen(avatar, Date.now(), { chatId, groupId, personaId });
    }

    if (isActive) {
        scheduleInterfaceRefresh({ syncControls: false });
    } else if (conversationState.conversationWorkspaceOpen) {
        scheduleConversationListRender();
    }

    if (isCurrentPersona) {
        notifyNewConversationMessage(avatar, message, shouldNotify, { chatId, groupId, personaId });
    }
    if (scheduleMemory) {
        scheduleConversationMemorySummary(avatar, { chatId, groupId, personaId });
    }
}
