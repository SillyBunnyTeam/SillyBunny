/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
const openPicker = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker: jest.fn(), isPickerOpen: () => false, openPicker }));
const { embeddedLorebookOptions, lorebookSelectOptions, lorebookSortingOptions, presetChoicesOptions } = await import('../../public/scripts/sillybunny-editor/adapters/preset-lorebook-dialogs.js');
const { releaseRowIds } = await import('../../public/scripts/sillybunny-editor/rows.js');

function root(html) {
    const node = document.createElement('div');
    node.innerHTML = html;
    document.body.append(node);
    return node;
}

const checks = count => Array.from({ length: count }, (_, index) => `<label class="checkbox_label"><input id="choice-${index}" type="checkbox" name="section" value="value-${index}" ${index ? '' : 'checked'}><span data-i18n="Section">Section ${index}</span><small>Preset ${index}</small></label>`).join('');
const batchChoices = count => Array.from({ length: count }, (_, index) => `<label><input type="checkbox" class="batch_wi_import_candidate" data-chid="${index}" checked><span>Book ${index}</span></label>`).join('');

afterEach(() => {
    openPicker.mockClear();
    releaseRowIds(document.body);
    document.body.replaceChildren();
});

test('preset checks adopt state, IDs, values, translated labels, details and listeners', () => {
    const node = root(checks(3));
    const input = node.querySelector('input');
    const changed = jest.fn();
    input.addEventListener('change', changed);
    const options = presetChoicesOptions(node);
    expect(options.tier).toBe('dialog');
    expect(node.querySelector('input')).toBe(input);
    expect(input.checked).toBe(true);
    expect(input.name).toBe('section');
    expect(input.value).toBe('value-0');
    expect(input.parentElement.lastElementChild).toBe(input);
    expect(input.hasAttribute('role')).toBe(false);
    expect(node.querySelector('.ds-row-label').dataset.i18n).toBe('Section');
    expect(node.querySelector('.ds-row-subtitle').textContent).toBe('Preset 0');
    input.click();
    expect(changed).toHaveBeenCalledTimes(1);
    options.onClose();
    expect(node.querySelector('#choice-0')).toBe(input);
    expect(node.querySelector('[data-sb-select-all]')).toBeNull();
});

test('Select All synchronizes mixed state, skips disabled choices and never adds a selected result', () => {
    const node = root(`<div>Select the presets you want to delete.</div>${checks(7)}`);
    const inputs = [...node.querySelectorAll('input')];
    inputs[6].disabled = true;
    const inputEvents = jest.fn();
    inputs.forEach(input => input.addEventListener('input', inputEvents));
    const options = presetChoicesOptions(node, { deletion: true });
    const all = node.querySelector('[data-sb-select-all]');
    expect(all.indeterminate).toBe(true);
    all.click();
    expect(inputs.slice(0, 6).every(input => input.checked)).toBe(true);
    expect(inputs[6].checked).toBe(false);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    expect(inputEvents).toHaveBeenCalledTimes(5);
    expect([...node.querySelectorAll('input:checked:not([data-sb-select-all])')].map(input => input.value)).toHaveLength(6);
    all.click();
    expect(inputs.every(input => !input.checked)).toBe(true);
    inputs[2].click();
    expect(all.indeterminate).toBe(true);
    expect(options.title).toBe('Delete selected');
    const okButton = document.createElement('button');
    options.onOpen({ okButton });
    expect(okButton.classList.contains('is-destructive')).toBe(true);
    options.onClose();
    expect(node.querySelectorAll('input')).toHaveLength(8);
});

test('batch selection retains candidate metadata and collision details without a nested scroller', () => {
    const node = root('<h3>Import embedded lorebooks?</h3><div class="m-b-1">Overwrite warning</div><label><input type="checkbox" checked><span>Select all</span></label><div style="max-height:50vh;overflow-y:auto"><label><input type="checkbox" class="batch_wi_import_candidate" data-chid="3" checked><span>&lt;b&gt;Character&lt;/b&gt; → Book</span><small>(overwrites existing)</small></label></div>');
    const all = node.querySelector('input');
    const candidate = node.querySelector('.batch_wi_import_candidate');
    const options = embeddedLorebookOptions(node);
    expect(node.querySelector('[data-sb-select-all]')).toBeNull();
    expect(node.contains(all)).toBe(false);
    expect(candidate.dataset.chid).toBe('3');
    expect(node.querySelector('.ds-row-subtitle').textContent).toBe('(overwrites existing)');
    expect(node.querySelector('b')).toBeNull();
    expect(node.querySelector('[style]')).toBeNull();
    candidate.click();
    expect(candidate.checked).toBe(false);
    options.onClose();
});

test.each([5, 6])('batch Select All is present only above five candidates: %i', count => {
    const node = root(`<h3>Import embedded lorebooks?</h3><label><input type="checkbox" checked><span>Select all</span></label><div>${batchChoices(count)}</div>`);
    const originalToggle = node.querySelector('input');
    const options = embeddedLorebookOptions(node);
    expect(node.querySelectorAll('.batch_wi_import_candidate')).toHaveLength(count);
    expect(node.querySelectorAll('[data-sb-select-all]')).toHaveLength(count > 5 ? 1 : 0);
    expect(node.contains(originalToggle)).toBe(count > 5);
    options.onClose();
});

test('batch Select All keeps the original toggle wired above the threshold', () => {
    const node = root(`<h3>Import embedded lorebooks?</h3><label><input type="checkbox" checked><span>Select all</span></label><div>${batchChoices(6)}</div>`);
    const originalToggle = node.querySelector('input');
    const options = embeddedLorebookOptions(node);
    expect(node.querySelector('[data-sb-select-all]')).toBe(originalToggle);
    originalToggle.click();
    expect(node.querySelectorAll('.batch_wi_import_candidate:checked')).toHaveLength(0);
    node.querySelector('.batch_wi_import_candidate').click();
    expect(originalToggle.indeterminate).toBe(true);
    originalToggle.click();
    expect(node.querySelectorAll('.batch_wi_import_candidate:checked')).toHaveLength(6);
    options.onClose();
});

test('sorting rows retain custom-input identity, constraints, warnings, help and focus', () => {
    const node = root('<h3>Apply Current Sorting</h3><div class="warning">Warning</div>');
    const dlg = root('<div class="popup-inputs"><label><input id="wi_sort_start" type="number" min="0" value="100" autofocus></label><label><input id="wi_sort_step" type="number" min="1" value="1"></label><label><input id="wi_sort_ascending" type="checkbox"></label></div>');
    dlg.append(node);
    const start = dlg.querySelector('#wi_sort_start');
    const change = jest.fn();
    start.addEventListener('input', change);
    const options = lorebookSortingOptions(node, [
        { id: 'wi_sort_start', type: 'number', label: 'Starting value', tooltip: 'First entry' },
        { id: 'wi_sort_step', type: 'number', label: 'Step', tooltip: 'Gap' },
        { id: 'wi_sort_ascending', type: 'checkbox', label: 'Ascending order', tooltip: 'Count upward' },
    ]);
    options.onOpen({ dlg, inputControls: dlg.querySelector('.popup-inputs') });
    expect(node.querySelector('#wi_sort_start')).toBe(start);
    expect(start.value).toBe('100');
    expect(start.min).toBe('0');
    expect(document.activeElement).toBe(start);
    expect(node.querySelector('#wi_sort_step').min).toBe('1');
    expect(node.querySelector('#wi_sort_ascending').getAttribute('role')).toBe('switch');
    expect(node.querySelectorAll('.ds-row-suffix')).toHaveLength(2);
    expect(node.lastElementChild.className).toBe('warning');
    start.dispatchEvent(new Event('input'));
    expect(change).toHaveBeenCalledTimes(1);
    expect(node.querySelector('.ds-row-subtitle').textContent).toBe('First entry');
    options.onClose();
});

test('sorting reuses the frame-converted switch without leaving duplicate descriptions', () => {
    const node = root('<div class="warning"></div>');
    const dlg = root('<div class="popup-inputs"><input id="wi_sort_start" type="number" value="100"><label class="ds-row ds-row-switch"><span class="ds-row-text"><span class="ds-row-label">Ascending order</span><small id="ascending-help" class="ds-row-subtitle">Count upward</small></span><input id="wi_sort_ascending" type="checkbox" role="switch" aria-describedby="ascending-help"></label></div>');
    dlg.append(node);
    const row = dlg.querySelector('.ds-row-switch');
    const options = lorebookSortingOptions(node, [{ id: 'wi_sort_start', type: 'number', label: 'Start' }, { id: 'wi_sort_ascending', type: 'checkbox', label: 'Ascending order', tooltip: 'Count upward' }]);
    options.onOpen({ dlg, inputControls: dlg.querySelector('.popup-inputs') });
    expect(node.querySelector('.ds-row-switch')).toBe(row);
    expect(node.querySelector('#wi_sort_ascending').getAttribute('aria-describedby')).toBe('ascending-help');
    expect(document.getElementById('ascending-help')).not.toBeNull();
    options.onClose();
});

test.each(['wi_sort_start', 'wi_sort_step'])('%s preserves empty and out-of-range edits for upstream validation', id => {
    const node = root('<div class="warning"></div>');
    const dlg = root(`<div class="popup-inputs"><input id="${id}" type="number" min="${id === 'wi_sort_step' ? 1 : 0}" value="100"></div>`);
    dlg.append(node);
    const options = lorebookSortingOptions(node, [{ id, type: 'number', label: id }]);
    options.onOpen({ dlg, inputControls: dlg.querySelector('.popup-inputs') });
    const input = dlg.querySelector('input');
    for (const value of ['', '0', '-1']) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(input.value).toBe(value);
    }
    options.onClose();
});

test.each(['personaLorebook', 'chatLorebook', 'character'])('%s mirrors source selects and preserves translated help and names', async kind => {
    const html = kind === 'character'
        ? readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8').split('<div id="character_world_template"')[1].split('<div id="past_chat_template"')[0]
        : readFileSync(new URL(`../../public/scripts/templates/${kind}.html`, import.meta.url), 'utf8');
    const wrapper = root(kind === 'character' ? `<div ${html}` : html);
    const node = wrapper.querySelector('.character_world, .persona_world, .chat_world');
    const selects = [...node.querySelectorAll('select')];
    const changed = jest.fn();
    selects[0].append(new Option('Selected book', 'book', true, true));
    selects[0].addEventListener('change', changed);
    const options = lorebookSelectOptions(node, { character: kind === 'character' });
    expect(options.tier).toBe('dialog');
    expect([...node.querySelectorAll('select')]).toEqual(selects);
    expect(node.querySelector('.popup-header')).not.toBeNull();
    expect(node.querySelector('.ds-row-subtitle [data-i18n]')).not.toBeNull();
    expect(node.querySelector('.ds-select-row__value').textContent).toBe('Selected book');
    selects[0].value = '';
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(node.querySelector('.ds-select-row__value').textContent).toBe('--- None ---');
    expect(selects.map(select => select.multiple)).toEqual(kind === 'character' ? [false, true] : [false]);
    options.onClose();
});

test('empty auxiliary lorebooks reuse the upstream placeholder and omit only the picker sentinel', () => {
    const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8').split('<div id="character_world_template"')[1].split('<div id="past_chat_template"')[0];
    const wrapper = root(`<div ${html}`);
    const node = wrapper.querySelector('.character_world');
    const select = node.querySelector('.character_extra_world_info_selector');
    const sentinel = select.options[0];
    select.append(new Option('Book 1', '1'));
    const options = lorebookSelectOptions(node, { character: true });
    const row = select.closest('.ds-select-row');
    expect(row.querySelector('.ds-select-row__value').textContent).toBe('No auxiliary Lorebooks set. Click here to select.');
    expect(select.options[0]).toBe(sentinel);
    expect(sentinel.value).toBe('');
    expect(sentinel.hidden).toBe(true);
    row.querySelector('.ds-select-row__trigger').click();
    expect(openPicker).toHaveBeenCalledWith(expect.objectContaining({ items: [{ value: '1', label: 'Book 1', disabled: false }] }));
    options.onClose();
});

test('upstream entry points retain adapter, result filtering and destructive default seams', () => {
    const preset = readFileSync(new URL('../../public/scripts/preset-manager.js', import.meta.url), 'utf8');
    expect(preset.match(/presetChoicesOptions\(html.filter\('div'\)\[0\]\)/g)).toHaveLength(2);
    expect(preset).toContain('presetChoicesOptions(html[0], { deletion: true })');
    expect(preset.match(/input:checked:not\(\[data-sb-select-all\]\)/g)).toHaveLength(3);
    expect(preset).toContain('defaultResult: POPUP_RESULT.NEGATIVE');
    const world = readFileSync(new URL('../../public/scripts/world-info.js', import.meta.url), 'utf8');
    expect(world).toContain('...lorebookSortingOptions(contentEl, customInputs)');
    expect(world).toContain('...embeddedLorebookOptions(contentEl)');
    expect(world).toContain('lorebookSelectOptions(template[0])');
});
