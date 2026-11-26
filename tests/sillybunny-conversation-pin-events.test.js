import { describe, expect, test } from '@jest/globals';

import { summarizeChat } from '../public/scripts/sillybunny-conversation/conversation-summary.js';
import { getConversationMessageRevision, getConversationMessagesRevision } from '../public/scripts/sillybunny-conversation/message-identity-utils.js';
import { getPinEvents, setMessagePin } from '../public/scripts/sillybunny-conversation/pin-model.js';
import { getConversationMessageExtraFingerprint } from '../public/scripts/sillybunny-conversation/render-utils.js';
import { summarizeChatRecords } from '../src/conversation-schema.js';

// The line that says a message was pinned is drawn from the pin time on the message. It is not a chat record, so what
// reads the records (the summary of the list, the unread count, the preview, the revision that the send queue keeps, the
// prompt) cannot read it. These tests hold that from both sides: pinning changes none of those answers, and the events are
// a description of a place, never a message.
const header = () => ({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' });
const minute = value => Date.UTC(2026, 0, 1, 0, value);
const record = (id, mes, { role = 'character', at = 0, extra } = {}) => ({
    id,
    role,
    name: role === 'user' ? 'Me' : 'Her',
    mes,
    is_user: role === 'user',
    is_system: false,
    send_date: new Date(minute(at)).toISOString(),
    created_at: minute(at),
    ...(extra ? { extra } : {}),
});

const chat = () => [
    record('a', 'first', { at: 1 }),
    record('b', 'me', { role: 'user', at: 2 }),
    record('c', 'reply', { role: 'member', at: 3, extra: { member_avatar: 'nova.png' } }),
    record('d', 'last <b>line</b>', { at: 4 }),
];
const pinned = (messages, ids) => {
    const copy = structuredClone(messages);
    for (const target of copy.filter(item => ids.includes(item.id))) {
        setMessagePin(target, true, { at: minute(5) });
    }
    return copy;
};

describe('a pin and the time of its line', () => {
    test('change nothing of what the list and the badge read from a chat: count, last time, preview, unread, last role', () => {
        const messages = chat();
        const withPins = pinned(messages, ['a', 'c', 'd']);

        for (const readThrough of ['', 'a', 'b', 'd']) {
            expect(summarizeChat(withPins, readThrough)).toEqual(summarizeChat(messages, readThrough));
            expect(summarizeChatRecords([header(), ...withPins], readThrough)).toEqual(summarizeChatRecords([header(), ...messages], readThrough));
        }
        expect(summarizeChat(withPins, 'a').messageCount).toBe(4);
    });

    test('change nothing of the revision that the send queue compares, so a queued message stays valid when the user pins one', () => {
        const messages = chat();
        const withPins = pinned(messages, ['a', 'b']);

        expect(getConversationMessagesRevision(withPins)).toBe(getConversationMessagesRevision(messages));
        for (const [index, item] of withPins.entries()) {
            expect(getConversationMessageRevision(item)).toBe(getConversationMessageRevision(messages[index]));
        }
    });

    test('do change what the timeline draws from a message, so that its mark and its line are drawn again and taken away again', () => {
        const [plain] = chat();
        const [pin] = pinned([plain], ['a']);
        const later = structuredClone(pin);
        setMessagePin(later, true, { at: minute(9) });
        const unpinned = structuredClone(pin);
        setMessagePin(unpinned, false);

        expect(getConversationMessageExtraFingerprint(pin)).not.toBe(getConversationMessageExtraFingerprint(plain));
        expect(getConversationMessageExtraFingerprint(later)).not.toBe(getConversationMessageExtraFingerprint(pin));
        expect(getConversationMessageExtraFingerprint(unpinned)).not.toBe(getConversationMessageExtraFingerprint(pin));
    });
});

describe('the events of the pins', () => {
    const timeOf = message => Number(message.created_at) || 0;

    test('are a description of a place, with no field of a message, so that they cannot be taken for one or saved as one', () => {
        const events = getPinEvents(pinned(chat(), ['b']), timeOf);

        expect(events).toHaveLength(1);
        expect(Object.keys(events[0]).sort()).toEqual(['afterMessageId', 'at', 'messageId']);
        for (const field of ['id', 'role', 'mes', 'extra', 'is_system', 'created_at']) {
            expect(events[0]).not.toHaveProperty(field);
        }
    });

    test('leave the chat as it was: the same records in the same order, with the same keys', () => {
        const messages = pinned(chat(), ['a', 'c']);
        const before = structuredClone(messages);

        getPinEvents(messages, timeOf);

        expect(messages).toEqual(before);
        expect(messages.map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    test('are not made from a chat that has no pin with a time, whatever its other extras say', () => {
        const messages = chat().map(item => ({ ...item, extra: { ...item.extra, conversation_reactions: [{ emoji: '❤️', by: 'user', at: 1 }] } }));

        expect(getPinEvents(messages, timeOf)).toEqual([]);
    });
});
