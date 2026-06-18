import { getConversationGroupIdForAvatar, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import { incrementUnreadCount, isConversationActiveThread, notifyNewConversationMessage } from './notifications.js';
import { scheduleConversationMemorySummary } from './prompt.js';
import { scheduleInterfaceRefresh, schedulePalsRailRender } from './render-scheduler.js';
import { conversationState } from './state.js';
import { appendConversationThreadMessage, markConversationSeen } from './thread-store.js';

export async function appendConversationMessage(messageText, { name = getCurrentCharName(), role = 'character', extra = {}, groupId = undefined } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return null;
    }

    const resolvedGroupId = groupId !== undefined ? groupId : getConversationGroupIdForAvatar(avatar);
    const message = appendConversationThreadMessage(avatar, {
        role,
        name,
        mes: messageText,
        extra,
    }, { groupId: resolvedGroupId });
    if (!message) {
        return null;
    }

    const shouldNotify = !['user', 'system'].includes(role) && !isConversationActiveThread(avatar, resolvedGroupId);
    if (shouldNotify) {
        incrementUnreadCount(avatar, { groupId: resolvedGroupId });
    }
    if (!['user', 'system'].includes(role)) {
        markConversationSeen(avatar, Date.now(), { groupId: resolvedGroupId });
    }

    if (isConversationActiveThread(avatar, resolvedGroupId)) {
        scheduleInterfaceRefresh({ syncControls: false });
    } else if (conversationState.conversationWorkspaceOpen) {
        schedulePalsRailRender();
    }

    notifyNewConversationMessage(avatar, message, shouldNotify, { groupId: resolvedGroupId });
    scheduleConversationMemorySummary(avatar, { groupId: resolvedGroupId });

    return message;
}
