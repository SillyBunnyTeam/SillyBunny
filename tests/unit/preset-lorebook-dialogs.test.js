/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { importWorldInfoModule } from '../util/world-info-module-harness.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
const cachedJQuerySource = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
const openPicker = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker: jest.fn(), isPickerOpen: () => false, openPicker }));
const realDialogs = await import('../../public/scripts/sillybunny-editor/adapters/preset-lorebook-dialogs.js');
const { embeddedLorebookOptions, lorebookSelectOptions, lorebookSortingOptions, presetChoicesOptions } = realDialogs;
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
    expect(input.parentElement.firstElementChild).toBe(input);
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
    expect(options.title).toBe('Delete Selected');
    const okButton = document.createElement('button');
    options.onOpening({ okButton });
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
    options.onOpening({ dlg, inputControls: dlg.querySelector('.popup-inputs') });
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
    options.onOpening({ dlg, inputControls: dlg.querySelector('.popup-inputs') });
    expect(node.querySelector('.ds-row-switch')).toBe(row);
    expect(node.querySelector('#wi_sort_ascending').getAttribute('aria-describedby')).toBe('ascending-help');
    expect(document.getElementById('ascending-help')).not.toBeNull();
    options.onClose();
});

test.each([
    ['wi_sort_start', '', ''],
    ['wi_sort_start', '-5', '0'],
    ['wi_sort_start', '0', '0'],
    ['wi_sort_step', '', ''],
    ['wi_sort_step', '0', '1'],
    ['wi_sort_step', '5', '5'],
])('%s changes %j to %j with upstream empty-value and clamping semantics', (id, value, expected) => {
    const node = root('<div class="warning"></div>');
    const dlg = root(`<div class="popup-inputs"><input id="${id}" type="number" min="${id === 'wi_sort_step' ? 1 : 0}" value="100"></div>`);
    dlg.append(node);
    const options = lorebookSortingOptions(node, [{ id, type: 'number', label: id }]);
    options.onOpening({ dlg, inputControls: dlg.querySelector('.popup-inputs') });
    const input = dlg.querySelector('input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(input.value).toBe(expected);
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

test('preset-manager entry points wire presetChoicesOptions, exclude Select All and default deletion to Cancel', async () => {
    if (!globalThis.window.jQuery) {
        (0, eval)(cachedJQuerySource);
    }
    const $ = globalThis.window.jQuery;
    globalThis.$ = $;
    globalThis.jQuery = $;
    globalThis.toastr = { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() };
    document.body.innerHTML = `
        <select id="settings_preset_openai" data-preset-manager-for="openai">
            <option value="0">Preset 0</option>
            <option value="1">Preset 1</option>
            <option value="2">Preset 2</option>
            <option value="3">Preset 3</option>
            <option value="4">Preset 4</option>
            <option value="5">Preset 5</option>
        </select>
        <select id="instruct_presets" data-preset-manager-for="instruct"><option value="0">Default</option></select>
        <select id="context_presets" data-preset-manager-for="context"><option value="0">Default</option></select>
        <select id="sysprompt_select" data-preset-manager-for="sysprompt"><option value="0">Default</option></select>
        <select id="reasoning_select" data-preset-manager-for="reasoning"><option value="0">Default</option></select>
        <select id="settings_preset_textgenerationwebui" data-preset-manager-for="textgenerationwebui"><option value="0">Default</option></select>
    `;

    const popupCalls = [];
    const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
    const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3 };
    const PopupMock = jest.fn(function (content, type, inputValue, options) {
        this.content = content;
        this.type = type;
        this.options = options;
        popupCalls.push({ content, type, options });
        this.show = jest.fn(async () => {
            // Check every checkbox including Select All so the caller must filter out Select All.
            const selectAll = content[0]?.querySelector?.('[data-sb-select-all]');
            if (selectAll && !selectAll.checked) {
                selectAll.click();
            }
            content.find('input[type="checkbox"]').prop('checked', true);
            return POPUP_RESULT.AFFIRMATIVE;
        });
    });

    const presetChoicesSpy = jest.fn((...args) => presetChoicesOptions(...args));
    const renderTemplateAsync = jest.fn(async (name, { sections }) => {
        const rows = Object.values(sections).map(section => `
            <label class="checkbox_label">
                <input type="checkbox" value="${section.key}" ${section.checked !== false ? 'checked' : ''} />
                <span>${section.name}</span>
            </label>
        `).join('');
        return `<div class="${name}">${rows}</div>`;
    });

    jest.resetModules();
    await jest.unstable_mockModule(pub('lib.js'), () => ({ Fuse: class {}, lodash: { isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b) } }));
    await jest.unstable_mockModule(pub('script.js'), () => ({
        amount_gen: 100,
        characters: [],
        eventSource: { on: jest.fn(), emit: jest.fn(async () => {}) },
        event_types: { SETTINGS_LOADED: 's', APP_READY: 'a', PRESET_CHANGED: 'p', PRESET_DELETED: 'd' },
        getRequestHeaders: () => ({}),
        koboldai_setting_names: [],
        koboldai_settings: [],
        main_api: 'openai',
        max_context: 4096,
        nai_settings: {},
        novelai_setting_names: [],
        novelai_settings: [],
        online_status: 'connected',
        saveSettings: jest.fn(async () => {}),
        saveSettingsDebounced: jest.fn(),
        this_chid: undefined,
    }));
    await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({ groups: [], selected_group: null }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({ t: parts => parts.join('') }));
    await jest.unstable_mockModule(pub('scripts/instruct-mode.js'), () => ({ instruct_presets: [{ name: 'Default', input_sequence: '', output_sequence: '' }] }));
    await jest.unstable_mockModule(pub('scripts/kai-settings.js'), () => ({ kai_settings: {} }));
    await jest.unstable_mockModule(pub('scripts/nai-settings.js'), () => ({ convertNovelPreset: v => v }));
    await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({
        getChatCompletionPreset: () => ({}),
        getPresetApplicationPromise: () => Promise.resolve(),
        oai_settings: {},
        openai_setting_names: { 'Preset 0': 0, 'Preset 1': 1, 'Preset 2': 2, 'Preset 3': 3, 'Preset 4': 4, 'Preset 5': 5 },
        openai_settings: Array.from({ length: 6 }, () => ({})),
    }));
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({ POPUP_RESULT, POPUP_TYPE, Popup: PopupMock }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({ confirmVerb: jest.fn(async () => true) }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/preset-lorebook-dialogs.js'), () => ({
        ...realDialogs,
        presetChoicesOptions: presetChoicesSpy,
    }));
    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
        context_presets: [{ name: 'Default', story_string: '' }],
        getContextSettings: () => ({}),
        power_user: { disable_preset_autosave: false },
    }));
    await jest.unstable_mockModule(pub('scripts/reasoning.js'), () => ({
        reasoning_templates: [{ name: 'Default', prefix: '', suffix: '', separator: '' }],
    }));
    await jest.unstable_mockModule(pub('scripts/sysprompt.js'), () => ({
        checkForSystemPromptInInstructTemplate: jest.fn(),
        system_prompts: [{ name: 'Default', content: '' }],
    }));
    await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({ renderTemplateAsync }));
    await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({
        getTextCompletionPresetSettings: () => ({}),
        textgenerationwebui_settings: {},
        textgenerationwebui_preset_names: ['Default'],
        textgenerationwebui_presets: [{ temp: 1, top_k: 0, top_p: 1, rep_pen: 1 }],
    }));
    await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
        download: jest.fn(),
        ensurePlainObject: v => v ?? {},
        equalsIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase(),
        getSanitizedFilename: v => String(v ?? ''),
        parseJsonFile: jest.fn(async () => ({})),
        waitUntilCondition: jest.fn(async () => {}),
    }));
    const enumProxy = new Proxy({}, { get: () => jest.fn(() => []) });
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({ SlashCommand: { fromProps: jest.fn(p => p) } }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => ({
        ARGUMENT_TYPE: { STRING: 'string' },
        SlashCommandArgument: { fromProps: jest.fn(p => p) },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        enumIcons: new Proxy({}, { get: () => '' }),
        commonEnumProviders: enumProxy,
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        SlashCommandEnumValue: class {},
        enumTypes: { enum: 'enum' },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser: { addCommandObject: jest.fn() },
    }));

    const presetManagerMod = await import('../../public/scripts/preset-manager.js');
    await presetManagerMod.initPresetManager();
    const openaiManager = presetManagerMod.getPresetManager('openai');
    const PresetManager = openaiManager.constructor;

    // 1. Master import uses presetChoicesOptions and ignores Select All when importing sections.
    const savedSections = [];
    const originalMasterSections = PresetManager.masterSections;
    PresetManager.masterSections = Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [`sec${index}`, {
            name: `Section ${index}`,
            isValid: () => true,
            getData: () => ({ id: index }),
            setData: jest.fn(async value => savedSections.push([`sec${index}`, value])),
        }]),
    );
    try {
        const importData = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`sec${index}`, { name: `P${index}` }]));
        await PresetManager.performMasterImport(importData, 'master.json');
        expect(presetChoicesSpy).toHaveBeenCalledTimes(1);
        expect(savedSections.map(([key]) => key)).toEqual(['sec0', 'sec1', 'sec2', 'sec3', 'sec4', 'sec5']);

        // 2. Master export uses presetChoicesOptions and never emits a key for Select All.
        const exportedJson = await PresetManager.performMasterExport();
        expect(presetChoicesSpy).toHaveBeenCalledTimes(2);
        expect(Object.keys(JSON.parse(exportedJson))).toEqual(['sec0', 'sec1', 'sec2', 'sec3', 'sec4', 'sec5']);
    } finally {
        PresetManager.masterSections = originalMasterSections;
    }

    // 3. Bulk deletion passes { deletion: true } + defaultResult: NEGATIVE and excludes Select All from result.
    const selectedForDelete = await openaiManager.selectPresetsForDeletion();
    expect(presetChoicesSpy).toHaveBeenCalledTimes(3);
    expect(presetChoicesSpy).toHaveBeenLastCalledWith(expect.any(HTMLElement), { deletion: true });
    expect(popupCalls.at(-1).options.defaultResult).toBe(POPUP_RESULT.NEGATIVE);
    expect(selectedForDelete).toEqual(['Preset 0', 'Preset 1', 'Preset 2', 'Preset 3', 'Preset 4', 'Preset 5']);
    delete globalThis.toastr;
});

test('world-info entry points wire lorebookSortingOptions, embeddedLorebookOptions and lorebookSelectOptions', async () => {
    document.body.innerHTML = `
        <button id="world_apply_current_sorting"></button>
        <button id="world_batch_import_embedded"></button>
        <select id="world_editor_select"><option value="0">LoreA</option></select>
        <div id="world_popup_entries_list"></div>
        <div id="world_info_pagination"></div>
    `;
    const sortingSpy = jest.fn((...args) => lorebookSortingOptions(...args));
    const embeddedSpy = jest.fn((...args) => embeddedLorebookOptions(...args));
    const selectSpy = jest.fn((...args) => lorebookSelectOptions(...args));
    const chatLorebookHtml = readFileSync(new URL('../../public/scripts/templates/chatLorebook.html', import.meta.url), 'utf8');

    const alice = { name: 'Alice', avatar: 'alice.png', data: { character_book: { name: 'AliceBook', entries: [{ keys: ['a'], content: 'x' }] } } };
    const loaded = await importWorldInfoModule({
        world_names: ['LoreA'],
        characters: [alice],
        script: {
            getEntitiesList: jest.fn(() => [{ type: 'character', id: 0, item: alice }]),
        },
        fetch: jest.fn(async (url) => {
            if (url === '/api/worldinfo/get') {
                return { ok: true, json: async () => ({ entries: { 0: { uid: 0, key: ['a'], content: 'body', order: 100 } } }) };
            }
            return { ok: true, json: async () => ({ name: 'AliceBook' }) };
        }),
        presetLorebookDialogs: {
            lorebookSortingOptions: sortingSpy,
            embeddedLorebookOptions: embeddedSpy,
            lorebookSelectOptions: selectSpy,
        },
        renderTemplateAsync: jest.fn(async name => (name === 'chatLorebook' ? chatLorebookHtml : '<div></div>')),
    });
    const { worldInfo, $, mocks } = loaded;
    mocks.script.getEntitiesList.mockReturnValue([{ type: 'character', id: 0, item: alice }]);
    mocks.popup.callGenericPopup.mockResolvedValue(0);
    mocks.popup.Popup.mockImplementation(function (content, type, inputValue, options) {
        this.dlg = document.createElement('div');
        this.dlg.innerHTML = '<div class="popup-inputs"><input id="wi_sort_start" type="number" value="100"><input id="wi_sort_step" type="number" value="1"><input id="wi_sort_ascending" type="checkbox"></div>';
        this.dlg.append(content);
        this.inputResults = new Map();
        this.options = options;
        this.show = jest.fn(async () => 0);
    });

    // 1. Apply Current Sorting wires lorebookSortingOptions(contentEl, customInputs).
    worldInfo.setWorldInfoSettings({}, { world_names: ['LoreA'] });
    worldInfo.initWorldInfo();
    $('#world_editor_select').val('0').trigger('change');
    for (let i = 0; i < 15; i++) await Promise.resolve();
    $('#world_apply_current_sorting').trigger('click');
    await Promise.resolve();
    expect(sortingSpy).toHaveBeenCalledTimes(1);
    expect(sortingSpy.mock.calls[0][1]).toHaveLength(3);

    // 2. Batch import embedded lorebooks wires embeddedLorebookOptions(contentEl).
    await worldInfo.importEmbeddedWorldInfoBatch();
    expect(embeddedSpy).toHaveBeenCalledTimes(1);
    expect(mocks.popup.callGenericPopup).toHaveBeenCalledWith(
        expect.anything(),
        mocks.popup.POPUP_TYPE.CONFIRM,
        '',
        expect.objectContaining({ tier: 'dialog' }),
    );

    // 3. Assign lorebook to chat wires lorebookSelectOptions(template[0]).
    await worldInfo.assignLorebookToChat({ shiftKey: true, altKey: false });
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(mocks.popup.callGenericPopup).toHaveBeenLastCalledWith(
        expect.anything(),
        mocks.popup.POPUP_TYPE.TEXT,
        '',
        expect.objectContaining({ tier: 'dialog' }),
    );
});
