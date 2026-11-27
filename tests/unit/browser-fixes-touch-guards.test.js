/** @jest-environment jsdom */
import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
    getParsedUA: () => ({ os: { name: 'Android' } }),
    isMobile: () => true,
}));
await jest.unstable_mockModule('../../public/scripts/mobile-send-button.js', () => ({
    isIOSWebKitPlatform: () => false,
    isLegacyIOSWebKitPlatform: () => false,
}));

const registrations = [];
const documentAddEventListener = document.addEventListener.bind(document);

beforeAll(async () => {
    document.body.innerHTML = `
        <div id="bg1"></div>
        <div id="top-bar"><button id="topbar-button" type="button">Menu</button></div>
        <div id="sheld"><div id="chat"></div></div>
        <div class="sb-shell-root"><div id="shell-body"></div></div>
        <dialog class="sb-dialog-host" open><div class="sb-dialog"><div id="dialog-body"></div></div></dialog>
        <div id="outside"></div>
    `;
    document.addEventListener = (type, handler, options) => {
        registrations.push({ type, handler, options });
        return documentAddEventListener(type, handler, options);
    };
    const { applyBrowserFixes } = await import('../../public/scripts/browser-fixes.js');
    applyBrowserFixes();
});

afterAll(() => {
    document.addEventListener = documentAddEventListener;
});

afterEach(() => {
    const chat = document.getElementById('chat');
    chat.style.overflowY = '';
    for (const property of ['scrollHeight', 'clientHeight', 'scrollTop']) delete chat[property];
});

function dispatchTouch(target, type, points) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', {
        value: points.map(({ id = 0, x, y }) => ({ identifier: id, clientX: x, clientY: y })),
    });
    target.dispatchEvent(event);
    return event;
}

/** A one-finger drag: the touchstart, then the touchmove events. Resolves to whether the first touchmove was prevented. */
function drag(target, { dy }) {
    dispatchTouch(target, 'touchstart', [{ x: 100, y: 300 }]);
    const moves = [1, 2, 3].map(step => dispatchTouch(target, 'touchmove', [{ x: 100, y: 300 + (dy * step) / 3 }]));
    dispatchTouch(target, 'touchend', []);
    return moves.every(event => event.defaultPrevented);
}

function makeScrollable(element, { scrollTop }) {
    element.style.overflowY = 'auto';
    Object.defineProperty(element, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(element, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(element, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
}

describe('multi-touch zoom guard on a mobile page that is not Firefox', () => {
    test.each([
        ['#chat', '#chat'],
        ['the top bar', '#top-bar'],
        ['the page background', '#bg1'],
        ['a Customize shell', '#shell-body'],
        ['a dialog', '#dialog-body'],
        ['an element that no pan guard names', '#outside'],
    ])('cancels a two-finger touchstart and touchmove on %s', (_label, selector) => {
        const target = document.querySelector(selector);

        const start = dispatchTouch(target, 'touchstart', [{ id: 0, x: 60, y: 300 }, { id: 1, x: 140, y: 300 }]);
        const move = dispatchTouch(target, 'touchmove', [{ id: 0, x: 40, y: 300 }, { id: 1, x: 160, y: 300 }]);

        expect(start.defaultPrevented).toBe(true);
        expect(move.defaultPrevented).toBe(true);
    });

    test('leaves a one-finger touchstart alone', () => {
        const start = dispatchTouch(document.getElementById('chat'), 'touchstart', [{ x: 100, y: 300 }]);

        expect(start.defaultPrevented).toBe(false);
    });
});

describe('document pan guard', () => {
    test.each([
        ['#chat', '#chat'],
        ['#sheld', '#sheld'],
        ['the top bar', '#top-bar'],
        ['a control in the top bar', '#topbar-button'],
        ['a Customize shell', '.sb-shell-root'],
        ['the body of a Customize shell', '#shell-body'],
        ['a dialog', '.sb-dialog'],
        ['the body of a dialog', '#dialog-body'],
        ['the page background', '#bg1'],
    ])('cancels a pull on %s that has nothing to scroll', (_label, selector) => {
        expect(drag(document.querySelector(selector), { dy: 90 })).toBe(true);
    });

    test('leaves a pull alone while the chat can scroll in that direction', () => {
        makeScrollable(document.getElementById('chat'), { scrollTop: 300 });

        expect(drag(document.getElementById('chat'), { dy: 90 })).toBe(false);
        expect(drag(document.getElementById('chat'), { dy: -90 })).toBe(false);
    });

    test('cancels a pull at the top of the chat but not the scroll back down', () => {
        makeScrollable(document.getElementById('chat'), { scrollTop: 0 });

        expect(drag(document.getElementById('chat'), { dy: 90 })).toBe(true);
        expect(drag(document.getElementById('chat'), { dy: -90 })).toBe(false);
    });

    test('leaves an element outside every guarded surface alone', () => {
        expect(drag(document.getElementById('outside'), { dy: 90 })).toBe(false);
    });
});

describe('touch listener registration', () => {
    const touchRegistrations = () => registrations.filter(({ type }) => type.startsWith('touch'));
    const isPassive = ({ options }) => Boolean(options && typeof options === 'object' && options.passive);

    test('keeps every listener that never cancels passive, and registers the cancelling ones on the document', () => {
        const blocking = touchRegistrations().filter(entry => !isPassive(entry));

        expect(blocking.map(({ type }) => type).sort()).toEqual(['touchmove', 'touchmove', 'touchstart']);
        expect(touchRegistrations().filter(isPassive).map(({ type }) => type).sort()).toEqual(['touchcancel', 'touchend', 'touchstart']);
    });
});
