/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

let renderer;
let stateRenderer;
let model;
let mounted;
let menu;
let resize;
let navigationGeneration;
let translationPrefix = '';
const navigationDestinations = new Map();
const pages = { characters: 1, groups: 1 };
const sizes = { characters: 10, groups: 10 };
const power_user = { charListGrid: false, show_tag_filters: true, bogus_folders: false };
const pageLoaded = jest.fn();
const printCharacters = jest.fn(async () => renderer?.render(model));
const toggleCharacterFavoriteById = jest.fn();
const toggleGroupFavoriteById = jest.fn();
const deleteCharacterById = jest.fn();
const duplicateCharacter = jest.fn();
const deleteGroupById = jest.fn();
const navigate = jest.fn();
const selectCharacterById = jest.fn();
const openGroupById = jest.fn();
const play = jest.fn();
const destroyTagMenu = jest.fn();
const attachTagFilterMenu = jest.fn(() => ({ refresh: jest.fn(), destroy: destroyTagMenu }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/tag-filter-menu.js', () => ({ attachTagFilterMenu }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker: jest.fn(), isPickerOpen: () => false }));
const runBulkAction = jest.fn();
const characterGroupOverlay = {
    legacyRowSelectionEnabled: true,
    setLegacyRowSelectionEnabled: jest.fn(enabled => { characterGroupOverlay.legacyRowSelectionEnabled = enabled; }),
    notifySharedSelectionState: jest.fn(async () => {}),
    runBulkAction,
};
const characterLibrary = Array.from({ length: 40 }, (_, id) => ({ name: `Name ${id}`, avatar: `${id}.png` }));
const groupLibrary = ['g', 'group-id', '0123'].map(id => ({ id, name: id }));
const setFilterData = jest.fn();
const setListPage = jest.fn((view, page) => { pages[view] = page; return stateRenderer?.(); });
const setListPageSize = jest.fn((view, size) => { sizes[view] = size; return stateRenderer?.(); });
const sorts = { characters: { field: 'name', order: 'asc' }, groups: { field: 'name', order: 'desc' } };
const setListSort = jest.fn();
const template = html => { const element = document.createElement('div'); element.innerHTML = html; return element; };

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => translationPrefix + strings.reduce((out, string, index) => out + string + (values[index] ?? ''), ''),
}));
await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({ power_user }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu: jest.fn(options => { menu = menu?.trigger === options.trigger ? null : options; }),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/object-navigation.js', () => ({ objectNavigation: {
    navigate, register: (kind, destination) => navigationDestinations.set(kind, destination), setNotify: jest.fn(), bindTopLevelClear: jest.fn(),
} }));
await jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_names: [], openWorldInfoEditor: jest.fn(), getWorldInfoEditorState: jest.fn(),
    captureWorldInfoEditorListState: jest.fn(), restoreWorldInfoEditorListState: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateListChange: jest.fn((_rows, update) => update()),
    play, stopMotion: jest.fn(), animateOut: jest.fn((_node, _frames, done) => done()), MOTION_SLOW: 0,
    MOTION_FAST: 200, MOTION_EASE_OUT_CUBIC: 'cubic-bezier(0.33, 1, 0.68, 1)',
    prefersReducedMotion: () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('reduced-motion'),
}));
await jest.unstable_mockModule('../../public/script.js', () => ({
    setCharacterListRenderer: value => { renderer = value; }, printCharacters,
    getCharacterRowData: (item, id) => ({ ...item, id, chid: id, avatarUrl: item.avatarUrl ?? `/thumb/${item.avatar}` }),
    getGroupRowData: group => ({ ...group, memberCountText: '2 characters', memberNamesText: 'One, Two' }),
    entitiesFilter: { setFilterData, clearFuzzySearchCaches: jest.fn() },
    getBackBlock: () => template('<span class="ch_name">Go back</span>'),
    getHiddenBlock: async count => template(`<p>${count} hidden</p>`),
    getEmptyBlock: async () => template('<p>No characters found</p>'),
    toggleCharacterFavoriteById, duplicateCharacter, deleteCharacterById,
    characterGroupOverlay, characters: characterLibrary, selectCharacterById,
    this_chid: 0,
}));
await jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
    toggleGroupFavoriteById, deleteGroupById, groups: groupLibrary, openGroupById,
    getGroupAvatarElement: () => template('<img src="/group.png">'),
    groupEditorTargetExists: jest.fn(), canPeekGroupMember: jest.fn(), openGroupMemberDefinition: jest.fn(),
    openGroupEditor: jest.fn(), captureGroupEditorListState: jest.fn(), restoreGroupEditorListState: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/tags.js', () => ({
    getTagBlock: item => template(`<span class="ch_name">${item.name}</span><span class="bogus_folder_counter">3 characters</span>`),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-character-list-state.js', () => ({
    getCharacterListView: () => model.view,
    registerCharacterListStateRenderer: value => { stateRenderer = value; },
    getListPage: view => pages[view], setListPage,
    getListPageSize: view => sizes[view], setListPageSize,
    getListSort: view => sorts[view], setListSort,
    getListSortOptions: () => [{ field: 'name', order: 'asc', label: 'Name (A-Z)' }, { field: 'name', order: 'desc', label: 'Name (Z-A)' }],
}));

const { mountCharacterList, getMountedCharacterList, prepareCharacterListRestore } = await import('../../public/scripts/sillybunny-character-list.js');
const { eventSource, event_types } = await import('../../public/scripts/events.js');
await import('../../public/scripts/sillybunny-characters-navigation.js');
const characters = count => Array.from({ length: count }, (_, id) => ({ type: 'character', id, item: { name: `Name ${id}`, avatar: `${id}.png` } }));
const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
const rows = () => [...document.querySelectorAll('#rm_print_characters_block > .ds-entity-row')];
const button = id => document.querySelector(`[data-action-id="${id}"]`);
const action = label => menu.sections.flatMap(section => section.items).find(item => item.label === label);
async function mount() {
    mounted = await mountCharacterList(undefined, { getNavigationGeneration: () => navigationGeneration });
    jest.spyOn(mounted.section, 'getClientRects').mockReturnValue([{}]);
    resize();
    return mounted;
}

beforeEach(() => {
    jest.clearAllMocks();
    play.mockReset().mockImplementation((_row, _frames, options) => { options.onEnd?.(); });
    selectCharacterById.mockReset().mockImplementation(async (id, { onAccepted } = {}) => {
        onAccepted?.();
        model.entities.forEach(entity => { entity.item.active = entity.type === 'character' && Number(entity.id) === id; });
        await eventSource.emit(event_types.CHAT_CHANGED);
        return true;
    });
    openGroupById.mockReset().mockImplementation(async (id, { onAccepted } = {}) => {
        onAccepted?.();
        model.entities.forEach(entity => { entity.item.active = entity.type === 'group' && entity.item.id === id; });
        await eventSource.emit(event_types.CHAT_CHANGED);
        return true;
    });
    runBulkAction.mockReset().mockResolvedValue(undefined);
    characterLibrary.splice(0, characterLibrary.length, ...Array.from({ length: 40 }, (_, id) => ({ name: `Name ${id}`, avatar: `${id}.png` })));
    renderer = null;
    stateRenderer = null;
    mounted = null;
    menu = null;
    navigationGeneration = 0;
    translationPrefix = '';
    pages.characters = pages.groups = 1;
    sizes.characters = sizes.groups = 10;
    Object.assign(power_user, { charListGrid: false, show_tag_filters: true, bogus_folders: false });
    model = { view: 'characters', entities: characters(3), sourceCount: 3, hasAnyFilter: false, folderOpen: false, fullRefresh: false, pageLoaded };
    document.body.innerHTML = `<div id="rm_characters_block"><div id="charListFixedTop"><div id="rm_button_bar"><div id="rm_buttons_container"></div></div>
        <form id="form_character_search_form"><input id="character_search_bar"></form>
        <div class="rm_tag_controls"><div class="rm_tag_filter"><button class="filterByFavorites"></button><button class="filterByFolder"></button><button class="clearAllFilters"></button><button class="manageTags"></button><button class="showTagList"></button></div><div class="rm_tag_bogus_drilldown"></div></div></div>
        <div id="rm_print_characters_pagination"><button id="charListGridToggle"></button><button id="bulkEditButton"></button><span id="bulkSelectedCount"></span><button id="bulkSelectAllButton"></button><button id="bulkDeleteButton"></button></div>
        <div id="rm_print_characters_block"></div></div><button id="rm_button_create"></button><button id="rm_button_group_chats"></button>`;
    document.getElementById('charListGridToggle').onclick = () => { power_user.charListGrid = !power_user.charListGrid; document.body.classList.toggle('charListGrid', power_user.charListGrid); };
    globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn(async () => {}) };
    globalThis.SillyBunnyShell = {
        openTab: jest.fn(async () => {
            navigationGeneration++;
            await Promise.resolve();
            await mounted.revealActiveEntity();
        }),
        closeCharacters: jest.fn(() => navigationGeneration++),
    };
    globalThis.ResizeObserver = class {
        constructor(callback) { this.callback = callback; }
        observe(element) { if (element.matches('.sb-character-list__header')) resize = this.callback; }
        disconnect() {}
        unobserve() {}
    };
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(); return 1; });
});

afterEach(() => {
    (mounted ?? getMountedCharacterList())?.destroy();
    jest.restoreAllMocks();
    document.body.replaceChildren();
    document.body.className = '';
    delete globalThis.SillyBunnyAssets;
    delete globalThis.SillyBunnyShell;
    delete globalThis.SillyBunnyCharacterListController;
    delete globalThis.toastr;
});

describe('shared Characters/Groups list', () => {
    test.each(['characters', 'groups'])('unchanged %s rows do not rewrite presentation, but state and real changes refresh', async view => {
        model.view = view;
        if (view === 'groups') model.entities = [{ type: 'group', id: 'g', item: { id: 'g', name: 'Name' } }];
        Object.assign(model.entities[0].item, { avatarTitle: 'Avatar', nameTitle: 'Name title' });
        await mount();
        const row = rows()[0];
        const avatar = row.querySelector('.ds-entity-row__avatar');
        const title = row.querySelector('.ds-entity-row__title');
        const more = row.querySelector('.ds-entity-row__suffix').lastElementChild;
        // Tooltip extensions remove title attributes after consuming them.
        for (const element of [avatar, title, more]) element.removeAttribute('title');
        const mutations = [];
        const observer = new MutationObserver(records => mutations.push(...records));
        observer.observe(row, { subtree: true, attributes: true, attributeFilter: ['title', 'aria-label', 'src', 'alt'] });
        model.entities[0].item.active = true;
        await mounted.render(model);
        expect([...mutations, ...observer.takeRecords()]).toHaveLength(0);
        expect(row.getAttribute('aria-current')).toBe('true');
        Object.assign(model.entities[0].item, { name: 'Renamed', avatarTitle: 'New avatar', nameTitle: 'Renamed title', favorite: true });
        await mounted.render(model);
        expect(rows()[0]).toBe(row);
        expect(avatar.title).toBe('New avatar');
        expect(title.title).toBe('Renamed title');
        expect(title.textContent).toContain('Renamed');
        expect(more.getAttribute('aria-label')).toBe('Actions for Renamed');
        expect(row.classList.contains('is_fav')).toBe(true);
        expect(row.querySelector('.ch_fav').value).toBe('true');
        translationPrefix = 'translated:';
        await mounted.render(model);
        expect(more.title).toBe('translated:Actions for Renamed');
        expect(more.getAttribute('aria-label')).toBe(more.title);
        observer.disconnect();
    });

    test('a changed avatar URL refreshes a retained character row', async () => {
        await mount();
        const row = rows()[0];
        model.entities[0].item.avatarUrl = '/new-avatar.png';
        model.entities[0].item.name = 'Renamed avatar';
        await mounted.render(model);
        expect(rows()[0]).toBe(row);
        expect(row.querySelector('img').getAttribute('src')).toBe('/new-avatar.png');
        expect(row.querySelector('img').alt).toBe('Renamed avatar');
    });

    test('mounts keyed character rows with upstream hooks and updates retained nodes', async () => {
        await mount();
        const row = rows()[0];
        expect(globalThis.SillyBunnyAssets.loadStylesheetAsync).toHaveBeenCalledWith('css/sillybunny-editor-shell.css?v=20261018b', { id: 'deferred-editor-shell-css' });
        expect(attachTagFilterMenu).toHaveBeenCalledWith(document.querySelector('.rm_tag_controls'));
        expect(row.id).toBe('CharID0');
        expect(row.getAttribute('data-chid')).toBe('0');
        expect(row.getAttribute('chid')).toBe('0');
        expect(row.querySelector('.avatar img').getAttribute('loading')).toBe('lazy');
        expect(row.querySelector('input.ch_fav')).not.toBeNull();
        model.entities[0].item.name = 'Updated';
        model.entities[0].item.favorite = true;
        await mounted.render(model);
        expect(rows()[0]).toBe(row);
        expect(row.querySelector('.ch_name').textContent).toBe('Updated');
        expect(row.querySelector('.ch_fav_icon')).not.toBeNull();
        expect(pageLoaded).toHaveBeenCalledTimes(2);
        expect(await mountCharacterList()).toBe(mounted);
    });

    test('renders groups, folders, Back, hidden counts and badges', async () => {
        model = { ...model, view: 'groups', sourceCount: 5, hasAnyFilter: true, folderOpen: true, entities: [
            { type: 'group', id: 'group-id', item: { id: 'group-id', name: 'Group', fav: true } },
            { type: 'tag', id: 'tag-id', item: { name: 'Folder', folder_type: 'OPEN' } },
        ] };
        await mount();
        const group = document.querySelector('.group_select');
        expect(group.getAttribute('data-grid')).toBe('group-id');
        expect(group.getAttribute('grid')).toBe('group-id');
        expect(group.querySelector('.avatar img')).not.toBeNull();
        expect(group.querySelector('.group_select_counter').textContent).toBe('2 characters');
        expect(document.querySelector('[tagid="tag-id"]').classList.contains('bogus_folder_select')).toBe(true);
        expect(document.querySelector('[tagid="back"]')).not.toBeNull();
        expect(rows().at(-1).textContent).toContain('4 hidden');
    });

    test('keeps empty subtitle hooks hidden and reveals them when character data arrives', async () => {
        await mount();
        const row = rows()[0];
        expect(row.querySelector('.character_version')).not.toBeNull();
        expect(row.querySelector('.ch_description')).not.toBeNull();
        expect(row.querySelector('.character_version').hidden).toBe(true);
        expect(row.querySelector('.ch_description').hidden).toBe(true);
        expect(row.querySelector('.ds-entity-row__subtitle').textContent).toBe('');
        Object.assign(model.entities[0].item, { characterVersion: 'v2', creatorNotes: 'Notes' });
        await mounted.render(model);
        expect(row.querySelector('.character_version').hidden).toBe(false);
        expect(row.querySelector('.ch_description').hidden).toBe(false);
        expect(row.querySelector('.ds-entity-row__subtitle').textContent).toBe('v2 · Notes');
        model.entities[0].item.characterVersion = '';
        await mounted.render(model);
        expect(row.querySelector('.character_version').hidden).toBe(true);
        expect(row.querySelector('.ds-entity-row__subtitle').textContent).toBe('Notes');
    });

    test('pencil and menu clicks do not activate rows and retained handlers use current data', async () => {
        await mount();
        const row = rows()[0];
        const activation = jest.fn();
        row.addEventListener('click', activation);
        model.entities[0].id = 9;
        model.entities[0].item.name = 'Changed';
        await mounted.render(model);
        row.querySelector('[aria-label="Edit"]').click();
        await settle();
        expect(navigate).toHaveBeenCalledWith({ kind: 'character-editor', id: '0.png', via: 'character-list' }, expect.objectContaining({ from: expect.any(Function) }));
        row.querySelector('[aria-label="Actions for Changed"]').click();
        await settle();
        expect(action('Convert to Persona')).toBeDefined();
        action('Favorites').onSelect();
        await settle();
        expect(toggleCharacterFavoriteById).toHaveBeenCalledWith(9);
        expect(activation).not.toHaveBeenCalled();
    });

    test('Enter/Space activate exactly once with the real upstream global keyboard handler', async () => {
        await mount();
        const previousCSS = globalThis.CSS;
        globalThis.CSS = { supports: () => false };
        const { initKeyboard } = await import('../../public/scripts/keyboard.js');
        const listeners = jest.spyOn(document, 'addEventListener');
        jest.spyOn(console, 'debug').mockImplementation(() => {});
        initKeyboard();
        const handler = listeners.mock.calls.find(([event]) => event === 'keydown')[1];
        try {
            const row = rows()[0];
            const activation = jest.fn();
            row.addEventListener('click', activation);
            for (const key of ['Enter', ' ']) {
                mounted.section.hidden = false;
                resize();
                row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
                await settle();
            }
            expect(selectCharacterById).toHaveBeenCalledTimes(2);
            expect(activation).not.toHaveBeenCalled();
            const edit = row.querySelector('button');
            edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            expect(selectCharacterById).toHaveBeenCalledTimes(2);
            mounted.section.hidden = false;
            resize();
            row.focus();
            row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            expect(document.activeElement).toBe(rows()[1]);
        } finally {
            document.removeEventListener('keydown', handler);
            globalThis.CSS = previousCSS;
        }
    });

    test('pagination clamps before slicing, changes size, and isolates equal-size views', async () => {
        model.entities = characters(26);
        model.sourceCount = 26;
        pages.characters = 99;
        await mount();
        expect(rows()[0].id).toBe('CharID20');
        expect(mounted.captureState().page).toBe(3);
        const select = document.querySelector('.sb-list-pagination__size');
        select.value = '25';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(sizes.characters).toBe(25);
        expect(rows()[0].id).toBe('CharID0');
        sizes.groups = 25;
        model.view = 'groups';
        model.entities = [{ type: 'group', id: 'g', item: { id: 'g', name: 'Group' } }];
        await mounted.render(model);
        document.querySelector('.sb-list-pagination__size').value = '50';
        document.querySelector('.sb-list-pagination__size').dispatchEvent(new Event('change'));
        await settle();
        expect(sizes.groups).toBe(50);
        expect(sizes.characters).toBe(25);
    });

    test('superseded pagination renders cannot write into the new view', async () => {
        model.entities = characters(26);
        model.sourceCount = 26;
        pages.characters = 3;
        await mount();
        const outgoing = mounted.render({ ...model, entities: characters(1) });
        const incoming = mounted.render({ ...model, view: 'groups', entities: [{ type: 'group', id: 'g', item: { id: 'g', name: 'Group' } }] });
        await Promise.all([outgoing, incoming]);
        expect(pages.characters).toBe(3);
        expect(pages.groups).toBe(1);
        expect(rows()[0].getAttribute('data-grid')).toBe('g');
        expect(mounted.section.dataset.view).toBe('groups');
    });

    test('row menus expose checked favorites and dispatch the confirmed delete wrappers', async () => {
        await mount();
        rows()[0].querySelector('[aria-label^="Actions for"]').click();
        await settle();
        expect(action('Favorites').checked).toBe(false);
        expect(action('Delete').danger).toBe(true);
        action('Delete').onSelect();
        action('Duplicate').onSelect();
        await settle();
        expect(deleteCharacterById).toHaveBeenCalledWith(0);
        expect(duplicateCharacter).toHaveBeenCalledWith({ avatar: '0.png' });
        model = { ...model, view: 'groups', entities: [{ type: 'group', id: 'g', item: { id: 'g', name: 'Group', fav: true } }] };
        await mounted.render(model);
        rows()[0].querySelector('[aria-label="Edit"]').click();
        await settle();
        expect(navigate).toHaveBeenLastCalledWith({ kind: 'group-editor', id: 'g', via: 'group-list' }, expect.any(Object));
        rows()[0].querySelector('[aria-label^="Actions for"]').click();
        await settle();
        expect(action('Favorites').checked).toBe(true);
        action('Favorites').onSelect();
        action('Delete').onSelect();
        await settle();
        expect(toggleGroupFavoriteById).toHaveBeenCalledWith('g');
        expect(deleteGroupById).toHaveBeenCalledWith('g');
    });

    test('legacy bulk transports stay in the DOM but do not own shared selection', async () => {
        await mount();
        const bulk = document.getElementById('bulkEditButton');
        expect(bulk.closest('.sb-character-list__transports')).not.toBeNull();
        expect(characterGroupOverlay.setLegacyRowSelectionEnabled).toHaveBeenCalledWith(false);
        expect(characterGroupOverlay.legacyRowSelectionEnabled).toBe(false);
        button('more').click();
        action('Select').onSelect();
        await settle();
        expect(mounted.section.dataset.selectionMode).toBe('true');
        expect(document.querySelector('.bulk_select_checkbox')).toBeNull();
        mounted.destroy();
        expect(destroyTagMenu).toHaveBeenCalledTimes(1);
        expect(characterGroupOverlay.setLegacyRowSelectionEnabled).toHaveBeenLastCalledWith(true);
    });

    test('navigation snapshots restore query, page, scroll and keyed focus', async () => {
        model.entities = characters(26);
        model.sourceCount = 26;
        await mount();
        await mounted.restoreState({ query: 'Name', page: 2, scrollTop: 65, focusKey: 'character:10.png' });
        expect(setFilterData).toHaveBeenCalledWith('search', 'Name', true);
        expect(rows()[0].id).toBe('CharID10');
        expect(document.activeElement).toBe(rows()[0]);
        expect(mounted.captureState()).toEqual({ query: 'Name', page: 2, scrollTop: 65, focusKey: 'character:10.png' });
    });

    test('search shortcuts reach the upstream input engine and restored queries stay in sync', async () => {
        const input = document.getElementById('character_search_bar');
        const upstream = jest.fn();
        input.addEventListener('input', upstream);
        await mount();
        rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
        expect(input.value).toBe('x');
        expect(upstream).toHaveBeenCalledTimes(1);
        input.value = 'restored';
        await mounted.render(model);
        expect(mounted.captureState().query).toBe('restored');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(input.value).toBe('');
        expect(upstream).toHaveBeenCalledTimes(2);
    });

    test.each([0, 3])('first reveal waits for render, measured header and a row layout turn (%s rows)', async count => {
        const frames = [];
        window.requestAnimationFrame.mockImplementation(callback => { frames.push(callback); return frames.length; });
        model.entities = characters(count);
        model.sourceCount = count;
        await mount();
        expect(mounted.section.classList.contains('sb-character-list--preparing')).toBe(true);
        expect(frames).toHaveLength(0);
        const header = document.querySelector('.sb-list-header');
        const styles = jest.spyOn(window, 'getComputedStyle');
        resize([
            { target: header, contentRect: { width: 300 } },
            { target: header.querySelector('.sb-list-header__titles'), borderBoxSize: [{ inlineSize: 96 }] },
            ...[...header.querySelectorAll('button')].map(target => ({ target, borderBoxSize: [{ inlineSize: 44 }] })),
            { target: document.getElementById('rm_buttons_container'), borderBoxSize: [{ inlineSize: 40 }] },
        ]);
        expect(button('sort').hidden).toBe(true);
        expect(frames).toHaveLength(1);
        frames[0]();
        expect(mounted.section.classList.contains('sb-character-list--preparing')).toBe(true);
        frames[1]();
        expect(mounted.section.classList.contains('sb-character-list--preparing')).toBe(false);
        expect(button('sort').hidden).toBe(true);
        expect(styles).not.toHaveBeenCalled();
    });

    test('header actions, menus, overflow order and grid use existing transports', async () => {
        await mount();
        const create = jest.fn();
        document.getElementById('rm_button_create').onclick = create;
        button('new').click();
        expect(create).toHaveBeenCalledTimes(1);
        button('sort').click();
        expect(action('Name (A-Z)').checked).toBe(true);
        expect(action('Grid').checked).toBe(false);
        action('Grid').onSelect();
        await settle();
        expect(document.body.classList.contains('charListGrid')).toBe(true);
        const header = document.querySelector('.sb-list-header');
        header.style.padding = '8px';
        header.style.columnGap = '4px';
        const titles = header.querySelector('.sb-list-header__titles');
        const extensions = document.getElementById('rm_buttons_container');
        const widths = new Map([...header.querySelectorAll('button')].map(button => [button, 44]));
        widths.set(titles, 96);
        widths.set(extensions, 40);
        [...header.children].forEach(child => {
            const width = widths.get(child) ?? 0;
            jest.spyOn(child, 'getBoundingClientRect').mockReturnValue({ width });
        });
        const measure = available => resize([
            { target: header, contentRect: { width: available - 16 } },
            ...[...widths].map(([target, width]) => ({ target, contentRect: { width } })),
        ]);
        measure(375);
        expect(button('sort').hidden).toBe(false);
        expect(button('search').hidden).toBe(false);
        measure(320);
        expect(button('sort').hidden).toBe(true);
        expect(button('search').hidden).toBe(false);
        measure(270);
        expect(button('search').hidden).toBe(true);
        expect(button('new').hidden).toBe(false);
        button('more').click();
        expect(action('Show Tag List')).toBeUndefined();
        expect(action('Tags as Folders').checked).toBe(false);
        expect(action('Sort')).toBeDefined();
        expect(action('Search')).toBeDefined();
        measure(375);
        expect(button('sort').hidden).toBe(false);
        expect(button('search').hidden).toBe(false);
        widths.set(extensions, 120);
        measure(375);
        expect(button('sort').hidden).toBe(true);
        expect(button('search').hidden).toBe(true);
    });

    test('late extension buttons retain their intrinsic width when the slot flex-shrinks', async () => {
        const observe = jest.spyOn(globalThis.ResizeObserver.prototype, 'observe');
        const unobserve = jest.spyOn(globalThis.ResizeObserver.prototype, 'unobserve');
        const extensions = document.getElementById('rm_buttons_container');
        extensions.style.marginInlineStart = '2px';
        await mount();
        const header = document.querySelector('.sb-list-header');
        resize([
            { target: header, contentRect: { width: 326 } },
            { target: header.querySelector('.sb-list-header__titles'), borderBoxSize: [{ inlineSize: 104 }] },
            ...[...header.querySelectorAll('button')].map(target => ({ target, borderBoxSize: [{ inlineSize: 44 }] })),
            { target: extensions, borderBoxSize: [{ inlineSize: 4 }] },
        ]);
        expect(button('sort').hidden).toBe(false);
        const archive = document.createElement('button');
        archive.title = 'Chat Archive';
        extensions.append(archive);
        await settle();
        expect(observe).toHaveBeenCalledWith(archive, { box: 'border-box' });
        const styles = jest.spyOn(window, 'getComputedStyle');
        const bounds = jest.spyOn(Element.prototype, 'getBoundingClientRect');
        resize([
            { target: extensions, borderBoxSize: [{ inlineSize: 20 }] },
            { target: archive, borderBoxSize: [{ inlineSize: 40 }] },
        ]);
        expect(button('sort').hidden).toBe(true);
        expect(button('search').hidden).toBe(false);
        resize([{ target: extensions, borderBoxSize: [{ inlineSize: 40 }] }]);
        expect(button('sort').hidden).toBe(true);
        resize([{ target: archive, borderBoxSize: [{ inlineSize: 84 }] }]);
        expect(button('search').hidden).toBe(true);
        resize([
            { target: extensions, borderBoxSize: [{ inlineSize: 4 }] },
            { target: archive, borderBoxSize: [{ inlineSize: 0 }] },
        ]);
        expect(button('sort').hidden).toBe(false);
        expect(button('search').hidden).toBe(false);
        resize([{ target: archive, borderBoxSize: [{ inlineSize: 40 }] }]);
        expect(button('sort').hidden).toBe(true);
        archive.remove();
        await settle();
        expect(unobserve).toHaveBeenCalledWith(archive);
        resize([{ target: extensions, borderBoxSize: [{ inlineSize: 4 }] }]);
        expect(button('sort').hidden).toBe(false);
        expect(styles).not.toHaveBeenCalled();
        expect(bounds).not.toHaveBeenCalled();
    });

    test('empty library and no-results status actions reuse existing copy and transports', async () => {
        model.entities = [];
        model.sourceCount = 0;
        await mount();
        expect(document.querySelector('.sb-character-list__status').textContent).toContain('No characters found');
        model.sourceCount = 3;
        await mounted.render(model);
        expect(document.querySelector('.sb-character-list__status').textContent).toContain('No results');
    });

    test('failed first render restores engines and can be retried', async () => {
        printCharacters.mockRejectedValueOnce(new Error('first render failed'));
        await expect(mount()).rejects.toThrow('first render failed');
        expect(characterGroupOverlay.legacyRowSelectionEnabled).toBe(true);
        expect(document.querySelector('#form_character_search_form #character_search_bar')).not.toBeNull();
        expect(getMountedCharacterList()).toBeNull();
        await mount();
        expect(rows()).toHaveLength(3);
    });

    test('concurrent mounts wait for styles before registering the renderer', async () => {
        let releaseStyles;
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementationOnce(() => new Promise(resolve => { releaseStyles = resolve; }));
        const first = mountCharacterList();
        const second = mountCharacterList();
        expect(renderer).toBeNull();
        expect(document.getElementById('charListFixedTop').hasAttribute('style')).toBe(false);
        expect(document.querySelector('.sb-character-list')).toBeNull();
        releaseStyles();
        [mounted] = await Promise.all([first, second]);
        expect(await second).toBe(mounted);
        expect(document.querySelectorAll('.sb-character-list')).toHaveLength(1);
        expect(pageLoaded).toHaveBeenCalledTimes(1);
    });

    test('failed styles restore the fallback and a later mount can retry', async () => {
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementationOnce((_href, { id }) => {
            const link = document.createElement('link');
            link.id = id;
            document.head.append(link);
            return Promise.reject(new Error('stylesheet unavailable'));
        });
        await expect(mount()).rejects.toThrow('stylesheet unavailable');
        expect(document.getElementById('deferred-entity-list-css')).toBeNull();
        expect(document.querySelector('#form_character_search_form #character_search_bar')).not.toBeNull();
        expect(document.getElementById('charListFixedTop').hasAttribute('style')).toBe(false);
        expect(renderer).toBeNull();
        await mount();
        expect(rows()).toHaveLength(3);
    });
});

async function enterSelection() {
    menu = null;
    button('more').click();
    action('Select').onSelect();
    await settle();
}

describe('chat activation and current entity', () => {
    test.each([
        ['characters', false], ['characters', true], ['groups', false], ['groups', true],
    ])('%s failure (rejection: %s) after a newer shell generation never reopens or restores focus', async (view, rejects) => {
        model.view = view;
        if (view === 'groups') model.entities = [{ type: 'group', id: 'g', item: groupLibrary[0] }];
        await mount();
        let fail;
        const select = view === 'groups' ? openGroupById : selectCharacterById;
        select.mockImplementationOnce((_id, { onAccepted }) => {
            onAccepted();
            return new Promise((resolve, reject) => { fail = () => rejects ? reject(new Error('load failed')) : resolve(false); });
        });
        globalThis.toastr = { error: jest.fn() };
        rows()[0].click();
        await settle();
        expect(mounted.section.hidden).toBe(true);
        const newerDestination = document.getElementById('rm_button_create');
        newerDestination.focus();
        navigationGeneration++;
        printCharacters.mockClear();
        fail();
        await settle();
        expect(globalThis.SillyBunnyShell.openTab).not.toHaveBeenCalled();
        expect(printCharacters).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(newerDestination);
        expect(globalThis.toastr.error.mock.calls).toEqual(rejects ? [['load failed']] : []);
    });

    test.each(['characters', 'groups'])('%s Back uses the real navigation adapter and prints only the restored final state', async view => {
        model.view = view;
        if (view === 'groups') model.entities = groupLibrary.map(item => ({ type: 'group', id: item.id, item }));
        else model.entities = characters(26);
        await mount();
        const snapshot = { query: 'saved', page: view === 'groups' ? 1 : 2, scrollTop: 42, focusKey: view === 'groups' ? 'group:g' : 'character:10.png' };
        const kind = view === 'groups' ? 'group-list' : 'character-list';
        printCharacters.mockClear();
        let printedState;
        printCharacters.mockImplementationOnce(async () => {
            printedState = mounted.captureState();
            await renderer.render(model);
        });
        expect(await navigationDestinations.get(kind).open({ kind }, { restore: snapshot, isCurrent: () => true })).toBe(true);
        expect(printCharacters).toHaveBeenCalledTimes(1);
        expect(printedState).toMatchObject({ query: snapshot.query, page: snapshot.page });
        expect(mounted.captureState()).toEqual(snapshot);
    });

    test('a newer reveal discards a stale queued restore without suppressing its own print', async () => {
        await mount();
        const cancelRestore = prepareCharacterListRestore('characters', { query: 'stale', page: 2 }, () => false);
        printCharacters.mockClear();
        await mounted.revealActiveEntity();
        expect(printCharacters).toHaveBeenCalledTimes(1);
        expect(mounted.captureState()).toMatchObject({ query: '', page: 1 });
        cancelRestore();
    });

    test('navigation during recovery layout prevents deferred focus restoration', async () => {
        await mount();
        let focusFrame;
        window.requestAnimationFrame.mockImplementation(callback => { focusFrame = callback; return 1; });
        selectCharacterById.mockImplementationOnce(async (_id, { onAccepted }) => { onAccepted(); return false; });
        rows()[1].click();
        await settle();
        expect(focusFrame).toEqual(expect.any(Function));
        const destinationFocus = document.getElementById('rm_button_create');
        destinationFocus.focus();
        navigationGeneration++;
        focusFrame();
        await settle();
        expect(document.activeElement).toBe(destinationFocus);
    });

    test.each(['false', 'reject'])('an accepted load returning %s reopens its own dismissal with keyed row focus', async outcome => {
        await mount();
        const row = rows()[1];
        selectCharacterById.mockImplementationOnce(async (_id, { onAccepted }) => {
            onAccepted();
            resize();
            if (outcome === 'reject') throw new Error('load failed');
            return false;
        });
        globalThis.toastr = { error: jest.fn() };
        row.click();
        await settle();
        expect(globalThis.SillyBunnyShell.closeCharacters).toHaveBeenCalledTimes(1);
        expect(globalThis.SillyBunnyShell.openTab).toHaveBeenCalledWith('characters', 'characters');
        expect(mounted.section.hidden).toBe(false);
        expect(document.activeElement).toBe(row);
        expect(row.classList.contains('is-activating-entity')).toBe(false);
    });

    test('hidden lists defer active-row events until the next reveal', async () => {
        await mount();
        mounted.section.hidden = true;
        resize();
        model.entities[1].item.active = true;
        await eventSource.emit(event_types.CHAT_CHANGED);
        await mounted.render(model);
        expect(rows()[1].hasAttribute('aria-current')).toBe(false);
        mounted.section.hidden = false;
        resize();
        expect(rows()[1].getAttribute('aria-current')).toBe('true');
        expect(rows()[1].querySelector('.sb-character-list__active-dot').getAttribute('aria-hidden')).toBe('true');
    });

    test('unchanged presentation retains subtitle, badges and tag nodes; state-only changes keep the signature', async () => {
        model.entities[0].item.tags = ['Tag'];
        model.entities[0].item.favorite = true;
        await mount();
        const row = rows()[0];
        const subtitle = row.querySelector('.character_version');
        const badge = row.querySelector('.ch_fav_icon');
        const tag = row.querySelector('.tag');
        model.entities[0].item.active = true;
        await mounted.render(model);
        expect(row.querySelector('.character_version')).toBe(subtitle);
        expect(row.querySelector('.ch_fav_icon')).toBe(badge);
        expect(row.querySelector('.tag')).toBe(tag);
        expect(row.getAttribute('aria-current')).toBe('true');
    });

    test('view switches, initial reveals, hidden lists and large pages bypass FLIP', async () => {
        const { animateListChange } = await import('../../public/scripts/sillybunny-motion.js');
        await mount();
        expect(animateListChange).not.toHaveBeenCalled();
        await mounted.revealActiveEntity();
        expect(animateListChange).not.toHaveBeenCalled();
        model.view = 'groups';
        model.entities = [{ type: 'group', id: 'g', item: groupLibrary[0] }];
        await mounted.render(model);
        expect(animateListChange).not.toHaveBeenCalled();
        mounted.section.hidden = true;
        resize();
        await mounted.render(model);
        expect(animateListChange).not.toHaveBeenCalled();
        mounted.section.hidden = false;
        resize();
        model.view = 'characters';
        model.entities = characters(100);
        sizes.characters = 100;
        await mounted.render(model);
        await mounted.render(model);
        expect(animateListChange).not.toHaveBeenCalled();
    });

    test('shell mounting and revealing print exactly once, including an off-page active entity', async () => {
        model.entities = characters(26);
        model.sourceCount = 26;
        model.entities[24].item.active = true;
        mounted = await mountCharacterList(undefined, { render: false });
        expect(printCharacters).not.toHaveBeenCalled();
        await mounted.revealActiveEntity();
        expect(printCharacters).toHaveBeenCalledTimes(1);
        expect(mounted.captureState().page).toBe(3);
    });

    test('cached ResizeObserver measurements do not read layout or computed style on each render', async () => {
        await mount();
        const header = document.querySelector('.sb-list-header');
        resize([{ target: header, contentRect: { width: 320 } }]);
        const styles = jest.spyOn(window, 'getComputedStyle');
        const bounds = jest.spyOn(header, 'getBoundingClientRect');
        await mounted.render(model);
        await mounted.render(model);
        expect(styles).not.toHaveBeenCalled();
        expect(bounds).not.toHaveBeenCalled();
    });

    test.each(['characters', 'groups'])('%s closes on acceptance before chat loading completes, without highlight motion', async view => {
        model.view = view;
        if (view === 'groups') model.entities = [{ type: 'group', id: 'g', item: { id: 'g', name: 'Group' } }];
        await mount();
        const row = rows()[0];
        let finish;
        const select = view === 'groups' ? openGroupById : selectCharacterById;
        select.mockImplementationOnce((_id, { onAccepted }) => {
            onAccepted();
            onAccepted();
            return new Promise(resolve => { finish = resolve; });
        });
        row.querySelector('.ch_name').click();
        await settle();
        expect(select).toHaveBeenCalledWith(view === 'groups' ? 'g' : 0, { switchMenu: false, onAccepted: expect.any(Function) });
        expect(mounted.section.hidden).toBe(true);
        expect(play).not.toHaveBeenCalled();
        expect(globalThis.SillyBunnyShell.closeCharacters).toHaveBeenCalledTimes(1);
        resize();
        finish(true);
        await settle();
        expect(globalThis.SillyBunnyShell.closeCharacters).toHaveBeenCalledTimes(1);
        expect(row.classList.contains('is-activating-entity')).toBe(false);
    });

    test.each([
        ['characters', 'refused'], ['characters', 'failed'], ['characters', 'cancelled guard'],
        ['groups', 'refused'], ['groups', 'failed'], ['groups', 'cancelled guard'],
    ])('%s %s selection leaves the menu open', async (view, outcome) => {
        model.view = view;
        if (view === 'groups') model.entities = [{ type: 'group', id: 'g', item: { id: 'g', name: 'Group' } }];
        await mount();
        const select = view === 'groups' ? openGroupById : selectCharacterById;
        select.mockReset();
        if (outcome === 'failed') select.mockRejectedValue(new Error('load failed'));
        else select.mockResolvedValue(false);
        globalThis.toastr = { error: jest.fn() };
        rows()[0].click();
        await settle();
        expect(globalThis.SillyBunnyShell.closeCharacters).not.toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
        expect(rows()[0].hasAttribute('aria-current')).toBe(false);
    });

    test('entering selection while chat loading cancels deferred dismissal', async () => {
        let finish;
        selectCharacterById.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await mount();
        rows()[0].click();
        await settle();
        await enterSelection();
        finish(true);
        await settle();
        expect(globalThis.SillyBunnyShell.closeCharacters).not.toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
    });

    test('the user pin keeps a successful chat activation open', async () => {
        document.body.insertAdjacentHTML('beforeend', '<input type="checkbox" id="rm_button_panel_pin"><div id="right-nav-panel"></div>');
        document.getElementById('rm_button_panel_pin').checked = true;
        await mount();
        rows()[0].click();
        await settle();
        expect(selectCharacterById).toHaveBeenCalledTimes(1);
        expect(rows()[0].getAttribute('aria-current')).toBe('true');
        expect(mounted.section.hidden).toBe(false);
        expect(globalThis.SillyBunnyShell.closeCharacters).not.toHaveBeenCalled();
    });

    test('the shell layout pinnedOpen class alone is not a user pin', async () => {
        document.body.insertAdjacentHTML('beforeend', '<div id="right-nav-panel" class="pinnedOpen"></div>');
        await mount();
        rows()[0].click();
        await settle();
        expect(globalThis.SillyBunnyShell.closeCharacters).toHaveBeenCalledTimes(1);
    });

    test.each(['media', 'body'])('%s reduced motion commits and closes instantly without playing motion', async source => {
        window.matchMedia = jest.fn(() => ({ matches: source === 'media' }));
        document.body.classList.toggle('reduced-motion', source === 'body');
        await mount();
        rows()[0].click();
        await settle();
        expect(mounted.section.hidden).toBe(true);
        expect(play).not.toHaveBeenCalled();
        expect(globalThis.SillyBunnyShell.closeCharacters).toHaveBeenCalledTimes(1);
        delete window.matchMedia;
    });

    test('chat and group events update retained rows without rendering or affecting checkboxes', async () => {
        await mount();
        const original = rows();
        model.entities[1].item.active = true;
        printCharacters.mockClear();
        await eventSource.emit(event_types.CHAT_CHANGED);
        expect(rows()).toEqual(original);
        expect(original[1].getAttribute('aria-current')).toBe('true');
        expect(printCharacters).not.toHaveBeenCalled();
        model.entities[1].item.active = false;
        model.entities[2].item.active = true;
        await eventSource.emit(event_types.GROUP_UPDATED);
        expect(original[1].hasAttribute('aria-current')).toBe(false);
        expect(original[2].getAttribute('aria-current')).toBe('true');
        await enterSelection();
        original[0].click();
        expect(original[0].querySelector('.sb-selection-check').checked).toBe(true);
        expect(original[2].getAttribute('aria-current')).toBe('true');
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(globalThis.SillyBunnyShell.closeCharacters).not.toHaveBeenCalled();
    });

    test('folder and Back activation still reaches the upstream drilldown without selecting a chat', async () => {
        model.folderOpen = true;
        model.entities.push({ type: 'tag', id: 'folder', item: { name: 'Folder' } });
        await mount();
        const drilldown = jest.fn();
        document.addEventListener('click', drilldown);
        try {
            document.querySelector('[tagid="folder"]').click();
            document.querySelector('[tagid="back"]').click();
            expect(drilldown).toHaveBeenCalledTimes(2);
            expect(selectCharacterById).not.toHaveBeenCalled();
            expect(globalThis.SillyBunnyShell.closeCharacters).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener('click', drilldown);
        }
    });

    test('first reveal scrolls to the current row without focus theft or repeated scrolling', async () => {
        await mount();
        const row = rows()[2];
        row.scrollIntoView = jest.fn();
        model.entities[2].item.active = true;
        const focus = button('more');
        focus.focus();
        mounted.section.hidden = true;
        resize();
        mounted.section.hidden = false;
        resize();
        resize();
        expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(focus);
        mounted.section.hidden = true;
        resize();
        mounted.section.hidden = false;
        resize();
        expect(row.scrollIntoView).toHaveBeenCalledTimes(2);
    });

    test('reveal opens the page containing the current chat, but editor Back keeps its saved origin', async () => {
        model.entities = characters(26);
        model.sourceCount = 26;
        model.entities[24].item.active = true;
        await mount();
        await mounted.revealActiveEntity();
        expect(mounted.captureState().page).toBe(3);
        expect(document.getElementById('CharID24').getAttribute('aria-current')).toBe('true');
        await mounted.restoreState({ query: '', page: 1, scrollTop: 15, focusKey: null });
        await mounted.revealActiveEntity();
        expect(mounted.captureState().page).toBe(1);
        expect(mounted.captureState().scrollTop).toBe(15);
    });
});

describe('Characters/Groups shared selection mode', () => {
    test('row capture toggles without starting a chat; controls and folders are inert', async () => {
        model.entities.push({ type: 'tag', id: 'folder', item: { name: 'Folder' } });
        model.folderOpen = true;
        model.entities[0].item.active = true;
        await mount();
        await enterSelection();
        const row = document.getElementById('CharID0');
        const activation = jest.fn();
        row.addEventListener('click', activation);
        expect(row.querySelector('.ds-entity-row__suffix').inert).toBe(true);
        expect(row.classList.contains('is-selected')).toBe(false);
        expect(document.querySelector('[tagid="folder"]').inert).toBe(true);
        expect(document.querySelector('[tagid="back"]').inert).toBe(true);
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(document.getElementById('CharID2'));
        row.querySelector('.ch_name').click();
        expect(activation).not.toHaveBeenCalled();
        expect(row.querySelector('.sb-selection-check').checked).toBe(true);
        expect(document.querySelector('.sb-selection-title').textContent).toBe('1 selected');
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(row.querySelector('.sb-selection-check').checked).toBe(false);
        expect(activation).not.toHaveBeenCalled();
        document.querySelector('.sb-selection-cancel').click();
        expect(row.querySelector('.ds-entity-row__suffix').inert).toBe(false);
        expect(row.classList.contains('is-selected')).toBe(true);
    });

    test('Shift range, Select all off-page, filtering and page re-renders retain keys', async () => {
        model.entities = characters(26);
        model.entities.push({ type: 'tag', id: 'folder', item: { name: 'Folder' } });
        model.sourceCount = 26;
        await mount();
        await enterSelection();
        rows()[0].click();
        rows()[3].dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.querySelector('.sb-selection-title').textContent).toBe('4 selected');
        document.querySelector('.sb-selection-select-all').click();
        expect(document.querySelector('.sb-selection-title').textContent).toBe('26 selected');
        await setListPage('characters', 2);
        expect(document.querySelectorAll('.is-selection-selected')).toHaveLength(10);
        model.entities = model.entities.slice(10, 12);
        await mounted.render(model);
        expect(document.querySelector('.sb-selection-title').textContent).toBe('26 selected');
        expect(document.querySelector('.sb-selection-select-all').getAttribute('aria-pressed')).toBe('true');
        characterLibrary.splice(25, 1);
        await mounted.render(model);
        expect(document.querySelector('.sb-selection-title').textContent).toBe('25 selected');
    });

    test('reloads retain avatars rather than reassigned character indices and prune replacements', async () => {
        await mount();
        await enterSelection();
        rows()[1].click();
        rows()[2].click();
        characterLibrary.splice(0, 1);
        characterLibrary.splice(1, 1, { name: 'Replacement', avatar: 'replacement.png' });
        model.entities = characterLibrary.slice(0, 3).map((item, id) => ({ type: 'character', id, item }));
        await mounted.render(model);
        expect(document.querySelector('.sb-selection-title').textContent).toBe('1 selected');
        expect(rows()[0].querySelector('.sb-selection-check').checked).toBe(true);
        expect(rows()[1].querySelector('.sb-selection-check').checked).toBe(false);
        document.querySelector('.sb-selection-action[data-action-id="delete"]').click();
        await settle();
        expect(runBulkAction).toHaveBeenCalledWith('delete', [0]);
    });

    test('bulk actions resolve the current index even if the library changed since rendering', async () => {
        await mount();
        await enterSelection();
        rows()[1].click();
        characterLibrary.splice(0, 1);
        document.querySelector('.sb-selection-action[data-action-id="delete"]').click();
        await settle();
        expect(runBulkAction).toHaveBeenCalledWith('delete', [0]);
    });

    test('bulk actions cannot use the replacement of an avatar removed since rendering', async () => {
        await mount();
        await enterSelection();
        rows()[1].click();
        characterLibrary.splice(1, 1, { name: 'Replacement', avatar: 'replacement.png' });
        document.querySelector('.sb-selection-action[data-action-id="delete"]').click();
        await settle();
        expect(runBulkAction).not.toHaveBeenCalled();
    });

    test('entering and leaving notify overlay state once, including empty selection and destroy', async () => {
        await mount();
        await enterSelection();
        expect(characterGroupOverlay.notifySharedSelectionState.mock.calls).toEqual([['select']]);
        document.querySelector('.sb-selection-cancel').click();
        await settle();
        expect(characterGroupOverlay.notifySharedSelectionState.mock.calls).toEqual([['select'], ['browse']]);
        await enterSelection();
        rows()[0].click();
        rows()[1].click();
        mounted.destroy();
        await settle();
        expect(characterGroupOverlay.notifySharedSelectionState.mock.calls).toEqual([['select'], ['browse'], ['select'], ['browse']]);
    });

    test.each([
        ['x', {}], ['f', { ctrlKey: true }], ['f', { metaKey: true }],
    ])('selection ignores search shortcut %s %j and restores it on exit', async (key, options) => {
        const input = document.getElementById('character_search_bar');
        const upstream = jest.fn();
        input.addEventListener('input', upstream);
        await mount();
        await enterSelection();
        const row = rows()[0];
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', { key, ...options, bubbles: true, cancelable: true }));
        expect(input.value).toBe('');
        expect(document.querySelector('.sb-character-list__search').hidden).toBe(true);
        expect(document.activeElement).toBe(row);
        expect(upstream).not.toHaveBeenCalled();
        document.querySelector('.sb-selection-cancel').click();
        await settle();
        row.dispatchEvent(new KeyboardEvent('keydown', { key, ...options, bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(input);
        expect(document.querySelector('.sb-character-list__search').hidden).toBe(false);
    });

    test.each(['favorite', 'tag', 'duplicate', 'persona', 'delete'])('character %s passes numeric indices and exits after settling', async actionId => {
        await mount();
        await enterSelection();
        rows()[0].click();
        rows()[1].click();
        document.querySelector(`.sb-selection-action[data-action-id="${actionId}"]`).click();
        await settle();
        expect(runBulkAction).toHaveBeenCalledWith(actionId, [0, 1]);
        expect(mounted.section.dataset.selectionMode).toBe('false');
    });

    test('paging to a disabled Next button restores a keyboard target for Escape', async () => {
        model.entities = characters(11);
        model.sourceCount = 11;
        await mount();
        await enterSelection();
        const next = document.querySelector('.sb-list-pagination__next');
        next.focus();
        next.click();
        await settle();
        expect(next.disabled).toBe(true);
        expect(document.activeElement).toBe(document.querySelector('.sb-selection-cancel'));
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(mounted.section.dataset.selectionMode).toBe('false');
    });

    test.each(['tag', 'delete'])('group %s passes string ids, including numeric-looking ids', async actionId => {
        model = { ...model, view: 'groups', entities: groupLibrary.map(item => ({ type: 'group', id: item.id, item })) };
        await mount();
        await enterSelection();
        document.querySelector('.sb-selection-select-all').click();
        expect([...document.querySelectorAll('.sb-selection-action')].map(button => button.dataset.actionId)).toEqual(['tag', 'delete']);
        document.querySelector(`.sb-selection-action[data-action-id="${actionId}"]`).click();
        await settle();
        expect(runBulkAction).toHaveBeenCalledWith(actionId, ['g', 'group-id', '0123']);
        expect(mounted.section.dataset.selectionMode).toBe('false');
    });

    test('only one action runs at a time, with busy state until completion', async () => {
        let resolve;
        runBulkAction.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        await mount();
        await enterSelection();
        rows()[0].click();
        const actionBar = document.querySelector('.sb-selection-action-bar');
        const favorite = actionBar.querySelector('[data-action-id="favorite"]');
        favorite.click();
        await settle();
        expect(actionBar.inert).toBe(true);
        expect(actionBar.getAttribute('aria-busy')).toBe('true');
        favorite.click();
        await settle();
        expect(runBulkAction).toHaveBeenCalledTimes(1);
        resolve();
        await settle();
        expect(actionBar.inert).toBe(false);
        expect(actionBar.hasAttribute('aria-busy')).toBe(false);
        expect(mounted.section.dataset.selectionMode).toBe('false');
    });

    test('a rejected bulk action reports the error, releases busy state, and retains the selection', async () => {
        globalThis.toastr = { error: jest.fn() };
        runBulkAction.mockRejectedValueOnce(new Error('bulk failed'));
        await mount();
        await enterSelection();
        rows()[0].click();
        document.querySelector('.sb-selection-action[data-action-id="favorite"]').click();
        await settle();
        expect(globalThis.toastr.error).toHaveBeenCalledWith('bulk failed');
        expect(document.querySelector('.sb-selection-action-bar').inert).toBe(false);
        expect(document.querySelector('.sb-selection-action-bar').hasAttribute('aria-busy')).toBe(false);
        expect(mounted.section.dataset.selectionMode).toBe('true');
        expect(document.querySelector('.sb-selection-title').textContent).toBe('1 selected');
    });

    test('Escape wins over search, restores focus, and view switches exit selection', async () => {
        await mount();
        const input = document.getElementById('character_search_bar');
        input.value = 'query';
        await mounted.render(model);
        await enterSelection();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(mounted.section.dataset.selectionMode).toBe('false');
        expect(document.activeElement).toBe(button('more'));
        expect(input.value).toBe('query');
        await enterSelection();
        rows()[0].click();
        model = { ...model, view: 'groups', entities: [{ type: 'group', id: 'g', item: groupLibrary[0] }] };
        await mounted.render(model);
        expect(mounted.section.dataset.selectionMode).toBe('false');
        await enterSelection();
        expect([...document.querySelectorAll('.sb-selection-action')].map(button => button.dataset.actionId)).toEqual(['tag', 'delete']);
    });

    test('empty and folder-only lists cannot enter selection', async () => {
        model.entities = [{ type: 'tag', id: 'folder', item: { name: 'Folder' } }];
        await mount();
        button('more').click();
        expect(action('Select').disabled).toBe(true);
        action('Select').onSelect();
        await settle();
        expect(mounted.section.dataset.selectionMode).toBe('false');
    });
});
