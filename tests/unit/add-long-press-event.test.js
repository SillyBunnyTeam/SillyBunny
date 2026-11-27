import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const utilsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'scripts', 'utils.js');

/** A matching element, as the delegated listener asks it: `closest(selector)` answers itself for its own selector. */
function element(selector) {
    const el = {
        selector,
        closest: candidate => (candidate === selector ? el : null),
        contains: node => node === el,
    };
    return el;
}

function loadAddLongPressEvent() {
    const source = readFileSync(utilsPath, 'utf8');
    const marker = 'const longPressRegistrations = [];';
    const snippet = source.slice(source.indexOf(marker)).replace('export function addLongPressEvent', 'function addLongPressEvent');
    const listeners = {};
    const document = {
        addEventListener(type, handler, options) {
            listeners[type] = { handler, options };
        },
    };
    const context = vm.createContext({ document, setTimeout, clearTimeout });
    const addLongPressEvent = vm.runInContext(`${snippet}\naddLongPressEvent;`, context);
    return { addLongPressEvent, listeners };
}

/** A touch event the way a browser builds it: the fingers that are down, and the ones that this event changed. */
function touchEvent({ down, changed, target }) {
    const toTouch = ({ id, target: touchTarget }) => ({ identifier: id, target: touchTarget });
    return { target: target ?? changed[0].target, touches: down.map(toTouch), changedTouches: changed.map(toTouch), preventDefault: jest.fn() };
}

describe('addLongPressEvent with more than one finger', () => {
    let addLongPressEvent;
    let listeners;
    let button;
    let otherButton;
    let outside;

    beforeEach(() => {
        jest.useFakeTimers();
        ({ addLongPressEvent, listeners } = loadAddLongPressEvent());
        button = element('#press-me');
        otherButton = element('#press-me-too');
        outside = { closest: () => null, contains: () => false };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    const start = (...fingers) => listeners.touchstart.handler(touchEvent({ down: fingers, changed: [fingers.at(-1)] }));

    test('a finger that lands somewhere else does not cancel the press that is running', () => {
        const callback = jest.fn();
        addLongPressEvent('#press-me', callback, 500);

        start({ id: 1, target: button });
        jest.advanceTimersByTime(200);
        start({ id: 1, target: button }, { id: 2, target: outside });
        jest.advanceTimersByTime(300);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.instances[0]).toBe(button);
    });

    test('a finger that lands on the same target does not restart or cancel the first press', () => {
        const callback = jest.fn();
        addLongPressEvent('#press-me', callback, 500);

        start({ id: 1, target: button });
        jest.advanceTimersByTime(200);
        start({ id: 1, target: button }, { id: 2, target: button });

        jest.advanceTimersByTime(300);
        expect(callback).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(200);
        expect(callback).toHaveBeenCalledTimes(2);
    });

    test('a touch that moves cancels its own press and no other', () => {
        const first = jest.fn();
        const second = jest.fn();
        addLongPressEvent('#press-me', first, 500);
        addLongPressEvent('#press-me-too', second, 500);

        start({ id: 1, target: button });
        start({ id: 1, target: button }, { id: 2, target: otherButton });
        listeners.touchmove.handler(touchEvent({ down: [{ id: 1, target: button }, { id: 2, target: otherButton }], changed: [{ id: 2, target: otherButton }] }));
        jest.advanceTimersByTime(500);

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
    });

    test('a touch that ends or is cancelled cancels its own press and no other', () => {
        const first = jest.fn();
        const second = jest.fn();
        addLongPressEvent('#press-me', first, 500);
        addLongPressEvent('#press-me-too', second, 500);

        start({ id: 1, target: button });
        start({ id: 1, target: button }, { id: 2, target: otherButton });
        listeners.touchend.handler(touchEvent({ down: [{ id: 1, target: button }], changed: [{ id: 2, target: otherButton }] }));
        jest.advanceTimersByTime(500);

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();

        start({ id: 3, target: otherButton });
        listeners.touchcancel.handler(touchEvent({ down: [], changed: [{ id: 3, target: otherButton }] }));
        jest.advanceTimersByTime(500);
        expect(second).not.toHaveBeenCalled();
    });

    test('the press of the finger that lifts is cancelled', () => {
        const callback = jest.fn();
        addLongPressEvent('#press-me', callback, 500);

        start({ id: 1, target: button });
        jest.advanceTimersByTime(200);
        listeners.touchend.handler(touchEvent({ down: [], changed: [{ id: 1, target: button }] }));
        jest.advanceTimersByTime(500);

        expect(callback).not.toHaveBeenCalled();
    });

    test('the click that follows a fired press is suppressed while a second finger is down, and a new gesture drops what is left', () => {
        addLongPressEvent('#press-me', jest.fn(), 500);
        const click = () => ({ target: button, preventDefault: jest.fn(), stopImmediatePropagation: jest.fn() });

        start({ id: 1, target: button });
        jest.advanceTimersByTime(500);
        start({ id: 1, target: button }, { id: 2, target: outside });
        const suppressed = click();
        listeners.click.handler(suppressed);
        expect(suppressed.preventDefault).toHaveBeenCalledTimes(1);
        expect(suppressed.stopImmediatePropagation).toHaveBeenCalledTimes(1);

        start({ id: 1, target: button });
        jest.advanceTimersByTime(500);
        listeners.touchend.handler(touchEvent({ down: [], changed: [{ id: 1, target: button }] }));
        start({ id: 4, target: outside });
        const later = click();
        listeners.click.handler(later);
        expect(later.preventDefault).not.toHaveBeenCalled();
    });

    test('keeps the passive listeners and the single press of one finger', () => {
        const callback = jest.fn();
        addLongPressEvent('#press-me', callback, 500);

        for (const type of ['touchstart', 'touchend', 'touchmove', 'touchcancel']) {
            expect(listeners[type].options).toEqual({ passive: true });
        }
        start({ id: 1, target: button });
        jest.advanceTimersByTime(500);
        expect(callback).toHaveBeenCalledTimes(1);
    });
});
