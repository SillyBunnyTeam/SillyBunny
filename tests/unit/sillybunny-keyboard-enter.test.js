/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
// The global Enter handler clicks keyboard interactables. A control that the browser already clicks on
// Enter must not get a second synthetic click.
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

globalThis.CSS = { supports: () => false };
const { initKeyboard } = await import('../../public/scripts/keyboard.js');

beforeAll(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    initKeyboard();
});

afterAll(() => {
    jest.restoreAllMocks();
});

beforeEach(() => {
    document.body.innerHTML = '';
});

/** Presses Enter on `html` and returns how many synthetic clicks the handler made. */
function pressEnter(html, { selector = '#target', ...init } = {}) {
    document.body.innerHTML = html;
    const target = document.querySelector(selector);
    const click = jest.spyOn(target, 'click').mockImplementation(() => {});
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }));
    return click.mock.calls.length;
}

describe('Enter on a keyboard interactable', () => {
    test.each([
        ['a div', '<div id="target" class="interactable" tabindex="0">Run</div>'],
        ['a checkbox', '<input id="target" class="interactable" type="checkbox">'],
        ['a radio', '<input id="target" class="interactable" type="radio">'],
        ['an anchor without href', '<a id="target" class="interactable" tabindex="0">Run</a>'],
    ])('keeps the synthetic click on %s', (_name, html) => {
        expect(pressEnter(html)).toBe(1);
    });

    test.each([
        ['a button', '<button id="target" class="menu_button" type="button">Run</button>'],
        ['a summary', '<details><summary id="target" class="interactable">Run</summary></details>'],
        ['an anchor with href', '<a id="target" class="interactable" href="#next">Run</a>'],
        ['a button input', '<input id="target" class="interactable" type="button" value="Run">'],
        ['a submit input', '<input id="target" class="interactable" type="submit" value="Run">'],
    ])('leaves %s to the browser', (_name, html) => {
        expect(pressEnter(html)).toBe(0);
    });

    test('ignores Enter with a modifier key', () => {
        expect(pressEnter('<div id="target" class="interactable" tabindex="0">Run</div>', { shiftKey: true })).toBe(0);
    });

    test('does not click a disabled interactable', () => {
        expect(pressEnter('<div id="target" class="interactable disabled" tabindex="0">Run</div>')).toBe(0);
    });
});
