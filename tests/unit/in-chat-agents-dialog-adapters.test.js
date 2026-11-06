/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({
    closePicker: jest.fn(),
    isPickerOpen: () => false,
    openPicker: jest.fn(),
}));
const adapters = await import('../../public/scripts/extensions/in-chat-agents/ui/dialog-adapters.js');

afterEach(() => document.body.replaceChildren());

function mount(html) {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.append(root);
    return root.firstElementChild;
}

test('bulk edit keeps source selects and exposes three-choice fields as segmented controls', () => {
    const root = mount(`<div><div class="ica--bulk-edit-popup-content">
        <strong>Bulk Edit Selected Agents</strong><p>Choose fields.</p>
        <div class="ica--editor-row"><label>Injection Role<select id="ica--bulkEdit-role"><option value="">Don't change</option><option value="0">System</option><option value="1">User</option><option value="2">Assistant</option></select></label><label>Phase<select id="ica--bulkEdit-phase"><option value="">Don't change</option><option value="pre">Pre-generation</option><option value="post">Post-generation</option><option value="both">Both</option></select></label></div>
        <div class="ica--editor-row"><label>Prompt Pass Mode<select id="ica--bulkEdit-promptMode"><option value="">Don't change</option><option value="rewrite">Rewrite</option><option value="append">Append</option></select></label><label>Prompt Pass Enabled<select id="ica--bulkEdit-promptEnabled"><option value="">Don't change</option><option value="true">Enabled</option><option value="false">Disabled</option></select></label></div>
        <div class="ica--editor-row"><label>Utility Post-Process Enabled<select id="ica--bulkEdit-ppEnabled"><option value="">Don't change</option><option value="true">Enabled</option><option value="false">Disabled</option></select></label><label>Scan World Info<select id="ica--bulkEdit-scan"><option value="">Don't change</option><option value="true">Enabled</option><option value="false">Disabled</option></select></label></div>
    </div></div>`);
    const state = adapters.prepareBulkEditDialog(root);
    expect(root.querySelectorAll('.ds-select-row')).toHaveLength(2);
    expect(root.querySelectorAll('.ds-toggle-row')).toHaveLength(4);
    const select = root.querySelector('#ica--bulkEdit-promptMode');
    const radio = root.querySelector('.ds-toggle-row input[type="radio"][value="append"]');
    radio.click();
    expect(select.value).toBe('append');
    select.value = 'rewrite';
    state.sync();
    expect(root.querySelector('.ds-toggle-row input[type="radio"][value="rewrite"]').checked).toBe(true);
});

test('manual targets use trailing check rows and Select All only for larger lists', () => {
    const root = mount(`<div><h4>Apply targets</h4>${Array.from({ length: 6 }, (_, index) => `<label class="checkbox_label"><input type="checkbox" name="target" value="${index}" /><span>Target ${index}</span></label>`).join('')}<label class="ica--run-target-range"><span>Messages</span><input id="range" type="text" /></label></div>`);
    adapters.prepareManualRunTargets(root);
    expect(root.querySelectorAll('.ds-row-check')).toHaveLength(7);
    const selectAll = root.querySelector('[data-sb-select-all="true"]');
    expect(selectAll).not.toBeNull();
    selectAll.checked = true;
    selectAll.dispatchEvent(new Event('change', { bubbles: true }));
    expect([...root.querySelectorAll('input[name="target"]')].map(input => input.checked)).toEqual([true, true, true, true, true, true]);
    expect(root.querySelector('#range').closest('.ds-row-entry')).not.toBeNull();
});

test('refine mode mirrors the original radio values and keeps custom input identity', () => {
    const root = mount(`<div><p>Choose how to refine this prompt:</p>
        <label class="checkbox_label"><input type="radio" name="ica-refine-mode" value="clarity" checked /><span>Improve clarity</span></label>
        <label class="checkbox_label"><input type="radio" name="ica-refine-mode" value="custom" /><span>Custom instruction:</span></label>
        <input id="ica--refine-custom" type="text" />
    </div>`);
    adapters.prepareRefinePromptDialog(root);
    const trigger = root.querySelector('.ds-select-row__trigger');
    expect(trigger).not.toBeNull();
    expect(root.querySelector('#ica--refine-custom')).toBeInstanceOf(HTMLInputElement);
    const select = root.querySelector('select');
    select.value = 'custom';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector('input[name="ica-refine-mode"][value="custom"]').checked).toBe(true);
});
