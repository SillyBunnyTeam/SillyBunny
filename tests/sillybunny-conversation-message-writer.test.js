import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { PERSONA, seedConversations, startConversationServer } from './util/conversation-data-fixture.js';

const charactersByAvatar = new Map();
let data;

const conversationData = new Proxy({}, { get: (_target, key) => data[key] });
const notifyNewConversationMessage = jest.fn();
const markConversationRead = jest.fn();
const isConversationActive = jest.fn(() => false);
const scheduleInterfaceRefresh = jest.fn();
const scheduleConversationMemorySummary = jest.fn();

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
    isConversationActive,
    markConversationRead,
    notifyNewConversationMessage,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    scheduleConversationListRender: jest.fn(),
    scheduleInterfaceRefresh,
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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({ scheduleConversationMemorySummary }));

const { afterIncomingMessage, appendConversationMessage } = await import('../public/scripts/sillybunny-conversation/message-writer.js');

let server;

beforeEach(async () => {
    server = await startConversationServer();
    charactersByAvatar.set('Nova.png', { avatar: 'Nova.png', name: 'Nova' });
    for (const mock of [notifyNewConversationMessage, markConversationRead, scheduleInterfaceRefresh, scheduleConversationMemorySummary]) {
        mock.mockClear();
    }
    isConversationActive.mockReset().mockReturnValue(false);
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

describe('the effects of an incoming message', () => {
    const address = { conversationId: 'conv_1_direct01', chatId: 'main' };
    const context = { chatId: 'main', groupId: '', personaId: PERSONA, address };
    const incoming = { id: 'm1', role: 'character', name: 'Nova', mes: 'hi', extra: {} };

    test('are the same for a reply that is written live as for one that lands after the page was away', async () => {
        await startData([TWO_CHATS]);

        const message = await reply('main', 'A live reply.');

        expect(notifyNewConversationMessage).toHaveBeenCalledWith('Nova.png', message, true, { chatId: 'main', groupId: '', personaId: PERSONA });
        expect(scheduleConversationMemorySummary).toHaveBeenCalledTimes(1);
        notifyNewConversationMessage.mockClear();
        scheduleConversationMemorySummary.mockClear();

        afterIncomingMessage('Nova.png', incoming, context);

        expect(notifyNewConversationMessage).toHaveBeenCalledWith('Nova.png', incoming, true, { chatId: 'main', groupId: '', personaId: PERSONA });
        expect(scheduleConversationMemorySummary).toHaveBeenCalledTimes(1);
    });

    test('mark a message that arrives in the open chat as read, and do not notify for it', () => {
        isConversationActive.mockReturnValue(true);

        afterIncomingMessage('Nova.png', incoming, context);

        expect(markConversationRead).toHaveBeenCalledWith('Nova.png', { chatId: 'main', groupId: '', personaId: PERSONA });
        expect(notifyNewConversationMessage).toHaveBeenCalledWith('Nova.png', incoming, false, expect.anything());
        expect(scheduleInterfaceRefresh).toHaveBeenCalledWith({ syncControls: false });
    });

    test('leave a message of the user alone: no read marker, no notification', () => {
        isConversationActive.mockReturnValue(true);

        afterIncomingMessage('Nova.png', { ...incoming, role: 'user' }, context);

        expect(markConversationRead).not.toHaveBeenCalled();
        expect(notifyNewConversationMessage).toHaveBeenCalledWith('Nova.png', expect.anything(), false, expect.anything());
    });

    test('can leave the notification and the memory summary to the caller, which runs them once for a reply of several bubbles', () => {
        afterIncomingMessage('Nova.png', incoming, { ...context, notify: false, scheduleMemory: false });

        expect(notifyNewConversationMessage).toHaveBeenCalledWith('Nova.png', incoming, false, expect.anything());
        expect(scheduleConversationMemorySummary).not.toHaveBeenCalled();
    });
});
