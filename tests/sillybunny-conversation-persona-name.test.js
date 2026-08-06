import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/script.js', () => ({
    name1: 'Active Name',
    saveSettingsDebounced: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/events.js', () => ({
    eventSource: { emit: jest.fn() },
    event_types: { PERSONA_UPDATED: 'persona-updated' },
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: {} }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'active.png' }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: {
        personas: {
            'captured.png': 'Captured Name',
        },
    },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'active.png' : value || ''),
    getRawConversationThreadKey: () => '',
    getConversationStore: () => ({}),
    getConversationThreadKey: () => '',
    getCurrentCharAvatar: () => '',
    isAvatarInConversationGroup: () => false,
    persistConversationStore: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/pickers.js', () => ({ updateUserFooter: jest.fn() }));

const { getConversationPersonaName } = await import('../public/scripts/sillybunny-conversation/personas.js');

describe('conversation captured persona names', () => {
    test('uses stored names for captured personas and only uses name1 for the active ID', () => {
        expect(getConversationPersonaName('captured.png', 'Fallback')).toBe('Captured Name');
        expect(getConversationPersonaName('active.png', 'Fallback')).toBe('Active Name');
        expect(getConversationPersonaName('missing.png', 'Fallback')).toBe('Fallback');
    });
});
