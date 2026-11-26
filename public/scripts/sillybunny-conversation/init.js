import { event_types, eventSource } from '../events.js';
import { extension_settings } from '../extensions.js';
import { CONVERSATION_DETAILS_CLOSE_EVENT, CONVERSATION_STORE_KEY } from './constants.js';
import { getConversationGroupById } from './context.js';
import { conversationData, installConversationDataHooks } from './conversation-data-browser.js';
import { generationTargets, installPageLeaveEffects, installRemovalEffects } from './deletion-guards.js';
import { importLegacyLocalStorage } from './legacy-import.js';
import {
    bindWorkspacePrefetch,
    disableConversationModeForCurrentCharacter,
    handleRoleplayCharacterMessage,
    handleRoleplayUserMessage,
    installConversationReplyStream,
    openConversationWorkspaceFromRequest,
    selectConversation,
    startConversationWorker,
    stopConversationWorker,
} from './lazy-parts.js';
import { getActiveConversationKey, updateConversationNotificationIndicators, updateModeToggleUnread } from './notifications.js';
import { scheduleConversationListRender, scheduleInterfaceRefresh } from './render-scheduler.js';
import { hasAnyConversationModeUsage } from './settings-store.js';
import { conversationState, sendQueue, setExternalConversationGenerationActive } from './state.js';

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

    startConversationWorker();
    updateConversationNotificationIndicators();
}

export function init() {
    if (conversationState.initialized) {
        return;
    }

    conversationState.initialized = true;
    installRemovalEffects({ onRemoval: conversationData.onRemoval, queue: sendQueue, targets: generationTargets });
    installPageLeaveEffects({ target: window, targets: generationTargets });
    conversationData.subscribe((event) => {
        if (event.type === 'list' || event.type === 'status') {
            updateConversationNotificationIndicators();
            if (hasAnyConversationModeUsage()) {
                installConversationReplyStream();
            }
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
        handleRoleplayUserMessage(messageId);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        if (!hasConversationRuntimeUsage()) {
            return;
        }

        scheduleInterfaceRefreshIfOpen();
        handleRoleplayCharacterMessage(messageId);
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
        void openConversationWorkspaceFromRequest(event instanceof CustomEvent ? event.detail : null);
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
    // The badge on the chat mode button shows only while the workspace is closed, so it follows the workspace opening and closing.
    window.addEventListener('sb:conversation-workspace-state-changed', () => updateModeToggleUnread());
    window.addEventListener('beforeunload', stopConversationWorker);
    bindWorkspacePrefetch(window);

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
