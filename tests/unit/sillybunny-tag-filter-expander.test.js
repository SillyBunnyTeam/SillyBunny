/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

await import('../../public/lib/jquery-3.5.1.min.js');
const $ = window.jQuery;

let options;
const picker = { close: jest.fn(), refresh: jest.fn() };
const openPicker = jest.fn(config => { options = config; return picker; });
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ openPicker, closePicker: jest.fn(), isPickerOpen: () => false }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), ''),
}));
const { attachTagFilterMenu } = await import('../../public/scripts/sillybunny-editor/tag-filter-menu.js');

const sources = new Map();

/**
 * Evaluates named top-level declarations of a public script in a vm context, so the test runs the real code.
 * @param {string} path Path below `public/`.
 * @param {string[]} names Declarations to extract.
 * @param {object} overrides Globals that stand in for the module's imports and state.
 * @returns {Record<string, any>} The extracted declarations.
 */
function loadSourceFunctions(path, names, overrides = {}) {
    if (!sources.has(path)) {
        const source = readFileSync(new URL(`../../public/${path}`, import.meta.url), 'utf8');
        const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.map(node => node.declaration ?? node);
        sources.set(path, { source, declarations });
    }
    const { source, declarations } = sources.get(path);
    const context = vm.createContext({ document, $, console: { log() {}, debug() {}, error: console.error }, ...overrides });
    const bodies = names.map(name => {
        const declaration = declarations.find(node => node.id?.name === name || node.declarations?.some(item => item.id.name === name));
        if (!declaration) throw new Error(`Missing ${path} declaration: ${name}`);
        return source.slice(declaration.start, declaration.end);
    });
    vm.runInContext(`${bodies.join('\n')}\nthis.api = { ${names.join(', ')} };`, context);
    return context.api;
}

const filters = loadSourceFunctions('scripts/filters.js', ['FILTER_TYPES', 'FILTER_STATES', 'DEFAULT_FILTER_STATE', 'isFilterState']);

const settle = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
const idOf = index => `tag-${String(index).padStart(3, '0')}`;
const makeTags = count => Array.from({ length: count }, (_, index) => ({ id: idOf(index), name: `T${String(index).padStart(3, '0')}`, color: 'rgb(90, 160, 220)', color2: '' }));

let filter;
let controls;
let menu;
let expandedTagsCache;

/**
 * Loads the real tag printing code, with only its environment stubbed.
 * @param {string[]} selected IDs of the tags that the filter has selected.
 */
function loadTagPrinting(selected = []) {
    expandedTagsCache = [];
    const filterHelper = { getFilterData: () => ({ selected, excluded: [] }) };
    return loadSourceFunctions('scripts/tags.js', ['printTagList', 'appendTagToList', 'toggleTagThreeState', 'determineTagFilterState'], {
        ...filters,
        TAG_TEMPLATE: $('#tag_template .tag'),
        TAG_ID_TO_FILTER_TYPE: new Map(),
        INTERACTABLE_CONTROL_CLASS: 'interactable',
        expanded_tags_cache: expandedTagsCache,
        refreshTagManager: () => {},
        getTagKey: () => null,
        getTagKeyForEntity: key => key,
        getTagKeyForEntityElement: () => undefined,
        getFilterHelper: () => filterHelper,
        isBogusFolder: () => false,
        compareTagsForSort: (a, b) => a.name.localeCompare(b.name),
        onTagFilterClick: () => {},
        translate: text => text,
        animateIn: () => {},
        t: strings => strings[0],
        uuidv4: () => 'expander-id',
    }).printTagList;
}

/** The call shape of `printTagFilters()` for the tag chips: it prints into a list that it does not empty. */
const printFilterChips = (printTagList, tags) => printTagList($(filter), { empty: false, tags: tags.slice(), tagOptions: { isFilter: true, isGeneralList: true }, inactiveTags: [] });
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
    test('the real expander chip is not actionable and the print stops at 50 chips', () => {
        const printTagList = loadTagPrinting();
        printFilterChips(printTagList, makeTags(60));
        expect(chips()).toHaveLength(51);
        expect(expanders()).toHaveLength(1);
        expect(expanders()[0].classList.contains('actionable')).toBe(false);
        expect(chips().filter(chip => !chip.matches('.placeholder-expander')).map(chip => chip.id)).toEqual(makeTags(50).map(tag => tag.id));
    });

    test('the picker lists all 245 tags, no expander option, and a second open does not expand again', async () => {
        const printTagList = loadTagPrinting();
        const tags = makeTags(245);
        printFilterChips(printTagList, tags);
        menu = attachTagFilterMenu(controls);
        await openMenu();
        expect(options.items.map(item => item.label)).toEqual(tags.map(tag => tag.name));
        expect(options.items.map(item => item.label)).not.toContain('...');
        expect(expanders()).toHaveLength(0);
        expect(filter.querySelector('.actionable.clearAllFilters')).not.toBeNull();
        expect(filter.classList.contains('tags-expanded')).toBe(true);
        expect(expandedTagsCache).toHaveLength(1);
        await openMenu();
        expect(openPicker).toHaveBeenCalledTimes(2);
        expect(expandedTagsCache).toHaveLength(1);
        expect(options.items).toHaveLength(245);
    });

    test('an active tag beyond the 50th keeps its place in the picker order and its state', async () => {
        const printTagList = loadTagPrinting([idOf(200)]);
        const tags = makeTags(245);
        printFilterChips(printTagList, tags);
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

    test('the expansion removes only the chips of its own print from a list that is not emptied', () => {
        const printTagList = loadTagPrinting();
        const tags = makeTags(60);
        filter.insertAdjacentHTML('beforeend', '<span class="tag" id="earlier-print"><span class="tag_name">Earlier</span></span>');
        printFilterChips(printTagList, tags);
        $(expanders()[0]).trigger('click');
        expect(chips().map(chip => chip.id)).toEqual(['earlier-print', ...tags.map(tag => tag.id)]);
        expect(expanders()).toHaveLength(0);
        expect(filter.querySelector('.actionable.clearAllFilters')).not.toBeNull();
    });

    test('a print that empties its list rebuilds it in full when the expander is clicked', () => {
        const printTagList = loadTagPrinting();
        const tags = makeTags(60);
        printTagList($(filter), { tags: tags.slice(), tagOptions: {} });
        expect(chips()).toHaveLength(51);
        $(expanders()[0]).trigger('click');
        expect(chips().map(chip => chip.id)).toEqual(tags.map(tag => tag.id));
        expect(expanders()).toHaveLength(0);
        expect(filter.querySelector('.actionable.clearAllFilters')).toBeNull();
    });
});
