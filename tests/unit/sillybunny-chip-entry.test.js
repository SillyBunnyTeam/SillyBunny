/** @jest-environment jsdom */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));

const { createChipEntry } = await import('../../public/scripts/sillybunny-editor/chip-entry.js');

beforeEach(() => {
    document.body.replaceChildren();
});

function makeEntry(options = {}) {
    const entry = createChipEntry({ label: 'Keywords', field: 'keys', ...options });
    document.body.append(entry.element);
    return entry;
}

function keydown(target, key, options = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
}

function paste(input, text) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    input.dispatchEvent(event);
}

function splitRegexes(text) {
    const tokens = [];
    let start = 0;
    let insideRegex = false;
    for (let index = 0; index < text.length; index++) {
        if (text[index] === '/' && text[index - 1] !== '\\') insideRegex = !insideRegex;
        if (text[index] !== ',' || insideRegex) continue;
        tokens.push(text.slice(start, index).trim());
        start = index + 1;
    }
    tokens.push(text.slice(start).trim());
    return tokens.filter(Boolean);
}

describe('createChipEntry', () => {
    test('commits on Enter, a complete comma, blur, and paste', () => {
        const entry = makeEntry();
        entry.input.value = 'alpha';
        keydown(entry.input, 'Enter');
        entry.input.value = 'beta,';
        entry.input.dispatchEvent(new Event('input', { bubbles: true }));
        entry.input.value = 'gamma';
        entry.input.dispatchEvent(new Event('blur'));
        paste(entry.input, 'delta,epsilon');

        expect(entry.getValues()).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
    });

    test('delegates splitting so a comma inside a regex remains one chip', () => {
        const entry = makeEntry({ split: splitRegexes });
        entry.input.value = '/a,b/i,keyword';

        expect(entry.commitPending()).toEqual(['/a,b/i', 'keyword']);
        expect(entry.element.querySelector('.sb-chip').textContent).toContain('/a,b/i');
    });

    test('normalizes values, skips empty values, and drops duplicates', () => {
        const entry = makeEntry({ values: [' first ', '', 'first'] });
        entry.input.value = ' second , , first ';
        entry.commitPending();

        expect(entry.getValues()).toEqual(['first', 'second']);
    });

    test('Backspace on an empty input removes the last chip and emits a copy', () => {
        const onChange = jest.fn();
        const entry = makeEntry({ values: ['one', 'two'], onChange });
        entry.input.focus();
        keydown(entry.input, 'Backspace');

        expect(entry.getValues()).toEqual(['one']);
        expect(onChange).toHaveBeenCalledWith(['one']);
        expect(onChange.mock.lastCall[0]).not.toBe(entry.getValues());
    });

    test('navigates remove buttons with arrows and deletes the focused chip', () => {
        const entry = makeEntry({ values: ['one', 'two', 'three'] });
        const buttons = () => [...entry.element.querySelectorAll('.sb-chip__remove')];
        entry.input.focus();
        entry.input.setSelectionRange(0, 0);
        keydown(entry.input, 'ArrowLeft');
        expect(document.activeElement).toBe(buttons()[2]);

        keydown(buttons()[2], 'ArrowLeft');
        expect(document.activeElement).toBe(buttons()[1]);
        keydown(buttons()[1], 'ArrowRight');
        expect(document.activeElement).toBe(buttons()[2]);
        keydown(buttons()[2], 'Delete');
        expect(entry.getValues()).toEqual(['one', 'two']);
        expect(document.activeElement).toBe(buttons()[1]);
        keydown(document.activeElement, 'Backspace');
        expect(entry.getValues()).toEqual(['one']);
        expect(document.activeElement).toBe(buttons()[0]);
    });

    test('refreshes suggestions and commits an exact datalist suggestion', () => {
        const suggestions = jest.fn(() => ['Alpha', 'Beta']);
        const entry = makeEntry({ suggestions });
        entry.input.dispatchEvent(new Event('focus'));
        const datalist = entry.element.querySelector('datalist');
        expect(suggestions).toHaveBeenCalled();
        expect(datalist.options).toHaveLength(2);
        expect(entry.input.list).toBe(datalist);

        entry.input.value = 'Alpha';
        entry.input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(entry.getValues()).toEqual(['Alpha']);
        expect(entry.input.value).toBe('');
    });

    test('commitPending preserves pending input semantics and setValues is silent by default', () => {
        const onChange = jest.fn();
        const entry = makeEntry({ onChange });
        entry.input.value = 'typed';
        expect(entry.getPending()).toBe('typed');
        expect(entry.commitPending()).toEqual(['typed']);
        expect(entry.getPending()).toBe('');
        expect(onChange).toHaveBeenCalledTimes(1);

        entry.setValues(['next']);
        expect(entry.getValues()).toEqual(['next']);
        expect(onChange).toHaveBeenCalledTimes(1);
        entry.setValues(['final'], { silent: false });
        expect(onChange).toHaveBeenLastCalledWith(['final']);
    });

    test('enforces maxChips and disabled state', () => {
        const entry = makeEntry({ maxChips: 2 });
        entry.input.value = 'one,two,three';
        entry.commitPending();
        expect(entry.getValues()).toEqual(['one', 'two']);
        expect(entry.getPending()).toBe('three');

        entry.setDisabled(true);
        keydown(entry.input, 'Enter');
        expect(entry.input.disabled).toBe(true);
        expect(entry.getValues()).toEqual(['one', 'two']);
        expect([...entry.element.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
    });

    test('renders accessible markup and treats chip values only as text', () => {
        const entry = makeEntry({
            values: ['<img src=x>', '/a,b/i'],
            placeholder: 'Keywords',
            chipClass: value => value.startsWith('/') ? 'sb-chip--regex' : '',
            chipLabel: value => `key: ${value}`,
            removeLabel: value => `Delete ${value}`,
        });

        expect(entry.element.dataset.sbEditorField).toBe('keys');
        expect(entry.element.querySelector('ul[role="list"][aria-label="Keywords"]')).not.toBeNull();
        expect(entry.element.querySelector('input[aria-label="Keywords"]')).toBe(entry.input);
        expect(entry.input.placeholder).toBe('Keywords');
        expect(entry.element.querySelectorAll('.sb-chip')).toHaveLength(2);
        expect(entry.element.querySelector('.sb-chip--regex .sb-chip__label').textContent).toBe('key: /a,b/i');
        expect(entry.element.querySelector('button[aria-label="Delete <img src=x>"]')).not.toBeNull();
        expect(entry.element.querySelector('img')).toBeNull();
        expect(entry.element.querySelectorAll('button[type="button"] i[aria-hidden="true"]')).toHaveLength(2);
        expect(entry.element.lastElementChild).toBe(entry.input);
    });

    test('commits a typed comma while preserving a trailing incomplete fragment', () => {
        const entry = makeEntry();
        entry.input.value = 'one';
        entry.input.setSelectionRange(3, 3);
        const comma = keydown(entry.input, ',');
        expect(comma.defaultPrevented).toBe(true);
        expect(entry.getValues()).toEqual(['one']);
        expect(entry.getPending()).toBe('');

        entry.input.value = 'two,th';
        entry.input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(entry.getValues()).toEqual(['one', 'two']);
        expect(entry.getPending()).toBe('th');
    });

    test('keeps a typed comma inside an unfinished regex until the splitter recognizes a delimiter', () => {
        const split = jest.fn(splitRegexes);
        const entry = makeEntry({ split });
        entry.input.value = '/a';
        entry.input.setSelectionRange(2, 2);
        keydown(entry.input, ',');

        expect(split).toHaveBeenLastCalledWith('/a,');
        expect(entry.getValues()).toEqual([]);
        expect(entry.getPending()).toBe('/a,');
        expect(entry.input.selectionStart).toBe(3);

        entry.input.value = '/a,b/i';
        entry.input.setSelectionRange(6, 6);
        keydown(entry.input, ',');
        expect(entry.getValues()).toEqual(['/a,b/i']);
        expect(entry.getPending()).toBe('');
    });

    test('pastes at the current selection without losing surrounding text', () => {
        const entry = makeEntry();
        entry.input.value = 'before REPLACE after';
        entry.input.setSelectionRange(7, 14);

        paste(entry.input, 'one,two');

        expect(entry.getValues()).toEqual(['before one', 'two after']);
    });

    test('allows duplicates explicitly and normalizes before comparing values', () => {
        const normalize = value => value.trim().toLowerCase();
        const unique = makeEntry({ normalize, values: [' Alpha ', 'ALPHA', ' '] });
        expect(unique.getValues()).toEqual(['alpha']);
        const repeated = makeEntry({ normalize, allowDuplicates: true, values: [' Alpha ', 'ALPHA', ' '] });
        repeated.input.value = 'alpha';
        repeated.commitPending();
        expect(repeated.getValues()).toEqual(['alpha', 'alpha', 'alpha']);
    });

    test('notifies for each actual add or removal without exposing the internal array', () => {
        const onChange = jest.fn();
        const entry = makeEntry({ onChange });
        entry.input.value = 'one,two,one,,';
        entry.commitPending();
        expect(onChange.mock.calls).toEqual([[['one']], [['one', 'two']]]);
        onChange.mock.calls[0][0].push('outside');
        const snapshot = entry.getValues();
        snapshot.push('also outside');
        expect(entry.getValues()).toEqual(['one', 'two']);

        entry.element.querySelector('.sb-chip__remove').click();
        expect(entry.getValues()).toEqual(['two']);
        expect(onChange).toHaveBeenLastCalledWith(['two']);
        expect(entry.element.querySelector('[aria-live]')).toBeNull();
    });

    test('clears nonempty pending text on Escape but leaves empty Escape for the enclosing editor', () => {
        const entry = makeEntry();
        const outerKeydown = jest.fn();
        entry.element.addEventListener('keydown', outerKeydown);
        entry.input.value = 'pending';
        const clear = keydown(entry.input, 'Escape');
        expect(entry.getPending()).toBe('');
        expect(clear.defaultPrevented).toBe(true);
        expect(outerKeydown).not.toHaveBeenCalled();

        const escape = keydown(entry.input, 'Escape');
        expect(escape.defaultPrevented).toBe(false);
        expect(outerKeydown).toHaveBeenCalledWith(escape);
    });

    test('does not intercept editing away from the input start or composition events', () => {
        const entry = makeEntry({ values: ['one'] });
        entry.input.value = 'abc';
        entry.input.focus();
        entry.input.setSelectionRange(1, 1);
        expect(keydown(entry.input, 'ArrowLeft').defaultPrevented).toBe(false);
        expect(keydown(entry.input, 'Backspace').defaultPrevented).toBe(false);
        expect(keydown(entry.input, 'Enter', { isComposing: true }).defaultPrevented).toBe(false);
        expect(entry.getValues()).toEqual(['one']);
    });

    test('moves right from the final remove button to the input and returns to it after the final deletion', () => {
        const entry = makeEntry({ values: ['one'] });
        const button = entry.element.querySelector('button');
        button.focus();
        keydown(button, 'ArrowRight');
        expect(document.activeElement).toBe(entry.input);
        button.focus();
        keydown(button, 'Delete');
        expect(entry.getValues()).toEqual([]);
        expect(document.activeElement).toBe(entry.input);
    });

    test('focuses the adjacent surviving button after deleting a middle chip', () => {
        const entry = makeEntry({ values: ['one', 'two', 'three'] });
        const buttons = [...entry.element.querySelectorAll('button')];
        buttons[1].focus();
        keydown(buttons[1], 'Delete');
        expect(document.activeElement).toBe(buttons[2]);
        expect(entry.getValues()).toEqual(['one', 'three']);
    });

    test('refreshes changing suggestions on focus and commits comma-bearing suggestions atomically', () => {
        const suggestions = jest.fn().mockReturnValueOnce(['old']).mockReturnValue(['/a,b/i']);
        const entry = makeEntry({ suggestions });
        entry.input.focus();
        entry.input.blur();
        entry.input.focus();
        expect([...entry.input.list.options].map(option => option.value)).toEqual(['/a,b/i']);
        entry.input.value = '/a,b/i';
        entry.input.dispatchEvent(new Event('input'));
        expect(entry.getValues()).toEqual(['/a,b/i']);
    });

    test('focuses on empty container clicks and via the public focus method', () => {
        const entry = makeEntry();
        entry.element.click();
        expect(document.activeElement).toBe(entry.input);
        entry.input.blur();
        entry.focus();
        expect(document.activeElement).toBe(entry.input);
    });

    test('prevents all user mutation while disabled and re-enables new chip buttons', () => {
        const onChange = jest.fn();
        const entry = makeEntry({ values: ['one'], suggestions: () => ['two'], onChange });
        entry.setDisabled(true);
        entry.input.value = 'two';
        entry.input.dispatchEvent(new Event('blur'));
        entry.input.dispatchEvent(new Event('input'));
        entry.element.querySelector('button').click();
        keydown(entry.element.querySelector('button'), 'Delete');
        paste(entry.input, 'two,three');
        expect(entry.commitPending()).toEqual(['one']);
        expect(onChange).not.toHaveBeenCalled();
        entry.setValues(['next']);
        expect(entry.element.querySelector('button').disabled).toBe(true);

        entry.setDisabled(false);
        entry.input.value = 'two';
        entry.commitPending();
        expect(entry.getValues()).toEqual(['next', 'two']);
        expect(entry.input.disabled).toBe(false);
        expect([...entry.element.querySelectorAll('button')].every(button => !button.disabled)).toBe(true);
    });

    test('limits programmatic values and retains rejected pending text at a zero limit', () => {
        const entry = makeEntry({ maxChips: 1, values: ['one', 'two'] });
        entry.setValues(['three', 'four']);
        expect(entry.getValues()).toEqual(['three']);
        const empty = makeEntry({ maxChips: 0 });
        empty.input.value = 'pending';
        expect(empty.commitPending()).toEqual([]);
        expect(empty.getPending()).toBe('pending');
    });

    test('destroy removes all event handlers and the owned datalist', () => {
        const suggestions = jest.fn(() => ['next']);
        const entry = makeEntry({ values: ['one'], suggestions });
        entry.destroy();
        entry.destroy();
        entry.input.value = 'next';
        entry.input.dispatchEvent(new Event('focus'));
        entry.input.dispatchEvent(new Event('blur'));
        keydown(entry.input, 'Enter');
        keydown(entry.element.querySelector('button'), 'Delete');
        entry.element.querySelector('button').click();
        expect(entry.getValues()).toEqual(['one']);
        expect(entry.getPending()).toBe('next');
        expect(suggestions).not.toHaveBeenCalled();
        expect(entry.element.querySelector('datalist')).toBeNull();
        expect(entry.input.list).toBeNull();
    });
});

describe('chip entry review regressions', () => {
    test('typing past a suggestion prefix does not commit it', () => {
        const entry = makeEntry({ suggestions: () => ['cat', 'catfish'] });
        entry.input.dispatchEvent(new Event('focus'));
        for (const value of ['c', 'ca', 'cat', 'catf', 'catfish']) {
            entry.input.value = value;
            entry.input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: value.at(-1) }));
        }
        expect(entry.getValues()).toEqual([]);
        expect(entry.input.value).toBe('catfish');
    });

    test('a datalist pick (replacement text) commits the suggestion', () => {
        const entry = makeEntry({ suggestions: () => ['cat', 'catfish'] });
        entry.input.dispatchEvent(new Event('focus'));
        entry.input.value = 'catfish';
        entry.input.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText' }));
        expect(entry.getValues()).toEqual(['catfish']);
        expect(entry.input.value).toBe('');
    });
});
