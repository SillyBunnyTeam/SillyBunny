/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
const openPicker = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker: jest.fn(), isPickerOpen: () => false, openPicker }));
const { adaptQuickReplyEditor } = await import('../../public/scripts/extensions/quick-reply/src/sillybunny-editor.js');

function template() {
    document.body.innerHTML = readFileSync(new URL('../../public/scripts/extensions/quick-reply/html/qrEditor.html', import.meta.url), 'utf8');
    return document.querySelector('#qr--modalEditor');
}

afterEach(() => {
    openPicker.mockClear();
    document.body.replaceChildren();
});

test('editor adopts every control and preserves debugger structural selectors and live input events', () => {
    const root = template();
    const controls = [...root.querySelectorAll('input, textarea')];
    const attributes = controls.map(input => [input.id, input.name, input.type, input.value, input.min, input.max]);
    const messageHolder = root.querySelector('#qr--modal-messageHolder');
    const messageSettings = root.querySelector('.qr--modal-editorSettings');
    const message = root.querySelector('#qr--modal-message');
    const input = root.querySelector('#qr--modal-label');
    const changed = jest.fn();
    input.addEventListener('input', changed);
    const editor = adaptQuickReplyEditor(root);
    expect(editor.options.tier).toBe('window');
    expect(editor.options.title).toBe('Quick Reply');
    expect(controls.every(control => root.contains(control))).toBe(true);
    expect(controls.map(control => [control.id, control.name, control.type, control.value, control.min, control.max])).toEqual(attributes);
    expect(root.querySelector('#qr--main > .qr--modal-messageContainer > #qr--modal-messageHolder')).toBe(messageHolder);
    expect(root.querySelector('#qr--main > .qr--modal-messageContainer > .qr--modal-editorSettings')).toBe(messageSettings);
    expect(root.querySelector('.qr--ctxEditorActions + h3 + #qr--autoExec')).not.toBeNull();
    expect(root.querySelector('label[for="qr--modal-message"]')).not.toBeNull();
    expect(root.querySelector('#qr--modal-message')).toBe(message);
    input.value = '  literal whitespace  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('  literal whitespace  ');
    expect(root.querySelectorAll('.checkbox_label.ds-row-switch')).toHaveLength(13);
    for (const row of root.querySelectorAll('.ds-row-switch')) expect(row.lastElementChild.matches('input[type="checkbox"][role="switch"]')).toBe(true);
    editor.options.onClose();
});

test.each(['', '0', '-2', '10', '1.5'])('tab size %j is not normalized by the adapter', value => {
    const root = template();
    const editor = adaptQuickReplyEditor(root);
    const input = root.querySelector('#qr--modal-tabSize');
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(input.value).toBe(value);
    expect([input.min, input.max]).toEqual(['1', '9']);
    editor.options.onClose();
});

test('dynamic context rows keep source select, chain label and existing click/change handlers', () => {
    const root = template();
    const item = root.querySelector('#qr--ctxItem').content.firstElementChild.cloneNode(true);
    const select = item.querySelector('select');
    select.innerHTML = '<option value="a">A</option><option value="b">B</option>';
    const chain = item.querySelector('.qr--isChained');
    const chainLabel = chain.parentElement;
    const changed = jest.fn();
    const clicked = jest.fn();
    select.addEventListener('change', changed);
    chain.addEventListener('click', clicked);
    const editor = adaptQuickReplyEditor(root);
    editor.adoptContextItem(item);
    root.querySelector('#qr--ctxEditor').append(item);
    expect(item.querySelector('select.qr--set')).toBe(select);
    expect(item.querySelector('.qr--isChainedLabel')).toBe(chainLabel);
    item.querySelector('.ds-select-row__trigger').click();
    openPicker.mock.calls[0][0].onSelect('b');
    expect(select.value).toBe('b');
    expect(changed).toHaveBeenCalledTimes(1);
    chainLabel.click();
    expect(chain.checked).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    editor.options.onClose();
    expect(select.value).toBe('b');
});

test('invalid template fails at the adapter boundary', () => {
    expect(() => adaptQuickReplyEditor(null)).toThrow('source template');
});
