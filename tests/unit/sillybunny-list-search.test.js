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
        expect(mockPlay).toHaveBeenCalledWith(field, expect.any(Array), { duration: 300 });
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

    test('Escape in the input closes search without reaching document listeners', () => {
        const { search, input, field, onChange } = makeSearch();
        search.open();
        typeQuery(input, 'term');
        const ancestor = listenOnDocument();

        const event = keydown(input, 'Escape');

        expect(field.hidden).toBe(true);
        expect(search.query).toBe('');
        expect(onChange).toHaveBeenLastCalledWith('');
        expect(event.defaultPrevented).toBe(true);
        expect(ancestor).not.toHaveBeenCalled();
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
