/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fitHomeHeader, updateVersionPlacement, versionTouchesButton } from '../../public/scripts/sillybunny-home/header-fit.js';

const BELOW = 'data-sb-version-below';

const box = (left, right, top = 0, bottom = 40) => ({ left, right, top, bottom });

function renderHeader({ version, button, hasBox = true }) {
    const panel = document.createElement('div');
    panel.innerHTML = `
        <header class="sbHomeHeader">
            <h1 class="sbHomeTitle">SillyBunny</h1>
            <span class="sbHomeVersion">v2</span>
            <button class="sbHomeMenuButton"></button>
        </header>`;
    document.body.append(panel);
    const header = panel.querySelector('.sbHomeHeader');
    const versionNode = header.querySelector('.sbHomeVersion');
    versionNode.getBoundingClientRect = jest.fn(() => version);
    versionNode.getClientRects = () => (hasBox ? [version] : []);
    header.querySelector('.sbHomeMenuButton').getBoundingClientRect = () => button;
    return header;
}

let observers;
let frames;
let fontListeners;
let fontsReady;

class FakeResizeObserver {
    constructor(callback) {
        this.callback = callback;
        this.observed = [];
        this.disconnected = false;
        observers.push(this);
    }

    observe(element) {
        this.observed.push(element);
    }

    disconnect() {
        this.disconnected = true;
    }
}

function runFrames() {
    frames.splice(0).forEach(callback => callback());
}

/** Waits for the callbacks of a MutationObserver and of a promise that is already settled. */
const settleMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    observers = [];
    frames = [];
    fontListeners = new Map();
    window.ResizeObserver = FakeResizeObserver;
    window.requestAnimationFrame = (callback) => {
        frames.push(callback);
        return frames.length;
    };
    fontsReady = Promise.withResolvers();
    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: {
            ready: fontsReady.promise,
            addEventListener: (type, listener) => fontListeners.set(listener, type),
            removeEventListener: (_type, listener) => fontListeners.delete(listener),
        },
    });
});

afterEach(() => {
    document.body.replaceChildren();
    delete document.fonts;
});

describe('the version beside the menu button', () => {
    test('keeps its gap from the button, so a version that ends 8px short is clear and 7px short is not', () => {
        expect(versionTouchesButton(box(100, 192), box(200, 240))).toBe(false);
        expect(versionTouchesButton(box(100, 193), box(200, 240))).toBe(true);
    });

    test('is clear of a button that mirrors to the other side', () => {
        expect(versionTouchesButton(box(48, 90), box(0, 40))).toBe(false);
        expect(versionTouchesButton(box(47, 90), box(0, 40))).toBe(true);
    });

    test('is clear of a button on another line', () => {
        expect(versionTouchesButton(box(190, 230, 0, 16), box(200, 240, 40, 84))).toBe(false);
    });
});

describe('the placement of the version', () => {
    test('moves below the title when it touches the button', () => {
        const header = renderHeader({ version: box(180, 260), button: box(250, 290) });

        updateVersionPlacement(header);

        expect(header.hasAttribute(BELOW)).toBe(true);
    });

    test('comes back beside the title when the room returns', () => {
        const header = renderHeader({ version: box(180, 220), button: box(250, 290) });
        header.setAttribute(BELOW, '');

        updateVersionPlacement(header);

        expect(header.hasAttribute(BELOW)).toBe(false);
    });

    test('keeps its last placement while the header has no box', () => {
        const header = renderHeader({ version: box(180, 260), button: box(250, 290), hasBox: false });
        header.setAttribute(BELOW, '');

        updateVersionPlacement(header);

        expect(header.hasAttribute(BELOW)).toBe(true);
    });
});

describe('header fit observer', () => {
    const tight = () => renderHeader({ version: box(180, 260), button: box(250, 290) });

    test('watches the header, the title and the version, and measures once per frame however many sizes change', () => {
        const header = tight();

        fitHomeHeader(header.parentElement);
        observers[0].callback();
        observers[0].callback();

        expect(observers[0].observed).toEqual([header, header.querySelector('.sbHomeTitle'), header.querySelector('.sbHomeVersion')]);
        expect(frames).toHaveLength(1);
        runFrames();
        expect(header.hasAttribute(BELOW)).toBe(true);
    });

    test('measures after the fonts are ready and again when a font finishes loading', async () => {
        const header = tight();
        fitHomeHeader(header.parentElement);
        runFrames();
        header.removeAttribute(BELOW);

        fontsReady.resolve();
        await settleMicrotasks();
        expect(frames).toHaveLength(1);
        runFrames();
        expect(header.hasAttribute(BELOW)).toBe(true);

        header.removeAttribute(BELOW);
        [...fontListeners.keys()][0]();
        expect(frames).toHaveLength(1);
        runFrames();
        expect(header.hasAttribute(BELOW)).toBe(true);
    });

    test('measures when the text of the version changes, because below the title it has no width to resize', async () => {
        const header = tight();
        fitHomeHeader(header.parentElement);
        runFrames();
        header.removeAttribute(BELOW);

        header.querySelector('.sbHomeVersion').textContent = 'v2.0.0-dev';
        await settleMicrotasks();

        expect(frames).toHaveLength(1);
        runFrames();
        expect(header.hasAttribute(BELOW)).toBe(true);
    });

    test('a mount does not stop the observer of another panel, because the caller owns each stop', () => {
        fitHomeHeader(tight().parentElement);
        fitHomeHeader(tight().parentElement);

        expect(observers.map(observer => observer.disconnected)).toEqual([false, false]);
    });

    test('a panel without a header starts nothing and returns a stop that does nothing', () => {
        const stop = fitHomeHeader(document.createElement('div'));

        expect(observers).toHaveLength(0);
        expect(fontListeners.size).toBe(0);
        expect(() => stop()).not.toThrow();
    });
});

describe('stopping the header fit', () => {
    const tight = () => renderHeader({ version: box(180, 260), button: box(250, 290) });

    test('disconnects both observers and removes the font listener', () => {
        const RealMutationObserver = window.MutationObserver;
        const textObservers = [];
        window.MutationObserver = class extends RealMutationObserver {
            disconnected = false;

            constructor(callback) {
                super(callback);
                textObservers.push(this);
            }

            disconnect() {
                this.disconnected = true;
                super.disconnect();
            }
        };
        try {
            const stop = fitHomeHeader(tight().parentElement);
            expect(observers).toHaveLength(1);
            expect(textObservers).toHaveLength(1);
            expect(fontListeners.size).toBe(1);

            stop();

            expect(observers[0].disconnected).toBe(true);
            expect(textObservers[0].disconnected).toBe(true);
            expect(fontListeners.size).toBe(0);
        } finally {
            window.MutationObserver = RealMutationObserver;
        }
    });

    test('nothing runs after it is stopped: not a queued frame, a font event, a text change or a late fonts promise', async () => {
        const old = tight();
        const stop = fitHomeHeader(old.parentElement);
        const measured = old.querySelector('.sbHomeVersion').getBoundingClientRect;
        observers[0].callback();
        const listener = [...fontListeners.keys()][0];
        stop();
        measured.mockClear();

        runFrames();
        listener();
        old.querySelector('.sbHomeVersion').textContent = 'v3';
        fontsReady.resolve();
        await settleMicrotasks();
        runFrames();

        expect(fontListeners.size).toBe(0);
        expect(measured).not.toHaveBeenCalled();
    });

    test('stops only its own panel, and stopping twice does no harm', () => {
        const stopFirst = fitHomeHeader(tight().parentElement);
        fitHomeHeader(tight().parentElement);

        stopFirst();
        stopFirst();

        expect(observers.map(observer => observer.disconnected)).toEqual([true, false]);
        expect(fontListeners.size).toBe(1);
    });
});
