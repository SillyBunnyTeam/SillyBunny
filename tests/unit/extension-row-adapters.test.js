/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
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

const { adoptRegexScriptList, adoptRegexScriptRow, adoptPositionRadios } = await import('../../public/scripts/sillybunny-editor/adapters/utility-dialogs.js');

const readFile = path => readFileSync(new URL(`../../public/scripts/${path}`, import.meta.url), 'utf8');

beforeAll(() => {
    new Function(readFileSync(new URL('../../public/lib/jquery-3.5.1.min.js', import.meta.url), 'utf8')).call(window);
});

afterEach(() => {
    openActionMenu.mockClear();
    document.body.replaceChildren();
});

describe('a regex script row', () => {
    function scriptRow({ disabled = false } = {}) {
        document.body.innerHTML = `<div id="global_scripts_block"><div id="saved_regex_scripts" class="regex-script-container"></div></div>${readFile('extensions/regex/scriptTemplate.html')}`;
        const row = document.querySelector('.regex-script-label');
        row.querySelector('.regex_script_name').textContent = 'Trim quotes';
        row.querySelector('.disable_regex').checked = disabled;
        // The extension's stylesheet shows the selection checkbox in bulk edit only.
        row.querySelector('.regex_bulk_checkbox').style.display = 'none';
        const clicks = { edit: jest.fn(), delete: jest.fn(), global: jest.fn() };
        row.querySelector('.edit_existing_regex').addEventListener('click', clicks.edit);
        row.querySelector('.delete_regex').addEventListener('click', clicks.delete);
        row.querySelector('.move_to_global').addEventListener('click', clicks.global);
        const list = document.querySelector('#saved_regex_scripts');
        adoptRegexScriptList(list);
        adoptRegexScriptRow(row);
        list.append(row);
        return { row, list, clicks };
    }

    test('is a shared entity row with the name as its title, a switch and a menu button', () => {
        const { row, list } = scriptRow();
        expect(list.getAttribute('role')).toBe('list');
        expect(list.classList.contains('ds-entity-list__rows')).toBe(true);
        expect(row.matches('.ds-entity-row[role="listitem"][data-sb-presentation="manual"]')).toBe(true);
        expect(row.querySelector('.ds-entity-row__text > .ds-entity-row__title.regex_script_name').textContent).toBe('Trim quotes');
        expect(row.querySelector('.ds-entity-row__suffix').children).toHaveLength(2);
        expect(row.querySelector('.ds-entity-row__suffix .regex-script-menu').getAttribute('aria-label')).toBe('Actions for Trim quotes');
        expect(row.querySelector('.ds-entity-row__grip.drag-handle')).not.toBeNull();
    });

    test('keeps the template\'s own controls in the row, hidden, so the code that finds them still does', () => {
        const { row } = scriptRow();
        const original = row.querySelector(':scope > .flex-container');
        expect(original.hidden).toBe(true);
        for (const selector of ['.disable_regex', '.edit_existing_regex', '.delete_regex', '.export_regex', '.move_to_global', '.move_to_preset', '.move_to_scoped']) {
            expect(original.querySelector(selector)).not.toBeNull();
        }
    });

    test('the switch is on for an enabled script and writes the disabled flag through the template\'s input event', () => {
        const { row } = scriptRow({ disabled: false });
        const disable = row.querySelector('.disable_regex');
        const enabled = row.querySelector('.regex-script-switch');
        const heard = jest.fn();
        disable.addEventListener('input', heard);
        expect(enabled.checked).toBe(true);
        expect(enabled.getAttribute('role')).toBe('switch');

        enabled.checked = false;
        enabled.dispatchEvent(new Event('change'));
        expect(disable.checked).toBe(true);
        expect(heard).toHaveBeenCalledTimes(1);

        disable.checked = false;
        disable.dispatchEvent(new Event('input'));
        expect(enabled.checked).toBe(true);
    });

    test('a click on the row edits the script, and a click the template\'s own button bubbles does not edit it twice', () => {
        const { row, clicks } = scriptRow();
        row.querySelector('.ds-entity-row__title').click();
        expect(clicks.edit).toHaveBeenCalledTimes(1);
        clicks.edit.mockClear();
        row.querySelector('.edit_existing_regex').click();
        expect(clicks.edit).toHaveBeenCalledTimes(1);
    });

    test('a click on the row selects the script while bulk edit shows the checkbox', () => {
        const { row, clicks } = scriptRow();
        const checkbox = row.querySelector('.regex_bulk_checkbox');
        checkbox.style.display = 'inline-block';
        row.querySelector('.ds-entity-row__title').click();
        expect(checkbox.checked).toBe(true);
        expect(clicks.edit).not.toHaveBeenCalled();
    });

    test('the menu offers the template\'s actions, leaves out the move into its own list, and runs the template button', async () => {
        const { row, clicks } = scriptRow();
        row.closest('body').insertAdjacentHTML('beforeend', '<div id="global_scripts_block"></div>');
        document.querySelector('#global_scripts_block').append(row);
        row.querySelector('.regex-script-menu').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const { sections, trigger } = openActionMenu.mock.calls[0][0];
        expect(trigger).toBe(row.querySelector('.regex-script-menu'));
        const labels = sections.map(section => section.items.map(item => item.icon.replace('fa-solid fa-', '')));
        expect(labels).toEqual([['pencil'], ['sliders', 'address-card', 'file-export'], ['trash']]);
        expect(sections[2].items[0].danger).toBe(true);
        sections[2].items[0].onSelect();
        expect(clicks.delete).toHaveBeenCalledTimes(1);
    });
});

describe('an injection position', () => {
    function positions() {
        document.body.innerHTML = readFile('extensions/vectors/settings.html').replace(/\{\{[^}]*\}\}/g, '');
        const root = document.body;
        const checked = root.querySelector('input[name="vectors_file_position_db"][value="0"]');
        checked.checked = true;
        adoptPositionRadios(root, 'vectors_file_position_db');
        return { root, checked };
    }

    test('is a select that starts on the radio that is checked, with the radios hidden', () => {
        const { root } = positions();
        const select = root.querySelector('select#vectors_file_position_db');
        expect(select.value).toBe('0');
        expect([...select.options].map(option => option.value)).toEqual(['2', '0', '1']);
        expect(root.querySelector('label[for="vectors_file_position_db"]').nextElementSibling).toBe(select);
        expect(root.querySelector('input[name="vectors_file_position_db"]').closest('.radio_group').hidden).toBe(true);
    });

    test('a choice checks the radio and sends the radio\'s own change event', () => {
        const { root } = positions();
        const select = root.querySelector('select#vectors_file_position_db');
        const heard = jest.fn();
        window.jQuery('input[name="vectors_file_position_db"]').on('change', heard);
        select.value = '1';
        select.dispatchEvent(new Event('change'));
        expect(root.querySelector('input[name="vectors_file_position_db"]:checked').value).toBe('1');
        expect(heard).toHaveBeenCalledTimes(1);
    });

    test('follows the radios when the extension checks one', () => {
        const { root } = positions();
        const select = root.querySelector('select#vectors_file_position_db');
        const radio = root.querySelector('input[name="vectors_file_position_db"][value="2"]');
        radio.checked = true;
        window.jQuery(radio).trigger('input');
        expect(select.value).toBe('2');
    });

    test('moves the depth and the role out of the radio\'s label into fields with labels of their own', () => {
        const { root } = positions();
        const depth = root.querySelector('#vectors_file_depth_db');
        const role = root.querySelector('#vectors_file_depth_role_db');
        expect(depth.closest('label[for="vectors_file_depth_db"]')).toBeNull();
        expect(root.querySelector('label[for="vectors_file_depth_db"]').dataset.i18n).toBe('In-chat @ Depth');
        expect(root.querySelector('label[for="vectors_file_depth_role_db"]').dataset.i18n).toBe('Role');
        expect(depth.closest('.sb-position-fields')).not.toBeNull();
        expect(role.closest('.sb-position-fields')).not.toBeNull();
    });

    test('adopting a group twice leaves one select', () => {
        const { root } = positions();
        adoptPositionRadios(root, 'vectors_file_position_db');
        expect(root.querySelectorAll('select#vectors_file_position_db')).toHaveLength(1);
    });
});
