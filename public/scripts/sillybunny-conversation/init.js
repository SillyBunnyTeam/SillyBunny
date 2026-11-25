import { chat } from '../../script.js';
import { event_types, eventSource } from '../events.js';
import { extension_settings } from '../extensions.js';
import { selected_group } from '../group-chats.js';
import {
    captureGroupAsideRequest,
    captureRoleplayAsideRequest,
    checkGroupChatMention,
    startConversationAutoWorker,
    stopConversationAutoWorker,
    triggerGroupAside,
    triggerRoleplayAside,
} from './auto-engine.js';
import { disableConversationModeForCurrentCharacter, getDefaultConversationAvatar, selectConversation } from './chrome.js';
import { CONVERSATION_DETAILS_CLOSE_EVENT, CONVERSATION_STORE_KEY, GROUP_ASIDE_RANDOM_CHANCE } from './constants.js';
import { getConversationGroupById, getConversationPersonaId, getRoleplayCurrentCharacter, getRoleplayGroupById } from './context.js';
import { conversationData, installConversationDataHooks } from './conversation-data-browser.js';
import { generationTargets, installPageLeaveEffects, installRemovalEffects } from './deletion-guards.js';
import { importLegacyLocalStorage } from './legacy-import.js';
import { getActiveConversationKey, updateConversationNotificationIndicators } from './notifications.js';
import { installReplyEvents } from './reply-events-browser.js';
import { installReplyFinalizer } from './reply-finalizer-browser.js';
import { installRoundResume } from './round-resume-browser.js';
import { getCharacterForGroupChatMessage, getCurrentGroupConversationMembers } from './conversation-list.js';
import { scheduleConversationListRender, scheduleInterfaceRefresh } from './render-scheduler.js';
import { getSettings, hasAnyConversationModeUsage } from './settings-store.js';
import { conversationState, sendQueue, setExternalConversationGenerationActive } from './state.js';
import { setConversationTimeout } from './timers.js';

function hasConversationRuntimeUsage() {
    return conversationState.conversationWorkspaceOpen || hasAnyConversationModeUsage();
}

function scheduleInterfaceRefreshIfOpen() {
    if (conversationState.conversationWorkspaceOpen) {
        scheduleInterfaceRefresh();
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
    installRemovalEffects({ onRemoval: conversationData.onRemoval, queue: sendQueue, targets: generationTargets });
    installPageLeaveEffects({ target: window, targets: generationTargets });
    installReplyFinalizer();
    installRoundResume();
    installReplyEvents();
    conversationData.subscribe((event) => {
        if (event.type === 'list' || event.type === 'status') {
            updateConversationNotificationIndicators();
            if (conversationState.conversationWorkspaceOpen) {
                scheduleConversationListRender();
            }
        } else if (event.type === 'chat' && !event.local && conversationState.conversationWorkspaceOpen && event.address.conversationId === getActiveConversationKey()) {
            scheduleInterfaceRefreshIfOpen();
        }
    });
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
                        setConversationTimeout(() => void triggerGroupAside(chosenMember.character, request), 2000);
                    }
                }
            } else {
                const roleplayCharacter = getCharacterForGroupChatMessage(chat[messageId]) || getRoleplayCurrentCharacter();
                const avatar = roleplayCharacter?.avatar || '';
                const personaId = getConversationPersonaId();
                if (!avatar || !getSettings(avatar, { groupId: '', personaId }).roleplay_reactions) {
                    return;
                }
                const request = captureRoleplayAsideRequest({ avatar, personaId, sourceMessageId: messageId });
                if (request) {
                    setConversationTimeout(() => void triggerRoleplayAside(request), 2000);
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
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, scheduleInterfaceRefreshIfOpen);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (conversationState.conversationWorkspaceOpen) {
            scheduleInterfaceRefresh();
        }
    });
    eventSource.on(event_types.CHAT_LOADED, () => {
        if (conversationState.conversationWorkspaceOpen) {
            scheduleInterfaceRefresh();
        }
    });
    eventSource.on(event_types.PERSONA_CHANGED, () => {
        window.dispatchEvent(new CustomEvent(CONVERSATION_DETAILS_CLOSE_EVENT));
        conversationState.conversationReplyTarget = null;
        updateConversationNotificationIndicators();
        ensureConversationRuntimeStarted();
        if (conversationState.conversationWorkspaceOpen) {
            if (conversationState.conversationSelectedGroupId && !getConversationGroupById(conversationState.conversationSelectedGroupId)) {
                conversationState.conversationSelectedGroupId = null;
            }
            scheduleInterfaceRefresh();
        }
    });

    window.addEventListener('sb:open-conversation-workspace', (event) => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        const avatar = detail?.avatar || getDefaultConversationAvatar();
        const chatId = detail?.chatId || '';
        const groupId = detail?.groupId || null;
        const personaId = detail?.personaId || getConversationPersonaId();
        void selectConversation(avatar, { chatId, groupId, personaId, showToast: detail?.showToast !== false });
    });
    window.addEventListener('sb:roleplay-character-selected', (event) => {
        if (!conversationState.conversationWorkspaceOpen) {
            return;
        }

        const detail = event instanceof CustomEvent ? event.detail : null;
        const avatar = detail?.avatar || '';
        if (avatar) {
            void selectConversation(avatar, { showToast: false });
        }
    });
    window.addEventListener('sb:close-conversation-workspace', () => disableConversationModeForCurrentCharacter({ focusRoleplay: false }));
    window.addEventListener('sb:conversation-runtime-needed', ensureConversationRuntimeStarted);
    window.addEventListener('beforeunload', stopConversationAutoWorker);

    // The page does not wait for the conversations: the rest of the mode starts when the list has arrived.
    void conversationData.whenReady().then(async () => {
        try {
            await importLegacyLocalStorage();
        } catch (error) {
            console.error('Conversation Mode: the old browser data could not be moved', error);
        }
        updateConversationNotificationIndicators();
        if (hasAnyConversationModeUsage()) {
            ensureConversationRuntimeStarted();
            scheduleInterfaceRefresh();
        }
    });
}

installConversationDataHooks({
    eventSource,
    settingsLoaded: event_types.SETTINGS_LOADED,
    refreshOn: [event_types.CHARACTER_DELETED, event_types.CHARACTER_RENAMED, event_types.PERSONA_DELETED],
    getModeObject: () => extension_settings[CONVERSATION_STORE_KEY],
});
eventSource.on(event_types.APP_READY, init);
