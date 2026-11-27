/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { describe, expect, test } from '@jest/globals';
import { findRecentChatRow, readRecentChatIdentity, resolveRecentChatTarget } from '../../public/scripts/sillybunny-home/recent-chat.js';

function row(attributes = {}) {
    const element = document.createElement('article');
    element.className = 'recentChat';
    for (const [name, value] of Object.entries(attributes)) {
        element.setAttribute(`data-${name}`, value);
    }
    return element;
}

function panelWith(...rows) {
    const panel = document.createElement('div');
    panel.append(...rows);
    return panel;
}

const characterRow = () => row({ 'recent-chat-type': 'individual', avatar: 'tewi.png', file: 'Tewi - 1', group: '' });
const groupRow = () => row({ 'recent-chat-type': 'group', avatar: '', file: 'Party - 3', group: 'g-17' });
const conversationRow = () => row({
    'recent-chat-type': 'conversation',
    avatar: 'reisen.png',
    file: 'Reisen - c',
    group: '',
    'conversation-id': 'conv_1_reisen',
    'conversation-chat-id': 'chat-2',
    'conversation-chat-name': 'Evening',
});

describe('readRecentChatIdentity', () => {
    test('reads the identity attributes and turns a missing one into an empty string', () => {
        expect(readRecentChatIdentity(characterRow())).toEqual({ file: 'Tewi - 1', avatar: 'tewi.png', group: '', conversationId: '', chatId: '' });
        expect(readRecentChatIdentity(conversationRow())).toEqual({ file: 'Reisen - c', avatar: 'reisen.png', group: '', conversationId: 'conv_1_reisen', chatId: 'chat-2' });
    });
});

describe('findRecentChatRow', () => {
    test('finds the row with the same identity in a freshly rendered panel', () => {
        const before = characterRow();
        const after = characterRow();
        const identity = readRecentChatIdentity(before);

        expect(findRecentChatRow(panelWith(groupRow(), after), identity)).toBe(after);
    });

    test('tells apart rows that share a file name but not an owner', () => {
        const mine = row({ avatar: 'a.png', file: 'Chat 1', group: '' });
        const other = row({ avatar: 'b.png', file: 'Chat 1', group: '' });

        expect(findRecentChatRow(panelWith(other, mine), readRecentChatIdentity(mine))).toBe(mine);
    });

    test('tells apart the chats of one conversation, and the conversations of one character', () => {
        const first = row({ avatar: 'a.png', file: 'c', group: '', 'conversation-id': 'conv_1_a', 'conversation-chat-id': 'one' });
        const second = row({ avatar: 'a.png', file: 'c', group: '', 'conversation-id': 'conv_1_a', 'conversation-chat-id': 'two' });
        const third = row({ avatar: 'a.png', file: 'c', group: '', 'conversation-id': 'conv_2_a', 'conversation-chat-id': 'two' });

        expect(findRecentChatRow(panelWith(first, second, third), readRecentChatIdentity(second))).toBe(second);
        expect(findRecentChatRow(panelWith(first, second, third), readRecentChatIdentity(third))).toBe(third);
    });

    test('returns null when the row is gone', () => {
        const gone = characterRow();

        expect(findRecentChatRow(panelWith(groupRow()), readRecentChatIdentity(gone))).toBeNull();
    });
});

describe('resolveRecentChatTarget', () => {
    const chats = [
        { chat_name: 'Tewi - 1', avatar: 'tewi.png', is_group: false, group: '' },
        { chat_name: 'Party - 3', avatar: '', is_group: true, group: 'g-17' },
        { chat_name: 'Reisen - c', avatar: 'reisen.png', is_group: false, is_conversation: true, group: '', conversation_id: 'conv_1_reisen', conversation_chat_id: 'chat-2' },
        { chat_name: 'Tewi - 1', avatar: 'other.png', is_group: false, group: '' },
    ];

    test('resolves a character chat and its recent chat record', () => {
        const target = resolveRecentChatTarget(characterRow(), chats);

        expect(target).toMatchObject({ avatarId: 'tewi.png', groupId: '', fileName: 'Tewi - 1', isConversation: false });
        expect(target.recentChat).toBe(chats[0]);
    });

    test('resolves a group chat by its group id', () => {
        const target = resolveRecentChatTarget(groupRow(), chats);

        expect(target).toMatchObject({ groupId: 'g-17', fileName: 'Party - 3', isConversation: false });
        expect(target.recentChat).toBe(chats[1]);
    });

    test('resolves a Conversation chat with the ids of its conversation and itself, and its name', () => {
        const target = resolveRecentChatTarget(conversationRow(), chats);

        expect(target).toMatchObject({ avatarId: 'reisen.png', conversationId: 'conv_1_reisen', chatId: 'chat-2', chatName: 'Evening', isConversation: true });
        expect(target.recentChat).toBe(chats[2]);
    });

    test('leaves the recent chat undefined when the list has no match', () => {
        expect(resolveRecentChatTarget(characterRow(), []).recentChat).toBeUndefined();
    });
});
