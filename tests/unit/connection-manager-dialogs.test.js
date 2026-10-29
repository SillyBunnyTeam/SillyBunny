/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
const { adaptProfileDeletion, adaptProfileDetails, adaptProfileFolders, createProfileChoices, profileDialogOptions, releaseProfileDialog } = await import('../../public/scripts/extensions/connection-manager/sillybunny-dialogs.js');

function root(html) {
    const node = document.createElement('div');
    node.innerHTML = html;
    document.body.append(node);
    return node;
}

function choices(count, checked = true) {
    return Array.from({ length: count }, (_, index) => `<label class="checkbox_label"><input type="checkbox" name="exclude" value="id-${index}" ${checked ? 'checked' : ''}><span data-i18n="Label">Label ${index}</span></label>`).join('');
}

afterEach(() => {
    releaseProfileDialog(document.body);
    document.body.replaceChildren();
});

describe('Connection Manager dialog adapters', () => {
    test('adopts checks and their i18n captions without changing values, listeners or checked state', () => {
        const node = root(choices(3));
        const input = node.querySelector('input');
        const caption = node.querySelector('span');
        const onInput = jest.fn();
        input.addEventListener('input', onInput);
        const group = createProfileChoices(node);
        node.replaceChildren(group.section);
        expect(node.querySelector('input')).toBe(input);
        expect(input.name).toBe('exclude');
        expect(input.value).toBe('id-0');
        expect(input.checked).toBe(true);
        expect(input.getAttribute('role')).toBeNull();
        expect(input.parentElement.lastElementChild).toBe(input);
        expect(node.querySelector('[data-i18n="Label"]')).toBe(caption);
        input.click();
        expect(onInput).toHaveBeenCalledTimes(1);
        expect(node.querySelector('[data-sb-editor-field="select-all"]')).toBeNull();
    });

    test('Select All reports input changes once per changed choice and tracks mixed state', () => {
        const node = root(choices(6));
        const inputs = [...node.querySelectorAll('input')];
        const onInput = jest.fn();
        inputs.forEach(input => input.addEventListener('input', onInput));
        node.replaceChildren(createProfileChoices(node).section);
        const all = node.querySelector('[data-sb-editor-field="select-all"] input');
        expect(all.checked).toBe(true);
        inputs[0].click();
        expect(all.indeterminate).toBe(true);
        all.click();
        expect(all.indeterminate).toBe(false);
        expect(inputs.every(input => input.checked)).toBe(true);
        expect(onInput).toHaveBeenCalledTimes(2);
        all.click();
        expect(inputs.every(input => !input.checked)).toBe(true);
        expect(onInput).toHaveBeenCalledTimes(8);
        all.click();
        expect(inputs.every(input => input.checked)).toBe(true);
        expect(onInput).toHaveBeenCalledTimes(14);
        expect(all.name).toBe('');
    });

    test.each([false, true])('profile form retains name and folder controls (edit=%s)', edit => {
        const node = root(`${edit ? '<h3>Folder:</h3><select id="profile_folder_select"><option value="folder">Folder</option></select><h3 data-i18n="Included settings:">Included settings:</h3>' : '<h2 data-i18n="Creating a Connection Profile">Creating a Connection Profile</h2>'}${choices(6)}<small><b data-i18n="Hint:">Hint:</b> <i data-i18n="Keep selected">Keep selected</i></small><h3 data-i18n="Profile name:">Profile name:</h3>`);
        const folder = node.querySelector('select');
        const options = profileDialogOptions(node, { edit });
        const input = document.createElement('textarea');
        input.className = 'popup-input';
        input.value = 'Profile';
        options.onOpen({ mainInput: input });
        expect(options.tier).toBe('dialog');
        expect(options.okButton).toBe('Save');
        expect(node.querySelector('textarea')).toBe(input);
        expect(node.querySelector('[data-sb-editor-field="profile-name"] label').textContent).toBe('Profile name:');
        expect(node.querySelector('.ds-pref-group-subtitle').textContent).toBe('Hint: Keep selected');
        expect(node.querySelector('.ds-pref-group-subtitle [data-i18n="Keep selected"]')).not.toBeNull();
        expect(node.querySelector('select')).toBe(folder);
        expect(folder?.value).toBe(edit ? 'folder' : undefined);
        expect(options.title).toBe(edit ? 'Edit a connection profile' : undefined);
        options.onClose();
    });

    test('deletion keeps the selected IDs and destructive styling', () => {
        const node = root(`<div>Select profiles</div>${choices(7, false)}`);
        const options = adaptProfileDeletion(node);
        const okButton = document.createElement('button');
        options.onOpen({ okButton });
        expect(okButton.classList.contains('is-destructive')).toBe(true);
        node.querySelector('[value="id-3"]').click();
        expect([...node.querySelectorAll('input[name="exclude"]:checked')].map(input => input.value)).toEqual(['id-3']);
        options.onClose();
    });

    test('folder rows preserve handler ancestry and provide keyboard deletion', () => {
        const node = root('<h3>Manage Profile Folders</h3><div class="folder-item" data-folder-id="folder"><input class="folder-name-input" data-original-name="Original" type="text" value="Original"><span class="folder-profile-count">(2 profiles)</span><i class="folder-delete-btn" title="Delete folder"></i></div><input id="new_profile_folder_name" type="text" placeholder="New folder name"><button id="add_new_folder">Add Folder</button><small>Deletion note</small>');
        const input = node.querySelector('.folder-name-input');
        const remove = node.querySelector('.folder-delete-btn');
        const add = node.querySelector('#add_new_folder');
        const onRemove = jest.fn();
        remove.addEventListener('click', onRemove);
        adaptProfileFolders(node);
        expect(node.querySelector('.folder-name-input')).toBe(input);
        expect(input.closest('.folder-item').dataset.folderId).toBe('folder');
        expect(input.dataset.originalName).toBe('Original');
        expect(node.querySelector('#add_new_folder')).toBe(add);
        expect(remove.getAttribute('aria-label')).toBe('Delete folder');
        remove.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(node.querySelector('h3')).toBeNull();
    });

    test('empty folder state and creation remain available', () => {
        const node = root('<h3>Folders</h3><div class="folder-empty-message">No folders yet.</div><input id="new_profile_folder_name" type="text" placeholder="New folder name"><button id="add_new_folder">Add Folder</button><small>Note</small>');
        adaptProfileFolders(node);
        expect(node.querySelector('.folder-empty-message').textContent).toBe('No folders yet.');
        expect(node.querySelector('#new_profile_folder_name')).not.toBeNull();
    });

    test('details keep summary selectors, translated labels, safe text and omitted values', () => {
        const node = root('<ul><li><strong class="profile-summary-label" data-i18n="API">API</strong><span class="profile-summary-value">&lt;b&gt;untrusted&lt;/b&gt;</span></li></ul><div><strong data-sb-profile-copy="true">Saved snapshot</strong></div><ul><li><strong class="profile-summary-label">Agents</strong><span class="profile-summary-value">None</span></li></ul><div><strong data-i18n="Omitted Settings:">Omitted Settings:</strong><span>Model</span></div>');
        adaptProfileDetails(node);
        expect(node.querySelectorAll('.ds-row-property')).toHaveLength(3);
        expect(node.querySelector('.profile-summary-value').textContent).toBe('<b>untrusted</b>');
        expect(node.querySelector('b')).toBeNull();
        expect(node.querySelector('[data-sb-profile-copy]').textContent).toBe('Saved snapshot');
        expect(node.querySelectorAll('strong.profile-summary-label')).toHaveLength(2);
        expect(node.querySelector('[data-sb-editor-field="omitted-settings"] .ds-row-property__value').textContent).toBe('Model');
    });

    test('upstream entry points opt into adapters before constructing Popup', () => {
        const source = readFileSync(new URL('../../public/scripts/extensions/connection-manager/index.js', import.meta.url), 'utf8');
        expect(source).toContain('suggestedName, profileDialogOptions(template[0])');
        expect(source).toContain('...profileDialogOptions(template[0], { edit: true })');
        expect(source).toContain('...adaptProfileDeletion(html[0])');
        expect(source).toContain('defaultResult: POPUP_RESULT.NEGATIVE');
        expect(source).toContain('adaptProfileFolders(template[0]);');
        expect(source).toContain('adaptProfileDetails(details[0]);');
    });
});
