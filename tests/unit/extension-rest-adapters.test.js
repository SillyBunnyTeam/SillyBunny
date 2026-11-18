/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
const openActionMenu = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '',
    getRevealScrollTop: () => 0,
    positionPopover: () => {},
    openActionMenu,
    openPopover: () => {},
    closeActionMenu: () => {},
    isActionMenuOpen: () => false,
    getActionMenuTrigger: () => null,
}));

const { adoptImageGenerationSettings, adoptQuickReplyRow, adoptQuickReplySetLink, adoptQuickReplySetPicker, adoptSummarizeSettings } = await import('../../public/scripts/sillybunny-editor/adapters/utility-dialogs.js');
const { createSelectRow } = await import('../../public/scripts/sillybunny-editor/select-row.js');
const { adaptRegexEditor } = await import('../../public/scripts/extensions/regex/sillybunny-editor.js');
const { normalizeExtensionSettings } = await import('../../public/scripts/sillybunny-settings-presentation.js');

const readFile = path => readFileSync(new URL(`../../public/scripts/${path}`, import.meta.url), 'utf8');

beforeAll(() => {
    new Function(readFileSync(new URL('../../public/lib/jquery-3.5.1.min.js', import.meta.url), 'utf8')).call(window);
});

afterEach(() => {
    openActionMenu.mockClear();
    document.body.replaceChildren();
});

describe('a select row', () => {
    beforeEach(() => {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    });

    test('shows an option written in brackets without them and leaves the option as it is', () => {
        document.body.innerHTML = '<select id="fallback"><option value="99">[ None ]</option><option value="1">Sad</option><option value="2">[Currently selected]</option></select>';
        const select = document.querySelector('#fallback');
        const { row } = createSelectRow({ select, label: 'Fallback', field: 'fallback', searchLabel: 'Search', emptyText: 'No results' });
        expect(row.querySelector('.ds-select-row__value').textContent).toBe('None');
        expect(select.options[0].textContent).toBe('[ None ]');
        select.value = '2';
        select.dispatchEvent(new Event('change'));
        expect(row.querySelector('.ds-select-row__value').textContent).toBe('Currently selected');
    });

    test('keeps brackets that are part of a longer text', () => {
        document.body.innerHTML = '<select id="mode"><option value="a">[Raw] mode</option></select>';
        const { row } = createSelectRow({ select: document.querySelector('#mode'), label: 'Mode', field: 'mode', searchLabel: 'Search', emptyText: 'No results' });
        expect(row.querySelector('.ds-select-row__value').textContent).toBe('[Raw] mode');
    });

    // An extension's action buttons are often `div.menu_button`. A click on one must not reach the row's background
    // handler: the picker would open and take the focus from whatever the action opened (a confirmation dialog).
    test('does not open the picker for a click on an extension action that is not a button element', () => {
        document.body.innerHTML = `
            <label for="speaker">Speaker:</label>
            <div class="flex-container">
                <select id="speaker" class="text_pole flex1"><option value="a">A</option><option value="b">B</option></select>
                <div id="upload" class="menu_button">Upload</div>
                <div id="delete" class="menu_button">Delete</div>
            </div>`;
        const { row, trigger } = createSelectRow({
            select: document.querySelector('#speaker'),
            label: 'Speaker',
            field: 'speaker',
            searchLabel: 'Search',
            emptyText: 'No results',
            suffix: [...document.querySelectorAll('.menu_button')],
        });
        document.body.append(row);
        const clicked = jest.fn();
        row.querySelector('#delete').addEventListener('click', clicked);
        row.querySelector('#delete').click();
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(trigger.getAttribute('aria-expanded')).not.toBe('true');
        expect(document.querySelector('.sb-picker')).toBeNull();

        row.querySelector('.ds-row-text').click();
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
    });

    test('the settings pass keeps a TTS provider action from opening the picker of its select row', () => {
        document.body.innerHTML = `<div id="tts_settings"><div id="tts_provider_settings">
            <label for="speecht5_tts_speaker">Speaker:</label>
            <div class="flex-container">
                <select id="speecht5_tts_speaker" class="text_pole flex1"><option value="a">A</option></select>
                <div id="speecht5_tts_delete_speaker_button" class="menu_button" title="Delete speaker"><i class="fa-solid fa-trash"></i></div>
            </div></div></div>`;
        const scope = document.querySelector('#tts_settings');
        normalizeExtensionSettings(scope);
        const row = scope.querySelector('#speecht5_tts_speaker').closest('.ds-select-row');
        expect(row).not.toBeNull();
        row.querySelector('#speecht5_tts_delete_speaker_button').click();
        expect(row.querySelector('.ds-select-row__trigger')?.getAttribute('aria-expanded')).not.toBe('true');
        expect(document.querySelector('.sb-picker')).toBeNull();
    });
});

describe('the Summarize settings', () => {
    function summarize() {
        document.body.innerHTML = readFile('extensions/memory/settings.html');
        const root = document.querySelector('#memory_settings');
        root.querySelector('input[name="memory_prompt_builder"][value="0"]').checked = true;
        root.querySelector('input[name="memory_position"][value="0"]').checked = true;
        adoptSummarizeSettings(root);
        return root;
    }

    test('the summary box is a text-area field with Restore Previous in its label row, and keeps its id', () => {
        const root = summarize();
        const box = root.querySelector('#memory_contents');
        const field = box.closest('.ds-row-textarea');
        expect(field).not.toBeNull();
        expect(field.querySelector('.ds-row-textarea__label').textContent).toBe('Current summary');
        const labelRow = field.querySelector('.ds-row-textarea__label-row');
        expect(labelRow.contains(root.querySelector('#memory_restore'))).toBe(true);
        expect(labelRow.querySelector('.editor_maximize').dataset.for).toBe('memory_contents');
        expect(root.querySelectorAll('.editor_maximize[data-for="memory_contents"]')).toHaveLength(1);
    });

    test('the prompt builder is a toggle row over the same radios', () => {
        const root = summarize();
        const radios = [...root.querySelectorAll('input[name="memory_prompt_builder"]')];
        expect(radios.map(radio => radio.id)).toEqual(['memory_prompt_builder_raw_blocking', 'memory_prompt_builder_raw_non_blocking', 'memory_prompt_builder_default']);
        const row = radios[0].closest('.ds-toggle-row');
        expect(row).not.toBeNull();
        expect(radios.every(radio => row.contains(radio))).toBe(true);
        expect(row.querySelector('.ds-row-label').textContent.trim()).toBe('Prompt builder');
        expect(row.querySelector('.ds-row-subtitle').textContent).toContain('regular main prompt builder');
        // A change made by the extension shows in the caption.
        radios[1].checked = true;
        window.jQuery(radios[1]).trigger('change');
        expect(row.querySelector('.ds-row-subtitle').textContent).toContain('Does not block the chat');
    });

    test('the injection position keeps the explanation of None as the description of that option', () => {
        const root = summarize();
        const select = root.querySelector('select#memory_position');
        const none = [...select.options].find(option => option.value === '-1');
        expect(none.dataset.sbDescription).toContain('will not be injected into the prompt');
        const inChat = [...select.options].find(option => option.value === '1');
        expect(inChat.dataset.sbDescription).toContain('How many messages before the current end of the chat');
    });
});

describe('a Quick Reply row', () => {
    function quickReplyRow() {
        const button = (classes, title) => `<div class="qr--action menu_button ${classes}" title="${title}"></div>`;
        document.body.innerHTML = `
            <div id="qr--settings"><div id="qr--set-qrList"><div class="qr--set-qrListContents">
                <div class="qr--set-item" data-id="3">
                    <div class="qr--set-itemAdder"><div class="qr--actions">${button('qr--add', 'Add quick reply')}${button('qr--paste', 'Add quick reply from clipboard')}${button('qr--importFile', 'Add quick reply from JSON file')}</div></div>
                    <div class="qr--content">
                        <div class="drag-handle">☰</div>
                        <div class="qr--set-itemLabelContainer"><div class="qr--set-itemIcon menu_button" title="Click to change icon"></div><input class="qr--set-itemLabel text_pole" value="Greeting"></div>
                        <div class="qr--set-optionsContainer">${button('', 'Additional options:\n - large editor')}</div>
                        <textarea id="qr--set--item3" class="qr--set-itemMessage">Hello</textarea>
                        <div class="qr--actions">${button('fa-truck-arrow-right', 'Move quick reply to other set')}${button('fa-copy', 'Copy quick reply to clipboard')}${button('fa-cut', 'Cut quick reply to clipboard')}${button('fa-file-export', 'Export quick reply as file')}${button('fa-trash-can', 'Remove Quick Reply\n---\nShift+Click to skip confirmation')}</div>
                    </div>
                </div>
            </div></div></div>`;
        const item = document.querySelector('.qr--set-item');
        const removed = jest.fn();
        item.querySelector('.fa-trash-can').addEventListener('click', removed);
        adoptQuickReplyRow(item);
        return { item, removed };
    }

    test('is a shared entity row with a grip, the label and message fields, and one menu button', () => {
        const { item } = quickReplyRow();
        expect(item.matches('.ds-entity-row[role="listitem"][data-sb-presentation="manual"]')).toBe(true);
        expect(item.querySelector(':scope > .drag-handle.ds-entity-row__grip')).not.toBeNull();
        expect(item.querySelector(':scope > .ds-entity-row__text > .qr--set-itemLabelContainer > .qr--set-itemLabel').value).toBe('Greeting');
        expect(item.querySelector(':scope > .ds-entity-row__text > #qr--set--item3').value).toBe('Hello');
        expect(item.querySelector(':scope > .ds-entity-row__suffix').children).toHaveLength(1);
        expect(item.querySelector(':scope > .qr--content').hidden).toBe(true);
    });

    test('the menu lists the buttons by their tooltips and runs the extension\'s own button', async () => {
        const { item, removed } = quickReplyRow();
        item.querySelector('.qr--set-itemMenu').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const { sections } = openActionMenu.mock.calls[0][0];
        expect(sections.map(section => section.items.map(entry => entry.label))).toEqual([
            ['Additional options:', 'Move quick reply to other set', 'Copy quick reply to clipboard', 'Cut quick reply to clipboard', 'Export quick reply as file'],
            ['Add quick reply', 'Add quick reply from clipboard', 'Add quick reply from JSON file'],
            ['Remove Quick Reply'],
        ]);
        expect(sections[2].items[0].danger).toBe(true);
        sections[2].items[0].onSelect();
        expect(removed).toHaveBeenCalledTimes(1);
    });
});

describe('the Quick Reply set controls', () => {
    test('a set link is an entity row with a switch and one menu that runs the hidden pencil and trash can', async () => {
        document.body.innerHTML = '<div class="qr--setList" role="list"><div class="qr--item ds-row ds-row--activatable"><div class="drag-handle">☰</div><select class="qr--set"><option value="A">A</option></select><label class="qr--visible ds-row-suffix" title="Show buttons"><input type="checkbox">Buttons</label><div class="menu_button fa-pencil" title="Edit quick reply set"></div><div class="menu_button qr--del fa-trash-can" title="Remove quick reply set"></div></div></div>';
        const item = document.querySelector('.qr--item');
        const removed = jest.fn();
        item.querySelector('.qr--del').addEventListener('click', removed);
        adoptQuickReplySetLink(item);
        expect(item.matches('.ds-entity-row[role="listitem"]')).toBe(true);
        expect(item.classList.contains('ds-row')).toBe(false);
        expect(item.querySelector('.ds-entity-row__suffix').children).toHaveLength(2);
        expect(item.querySelector('input[type="checkbox"]').getAttribute('role')).toBe('switch');
        item.querySelector('.qr--setlink-menu').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const { sections } = openActionMenu.mock.calls[0][0];
        expect(sections.map(section => section.items.map(entry => entry.label))).toEqual([['Edit quick reply set'], ['Remove quick reply set']]);
        sections[1].items[0].onSelect();
        expect(removed).toHaveBeenCalledTimes(1);
    });

    test('the set picker is a select row with one menu; the destructive item is last', async () => {
        const button = (id, title) => `<div id="${id}" class="menu_button" title="${title}"></div>`;
        document.body.innerHTML = `<div id="qr--editor"><div class="qr--head"><div class="qr--title">Edit Quick Replies</div><div class="qr--actions"><select id="qr--set"><option>Default</option></select>${button('qr--set-rename', 'Rename quick reply set')}${button('qr--set-new', 'Create new quick reply set')}${button('qr--set-import', 'Import quick reply set')}${button('qr--set-export', 'Export quick reply set')}${button('qr--set-duplicate', 'Duplicate quick reply set')}${button('qr--set-delete', 'Delete quick reply set')}</div></div></div>`;
        adoptQuickReplySetPicker(document.body);
        const row = document.querySelector('#qr--set').closest('.ds-select-row');
        expect(row.querySelector('.ds-row-label').textContent).toBe('Edit Quick Replies');
        expect(row.querySelectorAll('.ds-select-row__menu')).toHaveLength(1);
        expect(document.querySelector('.qr--actions').hidden).toBe(true);
        row.querySelector('.ds-select-row__menu').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const { sections } = openActionMenu.mock.calls[0][0];
        expect(sections.at(-1).items.map(entry => [entry.label, entry.danger])).toEqual([['Delete quick reply set', true]]);
        expect(sections[0].items).toHaveLength(5);
    });
});

describe('the Image Generation settings', () => {
    test('the swap button is a button row that keeps its id, and the style picker is titled Preset', () => {
        document.body.innerHTML = '<div id="sd_container"><div id="sd_swap_dimensions" class="right_menu_button" title="Swap width and height" data-i18n="[title]Swap width and height"><i class="fa-solid fa-arrow-right-arrow-left"></i></div><select id="sd_style" class="text_pole"></select></div>';
        const root = document.querySelector('#sd_container');
        const onSwap = jest.fn();
        root.querySelector('#sd_swap_dimensions').addEventListener('click', onSwap);
        adoptImageGenerationSettings(root);
        const swap = root.querySelector('#sd_swap_dimensions');
        expect(swap.matches('.ds-row.ds-button-row')).toBe(true);
        expect(swap.querySelector('.ds-row-label').textContent).toBe('Swap width and height');
        expect(swap.title).toBe('Swap width and height');
        swap.click();
        expect(onSwap).toHaveBeenCalledTimes(1);
        expect(root.querySelector('#sd_style').getAttribute('aria-label')).toBe('Preset');
    });
});

describe('the regex editor', () => {
    function editor() {
        document.body.innerHTML = readFile('extensions/regex/editor.html');
        const root = document.querySelector('#regex_editor_template');
        root.querySelector('.regex_script_name').value = 'Trim quotes';
        root.querySelector('.find_regex').value = '/"/g';
        root.querySelector('input[name="replace_position"][value="2"]').checked = true;
        const result = adaptRegexEditor(root);
        return { root, result };
    }

    test('keeps every control the extension reads by its own selector', () => {
        const { root } = editor();
        for (const selector of ['.regex_script_name', '.find_regex', '.regex_replace_string', '.regex_trim_strings', 'input[name="disabled"]', 'input[name="run_on_edit"]', 'input[name="only_format_display"]', 'input[name="only_format_prompt"]', 'select[name="substitute_regex"]', 'input[name="min_depth"]', 'input[name="max_depth"]', '#regex_test_input', '#regex_test_output', '#regex_test_mode_toggle']) {
            expect(root.querySelectorAll(selector)).toHaveLength(selector.startsWith('input[name="replace_position"') ? 5 : 1);
        }
        expect(root.querySelectorAll('input[name="replace_position"]')).toHaveLength(5);
        expect(root.querySelector('.regex_script_name').value).toBe('Trim quotes');
        expect(root.querySelector('input[name="replace_position"][value="2"]').checked).toBe(true);
    });

    test('puts the body in boxed groups with headings', () => {
        const { root } = editor();
        const groups = [...root.querySelectorAll('.sb-editor-section')];
        expect(groups.map(group => group.querySelector('.ds-pref-group-heading')?.textContent ?? null)).toEqual([null, 'Affects', 'Other Options', 'Ephemerality']);
        expect(groups[0].querySelectorAll('.ds-row-entry--floating')).toHaveLength(2);
        expect(groups[0].querySelectorAll('.ds-row-textarea')).toHaveLength(2);
        expect(groups[1].querySelectorAll('.ds-row-check')).toHaveLength(5);
        expect(groups[1].querySelectorAll('.ds-row--spin')).toHaveLength(2);
        expect(groups[2].querySelectorAll('.ds-row-switch')).toHaveLength(2);
        expect(groups[2].querySelectorAll('.ds-select-row')).toHaveLength(1);
        expect(groups[3].querySelectorAll('.ds-row-switch')).toHaveLength(2);
        expect(root.querySelector('#regex_test_mode').matches('.ds-pref-group.displayNone')).toBe(true);
    });
});

describe('the extension settings pass', () => {
    function page(html) {
        document.body.innerHTML = `<div id="demo_container">${html}</div>`;
        const scope = document.querySelector('#demo_container');
        const report = normalizeExtensionSettings(scope);
        return { scope, report };
    }

    test('a labelled text area becomes a text-area field with its hint as the caption', () => {
        const { scope, report } = page('<div><label for="prefix">Common prefix</label><small>Won\'t be used in groups.</small><textarea id="prefix" class="text_pole"></textarea></div>');
        expect(report.textareas).toBe(1);
        const field = scope.querySelector('#prefix').closest('.ds-row-textarea');
        expect(field.querySelector('.ds-row-textarea__label').textContent).toBe('Common prefix');
        expect(field.querySelector('.ds-row-textarea__caption').textContent).toBe('Won\'t be used in groups.');
    });

    test('sliders listed one after another each get a row, even when a label was left behind', () => {
        const { scope, report } = page(`<div>
            <label for="a_slider"><span>Length (</span><span id="a_value">5</span><span>)</span><small>0 = default</small></label>
            <input id="a_slider" type="range" min="0" max="9" value="5">
            <label for="b_slider" class="title_restorable"><span>Interval</span><div id="b_auto" class="right_menu_button" title="Auto"></div></label>
            <input id="b_slider" type="range" min="0" max="9" value="1">
        </div>`);
        expect(report.sliders).toBe(2);
        const first = scope.querySelector('#a_slider').closest('.ds-row-slider');
        expect(first.querySelector('.ds-row-label').textContent).toContain('Length');
        expect(first.querySelector('.ds-row-subtitle').textContent).toBe('0 = default');
        const second = scope.querySelector('#b_slider').closest('.ds-row-slider');
        expect(second.querySelector('.ds-row-label').classList.contains('title_restorable')).toBe(false);
        expect(second.querySelector('.ds-row-suffix').contains(scope.querySelector('#b_auto'))).toBe(true);
    });

    test('a select with the description above its wrapper takes it as the row caption', () => {
        const { scope } = page('<div><small>Save and switch between groups.</small><div class="flex-container"><select id="presets" aria-label="Preset"><option value="">[No presets saved]</option></select><div id="make" class="menu_button" title="Create"></div></div></div>');
        const row = scope.querySelector('#presets').closest('.ds-select-row');
        expect(row.querySelector('.ds-row-label').textContent).toBe('Preset');
        expect(row.querySelector('.ds-row-subtitle').textContent).toBe('Save and switch between groups.');
        expect(row.querySelector('.ds-select-row__value').textContent).toBe('No presets saved');
    });
});
