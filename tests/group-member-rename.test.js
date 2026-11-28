/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { event_types } from '../public/scripts/events.js';
import { createGroupChatsRuntime } from './util/group-chats-sandbox.js';

const header = roster => ({ user_name: 'User', character_name: 'Group', chat_metadata: { roster } });
const line = (name, avatar, mes) => ({ name, original_avatar: avatar, force_avatar: `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`, mes, is_user: false });
const userLine = mes => ({ name: 'User', mes, is_user: true });

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('renaming a group member in past chats', () => {
    test('tells every chat of the group about the rename, not only chats the member wrote in', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const chats = {
            'chat-1': [header(['alice.png', 'bob.png']), userLine('Hi.'), line('Bob', 'bob.png', 'Hello.')],
            'chat-2': [header(['alice.png', 'bob.png']), userLine('Hi.'), line('Alice', 'alice.png', 'Hello.')],
        };
        const { groupChats, eventSource, saves } = await createGroupChatsRuntime({ chats, openInitialGroup: false });
        const heard = [];
        eventSource.on(event_types.CHARACTER_RENAMED_IN_PAST_CHAT, (messages, oldAvatar, newAvatar, rename) => {
            heard.push(messages);
            const roster = messages[0].chat_metadata.roster;
            roster.splice(0, roster.length, ...roster.map(avatar => (avatar === oldAvatar ? newAvatar : avatar)));
            rename.markChanged();
        });

        await groupChats.renameGroupMember('bob.png', 'robert.png', 'Robert');

        expect(heard).toEqual([chats['chat-1'], chats['chat-2']]);
        expect(saves.map(save => save.id)).toEqual(['chat-1', 'chat-2']);
        expect(saves[0].chat[2]).toMatchObject({ name: 'Robert', original_avatar: 'robert.png' });
        expect(saves[0].chat[0].chat_metadata.roster).toEqual(['alice.png', 'robert.png']);
        expect(saves[1].chat[0].chat_metadata.roster).toEqual(['alice.png', 'robert.png']);
        expect(groupChats.groups[0].members).toContain('robert.png');
    });

    test('leaves a chat alone when neither the host nor a listener changed it', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const chats = {
            'chat-1': [header([]), userLine('Hi.'), line('Alice', 'alice.png', 'Hello.')],
            'chat-2': [header([]), userLine('Hi.'), line('Bob', 'bob.png', 'Hello.')],
        };
        const { groupChats, eventSource, saves } = await createGroupChatsRuntime({ chats, openInitialGroup: false });
        let heard = 0;
        eventSource.on(event_types.CHARACTER_RENAMED_IN_PAST_CHAT, () => { heard++; });

        await groupChats.renameGroupMember('bob.png', 'robert.png', 'Robert');

        expect(heard).toBe(2);
        expect(saves.map(save => save.id)).toEqual(['chat-2']);
    });

    test('saves a chat a listener changed even when the rename touched no message in it', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const chats = {
            'chat-1': [header(['alice.png', 'bob.png']), userLine('Hi.'), line('Alice', 'alice.png', 'Hello.')],
        };
        const { groupChats, eventSource, saves } = await createGroupChatsRuntime({ chats, openInitialGroup: false });
        eventSource.on(event_types.CHARACTER_RENAMED_IN_PAST_CHAT, (messages, _oldAvatar, newAvatar, rename) => {
            messages[0].chat_metadata.roster = [newAvatar];
            rename.markChanged();
        });

        await groupChats.renameGroupMember('bob.png', 'robert.png', 'Robert');

        expect(saves.map(save => save.id)).toEqual(['chat-1']);
        expect(saves[0].chat[0].chat_metadata.roster).toEqual(['robert.png']);
        expect(saves[0].chat[2]).toMatchObject({ name: 'Alice', original_avatar: 'alice.png' });
    });
});
