/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));

await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(),
    animateOut: jest.fn((_element, _frames, hide) => hide()),
    play: jest.fn(),
    stopMotion: jest.fn(),
}));

const { createSelectionMode } = await import('../../public/scripts/sillybunny-editor/selection-mode.js');
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

function createRow(key) {
    const row = document.createElement('div');
    row.tabIndex = 0;
    row.dataset.sbListKey = key;
    const label = document.createElement('span');
    label.textContent = `Row ${key}`;
    row.append(label);
    return row;
}

function makeSelection(options = {}) {
    const root = document.createElement('section');
    const header = document.createElement('header');
    const list = document.createElement('div');
    list.tabIndex = 0;
    const rows = ['a', 'b', 'c'].map(createRow);
    list.append(...rows);
    const actionBar = document.createElement('div');
    root.append(header, list, actionBar);
    document.body.append(root);
    const onActivate = jest.fn();
    const onChange = jest.fn();
    const onExit = jest.fn();
    const selection = createSelectionMode({
        root,
        list,
        header,
        actionBar,
        actions: [{ id: 'remove', label: 'Remove', icon: 'fa-solid fa-trash', danger: true, onActivate }],
        onChange,
        onExit,
        ...options,
    });
    cleanups.push(() => selection.destroy());
    return { selection, root, list, header, actionBar, rows, onActivate, onChange, onExit };
}

function keydown(target, key, options = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
}

function pointer(target, type, options = {}) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [property, value] of Object.entries({ pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 10, ...options })) {
        Object.defineProperty(event, property, { value });
    }
    target.dispatchEvent(event);
    return event;
}

describe('selection mode', () => {
    test('starts inactive without filling the header or action bar', () => {
        const { selection, root, header, actionBar } = makeSelection();

        expect(selection.isActive).toBe(false);
        expect(selection.count).toBe(0);
        expect(selection.selectedKeys).toEqual([]);
        expect(root.dataset.selectionMode).toBe('false');
        expect(header.hidden).toBe(true);
        expect(actionBar.hidden).toBe(true);
        expect(header.children).toHaveLength(0);
        expect(actionBar.children).toHaveLength(0);
    });

    test('enter shows a Cancel header, live title, select-all toggle and action toolbar', () => {
        const { selection, root, header, actionBar } = makeSelection();

        selection.enter('a');

        expect(selection.isActive).toBe(true);
        expect(selection.selectedKeys).toEqual(['a']);
        expect(root.dataset.selectionMode).toBe('true');
        expect(header.hidden).toBe(false);
        expect(actionBar.hidden).toBe(false);
        expect(header.querySelector('.sb-selection-cancel').textContent).toBe('Cancel');
        expect(header.querySelector('.sb-selection-title').textContent).toBe('1 selected');
        expect(header.querySelector('.sb-selection-title').getAttribute('aria-live')).toBe('polite');
        expect(header.querySelector('.sb-selection-select-all').getAttribute('aria-pressed')).toBe('false');
        expect(actionBar.getAttribute('role')).toBe('toolbar');
        expect(actionBar.getAttribute('aria-label')).toBe('Selection actions');
        expect(actionBar.classList.contains('sb-selection-action-bar')).toBe(true);
        expect(document.activeElement).toBe(header.querySelector('.sb-selection-cancel'));
    });

    test('decoration is idempotent and selected rows expose a checked decorative prefix', () => {
        const { selection, rows } = makeSelection();
        selection.enter('b');
        selection.decorate();
        selection.decorate();

        expect(rows[0].querySelectorAll('.sb-selection-check')).toHaveLength(1);
        expect(rows[1].querySelectorAll('.sb-selection-check')).toHaveLength(1);
        const check = rows[1].firstElementChild;
        expect(check.type).toBe('checkbox');
        expect(check.tabIndex).toBe(-1);
        expect(check.hasAttribute('aria-hidden')).toBe(false);
        expect(check.checked).toBe(true);
        expect(rows[1].hasAttribute('aria-selected')).toBe(false);
        expect(rows[1].classList.contains('is-selection-selected')).toBe(true);
        expect(rows[0].firstElementChild.checked).toBe(false);
    });

    test('decoration moves an existing check back to the prefix rather than duplicating it', () => {
        const { selection, rows } = makeSelection();
        selection.enter('a');
        const check = rows[0].firstElementChild;
        rows[0].prepend(document.createElement('span'));

        selection.decorate();

        expect(rows[0].firstElementChild).toBe(check);
        expect(rows[0].querySelectorAll('.sb-selection-check')).toHaveLength(1);
        selection.exit();
        expect(rows[0].querySelector('.sb-selection-check')).toBeNull();
    });

    test('actions are disabled with zero selected and receive a copy of selected keys', () => {
        const { selection, actionBar, onActivate } = makeSelection();
        selection.enter();
        const button = actionBar.querySelector('.sb-selection-action');

        expect(button.disabled).toBe(true);
        expect(button.classList.contains('is-danger')).toBe(true);
        expect(button.dataset.actionId).toBe('remove');
        expect(button.querySelector('i').getAttribute('aria-hidden')).toBe('true');
        button.click();
        expect(onActivate).not.toHaveBeenCalled();
        selection.select(['a', 'b']);
        expect(button.disabled).toBe(false);
        button.click();

        expect(onActivate).toHaveBeenCalledWith(['a', 'b']);
        onActivate.mock.calls[0][0].push('untrusted mutation');
        expect(selection.selectedKeys).toEqual(['a', 'b']);
        selection.clear();
        expect(button.disabled).toBe(true);
    });

    test('clicking anywhere in a row toggles it and suppresses normal bubble handlers', () => {
        const { selection, list, rows } = makeSelection();
        const onOpen = jest.fn();
        list.addEventListener('click', onOpen);
        selection.enter();

        rows[0].querySelector('span').click();

        expect(selection.selectedKeys).toEqual(['a']);
        expect(onOpen).not.toHaveBeenCalled();
        rows[0].click();
        expect(selection.selectedKeys).toEqual([]);
        expect(onOpen).not.toHaveBeenCalled();
        selection.exit();
        rows[0].click();
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    test('clicking the decorative checkbox toggles the row exactly once', () => {
        const { selection, rows } = makeSelection();
        selection.enter();
        const check = rows[0].firstElementChild;

        check.click();

        expect(selection.selectedKeys).toEqual(['a']);
        expect(check.checked).toBe(true);
        check.click();
        expect(selection.selectedKeys).toEqual([]);
        expect(check.checked).toBe(false);
    });

    test.each([' ', 'Enter'])('%j on a focused row toggles and stops normal keyboard handlers', key => {
        const { selection, rows, list } = makeSelection();
        const onOpen = jest.fn();
        list.addEventListener('keydown', onOpen);
        selection.enter();
        rows[0].focus();

        const event = keydown(rows[0], key);

        expect(selection.selectedKeys).toEqual(['a']);
        expect(event.defaultPrevented).toBe(true);
        expect(onOpen).not.toHaveBeenCalled();
    });

    test('modified keys, composing keys and keys from nested inputs do not toggle rows', () => {
        const { selection, rows } = makeSelection();
        selection.enter();
        keydown(rows[0], 'Enter', { ctrlKey: true });
        keydown(rows[0], ' ', { isComposing: true });
        const input = document.createElement('input');
        rows[0].append(input);
        keydown(input, ' ');

        expect(selection.count).toBe(0);
    });

    test('secondary click enters selection mode with that row and prevents the native menu', () => {
        const { selection, rows } = makeSelection();
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

        rows[1].querySelector('span').dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(selection.isActive).toBe(true);
        expect(selection.selectedKeys).toEqual(['b']);
    });

    test('touch long press enters after 500 ms, vibrates and suppresses the following click', () => {
        jest.useFakeTimers();
        const vibrate = jest.fn();
        Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
        cleanups.push(() => { delete navigator.vibrate; });
        const { selection, rows, list } = makeSelection();
        const onOpen = jest.fn();
        list.addEventListener('click', onOpen);

        pointer(rows[1], 'pointerdown');
        jest.advanceTimersByTime(499);
        expect(selection.isActive).toBe(false);
        jest.advanceTimersByTime(1);
        expect(selection.selectedKeys).toEqual(['b']);
        expect(vibrate).toHaveBeenCalledWith(10);
        rows[1].click();
        expect(selection.selectedKeys).toEqual(['b']);
        expect(onOpen).not.toHaveBeenCalled();
        rows[1].click();
        expect(selection.selectedKeys).toEqual([]);
    });

    test('moving more than 8px cancels touch long press', () => {
        jest.useFakeTimers();
        const { selection, rows } = makeSelection();
        pointer(rows[0], 'pointerdown');
        pointer(window, 'pointermove', { clientX: 19 });

        jest.advanceTimersByTime(500);

        expect(selection.isActive).toBe(false);
    });

    test('moving 8px or less still permits a long press', () => {
        jest.useFakeTimers();
        const { selection, rows } = makeSelection();
        pointer(rows[0], 'pointerdown');
        pointer(window, 'pointermove', { clientX: 18 });

        jest.advanceTimersByTime(500);

        expect(selection.isActive).toBe(true);
    });

    test.each(['pointerup', 'pointercancel'])('%s cancels a pending long press', type => {
        jest.useFakeTimers();
        const { selection, rows } = makeSelection();
        pointer(rows[0], 'pointerdown');
        pointer(window, type);
        jest.advanceTimersByTime(500);

        expect(selection.isActive).toBe(false);
    });

    test('mouse pointerdown does not start a long press', () => {
        jest.useFakeTimers();
        const { selection, rows } = makeSelection();
        pointer(rows[0], 'pointerdown', { pointerType: 'mouse' });
        jest.advanceTimersByTime(500);

        expect(selection.isActive).toBe(false);
    });

    test('selectAll selects current list rows and the header toggle clears them', () => {
        const { selection, header, rows } = makeSelection();
        selection.enter();
        selection.selectAll();
        const button = header.querySelector('.sb-selection-select-all');

        expect(selection.selectedKeys).toEqual(['a', 'b', 'c']);
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(header.querySelector('.sb-selection-title').textContent).toBe('3 selected');
        button.click();
        expect(selection.count).toBe(0);
        expect(button.getAttribute('aria-pressed')).toBe('false');
        rows[2].remove();
        button.click();
        expect(selection.selectedKeys).toEqual(['a', 'b']);
    });

    test('select replaces the set, deduplicates keys and selectedKeys returns an array copy', () => {
        const { selection } = makeSelection();
        selection.enter('a');
        selection.select(['b', 'b', 'c']);

        expect(selection.selectedKeys).toEqual(['b', 'c']);
        expect(selection.count).toBe(2);
        const copy = selection.selectedKeys;
        copy.push('other');
        expect(selection.selectedKeys).toEqual(['b', 'c']);
    });

    test('decorate reapplies selection after row replacement without pruning filtered keys', () => {
        const { selection, list, onChange } = makeSelection();
        selection.enter('a');
        selection.toggle('b');
        const replacement = createRow('a');
        list.replaceChildren(replacement);
        onChange.mockClear();

        selection.decorate();

        expect(selection.selectedKeys).toEqual(['a', 'b']);
        expect(replacement.classList.contains('is-selection-selected')).toBe(true);
        expect(replacement.firstElementChild.checked).toBe(true);
        expect(onChange).not.toHaveBeenCalled();
    });

    test('decorate with prune drops absent keys, updates title and emits the resulting set', () => {
        const { selection, list, header, onChange } = makeSelection();
        selection.enter('a');
        selection.toggle('b');
        list.replaceChildren(createRow('a'));
        onChange.mockClear();

        selection.decorate({ prune: true });

        expect(selection.selectedKeys).toEqual(['a']);
        expect(header.querySelector('.sb-selection-title').textContent).toBe('1 selected');
        expect(onChange).toHaveBeenCalledWith(['a']);
    });

    test('Escape anywhere in root exits, consumes the event and restores focused row', () => {
        const { selection, rows, header, actionBar, root, onExit } = makeSelection();
        rows[1].focus();
        selection.enter('a');
        const cancel = header.querySelector('.sb-selection-cancel');
        cancel.focus();
        const listener = jest.fn();
        document.addEventListener('keydown', listener);
        cleanups.push(() => document.removeEventListener('keydown', listener));

        const event = keydown(cancel, 'Escape');

        expect(event.defaultPrevented).toBe(true);
        expect(listener).not.toHaveBeenCalled();
        expect(selection.isActive).toBe(false);
        expect(root.dataset.selectionMode).toBe('false');
        expect(header.hidden).toBe(true);
        expect(actionBar.hidden).toBe(true);
        expect(rows[0].querySelector('.sb-selection-check')).toBeNull();
        expect(rows[0].hasAttribute('aria-selected')).toBe(false);
        expect(rows[0].classList.contains('is-selection-selected')).toBe(false);
        expect(document.activeElement).toBe(rows[1]);
        expect(onExit).toHaveBeenCalledTimes(1);
    });

    test('exit focuses the list if the previously focused row was removed', () => {
        const { selection, rows, list } = makeSelection();
        rows[0].focus();
        selection.enter('a');
        rows[0].remove();

        selection.exit();

        expect(document.activeElement).toBe(list);
    });

    test('exit makes a non-tabbable list focusable only as a return target', () => {
        const { selection, list } = makeSelection();
        list.removeAttribute('tabindex');
        selection.enter();

        selection.exit();

        expect(document.activeElement).toBe(list);
        expect(list.tabIndex).toBe(-1);
    });

    test('Cancel exits once and clears selection', () => {
        const { selection, header, onExit, onChange } = makeSelection();
        selection.enter('a');

        header.querySelector('.sb-selection-cancel').click();
        selection.exit();

        expect(selection.selectedKeys).toEqual([]);
        expect(selection.isActive).toBe(false);
        expect(onExit).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith([]);
    });

    test('onChange is emitted for entry and changes, not repeated sets or decoration', () => {
        const { selection, onChange, onExit } = makeSelection();
        selection.enter();
        selection.enter('ignored');
        selection.toggle('a');
        selection.select(['a']);
        selection.select(['b']);
        selection.decorate();
        selection.clear();
        selection.clear();
        selection.exit();

        expect(onChange.mock.calls).toEqual([[[]], [['a']], [['b']], [[]]]);
        expect(onExit).toHaveBeenCalledTimes(1);
    });

    test('consumer title and custom row-key contracts are preserved', () => {
        const { selection, header, list } = makeSelection({
            rowSelector: '[data-custom-key]',
            getKey: row => row.dataset.customKey,
            title: count => `${count} books`,
        });
        const row = createRow('unused');
        row.dataset.customKey = 'custom';
        list.replaceChildren(row);

        selection.enter('custom');

        expect(header.querySelector('.sb-selection-title').textContent).toBe('1 books');
        expect(row.firstElementChild.checked).toBe(true);
        selection.selectAll();
        expect(selection.selectedKeys).toEqual(['custom']);
    });

    test('destroy removes interaction listeners, pending gestures and decorations', () => {
        jest.useFakeTimers();
        const { selection, root, list, rows, header, actionBar } = makeSelection();
        pointer(rows[0], 'pointerdown');
        selection.destroy();
        jest.advanceTimersByTime(500);
        expect(selection.isActive).toBe(false);
        const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        rows[0].dispatchEvent(context);
        expect(context.defaultPrevented).toBe(false);
        expect(selection.isActive).toBe(false);

        const onOpen = jest.fn();
        list.addEventListener('click', onOpen);
        rows[0].click();
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(keydown(root, 'Escape').defaultPrevented).toBe(false);
        expect(header.hidden).toBe(true);
        expect(actionBar.hidden).toBe(true);
        expect(list.querySelector('.sb-selection-check')).toBeNull();
    });

    test('destroy while active resets chrome without calling the consumer exit callback', () => {
        const { selection, root, header, actionBar, rows, onExit } = makeSelection();
        selection.enter('a');

        selection.destroy();

        expect(selection.isActive).toBe(false);
        expect(selection.count).toBe(0);
        expect(root.dataset.selectionMode).toBe('false');
        expect(header.hidden).toBe(true);
        expect(actionBar.hidden).toBe(true);
        expect(rows[0].querySelector('.sb-selection-check')).toBeNull();
        expect(rows[0].hasAttribute('aria-selected')).toBe(false);
        expect(onExit).not.toHaveBeenCalled();
    });
});

describe('selection mode consumer contracts', () => {
    test('canEnter gates programmatic entry and row gestures', () => {
        jest.useFakeTimers();
        const { selection, rows } = makeSelection({ canEnter: () => false });
        selection.enter('a');
        const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        rows[0].dispatchEvent(context);
        pointer(rows[0], 'pointerdown');
        jest.advanceTimersByTime(500);
        expect(selection.isActive).toBe(false);
        expect(context.defaultPrevented).toBe(false);
    });

    test('a supplied trigger receives focus back after Cancel', () => {
        const { selection, root, header } = makeSelection({ selectAllLabel: 'Select All' });
        const trigger = document.createElement('button');
        root.prepend(trigger);
        selection.enter(null, trigger);
        expect(header.querySelector('.sb-selection-select-all').textContent).toBe('Select All');
        header.querySelector('.sb-selection-cancel').click();
        expect(document.activeElement).toBe(trigger);
    });

    test.each(['ctrlKey', 'metaKey'])('%s+A adds current-page keys without losing other-page selection', modifier => {
        const { selection, header, list } = makeSelection();
        selection.enter('a');
        list.replaceChildren(createRow('d'), createRow('e'));
        selection.decorate();
        const event = keydown(header.querySelector('.sb-selection-cancel'), 'a', { [modifier]: true });
        expect(event.defaultPrevented).toBe(true);
        expect(selection.selectedKeys).toEqual(['a', 'd', 'e']);
    });

    test('the select-all toggle deselects only current-page keys', () => {
        const { selection, header, list } = makeSelection();
        selection.enter('a');
        list.replaceChildren(createRow('d'), createRow('e'));
        selection.selectAll();
        header.querySelector('.sb-selection-select-all').click();
        expect(selection.selectedKeys).toEqual(['a']);
    });

    test('Ctrl+A leaves text fields and the detail outside selection chrome alone', () => {
        const { selection, root, header } = makeSelection();
        const input = document.createElement('input');
        header.append(input);
        const detail = document.createElement('textarea');
        root.append(detail);
        selection.enter();
        header.append(input);
        expect(keydown(input, 'a', { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(keydown(detail, 'a', { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(selection.count).toBe(0);
    });
});

describe('selection mode review regressions', () => {
    test('checkboxes are labelled from the row so selection is announced', () => {
        const { selection, rows } = makeSelection();
        rows[0].setAttribute('aria-label', 'Dragon entry');
        selection.enter('a');
        expect(rows[0].querySelector('.sb-selection-check').getAttribute('aria-label')).toBe('Select Dragon entry');
    });

    test('Space on a keySourceSelector descendant toggles instead of reaching row handlers', () => {
        const { selection, rows, list } = makeSelection({ keySourceSelector: '.grip' });
        const grip = document.createElement('span');
        grip.className = 'grip';
        grip.tabIndex = 0;
        rows[1].append(grip);
        const open = jest.fn();
        list.addEventListener('keydown', open);
        selection.enter('a');
        const event = keydown(grip, ' ');
        expect(event.defaultPrevented).toBe(true);
        expect(open).not.toHaveBeenCalled();
        expect(selection.selectedKeys).toEqual(['a', 'b']);
    });
});

describe('selection mode ranges', () => {
    function click(row, shiftKey = false) {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
    }

    test.each([[0, 2], [2, 0]])('Shift-click selects from anchor %s to target %s inclusively', (anchor, target) => {
        const { selection, rows } = makeSelection({ range: true });
        selection.enter();
        click(rows[anchor]);
        click(rows[target], true);

        expect(new Set(selection.selectedKeys)).toEqual(new Set(['a', 'b', 'c']));
        expect(rows.every(row => row.firstElementChild.checked)).toBe(true);
    });

    test('enter(initialKey) sets an anchor and Shift-click keeps that anchor', () => {
        const { selection, rows } = makeSelection({ range: true });
        selection.enter('a');
        click(rows[2], true);
        selection.select(['a']);
        click(rows[1], true);

        expect(selection.selectedKeys).toEqual(['a', 'b']);
    });

    test('clear removes the anchor so Shift-click acts as an unanchored toggle', () => {
        const { selection, rows } = makeSelection({ range: true });
        selection.enter('a');
        selection.clear();
        click(rows[2], true);

        expect(selection.selectedKeys).toEqual(['c']);
    });

    test('clear resets the anchor even when the selection is already empty', () => {
        const { selection, rows } = makeSelection({ range: true });
        selection.enter('a');
        click(rows[0]);
        expect(selection.selectedKeys).toEqual([]);
        selection.clear();
        click(rows[2], true);

        expect(selection.selectedKeys).toEqual(['c']);
    });

    test('range selection survives full row replacement with the same keys', () => {
        const { selection, list } = makeSelection({ range: true });
        selection.enter('a');
        const replacements = ['a', 'b', 'c'].map(createRow);
        list.replaceChildren(...replacements);
        selection.decorate();
        click(replacements[2], true);

        expect(selection.selectedKeys).toEqual(['a', 'b', 'c']);
        expect(replacements.every(row => row.querySelector('.sb-selection-check').checked)).toBe(true);
    });

    test('Shift-click on the checkbox applies a range without undoing its checked state', () => {
        const { selection, rows } = makeSelection({ range: true });
        selection.enter('a');
        const check = rows[2].querySelector('.sb-selection-check');
        click(check, true);

        expect(selection.selectedKeys).toEqual(['a', 'b', 'c']);
        expect(check.checked).toBe(true);
        click(rows[0]);
        click(check, true);
        expect(selection.selectedKeys).toEqual([]);
        expect(check.checked).toBe(false);
    });

    test.each(['row', 'checkbox'])('long press suppresses the next %s click without changing the range anchor', target => {
        jest.useFakeTimers();
        const { selection, rows, list } = makeSelection({ range: true });
        const onOpen = jest.fn();
        list.addEventListener('click', onOpen);
        pointer(rows[1], 'pointerdown');
        jest.advanceTimersByTime(500);
        const check = rows[2].querySelector('.sb-selection-check');
        click(target === 'checkbox' ? check : rows[2], true);

        expect(selection.selectedKeys).toEqual(['b']);
        expect(check.checked).toBe(false);
        expect(onOpen).not.toHaveBeenCalled();
        click(rows[0], true);
        expect(new Set(selection.selectedKeys)).toEqual(new Set(['a', 'b']));
    });

    test('ranges follow current DOM order rather than key order', () => {
        const { selection, rows, list } = makeSelection({ range: true });
        list.replaceChildren(rows[0], rows[2], rows[1]);
        selection.enter('a');
        click(rows[2], true);

        expect(selection.selectedKeys).toEqual(['a', 'c']);
    });

    test.each([[0, 2], [2, 0]])('a deselected anchor %s deselects through target %s', (anchor, target) => {
        const { selection, rows } = makeSelection({ range: true });
        selection.enter();
        selection.selectAll();
        click(rows[anchor]);
        click(rows[target], true);

        expect(selection.selectedKeys).toEqual([]);
        expect(rows.every(row => !row.firstElementChild.checked)).toBe(true);
    });

    test.each([' ', 'Enter'])('Shift+%j applies the keyboard anchor state in both directions', key => {
        const { selection, rows } = makeSelection({ range: true });
        selection.enter();
        rows[2].focus();
        keydown(rows[2], key);
        rows[0].focus();
        const event = keydown(rows[0], key, { shiftKey: true });

        expect(event.defaultPrevented).toBe(true);
        expect(new Set(selection.selectedKeys)).toEqual(new Set(['a', 'b', 'c']));
        keydown(rows[0], key);
        keydown(rows[2], key, { shiftKey: true });
        expect(selection.selectedKeys).toEqual([]);
    });

    test('Shift-click without an anchor acts as a plain toggle and becomes the anchor', () => {
        const { selection, rows } = makeSelection({ range: true });
        selection.enter();
        click(rows[2], true);
        expect(selection.selectedKeys).toEqual(['c']);
        click(rows[0], true);
        expect(new Set(selection.selectedKeys)).toEqual(new Set(['a', 'b', 'c']));
    });

    test.each([' ', 'Enter'])('Shift+%j without an anchor acts as a plain toggle', key => {
        const { selection, rows } = makeSelection({ range: true });
        selection.enter();
        keydown(rows[1], key, { shiftKey: true });

        expect(selection.selectedKeys).toEqual(['b']);
    });

    test('a missing anchor falls back to a plain toggle and exiting clears the anchor', () => {
        const { selection, rows } = makeSelection({ range: true });
        selection.enter('a');
        rows[0].remove();
        click(rows[2], true);
        expect(selection.selectedKeys).toEqual(['a', 'c']);
        selection.exit();
        selection.enter();
        click(rows[1], true);
        expect(selection.selectedKeys).toEqual(['b']);
    });

    test.each([' ', 'Enter'])('range remains disabled by default for Shift+%j and Shift-click', key => {
        const { selection, rows } = makeSelection();
        selection.enter('a');
        const event = keydown(rows[2], key, { shiftKey: true });
        expect(event.defaultPrevented).toBe(false);
        expect(selection.selectedKeys).toEqual(['a']);
        click(rows[2], true);
        expect(selection.selectedKeys).toEqual(['a', 'c']);
    });
});

describe('selection mode all filtered keys', () => {
    test('selectAll includes off-page keys and the header toggle deselects all filtered keys', () => {
        const getAllKeys = jest.fn(() => new Set(['a', 'b', 'c', 'off-page']));
        const { selection, header } = makeSelection({ getAllKeys });
        selection.enter();
        selection.selectAll();
        const button = header.querySelector('.sb-selection-select-all');

        expect(selection.selectedKeys).toEqual(['a', 'b', 'c', 'off-page']);
        expect(button.getAttribute('aria-pressed')).toBe('true');
        button.click();
        expect(selection.selectedKeys).toEqual([]);
        expect(button.getAttribute('aria-pressed')).toBe('false');
        button.click();
        expect(selection.selectedKeys).toEqual(['a', 'b', 'c', 'off-page']);
        expect(button.getAttribute('aria-pressed')).toBe('true');
    });

    test('aria-pressed uses all filtered keys, not just rendered rows', () => {
        let keys = ['a', 'b', 'c', 'off-page'];
        const { selection, header } = makeSelection({ getAllKeys: () => keys });
        selection.enter();
        selection.select(['a', 'b', 'c']);
        const button = header.querySelector('.sb-selection-select-all');

        expect(button.getAttribute('aria-pressed')).toBe('false');
        selection.selectAll();
        expect(button.getAttribute('aria-pressed')).toBe('true');
        keys = [];
        selection.decorate();
        expect(button.getAttribute('aria-pressed')).toBe('false');
    });

    test('toggling all filtered keys preserves selections outside the filter', () => {
        const { selection, header } = makeSelection({ getAllKeys: () => ['a', 'off-page'] });
        selection.enter('outside-filter');
        selection.selectAll();
        header.querySelector('.sb-selection-select-all').click();

        expect(selection.selectedKeys).toEqual(['outside-filter']);
    });

    test('Ctrl+A uses getAllKeys without dropping existing selections', () => {
        const { selection, header } = makeSelection({ getAllKeys: () => ['a', 'off-page'] });
        selection.enter('outside-filter');
        const event = keydown(header.querySelector('.sb-selection-cancel'), 'a', { ctrlKey: true });

        expect(event.defaultPrevented).toBe(true);
        expect(selection.selectedKeys).toEqual(['outside-filter', 'a', 'off-page']);
        expect(header.querySelector('.sb-selection-select-all').getAttribute('aria-pressed')).toBe('true');
    });
});
