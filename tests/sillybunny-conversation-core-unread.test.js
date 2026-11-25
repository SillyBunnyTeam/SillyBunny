import { describe, expect, jest, test } from '@jest/globals';

const conversationRecord = {
    activeChatId: 'main',
    unread: 4,
    chats: [
        { id: 'main', unread: 1 },
        { id: 'side', unread: 3 },
    ],
};

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ playMessageSound: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/lazy-parts.js', () => ({ selectConversation: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/constants.js', () => ({
    CHROME_IDS: { listToggle: 'list-toggle' },
    SAFE_TOAST_OPTIONS: {},
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getCharacterForAvatar: () => ({ avatar: 'char.png' }),
    clearLegacyConversationUnreadStorage: () => 0,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getConversationKey: () => 'conv_1_direct',
    getConversationRecord: () => conversationRecord,
    getCurrentCharAvatar: () => 'char.png',
    shouldSurfaceConversationNotification: () => false,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getSettings: () => ({}),
    isConversationModeEnabled: () => true,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: {
        conversationWorkspaceOpen: false,
        faviconUpdateToken: 0,
        originalDocumentTitle: '',
        originalFaviconHref: '',
    },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/preview-utils.js', () => ({ stripPreviewText: value => String(value || '') }));

const { getUnreadCount } = await import('../public/scripts/sillybunny-conversation/notifications.js');

describe('Conversation unread aggregation', () => {
    test('adds up the unread counts of the chats of a conversation while exposing the count of each chat', () => {
        expect(getUnreadCount('char.png', { groupId: '', personaId: 'persona-a.png' })).toBe(4);
        expect(getUnreadCount('char.png', { chatId: 'side', groupId: '', personaId: 'persona-a.png' })).toBe(3);
    });
});
