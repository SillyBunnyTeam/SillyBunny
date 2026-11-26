/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, test } from '@jest/globals';

import {
    PIN_EVENT_ACTIONS,
    createPinEventRow,
    createPinnedMark,
    detachPinEventRows,
    placePinEventRows,
} from '../public/scripts/sillybunny-conversation/pin-events-ui.js';

let timeline;

const messageNode = id => {
    const node = document.createElement('article');
    node.className = 'sb-conversation-message';
    node.dataset.messageId = id;
    return node;
};
const dividerNode = key => {
    const node = document.createElement('div');
    node.className = 'sb-conversation-day-divider';
    node.dataset.dayKey = key;
    return node;
};
const event = (messageId, afterMessageId = messageId, at = 1) => ({ messageId, afterMessageId, at });
const order = () => [...timeline.children].map(node => node.dataset.messageId ? `${node.classList.contains('sb-conversation-event') ? 'event:' : ''}${node.dataset.messageId}` : `day:${node.dataset.dayKey}`);

beforeEach(() => {
    document.body.innerHTML = '<div id="sb_conversation_timeline"></div>';
    timeline = document.getElementById('sb_conversation_timeline');
});

describe('the Pinned mark of a bubble', () => {
    test('says Pinned in words, so that the state does not rest on an icon or a colour', () => {
        const mark = createPinnedMark();

        expect(mark.textContent).toBe('Pinned');
        expect(mark.classList.contains('sb-conversation-message-pinned')).toBe(true);
        expect(mark.querySelector('i')).toBeNull();
    });
});

describe('the line that says a message was pinned', () => {
    test('says that the user pinned a message, and holds two buttons: one to show the message, one to see all pinned messages', () => {
        const row = createPinEventRow(event('b'));
        const buttons = [...row.querySelectorAll('button')];

        expect(row.textContent).toContain('You pinned a message.');
        expect(row.dataset.messageId).toBe('b');
        expect(buttons.map(button => button.textContent)).toEqual(['Show Message', 'See All Pinned']);
        expect(buttons.map(button => button.dataset.sbConversationAction)).toEqual([PIN_EVENT_ACTIONS.show, PIN_EVENT_ACTIONS.openPinned]);
        expect(buttons.every(button => button.type === 'button')).toBe(true);
        expect(buttons.every(button => button.dataset.messageId === 'b')).toBe(true);
    });

    test('is not a message: it has no message class, no author and no data that the message readers look for', () => {
        const row = createPinEventRow(event('b'));

        expect(row.classList.contains('sb-conversation-message')).toBe(false);
        expect(row.matches('[data-role]')).toBe(false);
        expect(row.dataset.sbConversationEvent).toBe('pin');
    });

    test('keeps the glyph out of the accessible text', () => {
        const row = createPinEventRow(event('b'));

        expect(row.querySelector('i').getAttribute('aria-hidden')).toBe('true');
    });
});

describe('placePinEventRows', () => {
    test('puts each line after the message that its event names, in the order of the events', () => {
        timeline.append(messageNode('a'), messageNode('b'), messageNode('c'));

        placePinEventRows(timeline, [event('a'), event('b', 'c')], detachPinEventRows(timeline));

        expect(order()).toEqual(['a', 'event:a', 'b', 'c', 'event:b']);
    });

    test('puts two lines of one place in the order given, and both before the next message', () => {
        timeline.append(messageNode('a'), messageNode('b'), messageNode('c'));

        placePinEventRows(timeline, [event('a', 'b'), event('b', 'b')], detachPinEventRows(timeline));

        expect(order()).toEqual(['a', 'b', 'event:a', 'event:b', 'c']);
    });

    test('puts a line before the divider of the day that follows its message, because the line belongs to the day it was pinned on', () => {
        timeline.append(messageNode('a'), dividerNode('2026-01-02'), messageNode('b'));

        placePinEventRows(timeline, [event('a')], detachPinEventRows(timeline));

        expect(order()).toEqual(['a', 'event:a', 'day:2026-01-02', 'b']);
    });

    test('leaves out a line whose message is not drawn, and draws nothing for no events', () => {
        timeline.append(messageNode('a'));

        placePinEventRows(timeline, [event('gone', 'gone'), event('a', 'missing')], detachPinEventRows(timeline));
        expect(order()).toEqual(['a']);

        placePinEventRows(timeline, [], detachPinEventRows(timeline));
        expect(order()).toEqual(['a']);
    });

    test('takes a line away when its event is gone, which is how an unpin removes it', () => {
        timeline.append(messageNode('a'), messageNode('b'));
        placePinEventRows(timeline, [event('a')], detachPinEventRows(timeline));
        expect(order()).toEqual(['a', 'event:a', 'b']);

        placePinEventRows(timeline, [], detachPinEventRows(timeline));

        expect(order()).toEqual(['a', 'b']);
    });

    test('keeps the element of a line from one draw to the next, so that a button that has the focus keeps it, and the window that will return the focus to it still has it', () => {
        timeline.append(messageNode('a'), messageNode('b'));
        placePinEventRows(timeline, [event('a')], detachPinEventRows(timeline));
        const button = timeline.querySelector('[data-sb-conversation-action="open-pinned-messages"]');
        button.focus();
        expect(document.activeElement).toBe(button);

        const detached = detachPinEventRows(timeline);
        timeline.insertBefore(messageNode('c'), timeline.firstChild);
        placePinEventRows(timeline, [event('a')], detached);

        expect(timeline.querySelector('[data-sb-conversation-action="open-pinned-messages"]')).toBe(button);
        expect(document.activeElement).toBe(button);
    });

    test('does not move the focus that was elsewhere', () => {
        timeline.append(messageNode('a'));
        const input = document.createElement('input');
        document.body.append(input);
        placePinEventRows(timeline, [event('a')], detachPinEventRows(timeline));
        input.focus();

        placePinEventRows(timeline, [event('a')], detachPinEventRows(timeline));

        expect(document.activeElement).toBe(input);
    });

    test('detaches the lines before the messages are put in order, so that the children of the timeline are the messages alone', () => {
        timeline.append(messageNode('a'), messageNode('b'));
        placePinEventRows(timeline, [event('a')], detachPinEventRows(timeline));

        detachPinEventRows(timeline);

        expect(order()).toEqual(['a', 'b']);
    });
});
