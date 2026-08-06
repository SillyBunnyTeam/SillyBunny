import { getConversationGroupIdForAvatar, getConversationPersonaId, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import { incrementUnreadCount, isConversationActiveThread, notifyNewConversationMessage } from './notifications.js';
import { scheduleConversationMemorySummary } from './prompt.js';
import { scheduleInterfaceRefresh, schedulePalsRailRender } from './render-scheduler.js';
import { conversationState } from './state.js';
import { appendConversationThreadMessage, markConversationSeen } from './thread-store.js';

export async function appendConversationMessage(messageText, { name = getCurrentCharName(), role = 'character', extra = {}, branchId = '', groupId = undefined, personaId = getConversationPersonaId() } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return null;
    }

    const resolvedGroupId = groupId !== undefined ? groupId : getConversationGroupIdForAvatar(avatar);
    const message = appendConversationThreadMessage(avatar, {
        role,
        name,
        mes: messageText,
        extra,
    }, { branchId, create: !branchId, groupId: resolvedGroupId, personaId });
    if (!message) {
        return null;
    }

    const isCurrentPersona = personaId === getConversationPersonaId();
    const isIncoming = !['user', 'system'].includes(role);
    const shouldIncrementUnread = isIncoming && !isConversationActiveThread(avatar, resolvedGroupId, { branchId, personaId });
    const shouldNotify = isCurrentPersona && shouldIncrementUnread;
    if (shouldIncrementUnread) {
        incrementUnreadCount(avatar, { branchId, groupId: resolvedGroupId, personaId });
    }
    if (isIncoming) {
        markConversationSeen(avatar, Date.now(), { branchId, groupId: resolvedGroupId, personaId });
    }

    if (isConversationActiveThread(avatar, resolvedGroupId, { branchId, personaId })) {
        scheduleInterfaceRefresh({ syncControls: false });
    } else if (conversationState.conversationWorkspaceOpen) {
        schedulePalsRailRender();
    }

    if (isCurrentPersona) {
        notifyNewConversationMessage(avatar, message, shouldNotify, { branchId, groupId: resolvedGroupId, personaId });
    }
    scheduleConversationMemorySummary(avatar, { branchId, groupId: resolvedGroupId, personaId });

    return message;
}
