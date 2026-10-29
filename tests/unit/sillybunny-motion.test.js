/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
// play() runs `onEnd` however the animation ends, so a caller that commits its end state there, such as
// hiding the page a pushed page covers, never keeps the state from before the motion.
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const { play, stopMotion } = await import('../../public/scripts/sillybunny-motion.js');

/** The part of the Web Animations API that play() uses, with the browser's cancel handler and finish promise. */
class FakeAnimation {
    constructor() {
        this.oncancel = null;
        this.finished = new Promise((resolve, reject) => {
            this.finish = () => resolve();
            this.reject = reject;
        });
        this.finished.catch(() => {});
    }

    /**
     * Cancelling rejects `finished` and fires `cancel`, as a browser does.
     * The fake fires `oncancel` synchronously while browsers fire it later. The tests still hold because the guard compares identity.
     */
    cancel() {
        this.reject(new DOMException('The animation was aborted', 'AbortError'));
        this.oncancel?.(new Event('cancel'));
    }
}

const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

let element;
let animation;

beforeAll(() => {
    // jsdom does not reflect `inert`.
    Object.defineProperty(HTMLElement.prototype, 'inert', {
        configurable: true,
        get() { return this.hasAttribute('inert'); },
        set(value) { this.toggleAttribute('inert', Boolean(value)); },
    });
});

beforeEach(() => {
    window.matchMedia = () => ({ matches: false });
    animation = new FakeAnimation();
    element = document.createElement('div');
    element.animate = jest.fn(() => animation);
    document.body.append(element);
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('play', () => {
    test('runs onFinish and then onEnd once when the animation finishes', async () => {
        const calls = [];
        play(element, [], { onFinish: () => calls.push('finish'), onEnd: () => calls.push('end') });

        animation.finish();
        await settle();

        expect(calls).toEqual(['finish', 'end']);
    });

    test('runs onEnd and not onFinish when the browser cancels the animation', async () => {
        const calls = [];
        play(element, [], { onFinish: () => calls.push('finish'), onEnd: () => calls.push('end') });

        animation.cancel();
        await settle();

        expect(calls).toEqual(['end']);
    });

    test('runs onEnd once when stopMotion cancels it', async () => {
        const onEnd = jest.fn();
        play(element, [], { onEnd });

        stopMotion(element);
        await settle();

        expect(onEnd).toHaveBeenCalledTimes(1);
    });

    test('runs onEnd once when a second animation on the element replaces it', async () => {
        const onEnd = jest.fn();
        play(element, [], { onEnd });
        element.animate = jest.fn(() => new FakeAnimation());

        play(element, []);
        await settle();

        expect(onEnd).toHaveBeenCalledTimes(1);
    });

    test('does not run onEnd a second time for a browser cancel after the animation finished', async () => {
        const onEnd = jest.fn();
        play(element, [], { onEnd });

        animation.finish();
        await settle();
        animation.cancel();
        await settle();

        expect(onEnd).toHaveBeenCalledTimes(1);
    });

    test('restores inline styles and inertness when the browser cancels it', async () => {
        play(element, [], { styles: { opacity: '0' }, inert: true });
        expect(element.style.opacity).toBe('0');
        expect(element.inert).toBe(true);

        animation.cancel();
        await settle();

        expect(element.style.opacity).toBe('');
        expect(element.inert).toBe(false);
    });
});
