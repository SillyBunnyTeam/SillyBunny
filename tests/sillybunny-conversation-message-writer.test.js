/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { PERSONA, recordCalls, seedConversations, startConversationServer } from './util/conversation-data-fixture.js';
import { pendingReply } from './util/conversation-pending-reply.js';

const charactersByAvatar = new Map();
let data;

const conversationData = new Proxy({}, { get: (_target, key) => data[key] });
const notifyNewConversationMessage = jest.fn();
const markConversationRead = jest.fn();
const isConversationActive = jest.fn(() => false);
const scheduleInterfaceRefresh = jest.fn();
const scheduleConversationMemorySummary = jest.fn();
const finalizePendingReplies = jest.fn();

await jest.unstable_mockModule('../public/script.js', () => ({ characters: [], saveSettingsDebounced: jest.fn(), this_chid: undefined }));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: {} }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ groups: [], selected_group: null }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: PERSONA }));
await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ getMessageTimeStamp: () => 'now' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({ conversationData }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => charactersByAvatar.get(avatar) || null,
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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/reply-finalizer-browser.js', () => ({ finalizePendingReplies }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({ scheduleConversationMemorySummary }));

const { afterIncomingMessage, appendConversationMessage } = await import('../public/scripts/sillybunny-conversation/message-writer.js');
const { addConversationReminder, ensureConversationChatLoaded, reloadConversationChat } = await import('../public/scripts/sillybunny-conversation/conversation-store.js');

let server;

beforeEach(async () => {
    server = await startConversationServer();
    charactersByAvatar.set('Nova.png', { avatar: 'Nova.png', name: 'Nova' });
    for (const mock of [notifyNewConversationMessage, markConversationRead, scheduleInterfaceRefresh, scheduleConversationMemorySummary]) {
        mock.mockClear();
    }
    isConversationActive.mockReset().mockReturnValue(false);
    finalizePendingReplies.mockReset().mockResolvedValue([]);
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
        expect(scheduleInterfaceRefresh).toHaveBeenCalledTimes(1);
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

describe('a message that arrives while the page is hidden', () => {
    afterEach(() => {
        delete globalThis.document;
    });

    async function startRecording() {
        seedConversations(server, [TWO_CHATS]);
        const recorded = recordCalls(server.adapter());
        data = createConversationData(recorded);
        await data.start();
        return recorded;
    }

    test('is saved with the flag that lets a request outlive a tab that is being closed', async () => {
        const recorded = await startRecording();
        globalThis.document = { visibilityState: 'hidden' };

        await reply('main', 'The last bubble of the reply.');
        await data.flush();

        const saves = recorded.callsTo('/chat/save');
        expect(saves).toHaveLength(1);
        expect(saves[0].options).toEqual({ keepalive: true });
    });

    test('is saved the ordinary way while the page is visible', async () => {
        const recorded = await startRecording();
        globalThis.document = { visibilityState: 'visible' };

        await reply('main', 'A reply that somebody watches.');
        await data.flush();

        expect(recorded.callsTo('/chat/save')[0].options).toBeUndefined();
    });
});

describe('a chat that holds a reply that the server wrote', () => {
    const address = { conversationId: 'conv_1_direct01', chatId: 'main' };
    const PENDING = pendingReply({ text: 'raw reply', triggers: ['main-1'] });
    const WITH_PENDING = { ...TWO_CHATS, chats: [{ id: 'main', messages: ['hello', 'hi there', { record: PENDING }] }, { id: 'trip', messages: ['to the sea'] }] };
    const load = () => ensureConversationChatLoaded('Nova.png', { chatId: 'main', groupId: '', personaId: PERSONA });

    test('is landed before the page reads it, so that a prompt never sees the raw message', async () => {
        await startData([WITH_PENDING]);
        finalizePendingReplies.mockImplementation(async (landing) => {
            data.commitChat(landing, (draft) => {
                draft.messages.splice(2, 1, { id: 'bubble', role: 'character', name: 'Nova', mes: 'raw reply', extra: {} });
            });
            return [];
        });

        await expect(load()).resolves.toEqual(address);

        expect(finalizePendingReplies).toHaveBeenCalledTimes(1);
        expect(finalizePendingReplies).toHaveBeenCalledWith(address);
        expect(data.chat(address).messages.map(message => message.id)).toEqual(['main-0', 'main-1', 'bubble']);
    });

    test('is not looked for in a chat that holds none, and the finalizer is not loaded for it', async () => {
        await startData([TWO_CHATS]);

        await load();

        expect(finalizePendingReplies).not.toHaveBeenCalled();
    });

    test('does not stop the caller when it cannot be landed: the message stays pending, and the predicates keep it hidden', async () => {
        await startData([WITH_PENDING]);
        finalizePendingReplies.mockRejectedValue(new Error('the finalizer failed'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(load()).resolves.toEqual(address);

        expect(warn).toHaveBeenCalled();
        expect(data.chat(address).messages).toHaveLength(3);
        warn.mockRestore();
    });

    test('is landed before a message is added after it', async () => {
        await startData([WITH_PENDING]);
        finalizePendingReplies.mockImplementation(async (landing) => {
            data.commitChat(landing, (draft) => {
                draft.messages.splice(2, 1);
            });
            return [];
        });

        await reply('main', 'A live reply.');

        expect(data.chat(address).messages.map(message => message.mes)).toEqual(['hello', 'hi there', 'A live reply.']);
    });
});

describe('a chat that the server wrote a reply into while this page held it', () => {
    const address = { conversationId: 'conv_1_direct01', chatId: 'main' };
    const options = { chatId: 'main', groupId: '', personaId: PERSONA };

    async function writeFromAnotherPage() {
        const other = createConversationData(server.adapter());
        await other.start();
        await other.loadChat(address);
        other.commitChat(address, (draft) => {
            draft.messages.push(pendingReply({ text: 'raw reply', triggers: ['main-1'] }));
        });
        await other.flush();
        other.destroy();
    }

    test('is read again, and the reply that the server wrote is landed before the caller goes on', async () => {
        await startData([TWO_CHATS]);
        await data.loadChat(address);
        await writeFromAnotherPage();
        const seen = [];
        finalizePendingReplies.mockImplementation(async (landing) => {
            seen.push(data.chat(landing).messages.map(message => message.id));
            return [];
        });

        await expect(reloadConversationChat('Nova.png', options)).resolves.toEqual(address);

        expect(finalizePendingReplies).toHaveBeenCalledWith(address);
        expect(seen[0]).toHaveLength(2);
        expect(seen[0][1]).toMatch(/-abcdef01$/);
    });

    test('is not handed to the finalizer when the reload finds no reply of the server in it', async () => {
        await startData([TWO_CHATS]);
        await data.loadChat(address);

        await reloadConversationChat('Nova.png', options);

        expect(finalizePendingReplies).not.toHaveBeenCalled();
    });

    test('answers null for a chat that does not exist, and does not throw when the request fails', async () => {
        await startData([TWO_CHATS]);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(reloadConversationChat('Nova.png', { ...options, chatId: 'never-existed' })).resolves.toBeNull();
        await data.deleteChat(address).catch(() => null);
        await expect(reloadConversationChat('Nova.png', options)).resolves.toBeNull();
        warn.mockRestore();
    });
});

describe('a message or a reminder that a caller gives an id', () => {
    test('keeps the id, so that a reply landed by two pages has the same messages in both', async () => {
        await startData([TWO_CHATS]);

        const message = await appendConversationMessage('Here, a picture.', { name: 'Nova', role: 'character', id: 'pending.s0', chatId: 'main', groupId: '', personaId: PERSONA }, 'Nova.png');

        expect(message.id).toBe('pending.s0');
        expect(data.chat({ conversationId: 'conv_1_direct01', chatId: 'main' }).messages.at(-1).id).toBe('pending.s0');
    });

    test('is added to the conversation once, however often the same reply asks for it', async () => {
        globalThis.toastr = { info: jest.fn() };
        await startData([TWO_CHATS]);
        const options = { chatId: 'main', personaId: PERSONA, id: 'rem_pending_g0_0' };

        addConversationReminder('Nova.png', '', '15m', 'tea', options);
        addConversationReminder('Nova.png', '', '15m', 'tea', options);
        await data.flush();

        const reminders = data.get('conv_1_direct01').reminders;
        expect(reminders.map(item => item.id)).toEqual(['rem_pending_g0_0']);
        delete globalThis.toastr;
    });
});
