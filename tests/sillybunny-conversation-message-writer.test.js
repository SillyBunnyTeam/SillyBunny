import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { PERSONA, seedConversations, startConversationServer } from './util/conversation-data-fixture.js';

const charactersByAvatar = new Map();
let data;

const conversationData = new Proxy({}, { get: (_target, key) => data[key] });
const notifyNewConversationMessage = jest.fn();

await jest.unstable_mockModule('../public/script.js', () => ({ characters: [], saveSettingsDebounced: jest.fn(), this_chid: undefined }));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: {} }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ groups: [], selected_group: null }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: PERSONA }));
await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ getMessageTimeStamp: () => 'now' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({ conversationData }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => charactersByAvatar.get(avatar) || null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    getConversationReplyMaxTokens: () => 16000,
    getScheduleStorageKey: avatar => `schedule:${avatar}`,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: { conversationSelectedAvatar: null, conversationSelectedGroupId: null, conversationWorkspaceOpen: false },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/notifications.js', () => ({
    isConversationActive: () => false,
    markConversationRead: jest.fn(),
    notifyNewConversationMessage,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    scheduleConversationListRender: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    scheduleTimelineRender: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getConversationSessionMarker: () => '',
    resetFollowupCount: jest.fn(),
    setConversationSessionMarker: jest.fn(),
    setLastUserActivity: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({ stripPreviewText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/tts.js', () => ({ narrateConversationMessage: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({ scheduleConversationMemorySummary: jest.fn() }));

const { appendConversationMessage } = await import('../public/scripts/sillybunny-conversation/message-writer.js');

let server;

beforeEach(async () => {
    server = await startConversationServer();
    charactersByAvatar.set('Nova.png', { avatar: 'Nova.png', name: 'Nova' });
    notifyNewConversationMessage.mockClear();
});

afterEach(async () => {
    data?.destroy();
    data = undefined;
    charactersByAvatar.clear();
    await server.stop();
});

const TWO_CHATS = { id: 'conv_1_direct01', characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello'] }, { id: 'trip', messages: ['to the sea'] }] };

async function startData(descriptors) {
    seedConversations(server, descriptors);
    data = createConversationData(server.adapter());
    await data.start();
}

const reply = (chatId, text = 'A reply that was started before the delete.') => appendConversationMessage(text, { name: 'Nova', role: 'character', chatId, groupId: '', personaId: PERSONA }, 'Nova.png');

describe('a reply that finds its target deleted', () => {
    test('is written to the chat that it was started for, when that chat exists', async () => {
        await startData([TWO_CHATS]);

        const message = await reply('trip');

        expect(message).toMatchObject({ mes: 'A reply that was started before the delete.' });
        expect(data.chat({ conversationId: 'conv_1_direct01', chatId: 'trip' }).messages.at(-1).mes).toBe('A reply that was started before the delete.');
        expect(data.chat({ conversationId: 'conv_1_direct01', chatId: 'main' })?.messages ?? []).toHaveLength(0);
    });

    test('is dropped when its chat was deleted, and does not land in the chat that is open now', async () => {
        await startData([TWO_CHATS]);
        await data.deleteChat({ conversationId: 'conv_1_direct01', chatId: 'trip' });

        const message = await reply('trip');

        expect(message).toBeNull();
        expect(data.chat({ conversationId: 'conv_1_direct01', chatId: 'main' })?.messages ?? []).toHaveLength(0);
        expect(data.get('conv_1_direct01').messageCount).toBe(1);
        expect(notifyNewConversationMessage).not.toHaveBeenCalled();
    });

    test('is dropped when its conversation was deleted', async () => {
        await startData([TWO_CHATS]);
        await data.deleteConversation('conv_1_direct01');

        expect(await reply('main')).toBeNull();
        expect(notifyNewConversationMessage).not.toHaveBeenCalled();
    });

    test('is dropped when it names no chat that exists, whatever chat is open now', async () => {
        await startData([TWO_CHATS]);

        expect(await reply('never-existed')).toBeNull();
        expect(data.get('conv_1_direct01').messageCount).toBe(2);
    });
});
