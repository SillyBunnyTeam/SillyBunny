/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';

const handlers = new Map();
const startConversationAutoWorker = jest.fn();
const triggerRoleplayAside = jest.fn();
const roleplayChat = [];
const dispatchedEvents = [];
const selectConversation = jest.fn();
const scheduleInterfaceRefresh = jest.fn();
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
    dispatchEvent: event => dispatchedEvents.push(event),
};
globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
        this.type = type;
        this.detail = init?.detail ?? type;
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
        ONLINE_STATUS_CHANGED: 'online-status-changed',
        PERSONA_CHANGED: 'persona-changed',
        USER_MESSAGE_RENDERED: 'user-message-rendered',
    },
}));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: {} }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: { onRemoval: jest.fn(), subscribe: jest.fn(), whenReady: () => Promise.resolve() },
    installConversationDataHooks: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/legacy-import.js', () => ({ importLegacyLocalStorage: jest.fn(async () => 'none') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/reply-finalizer-browser.js', () => ({ installReplyFinalizer: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/round-resume-browser.js', () => ({ installRoundResume: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/reply-events-browser.js', () => ({ installReplyEvents: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/auto-engine.js', () => ({
    captureGroupAsideRequest: jest.fn(),
    captureRoleplayAsideRequest: options => ({ ...options, chatId: 'branch-a', roleplayContext: 'captured roleplay' }),
    checkGroupChatMention: jest.fn(),
    startConversationAutoWorker: () => {
        conversationState.autoWorkerStarted = true;
        startConversationAutoWorker();
    },
    stopConversationAutoWorker: jest.fn(),
    triggerGroupAside: jest.fn(),
    triggerRoleplayAside,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/chrome.js', () => ({
    disableConversationModeForCurrentCharacter: jest.fn(),
    getDefaultConversationAvatar: () => '',
    selectConversation,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationGroupById: () => null,
    getConversationPersonaId: () => 'persona-b.png',
    getRoleplayCurrentCharacter: () => ({ avatar: 'roleplay.png', name: 'Roleplay' }),
    getRoleplayGroupById: () => null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/notifications.js', () => ({
    getActiveConversationKey: () => '',
    updateConversationNotificationIndicators: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list.js', () => ({
    getCharacterForGroupChatMessage: () => null,
    getCurrentGroupConversationMembers: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({ scheduleConversationListRender: jest.fn(), scheduleInterfaceRefresh }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getSettings: avatar => ({ roleplay_reactions: avatar === 'roleplay.png' }),
    hasAnyConversationModeUsage: () => hasUsage,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState,
    sendQueue: [],
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

// The workspace loads with a dynamic import, so a request for it reaches `selectConversation` a few ticks later.
const settleWorkspaceLoad = () => new Promise(resolve => setTimeout(resolve, 0));

describe('conversation persona runtime', () => {
    test('starts autonomous runtime and clears context-bound reply UI after persona change', () => {
        init();
        expect(startConversationAutoWorker).not.toHaveBeenCalled();

        hasUsage = true;
        conversationState.conversationWorkspaceOpen = true;
        dispatchedEvents.length = 0;
        scheduleInterfaceRefresh.mockClear();
        handlers.get('persona-changed')();

        expect(startConversationAutoWorker).toHaveBeenCalledTimes(1);
        expect(conversationState.autoWorkerStarted).toBe(true);
        expect(conversationState.conversationReplyTarget).toBeNull();
        expect(scheduleInterfaceRefresh).toHaveBeenCalledTimes(1);
    });

    test('asks the details window to close when the persona changes, because its conversation belongs to the old persona', () => {
        init();
        dispatchedEvents.length = 0;

        handlers.get('persona-changed')();

        expect(dispatchedEvents.map(event => event.type)).toContain('sb:conversation-details-close');
    });

    test('targets the originating roleplay character instead of Conversation selection', () => {
        init();
        hasUsage = true;
        conversationState.conversationWorkspaceOpen = true;
        conversationState.conversationSelectedAvatar = 'conversation.png';
        roleplayChat[0] = { id: 0, role: 'character', mes: 'roleplay reply' };
        triggerRoleplayAside.mockClear();
        const random = jest.spyOn(Math, 'random').mockReturnValue(0);

        handlers.get('character-message-rendered')(0);

        expect(triggerRoleplayAside).toHaveBeenCalledWith(expect.objectContaining({
            avatar: 'roleplay.png',
            personaId: 'persona-b.png',
        }));
        random.mockRestore();
    });

    test('passes captured persona identity through workspace-open events', async () => {
        init();
        selectConversation.mockClear();

        windowHandlers.get('sb:open-conversation-workspace')(new globalThis.CustomEvent({
            avatar: 'char.png',
            chatId: 'branch-b',
            groupId: 'group-b',
            personaId: 'persona-c.png',
            showToast: false,
        }));
        await settleWorkspaceLoad();

        expect(selectConversation).toHaveBeenCalledWith('char.png', {
            chatId: 'branch-b',
            groupId: 'group-b',
            personaId: 'persona-c.png',
            showToast: false,
        });
    });

    test('follows the newly selected roleplay character while Conversation is open', async () => {
        init();
        selectConversation.mockClear();
        conversationState.conversationWorkspaceOpen = true;

        windowHandlers.get('sb:roleplay-character-selected')(new globalThis.CustomEvent({
            avatar: 'new-character.png',
        }));
        await settleWorkspaceLoad();

        expect(selectConversation).toHaveBeenCalledWith('new-character.png', {
            showToast: false,
        });
    });

    test('refreshes open Conversation controls on connection changes without opening the workspace', () => {
        init();
        scheduleInterfaceRefresh.mockClear();
        conversationState.conversationWorkspaceOpen = false;

        handlers.get('online-status-changed')('no_connection');
        expect(scheduleInterfaceRefresh).not.toHaveBeenCalled();

        conversationState.conversationWorkspaceOpen = true;
        handlers.get('online-status-changed')('Connected');
        expect(scheduleInterfaceRefresh).toHaveBeenCalledTimes(1);
    });
});
