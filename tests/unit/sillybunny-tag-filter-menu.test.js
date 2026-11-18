/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

let options;
const picker = { close: jest.fn(), refresh: jest.fn() };
const openPicker = jest.fn(config => { options = config; return picker; });
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ openPicker, closePicker: jest.fn(), isPickerOpen: () => false }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), ''),
}));
const { adoptTagField, attachTagFilterMenu } = await import('../../public/scripts/sillybunny-editor/tag-filter-menu.js');
let controls;
let menu;
const settle = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
const tag = (id, state = '') => `<span class="tag ${state}" id="${id}" style="background-color: rgb(90, 160, 220)"><span class="tag_name">${id}</span></span>`;
const button = () => controls.querySelector('.sb-tag-filter-menu-button');

beforeEach(() => {
    jest.clearAllMocks();
    options = null;
    document.body.innerHTML = `<section class="ds-entity-list sb-editor-sheet"><div class="rm_tag_controls ds-tag-filter"><div class="rm_tag_filter">
        <span class="tag actionable filterByFavorites"></span><span class="tag actionable showTagList"></span>
        <span class="tag actionable clearAllFilters"></span><span class="tag actionable manageTags"></span>
        ${tag('Alpha')}${tag('Beta', 'tag-absent')}</div><div class="rm_tag_bogus_drilldown"></div></div></section>`;
    controls = document.querySelector('.rm_tag_controls');
    globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn(async () => {}) };
});

afterEach(() => {
    menu?.destroy();
    menu = null;
    document.body.replaceChildren();
    delete globalThis.SillyBunnyAssets;
    delete globalThis.toastr;
});

describe('tag filter menu', () => {
    test('names first-render and rebuilt icon actions even after tooltip extraction', async () => {
        controls.querySelector('.filterByFavorites').innerHTML = '<span class="tag_name fa-solid fa-star" data-sttt--title="Show only favorites"></span>';
        menu = attachTagFilterMenu(controls);
        expect(controls.querySelector('.filterByFavorites').getAttribute('aria-label')).toBe('Show only favorites');
        expect(controls.querySelector('.filterByFavorites .tag_name').getAttribute('aria-hidden')).toBe('true');
        controls.querySelector('.rm_tag_filter').innerHTML = '<span class="tag actionable"><span class="tag_name fa-solid fa-folder" title="Show only folders"></span></span>';
        await settle();
        expect(controls.querySelector('.tag.actionable').getAttribute('aria-label')).toBe('Show only folders');
    });

    test('places its button outside the replaceable filter, survives rebuilding and restores DOM', async () => {
        const original = controls.innerHTML;
        menu = attachTagFilterMenu(controls);
        expect(attachTagFilterMenu(controls)).toBe(menu);
        expect(controls.dataset.sbTagMenu).toBe('true');
        expect(button().previousElementSibling).toBe(controls.querySelector('.rm_tag_filter'));
        expect(button().type).toBe('button');
        expect(button().getAttribute('aria-label')).toBe('Show Tag List');
        controls.querySelector('.rm_tag_filter').replaceChildren();
        await settle();
        expect(button().hidden).toBe(true);
        controls.querySelector('.rm_tag_filter').innerHTML = tag('Gamma');
        await settle();
        expect(button().hidden).toBe(false);
        controls.querySelector('.rm_tag_filter').innerHTML = new DOMParser().parseFromString(`<div>${original}</div>`, 'text/html').querySelector('.rm_tag_filter').innerHTML;
        menu.destroy();
        expect(controls.innerHTML).toBe(original);
        expect(controls.hasAttribute('data-sb-tag-menu')).toBe(false);
    });

    test('builds ordered live options, colours, muted states, footer and bounds after loading styles', async () => {
        menu = attachTagFilterMenu(controls, { title: 'Tags' });
        button().click();
        expect(openPicker).not.toHaveBeenCalled();
        await settle();
        expect(globalThis.SillyBunnyAssets.loadStylesheetAsync).toHaveBeenCalledWith('css/sillybunny-editor-shell.css?v=20261118t', { id: 'deferred-editor-shell-css' });
        expect(options).toMatchObject({ title: 'Tags', multiple: true });
        expect(options.bounds).toBe(controls.parentElement);
        expect(options.items.map(({ value, label, muted }) => ({ value, label, muted }))).toEqual([
            { value: 'Alpha', label: 'Alpha', muted: false }, { value: 'Beta', label: 'Beta', muted: true },
        ]);
        expect(options.items[0].icon.style.backgroundColor).toBe('rgb(90, 160, 220)');
        expect(options.footer.map(item => item.label)).toEqual(['Clear All Filters', 'Manage Tags']);
        const clear = jest.fn();
        controls.querySelector('.clearAllFilters').onclick = clear;
        options.footer[0].onSelect();
        expect(clear).toHaveBeenCalledTimes(1);
    });

    test('expands the upstream chip limit before it reads the options, so every tag can be found', async () => {
        const filter = controls.querySelector('.rm_tag_filter');
        filter.insertAdjacentHTML('beforeend', '<span class="tag actionable placeholder-expander" id="placeholder_1"><span class="tag_name">...</span></span>');
        filter.querySelector('.placeholder-expander').addEventListener('click', event => {
            event.stopPropagation();
            filter.querySelector('.placeholder-expander').remove();
            filter.insertAdjacentHTML('beforeend', tag('Gamma') + tag('Delta'));
        });
        menu = attachTagFilterMenu(controls);
        button().click();
        await settle();
        expect(options.items.map(item => item.value)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
        expect(filter.querySelector('.placeholder-expander')).toBeNull();
    });

    test('clicks the current element, counts selected/excluded states, and refreshes an open picker', async () => {
        menu = attachTagFilterMenu(controls);
        button().click();
        await settle();
        const old = controls.querySelector('[id="Alpha"]');
        const staleClick = jest.fn();
        old.onclick = staleClick;
        old.outerHTML = tag('Alpha', 'selected');
        const current = controls.querySelector('[id="Alpha"]');
        const click = jest.fn();
        current.onclick = click;
        controls.querySelector('[id="Beta"]').classList.add('excluded');
        await settle();
        options.onSelect('Alpha');
        expect(click).toHaveBeenCalledTimes(1);
        expect(staleClick).not.toHaveBeenCalled();
        expect(options.getItemState('Alpha')).toBe('selected');
        expect(options.getItemState('Beta')).toBe('excluded');
        expect(options.getItemState('missing')).toBeNull();
        expect(button().classList.contains('is-active')).toBe(true);
        expect(button().querySelector('.sb-tag-filter-menu-count').textContent).toBe('2');
        expect(picker.refresh).toHaveBeenCalled();
        menu.destroy();
        picker.refresh.mockClear();
        current.classList.remove('selected');
        await settle();
        expect(picker.refresh).not.toHaveBeenCalled();
        expect(picker.close).toHaveBeenCalled();
    });

    test('failed styles can retry; destroying during loading prevents a late open', async () => {
        globalThis.toastr = { error: jest.fn() };
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockRejectedValueOnce(new Error('unavailable'));
        menu = attachTagFilterMenu(controls);
        button().click();
        await settle();
        expect(openPicker).not.toHaveBeenCalled();
        button().click();
        await settle();
        expect(openPicker).toHaveBeenCalledTimes(1);
        let release;
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        button().click();
        menu.destroy();
        release();
        await settle();
        expect(openPicker).toHaveBeenCalledTimes(1);
    });
});

describe('editor tag field', () => {
    const allTags = [
        { id: 't-red', name: 'Red', color: 'rgb(200, 0, 0)' },
        { id: 't-blue', name: 'Blue', color: '' },
        { id: 't-green', name: 'Green', color: 'rgb(0, 160, 0)' },
    ];
    let field;
    let added;
    let input;
    let list;

    function chip(tagItem) {
        return `<span class="tag" id="${tagItem.id}"><span class="tag_name">${tagItem.name}</span><button type="button" class="tag_remove">x</button></span>`;
    }

    function mount(applied = ['t-red']) {
        document.body.innerHTML = `<div id="tags_div"><div class="ds-row"><input id="tagInput"><button type="button" class="tags_view"></button></div>
            <div id="tagList" class="tags">${applied.map(id => chip(allTags.find(tagItem => tagItem.id === id))).join('')}</div></div>`;
        input = document.getElementById('tagInput');
        list = document.getElementById('tagList');
        added = [];
        // Upstream's add path: its autocomplete select handler prints the chip; its Remove handler takes it out.
        const selectHandler = (_event, ui) => {
            let tagItem = allTags.find(item => item.name === ui.item.value);
            if (!tagItem) {
                tagItem = { id: `t-${ui.item.value.toLowerCase()}`, name: ui.item.value, color: '' };
                allTags.push(tagItem);
            }
            added.push(tagItem.name);
            list.insertAdjacentHTML('beforeend', chip(tagItem));
        };
        list.addEventListener('click', event => event.target.closest('.tag_remove')?.closest('.tag').remove());
        const jquery = () => ({ autocomplete: (method, name) => (method === 'option' && name === 'select' ? selectHandler : undefined) });
        globalThis.SillyTavern = { getContext: () => ({ tags: allTags }) };
        field = adoptTagField({ input, list, manage: document.querySelector('.tags_view'), field: 'tags', jquery });
        return field;
    }

    afterEach(() => {
        field?.destroy();
        field = null;
        delete globalThis.SillyTavern;
    });

    test('one row replaces the add field and the chips, which stay in the page as the transport', () => {
        mount();
        expect(field.row.matches('.ds-select-row.sb-tag-field')).toBe(true);
        expect(field.row.querySelector('.ds-row-label').textContent).toBe('Tags');
        expect(field.row.querySelector('.ds-row-subtitle').textContent).toBe('Red');
        expect(input.closest('.ds-row').hidden).toBe(true);
        expect(list.hidden).toBe(true);
        expect(list.classList.contains('tags-expanded')).toBe(true);
        expect(field.row.nextElementSibling).toBe(list);
    });

    test('the picker lists the applied tags first, ticked, with a dot in their colour, and Manage tags at the foot', () => {
        mount(['t-green']);
        field.row.querySelector('.ds-select-row__trigger').click();
        expect(options.multiple).toBe(true);
        expect(options.items.map(item => item.label)).toEqual(['Green', 'Blue', 'Red']);
        expect(options.getItemState('t-green')).toBe('selected');
        expect(options.getItemState('t-red')).toBeNull();
        expect(options.items[0].icon.style.getPropertyValue('--sb-tag-color')).toBe('rgb(0, 160, 0)');
        expect(options.footer.map(item => item.label)).toEqual(['Manage Tags']);
    });

    test('ticking adds through upstream, unticking removes the chip, and the row follows', async () => {
        mount(['t-red']);
        field.row.querySelector('.ds-select-row__trigger').click();
        options.onSelect('t-blue');
        expect(added).toEqual(['Blue']);
        await settle();
        expect(field.row.querySelector('.ds-row-subtitle').textContent).toBe('Red, Blue');
        expect(field.row.querySelector('.ds-select-row__value').textContent).toBe('2');
        options.onSelect('t-red');
        await settle();
        expect(list.querySelector('#t-red')).toBeNull();
        expect(field.row.querySelector('.ds-row-subtitle').textContent).toBe('Blue');
        expect(field.row.querySelector('.ds-select-row__value').textContent).toBe('1');
    });

    test('a search that names no tag creates it through upstream and applies it', async () => {
        mount([]);
        field.row.querySelector('.ds-select-row__trigger').click();
        expect(field.row.querySelector('.ds-select-row__value').textContent).toBe('None');
        expect(field.row.querySelector('.ds-row-subtitle').hidden).toBe(true);
        expect(options.create.label('Vampire')).toBe('Create Tag Vampire');
        options.create.onCreate('Vampire');
        await settle();
        expect(added).toEqual(['Vampire']);
        expect(field.row.querySelector('.ds-row-subtitle').textContent).toBe('Vampire');
        expect(field.row.querySelector('.ds-select-row__value').textContent).toBe('1');
    });
});
