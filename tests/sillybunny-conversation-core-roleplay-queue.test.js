import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/script.js', () => ({ is_send_press: true, online_status: 'Connected' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-connection-notices.js', () => ({ notifyNotConnected: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/auto-engine.js', () => ({
    handleAvailabilityAutoResponder: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    ensureDirectConversation: jest.fn(),
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => 'persona-a.png',
    getConversationKey: () => 'conv_1_direct',
    getConversationRecord: () => null,
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    generateConversationReply: jest.fn(),
    postCharacterReply: jest.fn(),
    postMemberConversationReply: jest.fn(),
    reportConversationGenerationError: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    buildCharacterImagePrompt: jest.fn(),
    generateConversationImage: jest.fn(),
    getCharacterForAvatar: jest.fn(),
    getConversationMemberAvatars: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members.js', () => ({
    getConversationMemberSettings: (_avatar, settings) => settings,
    isCharacterMentionedInText: () => false,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({ getConversationPersonaName: () => 'User' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({ formatConversationFileSize: () => '' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({ formatPromptText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-utils.js', () => ({ escapeHtmlText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getSettings: () => ({ enabled: true }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    beginConversationGenerationOperation: jest.fn(),
    conversationState: {
        autoWorkerBusy: false,
        conversationUploadActive: false,
        sendQueueNeedsProcessing: false,
        sendQueueProcessing: false,
    },
    endConversationGenerationOperation: jest.fn(),
    memberReplyBusyKeys: new Set(),
    sendQueue: [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-render.js', () => ({ consumeConversationReplyTarget: () => null }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    appendConversationChatMessage: jest.fn(),
    buildConversationMessageReplyReference: jest.fn(),
    ensureConversationChatLoaded: jest.fn(async () => ({ conversationId: 'conv_1_direct', chatId: 'main' })),
    getConversationAttachmentSummary: () => '',
    getConversationFileAttachments: () => [],
    getConversationMediaAttachments: () => [],
    getConversationMessages: () => [],
    getImageCooldownRemainingSeconds: () => 0,
    markImageGenerated: jest.fn(),
    reloadConversationChat: jest.fn(),
    updateLastUserActivity: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-slash-commands.js', () => ({ handleConversationSlashAction: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    getConversationActivityContext: () => ({ status: 'online' }),
    maybePostDelayedReplyNotice: jest.fn(),
    splitChatroomMessages: value => [String(value || '')],
    withTypingParticipant: (_participant, task) => task(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-writer.js', () => ({ appendConversationMessage: jest.fn() }));

const { processQueuedConversationReply } = await import('../public/scripts/sillybunny-conversation/attachments.js');

describe('Conversation queue during roleplay generation', () => {
    test('returns a retry result instead of consuming the queued DM', async () => {
        await expect(processQueuedConversationReply({ avatar: 'char.png' })).resolves.toBe('retry');
    });
});
