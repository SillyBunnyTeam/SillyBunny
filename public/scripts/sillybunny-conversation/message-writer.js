import { getConversationGroupIdForAvatar, getConversationPersonaId, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import { isConversationActive, markConversationRead, notifyNewConversationMessage } from './notifications.js';
import { scheduleConversationMemorySummary } from './prompt.js';
import { scheduleInterfaceRefresh, scheduleConversationListRender } from './render-scheduler.js';
import { conversationState } from './state.js';
import { appendConversationChatMessage, ensureConversationChatLoaded, markConversationSeen } from './conversation-store.js';

export async function appendConversationMessage(messageText, { name = getCurrentCharName(), role = 'character', extra = {}, chatId = '', groupId = undefined, personaId = getConversationPersonaId() } = {}, avatar = getCurrentCharAvatar()) {
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
    }, { chatId, groupId: resolvedGroupId, personaId });
    if (!message) {
        return null;
    }

    const isCurrentPersona = personaId === getConversationPersonaId();
    const isIncoming = !['user', 'system'].includes(role);
    const isActive = isConversationActive(avatar, resolvedGroupId, { chatId, personaId });
    const shouldNotify = isCurrentPersona && isIncoming && !isActive;
    // A message that arrives in the chat that is open counts as read; one that arrives elsewhere stays unread until it is opened.
    if (isIncoming && isActive) {
        void markConversationRead(avatar, { chatId: address.chatId, groupId: resolvedGroupId, personaId });
    }
    if (isIncoming) {
        markConversationSeen(avatar, Date.now(), { chatId, groupId: resolvedGroupId, personaId });
    }

    if (isActive) {
        scheduleInterfaceRefresh({ syncControls: false });
    } else if (conversationState.conversationWorkspaceOpen) {
        scheduleConversationListRender();
    }

    if (isCurrentPersona) {
        notifyNewConversationMessage(avatar, message, shouldNotify, { chatId, groupId: resolvedGroupId, personaId });
    }
    scheduleConversationMemorySummary(avatar, { chatId, groupId: resolvedGroupId, personaId });

    return message;
}
