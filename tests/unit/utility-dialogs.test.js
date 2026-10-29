/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
const openPicker = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker: jest.fn(), isPickerOpen: () => false, openPicker }));
const adapters = await import('../../public/scripts/sillybunny-editor/adapters/utility-dialogs.js');
const { releaseRowIds } = await import('../../public/scripts/sillybunny-editor/rows.js');

function root(html) {
    const node = document.createElement('div');
    node.innerHTML = html;
    document.body.append(node);
    return node;
}
function template(path) {
    return root(readFileSync(new URL(`../../public/scripts/extensions/${path}.html`, import.meta.url), 'utf8')).firstElementChild;
}

afterEach(() => {
    openPicker.mockClear();
    releaseRowIds(document.body);
    document.body.replaceChildren();
});

test.each(['', '0', '-2', '1001', '1.8'])('spin rows preserve Popup numeric input %j without adding normalization', value => {
    const dlg = root('<div class="popup-content">Recent Chats Settings</div><div class="popup-inputs"><label class="text_label"><span data-i18n="Max recent chats">Max recent chats</span><input id="maxRecentChats" type="number" min="1" max="1000" step="1"></label></div>');
    const input = dlg.querySelector('input');
    const changed = jest.fn();
    input.addEventListener('change', changed);
    const popup = { content: dlg.querySelector('.popup-content'), inputControls: dlg.querySelector('.popup-inputs') };
    const options = adapters.utilityFormOptions({ title: 'Recent Chats Settings', clearContent: true });
    options.onOpen(popup);
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(input.value).toBe(value);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(input.closest('.ds-row-suffix')).not.toBeNull();
    expect([input.min, input.max, input.step]).toEqual(['1', '1000', '1']);
    expect(popup.content.querySelector('[data-i18n]').textContent).toBe('Max recent chats');
    options.onClose(popup);
});

test.each(['text', 'password'])('entry rows keep adopted %s input, autocomplete, IDs, values and events', type => {
    const dlg = root(`<div class="popup-content">Title</div><textarea class="popup-input" rows="1">main value</textarea><div class="popup-inputs"><label class="text_label"><span>Optional label</span><input id="extra" type="${type}" autocomplete="off" value="optional"></label></div>`);
    const mainInput = dlg.querySelector('textarea');
    const input = dlg.querySelector('input');
    const popup = { mainInput, content: dlg.querySelector('.popup-content'), inputControls: dlg.querySelector('.popup-inputs') };
    const options = adapters.utilityFormOptions({ mainLabel: 'Name', clearContent: true });
    options.onOpen(popup);
    expect(popup.content.querySelector('textarea')).toBe(mainInput);
    expect(popup.content.querySelector('input')).toBe(input);
    expect([input.type, input.autocomplete, input.value, input.id]).toEqual([type, 'off', 'optional', 'extra']);
    options.onClose(popup);
    expect(mainInput.value).toBe('main value');
});

test('image review adopts both textareas and the frame-created switch row', () => {
    const dlg = root('<div class="popup-content">Cancel to abort</div><textarea class="popup-input" rows="8">positive</textarea><div class="popup-inputs"><label class="text_label"><span>Negative prompt</span><textarea id="sd_refine_negative" rows="4">negative</textarea></label><label class="ds-row-switch"><span>Resolution</span><input id="sd_use_saved_resolution" type="checkbox" checked></label></div>');
    const popup = { mainInput: dlg.querySelector('textarea'), content: dlg.querySelector('.popup-content'), inputControls: dlg.querySelector('.popup-inputs') };
    const switchRow = dlg.querySelector('.ds-row-switch');
    const options = adapters.utilityFormOptions({ mainLabel: 'Prompt' });
    options.onOpen(popup);
    expect(popup.content.querySelectorAll('.ds-row--stacked')).toHaveLength(2);
    expect(popup.content.querySelector('.ds-row-switch')).toBe(switchRow);
    expect(dlg.querySelector('#sd_refine_negative').value).toBe('negative');
    options.onClose(popup);
});

test('regex import adopts all three radios and retains native input handlers and i18n captions', () => {
    const node = template('regex/importTarget');
    const inputs = [...node.querySelectorAll('input')];
    const attributes = inputs.map(input => [input.id, input.name, input.value]);
    const changed = jest.fn();
    inputs[1].addEventListener('input', changed);
    const options = adapters.regexImportOptions(node);
    expect(options.tier).toBe('dialog');
    expect([...node.querySelectorAll('input')]).toEqual(inputs);
    expect(inputs.map(input => [input.id, input.name, input.value])).toEqual(attributes);
    inputs[1].click();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(node.querySelectorAll('.sb-boolean-radio-option [data-i18n]')).toHaveLength(3);
    options.onClose();
});

test.each(['mediawiki', 'fandom'])('%s preserves URL/filter inputs and both output radio events', kind => {
    const node = template(`attachments/${kind}-scrape`);
    const inputs = [...node.querySelectorAll('input')];
    const attributes = inputs.map(input => [input.id, input.name, input.type, input.value]);
    const changed = jest.fn();
    inputs.at(-1).addEventListener('input', changed);
    const options = adapters.scraperDialogOptions(node, kind);
    expect(inputs.every(input => node.contains(input))).toBe(true);
    expect(inputs.map(input => [input.id, input.name, input.type, input.value])).toEqual(attributes);
    expect(node.querySelectorAll('.ds-row-entry')).toHaveLength(2);
    expect(node.querySelectorAll('.ds-toggle-row__group input')).toHaveLength(2);
    expect(node.textContent).toContain('Not recommended.');
    inputs.at(-1).click();
    expect(changed).toHaveBeenCalledTimes(1);
    options.onClose({ content: node });
});

test('Quick Reply select retains its value after cleanup and forwards transfer shortcuts once', () => {
    const node = root('<h3>Transfer Quick Reply</h3><h4>Source: Reply</h4><select autofocus><option value="">-- Select QR Set --</option><option value="target">Target</option></select><p><small>Transfer hint</small></p>');
    const select = node.querySelector('select');
    const keyboard = jest.fn();
    select.addEventListener('keydown', keyboard);
    const options = adapters.quickReplyTransferOptions(node);
    node.querySelector('button').click();
    openPicker.mock.calls[0][0].onSelect('target');
    node.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect(keyboard).toHaveBeenCalledTimes(1);
    expect(keyboard.mock.calls[0][0].shiftKey).toBe(true);
    options.onClose();
    expect(select.value).toBe('target');
    expect(node.querySelector('select')).toBe(select);
});

test('icon picker keeps the source search listener and makes every icon keyboard operable', () => {
    const node = root('<div class="faQuery-container"><input class="faQuery" type="search" placeholder="Filter icons"></div><div class="faPicker"><div title="star" data-result="1"></div></div>');
    const input = node.querySelector('input');
    const icon = node.querySelector('[data-result]');
    const clicked = jest.fn();
    icon.addEventListener('click', clicked);
    const options = adapters.iconPickerOptions(node);
    expect(node.querySelector('input')).toBe(input);
    expect(icon.getAttribute('aria-label')).toBe('star');
    icon.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(clicked).toHaveBeenCalledTimes(1);
    options.onClose();
});
