/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
const openPicker = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker: jest.fn(), isPickerOpen: () => false, openPicker }));
const adapters = await import('../../public/scripts/sillybunny-editor/adapters/misc-dialogs.js');
const { releaseRowIds } = await import('../../public/scripts/sillybunny-editor/rows.js');

const template = name => readFileSync(new URL(`../../public/scripts/templates/${name}.html`, import.meta.url), 'utf8');
function root(html) {
    const node = document.createElement('div');
    node.innerHTML = html;
    document.body.append(node);
    return node;
}
function form(name) {
    const wrapper = root(template(name));
    return wrapper.firstElementChild;
}

afterEach(() => {
    openPicker.mockClear();
    releaseRowIds(document.body);
    document.body.replaceChildren();
});

test.each([
    ['globalStylesPreference', 'creatorStylesPreferenceOptions', 2],
    ['forbidMedia', 'externalMediaOptions', 3],
])('%s adopts every radio with its original identity, name, value, events and state', (name, adapter, count) => {
    const node = form(name);
    const inputs = [...node.querySelectorAll('input')];
    const before = inputs.map(input => ({ id: input.id, name: input.name, value: input.value }));
    inputs.at(-1).checked = true;
    const inputEvent = jest.fn();
    const changeEvent = jest.fn();
    inputs[0].addEventListener('input', inputEvent);
    inputs[0].addEventListener('change', changeEvent);
    const options = adapters[adapter](node);
    expect(options.tier).toBe('dialog');
    expect([...node.querySelectorAll('input')]).toEqual(inputs);
    expect(inputs.map(input => ({ id: input.id, name: input.name, value: input.value }))).toEqual(before);
    expect(node.querySelectorAll('.sb-boolean-radio-option')).toHaveLength(count);
    expect(node.querySelector('.ds-toggle-row__group').getAttribute('aria-labelledby')).toBe(node.querySelector('.ds-row-label').id);
    expect(inputs.at(-1).checked).toBe(true);
    inputs[0].click();
    expect(inputEvent).toHaveBeenCalledTimes(1);
    expect(changeEvent).toHaveBeenCalledTimes(1);
    expect(inputs.at(-1).checked).toBe(false);
    expect(node.querySelector('[data-i18n]')).not.toBeNull();
    const retainedCaption = { globalStylesPreference: '#global_styles_preference_prompt', forbidMedia: '.forbid_media_global_state_allowed' }[name];
    expect(node.querySelector(retainedCaption)).not.toBeNull();
    options.onClose();
});

test('Custom CSS retains textarea, profile selection and radio results even after close cleanup', () => {
    const node = root('<h3>Generate Custom CSS</h3><label for="custom_css_ai_instruction"><small>Describe changes</small></label><textarea id="custom_css_ai_instruction" rows="6" placeholder="Example"></textarea><label for="custom_css_ai_profile"><small>Connection profile</small></label><select id="custom_css_ai_profile"><option value="a">Profile A</option><option value="b">Profile B</option></select><div><label><input type="radio" name="custom_css_ai_apply_mode" value="replace" checked><span>Replace current CSS</span></label><label><input type="radio" name="custom_css_ai_apply_mode" value="append"><span>Append below current CSS</span></label></div><small>AI notice</small><small>Length</small>');
    const textarea = node.querySelector('textarea');
    const select = node.querySelector('select');
    const append = node.querySelector('input[value="append"]');
    const changed = jest.fn();
    select.addEventListener('change', changed);
    const options = adapters.customCssAiOptions(node);
    expect(node.querySelector('textarea')).toBe(textarea);
    expect(textarea.rows).toBe(6);
    expect(textarea.placeholder).toBe('Example');
    expect(node.querySelectorAll('.ds-row')).toHaveLength(3);
    expect(node.querySelectorAll(':scope > small')).toHaveLength(2);
    node.querySelector('.ds-select-row__trigger').click();
    openPicker.mock.calls[0][0].onSelect('b');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(select.value).toBe('b');
    append.click();
    options.onClose();
    expect(node.querySelector('select')).toBe(select);
    expect(select.value).toBe('b');
    expect(node.querySelector('input:checked').value).toBe('append');
});

test.each(['', '-1', '999', '1.8', '1suffix', ' 1 '])('screenshot spin rows preserve raw text %j for upstream parseInt and rejection', value => {
    const dlg = root('<div class="popup-content"></div><div class="popup-inputs"><label class="text_label"><span data-i18n="Start ID">Start ID</span><input id="start" type="text" value="1" title="0-4"></label><label class="text_label"><span>End ID</span><input id="end" type="text" value="1"></label></div>');
    const start = dlg.querySelector('#start');
    const popup = { dlg, content: dlg.querySelector('.popup-content'), inputControls: dlg.querySelector('.popup-inputs') };
    const options = adapters.messageScreenshotOptions({ startId: 'start', endId: 'end' });
    options.onOpen(popup);
    start.value = value;
    start.dispatchEvent(new Event('input', { bubbles: true }));
    start.dispatchEvent(new Event('change', { bubbles: true }));
    expect(start.value).toBe(value);
    expect(start.type).toBe('text');
    expect(start.closest('.ds-row-suffix')).not.toBeNull();
    expect(popup.inputControls.children).toHaveLength(0);
    expect(start.closest('.popup-content')).not.toBeNull();
    options.onClose(popup);
});

test('install rows move Popup mainInput and custom branch without dropping post-close collection', () => {
    const node = root(template('installExtension'));
    const dlg = root('<textarea class="popup-input">https://example.test/repo</textarea><div class="popup-inputs"><label><span data-i18n="Branch or tag name (optional)">Branch or tag name (optional)</span><input id="extension_branch_name" value="feature/tag"></label></div>');
    const popup = { mainInput: dlg.querySelector('textarea'), inputControls: dlg.querySelector('div') };
    const url = popup.mainInput;
    const branch = dlg.querySelector('input');
    const options = adapters.installExtensionOptions(node);
    options.onOpen(popup);
    expect(node.querySelector('textarea')).toBe(url);
    expect(node.querySelector('input')).toBe(branch);
    expect(node.textContent).toContain('security risks');
    expect(node.querySelector(':scope > br')).toBeNull();
    options.onClose();
    expect(node.querySelector('#extension_branch_name').value).toBe('feature/tag');
    expect(popup.mainInput.value).toBe('https://example.test/repo');
});

test('branch select stays native, keeps selected commit, emits change once, and disposes its picker', () => {
    const dlg = root('<div class="popup-content"><select><option value="main" selected>Main commit</option><option value="dev">Dev commit</option></select></div>');
    const select = dlg.querySelector('select');
    const changed = jest.fn();
    select.addEventListener('change', changed);
    const options = adapters.switchBranchOptions(select);
    options.onOpen({ content: dlg.querySelector('.popup-content') });
    expect(select.value).toBe('main');
    dlg.querySelector('button').click();
    openPicker.mock.calls[0][0].onSelect('dev');
    expect(changed).toHaveBeenCalledTimes(1);
    options.onClose();
    expect(select.value).toBe('dev');
    expect(select.classList.contains('ds-select-row__native')).toBe(false);
});

test.each(['changePassword', 'deleteUser', 'resetSettings', 'userReset'])('%s retains field names, types, autocomplete, values and native events', name => {
    const node = form(name);
    const inputs = [...node.querySelectorAll('input')];
    const before = inputs.map(input => ({ name: input.name, type: input.type, autocomplete: input.autocomplete }));
    const changed = jest.fn();
    inputs.forEach(input => input.addEventListener('input', changed));
    if (name === 'changePassword') node.querySelector('.currentPasswordBlock').style.display = 'none';
    const options = adapters.accountFormOptions(node, { destructive: name !== 'changePassword' });
    expect([...node.querySelectorAll('input')]).toEqual(inputs);
    expect(inputs.map(input => ({ name: input.name, type: input.type, autocomplete: input.autocomplete }))).toEqual(before);
    for (const input of inputs.filter(input => input.type !== 'checkbox')) {
        expect(input.closest('.ds-row-entry')).not.toBeNull();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(node.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    }
    expect(changed).toHaveBeenCalledTimes(inputs.filter(input => input.type !== 'checkbox').length);
    expect(node.querySelector('.currentPasswordBlock')?.style.display ?? null).toBe({ changePassword: 'none', userReset: '', deleteUser: null, resetSettings: null }[name]);
    expect(node.querySelectorAll('input[type="checkbox"]')).toHaveLength(name === 'deleteUser' ? 1 : 0);
    const okButton = document.createElement('button');
    options.onOpen({ okButton });
    expect(okButton.classList.contains('is-destructive')).toBe(name !== 'changePassword');
    options.onClose();
});

test('upstream seams keep result parsing, intercepted request contracts and destructive defaults', () => {
    const read = name => readFileSync(new URL(`../../public/${name}`, import.meta.url), 'utf8');
    const core = read('script.js');
    expect(core).toContain('...dialogOptions');
    expect(core).toContain('Number.parseInt(String(startInput instanceof HTMLInputElement ? startInput.value');
    const user = read('scripts/user.js');
    expect(user.match(/defaultResult: POPUP_RESULT.NEGATIVE/g)).toHaveLength(4);
    expect(user.match(/accountFormOptions\(template/g)).toHaveLength(4);
    expect(user).toContain('JSON.stringify({ handle, newPassword, oldPassword })');
    expect(user).toContain('JSON.stringify({ handle, purge })');
    expect(user).toContain('JSON.stringify({ password, code })');
});
