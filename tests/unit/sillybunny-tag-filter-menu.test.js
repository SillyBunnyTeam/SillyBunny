/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

let options;
const picker = { close: jest.fn(), refresh: jest.fn() };
const openPicker = jest.fn(config => { options = config; return picker; });
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ openPicker }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
const { attachTagFilterMenu } = await import('../../public/scripts/sillybunny-editor/tag-filter-menu.js');
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
        expect(globalThis.SillyBunnyAssets.loadStylesheetAsync).toHaveBeenCalledWith('css/sillybunny-editor-shell.css?v=20261018b', { id: 'deferred-editor-shell-css' });
        expect(options).toMatchObject({ title: 'Tags', multiple: true });
        expect(options.bounds).toBe(controls.parentElement);
        expect(options.items.map(({ value, label, muted }) => ({ value, label, muted }))).toEqual([
            { value: 'Alpha', label: 'Alpha', muted: false }, { value: 'Beta', label: 'Beta', muted: true },
        ]);
        expect(options.items[0].icon.style.backgroundColor).toBe('rgb(90, 160, 220)');
        expect(options.footer.map(item => item.label)).toEqual(['Clear all filters', 'Manage tags']);
        const clear = jest.fn();
        controls.querySelector('.clearAllFilters').onclick = clear;
        options.footer[0].onSelect();
        expect(clear).toHaveBeenCalledTimes(1);
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
