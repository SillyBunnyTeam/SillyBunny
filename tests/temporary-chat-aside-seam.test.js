/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

const pub = relative => fileURLToPath(new URL(`../public/${relative}`, import.meta.url));

let isTemporary = false;

await jest.unstable_mockModule(pub('script.js'), () => ({
    chat: [{ name: 'Bunny', mes: 'Hello', is_user: false }],
    is_send_press: false,
}));
await jest.unstable_mockModule(pub('scripts/resumable-generation.js'), () => ({
    pageId: 'page-1',
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-temporary-chat-state.js'), () => ({
    isTemporaryChat: () => isTemporary,
}));
await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
    selected_group: null,
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/context.js'), () => ({
    getActiveConversationChat: jest.fn(() => null),
    getConversationAddress: jest.fn(() => null),
    getConversationGroupIdForAvatar: jest.fn(() => ''),
    getConversationPersonaId: jest.fn(() => 'persona.png'),
    getConversationRecord: jest.fn(() => ({ activeChatId: 'main' })),
    getCurrentCharAvatar: jest.fn(() => 'bunny.png'),
    getCurrentCharName: jest.fn(() => 'Bunny'),
    getRoleplayCurrentCharacter: jest.fn(() => null),
    getRoleplayGroupById: jest.fn(() => null),
    parsePositiveInt: (v, fallback = 0) => Number.parseInt(v, 10) || fallback,
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-data-browser.js'), () => ({
    conversationData: {},
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/deletion-guards.js'), () => ({
    createTargetCheck: jest.fn(() => () => true),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/generation.js'), () => ({
    generateConversationReply: jest.fn(),
    postCharacterReply: jest.fn(),
    postMemberConversationReply: jest.fn(),
    reportConversationGenerationError: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/media.js'), () => ({
    buildCharacterImagePrompt: jest.fn(),
    generateConversationImage: jest.fn(),
    getCharacterForAvatar: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/message-writer.js'), () => ({
    appendConversationMessage: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-list.js'), () => ({
    buildGroupChatContext: jest.fn(() => ''),
    getConversationRailItems: jest.fn(() => []),
    getCurrentGroupConversationMembers: jest.fn(() => []),
    getGroupAsideKey: jest.fn(() => ''),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/members.js'), () => ({
    isCharacterMentionedInText: jest.fn(() => false),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/personas.js'), () => ({
    getConversationPersonaName: jest.fn(() => 'User'),
    getUserStatus: jest.fn(() => ''),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/reminders.js'), () => ({
    claimReminderAttempt: jest.fn(),
    getReminderState: jest.fn(),
    getReminderToken: jest.fn(),
    isReminderDue: jest.fn(() => false),
    markReminderDelivered: jest.fn(),
    MAX_REMINDER_ATTEMPTS: 3,
    settleFailedReminderAttempt: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/reply-commit-plan.js'), () => ({
    createAutomaticReplyPlan: jest.fn(),
    createAutomaticSlotToken: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/reply-steps.js'), () => ({
    getReplyOriginFlags: jest.fn(() => ({})),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/shared-helpers.js'), () => ({
    buildConversationRoleplayContext: jest.fn(() => 'The scene so far.'),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/settings-store.js'), () => ({
    getFollowupCount: jest.fn(() => 0),
    getLastUserActivity: jest.fn(() => 0),
    getSettings: jest.fn(() => ({})),
    setFollowupCount: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/state.js'), () => ({
    conversationState: {},
    groupAsideBusyKeys: new Set(),
    groupAsideLastSent: new Map(),
    sendQueue: [],
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/timers.js'), () => ({
    clearConversationTimeouts: jest.fn(),
    setConversationTimeout: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-store.js'), () => ({
    ensureConversationChatLoaded: jest.fn(),
    getConversationMessages: jest.fn(() => []),
    getImageCooldownRemainingSeconds: jest.fn(() => 0),
    markImageGenerated: jest.fn(),
    reloadConversationChat: jest.fn(),
    resolveConversationReminderChatId: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/typing.js'), () => ({
    getConversationActivityContext: jest.fn(() => ({})),
    withTypingParticipant: jest.fn((_ctx, fn) => fn()),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/talkativeness.js'), () => ({
    getEffectivePatienceMinutes: jest.fn(() => 5),
    getTalkativeness: jest.fn(() => 0.5),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/worker-lock.js'), () => ({
    createWorkerLock: jest.fn(() => ({ acquire: jest.fn(() => true), release: jest.fn() })),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/worker-runner.js'), () => ({
    createWorkerRunner: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}));

const { captureRoleplayAsideRequest } = await import('../public/scripts/sillybunny-conversation/auto-engine.js');

afterEach(() => {
    isTemporary = false;
});

describe('Conversation reactions to the open roleplay', () => {
    test('captures the scene of a normal roleplay chat for a reaction', () => {
        isTemporary = false;
        expect(captureRoleplayAsideRequest()).toMatchObject({
            avatar: 'bunny.png',
            chatId: 'main',
            roleplayContext: 'The scene so far.',
        });
    });

    test('captures nothing from a temporary chat so no reaction is written into a conversation', () => {
        isTemporary = true;
        expect(captureRoleplayAsideRequest()).toBeNull();
    });
});
