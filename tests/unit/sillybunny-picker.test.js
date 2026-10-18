/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockAnimateIn = jest.fn();
const mockAnimateOut = jest.fn((_element, _frames, hide) => hide());
const mockPositionPopover = jest.fn(() => '0px 0');
const mockBlockUpstreamDrawerClose = jest.fn();
const mockCreateSheetController = jest.fn(({ sheet, backdrop, getInitialFocus, onClose }) => {
    const controller = {
        open: jest.fn(() => {
            sheet.hidden = false;
            backdrop.hidden = false;
            getInitialFocus()?.focus();
        }),
        close: jest.fn(() => {
            if (sheet.hidden) return;
            sheet.hidden = true;
            backdrop.hidden = true;
            onClose();
        }),
        isOpen: () => !sheet.hidden,
    };
    backdrop.addEventListener('click', () => controller.close());
    return controller;
});

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));

await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: mockAnimateIn,
    animateOut: mockAnimateOut,
    play: jest.fn(),
    stopMotion: jest.fn(),
    MOTION_FAST: 200,
    MOTION_POPOVER_CLOSE: 150,
    MOTION_EASE_OUT_CUBIC: 'cubic-bezier(0.33, 1, 0.68, 1)',
}));

await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '(max-width: 768px)',
    positionPopover: mockPositionPopover,
}));

await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: mockBlockUpstreamDrawerClose,
    createSheetController: mockCreateSheetController,
}));

const { openPicker, closePicker, isPickerOpen } = await import('../../public/scripts/sillybunny-editor/picker.js');
let cleanups;

beforeEach(() => {
    closePicker({ animate: false });
    jest.clearAllMocks();
    document.body.replaceChildren();
    cleanups = [];
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: jest.fn(() => ({ matches: false })),
    });
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
        callback(0);
        return 1;
    });
});

afterEach(() => {
    closePicker({ animate: false });
    for (const cleanup of cleanups.reverse()) cleanup();
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

function makePicker(options = {}) {
    const trigger = document.createElement('button');
    trigger.textContent = 'Choose';
    document.body.append(trigger);
    const onSelect = jest.fn();
    const onClose = jest.fn();
    const items = [
        { value: 'a', label: 'Alpha', subtitle: 'First book', icon: 'fa-solid fa-book' },
        { value: 'b', label: 'Beta', subtitle: 'Second book' },
        { value: 'c', label: 'Gamma' },
    ];
    const config = { trigger, title: 'Books', items, onSelect, onClose, ...options };
    const picker = openPicker(config);
    const surface = document.querySelector('.sb-picker, .sb-picker-sheet');
    const input = surface?.querySelector('.sb-picker__search');
    const list = surface?.querySelector('.sb-picker__list');
    return { picker, trigger, onSelect, onClose, config, surface, input, list };
}

function keydown(target, key, options = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
}

function filter(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('searchable picker', () => {
    test('opens a body-mounted desktop dialog and synchronizes trigger ARIA', () => {
        const { picker, trigger, surface, input, list } = makePicker();

        expect(picker.isOpen).toBe(true);
        expect(isPickerOpen()).toBe(true);
        expect(isPickerOpen(trigger)).toBe(true);
        expect(surface.parentElement).toBe(document.body);
        expect(surface.classList.contains('sb-action-popover')).toBe(true);
        expect(surface.getAttribute('role')).toBe('dialog');
        expect(surface.getAttribute('aria-label')).toBe('Books');
        expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(input.getAttribute('role')).toBe('combobox');
        expect(input.getAttribute('aria-controls')).toBe(list.id);
        expect(input.getAttribute('aria-autocomplete')).toBe('list');
        expect(input.getAttribute('aria-expanded')).toBe('true');
        expect(input.getAttribute('aria-label')).toBe('Search');
        expect(list.getAttribute('role')).toBe('listbox');
        expect(document.activeElement).toBe(input);
        expect(mockBlockUpstreamDrawerClose).toHaveBeenCalledWith(surface);
    });

    test('opening again on the same trigger toggles closed and returns an inert handle', () => {
        const { picker, config, trigger, onClose } = makePicker();

        const toggled = openPicker(config);

        expect(picker.isOpen).toBe(false);
        expect(toggled.isOpen).toBe(false);
        expect(isPickerOpen()).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(trigger);
        toggled.close();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('close is idempotent, removes the surface and returns focus', () => {
        const { picker, surface, trigger, onClose } = makePicker();

        picker.close();
        picker.close();
        closePicker();

        expect(picker.isOpen).toBe(false);
        expect(surface.isConnected).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(mockAnimateOut).toHaveBeenCalledWith(surface, expect.any(Array), expect.any(Function), expect.objectContaining({ duration: 150 }));
    });

    test('filtering searches labels and subtitles case-insensitively', () => {
        const { input, list } = makePicker();

        filter(input, 'ALP');
        expect(list.querySelectorAll('[role="option"]')).toHaveLength(1);
        expect(list.textContent).toContain('Alpha');
        filter(input, 'SECOND');
        expect(list.querySelectorAll('[role="option"]')).toHaveLength(1);
        expect(list.textContent).toContain('Beta');
        filter(input, '');
        expect(list.querySelectorAll('[role="option"]')).toHaveLength(3);
    });

    test('an empty filter result renders a presentation row and clears active descendant', () => {
        const { input, list, onSelect } = makePicker({ emptyText: 'Nothing found' });

        filter(input, 'missing');
        const empty = list.querySelector('.sb-picker__empty');
        expect(empty.textContent).toBe('Nothing found');
        expect(empty.getAttribute('role')).toBe('presentation');
        expect(input.hasAttribute('aria-activedescendant')).toBe(false);
        keydown(input, 'Enter');
        keydown(input, 'ArrowDown');
        expect(onSelect).not.toHaveBeenCalled();
        filter(input, 'Beta');
        expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toContain('Beta');
    });

    test('ArrowUp/Down, Home and End update active descendants and scroll the option', () => {
        const { input, list } = makePicker();
        const options = [...list.children];
        const scroll = jest.fn();
        for (const option of options) option.scrollIntoView = scroll;

        expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);
        keydown(input, 'ArrowDown');
        expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
        expect(options[1].classList.contains('is-active')).toBe(true);
        expect(options[0].classList.contains('is-active')).toBe(false);
        keydown(input, 'End');
        expect(input.getAttribute('aria-activedescendant')).toBe(options[2].id);
        keydown(input, 'ArrowUp');
        expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
        keydown(input, 'Home');
        expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);
        expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    });

    test('Enter selects the active filtered value and closes', () => {
        const { picker, input, onSelect } = makePicker();
        filter(input, 'book');
        keydown(input, 'ArrowDown');

        const event = keydown(input, 'Enter');

        expect(event.defaultPrevented).toBe(true);
        expect(onSelect).toHaveBeenCalledWith('b');
        expect(picker.isOpen).toBe(false);
    });

    test('clicking a nested option label selects once, then closes and returns focus', () => {
        let wasOpenDuringSelection = false;
        const onSelect = jest.fn(() => { wasOpenDuringSelection = isPickerOpen(); });
        const { picker, list, trigger, onClose } = makePicker({ onSelect });

        list.querySelector('.sb-picker__label').click();

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith('a');
        expect(wasOpenDuringSelection).toBe(true);
        expect(picker.isOpen).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(trigger);
    });

    test('Escape closes without propagating to document and ignores composing Escape', () => {
        const { picker, input } = makePicker();
        const listener = jest.fn();
        document.addEventListener('keydown', listener);
        cleanups.push(() => document.removeEventListener('keydown', listener));

        keydown(input, 'Escape', { isComposing: true });
        expect(picker.isOpen).toBe(true);
        listener.mockClear();
        const event = keydown(input, 'Escape');

        expect(event.defaultPrevented).toBe(true);
        expect(picker.isOpen).toBe(false);
        expect(listener).not.toHaveBeenCalled();
    });

    test('outside pointerdown closes but pointerdown on the input or trigger does not', () => {
        const { picker, input, trigger } = makePicker();
        input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(picker.isOpen).toBe(true);

        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));

        expect(picker.isOpen).toBe(false);
        expect(document.activeElement).toBe(trigger);
    });

    test('footer action rows stay outside the listbox and close before invoking their action', () => {
        const footerAction = jest.fn(() => expect(isPickerOpen()).toBe(false));
        const { surface, list, input, onSelect } = makePicker({
            footer: [{ label: 'New book…', icon: 'fa-solid fa-plus', onSelect: footerAction }],
        });
        filter(input, 'missing');
        const button = surface.querySelector('.sb-picker__footer-item');

        expect(button.type).toBe('button');
        expect(list.contains(button)).toBe(false);
        expect(surface.querySelector('[role="separator"]')).not.toBeNull();
        expect(button.textContent).toBe('New book…');
        button.click();

        expect(footerAction).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
    });

    test('selected values have aria-selected and a trailing decorative check', () => {
        const { list } = makePicker({ selected: 'b' });
        const selected = list.querySelector('[aria-selected="true"]');

        expect(selected.textContent).toContain('Beta');
        expect(selected.lastElementChild.classList.contains('fa-check')).toBe(true);
        expect(selected.lastElementChild.getAttribute('aria-hidden')).toBe('true');
        expect(list.querySelectorAll('[aria-selected="false"]')).toHaveLength(2);
    });

    test('only one picker is open and a stale handle cannot close its replacement', () => {
        const first = makePicker();
        const second = makePicker();

        expect(first.picker.isOpen).toBe(false);
        expect(second.picker.isOpen).toBe(true);
        expect(first.trigger.getAttribute('aria-expanded')).toBe('false');
        expect(first.onClose).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('.sb-picker')).toHaveLength(1);
        first.picker.close();
        expect(second.picker.isOpen).toBe(true);
    });

    test('resizing repositions the popover within the provided bounds', () => {
        const bounds = document.createElement('section');
        document.body.append(bounds);
        const { surface, trigger } = makePicker({ bounds });
        expect(mockPositionPopover).toHaveBeenCalledWith(surface, trigger, null, bounds);
        expect(mockAnimateIn).toHaveBeenCalledWith(surface, expect.any(Array), expect.objectContaining({
            duration: 200,
            styles: { 'transform-origin': '0px 0' },
        }));

        window.dispatchEvent(new Event('resize'));

        expect(mockPositionPopover).toHaveBeenCalledTimes(2);
    });

    test.each([[240, 320], [450, 450], [900, 560]])('trigger-width placement sizes a %ipx trigger to %ipx and aligns inline-start', (triggerWidth, expected) => {
        const trigger = document.createElement('button');
        document.body.append(trigger);
        jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ width: triggerWidth });
        const { surface, input } = makePicker({ trigger, matchTriggerWidth: true });
        expect(surface.style.inlineSize).toBe(`${expected}px`);
        expect(surface.style.maxInlineSize).toBe(`${expected}px`);
        expect(mockPositionPopover).toHaveBeenCalledWith(surface, trigger, null, null, 'start');
        filter(input, 'Alpha');
        expect(surface.style.inlineSize).toBe(`${expected}px`);
    });

    test('trigger-width placement caps its width to viewport-clipped bounds on every resize', () => {
        const bounds = document.createElement('div');
        jest.spyOn(bounds, 'getBoundingClientRect').mockReturnValue({ left: -20, right: 260, width: 280 });
        const { surface } = makePicker({ bounds, matchTriggerWidth: true });
        expect(surface.style.inlineSize).toBe('244px');
        bounds.getBoundingClientRect.mockReturnValue({ left: 0, right: 200, width: 200 });
        window.dispatchEvent(new Event('resize'));
        expect(surface.style.inlineSize).toBe('184px');
    });

    test('custom search labels and text content are not interpreted as markup', () => {
        const { input, list } = makePicker({
            searchLabel: 'Find a book',
            items: [{ value: '<x>', label: '<img src=x>', subtitle: '<b>Book</b>' }],
        });

        expect(input.getAttribute('aria-label')).toBe('Find a book');
        expect(list.querySelector('img')).toBeNull();
        expect(list.textContent).toContain('<img src=x>');
        expect(list.textContent).toContain('<b>Book</b>');
    });

    test('mobile opens its own bottom sheet, filters, and closes using its header control', () => {
        window.matchMedia.mockReturnValue({ matches: true });
        const { picker, surface, input, list, trigger, onClose } = makePicker();

        expect(surface.classList.contains('sb-action-sheet')).toBe(true);
        expect(surface.classList.contains('sb-picker-sheet')).toBe(true);
        expect(surface.getAttribute('aria-modal')).toBe('true');
        expect(document.querySelector('.sb-action-sheet-backdrop').hidden).toBe(false);
        expect(surface.hidden).toBe(false);
        expect(surface.querySelector('.sb-action-sheet-title').textContent).toBe('Books');
        expect(mockCreateSheetController).toHaveBeenCalledTimes(1);
        expect(mockBlockUpstreamDrawerClose).toHaveBeenCalledWith(surface);
        filter(input, 'Second');
        expect(list.querySelectorAll('[role="option"]')).toHaveLength(1);

        surface.querySelector('.sb-action-sheet-close').click();

        expect(picker.isOpen).toBe(false);
        expect(surface.hidden).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
    });

    test('mobile Escape stops propagation and backdrop dismissal synchronizes the handle', () => {
        window.matchMedia.mockReturnValue({ matches: true });
        const { picker, input, config, onClose } = makePicker();
        const listener = jest.fn();
        document.addEventListener('keydown', listener);
        cleanups.push(() => document.removeEventListener('keydown', listener));

        keydown(input, 'Escape');

        expect(picker.isOpen).toBe(false);
        expect(listener).not.toHaveBeenCalled();
        const reopened = openPicker(config);
        document.querySelector('.sb-action-sheet-backdrop').click();
        expect(reopened.isOpen).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    test('mobile selection uses the same keyboard and focus-return contract', () => {
        window.matchMedia.mockReturnValue({ matches: true });
        const { picker, input, trigger, onSelect } = makePicker();
        keydown(input, 'End');

        keydown(input, 'Enter');

        expect(onSelect).toHaveBeenCalledWith('c');
        expect(picker.isOpen).toBe(false);
        expect(document.activeElement).toBe(trigger);
        expect(input.getAttribute('aria-expanded')).toBe('false');
    });
});

describe('picker review regressions', () => {
    test('keyboard focus leaving the desktop popover closes it without stealing focus', () => {
        const { picker, input, trigger } = makePicker();
        const elsewhere = document.createElement('button');
        document.body.append(elsewhere);
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: elsewhere }));
        expect(picker.isOpen).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).not.toBe(trigger);
    });

    test('focus moving within the popover or to the trigger keeps it open', () => {
        const { picker, input, surface, trigger } = makePicker();
        const option = surface.querySelector('[role="option"]');
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: option }));
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: trigger }));
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
        expect(picker.isOpen).toBe(true);
    });
});

describe('multi-toggle picker', () => {
    test('cycles live states without closing, moving focus, or changing query and active index', () => {
        let state = null;
        const onSelect = jest.fn(() => { state = state === null ? 'selected' : state === 'selected' ? 'excluded' : null; });
        const { picker, list, input } = makePicker({ multiple: true, getItemState: () => state, onSelect });
        expect(list.closest('.sb-picker').classList.contains('sb-picker--multiple')).toBe(true);
        expect(list.getAttribute('aria-multiselectable')).toBe('true');
        filter(input, 'book');
        keydown(input, 'ArrowDown');
        for (const expected of ['selected', 'excluded', null]) {
            keydown(input, 'Enter');
            expect(picker.isOpen).toBe(true);
            expect(document.activeElement).toBe(input);
            expect(input.value).toBe('book');
            expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toContain('Beta');
            const option = list.children[1];
            expect(option.getAttribute('aria-selected')).toBe(String(expected === 'selected'));
            expect(Boolean(option.querySelector('.fa-check'))).toBe(expected === 'selected');
            expect(Boolean(option.querySelector('.fa-minus'))).toBe(expected === 'excluded');
            expect(option.querySelector('.sr-only')?.textContent ?? null).toBe(expected === 'excluded' ? 'lorum ipsum' : null);
        }
        expect(onSelect.mock.calls).toEqual([['b'], ['b'], ['b']]);
    });

    test('muted options remain selectable and pointer down preserves combobox focus', () => {
        const { picker, list, input, onSelect } = makePicker({ multiple: true, items: [{ value: 'a', label: 'Alpha', muted: true }] });
        const option = list.firstElementChild;
        expect(option.classList.contains('is-muted')).toBe(true);
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        option.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
        option.click();
        expect(onSelect).toHaveBeenCalledWith('a');
        expect(picker.isOpen).toBe(true);
        expect(document.activeElement).toBe(input);
    });

    test('refresh replaces items in place, preserving query, input and active index', () => {
        const { picker, input, list } = makePicker({ multiple: true });
        filter(input, 'a');
        keydown(input, 'ArrowDown');
        list.scrollTop = 30;
        list.closest('.sb-picker').scrollTop = 20;
        picker.refresh([{ value: 'x', label: 'Delta' }, { value: 'y', label: 'Zeta' }]);
        expect(input.value).toBe('a');
        expect(document.activeElement).toBe(input);
        expect(list.children).toHaveLength(2);
        expect(list.scrollTop).toBe(30);
        expect(list.closest('.sb-picker').scrollTop).toBe(20);
        expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe('Zeta');
        picker.refresh();
        expect(list.children).toHaveLength(2);
        picker.close();
        picker.refresh([]);
        expect(picker.isOpen).toBe(false);
    });
});
