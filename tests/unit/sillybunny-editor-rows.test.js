/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom tests use parameterized synchronous DOM assertions. */
import { jest, describe, test, expect } from '@jest/globals';
import {
    createRow,
    createSwitchRow,
    createComboRow,
    createSpinRow,
    createEntryRow,
    createPropertyRow,
    createExpanderRow,
    createButtonRow,
    createPrefGroup,
} from '../../public/scripts/sillybunny-editor/rows.js';

function node(tag, text = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
}

function input(type, value) {
    const control = document.createElement('input');
    control.type = type;
    control.id = `existing-${type}`;
    control.name = 'preserved-name';
    if (value !== undefined) control.value = value;
    return control;
}

function change(control, value) {
    if (value !== undefined) control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
}

function assertAssociation({ row, control }, label) {
    const caption = row.matches('label') ? row : row.querySelector('label');
    expect(caption.htmlFor).toBe(control.id);
    expect(control.id).not.toBe('');
    expect(row.querySelector('.ds-row-label').textContent).toBe(label);
    const description = row.querySelector('small.ds-row-subtitle');
    expect(description.textContent).toBe('Helpful description');
    expect(control.getAttribute('aria-describedby').split(/\s+/)).toContain(description.id);
}

const controlFactories = [
    ['switch', createSwitchRow, true, false],
    ['combo', options => createComboRow({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], ...options }), 'a', 'b'],
    ['spin', createSpinRow, 3, 4],
    ['entry', createEntryRow, 'first', 'second'],
];

describe('shared row behavior', () => {
    test.each(controlFactories)('%s labels and descriptions are associated with the control', (_name, factory) => {
        const row = factory({ label: 'Translated label', subtitle: 'Helpful description', field: 'field-key' });
        expect(row.row.dataset.sbEditorField).toBe('field-key');
        expect(row.row.classList.contains('ds-row')).toBe(true);
        assertAssociation(row, 'Translated label');
    });

    test.each(controlFactories)('%s honors an explicit control id', (name, factory) => {
        const { control } = factory({ label: 'Title', field: 'field', id: `explicit-${name}` });
        expect(control.id).toBe(`explicit-${name}`);
    });

    test.each(controlFactories)('%s setters are silent by default and optionally notify once', (_name, factory, first, second) => {
        const onChange = jest.fn();
        const onInput = jest.fn();
        const row = factory({ label: 'Title', field: 'field', onChange, onInput });
        expect(onChange).not.toHaveBeenCalled();

        row.setValue(first);

        expect(row.getValue()).toBe(first);
        expect(onChange).not.toHaveBeenCalled();
        row.setValue(second, { silent: false });
        expect(row.getValue()).toBe(second);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith(second);
        expect(onInput).not.toHaveBeenCalled();
    });

    test.each(controlFactories)('%s disabling and visibility are reversible', (_name, factory) => {
        const row = factory({ label: 'Title', field: 'field' });

        row.setDisabled(true);
        row.setVisible(false);

        expect(row.control.disabled).toBe(true);
        expect(row.row.getAttribute('aria-disabled')).toBe('true');
        expect(row.row.classList.contains('is-insensitive')).toBe(true);
        expect(row.row.hidden).toBe(true);
        row.setDisabled(false);
        row.setVisible(true);
        expect(row.control.disabled).toBe(false);
        expect(row.row.getAttribute('aria-disabled')).toBe('false');
        expect(row.row.classList.contains('is-insensitive')).toBe(false);
        expect(row.row.hidden).toBe(false);
    });

    test('generated control and subtitle ids are unique and avoid attached elements', () => {
        const generated = [];
        for (let index = 0; index < 10; index++) {
            const { row, control } = createEntryRow({ label: 'Title', subtitle: 'Description', field: 'field' });
            generated.push(control.id, row.querySelector('small').id);
        }
        expect(new Set(generated).size).toBe(generated.length);
        expect(generated.every(id => /^sb-row-\d+$/.test(id))).toBe(true);

        const blocked = node('div');
        blocked.id = `sb-row-${Number(generated.at(-1).split('-').at(-1)) + 1}`;
        document.body.append(blocked);
        const next = createSwitchRow({ label: 'Title', field: 'field' });
        expect(next.control.id).not.toBe(blocked.id);
        blocked.remove();
    });

    test('untrusted labels and descriptions stay text', () => {
        const payload = '<img src=x onerror=alert(1)>';
        const { row } = createEntryRow({ label: payload, subtitle: payload, field: payload, value: payload });
        expect(row.querySelector('img')).toBeNull();
        expect(row.querySelector('label').textContent).toBe(payload);
        expect(row.querySelector('small').textContent).toBe(payload);
        expect(row.dataset.sbEditorField).toBe(payload);
    });

    test('generated descriptions do not collide with detached explicit or adopted ids', () => {
        const lastId = createEntryRow({ label: 'Title', field: 'field' }).control.id;
        const explicitId = `sb-row-${Number(lastId.split('-').at(-1)) + 1}`;
        const explicit = createEntryRow({ label: 'Title', field: 'field', id: explicitId, subtitle: 'Description' });
        expect(explicit.row.querySelector('small').id).not.toBe(explicitId);
        const adoptedId = `sb-row-${Number(explicit.row.querySelector('small').id.split('-').at(-1)) + 1}`;
        const adoptedInput = input('text');
        adoptedInput.id = adoptedId;
        const adopted = createEntryRow({ label: 'Title', field: 'field', input: adoptedInput, subtitle: 'Description' });
        expect(adopted.row.querySelector('small').id).not.toBe(adoptedId);
    });

    test.each([
        ['switch', createSwitchRow, 'text'],
        ['spin', createSpinRow, 'text'],
        ['entry', createEntryRow, 'number'],
    ])('%s rejects incompatible adopted input types', (_name, factory, type) => {
        expect(() => factory({ label: 'Title', field: 'field', input: input(type) })).toThrow(TypeError);
    });
});

describe('createRow', () => {
    test('builds a plain row with prefix, text and node-array suffix', () => {
        const prefix = node('i');
        const first = node('span', 'First suffix');
        const second = node('span', 'Second suffix');
        const { row } = createRow({ label: 'Title', subtitle: 'Description', field: 'plain', prefix, suffix: [first, second] });
        expect(row.tagName).toBe('DIV');
        expect(row.className).toBe('ds-row');
        expect(row.dataset.sbEditorField).toBe('plain');
        expect(row.firstChild).toBe(prefix);
        expect(row.querySelector('.ds-row-text').textContent).toBe('TitleDescription');
        expect([...row.querySelector('.ds-row-suffix').children]).toEqual([first, second]);
        expect(row.querySelector('.ds-row__chevron')).toBeNull();
    });

    test('accepts a single suffix and omits optional markup when absent', () => {
        const suffix = node('span');
        expect(createRow({ label: 'Title', field: 'a', suffix }).row.lastChild.firstChild).toBe(suffix);
        const { row } = createRow({ label: 'Title', field: 'b' });
        expect(row.children).toHaveLength(1);
        expect(row.querySelector('small')).toBeNull();
    });

    test('activatable rows are native buttons with a trailing chevron', () => {
        const onActivate = jest.fn();
        const result = createRow({ label: 'Open', subtitle: 'Description', field: 'open', activatable: true, onActivate });
        const { row } = result;
        expect(row.tagName).toBe('BUTTON');
        expect(row.type).toBe('button');
        expect(row.classList.contains('ds-row--activatable')).toBe(true);
        expect(row.lastChild.className).toBe('fa-solid fa-chevron-right ds-row__chevron');
        expect(row.lastChild.getAttribute('aria-hidden')).toBe('true');
        expect(row.getAttribute('aria-describedby')).toBe(row.querySelector('small').id);
        row.click();
        expect(onActivate).toHaveBeenCalledTimes(1);
        result.setDisabled(true);
        row.click();
        expect(onActivate).toHaveBeenCalledTimes(1);
        expect(row.disabled).toBe(true);
    });
});

describe('createSwitchRow', () => {
    test('uses the existing switch markup and notifies on change only', () => {
        const onChange = jest.fn();
        const { row, control } = createSwitchRow({ label: 'Enabled', field: 'enabled', checked: true, disabled: true, onChange });
        expect(row.tagName).toBe('LABEL');
        expect(row.className).toBe('ds-row ds-row-switch is-insensitive');
        expect(row.lastChild).toBe(control);
        expect(control.type).toBe('checkbox');
        expect(control.classList.contains('sb-switch')).toBe(true);
        expect(control.getAttribute('role')).toBe('switch');
        expect(control.getAttribute('aria-checked')).toBe('true');
        expect(control.checked).toBe(true);
        expect(control.disabled).toBe(true);
        control.disabled = false;
        control.checked = false;
        control.dispatchEvent(new Event('input'));
        expect(onChange).not.toHaveBeenCalled();
        change(control);
        expect(onChange).toHaveBeenCalledWith(false);
        expect(control.getAttribute('aria-checked')).toBe('false');
    });

    test('adoption moves the input without losing identity, state, descriptions or listeners', () => {
        const control = input('checkbox');
        control.checked = true;
        control.disabled = true;
        control.className = 'legacy';
        control.setAttribute('aria-describedby', 'existing-description');
        const existingChange = jest.fn();
        control.addEventListener('change', existingChange);
        const old = node('div');
        old.append(control);

        const result = createSwitchRow({ label: 'Enabled', subtitle: 'Helpful description', field: 'enabled', id: 'ignored', input: control });

        expect(result.control).toBe(control);
        expect(old.children).toHaveLength(0);
        expect(control.id).toBe('existing-checkbox');
        expect(control.name).toBe('preserved-name');
        expect(result.getValue()).toBe(true);
        expect(control.disabled).toBe(true);
        expect(control.classList.contains('legacy')).toBe(true);
        expect(control.getAttribute('aria-describedby').split(' ')).toContain('existing-description');
        assertAssociation(result, 'Enabled');
        change(control);
        expect(existingChange).toHaveBeenCalledTimes(1);
    });
});

describe('createComboRow', () => {
    test('builds options, a label and suffix, with optional flexible width', () => {
        const onChange = jest.fn();
        const { row, control } = createComboRow({
            label: 'Mode', field: 'mode', value: 'two', wide: true, onChange,
            options: [{ value: 'one', label: '<One>' }, { value: 'two', label: 'Two', disabled: true }],
        });
        expect(row.querySelector('.ds-row-suffix').firstChild).toBe(control);
        expect(control.classList.contains('ds-control-flex')).toBe(true);
        expect(control.options[0].textContent).toBe('<One>');
        expect(control.options[1].disabled).toBe(true);
        expect(control.value).toBe('two');
        control.value = 'one';
        control.dispatchEvent(new Event('input'));
        expect(onChange).not.toHaveBeenCalled();
        change(control);
        expect(onChange).toHaveBeenCalledWith('one');
        expect(createComboRow({ label: 'Mode', field: 'mode' }).control.classList.contains('ds-control-flex')).toBe(false);
    });

    test('adoption retains options, selected value, id, name and listeners', () => {
        const select = node('select');
        select.id = 'existing-select';
        select.name = 'preserved-select';
        const option = node('option', 'Existing option');
        option.value = 'existing';
        select.append(option);
        const listener = jest.fn();
        select.addEventListener('change', listener);
        const old = node('div');
        old.append(select);

        const result = createComboRow({ label: 'Mode', field: 'mode', select, id: 'ignored' });

        expect(result.control).toBe(select);
        expect(old.children).toHaveLength(0);
        expect(select.id).toBe('existing-select');
        expect(select.name).toBe('preserved-select');
        expect(select.options[0]).toBe(option);
        expect(result.getValue()).toBe('existing');
        change(select);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('explicit replacement options preserve an available adopted selection', () => {
        const select = node('select');
        const option = node('option', 'Old');
        option.value = 'old';
        select.append(option);
        const result = createComboRow({ label: 'Mode', field: 'mode', select, options: [{ value: 'new', label: 'New' }, { value: 'old', label: 'Old' }] });
        expect(result.getValue()).toBe('old');
    });

    test('rejects a non-select control', () => {
        expect(() => createComboRow({ label: 'Mode', field: 'mode', select: input('text') })).toThrow(TypeError);
    });
});

describe('createSpinRow', () => {
    test('configures numeric attributes and commits only on change, clamping in both directions', () => {
        const onChange = jest.fn();
        const result = createSpinRow({ label: 'Count', field: 'count', value: 4, min: 2, max: 8, step: 2, placeholder: 'Count', onChange });
        const { row, control } = result;
        expect(row.querySelector('.ds-row-suffix').firstChild).toBe(control);
        expect(control.type).toBe('number');
        expect(control.inputMode).toBe('numeric');
        expect([control.min, control.max, control.step, control.placeholder]).toEqual(['2', '8', '2', 'Count']);
        control.value = '99';
        control.dispatchEvent(new Event('input'));
        expect(onChange).not.toHaveBeenCalled();
        change(control);
        expect(onChange).toHaveBeenLastCalledWith(8);
        expect(control.value).toBe('8');
        change(control, '-99');
        expect(onChange).toHaveBeenLastCalledWith(2);
        expect(control.value).toBe('2');
    });

    test.each(['', 'not-a-number'])('non-nullable %j restores the previous valid value', value => {
        const onChange = jest.fn();
        const result = createSpinRow({ label: 'Count', field: 'count', value: 4, min: 2, max: 8, onChange });
        change(result.control, '6');
        change(result.control, value);
        expect(result.control.value).toBe('6');
        expect(result.getValue()).toBe(6);
        expect(onChange).toHaveBeenLastCalledWith(6);
    });

    test('nullable empty values report null and setters normalize bounds', () => {
        const onChange = jest.fn();
        const result = createSpinRow({ label: 'Count', field: 'count', value: 4, min: 2, max: 8, nullable: true, onChange });
        change(result.control, '');
        expect(result.getValue()).toBeNull();
        expect(result.control.value).toBe('');
        expect(onChange).toHaveBeenLastCalledWith(null);
        onChange.mockClear();
        result.setValue(99);
        expect(result.getValue()).toBe(8);
        expect(onChange).not.toHaveBeenCalled();
        result.setValue(null, { silent: false });
        expect(result.control.value).toBe('');
        expect(onChange).toHaveBeenCalledWith(null);
    });

    test('clamps initial values and rewrites invalid edits without an onChange callback', () => {
        const result = createSpinRow({ label: 'Count', field: 'count', value: 99, min: 2, max: 8 });
        expect(result.getValue()).toBe(8);
        change(result.control, '-10');
        expect(result.control.value).toBe('2');
        change(result.control, '');
        expect(result.control.value).toBe('2');
        expect(createSpinRow({ label: 'Count', field: 'count' }).control.step).toBe('1');
    });

    test('adoption retains id, name, value, constraints and existing listeners', () => {
        const control = input('number', '5');
        control.min = '2';
        control.max = '8';
        const listener = jest.fn();
        control.addEventListener('change', listener);
        const old = node('div');
        old.append(control);
        const result = createSpinRow({ label: 'Count', field: 'count', input: control, id: 'ignored' });
        expect(result.control).toBe(control);
        expect(control.id).toBe('existing-number');
        expect(control.name).toBe('preserved-name');
        expect(result.getValue()).toBe(5);
        expect(old.children).toHaveLength(0);
        change(control, '12');
        expect(control.value).toBe('8');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('rejects inverted numeric bounds', () => {
        expect(() => createSpinRow({ label: 'Count', field: 'count', min: 10, max: 2 })).toThrow(RangeError);
    });
});

describe('createEntryRow', () => {
    test('places the entry below its label, with separate input and change notifications', () => {
        const onInput = jest.fn();
        const onChange = jest.fn();
        const result = createEntryRow({ label: 'Name', subtitle: 'Helpful description', field: 'name', value: 'Initial', placeholder: 'Name', maxLength: 16, onInput, onChange });
        const { row, control } = result;
        expect(row.classList.contains('ds-row-entry')).toBe(true);
        expect(control.type).toBe('text');
        expect(control.parentElement.className).toBe('ds-row-text');
        expect(control.previousSibling.className).toBe('ds-row-subtitle');
        expect(control.previousSibling.previousSibling.tagName).toBe('LABEL');
        expect(control.placeholder).toBe('Name');
        expect(control.maxLength).toBe(16);
        control.value = 'Updated';
        control.dispatchEvent(new Event('input'));
        expect(onInput).toHaveBeenCalledWith('Updated');
        expect(onChange).not.toHaveBeenCalled();
        change(control);
        expect(onChange).toHaveBeenCalledWith('Updated');
        expect(onInput).toHaveBeenCalledTimes(1);
    });

    test('adoption preserves id, name, value, placeholder, maximum length and both listeners', () => {
        const control = input('text', 'Existing');
        control.placeholder = 'Existing placeholder';
        control.maxLength = 24;
        const listener = jest.fn();
        control.addEventListener('input', listener);
        control.addEventListener('change', listener);
        const old = node('div');
        old.append(control);

        const result = createEntryRow({ label: 'Name', field: 'name', input: control, id: 'ignored' });

        expect(result.control).toBe(control);
        expect(control.id).toBe('existing-text');
        expect(control.name).toBe('preserved-name');
        expect(result.getValue()).toBe('Existing');
        expect(control.placeholder).toBe('Existing placeholder');
        expect(control.maxLength).toBe(24);
        expect(old.children).toHaveLength(0);
        control.dispatchEvent(new Event('input'));
        change(control);
        expect(listener).toHaveBeenCalledTimes(2);
    });
});

describe('createPropertyRow', () => {
    test('places the caption above a selectable read-only value and safely updates it', () => {
        const result = createPropertyRow({ label: 'Identifier', field: 'identifier', value: 'abc' });
        expect(result.row.className).toBe('ds-row ds-row-property');
        expect(result.row.dataset.sbEditorField).toBe('identifier');
        const text = result.row.firstChild;
        expect(text.firstChild.className).toBe('ds-row-subtitle');
        expect(text.firstChild.textContent).toBe('Identifier');
        expect(text.lastChild.className).toBe('ds-row-label ds-row-property__value');
        expect(text.lastChild.textContent).toBe('abc');
        expect(text.lastChild.style.userSelect).toBe('text');
        expect(result.row.querySelector('input')).toBeNull();
        result.setValue('<b>Updated</b>');
        expect(text.lastChild.textContent).toBe('<b>Updated</b>');
        expect(text.lastChild.children).toHaveLength(0);
    });

    test('can opt out of selection', () => {
        const { row } = createPropertyRow({ label: 'Identifier', field: 'identifier', value: 0, selectable: false });
        expect(row.querySelector('.ds-row-property__value').style.userSelect).toBe('none');
        expect(row.querySelector('.ds-row-property__value').textContent).toBe('0');
    });
});

describe('createExpanderRow', () => {
    test('uses native details with supplied content, description and toggle notifications', () => {
        const child = createPropertyRow({ label: 'Value', field: 'value', value: 'child' });
        const extra = node('div');
        const onToggle = jest.fn();
        const result = createExpanderRow({ label: 'Advanced', subtitle: 'Description', field: 'advanced', children: [child, extra], onToggle });
        const { row, content } = result;
        expect(row.tagName).toBe('DETAILS');
        expect(row.className).toBe('ds-row-expander');
        expect(row.dataset.sbEditorField).toBe('advanced');
        expect(row.open).toBe(false);
        expect(row.firstChild.tagName).toBe('SUMMARY');
        expect(row.firstChild.className).toBe('ds-row');
        expect(row.firstChild.getAttribute('aria-describedby')).toBe(row.querySelector('small').id);
        expect(content.className).toBe('ds-row-expander-content');
        expect([...content.children]).toEqual([child.row, extra]);
        result.setOpen(true);
        expect(row.open).toBe(true);
        row.dispatchEvent(new Event('toggle'));
        expect(onToggle).toHaveBeenCalledWith(true);
        result.setOpen(false);
        row.dispatchEvent(new Event('toggle'));
        expect(onToggle).toHaveBeenLastCalledWith(false);
    });

    test('can start open and disabled summaries decline click and keyboard activation', () => {
        const result = createExpanderRow({ label: 'Advanced', field: 'advanced', open: true });
        expect(result.row.open).toBe(true);
        result.setDisabled(true);
        expect(result.row.hasAttribute('inert')).toBe(true);
        for (const event of [new MouseEvent('click', { cancelable: true }), new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })]) {
            result.row.firstChild.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(true);
        }
        result.setDisabled(false);
        expect(result.row.hasAttribute('inert')).toBe(false);
    });
});

describe('createButtonRow', () => {
    test('uses a native destructive button with a decorative start icon', () => {
        const onActivate = jest.fn();
        const result = createButtonRow({ label: 'Delete', icon: 'trash', field: 'delete', danger: true, onActivate });
        expect(result.row.tagName).toBe('BUTTON');
        expect(result.row.type).toBe('button');
        expect(result.row.className).toBe('ds-row ds-button-row is-destructive');
        expect(result.row.dataset.sbEditorField).toBe('delete');
        expect(result.row.firstChild.className).toBe('fa-solid fa-trash');
        expect(result.row.firstChild.getAttribute('aria-hidden')).toBe('true');
        expect(result.row.lastChild.textContent).toBe('Delete');
        result.row.click();
        expect(onActivate).toHaveBeenCalledTimes(1);
        result.setDisabled(true);
        result.row.click();
        expect(onActivate).toHaveBeenCalledTimes(1);
        expect(result.control.disabled).toBe(true);
    });

    test('omits the icon and destructive state by default', () => {
        const { row } = createButtonRow({ label: 'Apply', field: 'apply' });
        expect(row.querySelector('i')).toBeNull();
        expect(row.classList.contains('is-destructive')).toBe(false);
    });
});

describe('createPrefGroup', () => {
    test('builds the section and accessible heading, adds a header suffix and appends row nodes or controllers', () => {
        const first = createRow({ label: 'First', field: 'first' });
        const second = node('div');
        const headerSuffix = node('button', 'Header action');
        const result = createPrefGroup({ title: 'Preferences', subtitle: 'Description', field: 'preferences', rows: [first], headerSuffix });
        const { section, group } = result;
        expect(result.row).toBe(section);
        expect(section.tagName).toBe('SECTION');
        expect(section.className).toBe('sb-editor-section');
        expect(section.dataset.sbEditorField).toBe('preferences');
        expect(group.className).toBe('ds-pref-group');
        expect(group.getAttribute('role')).toBe('group');
        const header = section.firstChild;
        expect(header.className).toBe('ds-pref-group-header');
        expect(header.querySelector('h3').textContent).toBe('Preferences');
        expect(header.querySelector('h3').className).toBe('ds-pref-group-heading');
        expect(group.getAttribute('aria-labelledby')).toBe(header.querySelector('h3').id);
        expect(header.querySelector('p').className).toBe('ds-pref-group-subtitle');
        expect(header.lastChild).toBe(headerSuffix);
        expect(group.firstChild).toBe(first.row);
        result.append(second, createRow({ label: 'Third', field: 'third' }));
        expect(group.children).toHaveLength(3);
        expect(group.children[1]).toBe(second);
        expect(group.lastChild.dataset.sbEditorField).toBe('third');
    });

    test('omits an empty header, including an orphan header suffix', () => {
        const { section, group } = createPrefGroup({ field: 'group', headerSuffix: node('button') });
        expect(section.children).toHaveLength(1);
        expect(section.firstChild).toBe(group);
        expect(group.hasAttribute('aria-labelledby')).toBe(false);
    });

    test('subtitle-only groups do not create an empty heading or dangling labelledby', () => {
        const { section, group } = createPrefGroup({ field: 'group', subtitle: 'Description' });
        expect(section.querySelector('h3')).toBeNull();
        expect(group.hasAttribute('aria-labelledby')).toBe(false);
        expect(group.getAttribute('aria-describedby')).toBe(section.querySelector('p').id);
    });
});

describe('display-only row controllers', () => {
    test.each([
        ['row', () => createRow({ label: 'Label', field: 'field' })],
        ['property', () => createPropertyRow({ label: 'Label', field: 'field', value: 'Value' })],
        ['expander', () => createExpanderRow({ label: 'Label', field: 'field' })],
        ['button', () => createButtonRow({ label: 'Label', field: 'field' })],
        ['group', () => createPrefGroup({ field: 'field' })],
    ])('%s supports disabling and visibility without a value control', (_name, factory) => {
        const result = factory();
        result.setDisabled(true);
        result.setVisible(false);
        expect(result.row.classList.contains('is-insensitive')).toBe(true);
        expect(result.row.getAttribute('aria-disabled')).toBe('true');
        expect(result.row.hidden).toBe(true);
        result.setDisabled(false);
        result.setVisible(true);
        expect(result.row.classList.contains('is-insensitive')).toBe(false);
        expect(result.row.getAttribute('aria-disabled')).toBe('false');
        expect(result.row.hidden).toBe(false);
    });
});
