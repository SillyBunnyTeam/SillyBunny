/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
const { adaptDebugMenu, adaptSamplerSelectList, tokenCounterOptions } = await import('../../public/scripts/sillybunny-editor/adapters/window-tools-dialogs.js');
const { releaseRowIds } = await import('../../public/scripts/sillybunny-editor/rows.js');

function root(html) {
    const node = document.createElement('div');
    node.innerHTML = html;
    document.body.append(node);
    return node;
}

afterEach(() => {
    releaseRowIds(document.body);
    document.body.replaceChildren();
});

test('Token Counter adopts live inputs, translated captions, output IDs and input listeners', () => {
    const node = root(readFileSync(new URL('../../public/scripts/extensions/token-counter/window.html', import.meta.url), 'utf8'));
    const input = node.querySelector('#token_counter_textarea');
    const ids = node.querySelector('#token_counter_ids');
    const result = node.querySelector('#token_counter_result');
    const chunks = node.querySelector('#tokenized_chunks_display');
    const changed = jest.fn();
    input.addEventListener('input', changed);
    const options = tokenCounterOptions(node);

    expect(options.tier).toBe('window');
    expect(node.querySelector('#token_counter_textarea')).toBe(input);
    expect(node.querySelector('#token_counter_ids')).toBe(ids);
    expect(node.querySelector('#token_counter_result')).toBe(result);
    expect(node.querySelector('#tokenized_chunks_display')).toBe(chunks);
    expect(ids.readOnly).toBe(true);
    expect(input.rows).toBe(1);
    expect(input.closest('.ds-row--stacked')).not.toBeNull();
    expect(ids.closest('.ds-row--stacked')).not.toBeNull();
    expect(node.querySelector('[data-i18n="Input:"]').textContent).toBe('Input:');
    expect(node.querySelector('h3').dataset.i18n).toBe('Token Counter');
    input.value = 'exact input\n';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('exact input\n');
    options.onClose();
});

test('sampler visibility adopts source inputs and Select All synchronizes only lists over five', () => {
    const node = root(Array.from({ length: 7 }, (_, index) => `
        <label class="sampler_view_list_item wide50p flex-container">
            <input id="sampler-${index}" type="checkbox" name="sampler-${index}_checkbox" value="source-${index}" ${index < 4 ? 'checked' : ''}>
            <small class="sampler_name" style="color: red">Sampler ${index}</small>
        </label>`).join(''));
    const inputs = [...node.querySelectorAll('input')];
    const changed = jest.fn();
    inputs.forEach(input => input.addEventListener('change', changed));

    const adapter = adaptSamplerSelectList(node);
    const selectAll = adapter.selectAll;

    expect(node.querySelectorAll('.ds-row-check')).toHaveLength(8);
    expect(node.querySelectorAll('.sampler_view_list_item')).toHaveLength(7);
    expect([...node.querySelectorAll('.sampler_view_list_item input')]).toEqual(inputs);
    expect(inputs.map(input => [input.id, input.name, input.value, input.checked])).toEqual(Array.from({ length: 7 }, (_, index) => [
        `sampler-${index}`, `sampler-${index}_checkbox`, `source-${index}`, index < 4,
    ]));
    expect(inputs.every(input => !input.hasAttribute('role'))).toBe(true);
    expect(inputs.every(input => input.parentElement.lastElementChild === input)).toBe(true);
    expect(node.querySelector('.ds-row-label.sampler_name').getAttribute('style')).toBe('color: red');
    expect(node.querySelector('.sampler-select-all')).toBeNull();
    expect(selectAll.indeterminate).toBe(true);

    selectAll.click();
    expect(inputs.every(input => input.checked)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);

    inputs[0].click();
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
    adapter.destroy();
    adapter.destroy();
});

test('sampler lists with five or fewer choices do not add Select All', () => {
    const node = root(Array.from({ length: 5 }, (_, index) => `<label class="sampler_view_list_item"><input type="checkbox" name="sampler-${index}_checkbox"><small class="sampler_name">Sampler ${index}</small></label>`).join(''));
    const adapter = adaptSamplerSelectList(node);

    expect(adapter.selectAll).toBeNull();
    expect(node.querySelectorAll('.ds-row-check')).toHaveLength(5);
    adapter.destroy();
});

test('debug rows preserve action node identity and place the delegated action after its description', () => {
    const node = root(`<div>
        <h3>Debug Menu</h3>
        <div>Advanced diagnostics</div>
        <table id="debug_table" class="responsiveTable"><tbody><tr><td>
            <div class="justifyLeft"><b>Diagnostic name</b></div>
            <div class="justifyLeft">Diagnostic description</div>
            <div class="flex-container justifyCenter"><div class="menu_button menu_button_icon" data-debug-function="diagnostic" data-i18n="Execute">Execute</div></div>
        </td></tr></tbody></table>
    </div>`);
    const action = node.querySelector('[data-debug-function]');
    const table = adaptDebugMenu(node);
    const row = node.querySelector('.ds-row-debug');

    expect(table.id).toBe('debug_table');
    expect(table.classList.contains('sb-debug-menu')).toBe(true);
    expect(row.querySelector('.ds-row-label').textContent).toBe('Diagnostic name');
    expect(row.querySelector('.ds-row-subtitle').textContent).toBe('Diagnostic description');
    expect(row.querySelector('.ds-row-suffix [data-debug-function]')).toBe(action);
    expect(action.dataset.debugFunction).toBe('diagnostic');
});
