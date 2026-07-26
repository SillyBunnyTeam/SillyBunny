/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';

const handlers = new Map();
const startConversationAutoWorker = jest.fn();
const triggerRoleplayDM = jest.fn();
const roleplayChat = [];
const personaChangeOrder = [];
const handleChatChanged = jest.fn(() => personaChangeOrder.push('handle'));
const loadCurrentPanelSettings = jest.fn(() => personaChangeOrder.push('load'));
const selectConversationThread = jest.fn();
const windowHandlers = new Map();
let hasUsage = false;
const conversationState = {
    autoWorkerStarted: false,
    conversationReplyTarget: { messageId: 'old-target' },
    conversationSelectedGroupId: null,
    conversationWorkspaceOpen: false,
    externalGenerationActive: false,
    generationActive: false,
    initialized: false,
};

globalThis.window = {
    addEventListener: (event, handler) => windowHandlers.set(event, handler),
};
globalThis.CustomEvent = class CustomEvent {
    constructor(detail) {
        this.detail = detail;
    }
};

await jest.unstable_mockModule('../public/script.js', () => ({ chat: roleplayChat }));
await jest.unstable_mockModule('../public/scripts/events.js', () => ({
    eventSource: { on: (event, handler) => handlers.set(event, handler) },
    event_types: {
        APP_READY: 'app-ready',
        CHARACTER_MESSAGE_RENDERED: 'character-message-rendered',
        CHAT_CHANGED: 'chat-changed',
        CHAT_LOADED: 'chat-loaded',
        GENERATION_ENDED: 'generation-ended',
        GENERATION_STARTED: 'generation-started',
        GENERATION_STOPPED: 'generation-stopped',
        PERSONA_CHANGED: 'persona-changed',
        USER_MESSAGE_RENDERED: 'user-message-rendered',
    },
}));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/auto-engine.js', () => ({
    captureGroupAsideRequest: jest.fn(),
    captureRoleplayDMRequest: options => ({ ...options, branchId: 'branch-a', roleplayContext: 'captured roleplay' }),
    checkGroupChatMention: jest.fn(),
    handleChatChanged,
    startConversationAutoWorker: () => {
        conversationState.autoWorkerStarted = true;
        startConversationAutoWorker();
    },
    stopConversationAutoWorker: jest.fn(),
    triggerGroupAsideDM: jest.fn(),
    triggerRoleplayDM,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/chrome.js', () => ({
    disableConversationModeForCurrentCharacter: jest.fn(),
    getDefaultConversationAvatar: () => '',
    selectConversationThread,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationGroupById: () => null,
    getConversationPersonaId: () => 'persona-b.png',
    getRoleplayCurrentCharacter: () => ({ avatar: 'roleplay.png', name: 'Roleplay' }),
    getRoleplayGroupById: () => null,
    migrateConversationLocalStorage: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/interface.js', () => ({ loadCurrentPanelSettings }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/notifications.js', () => ({
    sanitizeConversationUnreadCounts: jest.fn(),
    updateConversationNotificationIndicators: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/pals-rail.js', () => ({
    getCharacterForGroupChatMessage: () => null,
    getCurrentGroupConversationMembers: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-panel.js', () => ({
    closeConversationSettings: () => personaChangeOrder.push('close'),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getSettings: avatar => ({ roleplay_reactions: avatar === 'roleplay.png' }),
    hasAnyConversationModeUsage: () => hasUsage,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState,
    setExternalConversationGenerationActive: (active) => {
        conversationState.externalGenerationActive = active;
        conversationState.generationActive = active;
    },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timers.js', () => ({
    setConversationTimeout: (callback) => {
        callback();
        return 1;
    },
}));

const { init } = await import('../public/scripts/sillybunny-conversation/init.js');

describe('conversation persona runtime', () => {
    test('starts autonomous runtime and clears context-bound reply UI after persona change', () => {
        init();
        expect(startConversationAutoWorker).not.toHaveBeenCalled();

        hasUsage = true;
        conversationState.conversationWorkspaceOpen = true;
        personaChangeOrder.length = 0;
        handlers.get('persona-changed')();

        expect(startConversationAutoWorker).toHaveBeenCalledTimes(1);
        expect(conversationState.autoWorkerStarted).toBe(true);
        expect(conversationState.conversationReplyTarget).toBeNull();
        expect(personaChangeOrder).toEqual(['close', 'handle', 'load']);
    });

    test('targets the originating roleplay character instead of Conversation selection', () => {
        init();
        hasUsage = true;
        conversationState.conversationWorkspaceOpen = true;
        conversationState.conversationSelectedAvatar = 'conversation.png';
        roleplayChat[0] = { id: 0, role: 'character', mes: 'roleplay reply' };
        triggerRoleplayDM.mockClear();
        const random = jest.spyOn(Math, 'random').mockReturnValue(0);

        handlers.get('character-message-rendered')(0);

        expect(triggerRoleplayDM).toHaveBeenCalledWith(expect.objectContaining({
            avatar: 'roleplay.png',
            personaId: 'persona-b.png',
        }));
        random.mockRestore();
    });

    test('passes captured persona identity through workspace-open events', () => {
        init();
        selectConversationThread.mockClear();

        windowHandlers.get('sb:open-conversation-workspace')(new globalThis.CustomEvent({
            avatar: 'char.png',
            branchId: 'branch-b',
            groupId: 'group-b',
            personaId: 'persona-c.png',
            showToast: false,
        }));

        expect(selectConversationThread).toHaveBeenCalledWith('char.png', {
            branchId: 'branch-b',
            groupId: 'group-b',
            personaId: 'persona-c.png',
            showToast: false,
        });
    });
});
