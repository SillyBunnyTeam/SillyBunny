import { describe, expect, jest, test } from '@jest/globals';

import { resolveConversationReminderChatId } from '../public/scripts/sillybunny-conversation/conversation-store-utils.js';

const persistConversationStore = jest.fn();
const generateConversationReply = jest.fn();
const reminder = {
    id: 'reminder-1',
    avatar: 'char.png',
    branchId: 'deleted-branch',
    groupId: '',
    personaId: 'persona-a.png',
    text: 'remember this',
    triggerAt: 1,
    fired: false,
};

await jest.unstable_mockModule('../public/script.js', () => ({ chat: [], is_send_press: false, name1: 'User' }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getActiveConversationChat: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getConversationStore: () => ({ reminders: [reminder] }),
    getConversationRecord: () => ({
        activeBranchId: 'main',
        branches: { main: { id: 'main' } },
    }),
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
    getRoleplayCurrentCharacter: () => ({ avatar: 'char.png' }),
    getRoleplayGroupById: () => null,
    parsePositiveInt: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    persistConversationStore,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    generateConversationReply,
    postCharacterReply: jest.fn(),
    postMemberConversationReply: jest.fn(),
    reportConversationGenerationError: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/interface.js', () => ({ loadCurrentPanelSettings: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    buildCharacterImagePrompt: () => '',
    generateConversationImage: jest.fn(),
    getCharacterForAvatar: () => ({ avatar: 'char.png', name: 'Aster' }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-writer.js', () => ({ appendConversationMessage: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list.js', () => ({
    buildGroupChatContext: () => '',
    getConversationRailItems: () => [],
    getCurrentGroupConversationMembers: () => [],
    getGroupAsideKey: () => '',
    getSelectedConversationGroup: () => null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members.js', () => ({
    chooseConversationMember: () => null,
    getAllowedMemberCharacters: () => [],
    getConversationMemberSettings: (_avatar, settings) => settings,
    getLeastRecentMember: () => null,
    getRecentlySilentMentionedMember: () => null,
    isCharacterMentionedInText: () => false,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    getConversationPersonaName: () => 'User',
    getUserStatus: () => 'online',
    safeParseWeeklySchedule: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    clamp: value => value,
    getCurrentActivityFromSchedule: () => ({ activity: '', status: 'online' }),
    getStoredSchedule: () => null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({ buildConversationRoleplayContext: () => '' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getAutoCharacterChatCooldownMs: () => 0,
    getConversationChatActivityTime: () => 0,
    getConversationSessionMarker: () => '',
    getFollowupCount: () => 0,
    getLastAutoCharacterChatTime: () => 0,
    getLastUserActivity: () => 0,
    getSettings: () => ({ enabled: true }),
    setConversationSessionMarker: jest.fn(),
    setFollowupCount: jest.fn(),
    setLastAutoCharacterChatTime: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: {},
    groupAsideBusyKeys: new Set(),
    groupAsideLastSent: new Map(),
    memberReplyBusyKeys: new Set(),
    sendQueue: [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timers.js', () => ({
    clearConversationTimeouts: jest.fn(),
    setConversationTimeout: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    getConversationMessages: () => [],
    getImageCooldownRemainingSeconds: () => 0,
    markImageGenerated: jest.fn(),
    resolveConversationReminderChatId,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    getConversationActivityContext: () => ({ activity: '', source: 'manual', status: 'online' }),
    withTypingParticipant: (_participant, task) => task(),
}));

const { checkConversationReminders } = await import('../public/scripts/sillybunny-conversation/auto-engine.js');

describe('conversation reminder target identity', () => {
    test('marks a missing captured branch invalid without posting or falsely firing', async () => {
        await expect(checkConversationReminders(100)).resolves.toBe(false);
        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(reminder.fired).toBe(false);
        expect(reminder.invalidAt).toBe(100);
        expect(reminder.invalidReason).toBe('missing_branch');
        expect(persistConversationStore).toHaveBeenCalled();
    });
});
