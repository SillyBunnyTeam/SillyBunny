/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(),
    animateOut: jest.fn((_element, _frames, hide) => hide()),
    play: jest.fn(),
    stopMotion: jest.fn(),
    MOTION_FAST: 200,
    MOTION_POPOVER_CLOSE: 150,
    MOTION_EASE_OUT_CUBIC: 'cubic-bezier(0.33, 1, 0.68, 1)',
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '(max-width: 768px)',
    positionPopover: jest.fn(() => '0px 0'),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: jest.fn(),
    createSheetController: jest.fn(),
}));

const { createSelectRow, createProfileRow } = await import('../../public/scripts/sillybunny-editor/select-row.js');
const { closePicker } = await import('../../public/scripts/sillybunny-editor/picker.js');

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const jquerySource = readFileSync(new URL('../../public/lib/jquery-3.5.1.min.js', import.meta.url), 'utf8');

/** Loads the app's real jQuery: its trigger('change') reaches only jQuery-bound handlers. */
function loadJQuery() {
    new Function(jquerySource).call(window);
    expect(typeof globalThis.jQuery).toBe('function');
}

beforeEach(() => {
    closePicker({ animate: false });
    document.body.replaceChildren();
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: jest.fn(() => ({ matches: false })) });
    delete globalThis.jQuery;
});

afterEach(() => {
    closePicker({ animate: false });
    delete globalThis.jQuery;
    delete globalThis.$;
    document.body.replaceChildren();
});

function makeSelect({ multiple = false } = {}) {
    const select = document.createElement('select');
    select.id = 'model_fixture_select';
    select.multiple = multiple;
    select.innerHTML = `
        <option value="">Select a model</option>
        <optgroup label="OpenAI">
            <option value="gpt">GPT-4o</option>
            <option value="mini" disabled>GPT-4o mini</option>
        </optgroup>
        <optgroup label="Anthropic">
            <option value="claude">Claude Sonnet</option>
        </optgroup>`;
    const parent = document.createElement('div');
    parent.append(select);
    document.body.append(parent);
    return select;
}

function mount(options) {
    const result = createSelectRow({ label: 'Model', field: 'model', ...options });
    document.body.append(result.row);
    return result;
}

const pickerOptions = () => [...document.querySelectorAll('.sb-picker__list [role="option"]')];

describe('createSelectRow', () => {
    test('profile rows omit the menu unless onMenu is supplied', () => {
        const withoutMenu = createProfileRow({ select: makeSelect(), label: 'Profile', field: 'profile' });
        expect(withoutMenu.menuButton).toBeNull();
        expect(withoutMenu.row.querySelector('.ds-select-row__menu')).toBeNull();
        const onMenu = jest.fn();
        const withMenu = createProfileRow({ select: makeSelect(), label: 'Profile', field: 'other-profile', menuLabel: 'Profile Menu', onMenu });
        withMenu.menuButton.click();
        expect(onMenu).toHaveBeenCalledWith(withMenu.menuButton);
        withoutMenu.destroy();
        withMenu.destroy();
    });
    test('ordered multiple choices keep routing priority in pick order, including after deselection', () => {
        const select = makeSelect({ multiple: true });
        const { trigger } = mount({ select, ordered: true });
        trigger.click();
        const choose = label => pickerOptions().find(option => option.textContent === label).click();
        choose('Claude Sonnet');
        choose('GPT-4o');
        expect([...select.selectedOptions].map(option => option.value)).toEqual(['claude', 'gpt']);
        choose('Claude Sonnet');
        choose('Claude Sonnet');
        expect([...select.selectedOptions].map(option => option.value)).toEqual(['gpt', 'claude']);
    });

    test('carries the real select2 container immediately after its adopted select', () => {
        loadJQuery();
        const source = readFileSync(new URL('../../public/lib/select2.min.js', import.meta.url), 'utf8');
        new Function(source).call(window);
        const select = makeSelect();
        globalThis.jQuery(select).select2();
        const container = globalThis.jQuery(select).data('select2').$container[0];
        const { row } = mount({ select });
        expect(row.contains(container)).toBe(true);
        expect(select.nextElementSibling).toBe(container);
        globalThis.jQuery(select).select2('destroy');
    });

    test('adopts the native select without cloning, keeps its id and listeners, and hides it from layout and focus', () => {
        const select = makeSelect();
        const listener = jest.fn();
        select.addEventListener('change', listener);
        const { row, control } = mount({ select });
        expect(control).toBe(select);
        expect(row.contains(select)).toBe(true);
        expect(select.id).toBe('model_fixture_select');
        expect(select.classList.contains('ds-select-row__native')).toBe(true);
        expect(select.tabIndex).toBe(-1);
        expect(select.getAttribute('aria-hidden')).toBe('true');
        select.dispatchEvent(new Event('change'));
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('the trigger shows the selected option and is named by the row title and value', () => {
        const select = makeSelect();
        select.value = 'claude';
        const { row, trigger } = mount({ select });
        expect(trigger.tagName).toBe('BUTTON');
        expect(trigger.type).toBe('button');
        expect(trigger.textContent).toContain('Claude Sonnet');
        const names = trigger.getAttribute('aria-labelledby').split(/\s+/).map(id => document.getElementById(id).textContent);
        expect(names[0]).toBe('Model');
        expect(names[1]).toContain('Claude Sonnet');
        expect(row.querySelector('.ds-row-label').textContent).toBe('Model');
    });

    test('opens a picker that mirrors options, optgroups, disabled state and selection', () => {
        const select = makeSelect();
        select.value = 'gpt';
        const { trigger } = mount({ select });
        trigger.click();
        const options = pickerOptions();
        expect(options.map(option => option.textContent)).toEqual(['Select a model', 'GPT-4o', 'GPT-4o mini', 'Claude Sonnet']);
        expect(options[2].getAttribute('aria-disabled')).toBe('true');
        expect(options[1].getAttribute('aria-selected')).toBe('true');
        const headings = [...document.querySelectorAll('.sb-picker__group-heading')].map(node => node.textContent);
        expect(headings).toEqual(['OpenAI', 'Anthropic']);
    });

    test('choosing writes back to the select and dispatches one bubbling change', () => {
        const select = makeSelect();
        const onChange = jest.fn();
        const parentListener = jest.fn();
        select.parentElement.addEventListener('change', parentListener);
        const { trigger } = mount({ select, onChange });
        const listener = jest.fn();
        select.addEventListener('change', listener);
        trigger.click();
        pickerOptions().find(option => option.textContent === 'Claude Sonnet').click();
        expect(select.value).toBe('claude');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('claude');
        expect(trigger.textContent).toContain('Claude Sonnet');
    });

    test('with real jQuery, a write-back reaches jQuery and native handlers once each', () => {
        loadJQuery();
        const select = makeSelect();
        const { trigger } = mount({ select });
        const jqueryHandler = jest.fn();
        const nativeHandler = jest.fn();
        globalThis.jQuery(select).on('change', jqueryHandler);
        select.addEventListener('change', nativeHandler);
        trigger.click();
        pickerOptions().find(option => option.textContent === 'GPT-4o').click();
        expect(select.value).toBe('gpt');
        expect(jqueryHandler).toHaveBeenCalledTimes(1);
        expect(nativeHandler).toHaveBeenCalledTimes(1);
    });

    test('with real jQuery, a change triggered through jQuery (profiles, upstream code) updates the row', () => {
        loadJQuery();
        const select = makeSelect();
        const onChange = jest.fn();
        const { trigger } = mount({ select, onChange });
        globalThis.jQuery(select).val('claude').trigger('change');
        expect(trigger.textContent).toContain('Claude Sonnet');
        expect(onChange).toHaveBeenCalledWith('claude');
    });

    test('with real jQuery, destroy unbinds its jQuery listener', () => {
        loadJQuery();
        const select = makeSelect();
        const result = mount({ select });
        result.destroy();
        globalThis.jQuery(select).val('claude').trigger('change');
        expect(result.trigger.textContent).not.toContain('Claude Sonnet');
    });

    test('follows late option loads, attribute changes and external changes', async () => {
        const select = makeSelect();
        const { trigger, sync } = mount({ select });
        trigger.click();
        const late = document.createElement('option');
        late.value = 'late';
        late.textContent = 'Late Model';
        select.querySelector('optgroup[label="Anthropic"]').append(late);
        await flush();
        expect(pickerOptions().map(option => option.textContent)).toContain('Late Model');
        select.querySelector('option[value="mini"]').disabled = false;
        await flush();
        expect(pickerOptions().find(option => option.textContent === 'GPT-4o mini').hasAttribute('aria-disabled')).toBe(false);
        closePicker({ animate: false });
        select.value = 'late';
        select.dispatchEvent(new Event('change'));
        expect(trigger.textContent).toContain('Late Model');
        select.value = 'gpt';
        sync();
        expect(trigger.textContent).toContain('GPT-4o');
    });

    test('onPick reports only choices made in the picker, never external changes', () => {
        const select = makeSelect();
        const onPick = jest.fn();
        const { trigger } = mount({ select, onPick });
        select.value = 'claude';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(onPick).not.toHaveBeenCalled();
        trigger.click();
        pickerOptions().find(option => option.textContent === 'GPT-4o').click();
        expect(onPick).toHaveBeenCalledTimes(1);
        expect(onPick).toHaveBeenCalledWith('gpt');
    });

    test('a disabled select makes the trigger insensitive', async () => {
        const select = makeSelect();
        const { trigger } = mount({ select });
        select.disabled = true;
        await flush();
        expect(trigger.disabled).toBe(true);
        select.disabled = false;
        await flush();
        expect(trigger.disabled).toBe(false);
    });

    test('ArrowDown and ArrowUp on the trigger open the picker; clicking the row background opens it too', () => {
        const select = makeSelect();
        const { row, trigger } = mount({ select });
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        closePicker({ animate: false });
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        closePicker({ animate: false });
        row.querySelector('.ds-row-label').click();
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
    });

    test('a second press on the row background closes the picker instead of reopening it', () => {
        const select = makeSelect();
        const { row, trigger } = mount({ select });
        const press = target => {
            target.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
            target.click();
        };
        const label = row.querySelector('.ds-row-label');
        press(label);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        press(label);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        press(label);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        press(document.body);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    test('a press on another control inside the row, such as the profile menu, still dismisses the picker', () => {
        const select = makeSelect();
        const onMenu = jest.fn();
        const result = createProfileRow({ select, label: 'Profile', field: 'profile', menuLabel: 'Profile Menu', onMenu });
        document.body.append(result.row);
        result.trigger.click();
        expect(result.trigger.getAttribute('aria-expanded')).toBe('true');
        result.menuButton.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
        result.menuButton.click();
        expect(result.trigger.getAttribute('aria-expanded')).toBe('false');
        expect(onMenu).toHaveBeenCalledTimes(1);
        result.destroy();
    });

    test('multiple selects toggle options without closing and summarise the selection', () => {
        const select = makeSelect({ multiple: true });
        const onChange = jest.fn();
        const { trigger } = mount({ select, onChange, noneLabel: 'None' });
        expect(trigger.textContent).toContain('None');
        trigger.click();
        pickerOptions().find(option => option.textContent === 'GPT-4o').click();
        pickerOptions().find(option => option.textContent === 'Claude Sonnet').click();
        expect(select.querySelector('option[value="gpt"]').selected).toBe(true);
        expect(select.querySelector('option[value="claude"]').selected).toBe(true);
        expect(onChange).toHaveBeenLastCalledWith(['gpt', 'claude']);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(trigger.textContent).toContain('GPT-4o, Claude Sonnet');
    });

    test('destroy stops observing and closes its own picker', async () => {
        const select = makeSelect();
        const result = mount({ select });
        result.trigger.click();
        result.destroy();
        expect(document.querySelector('.sb-picker')).toBeNull();
        select.value = 'claude';
        select.dispatchEvent(new Event('change'));
        expect(result.trigger.textContent).not.toContain('Claude Sonnet');
    });

    test('rejects anything other than a select', () => {
        expect(() => createSelectRow({ label: 'Model', field: 'model', select: document.createElement('input') })).toThrow(TypeError);
    });
});

describe('createProfileRow', () => {
    function makeProfiles() {
        const select = document.createElement('select');
        select.id = 'connection_profiles';
        select.innerHTML = `
            <option value="">&lt;None&gt;</option>
            <optgroup label="★ Favorites"><option value="p1">★ Work</option></optgroup>
            <optgroup label="📁 Local"><option value="p2">KoboldCpp</option></optgroup>`;
        document.body.append(select);
        return select;
    }

    test('adds a menu button that names its menu and reports the trigger', () => {
        const onMenu = jest.fn();
        const result = createProfileRow({ label: 'Connection Profile', field: 'profile', select: makeProfiles(), menuLabel: 'Profile Menu', onMenu });
        document.body.append(result.row);
        const menu = result.menuButton;
        expect(menu.type).toBe('button');
        expect(menu.getAttribute('aria-haspopup')).toBe('menu');
        expect(menu.getAttribute('aria-label')).toBe('Profile Menu');
        expect(menu.title).toBe('Profile Menu');
        expect(menu.querySelector('i.fa-ellipsis-vertical')).not.toBeNull();
        menu.click();
        expect(onMenu).toHaveBeenCalledWith(menu);
        expect(result.trigger.getAttribute('aria-expanded')).not.toBe('true');
    });

    test('keeps favourites and folders as headings from the native optgroups', () => {
        const result = createProfileRow({ label: 'Connection Profile', field: 'profile', select: makeProfiles(), menuLabel: 'Profile Menu', onMenu: jest.fn() });
        document.body.append(result.row);
        result.trigger.click();
        expect([...document.querySelectorAll('.sb-picker__group-heading')].map(node => node.textContent)).toEqual(['★ Favorites', '📁 Local']);
    });

    test('extra suffix nodes sit before the menu button, within the two-control row', () => {
        const spinner = document.createElement('i');
        spinner.id = 'connection_profile_spinner';
        const result = createProfileRow({ label: 'Connection Profile', field: 'profile', select: makeProfiles(), menuLabel: 'Profile Menu', onMenu: jest.fn(), suffix: spinner });
        const suffix = result.row.querySelector('.ds-row-suffix');
        expect([...suffix.children].indexOf(spinner)).toBeLessThan([...suffix.children].indexOf(result.menuButton));
        expect(suffix.querySelectorAll('button')).toHaveLength(2);
    });
});
