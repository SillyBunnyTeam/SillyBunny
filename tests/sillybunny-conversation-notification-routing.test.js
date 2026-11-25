import { describe, expect, jest, test } from '@jest/globals';

const selectConversation = jest.fn(async () => true);

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ playMessageSound: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/lazy-parts.js', () => ({ selectConversation }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getCharacterForAvatar: () => null,
    clearLegacyConversationUnreadStorage: () => 0,
    getActiveConversationChat: () => null,
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => 'active.png',
    getConversationStore: () => ({ characters: {} }),
    getConversationKey: () => '',
    getConversationRecord: () => null,
    getCurrentCharAvatar: () => '',
    isConversationKeyForPersona: () => true,
    parseConversationKey: () => ({ avatar: '', groupId: '', personaId: '' }),
    parsePositiveInt: (_value, fallback) => fallback,
    persistConversationStore: jest.fn(),
    shouldSurfaceConversationNotification: () => true,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getSettings: () => ({}),
    isConversationModeEnabled: () => true,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ conversationState: {} }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/preview-utils.js', () => ({ stripPreviewText: value => String(value || '') }));

const { openConversationFromNotification } = await import('../public/scripts/sillybunny-conversation/notifications.js');

describe('conversation notification routing', () => {
    test('routes the captured persona, branch, and group to thread selection', async () => {
        await expect(openConversationFromNotification('char.png', {
            chatId: 'branch-a',
            groupId: 'group-a',
            personaId: 'captured.png',
        })).resolves.toBe(true);

        expect(selectConversation).toHaveBeenCalledWith('char.png', {
            chatId: 'branch-a',
            groupId: 'group-a',
            personaId: 'captured.png',
            showToast: false,
        });
    });
});
