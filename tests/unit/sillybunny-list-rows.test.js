/** @jest-environment jsdom */
/* global globalThis:readonly */
/* eslint-disable playwright/no-standalone-expect -- Playwright does not recognize Jest test.each callbacks. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const { reconcileRows, rowEntry, bindListKeyboard, bindSortable } = await import('../../public/scripts/sillybunny-editor/list-rows.js');

const originalDollar = Object.getOwnPropertyDescriptor(globalThis, '$');
let cleanups;

beforeEach(() => {
    jest.clearAllMocks();
    document.body.replaceChildren();
    cleanups = [];
});

afterEach(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    jest.restoreAllMocks();
    document.body.replaceChildren();
    if (originalDollar) Object.defineProperty(globalThis, '$', originalDollar);
    else delete globalThis.$;
});

function makeReconciler() {
    const container = document.createElement('div');
    const cache = new Map();
    const create = jest.fn(entry => {
        const row = document.createElement('div');
        row.textContent = entry.name;
        return row;
    });
    const update = jest.fn();
    const render = (entries, options = {}) => reconcileRows({
        container,
        cache,
        entries,
        key: entry => entry.id,
        create,
        update,
        ...options,
    });
    return { container, cache, create, update, render };
}

function makeKeyboardList(options = {}) {
    const container = document.createElement('div');
    const rows = ['a', 'b', 'c'].map(key => {
        const row = document.createElement('div');
        row.dataset.sbListKey = key;
        row.tabIndex = 0;
        container.append(row);
        return row;
    });
    document.body.append(container);
    const onOpen = jest.fn();
    const onRename = jest.fn();
    const onMove = jest.fn();
    const unbind = bindListKeyboard(container, { onOpen, onRename, onMove, ...options });
    cleanups.push(unbind);
    return { container, rows, onOpen, onRename, onMove, unbind };
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

function mockSortable() {
    const sortable = jest.fn();
    const wrapped = { sortable };
    sortable.mockReturnValue(wrapped);
    const jq = jest.fn(() => wrapped);
    jq.fn = { sortable };
    globalThis.$ = jq;
    return { jq, sortable };
}

describe('reconcileRows', () => {
    const entries = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }];

    test('creates ordered keyed rows and returns their keys as a Set', () => {
        const { container, cache, create, render } = makeReconciler();

        const keys = render(entries);

        expect(keys).toBeInstanceOf(Set);
        expect([...keys]).toEqual(['a', 'b', 'c']);
        expect([...container.children].map(row => row.dataset.sbListKey)).toEqual(['a', 'b', 'c']);
        expect([...container.children].map(row => row.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
        expect(create.mock.calls).toEqual(entries.map(entry => [entry]));
        expect(cache.get('a').row).toBe(container.firstElementChild);
    });

    test('reuses a row when the default JSON signature is unchanged', () => {
        const { container, create, render } = makeReconciler();
        render(entries);
        const rows = [...container.children];

        render(entries.map(entry => ({ ...entry })));

        for (const [index, row] of rows.entries()) expect(container.children[index]).toBe(row);
        expect(create).toHaveBeenCalledTimes(3);
    });

    test('replaces only the row whose signature changes', () => {
        const { container, cache, create, render } = makeReconciler();
        render(entries);
        const [first, second, third] = container.children;
        const changed = { id: 'b', name: 'Renamed' };

        render([entries[0], changed, entries[2]]);

        expect(container.children[0]).toBe(first);
        expect(container.children[1]).not.toBe(second);
        expect(container.children[1].dataset.sbListKey).toBe('b');
        expect(container.children[1].textContent).toBe('Renamed');
        expect(container.children[2]).toBe(third);
        expect(second.parentElement).toBeNull();
        expect(cache.get('b').row).toBe(container.children[1]);
        expect(rowEntry(container.children[1])).toBe(changed);
        expect(create).toHaveBeenCalledTimes(4);
    });

    test.each([
        ['a', 'c', 'b'],
        ['b', 'a', 'c'],
        ['b', 'c', 'a'],
        ['c', 'a', 'b'],
        ['c', 'b', 'a'],
    ])('reorders existing rows to %s, %s, %s without recreating them', (...order) => {
        const { container, cache, create, render } = makeReconciler();
        render(entries);
        const rows = new Map([...cache].map(([key, value]) => [key, value.row]));

        const keys = render(order.map(key => entries.find(entry => entry.id === key)));

        expect([...keys]).toEqual(order);
        expect([...container.children].map(row => row.dataset.sbListKey)).toEqual(order);
        for (const [index, key] of order.entries()) expect(container.children[index]).toBe(rows.get(key));
        expect(create).toHaveBeenCalledTimes(3);
    });

    test('removes missing rows and cache entries, including when the list becomes empty', () => {
        const { container, cache, render } = makeReconciler();
        render(entries);
        const [first, second, third] = container.children;

        expect(render([entries[1]])).toEqual(new Set(['b']));
        expect([...container.children]).toEqual([second]);
        expect([...cache.keys()]).toEqual(['b']);
        expect(first.parentElement).toBeNull();
        expect(third.parentElement).toBeNull();

        expect(render([])).toEqual(new Set());
        expect(container.children).toHaveLength(0);
        expect(cache.size).toBe(0);
    });

    test('updates every row on every pass, including reused rows', () => {
        const { container, update, render } = makeReconciler();
        render(entries);
        const rows = [...container.children];

        expect(update.mock.calls).toEqual(entries.map((entry, index) => [rows[index], entry]));
        update.mockClear();
        const next = entries.map(entry => ({ ...entry }));
        render(next);

        expect(update.mock.calls).toEqual(next.map((entry, index) => [rows[index], entry]));
    });

    test('supports numeric key zero', () => {
        const { container, cache, render } = makeReconciler();
        const entry = { id: 0, name: 'Zero' };

        expect(render([entry])).toEqual(new Set(['0']));
        expect(container.firstElementChild.dataset.sbListKey).toBe('0');
        expect(cache.get('0').row).toBe(container.firstElementChild);
        expect(rowEntry(container.firstElementChild)).toBe(entry);
    });

    test('rowEntry returns the latest entry even when a custom signature reuses the row', () => {
        const { container, create, render } = makeReconciler();
        const signature = entry => entry.name;
        const initial = { id: 'a', name: 'Alpha', selected: false };
        const latest = { ...initial, selected: true };
        render([initial], { signature });
        const row = container.firstElementChild;
        expect(rowEntry(row)).toBe(initial);

        render([latest], { signature });

        expect(container.firstElementChild).toBe(row);
        expect(create).toHaveBeenCalledTimes(1);
        expect(rowEntry(row)).toBe(latest);
        expect(rowEntry(null)).toBeUndefined();
        expect(rowEntry(document.createElement('div'))).toBeUndefined();
    });
});

describe('bindListKeyboard', () => {
    test('opens a clicked row, including a non-control descendant', () => {
        const { rows: [row], onOpen } = makeKeyboardList();
        const label = document.createElement('span');
        row.append(label);

        row.click();
        label.click();

        expect(onOpen).toHaveBeenCalledTimes(2);
        expect(onOpen).toHaveBeenNthCalledWith(1, row, expect.any(MouseEvent));
        expect(onOpen).toHaveBeenNthCalledWith(2, row, expect.any(MouseEvent));
    });

    test.each(['button', 'input', '[role="switch"]'])('does not open when clicking a nested %s', selector => {
        const { rows: [row], onOpen } = makeKeyboardList();
        const control = document.createElement(selector === '[role="switch"]' ? 'span' : selector);
        if (selector === '[role="switch"]') control.setAttribute('role', 'switch');
        row.append(control);

        control.click();

        expect(onOpen).not.toHaveBeenCalled();
    });

    test('does not open when clicking inside a key source', () => {
        const { rows: [row], onOpen } = makeKeyboardList({ keySourceSelector: '.grip' });
        const grip = document.createElement('span');
        grip.className = 'grip';
        const icon = document.createElement('span');
        grip.append(icon);
        row.append(grip);

        icon.click();

        expect(onOpen).not.toHaveBeenCalled();
    });

    test.each(['Enter', ' '])('%j opens a focused row and prevents its default action', key => {
        const { rows: [row], onOpen } = makeKeyboardList();
        row.focus();

        const event = keydown(row, key);

        expect(document.activeElement).toBe(row);
        expect(onOpen).toHaveBeenCalledWith(row, event);
        expect(event.defaultPrevented).toBe(true);
    });

    test('leaves Enter on a nested button alone', () => {
        const { rows: [row], onOpen } = makeKeyboardList();
        const button = document.createElement('button');
        row.append(button);
        button.focus();

        const event = keydown(button, 'Enter');

        expect(onOpen).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    test('F2 renames a row and prevents its default action', () => {
        const { rows: [row], onRename, onOpen } = makeKeyboardList();

        const event = keydown(row, 'F2');

        expect(onRename).toHaveBeenCalledWith(row, event);
        expect(onOpen).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    test.each([['ArrowUp', -1], ['ArrowDown', 1]])('Alt+%s moves by %s and consumes the event', (key, direction) => {
        const { rows: [row], onMove } = makeKeyboardList();
        const ancestor = listenOnDocument();

        const event = keydown(row, key, { altKey: true });

        expect(onMove).toHaveBeenCalledWith(row, direction, event);
        expect(event.defaultPrevented).toBe(true);
        expect(ancestor).not.toHaveBeenCalled();
    });

    test.each([
        ['Enter', 'onOpen', {}],
        [' ', 'onOpen', {}],
        ['F2', 'onRename', {}],
        ['ArrowUp', 'onMove', { altKey: true }],
        ['ArrowDown', 'onMove', { altKey: true }],
    ])('%s remains unconsumed when %s returns false', (key, callback, options) => {
        const decline = jest.fn(() => false);
        const { rows: [row] } = makeKeyboardList({ [callback]: decline });
        const ancestor = listenOnDocument();

        const event = keydown(row, key, options);

        expect(decline).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
        expect(ancestor).toHaveBeenCalledWith(event);
    });

    test.each([
        ['ArrowDown', 0, 1],
        ['ArrowUp', 2, 1],
        ['Home', 2, 0],
        ['End', 0, 2],
    ])('%s moves focus from row %s to row %s', (key, from, to) => {
        const { rows } = makeKeyboardList();
        rows[from].focus();

        const event = keydown(rows[from], key);

        expect(document.activeElement).toBe(rows[to]);
        expect(event.defaultPrevented).toBe(true);
    });

    test.each(['hidden', 'inert'])('navigation skips rows inside a [%s] ancestor', attribute => {
        const { container, rows: [first, middle, last] } = makeKeyboardList();
        const wrapper = document.createElement('div');
        wrapper.setAttribute(attribute, '');
        container.insertBefore(wrapper, middle);
        wrapper.append(middle);
        first.focus();

        keydown(first, 'ArrowDown');
        expect(document.activeElement).toBe(last);
        keydown(last, 'ArrowUp');
        expect(document.activeElement).toBe(first);
    });

    test.each(['ArrowDown', 'ArrowUp', 'Home', 'End'])('navigate: false disables %s navigation', key => {
        const { rows } = makeKeyboardList({ navigate: false });
        rows[1].focus();

        const event = keydown(rows[1], key);

        expect(document.activeElement).toBe(rows[1]);
        expect(event.defaultPrevented).toBe(false);
    });

    test('keys from a key source descendant act on its row', () => {
        const { rows: [row, next], onOpen, onRename, onMove } = makeKeyboardList({ keySourceSelector: '.grip' });
        const grip = document.createElement('span');
        grip.className = 'grip';
        const icon = document.createElement('span');
        icon.tabIndex = 0;
        grip.append(icon);
        row.append(grip);
        icon.focus();

        const open = keydown(icon, 'Enter');
        const rename = keydown(icon, 'F2');
        const move = keydown(icon, 'ArrowDown', { altKey: true });
        const navigate = keydown(icon, 'ArrowDown');

        expect(onOpen).toHaveBeenCalledWith(row, open);
        expect(onRename).toHaveBeenCalledWith(row, rename);
        expect(onMove).toHaveBeenCalledWith(row, 1, move);
        expect(navigate.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(next);
    });

    test('unbind removes both click and keyboard handlers', () => {
        const { rows: [row], onOpen, onRename, onMove, unbind } = makeKeyboardList();
        row.focus();
        unbind();

        row.click();
        const event = keydown(row, 'Enter');
        keydown(row, 'F2');
        keydown(row, 'ArrowDown', { altKey: true });
        keydown(row, 'ArrowDown');

        expect(onOpen).not.toHaveBeenCalled();
        expect(onRename).not.toHaveBeenCalled();
        expect(onMove).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(row);
    });

    test.each([
        ['Enter', {}],
        ['F2', {}],
        ['ArrowDown', { altKey: true }],
        ['ArrowDown', {}],
    ])('ignores composing %s events', (key, options) => {
        const { rows: [row], onOpen, onRename, onMove } = makeKeyboardList();
        row.focus();

        const event = keydown(row, key, { ...options, isComposing: true });

        expect(onOpen).not.toHaveBeenCalled();
        expect(onRename).not.toHaveBeenCalled();
        expect(onMove).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(row);
    });
});

describe('bindSortable', () => {
    test('returns null when jQuery or its sortable plugin is unavailable', () => {
        const box = document.createElement('div');
        const options = { handle: '.grip', items: '.row', update: jest.fn() };
        delete globalThis.$;
        expect(bindSortable(box, options)).toBeNull();

        const jq = jest.fn();
        jq.fn = {};
        globalThis.$ = jq;

        expect(bindSortable(box, options)).toBeNull();
        expect(jq).not.toHaveBeenCalled();
    });

    test.each([true, false])('passes sortable options with touch=%s', touchEnabled => {
        const { jq, sortable } = mockSortable();
        const box = document.createElement('div');
        const start = jest.fn();
        const update = jest.fn();
        const stop = jest.fn();
        const touch = jest.fn(() => touchEnabled);

        bindSortable(box, { handle: '.grip', items: '.row', disabled: true, touch, start, update, stop });

        expect(jq).toHaveBeenCalledWith(box);
        expect(touch).toHaveBeenCalledTimes(1);
        expect(sortable).toHaveBeenCalledTimes(1);
        expect(sortable).toHaveBeenCalledWith({
            handle: '.grip',
            items: '.row',
            axis: 'y',
            delay: touchEnabled ? 30 : 0,
            distance: 4,
            cancel: 'input,textarea,button,select,option',
            disabled: true,
            start: expect.any(Function),
            update,
            stop: expect.any(Function),
        });
        const options = sortable.mock.calls[0][0];
        const event = {};
        const ui = {};
        options.start(event, ui);
        options.update(event, ui);
        options.stop();
        expect(start).toHaveBeenCalledWith(event, ui);
        expect(update).toHaveBeenCalledWith(event, ui);
        expect(stop).toHaveBeenCalledWith();
    });

    test('binds once per box and only updates disabled on subsequent binds', () => {
        const { sortable } = mockSortable();
        const box = document.createElement('div');
        const options = { handle: '.grip', items: '.row', update: jest.fn() };
        const first = bindSortable(box, options);

        const second = bindSortable(box, { ...options, handle: '.other', disabled: true });

        expect(second).toBe(first);
        expect(sortable.mock.calls).toEqual([
            [expect.objectContaining({ handle: '.grip', disabled: false, delay: 0 })],
            ['option', 'disabled', true],
        ]);
        expect(bindSortable(box, { ...options, disabled: true })).toBe(first);
        expect(sortable).toHaveBeenCalledTimes(2);
    });

    test('setDisabled calls the plugin only when the value changes', () => {
        const { sortable } = mockSortable();
        const box = document.createElement('div');
        const controller = bindSortable(box, { handle: '.grip', items: '.row', update: jest.fn() });
        sortable.mockClear();

        controller.setDisabled(false);
        expect(sortable).not.toHaveBeenCalled();
        controller.setDisabled(true);
        controller.setDisabled(true);
        controller.setDisabled(false);
        controller.setDisabled(false);

        expect(sortable.mock.calls).toEqual([
            ['option', 'disabled', true],
            ['option', 'disabled', false],
        ]);
    });

    test('destroy removes the controller and allows a new plugin initialization', () => {
        const { sortable } = mockSortable();
        const box = document.createElement('div');
        const options = { handle: '.grip', items: '.row', update: jest.fn() };
        const first = bindSortable(box, options);
        box.classList.add('ui-sortable');

        first.destroy();
        expect(sortable).toHaveBeenLastCalledWith('destroy');
        const second = bindSortable(box, options);

        expect(second).not.toBe(first);
        expect(sortable).toHaveBeenCalledTimes(3);
        expect(sortable).toHaveBeenLastCalledWith(expect.objectContaining({ handle: '.grip', items: '.row' }));
    });
});
