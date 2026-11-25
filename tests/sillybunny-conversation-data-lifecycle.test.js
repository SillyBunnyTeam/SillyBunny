import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { line, recordCalls, seedConversations, startConversationServer } from './util/conversation-data-fixture.js';
import { addCharacters, IMAGES } from './util/conversation-store-sandbox.js';

const {
    deleteChat: deleteStoredChat,
    deleteConversation: deleteStoredConversation,
    loadChat: loadStoredChat,
    readConversation: readStoredConversation,
} = await import('../src/conversation-store.js');

let server;
let adapter;
let data;
let removals;
let errors;

beforeEach(async () => {
    server = await startConversationServer();
    addCharacters(server.user, ['Nova.png', 'Orion.png', 'Pip.png', 'Quill.png']);
    removals = [];
    errors = [];
});

afterEach(async () => {
    data?.destroy();
    await server.stop();
    jest.restoreAllMocks();
});

async function started(descriptors = []) {
    seedConversations(server, descriptors);
    adapter = recordCalls(server.adapter());
    data = createConversationData(adapter);
    data.onRemoval(target => removals.push(target));
    data.subscribe(event => event.type === 'error' && errors.push(event));
    await data.start();
    await data.whenReady();
    return data;
}

const DIRECT = {
    id: 'conv_1_direct01',
    characters: ['Nova.png'],
    chats: [{ id: 'main', name: 'Main', messages: ['hello', 'hi there', 'how are you', 'fine'], readThrough: 'main-1' }],
};
const GROUP = { id: 'conv_2_group001', characters: ['Nova.png', 'Orion.png', 'Pip.png'], name: 'Trip', chats: [{ id: 'main', messages: ['one', 'two'] }] };
const ADDRESS = { conversationId: DIRECT.id, chatId: 'main' };
const WITH_MEMORY = { ...DIRECT, chats: [{ ...DIRECT.chats[0] }] };

describe('Branch from Here', () => {
    test('is made by the server with the messages up to the chosen one, read, and with the memory summary of its source', async () => {
        await started([WITH_MEMORY]);
        const source = await data.loadChat(ADDRESS);
        source.header.chat_metadata.sb_conversation = { memory_summary: 'They said hello.', memory_message_count: 2, memory_updated_at: 5 };

        const branch = await data.branchChat(ADDRESS, 'main-1', { name: 'Branch 1', activate: true });

        const request = adapter.callsTo('/chat/create')[0].body;
        expect(request).toMatchObject({ id: DIRECT.id, name: 'Branch 1', activate: true, readThrough: 'main-1' });
        expect(request.records.map(record => record.id)).toEqual(['main-0', 'main-1']);
        expect(request.chat_metadata).toEqual({ sb_conversation: { memory_summary: 'They said hello.', memory_message_count: 2, memory_updated_at: 5 } });
        expect(request).not.toHaveProperty('chatId');
        const stored = loadStoredChat(server.user, DIRECT.id, branch.address.chatId);
        expect(stored.slice(1).map(record => record.id)).toEqual(['main-0', 'main-1']);
        expect(stored[0].chat_metadata.sb_conversation.memory_summary).toBe('They said hello.');
        const view = data.get(DIRECT.id);
        expect(view.activeChatId).toBe(branch.address.chatId);
        expect(view.chats.find(entry => entry.id === branch.address.chatId)).toMatchObject({ name: 'Branch 1', readThrough: 'main-1', messageCount: 2, unread: 0 });
        expect(data.chat(ADDRESS).messages).toHaveLength(4);
    });

    test('keeps the slug that the server answered, so that its first save is accepted', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);

        const branch = await data.branchChat(ADDRESS, 'main-2');
        const slug = loadStoredChat(server.user, DIRECT.id, branch.address.chatId)[0].chat_metadata.integrity;
        expect(data.chat(branch.address).header.chat_metadata.integrity).toBe(slug);
        data.commitChat(branch.address, (draft) => {
            draft.messages.push({ ...line('b1', 'a new line in the branch', { minute: 30, user: true }) });
        });
        await data.flush();

        expect(errors).toEqual([]);
        expect(loadStoredChat(server.user, DIRECT.id, branch.address.chatId).at(-1).mes).toBe('a new line in the branch');
        expect(adapter.callsTo('/chat/save').at(-1).body.chat[0].chat_metadata.integrity).toBe(slug);
    });

    test('copies the messages, so that editing the branch leaves its source alone', async () => {
        await started([DIRECT]);
        const source = await data.loadChat(ADDRESS);

        const branch = await data.branchChat(ADDRESS, 'main-1');
        data.commitChat(branch.address, (draft) => {
            draft.messages[0].mes = 'edited in the branch';
        });

        expect(source.messages[0].mes).toBe('hello');
    });

    test('has no memory summary to carry when its source has none', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);

        await data.branchChat(ADDRESS, 'main-1');

        expect(adapter.callsTo('/chat/create')[0].body).not.toHaveProperty('chat_metadata');
    });

    test('refuses a message that the chat does not have, and makes nothing', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);

        await expect(data.branchChat(ADDRESS, 'nothing')).rejects.toMatchObject({ code: 'not_found' });

        expect(adapter.callsTo('/chat/create')).toHaveLength(0);
        expect(data.get(DIRECT.id).chats).toHaveLength(1);
    });

    test('drops a conversation that another tab deleted, and rejects with the code of the route', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);
        deleteStoredConversation(server.user, DIRECT.id);

        await expect(data.branchChat(ADDRESS, 'main-1')).rejects.toMatchObject({ code: 'not_found', status: 404 });

        expect(data.get(DIRECT.id)).toBeNull();
        expect(removals).toContainEqual({ conversationId: DIRECT.id });
    });
});

describe('Delete Chat and Delete Conversation', () => {
    const TWO_CHATS = {
        ...DIRECT,
        chats: [
            { id: 'main', name: 'Main', messages: ['hello', 'hi'] },
            { id: 'trip', name: 'Trip', messages: ['to the sea'] },
        ],
        reminders: [
            { id: 'rem_1_aaaaaa', avatar: 'Nova.png', chatId: 'main', text: 'water the plants', triggerAt: Date.UTC(2026, 5, 2), fired: false },
            { id: 'rem_2_bbbbbb', avatar: 'Nova.png', chatId: 'trip', text: 'pack the bag', triggerAt: Date.UTC(2026, 5, 2), fired: false },
        ],
    };

    test('Delete Chat tells the listeners of removal before the request goes out, and leaves the conversation open', async () => {
        const log = [];
        await started([TWO_CHATS]);
        const original = adapter.fetchJson;
        adapter.fetchJson = (path, ...rest) => {
            log.push(path);
            return original(path, ...rest);
        };
        data.onRemoval(() => log.push('removal'));

        await data.deleteChat({ conversationId: DIRECT.id, chatId: 'main' });

        expect(log.indexOf('removal')).toBeGreaterThanOrEqual(0);
        expect(log.indexOf('removal')).toBeLessThan(log.indexOf('/chat/delete'));
        expect(removals).toContainEqual({ conversationId: DIRECT.id, chatId: 'main' });
        expect(data.get(DIRECT.id).chats.map(entry => entry.id)).toEqual(['trip']);
    });

    test('Delete Chat drops the reminders of that chat and keeps the others, in the cache and on the server', async () => {
        await started([TWO_CHATS]);

        await data.deleteChat({ conversationId: DIRECT.id, chatId: 'main' });
        await data.flush();

        expect(data.get(DIRECT.id).reminders.map(reminder => reminder.id)).toEqual(['rem_2_bbbbbb']);
        expect(readStoredConversation(server.user, DIRECT.id).reminders.map(reminder => reminder.id)).toEqual(['rem_2_bbbbbb']);
    });

    test('deleting the last chat leaves one empty chat, and the removal of the old one was announced', async () => {
        await started([DIRECT]);

        const view = await data.deleteChat(ADDRESS);

        expect(view.chats).toHaveLength(1);
        expect(view.chats[0]).toMatchObject({ messageCount: 0, hasUserMessage: false });
        expect(removals).toContainEqual(ADDRESS);
    });

    test('Delete Conversation tells the listeners before the request, removes the folder, and takes the reminders with it', async () => {
        const log = [];
        await started([TWO_CHATS, GROUP]);
        const original = adapter.fetchJson;
        adapter.fetchJson = (path, ...rest) => {
            log.push(path);
            return original(path, ...rest);
        };
        data.onRemoval(() => log.push('removal'));

        await data.deleteConversation(DIRECT.id);

        expect(log.indexOf('removal')).toBeLessThan(log.indexOf('/delete'));
        expect(removals).toContainEqual({ conversationId: DIRECT.id });
        expect(data.get(DIRECT.id)).toBeNull();
        expect(data.list().map(view => view.id)).toEqual([GROUP.id]);
        expect(() => readStoredConversation(server.user, DIRECT.id)).toThrow();
    });

    test('a conversation that the list no longer has is announced as removed, and so is a chat that the server dropped', async () => {
        await started([TWO_CHATS, GROUP]);
        deleteStoredConversation(server.user, GROUP.id);
        deleteStoredChat(server.user, DIRECT.id, 'trip');
        removals.length = 0;

        await data.refresh();

        expect(removals).toContainEqual({ conversationId: GROUP.id });
        expect(removals).toContainEqual({ conversationId: DIRECT.id, chatId: 'trip' });
    });
});

describe('editing a group', () => {
    test('a name and a description are saved with the next update', async () => {
        await started([GROUP]);

        data.patchConversation(GROUP.id, { name: 'Beach trip', description: 'Plans for the beach' });
        await data.flush();

        expect(readStoredConversation(server.user, GROUP.id)).toMatchObject({ name: 'Beach trip', description: 'Plans for the beach' });
        expect(data.get(GROUP.id)).toMatchObject({ name: 'Beach trip', description: 'Plans for the beach' });
    });

    test('an uploaded avatar is stored and shows in the cache, and removing it clears it again', async () => {
        await started([GROUP]);

        const uploaded = await data.setGroupAvatar(GROUP.id, `data:image/png;base64,${IMAGES.png.toString('base64')}`);

        expect(uploaded.avatar).toBe('avatar.png');
        expect(data.get(GROUP.id).avatar).toBe('avatar.png');
        expect(readStoredConversation(server.user, GROUP.id).avatar).toBe('avatar.png');

        const cleared = await data.removeGroupAvatar(GROUP.id);

        expect(cleared.avatar).toBe('');
        expect(readStoredConversation(server.user, GROUP.id).avatar).toBe('');
    });

    test('an avatar that is not an image is refused with the code of the route, and the cache keeps what it had', async () => {
        await started([GROUP]);

        await expect(data.setGroupAvatar(GROUP.id, 'not an image')).rejects.toMatchObject({ code: 'invalid_input', status: 400 });

        expect(data.get(GROUP.id).avatar).toBe('');
    });
});

describe('members', () => {
    test('a member is added in place, and the group keeps its chats and its messages', async () => {
        await started([GROUP]);
        await data.loadChat({ conversationId: GROUP.id, chatId: 'main' });

        const result = await data.addMembers(GROUP.id, ['Quill.png']);

        expect(result.created).toBe(false);
        expect(result.conversation).toBe(data.get(GROUP.id));
        expect(data.get(GROUP.id).characters).toEqual(['Nova.png', 'Orion.png', 'Pip.png', 'Quill.png']);
        expect(data.get(GROUP.id)).toMatchObject({ messageCount: 2, preview: 'two' });
        expect(data.chat({ conversationId: GROUP.id, chatId: 'main' }).messages).toHaveLength(2);
        expect(adapter.callsTo('/members/add')[0].body).toEqual({ id: GROUP.id, characters: ['Quill.png'] });
    });

    test('Add Member on a direct conversation makes a new group and leaves the direct conversation as it is', async () => {
        await started([DIRECT]);

        const result = await data.addMembers(DIRECT.id, ['Orion.png']);

        expect(result.created).toBe(true);
        expect(result.conversation.kind).toBe('group');
        expect(result.conversation.characters).toEqual(['Nova.png', 'Orion.png']);
        expect(result.conversation.id).not.toBe(DIRECT.id);
        expect(data.get(result.conversation.id)).toBe(result.conversation);
        expect(data.get(DIRECT.id)).toMatchObject({ kind: 'direct', characters: ['Nova.png'], messageCount: 4 });
        expect(data.list()).toHaveLength(2);
    });

    test('a character that is not a card, or is a member already, is refused with the code of the route', async () => {
        await started([GROUP]);

        await expect(data.addMembers(GROUP.id, ['Ghost.png'])).rejects.toMatchObject({ code: 'invalid_input' });
        await expect(data.addMembers(GROUP.id, ['Nova.png'])).rejects.toMatchObject({ code: 'invalid_input' });

        expect(data.get(GROUP.id).characters).toEqual(['Nova.png', 'Orion.png', 'Pip.png']);
    });

    test('a member is removed in place, and the messages of that member stay', async () => {
        await started([GROUP]);

        const result = await data.removeMember(GROUP.id, 'Pip.png');

        expect(result).toMatchObject({ converted: false, conversation: data.get(GROUP.id) });
        expect(data.get(GROUP.id).characters).toEqual(['Nova.png', 'Orion.png']);
        expect(data.get(GROUP.id).messageCount).toBe(2);
        expect(loadStoredChat(server.user, GROUP.id, 'main')).toHaveLength(3);
    });

    test('removing the second-to-last member converts the group: its chats join the direct conversation of the member that is left, and the group leaves the cache', async () => {
        await started([{ ...GROUP, characters: ['Nova.png', 'Orion.png'] }]);
        await data.loadChat({ conversationId: GROUP.id, chatId: 'main' });

        const result = await data.removeMember(GROUP.id, 'Orion.png');

        expect(result.converted).toBe(true);
        expect(result.removedId).toBe(GROUP.id);
        expect(result.conversation).toMatchObject({ kind: 'direct', characters: ['Nova.png'] });
        expect(data.get(GROUP.id)).toBeNull();
        expect(data.chat({ conversationId: GROUP.id, chatId: 'main' })).toBeNull();
        expect(removals).toContainEqual({ conversationId: GROUP.id });
        expect(data.get(result.conversation.id)).toBe(result.conversation);
        const [chatEntry] = result.conversation.chats;
        expect(chatEntry).toMatchObject({ name: 'Trip', messageCount: 2, preview: 'two' });
        expect(loadStoredChat(server.user, result.conversation.id, chatEntry.id).slice(1).map(record => record.mes)).toEqual(['one', 'two']);
        expect(() => readStoredConversation(server.user, GROUP.id)).toThrow();
    });

    test('the direct conversation that the group joins keeps its own chats, and the cache lists them all', async () => {
        await started([DIRECT, { ...GROUP, characters: ['Nova.png', 'Orion.png'] }]);

        const result = await data.removeMember(GROUP.id, 'Orion.png');

        expect(result.conversation.id).toBe(DIRECT.id);
        expect(result.conversation.chats.map(entry => entry.name)).toEqual(['Main', 'Trip']);
        expect(data.list().map(view => view.id)).toEqual([DIRECT.id]);
    });

    test('a conversion that the server could not do leaves the group in the cache as it was, and says why', async () => {
        await started([{ ...GROUP, characters: ['Nova.png', 'Orion.png'] }]);
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const original = adapter.fetchJson;
        adapter.fetchJson = async (path, body, options) => (path === '/members/remove'
            ? { status: 500, json: { error: 'conversion_failed' } }
            : original(path, body, options));

        await expect(data.removeMember(GROUP.id, 'Orion.png')).rejects.toMatchObject({ code: 'conversion_failed', status: 500 });

        expect(data.get(GROUP.id).characters).toEqual(['Nova.png', 'Orion.png']);
        expect(data.list()).toHaveLength(1);
    });

    test('a character that is not a member is not found, and a direct conversation has no members to remove', async () => {
        await started([GROUP, DIRECT]);

        await expect(data.removeMember(GROUP.id, 'Quill.png')).rejects.toMatchObject({ code: 'not_found' });
        await expect(data.removeMember(DIRECT.id, 'Nova.png')).rejects.toMatchObject({ code: 'invalid_input' });
        expect(data.get(GROUP.id).characters).toEqual(['Nova.png', 'Orion.png', 'Pip.png']);
    });
});

describe('extras', () => {
    const WITH_EXTRAS = { ...DIRECT, extras: ['Orion.png', 'Pip.png'] };

    test('an extra is removed, and the messages of that character stay', async () => {
        await started([WITH_EXTRAS]);

        const view = await data.removeExtra(DIRECT.id, 'Orion.png');

        expect(view).toBe(data.get(DIRECT.id));
        expect(view.extras).toEqual(['Pip.png']);
        expect(view.messageCount).toBe(4);
        expect(readStoredConversation(server.user, DIRECT.id).extras).toEqual(['Pip.png']);
    });

    test('a character that is not an extra is not found, and a group has no extras', async () => {
        await started([WITH_EXTRAS, GROUP]);

        await expect(data.removeExtra(DIRECT.id, 'Quill.png')).rejects.toMatchObject({ code: 'not_found' });
        await expect(data.removeExtra(GROUP.id, 'Orion.png')).rejects.toMatchObject({ code: 'invalid_input' });
    });
});

describe('export', () => {
    test('answers the file of the chat as stored, with the file name that the server made from the chat name', async () => {
        await started([{ ...DIRECT, chats: [{ ...DIRECT.chats[0], name: 'Trip: day 1' }] }]);

        const file = await data.exportChat(ADDRESS);

        expect(file.fileName).toMatch(/^Trip.* day 1\.jsonl$/);
        const lines = file.text.trimEnd().split('\n').map(text => JSON.parse(text));
        expect(lines.slice(1).map(record => record.id)).toEqual(['main-0', 'main-1', 'main-2', 'main-3']);
        expect(adapter.callsTo('/chat/export')[0].body).toEqual({ id: DIRECT.id, chatId: 'main' });
    });

    test('rejects with the code of the route for a chat that does not exist', async () => {
        await started([DIRECT]);

        await expect(data.exportChat({ conversationId: DIRECT.id, chatId: 'gone' })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    });

    test('sends the edits that wait before it reads the file, so that the export has the latest messages', async () => {
        await started([DIRECT]);
        await data.loadChat(ADDRESS);
        data.commitChat(ADDRESS, (draft) => {
            draft.messages.push(line('main-9', 'the latest line', { minute: 40 }));
        });

        const file = await data.exportChat(ADDRESS);

        expect(file.text).toContain('the latest line');
    });
});

