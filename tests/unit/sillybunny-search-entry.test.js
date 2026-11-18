/** @jest-environment jsdom */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { createSearchEntry } from '../../public/scripts/sillybunny-editor/search-entry.js';

let entries;

beforeEach(() => {
    document.body.replaceChildren();
    entries = [];
});

afterEach(() => {
    for (const entry of entries) entry.destroy();
    jest.useRealTimers();
});

function make(options = {}) {
    const entry = createSearchEntry(options);
    entries.push(entry);
    document.body.append(entry.element);
    return entry;
}

function type(entry, value) {
    entry.input.value = value;
    entry.input.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(target, key, init = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
}

describe('createSearchEntry structure', () => {
    test('builds a search input with a decorative icon, then the input, then the clear button', () => {
        const entry = make({ id: 'find', label: 'Search Prompts', placeholder: 'Search...' });
        expect(entry.input.type).toBe('search');
        expect(entry.input.id).toBe('find');
        expect(entry.input.placeholder).toBe('Search...');
        const [icon, input, clear] = entry.element.children;
        expect(icon.getAttribute('aria-hidden')).toBe('true');
        expect(icon.classList.contains('fa-magnifying-glass')).toBe(true);
        expect(input).toBe(entry.input);
        expect(clear).toBe(entry.clearButton);
    });

    test('variant, entry classes and input classes are applied', () => {
        const entry = make({ variant: 'bar', className: 'host-field', inputClassName: 'host-input other' });
        expect(entry.element.classList.contains('sb-search-entry')).toBe(true);
        expect(entry.element.classList.contains('host-field')).toBe(true);
        expect(entry.element.dataset.variant).toBe('bar');
        expect(entry.input.classList.contains('sb-search-entry__input')).toBe(true);
        expect(entry.input.classList.contains('host-input')).toBe(true);
        expect(entry.input.classList.contains('other')).toBe(true);
    });

    test('defaults to the field variant', () => {
        expect(make().element.dataset.variant).toBe('field');
    });
});

describe('clear button', () => {
    test('has an accessible name and a tooltip; the default is GtkSearchEntry\'s', () => {
        const entry = make();
        expect(entry.clearButton.type).toBe('button');
        expect(entry.clearButton.getAttribute('aria-label')).toBe('Clear Entry');
        expect(entry.clearButton.title).toBe('Clear Entry');
        expect(entry.clearButton.dataset.sbCopyPlaceholder).toBeUndefined();
    });

    test('a supplied label names the button', () => {
        const entry = make({ clearLabel: 'Clear search' });
        expect(entry.clearButton.getAttribute('aria-label')).toBe('Clear search');
        expect(entry.clearButton.title).toBe('Clear search');
        expect(entry.clearButton.dataset.sbCopyPlaceholder).toBeUndefined();
    });

    test('is shown by :placeholder-shown, so the input always has a placeholder', () => {
        expect(make().input.placeholder).not.toBe('');
        expect(make({ placeholder: 'Search...' }).input.placeholder).toBe('Search...');
        const bare = document.createElement('input');
        document.body.append(bare);
        expect(make({ input: bare }).input.placeholder.length).toBeGreaterThan(0);
    });

    test('a click empties the input, tells its listeners and returns focus to it', () => {
        const entry = make({ placeholder: 'Search...' });
        const seen = [];
        entry.input.addEventListener('input', event => seen.push([event.bubbles, entry.input.value]));
        type(entry, 'abc');
        seen.length = 0;
        entry.clearButton.focus();
        entry.clearButton.click();
        expect(entry.input.value).toBe('');
        expect(seen).toEqual([[true, '']]);
        expect(document.activeElement).toBe(entry.input);
    });

    test('a click on an empty input sends no event but still focuses the input', () => {
        const entry = make();
        const listener = jest.fn();
        entry.input.addEventListener('input', listener);
        entry.clearButton.click();
        expect(listener).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(entry.input);
    });
});

describe('Escape', () => {
    test('clears a non-empty input and does not reach the host', () => {
        const entry = make();
        const host = jest.fn();
        document.body.addEventListener('keydown', host);
        type(entry, 'abc');
        const event = press(entry.input, 'Escape');
        expect(entry.input.value).toBe('');
        expect(event.defaultPrevented).toBe(true);
        expect(host).not.toHaveBeenCalled();
        document.body.removeEventListener('keydown', host);
    });

    test('a second Escape on the empty input is left to the host', () => {
        const entry = make();
        const host = jest.fn();
        document.body.addEventListener('keydown', host);
        type(entry, 'abc');
        press(entry.input, 'Escape');
        const second = press(entry.input, 'Escape');
        expect(second.defaultPrevented).toBe(false);
        expect(host).toHaveBeenCalledTimes(1);
        document.body.removeEventListener('keydown', host);
    });

    test('clearing sends the input event so adopted listeners filter again', () => {
        const entry = make();
        const onInput = jest.fn();
        entry.input.addEventListener('input', () => onInput(entry.input.value));
        type(entry, 'abc');
        onInput.mockClear();
        press(entry.input, 'Escape');
        expect(onInput).toHaveBeenCalledWith('');
    });

    test('clearOnEscape: false leaves the key and the text alone', () => {
        const entry = make({ clearOnEscape: false });
        type(entry, 'abc');
        const event = press(entry.input, 'Escape');
        expect(entry.input.value).toBe('abc');
        expect(event.defaultPrevented).toBe(false);
    });

    test('ignores Escape that ends an IME composition and other keys', () => {
        const entry = make();
        type(entry, 'abc');
        press(entry.input, 'Escape', { isComposing: true });
        press(entry.input, 'a');
        expect(entry.input.value).toBe('abc');
    });
});

describe('debounce and onInput', () => {
    test('without debounce onInput runs on every input', () => {
        const onInput = jest.fn();
        const entry = make({ onInput });
        type(entry, 'a');
        type(entry, 'ab');
        expect(onInput.mock.calls).toEqual([['a'], ['ab']]);
    });

    test('with debounce a non-empty value waits for the last keystroke', () => {
        jest.useFakeTimers();
        const onInput = jest.fn();
        const entry = make({ onInput, debounce: 300 });
        type(entry, 'a');
        jest.advanceTimersByTime(200);
        type(entry, 'ab');
        jest.advanceTimersByTime(299);
        expect(onInput).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(onInput.mock.calls).toEqual([['ab']]);
    });

    test('an empty value runs at once and cancels a pending run', () => {
        jest.useFakeTimers();
        const onInput = jest.fn();
        const entry = make({ onInput, debounce: 300 });
        type(entry, 'ab');
        type(entry, '');
        expect(onInput.mock.calls).toEqual([['']]);
        jest.advanceTimersByTime(1000);
        expect(onInput).toHaveBeenCalledTimes(1);
    });

    test('Escape and the clear button skip the wait', () => {
        jest.useFakeTimers();
        const onInput = jest.fn();
        const entry = make({ onInput, debounce: 300 });
        type(entry, 'ab');
        press(entry.input, 'Escape');
        expect(onInput.mock.calls).toEqual([['']]);
        type(entry, 'cd');
        entry.clearButton.click();
        expect(onInput.mock.calls.at(-1)).toEqual(['']);
        expect(onInput).toHaveBeenCalledTimes(2);
    });

    test('destroy cancels a pending run and detaches the listeners', () => {
        jest.useFakeTimers();
        const onInput = jest.fn();
        const entry = make({ onInput, debounce: 300 });
        type(entry, 'ab');
        entry.destroy();
        jest.advanceTimersByTime(1000);
        type(entry, 'abc');
        expect(onInput).not.toHaveBeenCalled();
    });

    test('setValue notifies unless told not to', () => {
        const onInput = jest.fn();
        const entry = make({ onInput });
        entry.setValue('x');
        expect(entry.input.value).toBe('x');
        expect(onInput).toHaveBeenCalledWith('x');
        onInput.mockClear();
        entry.setValue('y', { notify: false });
        expect(entry.input.value).toBe('y');
        expect(onInput).not.toHaveBeenCalled();
    });
});

describe('adopting an input', () => {
    function adopt(options = {}) {
        const host = document.createElement('div');
        const before = document.createElement('span');
        const input = document.createElement('input');
        input.type = 'search';
        input.id = 'existing-search';
        input.value = 'kept';
        const after = document.createElement('span');
        host.append(before, input, after);
        document.body.append(host);
        const listener = jest.fn();
        input.addEventListener('input', listener);
        const entry = createSearchEntry({ input, ...options });
        entries.push(entry);
        return { host, before, after, input, entry, listener };
    }

    test('keeps the node, its id and its value, and takes its place', () => {
        const { host, before, after, input, entry } = adopt();
        expect(entry.input).toBe(input);
        expect(input.id).toBe('existing-search');
        expect(input.value).toBe('kept');
        expect([...host.children]).toEqual([before, entry.element, after]);
        expect(input.parentElement).toBe(entry.element);
        expect(document.getElementById('existing-search')).toBe(input);
    });

    test('keeps the listeners that were bound before adoption', () => {
        const { input, listener } = adopt();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('the clear button reaches listeners bound before adoption', () => {
        const { entry, listener } = adopt();
        entry.clearButton.click();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(entry.input.value).toBe('');
    });

    test('an adopted input without an entry in the document still gets wrapped', () => {
        const input = document.createElement('input');
        const entry = createSearchEntry({ input });
        entries.push(entry);
        expect(entry.element.contains(input)).toBe(true);
        expect(entry.element.parentElement).toBeNull();
    });
});

describe('accessible name', () => {
    test('label becomes aria-label', () => {
        expect(make({ label: 'Search settings' }).input.getAttribute('aria-label')).toBe('Search settings');
    });

    test('label replaces an existing aria-label on an adopted input', () => {
        const input = document.createElement('input');
        input.setAttribute('aria-label', 'Old');
        document.body.append(input);
        expect(make({ input, label: 'New' }).input.getAttribute('aria-label')).toBe('New');
    });

    test('an adopted input keeps its aria-label when no label is passed', () => {
        const input = document.createElement('input');
        input.setAttribute('aria-label', 'Search settings');
        document.body.append(input);
        expect(make({ input, placeholder: 'Search...' }).input.getAttribute('aria-label')).toBe('Search settings');
    });

    test('an adopted input named by a label element is left alone', () => {
        const label = document.createElement('label');
        label.htmlFor = 'named';
        label.textContent = 'Find';
        const input = document.createElement('input');
        input.id = 'named';
        document.body.append(label, input);
        expect(make({ input, placeholder: 'Search...' }).input.hasAttribute('aria-label')).toBe(false);
    });

    test('without any name the placeholder names the input', () => {
        expect(make({ placeholder: 'Search...' }).input.getAttribute('aria-label')).toBe('Search...');
    });
});

describe('pointer', () => {
    test('a press on the icon focuses the input instead of the page', () => {
        const entry = make();
        const event = new Event('pointerdown', { bubbles: true, cancelable: true });
        entry.element.firstElementChild.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(entry.input);
    });

    test('a press on the clear button is left to the button', () => {
        const entry = make();
        const event = new Event('pointerdown', { bubbles: true, cancelable: true });
        entry.clearButton.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    });
});
