/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const play = jest.fn();
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    MOTION_FAST: 0,
    SPRING_SHEET: {},
    play,
    stopMotion: jest.fn(),
}));

const { bindSheetGestures, bindSheetSwipeClose, createSheetHandle } = await import('../../public/scripts/sillybunny-editor/sheet-gestures.js');

beforeEach(() => {
    jest.clearAllMocks();
    document.body.replaceChildren();
});

function makeSheet() {
    const sheet = document.createElement('div');
    sheet.getBoundingClientRect = () => ({ height: 400 });
    const handle = createSheetHandle();
    const header = document.createElement('div');
    header.className = 'qa-header';
    const title = document.createElement('h2');
    const closeButton = document.createElement('button');
    header.append(title, closeButton);
    const body = document.createElement('div');
    const backdrop = document.createElement('div');
    sheet.append(handle, header, body);
    document.body.append(backdrop, sheet);
    return { sheet, handle, header, title, closeButton, body, backdrop };
}

function pointer(target, type, clientY, timeStamp) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        pointerId: { value: 1 },
        clientY: { value: clientY },
        button: { value: 0 },
        timeStamp: { value: timeStamp },
    });
    target.dispatchEvent(event);
    return event;
}

describe('createSheetHandle', () => {
    test('is a decorative shared handle', () => {
        const handle = createSheetHandle();

        expect(handle.className).toBe('sb-dialog__handle');
        expect(handle.getAttribute('aria-hidden')).toBe('true');
    });
});

describe('bindSheetSwipeClose', () => {
    function bind(overrides = {}) {
        const parts = makeSheet();
        const close = jest.fn(() => true);
        const unbind = bindSheetSwipeClose({ sheet: parts.sheet, backdrop: parts.backdrop, headerSelector: '.qa-header', close, ...overrides });
        return { ...parts, close, unbind };
    }

    test('follows the finger from the handle and closes through the supplied close path on a long swipe', () => {
        const { sheet, backdrop, handle, close } = bind();

        pointer(handle, 'pointerdown', 100, 0);
        pointer(handle, 'pointermove', 220, 100);
        expect(sheet.style.transform).toBe('translateY(120px)');
        expect(backdrop.style.opacity).toBe('0.7');
        pointer(handle, 'pointerup', 220, 100);

        expect(close).toHaveBeenCalledTimes(1);
    });

    test('a swipe from the header title starts the drag, and a swipe from a header control does not', () => {
        const { sheet, title, closeButton, close } = bind();

        pointer(closeButton, 'pointerdown', 100, 0);
        pointer(closeButton, 'pointermove', 220, 100);
        expect(sheet.style.transform).toBe('');

        pointer(title, 'pointerdown', 100, 200);
        pointer(title, 'pointermove', 220, 300);
        expect(sheet.style.transform).toBe('translateY(120px)');
        pointer(title, 'pointerup', 220, 300);
        expect(close).toHaveBeenCalledTimes(1);
    });

    test('a swipe from the body does not drag the sheet', () => {
        const { sheet, body, close } = bind();

        pointer(body, 'pointerdown', 100, 0);
        pointer(body, 'pointermove', 300, 100);
        pointer(body, 'pointerup', 300, 100);

        expect(sheet.style.transform).toBe('');
        expect(close).not.toHaveBeenCalled();
    });

    test('a short, slow swipe springs back with the sheet spring and does not close', () => {
        const { sheet, handle, close } = bind();

        pointer(handle, 'pointerdown', 100, 0);
        pointer(handle, 'pointermove', 130, 600);
        pointer(handle, 'pointerup', 130, 1200);

        expect(close).not.toHaveBeenCalled();
        expect(sheet.style.transform).toBe('');
        expect(play).toHaveBeenCalledWith(sheet, [{ transform: 'translateY(30px)' }, { transform: 'none' }], {});
    });

    test('a hidden sheet ignores swipes', () => {
        const { sheet, handle, close } = bind();
        sheet.hidden = true;

        pointer(handle, 'pointerdown', 100, 0);
        pointer(handle, 'pointermove', 300, 100);
        pointer(handle, 'pointerup', 300, 100);

        expect(close).not.toHaveBeenCalled();
    });

    test('unbinding removes the listeners', () => {
        const { handle, close, unbind } = bind();
        unbind();

        pointer(handle, 'pointerdown', 100, 0);
        pointer(handle, 'pointerup', 300, 100);

        expect(close).not.toHaveBeenCalled();
    });
});

describe('bindSheetGestures drag lifetime', () => {
    function bind() {
        const parts = makeSheet();
        let active = true;
        const requestClose = jest.fn(() => true);
        bindSheetGestures({
            surface: parts.sheet,
            scrim: parts.backdrop,
            targets: [parts.sheet],
            isActive: () => active,
            requestClose,
        });
        return { ...parts, requestClose, setActive: value => { active = value; } };
    }

    test('a drag that was held while the sheet went inactive is dropped at the next event', () => {
        const { sheet, handle, backdrop, requestClose, setActive } = bind();

        pointer(handle, 'pointerdown', 100, 0);
        pointer(handle, 'pointermove', 220, 100);
        expect(sheet.style.transform).toBe('translateY(120px)');

        setActive(false);
        pointer(handle, 'pointermove', 260, 200);
        expect(sheet.style.transform).toBe('');
        expect(backdrop.style.opacity).toBe('');
        pointer(handle, 'pointerup', 260, 200);
        expect(requestClose).not.toHaveBeenCalled();
    });

    test('a stale drag does not block the next drag once the sheet is active again', () => {
        const { sheet, handle, setActive } = bind();

        pointer(handle, 'pointerdown', 100, 0);
        setActive(false);
        pointer(handle, 'pointermove', 110, 10);
        setActive(true);
        pointer(handle, 'pointerdown', 50, 300);
        pointer(handle, 'pointermove', 170, 400);

        expect(sheet.style.transform).toBe('translateY(120px)');
    });

    test('losing pointer capture mid-drag springs the sheet back without closing it', () => {
        const { sheet, handle, requestClose } = bind();

        pointer(handle, 'pointerdown', 100, 0);
        pointer(handle, 'pointermove', 160, 100);
        pointer(handle, 'lostpointercapture', 160, 110);

        expect(sheet.style.transform).toBe('');
        expect(play).toHaveBeenCalledWith(sheet, [{ transform: 'translateY(60px)' }, { transform: 'none' }], {});
        expect(requestClose).not.toHaveBeenCalled();
    });

    test('the capture release after a normal pointerup does nothing more', () => {
        const { handle, requestClose } = bind();

        pointer(handle, 'pointerdown', 100, 0);
        pointer(handle, 'pointermove', 300, 100);
        pointer(handle, 'pointerup', 300, 100);
        pointer(handle, 'lostpointercapture', 300, 110);

        expect(requestClose).toHaveBeenCalledTimes(1);
        expect(play).not.toHaveBeenCalled();
    });
});
