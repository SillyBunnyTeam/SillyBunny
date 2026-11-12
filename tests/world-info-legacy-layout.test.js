/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest assertions verify DOM contracts and the dormant renderer. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/world-info.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');

function rendererHarness(adapter = null) {
    const controls = new Map();
    function $(selector) {
        if (controls.has(selector)) return controls.get(selector);
        const control = {
            length: 1,
            handlers: new Map(),
            off: jest.fn(() => control),
            on: jest.fn((event, handler) => { control.handlers.set(event, handler); return control; }),
            show: jest.fn(() => control),
            hide: jest.fn(() => control),
            html: jest.fn(() => control),
            append: jest.fn(() => control),
            find: jest.fn(() => control),
            data: jest.fn(() => 'custom'),
            pagination: jest.fn(() => 1),
            sortable: jest.fn(() => undefined),
            offset: () => ({ top: 0 }),
            parent: () => control,
            scrollTop: jest.fn(),
        };
        controls.set(selector, control);
        return control;
    }
    const context = vm.createContext({
        $, updateEditor: null, worldInfoEditorAdapter: adapter,
        navigation_option: { none: 'none', previous: 'previous' },
        worldInfoDataSnapshots: new WeakMap(),
        clearEntryList: jest.fn(), nullWorldInfo: jest.fn(),
        verifyWorldInfoSearchSortRule: jest.fn(),
        getWorldInfoDisplayEntries: data => Object.values(data.entries),
        updateWorldEntryKeyOptionsCache: jest.fn(),
        accountStorage: { getItem: () => '1' },
        PAGINATION_TEMPLATE: '', getSortableDelay: () => 0,
        waitUntilCondition: jest.fn(async () => {}), flashHighlight: jest.fn(),
        renderTemplateAsync: jest.fn(async () => 'headers'),
        getWorldEntry: jest.fn(async (_name, _data, entry) => entry),
        updateWorldInfoResultsSummary: jest.fn(),
    });
    const renderer = source.match(/^async function displayWorldEntries\([\s\S]*?^}/m)?.[0];
    if (!renderer) throw new Error('Missing displayWorldEntries fallback.');
    vm.runInContext(renderer, context);
    return { $, context, controls };
}

describe('World Info legacy layout retirement', () => {
    test('retains unique native transports and the upstream fallback list', () => {
        const document = new DOMParser().parseFromString(indexHtml, 'text/html');
        const ids = [
            'world_info', 'world_editor_select', 'WorldInfo', 'WI-SP-button', 'world_popup',
            'world_popup_new', 'world_create_button', 'world_import_file', 'world_import_button',
            'world_batch_import_embedded', 'world_popup_export', 'world_popup_name_button',
            'world_duplicate', 'world_popup_delete', 'world_backfill_memos',
            'world_apply_current_sorting', 'world_refresh', 'world_info_view_filters',
            'world_info_search', 'world_info_sort_order', 'world_info_pagination', 'world_popup_entries_list',
        ];
        for (const id of ids) expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
        expect(document.querySelector('#world_info').multiple).toBe(true);
        expect(document.querySelector('#world_popup_entries_list').parentElement.id).toBe('world_popup');
        expect([...document.querySelectorAll('.world_info_view_filter')].map(button => button.dataset.filter)).toEqual(['all', 'active', 'disabled', 'constant', 'vectorized']);
        expect(document.querySelector('#world_info_sort_order').options).toHaveLength(15);
        expect(document.querySelector('#entry_edit_template .world_entry_edit')).not.toBeNull();
        expect(document.querySelector('#entry_edit_template .world_entry .inline-drawer')).not.toBeNull();
    });

    test('drops fork-only toolbar, workspace, popout and responsive layout paths', () => {
        for (const content of [indexHtml, source, css]) {
            expect(content).not.toMatch(/world_popup_(?:workspace|entries_column|editor_|toolbar|primary_actions|action_group)/);
        }
        expect(indexHtml).not.toMatch(/id="(?:OpenAllWIEntries|CloseAllWIEntries)"/);
        expect(source).not.toMatch(/WORLD_INFO_DESKTOP_SPLIT_QUERY|desktopSelectedWorldInfoUid|WorldInfoDesktopEditor|isDesktopSplit/);
        expect(css).not.toMatch(/@container|961px|1020px|#WorldInfo\.sb-shell-embedded-content/);
    });

    test('keeps exported entry rendering and dormant upstream Open/Close handlers', () => {
        expect(source).toContain('export async function getWorldEntry(name, data, entry)');
        expect(source).toContain('headerTemplate.find(\'.inline-drawer\').on(\'inline-drawer-toggle\'');
        expect(script).toContain('e.target.matches(\'#OpenAllWIEntries\')');
        expect(script).toContain('e.target.matches(\'#CloseAllWIEntries\')');
        expect(script.match(/document.querySelectorAll\('#world_popup_entries_list \.inline-drawer'\)/g)).toHaveLength(2);
    });

    test('uses upstream pagination and rendering without any split or popout DOM', async () => {
        const { $, context, controls } = rendererHarness();
        const entry = { uid: 0, key: [], keysecondary: [] };
        const otherEntry = { uid: 11, key: [], keysecondary: [] };
        const data = { entries: { 0: entry, 11: otherEntry } };
        context.getWorldInfoDisplayEntries = () => [otherEntry, entry];
        await context.displayWorldEntries('Book', data, 0, false);
        const pagination = $('#world_info_pagination').pagination.mock.calls[0][0];
        expect(pagination.pageNumber).toBe(2);
        await pagination.callback([entry]);
        expect(context.getWorldEntry).toHaveBeenCalledWith('Book', data, entry);
        expect($('#world_popup_entries_list').append).toHaveBeenCalledWith([entry]);
        expect($('#world_popup_entries_list').sortable).toHaveBeenCalledWith(expect.objectContaining({ items: '.world_entry' }));
        expect([...controls.keys()].some(selector => selector.includes('world_popup_editor'))).toBe(false);
    });

    test.each([0, 'previous'])('delegates navigation %p to the adapter while keeping native action handlers bound', async navigation => {
        const adapter = { render: jest.fn() };
        const { $, context } = rendererHarness(adapter);
        const data = { entries: {} };
        await context.displayWorldEntries('Book', data, navigation, false);
        expect(adapter.render).toHaveBeenCalledWith({ name: 'Book', data, navigation, flashOnNav: false });
        expect($('#world_info_pagination').pagination).not.toHaveBeenCalled();
        expect(context.getWorldEntry).not.toHaveBeenCalled();
        expect(context.waitUntilCondition).not.toHaveBeenCalled();
        expect($('#world_popup_entries_list').sortable.mock.calls).toEqual([['instance']]);
        for (const id of ['world_popup_new', 'world_popup_name_button', 'world_popup_export', 'world_popup_delete', 'world_duplicate']) {
            expect($(`#${id}`).handlers.get('click')).toEqual(expect.any(Function));
        }
    });

    test.each([false, true])('handles an absent book safely with adapter enabled: %p', async enabled => {
        const render = jest.fn();
        const { $, context } = rendererHarness(enabled ? { render } : null);
        await context.displayWorldEntries(null, null);
        expect($('#world_popup_entries_list').hide).toHaveBeenCalled();
        expect($('#world_info_pagination').html).toHaveBeenCalledWith('');
        expect($('#world_info_pagination').pagination).not.toHaveBeenCalled();
        expect(render).toHaveBeenCalledTimes(Number(enabled));
    });
});
