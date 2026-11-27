/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
// The keyboard observer rescans a subtree after a class change only when the class can change which descendants
// match an interactable selector. A wrong "no" leaves a control without a tab stop.
import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

globalThis.CSS = { supports: () => true };
const { initKeyboard, registerInteractableType } = await import('../../public/scripts/keyboard.js');

const flushMicrotasks = async () => {
    for (let index = 0; index < 4; index++) {
        await Promise.resolve();
    }
};

beforeAll(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    initKeyboard();
});

afterAll(() => {
    jest.restoreAllMocks();
});

afterEach(() => {
    document.body.replaceChildren();
});

/**
 * Builds `<div id="wrap" class="start"><span id="target" class="targetClass"></span></div>`, registers the selector,
 * changes the class of the wrapper and returns the target after the observer ran.
 */
async function toggleAncestorClass({ selector, targetClass, wrapperClass, change }) {
    registerInteractableType(selector);
    document.body.innerHTML = `<div id="wrap" class="${wrapperClass}"><span id="target" class="${targetClass}"></span></div>`;
    await flushMicrotasks();
    const wrap = document.getElementById('wrap');
    const target = document.getElementById('target');
    change(wrap);
    await flushMicrotasks();
    return target;
}

describe('a class change on an ancestor of an interactable', () => {
    test('rescans for a class that the real selector list names inside :not(:is(...) *)', async () => {
        document.body.innerHTML = '<div id="wrap" class="inline-drawer-toggle"><span id="icon" class="inline-drawer-icon"></span></div>';
        await flushMicrotasks();
        const icon = document.getElementById('icon');
        expect(icon.hasAttribute('tabindex')).toBe(false);

        document.getElementById('wrap').classList.remove('inline-drawer-toggle');
        await flushMicrotasks();

        expect(icon.getAttribute('tabindex')).toBe('0');
    });

    test.each([
        ['the first compound of a selector with a :not() list', '.zz-multi:not(.zz-a1, .zz-a2) .zz-btn1', 'zz-btn1', 'zz-off', el => el.classList.add('zz-multi')],
        ['a class in the second item of a :not() list', '.zz-btn2:not(.zz-b1, .zz-b2 *)', 'zz-btn2', 'zz-b2', el => el.classList.remove('zz-b2')],
        ['the first class of an :is() list', '.zz-wrap3:is(.zz-c1, .zz-c2) .zz-btn3', 'zz-btn3', 'zz-wrap3 zz-off', el => el.classList.add('zz-c1')],
        ['the first class of a :where() list', ':where(.zz-d1, .zz-d2) .zz-btn4', 'zz-btn4', 'zz-off', el => el.classList.add('zz-d1')],
        ['a class with a CSS escape', '.zz\\:flex .zz-btn5', 'zz-btn5', 'zz-off', el => el.classList.add('zz:flex')],
        ['a class with a non-ASCII name', '.zz-日本 .zz-btn6', 'zz-btn6', 'zz-off', el => el.classList.add('zz-日本')],
        ['a class after a comma inside an attribute value', '.zz-e1:not([title="a, b.c"]) .zz-btn7', 'zz-btn7', 'zz-off', el => el.classList.add('zz-e1')],
    ])('gives the control a tab stop after %s', async (_name, selector, targetClass, wrapperClass, change) => {
        const target = await toggleAncestorClass({ selector, targetClass, wrapperClass, change });

        expect(target.getAttribute('tabindex')).toBe('0');
    });

    test('skips the subtree when the class cannot matter to any selector', async () => {
        registerInteractableType('.zz-known .zz-btn8');
        document.body.innerHTML = '<div id="wrap" class="zz-known"><span class="zz-btn8"></span></div>';
        await flushMicrotasks();
        const wrap = document.getElementById('wrap');
        const querySpy = jest.spyOn(wrap, 'querySelectorAll');

        wrap.classList.add('zz-visual-only');
        await flushMicrotasks();

        expect(querySpy).not.toHaveBeenCalled();
    });

    test('skips the subtree when the changed class is the last compound of every selector that names it', async () => {
        registerInteractableType('.zz-subject-only');
        document.body.innerHTML = '<div id="wrap"><span class="zz-subject-only"></span></div>';
        await flushMicrotasks();
        const wrap = document.getElementById('wrap');
        const querySpy = jest.spyOn(wrap, 'querySelectorAll');

        wrap.classList.add('zz-subject-only');
        await flushMicrotasks();

        expect(querySpy).not.toHaveBeenCalled();
        expect(wrap.getAttribute('tabindex')).toBe('0');
    });
});
