/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { bindRovingFocus } from '../../public/scripts/sillybunny-roving-focus.js';

const press = (target, key, init = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
};
const stops = group => [...group.querySelectorAll('button')].filter(button => button.tabIndex === 0);

describe('bindRovingFocus', () => {
    let group;
    let binding;

    beforeEach(() => {
        document.body.innerHTML = '<div id="group"><button data-id="a" aria-selected="false">A</button><button data-id="b" aria-selected="true">B</button><button data-id="c" aria-selected="false">C</button><button data-id="d" class="gone">D</button></div>';
        group = document.getElementById('group');
        group.querySelector('.gone').style.display = 'none';
    });

    afterEach(() => binding?.destroy());

    test('gives the selected item the one Tab stop', () => {
        binding = bindRovingFocus(group, { itemSelector: 'button', orientation: 'vertical', isSelected: button => button.getAttribute('aria-selected') === 'true' });
        expect(stops(group).map(button => button.dataset.id)).toEqual(['b']);
    });

    test('falls back to the first available item when none is selected', () => {
        binding = bindRovingFocus(group, { itemSelector: 'button', orientation: 'vertical' });
        expect(stops(group).map(button => button.dataset.id)).toEqual(['a']);
    });

    test('vertical groups move with ArrowDown and ArrowUp, wrap, skip a hidden item, and ignore Left and Right', () => {
        binding = bindRovingFocus(group, { itemSelector: 'button', orientation: 'vertical' });
        const [a, b, c] = group.querySelectorAll('button');
        a.focus();
        expect(press(a, 'ArrowDown').defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(b);
        press(b, 'ArrowDown');
        expect(document.activeElement).toBe(c);
        press(c, 'ArrowDown');
        expect(document.activeElement).toBe(a);
        press(a, 'ArrowUp');
        expect(document.activeElement).toBe(c);
        expect(press(c, 'ArrowRight').defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(c);
        expect(stops(group)).toEqual([c]);
    });

    test('horizontal groups use Left and Right, and Home and End go to the ends', () => {
        binding = bindRovingFocus(group, { itemSelector: 'button', orientation: 'horizontal' });
        const [a, b, c] = group.querySelectorAll('button');
        b.focus();
        press(b, 'ArrowRight');
        expect(document.activeElement).toBe(c);
        press(c, 'ArrowLeft');
        expect(document.activeElement).toBe(b);
        press(b, 'End');
        expect(document.activeElement).toBe(c);
        press(c, 'Home');
        expect(document.activeElement).toBe(a);
        expect(press(a, 'ArrowDown').defaultPrevented).toBe(false);
    });

    test('moving only focuses unless onMove selects', () => {
        const moved = [];
        binding = bindRovingFocus(group, { itemSelector: 'button', orientation: 'vertical', isSelected: button => button.getAttribute('aria-selected') === 'true', onMove: button => moved.push(button.dataset.id) });
        const [a, b] = group.querySelectorAll('button');
        b.focus();
        press(b, 'ArrowUp');
        expect(document.activeElement).toBe(a);
        expect(moved).toEqual(['a']);
        expect(b.getAttribute('aria-selected')).toBe('true');
    });

    test('keys with a modifier pass through', () => {
        binding = bindRovingFocus(group, { itemSelector: 'button', orientation: 'vertical' });
        const [a] = group.querySelectorAll('button');
        a.focus();
        expect(press(a, 'ArrowDown', { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(a);
    });

    test('the Tab stop follows focus and a change of selection', async () => {
        binding = bindRovingFocus(group, { itemSelector: 'button', orientation: 'vertical', isSelected: button => button.getAttribute('aria-selected') === 'true' });
        const [a, b, c] = group.querySelectorAll('button');
        a.focus();
        expect(stops(group)).toEqual([a]);
        a.blur();
        b.setAttribute('aria-selected', 'false');
        c.setAttribute('aria-selected', 'true');
        await Promise.resolve();
        expect(stops(group)).toEqual([c]);
    });
});
