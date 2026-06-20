import { chat } from '../../script.js';
import { event_types, eventSource } from '../events.js';
import { selected_group } from '../group-chats.js';
import {
    checkGroupChatMention,
    handleChatChanged,
    startConversationAutoWorker,
    stopConversationAutoWorker,
    triggerGroupAsideDM,
    triggerRoleplayDM,
} from './auto-engine.js';
import { disableConversationModeForCurrentCharacter, getDefaultConversationAvatar, openConversationWorkspaceForAvatar } from './chrome.js';
import { GROUP_ASIDE_RANDOM_CHANCE } from './constants.js';
import { getCurrentCharAvatar, getRoleplayCurrentCharacter, isAvatarInConversationGroup, migrateConversationLocalStorage } from './context.js';
import { loadCurrentPanelSettings } from './interface.js';
import { sanitizeConversationUnreadCounts, updateConversationNotificationIndicators } from './notifications.js';
import { getCharacterForGroupChatMessage, getCurrentGroupConversationMembers } from './pals-rail.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { getSettings, hasAnyConversationModeUsage } from './settings-store.js';
import { conversationState } from './state.js';
import { setConversationTimeout } from './timers.js';

function hasConversationRuntimeUsage() {
    return conversationState.conversationWorkspaceOpen || hasAnyConversationModeUsage();
}

function scheduleInterfaceRefreshIfOpen() {
    if (conversationState.conversationWorkspaceOpen) {
        scheduleInterfaceRefresh({ syncControls: false });
    }
}

function syncConversationWorkspaceToRoleplaySelection() {
    if (!conversationState.conversationWorkspaceOpen) {
        return;
    }

    let targetAvatar = null;
    const roleplayGroupId = selected_group ? String(selected_group) : null;

    if (roleplayGroupId) {
        const groupMembers = getCurrentGroupConversationMembers({ groupId: roleplayGroupId, requireEnabled: false });
        targetAvatar = groupMembers[0]?.character?.avatar || null;
    } else {
        targetAvatar = getRoleplayCurrentCharacter()?.avatar || null;
    }
    const targetGroupId = roleplayGroupId && targetAvatar && isAvatarInConversationGroup(targetAvatar, roleplayGroupId)
        ? roleplayGroupId
        : null;

    if (!targetAvatar) {
        conversationState.conversationSelectedAvatar = null;
        conversationState.conversationSelectedGroupId = null;
        conversationState.conversationUnavailableGroupId = roleplayGroupId;
        conversationState.conversationTimelineChannel = 'main';
        conversationState.conversationTimelineSearchQuery = '';
        scheduleInterfaceRefresh({ syncControls: false });
        return;
    }

    conversationState.conversationUnavailableGroupId = null;

    if (targetAvatar === conversationState.conversationSelectedAvatar
        && targetGroupId === conversationState.conversationSelectedGroupId) {
        return;
    }

    openConversationWorkspaceForAvatar(targetAvatar, { groupId: targetGroupId, showToast: false });
}

function ensureConversationRuntimeStarted() {
    if (conversationState.autoWorkerStarted || !hasConversationRuntimeUsage()) {
        return;
    }

    startConversationAutoWorker();
    updateConversationNotificationIndicators();
}

export function init() {
    if (conversationState.initialized) {
        return;
    }

    conversationState.initialized = true;
    migrateConversationLocalStorage();
    sanitizeConversationUnreadCounts();
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => {
        if (!hasConversationRuntimeUsage()) {
            return;
        }

        scheduleInterfaceRefreshIfOpen();
        if (selected_group) {
            checkGroupChatMention(messageId);
        }
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        if (!hasConversationRuntimeUsage()) {
            return;
        }

        scheduleInterfaceRefreshIfOpen();

        // Occasional private asides keep Conversation Mode feeling connected
        // without forcing a public group-chat reply.
        const roll = Math.random();
        if (roll < GROUP_ASIDE_RANDOM_CHANCE) {
            if (selected_group) {
                const members = getCurrentGroupConversationMembers({ requireRoleplayReactions: true });
                const speaker = getCharacterForGroupChatMessage(chat[messageId]);
                const speakerMember = speaker?.avatar ? members.find(item => item.character?.avatar === speaker.avatar) : null;
                const chosenMember = speakerMember && Math.random() < 0.65
                    ? speakerMember
                    : members[Math.floor(Math.random() * members.length)];
                if (chosenMember?.character) {
                    const reason = speakerMember?.character?.avatar === chosenMember.character.avatar ? 'reaction' : 'random';
                    setConversationTimeout(() => void triggerGroupAsideDM(chosenMember.character, { reason, sourceMessageId: messageId }), 2000);
                }
            } else if (getSettings(getCurrentCharAvatar(), { groupId: '' }).roleplay_reactions) {
                setConversationTimeout(() => void triggerRoleplayDM(), 2000);
            }
        }
    });
    eventSource.on(event_types.GENERATION_STARTED, (_type, _params, isDryRun) => {
        if (isDryRun) {
            return;
        }

        conversationState.generationActive = true;
        if (!hasConversationRuntimeUsage()) {
            return;
        }

        scheduleInterfaceRefreshIfOpen();
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        conversationState.generationActive = false;
        scheduleInterfaceRefreshIfOpen();
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        conversationState.generationActive = false;
        scheduleInterfaceRefreshIfOpen();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (conversationState.conversationWorkspaceOpen) {
            syncConversationWorkspaceToRoleplaySelection();
            handleChatChanged();
        }
    });
    eventSource.on(event_types.CHAT_LOADED, () => {
        if (conversationState.conversationWorkspaceOpen) {
            syncConversationWorkspaceToRoleplaySelection();
            handleChatChanged();
        }
    });

    window.addEventListener('sb:open-conversation-workspace', (event) => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        const avatar = detail?.avatar || getDefaultConversationAvatar();
        const groupId = detail?.groupId || (selected_group && avatar && isAvatarInConversationGroup(avatar, selected_group) ? String(selected_group) : null);
        openConversationWorkspaceForAvatar(avatar, { groupId, showToast: detail?.showToast !== false });
    });
    window.addEventListener('sb:close-conversation-workspace', () => disableConversationModeForCurrentCharacter({ focusRoleplay: false }));
    window.addEventListener('sb:conversation-runtime-needed', ensureConversationRuntimeStarted);
    window.addEventListener('beforeunload', stopConversationAutoWorker);

    if (hasAnyConversationModeUsage()) {
        ensureConversationRuntimeStarted();
        loadCurrentPanelSettings();
    }
}

eventSource.on(event_types.APP_READY, init);
