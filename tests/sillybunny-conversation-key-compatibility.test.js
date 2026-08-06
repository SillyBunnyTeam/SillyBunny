import { describe, expect, jest, test } from '@jest/globals';

const avatar = 'Nova 100% alt.png';
const groupId = 'group 50% alpha';
const personaId = 'Persona 25%: one.png';
const extensionSettings = {
    sillybunny_conversation: {
        version: 1,
        localStorageMigrated: true,
        settings: {},
        characters: {},
        groups: [{
            id: groupId,
            personaId,
            members: [avatar, 'Echo.png'],
            disabled_members: [],
            conversation_settings: {},
        }],
        legacyThreadPersonaAssignments: {},
        reminders: [],
    },
};

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    saveSettingsDebounced: jest.fn(),
    this_chid: undefined,
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: extensionSettings }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    editGroup: jest.fn(),
    groups: [],
    selected_group: null,
}));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: personaId }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({ getCharacterForAvatar: () => null }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    getConversationReplyMaxTokens: settings => settings.reply_max_tokens,
    getScheduleStorageKey: value => `schedule:${value}`,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: {
        conversationSelectedAvatar: null,
        conversationSelectedGroupId: null,
        conversationWorkspaceOpen: false,
    },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/thread-store.js', () => ({ safeParseThread: value => value }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({ stripPreviewText: value => String(value || '') }));

const { getConversationThreadKey: getBrowserThreadKey } = await import('../public/scripts/sillybunny-conversation/context.js');
const { getConversationThreadKey: getBackendThreadKey } = await import('../src/endpoints/conversation-store.js');

describe('Conversation thread key compatibility', () => {
    test('backend and browser helpers share raw avatar/group syntax and persona encoding', () => {
        expect(getBackendThreadKey(avatar, '', personaId)).toBe(getBrowserThreadKey(avatar, '', { personaId }));
        expect(getBackendThreadKey(avatar, groupId, personaId)).toBe(getBrowserThreadKey(avatar, groupId, { personaId }));
        expect(getBackendThreadKey(avatar, groupId, personaId)).toBe(
            `persona:${encodeURIComponent(personaId)}:group:${groupId}:${avatar}`,
        );
    });

    test('backend rejects raw composite delimiters in API storage components', () => {
        expect(getBackendThreadKey('Nova:alt.png', '', personaId)).toBe('');
        expect(getBackendThreadKey(avatar, 'group:alpha', personaId)).toBe('');
    });
});
