/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest/jsdom contracts. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { OPENING_HOLD_MS, createOpeningHold, shouldHoldChatAtTop } from '../../public/scripts/sillybunny-home/greeting-art-opening.js';

const readSource = path => readFileSync(fileURLToPath(new URL(`../../public/${path}`, import.meta.url)), 'utf8');

/**
 * A chat element that scrolls and measures like a real one, a clock the test moves by hand, and a hold that reads
 * both. `isPerson` is true for every event, because jsdom cannot make a trusted one.
 */
function setup({ greetingOnly = true, overflows = true, isPerson = () => true } = {}) {
    document.body.innerHTML = '<div id="chat"></div><textarea id="box"></textarea>';
    const chatElement = document.getElementById('chat');
    let scrollTop = 0;
    Object.defineProperties(chatElement, {
        scrollTop: { configurable: true, get: () => scrollTop, set: (value) => { scrollTop = value; } },
        scrollHeight: { configurable: true, get: () => (overflows ? 1000 : 100) },
        clientHeight: { configurable: true, get: () => 500 },
    });
    const chat = { greetingOnly, clock: 0 };
    const hold = createOpeningHold({ chatElement, isGreetingOnly: () => chat.greetingOnly, win: window, now: () => chat.clock, isPerson });
    return {
        chat,
        hold,
        chatElement,
        setScrollTop: (value) => { scrollTop = value; },
        passTime: (ms) => {
            chat.clock += ms;
            jest.advanceTimersByTime(ms);
        },
        /** An opening from Home with its picture placed. */
        open() {
            hold.beginOpening();
            hold.offer();
        },
    };
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '';
});

describe('the hold of a chat that is opening', () => {
    test('starts when a chat opens from Home with a greeting that has a picture and overflows', () => {
        const { hold, setScrollTop, chatElement } = setup();
        setScrollTop(53);

        hold.beginOpening();
        expect(hold.shouldHold()).toBe(false);
        hold.offer();

        expect(hold.shouldHold()).toBe(true);
        expect(shouldHoldChatAtTop()).toBe(true);
        expect(chatElement.scrollTop).toBe(0);
    });

    test('does not start without an opening', () => {
        const { hold } = setup();

        hold.offer();

        expect(hold.shouldHold()).toBe(false);
        expect(shouldHoldChatAtTop()).toBe(false);
    });

    test('does not start for an opening that is over', () => {
        const { hold, passTime } = setup();
        hold.beginOpening();

        passTime(OPENING_HOLD_MS);
        hold.offer();

        expect(hold.shouldHold()).toBe(false);
    });

    test('does not start when the chat holds more than the greeting', () => {
        const { hold } = setup({ greetingOnly: false });

        hold.beginOpening();
        hold.offer();

        expect(hold.shouldHold()).toBe(false);
    });

    test('does not start when the greeting already fits', () => {
        const { hold } = setup({ overflows: false });

        hold.beginOpening();
        hold.offer();

        expect(hold.shouldHold()).toBe(false);
    });
});

describe('what ends the hold', () => {
    test('a second message, and the hold does not come back when the chat is only the greeting again', () => {
        const { open, hold, chat } = setup();
        open();

        chat.greetingOnly = false;
        expect(hold.shouldHold()).toBe(false);

        chat.greetingOnly = true;
        expect(hold.shouldHold()).toBe(false);
    });

    test('the time', () => {
        const { open, hold, passTime } = setup();
        open();

        passTime(OPENING_HOLD_MS - 1);
        expect(hold.shouldHold()).toBe(true);
        passTime(1);
        expect(hold.shouldHold()).toBe(false);
    });

    test('the time also takes the listeners off the page', () => {
        const remove = jest.spyOn(document, 'removeEventListener');
        const { open, passTime } = setup();
        open();

        passTime(OPENING_HOLD_MS);

        expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['wheel', 'touchstart', 'pointerdown', 'keydown']));
        remove.mockRestore();
    });

    test.each(['wheel', 'touchstart', 'pointerdown'])('a %s on the page', (type) => {
        const { open, hold } = setup();
        open();

        document.body.dispatchEvent(new Event(type, { bubbles: true }));

        expect(hold.shouldHold()).toBe(false);
    });

    test.each(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])('the %j key outside a field', (key) => {
        const { open, hold } = setup();
        open();

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

        expect(hold.shouldHold()).toBe(false);
    });

    test('is not ended by typing, or by a scroll key in a text field', () => {
        const { open, hold } = setup();
        open();
        const box = document.getElementById('box');

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        box.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

        expect(hold.shouldHold()).toBe(true);
    });

    test('is not ended by an event that a script made', () => {
        const { open, hold } = setup({ isPerson: event => event.isTrusted });
        open();

        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));

        expect(hold.shouldHold()).toBe(true);
    });

    test('a scroll of the chat away from the top, and not a scroll that stays at the top', () => {
        const { open, hold, chatElement, setScrollTop } = setup();
        open();

        chatElement.dispatchEvent(new Event('scroll'));
        expect(hold.shouldHold()).toBe(true);

        setScrollTop(46);
        chatElement.dispatchEvent(new Event('scroll'));
        expect(hold.shouldHold()).toBe(false);
    });
});

describe('an opening', () => {
    test('is one opening for a Home panel that is removed and the CHAT_CHANGED events that follow it', () => {
        const { hold } = setup();
        hold.beginOpening();
        hold.chatChanged('chat A');
        hold.chatChanged('chat A');

        hold.offer();
        expect(hold.shouldHold()).toBe(true);

        document.body.dispatchEvent(new Event('wheel', { bubbles: true }));
        hold.chatChanged('chat A');
        hold.offer();

        expect(hold.shouldHold()).toBe(false);
    });

    test('is over for the hold once a person has scrolled, even when the signal that opened it comes again', () => {
        const { hold } = setup();
        hold.chatChanged('chat A');
        hold.offer();
        document.body.dispatchEvent(new Event('wheel', { bubbles: true }));

        hold.chatChanged('chat A');
        hold.offer();

        expect(hold.shouldHold()).toBe(false);
    });

    test('is a new one for a chat with another id, so a takeover does not carry over to it', () => {
        const { hold, passTime } = setup();
        hold.chatChanged('chat A');
        hold.offer();
        document.body.dispatchEvent(new Event('wheel', { bubbles: true }));
        passTime(100);

        hold.chatChanged('chat B');
        hold.offer();

        expect(hold.shouldHold()).toBe(true);
    });

    test('is a new one for a chat that opens from Home, so a takeover does not carry over to it', () => {
        const { hold, passTime } = setup();
        hold.beginOpening();
        hold.offer();
        document.body.dispatchEvent(new Event('wheel', { bubbles: true }));
        passTime(100);

        hold.beginOpening();
        hold.offer();

        expect(hold.shouldHold()).toBe(true);
    });

    test('is a new one for the same chat id once the opening is over', () => {
        const { hold, passTime } = setup();
        hold.chatChanged('chat A');
        hold.offer();
        document.body.dispatchEvent(new Event('wheel', { bubbles: true }));
        passTime(OPENING_HOLD_MS);

        hold.chatChanged('chat A');
        hold.offer();

        expect(hold.shouldHold()).toBe(true);
    });

    test('gets its id from the first CHAT_CHANGED after Home, and a chat with another id is not part of it', () => {
        const { hold } = setup();
        hold.beginOpening();
        hold.chatChanged('chat A');
        hold.offer();
        document.body.dispatchEvent(new Event('wheel', { bubbles: true }));

        hold.chatChanged('chat B');
        hold.offer();

        expect(hold.shouldHold()).toBe(true);
    });
});

describe('a chat that changes while the hold is on', () => {
    test('ends the hold when the new chat is not a greeting with a picture', () => {
        const { open, hold, chat } = setup();
        open();

        chat.greetingOnly = false;
        hold.chatChanged('chat B');
        hold.offer();

        expect(hold.shouldHold()).toBe(false);
    });

    test('holds the new chat for as long as a new opening does when it is a greeting with a picture too', () => {
        const { open, hold, passTime } = setup();
        open();
        passTime(OPENING_HOLD_MS - 1000);

        hold.chatChanged('chat B');
        hold.offer();
        passTime(OPENING_HOLD_MS - 1);

        expect(hold.shouldHold()).toBe(true);
        passTime(1);
        expect(hold.shouldHold()).toBe(false);
    });
});

describe('the scroll sink of the app', () => {
    test('is not asked to leave the chat alone after the hold is released', () => {
        const { open, hold } = setup();
        open();

        hold.release();

        expect(shouldHoldChatAtTop()).toBe(false);
    });

    test('asks before the bottom pin, and does not skip the question for a forced pin', () => {
        const sink = readSource('script.js').match(/function scrollChatElementToBottom\([\s\S]*?\n}\n/)?.[0] ?? '';

        expect(sink).toMatch(/shouldHoldChatAtTop\(\)/);
        expect(sink).not.toMatch(/force\s*&&|!force/);
        expect(sink.indexOf('shouldHoldChatAtTop()')).toBeLessThan(sink.indexOf('chatElement[0].scrollHeight'));
    });

    test('is reached by every pin of a chat load', () => {
        const source = readSource('script.js');
        const pin = source.match(/function pinChatLoadToBottom\([\s\S]*?\n}\n/)?.[0] ?? '';
        const scrollChatToBottom = source.match(/export function scrollChatToBottom\([\s\S]*?\n}\n/)?.[0] ?? '';

        expect(pin).toContain('scrollChatElementToBottom(');
        expect(scrollChatToBottom.match(/scrollChatElementToBottom\(\)/g)).toHaveLength(2);
    });

    test('is asked by the resize compensation of the chat, which would otherwise push a held chat off the top', () => {
        expect(readSource('scripts/RossAscends-mods.js')).toMatch(/!shouldHoldChatAtTop\(\) && Math\.abs\(deltaHeight\)/);
    });
});

describe('the time of the hold', () => {
    test('is longer than the load lock of the app, which scrolls a loaded chat to the bottom until its latest settle delay and margin have passed', () => {
        const source = readSource('script.js');
        const constant = name => Number(source.match(new RegExp(`const ${name} = (\\d+);`))?.[1]);
        const mobileSettle = constant('MOBILE_CHAT_LOAD_SCROLL_SETTLE_MS');
        const delays = source.match(/const CHAT_LOAD_SCROLL_SETTLE_DELAYS_MS = Object\.freeze\(\[([^\]]+)\]\);/)?.[1]
            .split(',').map(item => (item.trim() === 'MOBILE_CHAT_LOAD_SCROLL_SETTLE_MS' ? mobileSettle : Number(item)));

        expect(Number.isFinite(mobileSettle) && delays?.length).toBeGreaterThan(0);
        expect(delays.every(Number.isFinite)).toBe(true);
        expect(OPENING_HOLD_MS).toBeGreaterThan(Math.max(...delays) + constant('CHAT_LOAD_BOTTOM_LOCK_EXTRA_MS'));
    });
});
