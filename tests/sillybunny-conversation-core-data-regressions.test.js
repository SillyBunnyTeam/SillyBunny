/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { PERSONA, seedConversations, startConversationServer } from './util/conversation-data-fixture.js';
import { createCharacterRoster } from './util/character-roster.js';

const extensionSettings = {};
const charactersByAvatar = createCharacterRoster();
const saveSettingsDebounced = jest.fn();
let data;

// The module under test reads the page's data module through this stand-in, which points at the one of the test.
const conversationData = new Proxy({}, { get: (_target, key) => data[key] });

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: charactersByAvatar.characters,
    saveSettingsDebounced,
    this_chid: undefined,
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: extensionSettings }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    editGroup: jest.fn(),
    groups: [],
    selected_group: null,
}));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: PERSONA }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({ conversationData }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => charactersByAvatar.get(avatar) || null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: {
        conversationSelectedAvatar: null,
        conversationSelectedGroupId: null,
        conversationWorkspaceOpen: false,
    },
}));

const {
    clearLegacyConversationUnreadStorage,
    createConversationChat,
    deleteConversationByAvatar,
    deleteConversationChat,
    deleteConversationWelcomeChat,
    ensureDirectConversation,
    getActiveConversationChat,
    getConversationAddress,
    getConversationChats,
    getConversationGroupAnchor,
    getConversationGroupById,
    getConversationKey,
    getConversationRecord,
    getConversationStore,
    makeConversationGroup,
    renameConversationChat,
} = await import('../public/scripts/sillybunny-conversation/context.js');

let server;

async function startData(descriptors) {
    seedConversations(server, descriptors);
    data = createConversationData(server.adapter());
    await data.start();
}

beforeEach(async () => {
    server = await startConversationServer();
    for (const avatar of ['Nova.png', 'Orion.png', 'Pax.png']) {
        charactersByAvatar.set(avatar, { avatar, name: avatar });
    }
});

afterEach(async () => {
    data?.destroy();
    data = undefined;
    charactersByAvatar.clear();
    for (const key of Object.keys(extensionSettings)) {
        delete extensionSettings[key];
    }
    saveSettingsDebounced.mockClear();
    await server.stop();
});

const GROUP = { id: 'conv_2_group001', characters: ['Missing.png', 'Orion.png', 'Pax.png'], name: 'Crew', chats: [{ id: 'main', messages: ['one', 'two'] }] };
const DIRECT = { id: 'conv_1_direct01', characters: ['Nova.png'], chats: [{ id: 'main', name: 'Main', messages: ['hello', 'hi'] }] };

describe('conversations as the rest of the mode reads them', () => {
    test('a group is the old group record: its members, a name that is never empty, no disabled members', async () => {
        await startData([GROUP, { ...DIRECT, id: 'conv_3_second001', characters: ['Nova.png', 'Orion.png'], name: '' }]);

        expect(getConversationGroupById('conv_2_group001')).toMatchObject({
            id: 'conv_2_group001',
            name: 'Crew',
            members: ['Missing.png', 'Orion.png', 'Pax.png'],
            disabled_members: [],
            is_conversation_group: true,
            personaId: PERSONA,
        });
        expect(getConversationGroupById('conv_3_second001').name).toBe('Conversation Group');
        expect(getConversationGroupById('conv_1_direct01')).toBeNull();
        expect(getConversationGroupById('conv_2_group001', { personaId: 'other.png' })).toBeNull();
    });

    test('the anchor of a group is its first member with a character card, and its key is the id of the conversation', async () => {
        await startData([GROUP]);

        const anchor = getConversationGroupAnchor(getConversationGroupById('conv_2_group001'), { personaId: PERSONA });

        expect(anchor.avatar).toBe('Orion.png');
        expect(anchor.key).toBe('conv_2_group001');
        expect(anchor.conversationRecord).toBe(data.get('conv_2_group001'));
    });

    test('a group with no member that has a card has no anchor', async () => {
        await startData([GROUP]);
        charactersByAvatar.clear();

        expect(getConversationGroupAnchor(getConversationGroupById('conv_2_group001'))).toBeNull();
    });

    test('a call in the old form finds the direct conversation of the persona or the group by its id', async () => {
        await startData([DIRECT, GROUP]);

        expect(getConversationRecord('Nova.png', { groupId: '' })).toBe(data.get('conv_1_direct01'));
        expect(getConversationRecord('Orion.png', { groupId: 'conv_2_group001' })).toBe(data.get('conv_2_group001'));
        expect(getConversationRecord('Nova.png', { groupId: '', personaId: 'other.png' })).toBeNull();
        expect(getConversationRecord('Ghost.png', { groupId: '' })).toBeNull();
        expect(getConversationAddress('Nova.png', { groupId: '', chatId: 'main' })).toEqual({ conversationId: 'conv_1_direct01', chatId: 'main' });
        expect(getConversationAddress('Nova.png', { groupId: '' })).toEqual({ conversationId: 'conv_1_direct01', chatId: 'main' });
        expect(getConversationKey('Nova.png', '')).toBe('conv_1_direct01');
        expect(getConversationKey('Ghost.png', '')).toBe(`pending:${PERSONA}::Ghost.png`);
    });

    test('a chat that the conversation does not have names no address, so that a write for a deleted chat lands nowhere', async () => {
        await startData([DIRECT]);
        await data.deleteChat({ conversationId: 'conv_1_direct01', chatId: 'main' });

        expect(getConversationAddress('Nova.png', { groupId: '', chatId: 'main' })).toBeNull();
        expect(getConversationAddress('Nova.png', { groupId: '', chatId: 'ghost' })).toBeNull();
        expect(getConversationAddress('Nova.png', { groupId: '' })).toMatchObject({ conversationId: 'conv_1_direct01' });
    });

    test('a chat is a handle with its messages only while it is loaded', async () => {
        await startData([DIRECT]);

        expect(getActiveConversationChat('Nova.png', { groupId: '' })).toMatchObject({ id: 'main', loaded: false, messageCount: 2 });
        expect(getActiveConversationChat('Nova.png', { groupId: '' }).messages).toHaveLength(0);
        expect(Object.isFrozen(getActiveConversationChat('Nova.png', { groupId: '' }).messages)).toBe(true);

        await data.loadChat({ conversationId: 'conv_1_direct01', chatId: 'main' });

        expect(getActiveConversationChat('Nova.png', { groupId: '' })).toMatchObject({ loaded: true, messageCount: 2, preview: 'hi' });
        expect(getActiveConversationChat('Nova.png', { groupId: '' }).messages.map(item => item.mes)).toEqual(['hello', 'hi']);
    });
});

describe('making conversations', () => {
    test('a direct conversation is made once for a character, and a group from its members', async () => {
        await startData([]);

        const first = await ensureDirectConversation('Nova.png');
        const second = await ensureDirectConversation('Nova.png');
        const group = await makeConversationGroup(['Nova.png', 'Orion.png', 'Nova.png'], { name: 'Crew' });

        expect(second).toBe(first);
        expect(group).toMatchObject({ name: 'Crew', members: ['Nova.png', 'Orion.png'], is_conversation_group: true });
        expect(await makeConversationGroup(['Nova.png'])).toBeNull();
    });
});

describe('chats of a conversation', () => {
    test('a new chat is listed and active at once, and the server makes it', async () => {
        await startData([DIRECT]);

        const chat = createConversationChat('Nova.png', 'Trip', { groupId: '' });

        expect(chat).toMatchObject({ name: 'Trip', loaded: true });
        expect(getConversationRecord('Nova.png', { groupId: '' }).activeChatId).toBe(chat.id);
        expect(getConversationChats('Nova.png', { groupId: '' }).map(item => item.name)).toEqual(['Main', 'Trip']);
        await data.flush();
        const stored = await server.adapter().fetchJson('/get', { id: 'conv_1_direct01' });
        expect(stored.json.conversation.chats.map(item => item.id)).toEqual(['main', chat.id]);
    });

    test('a new chat starts blank: it has no messages and no memory summary, whatever the chat it was started from has', async () => {
        await startData([DIRECT]);
        const loaded = await data.loadChat({ conversationId: 'conv_1_direct01', chatId: 'main' });
        data.commitChat(loaded.address, (draft) => {
            draft.header.chat_metadata.sb_conversation = { memory_summary: 'Durable memory', memory_message_count: 7, memory_updated_at: 123 };
        });

        const chat = createConversationChat('Nova.png', 'Trip', { groupId: '' });

        expect(chat).toMatchObject({ messageCount: 0, memorySummary: '', memoryMessageCount: 0, sessionMarkers: {} });
        await data.flush();
        const stored = await server.adapter().fetchJson('/chat/get', { id: 'conv_1_direct01', chatId: chat.id });
        expect(stored.json.chat[0].chat_metadata.sb_conversation).toBeUndefined();
    });

    test('a chat can be renamed, and a blank name or a chat that does not exist is refused', async () => {
        await startData([DIRECT]);

        expect(renameConversationChat('Nova.png', 'main', '  Renamed  ', { groupId: '' })).toBe(true);
        expect(renameConversationChat('Nova.png', 'main', '   ', { groupId: '' })).toBe(false);
        expect(renameConversationChat('Nova.png', 'ghost', 'x', { groupId: '' })).toBe(false);
        expect(getConversationChats('Nova.png', { groupId: '' })[0].name).toBe('Renamed');
        await data.flush();
    });

    test('deleting the only chat leaves one empty chat', async () => {
        await startData([DIRECT]);

        expect(await deleteConversationChat('Nova.png', 'main', { groupId: '' })).toBe(true);

        const chats = getConversationChats('Nova.png', { groupId: '' });
        expect(chats).toHaveLength(1);
        expect(chats[0]).toMatchObject({ messageCount: 0, unread: 0 });
        expect(chats[0].id).not.toBe('main');
        expect(await deleteConversationChat('Nova.png', 'ghost', { groupId: '' })).toBe(false);
    });

    test('Home says whether deleting a chat was the reset of the only one', async () => {
        await startData([{ ...DIRECT, chats: [{ id: 'main', messages: ['a'] }, { id: 'side', messages: ['b'] }] }]);

        expect(await deleteConversationWelcomeChat('Nova.png', 'side', { personaId: PERSONA })).toEqual({ deleted: true, reset: false });
        expect(await deleteConversationWelcomeChat('Nova.png', 'main', { personaId: PERSONA })).toEqual({ deleted: true, reset: true });
        expect(await deleteConversationWelcomeChat('Nova.png', 'ghost', { personaId: PERSONA })).toEqual({ deleted: false, reset: false });
    });

    test('deleting a conversation by its avatar and group removes it from the list and the disk, and a conversation that is not there is not an error', async () => {
        await startData([DIRECT, GROUP]);

        expect(await deleteConversationByAvatar('Nova.png', { groupId: '' })).toBe(true);
        expect(await deleteConversationByAvatar('Orion.png', { groupId: 'conv_2_group001' })).toBe(true);
        expect(await deleteConversationByAvatar('Nova.png', { groupId: '' })).toBe(false);

        expect(data.list()).toHaveLength(0);
        const stored = await server.adapter().fetchJson('/list', {});
        expect(stored.json.conversations).toEqual([]);
    });
});

describe('the mode object in settings.json', () => {
    test('is made with the version of the new storage when there is none', () => {
        expect(getConversationStore()).toEqual({ version: 2, localStorageMigrated: false, settings: {} });
        expect(extensionSettings.sillybunny_conversation).toBe(getConversationStore());
    });

    test('takes the version of the new storage when it only has the mode-wide values', () => {
        extensionSettings.sillybunny_conversation = { version: 1, localStorageMigrated: true, userStatus: 'idle' };

        const store = getConversationStore();

        expect(store).toMatchObject({ version: 2, localStorageMigrated: true, userStatus: 'idle', settings: {} });
    });

    test('leaves the old parts and the old version alone while the old parts have content, and adds none', () => {
        const old = {
            version: 1,
            characters: { 'persona:a.png:Nova.png': { branches: {} } },
            groups: [],
            reminders: [{ id: 'r1' }],
            legacyThreadPersonaAssignments: {},
            settings: { custom_instructions: 'x' },
        };
        extensionSettings.sillybunny_conversation = structuredClone(old);

        const store = getConversationStore();

        expect(store).toEqual(old);
    });

    test('never adds the parts of the old store to an object that does not have them', () => {
        extensionSettings.sillybunny_conversation = { version: 2, settings: {}, userStatus: 'dnd' };

        const store = getConversationStore();

        for (const part of ['characters', 'groups', 'reminders', 'legacyThreadPersonaAssignments']) {
            expect(Object.hasOwn(store, part)).toBe(false);
        }
        expect(JSON.parse(JSON.stringify(extensionSettings.sillybunny_conversation))).toEqual({ version: 2, settings: {}, userStatus: 'dnd' });
    });
});

describe('the unread counts of the first versions', () => {
    test('are removed from localStorage and counted', () => {
        const removed = [];
        const keys = ['sb_conv_unread_a.png', 'sb_conv_settings_a.png', 'sb_conv_unread_b.png'];
        globalThis.localStorage = {
            get length() {
                return keys.length;
            },
            key: index => keys[index],
            removeItem: (key) => {
                removed.push(key);
            },
        };

        try {
            expect(clearLegacyConversationUnreadStorage()).toBe(2);
            expect(removed).toEqual(['sb_conv_unread_a.png', 'sb_conv_unread_b.png']);
        } finally {
            delete globalThis.localStorage;
        }
    });
});
