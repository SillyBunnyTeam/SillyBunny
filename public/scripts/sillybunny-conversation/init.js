import { chat } from '../../script.js';
import { event_types, eventSource } from '../events.js';
import { selected_group } from '../group-chats.js';
import {
    checkGroupChatMention,
    conversationModeAutoMessageWorker,
    handleChatChanged,
    triggerGroupAsideDM,
    triggerRoleplayDM,
} from './auto-engine.js';
import { disableConversationModeForCurrentCharacter, getDefaultConversationAvatar, openConversationWorkspaceForAvatar } from './chrome.js';
import { AUTO_WORKER_INTERVAL_GLOBAL_KEY, AUTO_WORKER_INTERVAL_MS, GROUP_ASIDE_RANDOM_CHANCE } from './constants.js';
import { getCurrentCharAvatar, isAvatarInConversationGroup, migrateConversationLocalStorage } from './context.js';
import { loadCurrentPanelSettings } from './interface.js';
import { updateConversationNotificationIndicators } from './notifications.js';
import { getCharacterForGroupChatMessage, getCurrentGroupConversationMembers } from './pals-rail.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';

export function init() {
    if (conversationState.initialized) {
        return;
    }

    conversationState.initialized = true;
    migrateConversationLocalStorage();
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => {
        scheduleInterfaceRefresh({ syncControls: false });
        if (selected_group) {
            checkGroupChatMention(messageId);
        }
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        scheduleInterfaceRefresh({ syncControls: false });

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
                    setTimeout(() => void triggerGroupAsideDM(chosenMember.character, { reason, sourceMessageId: messageId }), 2000);
                }
            } else if (getSettings(getCurrentCharAvatar(), { groupId: '' }).roleplay_reactions) {
                setTimeout(() => void triggerRoleplayDM(), 2000);
            }
        }
    });
    eventSource.on(event_types.GENERATION_STARTED, (_type, _params, isDryRun) => {
        if (isDryRun) {
            return;
        }

        conversationState.generationActive = true;
        scheduleInterfaceRefresh({ syncControls: false });
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        conversationState.generationActive = false;
        scheduleInterfaceRefresh({ syncControls: false });
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        conversationState.generationActive = false;
        scheduleInterfaceRefresh({ syncControls: false });
    });
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.CHAT_LOADED, handleChatChanged);

    window.addEventListener('sb:open-conversation-workspace', (event) => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        const avatar = detail?.avatar || getDefaultConversationAvatar();
        const groupId = detail?.groupId || (selected_group && avatar && isAvatarInConversationGroup(avatar, selected_group) ? String(selected_group) : null);
        openConversationWorkspaceForAvatar(avatar, { groupId, showToast: detail?.showToast !== false });
    });
    window.addEventListener('sb:close-conversation-workspace', () => disableConversationModeForCurrentCharacter({ focusRoleplay: false }));

    const existingAutoWorkerIntervalId = globalThis[AUTO_WORKER_INTERVAL_GLOBAL_KEY];
    if (existingAutoWorkerIntervalId) {
        window.clearInterval(existingAutoWorkerIntervalId);
    }

    conversationState.autoWorkerIntervalId = window.setInterval(() => void conversationModeAutoMessageWorker(), AUTO_WORKER_INTERVAL_MS);
    globalThis[AUTO_WORKER_INTERVAL_GLOBAL_KEY] = conversationState.autoWorkerIntervalId;
    loadCurrentPanelSettings();
    updateConversationNotificationIndicators();
}

eventSource.on(event_types.APP_READY, init);
