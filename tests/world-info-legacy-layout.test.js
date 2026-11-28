/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest assertions verify DOM/CSS contracts and real world-info rendering. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { importWorldInfoModule } from './util/world-info-module-harness.js';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/world-info.css', import.meta.url), 'utf8');

const parsedIndex = new DOMParser().parseFromString(indexHtml, 'text/html');
const entryEditTemplateHtml = parsedIndex.querySelector('#entry_edit_template')?.outerHTML ?? '';

function mountWorldInfoDom() {
    document.body.innerHTML = `
        <div id="WorldInfo">
            <select id="world_editor_select"><option value="0">Book</option></select>
            <select id="world_info_sort_order">
                <option value="0" data-field="displayIndex" data-order="asc" data-rule="custom" selected>Custom</option>
            </select>
            <input id="world_info_search" value="" />
            <div id="world_popup">
                <button id="world_popup_new"></button>
                <button id="world_popup_name_button"></button>
                <button id="world_popup_export"></button>
                <button id="world_popup_delete"></button>
                <button id="world_duplicate"></button>
                <div id="world_info_pagination"></div>
                <div id="world_popup_entries_list"></div>
            </div>
        </div>
        ${entryEditTemplateHtml}
    `;
}

async function createRendererHarness({ adapter = null, books = {} } = {}) {
    mountWorldInfoDom();
    const paginationCalls = [];
    const sortableCalls = [];
    const loaded = await importWorldInfoModule({
        books,
        accountStorage: { WI_PerPage: '1' },
    });
    const { $, worldInfo } = loaded;
    $.fn.pagination = jest.fn(function (...args) {
        paginationCalls.push(args);
        if (args[0] === 'getCurrentPageNum') return 1;
        return this;
    });
    $.fn.sortable = jest.fn(function (...args) {
        sortableCalls.push(args);
        return undefined;
    });
    worldInfo.setWorldInfoSettings({}, { world_names: Object.keys(books) });
    if (adapter) {
        await worldInfo.setWorldInfoEditorAdapter(adapter);
    }
    return { ...loaded, paginationCalls, sortableCalls };
}

afterEach(() => {
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

describe('World Info legacy layout retirement', () => {
    test('retains unique native transports and the upstream fallback list', () => {
        const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
        const ids = [
            'world_info', 'world_editor_select', 'WorldInfo', 'WI-SP-button', 'world_popup',
            'world_popup_new', 'world_create_button', 'world_import_file', 'world_import_button',
            'world_batch_import_embedded', 'world_popup_export', 'world_popup_name_button',
            'world_duplicate', 'world_popup_delete', 'world_backfill_memos',
            'world_apply_current_sorting', 'world_refresh', 'world_info_view_filters',
            'world_info_search', 'world_info_sort_order', 'world_info_pagination', 'world_popup_entries_list',
        ];
        for (const id of ids) expect(doc.querySelectorAll(`#${id}`)).toHaveLength(1);
        expect(doc.querySelector('#world_info').multiple).toBe(true);
        expect(doc.querySelector('#world_popup_entries_list').parentElement.id).toBe('world_popup');
        expect([...doc.querySelectorAll('.world_info_view_filter')].map(button => button.dataset.filter)).toEqual(['all', 'active', 'disabled', 'constant', 'vectorized']);
        expect(doc.querySelector('#world_info_sort_order').options).toHaveLength(15);
        expect(doc.querySelector('#entry_edit_template .world_entry_edit')).not.toBeNull();
        expect(doc.querySelector('#entry_edit_template .world_entry .inline-drawer')).not.toBeNull();
    });

    test('drops fork-only toolbar, workspace, popout and responsive layout paths', () => {
        for (const content of [indexHtml, css]) {
            expect(content).not.toMatch(/world_popup_(?:workspace|entries_column|editor_|toolbar|primary_actions|action_group)/);
        }
        expect(indexHtml).not.toMatch(/id="(?:OpenAllWIEntries|CloseAllWIEntries)"/);
        expect(css).not.toMatch(/@container|961px|1020px|#WorldInfo\.sb-shell-embedded-content/);
    });

    test('keeps exported entry rendering with inline-drawer toggle and dormant upstream Open/Close handlers', async () => {
        const entry = { uid: 0, key: ['alpha'], keysecondary: [], comment: 'Title', content: 'Body', position: 0, order: 100 };
        const data = { entries: { 0: entry } };
        const { worldInfo } = await createRendererHarness({ books: { Book: data } });

        const block = await worldInfo.getWorldEntry('Book', data, entry);
        expect(block.attr('uid')).toBe('0');
        expect(block.find('.world_entry_edit')).toHaveLength(0);

        block.find('.inline-drawer').trigger('inline-drawer-toggle');
        expect(block.find('.world_entry_edit')).toHaveLength(1);
    });

    test('uses upstream pagination and rendering without any split or popout DOM', async () => {
        const entry = { uid: 0, displayIndex: 1, key: [], keysecondary: [], comment: 'Second', content: '' };
        const otherEntry = { uid: 11, displayIndex: 0, key: [], keysecondary: [], comment: 'First', content: '' };
        const data = { entries: { 0: entry, 11: otherEntry } };
        const { worldInfo, paginationCalls, sortableCalls } = await createRendererHarness({ books: { Book: data } });

        await worldInfo.showWorldEditor('Book');
        await worldInfo.refreshWorldInfoEditor(0, false);

        const pagination = paginationCalls.at(-1)[0];
        expect(pagination.pageNumber).toBe(2);
        await pagination.callback([entry]);

        expect(document.querySelectorAll('#world_popup_entries_list .world_entry[uid="0"]')).toHaveLength(1);
        expect(sortableCalls.some(([arg]) => arg && typeof arg === 'object' && arg.items === '.world_entry')).toBe(true);
        expect(document.querySelector('[id^="world_popup_editor"]')).toBeNull();
    });

    test.each([0, 'previous'])('delegates navigation %p to the adapter while keeping native action handlers bound', async navigation => {
        const render = jest.fn();
        const data = { entries: {} };
        const { $, worldInfo, mocks, paginationCalls, sortableCalls } = await createRendererHarness({
            adapter: { render },
            books: { Book: data },
        });
        render.mockClear();
        paginationCalls.length = 0;
        sortableCalls.length = 0;

        await worldInfo.showWorldEditor('Book');
        const navArg = navigation === 'previous' ? mocks.utils.navigation_option.previous : navigation;
        render.mockClear();
        sortableCalls.length = 0;
        await worldInfo.refreshWorldInfoEditor(navArg, false);

        expect(render).toHaveBeenCalledWith({ name: 'Book', data: expect.objectContaining({ entries: {} }), navigation: navArg, flashOnNav: false });
        expect(paginationCalls).toEqual([]);
        expect(mocks.utils.waitUntilCondition).not.toHaveBeenCalled();
        expect(sortableCalls).toEqual([['instance']]);
        for (const id of ['world_popup_new', 'world_popup_name_button', 'world_popup_export', 'world_popup_delete', 'world_duplicate']) {
            const clickEvents = $._data(document.getElementById(id), 'events')?.click ?? [];
            expect(clickEvents.length).toBeGreaterThan(0);
        }
    });

    test.each([false, true])('handles an absent book safely with adapter enabled: %p', async enabled => {
        const render = jest.fn();
        const { $, worldInfo, paginationCalls } = await createRendererHarness({
            adapter: enabled ? { render } : null,
            books: {},
        });
        render.mockClear();
        paginationCalls.length = 0;

        await worldInfo.showWorldEditor(null);

        expect($('#world_popup_entries_list').css('display')).toBe('none');
        expect($('#world_info_pagination').html()).toBe('');
        expect(paginationCalls).toEqual([]);
        expect(render).toHaveBeenCalledTimes(Number(enabled));
    });
});
