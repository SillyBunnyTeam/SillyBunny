/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join(''), translate: value => value }));
const adapters = await import('../../public/scripts/sillybunny-editor/adapters/window-content-dialogs.js');
const { releaseRowIds } = await import('../../public/scripts/sillybunny-editor/rows.js');

function root(html) {
    const node = document.createElement('div');
    node.innerHTML = html;
    document.body.append(node);
    return node;
}

function template(name) {
    return readFileSync(new URL(`../../public/scripts/templates/${name}.html`, import.meta.url), 'utf8');
}

afterEach(() => {
    releaseRowIds(document.body);
    document.body.replaceChildren();
});

test('account profile uses the Dialog title and keeps its existing controls', () => {
    const node = root(template('userProfile')).firstElementChild;
    const heading = node.querySelector('h3[data-i18n="Account Info"]');
    const changeName = node.querySelector('.userChangeNameButton');
    const options = adapters.accountProfileOptions(node);

    expect(options.tier).toBe('dialog');
    expect(options.title).toBe('Account Info');
    expect(heading.isConnected).toBe(false);
    expect(node.querySelector('.userChangeNameButton')).toBe(changeName);
    options.onClose();
});

test('snapshots keep the existing action and decorate dynamically appended entries', async () => {
    const node = root(template('snapshotsView')).firstElementChild;
    const action = node.querySelector('.makeSnapshotButton');
    const heading = node.querySelector(':scope > h3');
    const options = adapters.snapshotsOptions(node);
    const snapshot = document.createElement('div');
    snapshot.className = 'snapshot';

    node.querySelector('.snapshotList').append(snapshot);
    await Promise.resolve();

    expect(options.tier).toBe('window');
    expect(options.title).toBe('Settings Snapshots');
    expect(node.querySelector(':scope > h3')).toBeNull();
    expect(node.querySelector('.makeSnapshotButton')).toBe(action);
    expect(action.previousElementSibling).toBeNull();
    expect(snapshot.classList.contains('ds-pref-group')).toBe(true);
    options.onClose();
    expect(node.querySelector('.makeSnapshotButton')).toBe(action);
    expect(heading.isConnected).toBe(false);
});

test('admin adopts four new-user fields without changing types, attributes, listeners or submit identity', () => {
    const node = root(template('admin')).firstElementChild;
    const form = node.querySelector('.userCreateForm');
    const submit = form.querySelector('.newUserRegisterFinalizeButton');
    const fields = [...form.querySelectorAll('input[name]')];
    const metadata = fields.map(input => ({ name: input.name, type: input.type, autocomplete: input.autocomplete, pattern: input.pattern }));
    const inputListener = jest.fn();
    fields.forEach(input => input.addEventListener('input', inputListener));
    const options = adapters.adminPanelOptions(node);

    expect(options.tier).toBe('window');
    expect(options.title).toBe('Manage Users');
    expect(form.querySelectorAll('.ds-row-entry')).toHaveLength(4);
    expect([...form.querySelectorAll('input[name]')]).toEqual(fields);
    expect(fields.map(input => ({ name: input.name, type: input.type, autocomplete: input.autocomplete, pattern: input.pattern }))).toEqual(metadata);
    expect(fields.map(input => input.type)).toEqual(['text', 'text', 'password', 'password']);
    expect(fields.slice(2).map(input => input.autocomplete)).toEqual(['new-password', 'new-password']);
    expect(fields[0].autocomplete).toBe('username');
    expect(fields[1].pattern).toBe('[a-z0-9-]+');
    fields[0].dispatchEvent(new Event('input', { bubbles: true }));
    expect(inputListener).toHaveBeenCalledTimes(1);
    expect(form.querySelector('.newUserRegisterFinalizeButton')).toBe(submit);
    options.onClose();
});

test('scenario override rows adopt source textareas, headings, and input listeners', () => {
    const node = root(template('scenarioOverride')).firstElementChild;
    const textareas = [...node.querySelectorAll('textarea')];
    const headings = [...node.querySelectorAll('h4')];
    const maximizeButtons = [...node.querySelectorAll('.editor_maximize')];
    const inputListener = jest.fn();
    textareas[0].addEventListener('input', inputListener);
    textareas.forEach((textarea, index) => { textarea.value = `Initial ${index}`; });
    const options = adapters.scenarioOverrideOptions(node);

    expect(options.tier).toBe('window');
    expect(node.querySelectorAll('.ds-row--stacked')).toHaveLength(3);
    expect(node.querySelectorAll('.ds-row--stacked.sb-window-stacked-textarea textarea')).toHaveLength(3);
    expect([...node.querySelectorAll('textarea')]).toEqual(textareas);
    expect(node.querySelectorAll('.editor_maximize')).toHaveLength(3);
    expect(maximizeButtons.every(button => node.contains(button))).toBe(true);
    expect(headings.every(heading => !heading.isConnected)).toBe(true);
    expect(textareas.map(textarea => textarea.value)).toEqual(['Initial 0', 'Initial 1', 'Initial 2']);
    textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
    expect(inputListener).toHaveBeenCalledTimes(1);
    options.onClose();
});

test('custom endpoint rows preserve YAML strings, native select semantics, and reasoning inputs', () => {
    const node = root(template('customEndpointAdditionalParameters')).firstElementChild;
    const textareas = [...node.querySelectorAll('textarea')];
    const selects = [...node.querySelectorAll('select')];
    const inputs = [...node.querySelectorAll('input')];
    const ids = [...textareas, ...selects, ...inputs].map(control => control.id);
    const inputListener = jest.fn();
    const changeListener = jest.fn();
    textareas.forEach(textarea => textarea.addEventListener('input', inputListener));
    selects.forEach(select => select.addEventListener('change', changeListener));
    textareas[0].value = 'top_k: 20\nrepetition_penalty: 1.1';
    const valuesWrapper = node.querySelector('.sb-custom-reasoning-toggle-values');
    const options = adapters.customEndpointParametersOptions(node);

    expect(options.tier).toBe('window');
    expect(node.querySelectorAll('.ds-row--stacked textarea')).toHaveLength(3);
    expect(node.querySelectorAll('.ds-row--stacked.sb-window-stacked-textarea textarea')).toHaveLength(3);
    expect([...node.querySelectorAll('textarea')]).toEqual(textareas);
    expect([...node.querySelectorAll('select')]).toEqual(selects);
    expect([...node.querySelectorAll('input')]).toEqual(inputs);
    expect([...textareas, ...selects, ...inputs].map(control => control.id)).toEqual(ids);
    expect(textareas[0].value).toBe('top_k: 20\nrepetition_penalty: 1.1');
    expect(selects.every(select => select.closest('.ds-row-suffix'))).toBe(true);
    expect(node.querySelector('.ds-pref-group-heading').textContent).toBe('Reasoning Parameter Preset');
    expect(node.querySelector('.sb-custom-reasoning-toggle-values')).toBe(valuesWrapper);
    textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    expect(inputListener).toHaveBeenCalledTimes(1);
    expect(changeListener).toHaveBeenCalledTimes(1);
    options.onClose();
});
