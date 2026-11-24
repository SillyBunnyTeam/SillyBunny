import { getConversationGroupIdForAvatar, getConversationPersonaId, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import { incrementUnreadCount, isConversationActive, notifyNewConversationMessage } from './notifications.js';
import { scheduleConversationMemorySummary } from './prompt.js';
import { scheduleInterfaceRefresh, scheduleConversationListRender } from './render-scheduler.js';
import { conversationState } from './state.js';
import { appendConversationChatMessage, markConversationSeen } from './conversation-store.js';

export async function appendConversationMessage(messageText, { name = getCurrentCharName(), role = 'character', extra = {}, chatId = '', groupId = undefined, personaId = getConversationPersonaId() } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return null;
    }

    const resolvedGroupId = groupId !== undefined ? groupId : getConversationGroupIdForAvatar(avatar);
    const message = appendConversationChatMessage(avatar, {
        role,
        name,
        mes: messageText,
        extra,
    }, { chatId, create: !chatId, groupId: resolvedGroupId, personaId });
    if (!message) {
        return null;
    }

    const isCurrentPersona = personaId === getConversationPersonaId();
    const isIncoming = !['user', 'system'].includes(role);
    const shouldIncrementUnread = isIncoming && !isConversationActive(avatar, resolvedGroupId, { chatId, personaId });
    const shouldNotify = isCurrentPersona && shouldIncrementUnread;
    if (shouldIncrementUnread) {
        incrementUnreadCount(avatar, { chatId, groupId: resolvedGroupId, personaId });
    }
    if (isIncoming) {
        markConversationSeen(avatar, Date.now(), { chatId, groupId: resolvedGroupId, personaId });
    }

    if (isConversationActive(avatar, resolvedGroupId, { chatId, personaId })) {
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
