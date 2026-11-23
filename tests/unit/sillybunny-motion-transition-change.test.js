/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const { endTransitionMark, transitionChange } = await import('../../public/scripts/sillybunny-motion.js');

const ATTRIBUTE = 'data-qa-moving';
let element;
let style;

function endTransition(propertyName, target = element) {
    target.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName }));
}

beforeEach(() => {
    jest.useFakeTimers();
    document.body.className = '';
    document.body.innerHTML = '<div id="shell"></div>';
    element = document.getElementById('shell');
    style = { transitionDuration: '0.25s', transitionDelay: '0s' };
    jest.spyOn(window, 'getComputedStyle').mockImplementation(() => style);
});

afterEach(() => {
    endTransitionMark(element, ATTRIBUTE);
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('transitionChange', () => {
    test('has the attribute when the change is written, and ends with a transitionend of a listed property', () => {
        let seen = null;
        transitionChange(element, ATTRIBUTE, () => { seen = element.hasAttribute(ATTRIBUTE); }, { properties: ['width'] });

        expect(seen).toBe(true);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(true);

        endTransition('opacity');
        expect(element.hasAttribute(ATTRIBUTE)).toBe(true);

        endTransition('width', document.body);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(true);

        endTransition('width');
        expect(element.hasAttribute(ATTRIBUTE)).toBe(false);
    });

    test('ends after the duration of the style and a margin when no transition ends', () => {
        transitionChange(element, ATTRIBUTE, () => {});

        jest.advanceTimersByTime(300);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(true);

        jest.advanceTimersByTime(100);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(false);
    });

    test('takes the longest duration and the delay of a list of transitions, in seconds or milliseconds', () => {
        style = { transitionDuration: '0.1s, 400ms', transitionDelay: '0s, 50ms' };
        transitionChange(element, ATTRIBUTE, () => {});

        jest.advanceTimersByTime(549);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(true);

        jest.advanceTimersByTime(1);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(false);
    });

    test('is not set when the style has no transition', () => {
        style = { transitionDuration: '0s', transitionDelay: '0s' };
        const change = jest.fn();
        transitionChange(element, ATTRIBUTE, change);

        expect(change).toHaveBeenCalledTimes(1);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(false);
    });

    test('is never set when the setting reduces motion', () => {
        document.body.classList.add('reduced-motion');
        const change = jest.fn(() => { expect(element.hasAttribute(ATTRIBUTE)).toBe(false); });
        transitionChange(element, ATTRIBUTE, change);

        expect(change).toHaveBeenCalledTimes(1);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(false);
        expect(window.getComputedStyle).not.toHaveBeenCalled();
    });

    test('is never set when the system reduces motion', () => {
        window.matchMedia = jest.fn(() => ({ matches: true }));
        const change = jest.fn();
        try {
            transitionChange(element, ATTRIBUTE, change);
        } finally {
            delete window.matchMedia;
        }

        expect(change).toHaveBeenCalledTimes(1);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(false);
    });

    test('a second change restarts the mark, and endTransitionMark ends it at once', () => {
        transitionChange(element, ATTRIBUTE, () => {});
        jest.advanceTimersByTime(300);
        transitionChange(element, ATTRIBUTE, () => {});
        jest.advanceTimersByTime(300);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(true);

        endTransitionMark(element, ATTRIBUTE);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(false);

        jest.advanceTimersByTime(1000);
        expect(element.hasAttribute(ATTRIBUTE)).toBe(false);
    });
});
