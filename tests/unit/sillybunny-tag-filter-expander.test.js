/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';

import { importTagsModule } from '../util/tags-module-harness.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));

let options;
const picker = { close: jest.fn(), refresh: jest.fn() };
const openPicker = jest.fn(config => { options = config; return picker; });

const settle = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
const idOf = index => `tag-${String(index).padStart(3, '0')}`;
const makeTags = count => Array.from({ length: count }, (_, index) => ({
    id: idOf(index),
    name: `T${String(index).padStart(3, '0')}`,
    color: 'rgb(90, 160, 220)',
    color2: '',
}));

let filter;
let controls;
let menu;

/**
 * Loads the real `tags.js`, `filters.js` and `tag-filter-menu.js` modules in jsdom.
 * @param {string[]} selected IDs of the tags that the filter has selected.
 */
async function loadTagPrinting(selected = []) {
    const { tagsModule, filters, $ } = await importTagsModule({
        power_user: { tag_sort_mode: 'alphabetical', bogus_folders: false },
        entitiesFilter: {
            getFilterData: () => ({ selected, excluded: [] }),
            setFilterData: jest.fn(),
        },
    });
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/picker.js'), () => ({
        openPicker,
        closePicker: jest.fn(),
        isPickerOpen: () => false,
    }));
    const { attachTagFilterMenu } = await import('../../public/scripts/sillybunny-editor/tag-filter-menu.js');
    return {
        $,
        filters,
        printTagList: tagsModule.printTagList,
        attachTagFilterMenu,
    };
}

/** The call shape of `printTagFilters()` for the tag chips: it prints into a list that it does not empty. */
const printFilterChips = ($, printTagList, tags) => printTagList($(filter), {
    empty: false,
    tags: tags.slice(),
    tagOptions: { isFilter: true, isGeneralList: true },
    inactiveTags: [],
});
const chips = () => [...filter.querySelectorAll('.tag:not(.actionable)')];
const expanders = () => filter.querySelectorAll('.tag.placeholder-expander');
const openMenu = async () => {
    controls.querySelector('.sb-tag-filter-menu-button').click();
    await settle();
};

beforeEach(() => {
    jest.clearAllMocks();
    options = null;
    document.body.innerHTML = `<div id="tag_template"><span class="tag"><span class="tag_name"></span><span class="tag_remove"></span></span></div>
        <section class="sb-character-list"><div class="rm_tag_controls ds-tag-filter"><div class="rm_tag_filter">
        <span class="tag actionable clearAllFilters"><span class="tag_name"></span></span></div></div></section>`;
    controls = document.querySelector('.rm_tag_controls');
    filter = controls.querySelector('.rm_tag_filter');
    globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn(async () => {}) };
});

afterEach(() => {
    menu?.destroy();
    menu = null;
    document.body.replaceChildren();
    delete globalThis.SillyBunnyAssets;
});

describe('tag filter picker with more than 50 tags (real tag printing)', () => {
    test('the real expander chip is not actionable and the print stops at 50 chips', async () => {
        const { $, printTagList } = await loadTagPrinting();
        printFilterChips($, printTagList, makeTags(60));
        expect(chips()).toHaveLength(51);
        expect(expanders()).toHaveLength(1);
        expect(expanders()[0].classList.contains('actionable')).toBe(false);
        expect(chips().filter(chip => !chip.matches('.placeholder-expander')).map(chip => chip.id)).toEqual(makeTags(50).map(tag => tag.id));
    });

    test('the picker lists all 245 tags, no expander option, and a second open does not expand again', async () => {
        const { $, printTagList, attachTagFilterMenu } = await loadTagPrinting();
        const tags = makeTags(245);
        printFilterChips($, printTagList, tags);
        menu = attachTagFilterMenu(controls);
        await openMenu();
        expect(options.items.map(item => item.label)).toEqual(tags.map(tag => tag.name));
        expect(options.items.map(item => item.label)).not.toContain('...');
        expect(expanders()).toHaveLength(0);
        expect(filter.querySelector('.actionable.clearAllFilters')).not.toBeNull();
        expect(filter.classList.contains('tags-expanded')).toBe(true);

        // Re-opening uses the expanded state without adding another expander or re-expanding.
        await openMenu();
        expect(openPicker).toHaveBeenCalledTimes(2);
        expect(expanders()).toHaveLength(0);
        expect(options.items).toHaveLength(245);

        // Even after clearing the DOM class, re-printing remembers the expanded key in cache.
        filter.classList.remove('tags-expanded');
        filter.querySelectorAll('.tag:not(.actionable)').forEach(node => node.remove());
        printFilterChips($, printTagList, tags);
        expect(expanders()).toHaveLength(0);
        expect(chips()).toHaveLength(245);
    });

    test('an active tag beyond the 50th keeps its place in the picker order and its state', async () => {
        const { $, printTagList, attachTagFilterMenu } = await loadTagPrinting([idOf(200)]);
        const tags = makeTags(245);
        printFilterChips($, printTagList, tags);
        // Before the expansion the active tag is in the first batch, out of order with the tags that are skipped.
        expect(filter.querySelector(`[id="${idOf(200)}"]`)).not.toBeNull();
        menu = attachTagFilterMenu(controls);
        await openMenu();
        expect(options.items.map(item => item.label)).toEqual(tags.map(tag => tag.name));
        expect(filter.querySelector(`[id="${idOf(200)}"]`).classList.contains('selected')).toBe(true);
        expect(options.getItemState(idOf(200))).toBe('selected');
        expect(options.getItemState(idOf(10))).toBeNull();
        expect(expanders()).toHaveLength(0);
    });

    test('the expansion removes only the chips of its own print from a list that is not emptied', async () => {
        const { $, printTagList } = await loadTagPrinting();
        const tags = makeTags(60);
        filter.insertAdjacentHTML('beforeend', '<span class="tag" id="earlier-print"><span class="tag_name">Earlier</span></span>');
        printFilterChips($, printTagList, tags);
        $(expanders()[0]).trigger('click');
        expect(chips().map(chip => chip.id)).toEqual(['earlier-print', ...tags.map(tag => tag.id)]);
        expect(expanders()).toHaveLength(0);
        expect(filter.querySelector('.actionable.clearAllFilters')).not.toBeNull();
    });

    test('a print that empties its list rebuilds it in full when the expander is clicked', async () => {
        const { $, printTagList } = await loadTagPrinting();
        const tags = makeTags(60);
        printTagList($(filter), { tags: tags.slice(), tagOptions: {} });
        expect(chips()).toHaveLength(51);
        $(expanders()[0]).trigger('click');
        expect(chips().map(chip => chip.id)).toEqual(tags.map(tag => tag.id));
        expect(expanders()).toHaveLength(0);
        expect(filter.querySelector('.actionable.clearAllFilters')).toBeNull();
    });
});
