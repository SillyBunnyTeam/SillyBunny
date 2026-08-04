import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const extensionSettings = {};
const charactersByAvatar = new Map();
const saveSettingsDebounced = jest.fn();

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    saveSettingsDebounced,
    this_chid: undefined,
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: extensionSettings }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    editGroup: jest.fn(),
    groups: [],
    selected_group: null,
}));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-a.png' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => charactersByAvatar.get(avatar) || null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    getConversationReplyMaxTokens: settings => settings.reply_max_tokens || 16000,
    getScheduleStorageKey: avatar => `schedule:${avatar}`,
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

const {
    deleteConversationBranch,
    deleteConversationWelcomeBranch,
    getConversationGroupThreadAnchor,
    getConversationStore,
    normalizeGroupConversationSettings,
    resetCharacterConversationBranches,
} = await import('../public/scripts/sillybunny-conversation/context.js');

function createStore(overrides = {}) {
    return {
        characters: {},
        groups: [],
        legacyThreadPersonaAssignments: {},
        localStorageMigrated: true,
        reminders: [],
        settings: {},
        version: 1,
        ...overrides,
    };
}

describe('Conversation core persisted data regressions', () => {
    beforeEach(() => {
        for (const key of Object.keys(extensionSettings)) {
            delete extensionSettings[key];
        }
        charactersByAvatar.clear();
        saveSettingsDebounced.mockClear();
    });

    test('defaults missing legacy group cross-talk keys on while preserving explicit false', () => {
        expect(normalizeGroupConversationSettings({})).toMatchObject({
            auto_character_chat: true,
            multi_char: true,
        });
        expect(normalizeGroupConversationSettings({ auto_character_chat: false, multi_char: false })).toMatchObject({
            auto_character_chat: false,
            multi_char: false,
        });
        expect(normalizeGroupConversationSettings(JSON.stringify({ auto_character_chat: false, multi_char: false }))).toMatchObject({
            auto_character_chat: false,
            multi_char: false,
        });
        expect(normalizeGroupConversationSettings(JSON.stringify({}))).toMatchObject({
            auto_character_chat: true,
            multi_char: true,
        });
    });

    test('uses persisted eligible group history instead of a disabled first member or solo alias', () => {
        for (const avatar of ['disabled.png', 'fallback.png', 'persisted.png']) {
            charactersByAvatar.set(avatar, { avatar, name: avatar });
        }
        const group = {
            id: 'group-a',
            personaId: 'persona-a.png',
            members: ['disabled.png', 'fallback.png', 'persisted.png'],
            disabled_members: ['disabled.png'],
            conversation_settings: {},
        };
        const persistedThread = {
            activeBranchId: 'main',
            branches: { main: { id: 'main', messages: [{ id: 'group-message' }], updatedAt: 20 } },
            settings: {},
        };
        extensionSettings.sillybunny_conversation = createStore({
            groups: [group],
            characters: {
                'persona:persona-a.png:disabled.png': {
                    activeBranchId: 'main',
                    branches: { main: { id: 'main', messages: [{ id: 'solo-message' }], updatedAt: 50 } },
                    settings: {},
                },
                'persona:persona-a.png:group:group-a:persisted.png': persistedThread,
            },
        });

        const anchor = getConversationGroupThreadAnchor(group, { personaId: 'persona-a.png' });

        expect(anchor.avatar).toBe('persisted.png');
        expect(anchor.key).toBe('persona:persona-a.png:group:group-a:persisted.png');
        expect(anchor.threadStore).toBe(persistedThread);
    });

    test('falls back to the first enabled group member when no group thread exists', () => {
        for (const avatar of ['disabled.png', 'enabled.png', 'later.png']) {
            charactersByAvatar.set(avatar, { avatar, name: avatar });
        }
        const group = {
            id: 'group-a',
            personaId: 'persona-a.png',
            members: ['disabled.png', 'enabled.png', 'later.png'],
            disabled_members: ['disabled.png'],
            conversation_settings: {},
        };
        extensionSettings.sillybunny_conversation = createStore({ groups: [group] });

        expect(getConversationGroupThreadAnchor(group, { personaId: 'persona-a.png' })).toMatchObject({
            avatar: 'enabled.png',
            key: 'persona:persona-a.png:group:group-a:enabled.png',
            threadStore: null,
        });
    });

    test('merges disabled and missing group aliases into the best eligible anchor', () => {
        charactersByAvatar.set('disabled.png', { avatar: 'disabled.png', name: 'Disabled' });
        charactersByAvatar.set('enabled.png', { avatar: 'enabled.png', name: 'Enabled' });
        const group = {
            id: 'group-a',
            personaId: 'persona-a.png',
            members: ['disabled.png', 'enabled.png', 'missing.png'],
            disabled_members: ['disabled.png'],
            conversation_settings: {},
        };
        const makeThread = (id, unread, updatedAt) => ({
            activeBranchId: 'main',
            branches: {
                main: {
                    id: 'main',
                    messages: [{ id, created_at: updatedAt, mes: id }],
                    preview: id,
                    unread,
                    updatedAt,
                },
            },
            settings: {},
        });
        extensionSettings.sillybunny_conversation = createStore({
            groups: [group],
            characters: {
                'persona:persona-a.png:group:group-a:disabled.png': makeThread('from-disabled', 2, 10),
                'persona:persona-a.png:group:group-a:enabled.png': makeThread('from-enabled', 3, 30),
                'persona:persona-a.png:group:group-a:missing.png': makeThread('from-missing', 4, 20),
            },
        });

        const anchor = getConversationGroupThreadAnchor(group, { personaId: 'persona-a.png' });
        const store = getConversationStore();

        expect(anchor.avatar).toBe('enabled.png');
        expect(Object.keys(store.characters)).toEqual(['persona:persona-a.png:group:group-a:enabled.png']);
        expect(anchor.threadStore.branches.main.messages.map(message => message.id)).toEqual([
            'from-disabled',
            'from-missing',
            'from-enabled',
        ]);
        expect(anchor.threadStore.branches.main.unread).toBe(9);
        expect(saveSettingsDebounced).toHaveBeenCalled();
    });

    test('seeds reset branches from retained thread memory', () => {
        const threadStore = {
            activeBranchId: 'only',
            branches: {
                only: { id: 'only', memorySummary: 'Durable memory', messages: [{ id: 'old-message' }] },
            },
            memoryMessageCount: 7,
            memorySummary: 'Durable memory',
            memoryUpdatedAt: 123,
            settings: {},
        };
        extensionSettings.sillybunny_conversation = createStore({
            characters: { 'persona:persona-a.png:char.png': threadStore },
        });

        expect(deleteConversationBranch('char.png', 'only', { groupId: '', personaId: 'persona-a.png' })).toBe(true);
        expect(threadStore.branches.only.messages).toEqual([]);
        expect(threadStore.branches.only.memorySummary).toBe('Durable memory');

        resetCharacterConversationBranches('char.png', { groupId: '', personaId: 'persona-a.png' });
        expect(threadStore.branches.main.memorySummary).toBe('Durable memory');
        expect(getConversationStore().characters['persona:persona-a.png:char.png'].memorySummary).toBe('Durable memory');
    });

    test('reports when deleting a welcome branch resets the sole thread', () => {
        const threadStore = {
            activeBranchId: 'only',
            branches: {
                only: { id: 'only', messages: [{ id: 'old-message' }] },
            },
            settings: {},
        };
        extensionSettings.sillybunny_conversation = createStore({
            characters: { 'persona:persona-a.png:char.png': threadStore },
        });

        expect(deleteConversationWelcomeBranch('char.png', 'only', { personaId: 'persona-a.png' })).toEqual({
            deleted: true,
            reset: true,
        });
        expect(threadStore.branches.only.messages).toEqual([]);
    });
});
