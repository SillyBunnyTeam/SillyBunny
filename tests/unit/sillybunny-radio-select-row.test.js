/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let pickerOptions;
const picker = { close: jest.fn(), refresh: jest.fn() };
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({
    openPicker: jest.fn(config => { pickerOptions = config; return picker; }),
    closePicker: jest.fn(),
    isPickerOpen: () => false,
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), ''),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-settings-presentation.js', () => ({
    adoptButtonRows: jest.fn(), adoptFieldRow: jest.fn(), bindDependentSets: jest.fn(), readRowTitle: jest.fn(), unwrapLoneSelects: jest.fn(),
}));
const { createRadioSelectRow } = await import('../../public/scripts/sillybunny-backend-pages.js');

const NAMES = [['character_names_none', '-1', 'None', 'Never add character name prefixes.'], ['character_names_default', '0', 'Default', 'Add prefixes for groups.'],
    ['character_names_completion', '1', 'Completion Object', 'Add character names to completion objects.'], ['character_names_content', '2', 'Message Content', '']];

let set;
let upstream;
const radio = id => document.getElementById(id);
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

beforeEach(() => {
    upstream = jest.fn();
    document.body.innerHTML = `<div id="set"><span id="character_names_display"></span>${NAMES.map(([id, value, label, hint]) => `
        <label class="checkbox_label" for="${id}"><input type="radio" id="${id}" name="character_names" value="${value}"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label>`).join('')}</div>`;
    set = document.getElementById('set');
    for (const [id] of NAMES) radio(id).addEventListener('input', () => upstream(id));
    radio('character_names_default').checked = true;
});

describe('a set of upstream radios as one select row', () => {
    test('has one option for each radio, with the radio\'s own label, in order', () => {
        const row = createRadioSelectRow(set, 'names-behavior', 'Character Names Behavior');
        document.body.append(row);
        const select = row.querySelector('select');
        expect([...select.options].map(option => [option.value, option.textContent])).toEqual([['-1', 'None'], ['0', 'Default'], ['1', 'Completion Object'], ['2', 'Message Content']]);
        expect(row.querySelector('.ds-row-label').textContent).toBe('Character Names Behavior');
    });

    test('shows the checked radio and names its note under the title', () => {
        const row = createRadioSelectRow(set, 'names-behavior', 'Character Names Behavior');
        expect(row.querySelector('select').value).toBe('0');
        expect(row.querySelector('.ds-select-row__value').textContent).toBe('Default');
        expect(row.querySelector('.ds-select-row__detail').textContent).toBe('Add prefixes for groups.');
    });

    test('a pick checks the radio and fires its input handler once, with the radio left in the document', async () => {
        const row = createRadioSelectRow(set, 'names-behavior', 'Character Names Behavior');
        document.body.append(row);
        row.querySelector('.ds-select-row__trigger').click();
        pickerOptions.onSelect('1');
        await settle();
        expect(radio('character_names_completion').checked).toBe(true);
        expect(radio('character_names_default').checked).toBe(false);
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(upstream).toHaveBeenCalledWith('character_names_completion');
        expect(set.contains(radio('character_names_completion'))).toBe(true);
    });

    test('picking the value that is already checked fires nothing', async () => {
        const row = createRadioSelectRow(set, 'names-behavior', 'Character Names Behavior');
        document.body.append(row);
        row.querySelector('.ds-select-row__trigger').click();
        pickerOptions.onSelect('0');
        await settle();
        expect(upstream).not.toHaveBeenCalled();
    });

    test('follows a preset load that checks a radio without an event and then rewrites the readout', async () => {
        const row = createRadioSelectRow(set, 'names-behavior', 'Character Names Behavior');
        document.body.append(row);
        radio('character_names_content').checked = true;
        document.getElementById('character_names_display').textContent = 'Message Content';
        await settle();
        expect(row.querySelector('select').value).toBe('2');
        expect(row.querySelector('.ds-select-row__value').textContent).toBe('Message Content');
    });

    test('opens its picker on the checked value even when nothing announced the change', () => {
        const row = createRadioSelectRow(set, 'names-behavior', 'Character Names Behavior');
        document.body.append(row);
        radio('character_names_none').checked = true;
        row.querySelector('.ds-select-row__trigger').click();
        expect(pickerOptions.selected).toBe('-1');
    });
});
