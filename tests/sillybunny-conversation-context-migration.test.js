import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const extensionSettings = {};
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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({ getCharacterForAvatar: () => null }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    getConversationReplyMaxTokens: settings => settings.reply_max_tokens,
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
    getActiveConversationBranch,
    getConversationStore,
    getRawConversationThreadKey,
    migrateLegacyConversationStoreToPersona,
} = await import('../public/scripts/sillybunny-conversation/context.js');

describe('conversation persona migration', () => {
    beforeEach(() => {
        for (const key of Object.keys(extensionSettings)) {
            delete extensionSettings[key];
        }
        saveSettingsDebounced.mockClear();
    });

    test('assigns and persists missing reminder persona IDs without changing reminder metadata', () => {
        const reminder = {
            id: 'reminder-1',
            avatar: 'char.png',
            branchId: 'branch-1',
            text: 'Keep this',
            triggerAt: 1234,
        };
        extensionSettings.sillybunny_conversation = {
            characters: {},
            groups: [],
            reminders: [reminder],
            settings: {},
        };

        const store = getConversationStore();

        expect(store.reminders[0]).toEqual({ ...reminder, personaId: 'persona-a.png' });
        expect(saveSettingsDebounced).toHaveBeenCalled();
    });

    test('keeps the browser raw key format compatible with persisted and backend keys', () => {
        expect(getRawConversationThreadKey('folder/name.png', 'group id', 'persona/a.png')).toBe(
            'persona:persona%2Fa.png:group:group id:folder/name.png',
        );
        expect(getRawConversationThreadKey('folder/name.png', '', 'persona/a.png')).toBe(
            'persona:persona%2Fa.png:folder/name.png',
        );
    });

    test('merges non-conflicting history and retains a colliding legacy source with conflicting settings', () => {
        const legacyMessage = { id: 'legacy-message', mes: 'legacy history', created_at: 1 };
        const scopedMessage = { id: 'scoped-message', mes: 'scoped history', created_at: 2 };
        const store = {
            characters: {
                'char.png': {
                    activeBranchId: 'main',
                    settings: { enabled: false, custom_instructions: 'legacy setting' },
                    branches: { main: { id: 'main', messages: [legacyMessage] } },
                },
                'persona:persona-a.png:char.png': {
                    activeBranchId: 'main',
                    settings: { enabled: true },
                    branches: { main: { id: 'main', messages: [scopedMessage] } },
                },
            },
            groups: [],
            reminders: [],
            settings: {},
        };

        expect(migrateLegacyConversationStoreToPersona(store, 'persona-a.png')).toBe(true);
        expect(store.characters['persona:persona-a.png:char.png'].branches.main.messages.map(message => message.id)).toEqual([
            'legacy-message',
            'scoped-message',
        ]);
        expect(store.characters['persona:persona-a.png:char.png'].settings).toEqual({
            custom_instructions: 'legacy setting',
            enabled: true,
        });
        expect(store.characters['char.png']).toBeDefined();
        expect(store.legacyThreadPersonaAssignments['char.png']).toBe('persona-a.png');

        migrateLegacyConversationStoreToPersona(store, 'persona-b.png');
        expect(store.characters['persona:persona-b.png:char.png']).toBeUndefined();
    });

    test('reads an explicitly captured persona and branch instead of the active persona branch', () => {
        const branchA = { id: 'branch-a', messages: [{ id: 'a' }] };
        const branchB = { id: 'branch-b', messages: [{ id: 'b' }] };
        extensionSettings.sillybunny_conversation = {
            characters: {
                'persona:persona-a.png:char.png': {
                    activeBranchId: 'branch-a',
                    branches: { 'branch-a': branchA },
                    settings: {},
                },
                'persona:persona-b.png:char.png': {
                    activeBranchId: 'branch-b',
                    branches: { 'branch-b': branchB },
                    settings: {},
                },
            },
            groups: [],
            reminders: [],
            settings: {},
        };

        expect(getActiveConversationBranch('char.png', {
            branchId: 'branch-b',
            create: false,
            groupId: '',
            personaId: 'persona-b.png',
        })).toBe(branchB);
        expect(getActiveConversationBranch('char.png', {
            branchId: 'branch-a',
            create: false,
            groupId: '',
            personaId: 'persona-a.png',
        })).toBe(branchA);
    });

    test('does not duplicate ID-less messages when a retained collision is migrated repeatedly', () => {
        const legacyMessage = { role: 'user', name: 'User', mes: 'legacy', created_at: 10, extra: { legacy: true } };
        const store = {
            characters: {
                'char.png': {
                    activeBranchId: 'main',
                    settings: { enabled: false },
                    branches: { main: { id: 'main', messages: [legacyMessage] } },
                },
                'persona:persona-a.png:char.png': {
                    activeBranchId: 'main',
                    settings: { enabled: true },
                    branches: { main: { id: 'main', messages: [] } },
                },
            },
            groups: [],
            reminders: [],
            settings: {},
        };

        migrateLegacyConversationStoreToPersona(store, 'persona-a.png');
        migrateLegacyConversationStoreToPersona(store, 'persona-a.png');

        expect(store.characters['persona:persona-a.png:char.png'].branches.main.messages).toEqual([legacyMessage]);
        expect(store.characters['char.png']).toBeDefined();
    });
});
