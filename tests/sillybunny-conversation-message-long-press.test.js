/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const { bindMessageLongPress, CLICK_SWALLOW_MS, LONG_PRESS_MS, LONG_PRESS_SLOP_PX } = await import('../public/scripts/sillybunny-conversation/message-long-press.js');

let unbind;
let onLongPress;

function build() {
    document.body.innerHTML = `
        <div id="sheld" data-selection-mode="false">
            <div id="sb_conversation_timeline">
                <div class="sb-conversation-message" data-message-id="m1">
                    <div class="sb-conversation-message-body">
                        <div class="sb-conversation-message-bubble">
                            <div class="sb-conversation-message-reply-preview"><span class="quote">quoted</span></div>
                            <div class="sb-conversation-message-text">Hello <a href="https://example.test/" class="link">a link</a>
                                <figure class="sb-conversation-image-preview"><img alt="" src="data:,"></figure>
                                <button type="button" class="selfie-action">Another</button>
                            </div>
                        </div>
                        <div class="sb-conversation-message-reactions">
                            <button type="button" class="sb-conversation-message-reaction-chip" data-sb-own-long-press>👍</button>
                        </div>
                    </div>
                    <button type="button" class="sb-conversation-mobile-menu-trigger" data-sb-conversation-menu></button>
                </div>
                <div class="sb-conversation-message is-editing" data-message-id="m2">
                    <div class="sb-conversation-message-bubble"><textarea class="edit"></textarea><span class="label">editing</span></div>
                </div>
                <div class="sb-conversation-message sb-conversation-typing-indicator"><div class="typing">typing</div></div>
            </div>
            <textarea id="sb_conversation_input"></textarea>
        </div>`;
}

const $ = selector => document.querySelector(selector);

/** jsdom has no PointerEvent, so the events carry the fields that the module reads. */
function pointer(target, type, options = {}) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY: 60, ...options });
    for (const [property, value] of Object.entries({ pointerType: 'touch', pointerId: 1, ...options })) {
        Object.defineProperty(event, property, { value, configurable: true });
    }
    target.dispatchEvent(event);
    return event;
}

function press(target, options) {
    pointer(target, 'pointerdown', options);
}

function release(target, options) {
    pointer(target, 'pointerup', options);
}

beforeEach(() => {
    jest.useFakeTimers();
    build();
    onLongPress = jest.fn();
    unbind = bindMessageLongPress({ onLongPress });
});

afterEach(() => {
    unbind();
    jest.useRealTimers();
    document.body.innerHTML = '';
    getSelection().removeAllRanges();
});

describe('a long press on a message, by touch', () => {
    test('opens its menu once the finger has stayed for the long-press time, with the message and the point of the finger', () => {
        press($('.sb-conversation-message-text'));
        jest.advanceTimersByTime(LONG_PRESS_MS - 1);
        expect(onLongPress).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);

        expect(onLongPress).toHaveBeenCalledTimes(1);
        expect(onLongPress).toHaveBeenCalledWith($('[data-message-id="m1"]'), { x: 50, y: 60 });
    });

    test('is not started by a mouse or a pen, which have the toolbar and the secondary click', () => {
        press($('.sb-conversation-message-text'), { pointerType: 'mouse' });
        press($('.sb-conversation-message-text'), { pointerType: 'pen' });
        jest.advanceTimersByTime(LONG_PRESS_MS * 2);

        expect(onLongPress).not.toHaveBeenCalled();
    });

    test('is given up by a release before the time and by a move that is more than the slop, which is a scroll', () => {
        press($('.sb-conversation-message-text'));
        jest.advanceTimersByTime(LONG_PRESS_MS - 100);
        release($('.sb-conversation-message-text'));
        jest.advanceTimersByTime(1000);
        expect(onLongPress).not.toHaveBeenCalled();

        press($('.sb-conversation-message-text'));
        pointer($('.sb-conversation-message-text'), 'pointermove', { clientX: 50, clientY: 60 + LONG_PRESS_SLOP_PX + 1 });
        jest.advanceTimersByTime(1000);
        expect(onLongPress).not.toHaveBeenCalled();

        press($('.sb-conversation-message-text'));
        pointer($('.sb-conversation-message-text'), 'pointermove', { clientX: 50 + LONG_PRESS_SLOP_PX, clientY: 60 });
        jest.advanceTimersByTime(LONG_PRESS_MS);
        expect(onLongPress).toHaveBeenCalledTimes(1);
    });

    test('is given up when the browser takes the touch back', () => {
        press($('.sb-conversation-message-text'));
        pointer($('.sb-conversation-message-text'), 'pointercancel');
        jest.advanceTimersByTime(1000);

        expect(onLongPress).not.toHaveBeenCalled();
    });

    test('belongs to the bubble, the image and the empty parts of the row, and not to a control, a link or a field', () => {
        const opens = target => {
            onLongPress.mockClear();
            press(target);
            jest.advanceTimersByTime(LONG_PRESS_MS);
            release(target);
            jest.advanceTimersByTime(CLICK_SWALLOW_MS);
            return onLongPress.mock.calls.length === 1;
        };

        expect(opens($('.sb-conversation-message-bubble'))).toBe(true);
        expect(opens($('.sb-conversation-message-text'))).toBe(true);
        expect(opens($('.sb-conversation-image-preview img'))).toBe(true);
        expect(opens($('[data-message-id="m1"]'))).toBe(true);
        // A control keeps its own press: a reaction chip lists who reacted, a button acts, a link has the platform's menu.
        expect(opens($('.sb-conversation-message-reaction-chip'))).toBe(false);
        expect(opens($('.selfie-action'))).toBe(false);
        expect(opens($('.link'))).toBe(false);
        expect(opens($('.sb-conversation-mobile-menu-trigger'))).toBe(false);
        // A message being edited, a transient row and the composer have no menu to open.
        expect(opens($('.edit'))).toBe(false);
        expect(opens($('[data-message-id="m2"] .label'))).toBe(false);
        expect(opens($('.typing'))).toBe(false);
        expect(opens($('#sb_conversation_input'))).toBe(false);
    });

    test('leaves a text selection to the platform: a press while the message holds one opens nothing', () => {
        const text = $('.sb-conversation-message-text');
        const range = document.createRange();
        range.selectNodeContents(text.firstChild);
        getSelection().removeAllRanges();
        getSelection().addRange(range);

        press(text);
        jest.advanceTimersByTime(LONG_PRESS_MS);

        expect(onLongPress).not.toHaveBeenCalled();
    });

    test('does nothing while messages are being selected, where a tap toggles a row', () => {
        $('#sheld').dataset.selectionMode = 'true';

        press($('.sb-conversation-message-text'));
        jest.advanceTimersByTime(LONG_PRESS_MS);

        expect(onLongPress).not.toHaveBeenCalled();
    });
});

describe('the end of a long press', () => {
    function longPress(target = $('.sb-conversation-message-text')) {
        press(target);
        jest.advanceTimersByTime(LONG_PRESS_MS);
    }

    test('swallows the click that comes after the release, for a short time, wherever it lands', () => {
        longPress();
        release($('.sb-conversation-message-text'));

        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        const reached = jest.fn();
        document.body.addEventListener('click', reached);
        $('.sb-conversation-message-text').dispatchEvent(click);

        expect(click.defaultPrevented).toBe(true);
        expect(reached).not.toHaveBeenCalled();

        jest.advanceTimersByTime(CLICK_SWALLOW_MS + 1);
        $('.sb-conversation-message-text').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(reached).toHaveBeenCalledTimes(1);
    });

    test('does not swallow a click of an ordinary tap', () => {
        const reached = jest.fn();
        document.body.addEventListener('click', reached);
        press($('.sb-conversation-message-text'));
        jest.advanceTimersByTime(100);
        release($('.sb-conversation-message-text'));
        $('.sb-conversation-message-text').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(reached).toHaveBeenCalledTimes(1);
    });

    test('keeps the browser from showing its own menu for the same press, and leaves a link its menu', () => {
        longPress();
        const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        $('.sb-conversation-message-text').dispatchEvent(menu);
        expect(menu.defaultPrevented).toBe(true);
        release($('.sb-conversation-message-text'));
        jest.advanceTimersByTime(CLICK_SWALLOW_MS + 1);

        press($('.link'));
        jest.advanceTimersByTime(LONG_PRESS_MS);
        const linkMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        $('.link').dispatchEvent(linkMenu);
        expect(linkMenu.defaultPrevented).toBe(false);
    });

    test('does not touch a secondary click of a mouse', () => {
        const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        $('.sb-conversation-message-text').dispatchEvent(menu);

        expect(menu.defaultPrevented).toBe(false);
    });

    test('stops listening when it is unbound', () => {
        unbind();
        longPress();

        expect(onLongPress).not.toHaveBeenCalled();
    });
});
