/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom tests use test.each and synchronous DOM assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockPlay = jest.fn();
const mockStopMotion = jest.fn();
const mockAnimateOut = jest.fn((_field, _frames, hide) => hide());

await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    play: mockPlay,
    stopMotion: mockStopMotion,
    animateOut: mockAnimateOut,
    prefersReducedMotion: () => false,
    MOTION_SLOW: 300,
}));

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
}));

const { createListSearch } = await import('../../public/scripts/sillybunny-editor/list-search.js');

let cleanups;

beforeEach(() => {
    jest.clearAllMocks();
    document.body.replaceChildren();
    cleanups = [];
});

afterEach(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

function makeSearch(options = {}) {
    const field = document.createElement('label');
    field.hidden = true;
    const input = document.createElement('input');
    input.type = 'search';
    field.append(input);
    const trigger = document.createElement('button');
    const scope = document.createElement('div');
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.tabIndex = 0;
    row.dataset.sbListKey = 'a';
    scroller.append(row);
    const status = document.createElement('div');
    scope.append(trigger, field, scroller, status);
    document.body.append(scope);
    const onChange = jest.fn();
    const search = createListSearch({ field, input, trigger, scope, scroller, status, onChange, ...options });
    cleanups.push(() => search.destroy());
    return { search, field, input, trigger, scope, scroller, row, status, onChange };
}

function typeQuery(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function keydown(target, key, options = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
}

function listenOnDocument() {
    const listener = jest.fn();
    document.addEventListener('keydown', listener);
    cleanups.push(() => document.removeEventListener('keydown', listener));
    return listener;
}

describe('createListSearch', () => {
    test('input events notify synchronously with debounce zero', () => {
        const { search, input, onChange } = makeSearch({ debounce: 0 });

        typeQuery(input, 'a');
        expect(onChange).toHaveBeenCalledWith('a');
        expect(search.query).toBe('a');
        typeQuery(input, 'ab');

        expect(onChange.mock.calls).toEqual([['a'], ['ab']]);
        expect(search.query).toBe('ab');
    });

    test('debounces rapid input until 300 ms after the latest event', () => {
        jest.useFakeTimers();
        const { search, input, onChange } = makeSearch({ debounce: 300 });

        typeQuery(input, 'a');
        jest.advanceTimersByTime(100);
        typeQuery(input, 'ab');
        jest.advanceTimersByTime(100);
        typeQuery(input, 'abc');
        jest.advanceTimersByTime(299);

        expect(onChange).not.toHaveBeenCalled();
        expect(search.query).toBe('');
        jest.advanceTimersByTime(1);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('abc');
        expect(search.query).toBe('abc');
        jest.runOnlyPendingTimers();
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('toggle opens and closes the field, synchronizing focus, query and trigger state', () => {
        const { search, field, input, trigger, onChange } = makeSearch();
        expect(search.isOpen).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        search.toggle();

        expect(field.hidden).toBe(false);
        expect(search.isOpen).toBe(true);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(input);
        expect(mockStopMotion).toHaveBeenCalledWith(field);
        expect(mockPlay).toHaveBeenCalledWith(field, expect.any(Array), expect.objectContaining({ duration: 300 }));
        typeQuery(input, 'term');
        onChange.mockClear();

        search.toggle();

        expect(input.value).toBe('');
        expect(search.query).toBe('');
        expect(onChange).toHaveBeenCalledWith('');
        expect(field.hidden).toBe(true);
        expect(search.isOpen).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
        expect(mockAnimateOut).toHaveBeenCalledWith(field, expect.any(Array), expect.any(Function), { duration: 300 });
    });

    test('Escape clears the query first, then closes search without reaching document listeners', () => {
        const { search, input, field, onChange } = makeSearch({ escapeClearsFirst: true });
        search.open();
        typeQuery(input, 'term');
        const ancestor = listenOnDocument();

        const clearEvent = keydown(input, 'Escape');

        expect(field.hidden).toBe(false);
        expect(search.query).toBe('');
        expect(onChange).toHaveBeenLastCalledWith('');
        expect(clearEvent.defaultPrevented).toBe(true);
        expect(ancestor).not.toHaveBeenCalled();

        keydown(input, 'Escape');
        expect(field.hidden).toBe(true);
    });

    test.each(['ctrlKey', 'metaKey'])('%s+F inside scope opens search and consumes the event', modifier => {
        const { search, field, input, row } = makeSearch();
        row.focus();
        const ancestor = listenOnDocument();

        const event = keydown(row, 'f', { [modifier]: true });

        expect(search.isOpen).toBe(true);
        expect(field.hidden).toBe(false);
        expect(document.activeElement).toBe(input);
        expect(event.defaultPrevented).toBe(true);
        expect(ancestor).not.toHaveBeenCalled();
    });

    test.each(['ctrlKey', 'metaKey'])('%s+F is ignored in a textarea inside scope', modifier => {
        const { scope, search, onChange } = makeSearch();
        const textarea = document.createElement('textarea');
        scope.append(textarea);
        textarea.focus();
        const ancestor = listenOnDocument();

        const event = keydown(textarea, 'f', { [modifier]: true });

        expect(search.isOpen).toBe(false);
        expect(document.activeElement).toBe(textarea);
        expect(onChange).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
        expect(ancestor).toHaveBeenCalledWith(event);
    });

    test.each(['ctrlKey', 'metaKey'])('%s+F also works from the search input itself', modifier => {
        const { search, input } = makeSearch();
        search.open();
        typeQuery(input, 'term');
        input.setSelectionRange(4, 4);
        const ancestor = listenOnDocument();

        const event = keydown(input, 'F', { [modifier]: true });

        expect(search.isOpen).toBe(true);
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(4);
        expect(event.defaultPrevented).toBe(true);
        expect(ancestor).not.toHaveBeenCalled();
    });

    test('printable keys on a focused row open search and append to the query', () => {
        const { search, input, row, onChange } = makeSearch();
        row.focus();

        const first = keydown(row, 'a');

        expect(search.isOpen).toBe(true);
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('a');
        expect(search.query).toBe('a');
        expect(onChange).toHaveBeenCalledWith('a');
        expect(first.defaultPrevented).toBe(true);
        row.focus();
        const second = keydown(row, 'B', { shiftKey: true });

        expect(input.value).toBe('aB');
        expect(search.query).toBe('aB');
        expect(onChange.mock.calls).toEqual([['a'], ['aB']]);
        expect(second.defaultPrevented).toBe(true);
    });

    test.each([
        [' ', {}],
        ['x', { ctrlKey: true }],
        ['x', { metaKey: true }],
        ['x', { altKey: true }],
        ['Control', { ctrlKey: true }],
        ['Meta', { metaKey: true }],
        ['Alt', { altKey: true }],
        ['Shift', { shiftKey: true }],
    ])('%j with %j does not start type-to-search', (key, options) => {
        const { search, row, onChange } = makeSearch();
        row.focus();

        const event = keydown(row, key, options);

        expect(search.isOpen).toBe(false);
        expect(search.query).toBe('');
        expect(onChange).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    test('printable keys on non-row elements in scope do not start search', () => {
        const { scope, search, onChange } = makeSearch();
        const other = document.createElement('div');
        other.tabIndex = 0;
        scope.append(other);
        other.focus();

        const event = keydown(other, 'x');

        expect(search.isOpen).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    test.each([
        ['f', { ctrlKey: true }],
        ['f', { metaKey: true }],
        ['x', {}],
    ])('shortcuts: false disables %j with %j', (key, options) => {
        const { search, row, onChange } = makeSearch({ shortcuts: false });
        row.focus();
        const ancestor = listenOnDocument();

        const event = keydown(row, key, options);

        expect(search.isOpen).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
        expect(ancestor).toHaveBeenCalledWith(event);
    });

    test('clearing restores the scroll position captured before the first non-empty query', () => {
        const { search, input, scroller, onChange } = makeSearch();
        scroller.scrollTop = 120;
        typeQuery(input, 'a');
        scroller.scrollTop = 40;
        typeQuery(input, 'ab');
        scroller.scrollTop = 5;

        search.clear();
        search.report(10, 10);

        expect(scroller.scrollTop).toBe(120);
        expect(input.value).toBe('');
        expect(search.query).toBe('');
        expect(onChange).toHaveBeenLastCalledWith('');
    });

    test.each(['scope', 'ancestor'])('selection on the %s suspends shortcuts without changing the query', location => {
        const { search, field, input, scope, row, onChange } = makeSearch();
        const root = location === 'scope' ? scope : document.createElement('section');
        if (root !== scope) { scope.before(root); root.append(scope); }
        root.dataset.selectionMode = 'true';
        row.focus();
        const globalShortcut = listenOnDocument();
        keydown(row, 'x');
        globalShortcut.mockClear();
        expect(keydown(row, 'f', { ctrlKey: true }).defaultPrevented).toBe(true);
        expect(keydown(row, 'f', { metaKey: true }).defaultPrevented).toBe(true);
        expect(globalShortcut).not.toHaveBeenCalled();
        expect(field.hidden).toBe(true);
        expect(search.query).toBe('');
        expect(input.value).toBe('');
        expect(document.activeElement).toBe(row);
        expect(onChange).not.toHaveBeenCalled();
        root.dataset.selectionMode = 'false';
        keydown(row, 'x');
        expect(search.query).toBe('x');
    });

    test('scroll restore waits for the render that reports after clearing', () => {
        const { search, input, scroller } = makeSearch();
        scroller.scrollTop = 120;
        typeQuery(input, 'a');
        scroller.scrollTop = 5;

        // The consumer deferred its render: nothing reported yet, so nothing restored.
        search.clear();
        expect(scroller.scrollTop).toBe(5);

        // The deferred unfiltered render completes and reports.
        search.report(10, 10);
        expect(scroller.scrollTop).toBe(120);

        // The saved offset is consumed once.
        scroller.scrollTop = 60;
        search.report(10, 10);
        expect(scroller.scrollTop).toBe(60);
    });

    test('report does nothing when the query is empty', () => {
        const { search, status } = makeSearch();
        status.textContent = 'Existing status';

        search.report(0, 10);
        search.report(3, 10);

        expect(status.textContent).toBe('Existing status');
    });

    test.each([
        [0, 10, 'No results'],
        [3, 10, '3 of 10 results'],
    ])('report(%s, %s) announces %j', (shown, total, message) => {
        const { search, status } = makeSearch();
        search.setQuery('term');

        search.report(shown, total);

        expect(status.textContent).toBe(message);
    });

    test('report does not rewrite an unchanged message', () => {
        const { search, status } = makeSearch();
        search.setQuery('term');
        search.report(3, 10);
        expect(status.textContent).toBe('3 of 10 results');
        status.textContent = 'Unchanged marker';

        search.report(3, 10);

        expect(status.textContent).toBe('Unchanged marker');
    });

    test('clearing resets report deduplication so the same message is announced again', () => {
        const { search, status } = makeSearch();
        search.setQuery('term');
        search.report(3, 10);
        search.clear();
        status.textContent = 'Unchanged marker';
        search.setQuery('term');

        search.report(3, 10);

        expect(status.textContent).toBe('3 of 10 results');
    });

    test('setQuery with notify: false updates query and input without notifying', () => {
        const { search, input, onChange } = makeSearch();

        search.setQuery('silent', { notify: false });

        expect(search.query).toBe('silent');
        expect(input.value).toBe('silent');
        expect(onChange).not.toHaveBeenCalled();
    });

    test('setQuery notifies by default', () => {
        const { search, input, onChange } = makeSearch();

        search.setQuery('term');

        expect(search.query).toBe('term');
        expect(input.value).toBe('term');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('term');
    });

    test('trigger aria-controls points at the generated field id', () => {
        const { field, input, trigger } = makeSearch();

        expect(input.id).not.toBe('');
        expect(field.id).toBe(`${input.id}-field`);
        expect(trigger.getAttribute('aria-controls')).toBe(field.id);
        expect(document.getElementById(trigger.getAttribute('aria-controls'))).toBe(field);
    });

    test('destroy removes input, Escape and scope shortcut listeners', () => {
        const { search, input, row, onChange } = makeSearch();
        search.destroy();

        typeQuery(input, 'ignored');
        const find = keydown(row, 'f', { ctrlKey: true });
        const printable = keydown(row, 'x');

        expect(onChange).not.toHaveBeenCalled();
        expect(search.query).toBe('');
        expect(search.isOpen).toBe(false);
        expect(find.defaultPrevented).toBe(false);
        expect(printable.defaultPrevented).toBe(false);
        search.open();
        const escape = keydown(input, 'Escape');
        expect(search.isOpen).toBe(true);
        expect(escape.defaultPrevented).toBe(false);
    });

    describe('closeEmptyOnBlur', () => {
        // The field listens to `focusout`, which the browser fires after `blur` and which bubbles from any control in the field.
        const blur = (target, relatedTarget) => target.dispatchEvent(new FocusEvent('focusout', { relatedTarget, bubbles: true }));
        const press = (target, type = 'pointerdown') => target.dispatchEvent(new Event(type, { bubbles: true }));
        const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
        // A field with a Sort button and a menu opened from it, as the list editors build their search bars.
        function makeBar(options = {}) {
            const bar = makeSearch({ closeEmptyOnBlur: true, ...options });
            const sort = document.createElement('button');
            sort.setAttribute('aria-haspopup', 'menu');
            sort.setAttribute('aria-expanded', 'false');
            bar.field.append(sort);
            const menu = document.createElement('div');
            menu.tabIndex = -1;
            document.body.append(menu);
            // What the shared action menu does: the trigger reads expanded while the menu is open, and a press outside closes it first.
            const openMenu = async () => {
                sort.setAttribute('aria-expanded', 'true');
                await Promise.resolve();
            };
            const closeMenu = () => sort.setAttribute('aria-expanded', 'false');
            return { ...bar, sort, menu, openMenu, closeMenu };
        }

        test('is off by default', () => {
            const { search, input, row } = makeSearch();
            search.open();
            blur(input, row);
            expect(search.isOpen).toBe(true);
        });

        test('closes an empty field when the focus goes outside it, and keeps it for the trigger, the field and a query', async () => {
            const { search, field, input, row, trigger } = makeSearch({ closeEmptyOnBlur: true });
            const inside = document.createElement('button');
            field.append(inside);
            search.open();
            blur(input, trigger);
            blur(input, inside);
            expect(search.isOpen).toBe(true);
            typeQuery(input, 'abc');
            blur(input, row);
            expect(search.isOpen).toBe(true);
            input.value = '';
            blur(input, row);
            await Promise.resolve();
            expect(search.isOpen).toBe(false);
            expect(document.activeElement).toBe(row);
        });

        test('waits for the pointer that caused the blur to finish its click', () => {
            const { search, input, row } = makeSearch({ closeEmptyOnBlur: true });
            search.open();
            input.focus();
            row.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            blur(input, row);
            expect(search.isOpen).toBe(true);
            row.dispatchEvent(new Event('click', { bubbles: true }));
            expect(search.isOpen).toBe(false);
        });

        test('a press on a control inside the field keeps it open when the browser gives that control no focus', () => {
            const { search, field, input, row } = makeSearch({ closeEmptyOnBlur: true });
            const inside = document.createElement('button');
            field.append(inside);
            search.open();
            input.focus();
            inside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            blur(input, null);
            inside.dispatchEvent(new Event('pointerup', { bubbles: true }));
            expect(search.isOpen).toBe(true);
            blur(input, row);
            expect(search.isOpen).toBe(false);
        });

        test('a control in the field that loses the focus to the page closes an empty field, as the input does', async () => {
            const { search, sort, row } = makeBar();
            search.open();
            sort.focus();
            blur(sort, row);
            await Promise.resolve();
            expect(search.isOpen).toBe(false);
            expect(document.activeElement).toBe(row);
        });

        test('Tab from the input to the Sort button keeps the field and Tab on out of it closes it', async () => {
            const { search, input, sort, row } = makeBar();
            search.open();
            blur(input, sort);
            expect(search.isOpen).toBe(true);
            blur(sort, row);
            await Promise.resolve();
            expect(search.isOpen).toBe(false);
        });

        test('a menu opened from a control counts as inside while it is open, and the focus may sit in it', async () => {
            const { search, sort, menu, row, openMenu, closeMenu } = makeBar();
            search.open();
            await openMenu();
            blur(sort, menu);
            expect(search.isOpen).toBe(true);
            // Escape or a chosen item gives the focus back to the button; the menu is gone.
            closeMenu();
            await nextTask();
            await nextTask();
            blur(sort, row);
            await Promise.resolve();
            expect(search.isOpen).toBe(false);
        });

        test('a press outside while the menu is open closes the menu only, and the next press outside closes the field', async () => {
            const { search, row, openMenu, closeMenu } = makeBar();
            search.open();
            await openMenu();
            // The menu dismisses itself in a window capture listener, ahead of the field's listener on the document.
            const dismiss = () => closeMenu();
            window.addEventListener('pointerdown', dismiss, true);
            cleanups.push(() => window.removeEventListener('pointerdown', dismiss, true));
            press(row);
            press(row, 'pointerup');
            press(row, 'click');
            await new Promise(resolve => requestAnimationFrame(resolve));
            expect(search.isOpen).toBe(true);
            await nextTask();
            await nextTask();
            press(row);
            press(row, 'pointerup');
            press(row, 'click');
            expect(search.isOpen).toBe(false);
        });

        test('a press outside closes an empty field whose focus sits on its Sort button, after the click and not before', () => {
            const { search, sort, row } = makeBar();
            search.open();
            sort.focus();
            press(row);
            expect(search.isOpen).toBe(true);
            press(row, 'pointerup');
            expect(search.isOpen).toBe(true);
            press(row, 'click');
            expect(search.isOpen).toBe(false);
        });

        test('a press outside closes an empty field when the focus is nowhere in it, and leaves the focus where the press put it', () => {
            const { search, scope, row } = makeBar();
            const other = document.createElement('button');
            scope.append(other);
            search.open();
            document.body.focus();
            press(row);
            other.focus();
            press(row, 'click');
            expect(search.isOpen).toBe(false);
            expect(document.activeElement).toBe(other);
        });

        test('a press outside keeps a field with a query, and a press on its own controls or the toggle keeps an empty one', () => {
            const { search, input, sort, trigger, row } = makeBar();
            search.open();
            typeQuery(input, 'abc');
            press(row);
            press(row, 'click');
            expect(search.isOpen).toBe(true);
            input.value = '';
            for (const control of [sort, trigger]) {
                press(control);
                press(control, 'click');
                expect(search.isOpen).toBe(true);
            }
        });

        test('a touch that turns into a scroll is no press on the page, but a blur that already moved the focus still closes', async () => {
            const { search, input, row } = makeBar();
            search.open();
            press(row);
            press(row, 'pointercancel');
            expect(search.isOpen).toBe(true);
            input.focus();
            press(row);
            blur(input, row);
            press(row, 'pointercancel');
            await Promise.resolve();
            expect(search.isOpen).toBe(false);
        });

        test('stops listening once destroyed', () => {
            const { search, input, row } = makeSearch({ closeEmptyOnBlur: true });
            search.open();
            search.destroy();
            blur(input, row);
            expect(search.isOpen).toBe(true);
        });
    });

    test('open and close can restore the field without moving the focus or playing motion', () => {
        const { search, field, input, trigger } = makeSearch();
        search.open({ focus: false, animate: false });
        expect([field.hidden, field.inert, field.dataset.state, trigger.getAttribute('aria-expanded')]).toEqual([false, false, 'open', 'true']);
        expect(document.activeElement).not.toBe(input);
        expect(mockPlay).not.toHaveBeenCalled();
        search.close({ focus: false, animate: false });
        expect([field.hidden, field.inert, field.dataset.state, trigger.getAttribute('aria-expanded')]).toEqual([true, true, 'closed', 'false']);
        expect(document.activeElement).not.toBe(trigger);
        expect(mockAnimateOut).not.toHaveBeenCalled();
        search.open();
        expect(document.activeElement).toBe(input);
        expect(mockPlay).toHaveBeenCalledTimes(1);
        search.close();
        expect(document.activeElement).toBe(trigger);
        expect(mockAnimateOut).toHaveBeenCalledTimes(1);
    });

    test('destroy cancels a pending debounced notification', () => {
        jest.useFakeTimers();
        const { search, input, onChange } = makeSearch({ debounce: 300 });
        typeQuery(input, 'pending');

        search.destroy();
        jest.advanceTimersByTime(300);

        expect(onChange).not.toHaveBeenCalled();
        expect(search.query).toBe('');
    });
});
