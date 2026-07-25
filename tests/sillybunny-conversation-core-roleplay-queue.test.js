import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/script.js', () => ({ is_send_press: true }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/auto-engine.js', () => ({
    checkMultiCharacterChime: jest.fn(),
    handleAvailabilityAutoResponder: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => 'persona-a.png',
    getConversationThreadKey: () => 'persona:persona-a.png:char.png',
    getConversationThreadStore: () => null,
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    generateConversationReply: jest.fn(),
    postCharacterReply: jest.fn(),
    postPartnerConversationReply: jest.fn(),
    reportConversationGenerationError: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    buildCharacterImagePrompt: jest.fn(),
    generateConversationImage: jest.fn(),
    getCharacterForAvatar: jest.fn(),
    getConversationPartnerAvatars: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/partners.js', () => ({
    getAllowedPartnerCharacters: () => [],
    getConversationPartnerSettings: (_avatar, settings) => settings,
    isCharacterMentionedInText: () => false,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({ getConversationPersonaName: () => 'User' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({ formatConversationFileSize: () => '' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({ formatPromptText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-utils.js', () => ({ escapeHtmlText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getSettings: () => ({ enabled: true }),
    saveSettings: jest.fn(),
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
    partnerReplyBusyKeys: new Set(),
    sendQueue: [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-render.js', () => ({ consumeConversationReplyTarget: () => null }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/thread-store.js', () => ({
    appendConversationThreadMessage: jest.fn(),
    buildConversationMessageReplyReference: jest.fn(),
    getConversationAttachmentSummary: () => '',
    getConversationFileAttachments: () => [],
    getConversationMediaAttachments: () => [],
    getConversationThread: () => [],
    getImageCooldownRemainingSeconds: () => 0,
    markImageGenerated: jest.fn(),
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
