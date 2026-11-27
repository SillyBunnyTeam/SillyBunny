import { describe, expect, test } from '@jest/globals';

import {
    PIN_FIELD,
    PIN_TIME_FIELD,
    getPinEvents,
    hasPinnedMessage,
    isPinned,
    readPinnedAt,
    setMessagePin,
} from '../public/scripts/sillybunny-conversation/pin-model.js';

const NOW = 1_700_000_000_000;
const timeOf = message => Number(message?.created_at) || 0;
const message = (id, created_at, extra) => ({ id, role: 'character', mes: id, created_at, ...(extra ? { extra } : {}) });
const pinnedAt = (id, created_at, at) => message(id, created_at, { [PIN_FIELD]: true, ...(at === undefined ? {} : { [PIN_TIME_FIELD]: at }) });
const eventsOf = messages => getPinEvents(messages, timeOf).map(event => `${event.messageId}>${event.afterMessageId}`);

describe('the pin of a message', () => {
    test('is stored as the boolean that older builds wrote and a time beside it, so a boolean alone still reads as a pin', () => {
        expect(PIN_FIELD).toBe('conversation_pinned');
        expect(PIN_TIME_FIELD).toBe('conversation_pinned_at');
        expect(isPinned(pinnedAt('a', 10))).toBe(true);
        expect(isPinned(message('a', 10))).toBe(false);
        expect(isPinned(message('a', 10, { conversation_pinned: false }))).toBe(false);
        expect(isPinned(null)).toBe(false);
    });

    test('reads the time of an old pin, which has none, as zero', () => {
        expect(readPinnedAt(pinnedAt('a', 10))).toBe(0);
    });

    test('reads the time that was written, and nothing that is not a time', () => {
        expect(readPinnedAt(pinnedAt('a', 10, NOW))).toBe(NOW);
        for (const value of ['soon', '1700000000000', -5, 0, NaN, Infinity, 1.5, null, {}, [], true, 8_640_000_000_000_001]) {
            expect(readPinnedAt(pinnedAt('a', 10, value))).toBe(0);
        }
    });

    test('reads no time from a message that is not pinned, whatever a stale value says', () => {
        expect(readPinnedAt(message('a', 10, { conversation_pinned: false, conversation_pinned_at: NOW }))).toBe(0);
        expect(readPinnedAt(message('a', 10, { conversation_pinned_at: NOW }))).toBe(0);
    });
});

describe('setMessagePin', () => {
    test('pins with the time of now, and keeps what else the message carries in its extra', () => {
        const target = message('a', 10, { conversation_reactions: [{ emoji: '❤️', by: 'user', at: 1 }], member_avatar: 'nova.png' });

        setMessagePin(target, true, { at: NOW });

        expect(target.extra).toEqual({ conversation_reactions: [{ emoji: '❤️', by: 'user', at: 1 }], member_avatar: 'nova.png', conversation_pinned: true, conversation_pinned_at: NOW });
    });

    test('takes the time from the clock when it is not given', () => {
        const target = message('a', 10);

        setMessagePin(target, true);

        expect(readPinnedAt(target)).toBeGreaterThan(1_700_000_000_000);
    });

    test('removes the time when the user unpins, and writes the boolean as false as before', () => {
        const target = pinnedAt('a', 10, NOW);

        setMessagePin(target, false);

        expect(target.extra).toEqual({ conversation_pinned: false });
        expect(Object.hasOwn(target.extra, 'conversation_pinned_at')).toBe(false);
    });

    test('replaces the extra instead of editing it, so that a copy of the old one keeps what it was', () => {
        const target = message('a', 10, { conversation_reactions: [] });
        const before = target.extra;

        setMessagePin(target, true, { at: NOW });

        expect(before).toEqual({ conversation_reactions: [] });
        expect(target.extra).not.toBe(before);
    });

    test('returns the pin that the message had, so that an undo can write it back', () => {
        expect(setMessagePin(pinnedAt('a', 10, NOW), false)).toEqual({ pinned: true, at: NOW });
        expect(setMessagePin(pinnedAt('a', 10), false)).toEqual({ pinned: true, at: 0 });
        expect(setMessagePin(message('a', 10), true, { at: NOW })).toEqual({ pinned: false, at: 0 });
    });

    test('restores an old pin without a time as one without a time, so that an undo does not make a line for it', () => {
        const target = pinnedAt('a', 10);
        const before = setMessagePin(target, false);

        setMessagePin(target, before.pinned, { at: before.at });

        expect(target.extra).toEqual({ conversation_pinned: true });
    });

    test('does nothing to a missing message', () => {
        expect(() => setMessagePin(undefined, true)).not.toThrow();
    });
});

describe('hasPinnedMessage', () => {
    test('is true when any message of the chat is pinned, with a time or without', () => {
        expect(hasPinnedMessage([message('a', 1), pinnedAt('b', 2)])).toBe(true);
        expect(hasPinnedMessage([message('a', 1), pinnedAt('b', 2, NOW)])).toBe(true);
        expect(hasPinnedMessage([message('a', 1), message('b', 2)])).toBe(false);
        expect(hasPinnedMessage([])).toBe(false);
        expect(hasPinnedMessage(undefined)).toBe(false);
    });

    test('does not count a reply that the server wrote and no page has landed yet', () => {
        const pending = { ...message('p', 3), extra: { conversation_pinned: true, server_generation: { pending: true } } };

        expect(hasPinnedMessage([message('a', 1), pending])).toBe(false);
    });
});

describe('the events of the pins, placed by the time of the pin among the messages', () => {
    test('puts the line after the pinned message when nothing came after it', () => {
        expect(eventsOf([message('a', 100), pinnedAt('b', 200, 300)])).toEqual(['b>b']);
    });

    test('puts the line after the last message that is as old as the pin, and later messages stay after it', () => {
        const messages = [message('a', 100), pinnedAt('b', 200, 450), message('c', 300), message('d', 400), message('e', 500), message('f', 600)];

        expect(eventsOf(messages)).toEqual(['b>d']);
    });

    test('keeps its place when more messages come, and moves for nothing', () => {
        const before = [message('a', 100), pinnedAt('b', 200, 250), message('c', 300)];
        const after = [...before, message('d', 400), message('e', 500)];

        expect(eventsOf(before)).toEqual(['b>b']);
        expect(eventsOf(after)).toEqual(['b>b']);
    });

    test('counts a message sent in the same millisecond as before the line', () => {
        expect(eventsOf([pinnedAt('a', 100, 300), message('b', 300), message('c', 301)])).toEqual(['a>b']);
    });

    test('never puts a line before the message that it is about, whatever the time says', () => {
        expect(eventsOf([message('a', 100), message('b', 200), pinnedAt('c', 300, 150), message('d', 400)])).toEqual(['c>c']);
    });

    test('draws no line for an old pin that has no time, and none for a message that is not pinned', () => {
        expect(eventsOf([pinnedAt('a', 100), message('b', 200), message('c', 300, { conversation_pinned: false, conversation_pinned_at: 500 })])).toEqual([]);
    });

    test('draws one line for each pinned message, in the order of the chat across places', () => {
        const messages = [pinnedAt('a', 100, 150), message('b', 200), pinnedAt('c', 300, 350), message('d', 400), pinnedAt('e', 500, 120)];

        expect(eventsOf(messages)).toEqual(['a>a', 'c>c', 'e>e']);
    });

    test('draws the lines of one place in the order that the messages were pinned in, not the order that they stand in', () => {
        const messages = [pinnedAt('a', 100, 700), pinnedAt('b', 200, 650), message('c', 300)];

        expect(eventsOf(messages)).toEqual(['b>c', 'a>c']);
    });

    test('stops at a message with no time, because where the pin falls after it cannot be known', () => {
        expect(eventsOf([pinnedAt('a', 100, 900), message('b', 0), message('c', 200)])).toEqual(['a>a']);
        expect(eventsOf([pinnedAt('a', 0, 900), message('b', 200)])).toEqual(['a>b']);
    });

    test('gives the pin time and the id of the message on each event', () => {
        const [event] = getPinEvents([pinnedAt('a', 100, 250), message('b', 300)], timeOf);

        expect(event).toEqual({ messageId: 'a', at: 250, afterMessageId: 'a' });
    });

    test('is empty for no messages, and does not read a message that is not an object', () => {
        expect(getPinEvents([], timeOf)).toEqual([]);
        expect(getPinEvents(undefined, timeOf)).toEqual([]);
        expect(getPinEvents([null, undefined, 'a', pinnedAt('b', 1, 2)], timeOf)).toEqual([{ messageId: 'b', at: 2, afterMessageId: 'b' }]);
    });

    test('does not change the messages that it reads', () => {
        const messages = [message('a', 100), pinnedAt('b', 200, 250), message('c', 300)];
        const copy = structuredClone(messages);

        getPinEvents(messages, timeOf);

        expect(messages).toEqual(copy);
    });
});
