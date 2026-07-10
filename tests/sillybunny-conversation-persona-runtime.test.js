/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';

const handlers = new Map();
const startConversationAutoWorker = jest.fn();
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
    addEventListener: jest.fn(),
};

await jest.unstable_mockModule('../public/script.js', () => ({ chat: [] }));
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
    checkGroupChatMention: jest.fn(),
    handleChatChanged: jest.fn(),
    startConversationAutoWorker: () => {
        conversationState.autoWorkerStarted = true;
        startConversationAutoWorker();
    },
    stopConversationAutoWorker: jest.fn(),
    triggerGroupAsideDM: jest.fn(),
    triggerRoleplayDM: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/chrome.js', () => ({
    disableConversationModeForCurrentCharacter: jest.fn(),
    getDefaultConversationAvatar: () => '',
    openConversationWorkspaceForAvatar: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationGroupById: () => null,
    getConversationPersonaId: () => 'persona-b.png',
    getCurrentCharAvatar: () => '',
    migrateConversationLocalStorage: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/interface.js', () => ({ loadCurrentPanelSettings: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/notifications.js', () => ({
    sanitizeConversationUnreadCounts: jest.fn(),
    updateConversationNotificationIndicators: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/pals-rail.js', () => ({
    getCharacterForGroupChatMessage: () => null,
    getCurrentGroupConversationMembers: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getSettings: () => ({}),
    hasAnyConversationModeUsage: () => hasUsage,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState,
    setExternalConversationGenerationActive: (active) => {
        conversationState.externalGenerationActive = active;
        conversationState.generationActive = active;
    },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timers.js', () => ({ setConversationTimeout: jest.fn() }));

const { init } = await import('../public/scripts/sillybunny-conversation/init.js');

describe('conversation persona runtime', () => {
    test('starts autonomous runtime and clears context-bound reply UI after persona change', () => {
        init();
        expect(startConversationAutoWorker).not.toHaveBeenCalled();

        hasUsage = true;
        handlers.get('persona-changed')();

        expect(startConversationAutoWorker).toHaveBeenCalledTimes(1);
        expect(conversationState.autoWorkerStarted).toBe(true);
        expect(conversationState.conversationReplyTarget).toBeNull();
    });
});
