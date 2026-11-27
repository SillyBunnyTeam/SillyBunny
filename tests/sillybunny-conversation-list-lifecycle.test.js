import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { PERSONA, seedConversations, startConversationServer } from './util/conversation-data-fixture.js';
import { addCharacters } from './util/conversation-store-sandbox.js';
import { createCharacterRoster } from './util/character-roster.js';

const charactersByAvatar = createCharacterRoster();
let data;

const conversationData = new Proxy({}, { get: (_target, key) => data[key] });

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: charactersByAvatar.characters,
    chat: [],
    default_user_avatar: 'user-default.png',
    getThumbnailUrl: () => '',
    name1: 'User',
    saveSettingsDebounced: jest.fn(),
    this_chid: undefined,
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: {} }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ groups: [], selected_group: null }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: PERSONA }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({ conversationData }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => charactersByAvatar.get(avatar) || null,
    getCharacterIndexForAvatar: () => 0,
    getConversationParticipants: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: { conversationSelectedAvatar: null, conversationSelectedGroupId: null, conversationWorkspaceOpen: false },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ getSettings: () => ({ enabled: true }) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    getConversationMessages: () => [],
    getConversationSeenAt: () => 0,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({ stripPreviewText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({ formatPromptText: value => String(value || '') }));

const { getConversationRailItems } = await import('../public/scripts/sillybunny-conversation/conversation-list.js');
const { deleteConversationsOfCharacter } = await import('../src/conversation-cleanup.js');

let server;

beforeEach(async () => {
    server = await startConversationServer();
    addCharacters(server.user, ['Nova.png', 'Orion.png', 'Pip.png']);
    for (const avatar of ['Nova.png', 'Orion.png', 'Pip.png']) {
        charactersByAvatar.set(avatar, { avatar, name: avatar });
    }
});

afterEach(async () => {
    data?.destroy();
    data = undefined;
    charactersByAvatar.clear();
    await server.stop();
});

const DIRECT_NOVA = { id: 'conv_1_direct01', characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello'] }] };
const DIRECT_ORION = { id: 'conv_3_direct02', characters: ['Orion.png'], chats: [{ id: 'main', messages: ['hi'] }] };
const GROUP = { id: 'conv_2_group001', characters: ['Nova.png', 'Orion.png', 'Pip.png'], name: 'Trip', chats: [{ id: 'main', messages: ['one'] }] };

async function startData(descriptors) {
    seedConversations(server, descriptors);
    data = createConversationData(server.adapter());
    await data.start();
}

const listed = () => getConversationRailItems({ personaId: PERSONA }).map(item => item.key).sort();

describe('the list when a character is deleted', () => {
    test('without its chats, a direct conversation of that character is hidden and its data stays, and a group stays while one member is left', async () => {
        await startData([DIRECT_NOVA, DIRECT_ORION, GROUP]);
        charactersByAvatar.delete('Nova.png');

        expect(listed()).toEqual(['conv_2_group001', 'conv_3_direct02']);
        expect(data.get('conv_1_direct01')).not.toBeNull();
        charactersByAvatar.delete('Orion.png');
        charactersByAvatar.delete('Pip.png');
        expect(listed()).toEqual([]);
    });

    test('with its chats, the conversations of that character are gone from the list once it is read again, and the group lost the member', async () => {
        await startData([DIRECT_NOVA, DIRECT_ORION, GROUP]);

        deleteConversationsOfCharacter(server.user, 'Nova.png');
        charactersByAvatar.delete('Nova.png');
        await data.refresh();

        expect(listed()).toEqual(['conv_2_group001', 'conv_3_direct02']);
        expect(data.get('conv_1_direct01')).toBeNull();
        expect(data.get('conv_2_group001').characters).toEqual(['Orion.png', 'Pip.png']);
    });

    test('a group that falls to one member comes back as the direct conversation of that member once the list is read again', async () => {
        await startData([{ ...GROUP, characters: ['Nova.png', 'Orion.png'] }]);

        deleteConversationsOfCharacter(server.user, 'Nova.png');
        charactersByAvatar.delete('Nova.png');
        await data.refresh();

        expect(data.get('conv_2_group001')).toBeNull();
        const [only] = data.list();
        expect(only).toMatchObject({ kind: 'direct', characters: ['Orion.png'] });
        expect(listed()).toEqual([only.id]);
    });

    test('lists groups for an explicit non-active personaId by passing personaId through group lookup', async () => {
        const otherGroup = { ...GROUP, id: 'conv_4_othergrp', personaId: 'other.png', name: 'Other Trip' };
        await startData([DIRECT_NOVA, GROUP, otherGroup]);

        const otherItems = getConversationRailItems({ personaId: 'other.png' });
        expect(otherItems).toHaveLength(1);
        expect(otherItems[0]).toMatchObject({
            key: 'conv_4_othergrp',
            groupId: 'conv_4_othergrp',
            group: expect.objectContaining({ id: 'conv_4_othergrp', personaId: 'other.png' }),
        });
        expect(listed()).toEqual(['conv_1_direct01', 'conv_2_group001']);
    });
});
