import { describe, expect, jest, test } from '@jest/globals';

const conversationRecord = {
    activeBranchId: 'main',
    branches: {
        main: { unread: 1 },
        side: { unread: 3 },
    },
};

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ playMessageSound: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/chrome.js', () => ({ selectConversation: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/constants.js', () => ({
    CHROME_IDS: { listToggle: 'list-toggle' },
    SAFE_TOAST_OPTIONS: {},
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    clearLegacyConversationUnreadStorage: () => 0,
    getActiveConversationChat: (_avatar, options = {}) => conversationRecord.branches[options.chatId || conversationRecord.activeBranchId],
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getConversationStore: () => ({ characters: {} }),
    getConversationKey: () => 'persona:persona-a.png:char.png',
    getConversationRecord: () => conversationRecord,
    getCurrentCharAvatar: () => 'char.png',
    isConversationKeyForPersona: () => true,
    parseConversationKey: () => ({ avatar: 'char.png', groupId: '', personaId: 'persona-a.png' }),
    parsePositiveInt: (value, fallback, min = 1) => {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
    },
    persistConversationStore: jest.fn(),
    shouldSurfaceConversationNotification: () => false,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({ getCharacterForAvatar: () => ({ avatar: 'char.png' }) }));
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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({ stripPreviewText: value => String(value || '') }));

const { getUnreadCount } = await import('../public/scripts/sillybunny-conversation/notifications.js');

describe('Conversation unread aggregation', () => {
    test('aggregates inactive branches for a DM row while exposing individual branch counts', () => {
        expect(getUnreadCount('char.png', { groupId: '', personaId: 'persona-a.png' })).toBe(4);
        expect(getUnreadCount('char.png', { chatId: 'side', groupId: '', personaId: 'persona-a.png' })).toBe(3);
    });
});
