import { chat } from '../../script.js';
import { event_types, eventSource } from '../events.js';
import { selected_group } from '../group-chats.js';
import {
    captureGroupAsideRequest,
    captureRoleplayDMRequest,
    checkGroupChatMention,
    handleChatChanged,
    startConversationAutoWorker,
    stopConversationAutoWorker,
    triggerGroupAsideDM,
    triggerRoleplayDM,
} from './auto-engine.js';
import { disableConversationModeForCurrentCharacter, getDefaultConversationAvatar, selectConversationThread } from './chrome.js';
import { GROUP_ASIDE_RANDOM_CHANCE } from './constants.js';
import { getConversationGroupById, getConversationPersonaId, getRoleplayCurrentCharacter, getRoleplayGroupById, migrateConversationLocalStorage } from './context.js';
import { loadCurrentPanelSettings } from './interface.js';
import { sanitizeConversationUnreadCounts, updateConversationNotificationIndicators } from './notifications.js';
import { getCharacterForGroupChatMessage, getCurrentGroupConversationMembers } from './pals-rail.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { closeConversationSettings } from './settings-panel.js';
import { getSettings, hasAnyConversationModeUsage } from './settings-store.js';
import { conversationState, setExternalConversationGenerationActive } from './state.js';
import { setConversationTimeout } from './timers.js';

function hasConversationRuntimeUsage() {
    return conversationState.conversationWorkspaceOpen || hasAnyConversationModeUsage();
}

function scheduleInterfaceRefreshIfOpen() {
    if (conversationState.conversationWorkspaceOpen) {
        scheduleInterfaceRefresh({ syncControls: false });
    }
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
                const sourceGroupId = String(selected_group || '');
                const roleplayGroup = getRoleplayGroupById(sourceGroupId);
                const members = getCurrentGroupConversationMembers({ group: roleplayGroup, requireRoleplayReactions: true });
                const speaker = getCharacterForGroupChatMessage(chat[messageId]);
                const speakerMember = speaker?.avatar ? members.find(item => item.character?.avatar === speaker.avatar) : null;
                const chosenMember = speakerMember && Math.random() < 0.65
                    ? speakerMember
                    : members[Math.floor(Math.random() * members.length)];
                if (chosenMember?.character) {
                    const reason = speakerMember?.character?.avatar === chosenMember.character.avatar ? 'reaction' : 'random';
                    const personaId = getConversationPersonaId();
                    const request = captureGroupAsideRequest(chosenMember.character, {
                        personaId,
                        reason,
                        sourceGroup: roleplayGroup,
                        sourceGroupId,
                        sourceMessageId: messageId,
                    });
                    if (request) {
                        setConversationTimeout(() => void triggerGroupAsideDM(chosenMember.character, request), 2000);
                    }
                }
            } else {
                const roleplayCharacter = getCharacterForGroupChatMessage(chat[messageId]) || getRoleplayCurrentCharacter();
                const avatar = roleplayCharacter?.avatar || '';
                const personaId = getConversationPersonaId();
                if (!avatar || !getSettings(avatar, { groupId: '', personaId }).roleplay_reactions) {
                    return;
                }
                const request = captureRoleplayDMRequest({ avatar, personaId, sourceMessageId: messageId });
                if (request) {
                    setConversationTimeout(() => void triggerRoleplayDM(request), 2000);
                }
            }
        }
    });
    eventSource.on(event_types.GENERATION_STARTED, (_type, _params, isDryRun) => {
        if (isDryRun) {
            return;
        }

        setExternalConversationGenerationActive(true);
        if (!hasConversationRuntimeUsage()) {
            return;
        }

        scheduleInterfaceRefreshIfOpen();
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        setExternalConversationGenerationActive(false);
        scheduleInterfaceRefreshIfOpen();
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        setExternalConversationGenerationActive(false);
        scheduleInterfaceRefreshIfOpen();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (conversationState.conversationWorkspaceOpen) {
            handleChatChanged();
            scheduleInterfaceRefresh({ syncControls: false });
        }
    });
    eventSource.on(event_types.CHAT_LOADED, () => {
        if (conversationState.conversationWorkspaceOpen) {
            handleChatChanged();
            scheduleInterfaceRefresh({ syncControls: false });
        }
    });
    eventSource.on(event_types.PERSONA_CHANGED, () => {
        closeConversationSettings();
        conversationState.conversationReplyTarget = null;
        sanitizeConversationUnreadCounts();
        updateConversationNotificationIndicators();
        ensureConversationRuntimeStarted();
        if (conversationState.conversationWorkspaceOpen) {
            if (conversationState.conversationSelectedGroupId && !getConversationGroupById(conversationState.conversationSelectedGroupId)) {
                conversationState.conversationSelectedGroupId = null;
            }
            handleChatChanged();
            loadCurrentPanelSettings();
            scheduleInterfaceRefresh({ syncControls: false });
        }
    });

    window.addEventListener('sb:open-conversation-workspace', (event) => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        const avatar = detail?.avatar || getDefaultConversationAvatar();
        const branchId = detail?.branchId || '';
        const groupId = detail?.groupId || null;
        const personaId = detail?.personaId || getConversationPersonaId();
        void selectConversationThread(avatar, { branchId, groupId, personaId, showToast: detail?.showToast !== false });
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
