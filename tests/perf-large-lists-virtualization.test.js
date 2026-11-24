/** @jest-environment jsdom */
/* global globalThis */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const wiModel = await import('../public/scripts/sillybunny-world-info-model.js');
const wiSetEnabled = jest.fn(wiModel.setEnabled);
const wiReorder = jest.fn(wiModel.reorder);
const wiMove = jest.fn(wiModel.move);
await jest.unstable_mockModule('../public/scripts/sillybunny-world-info-model.js', () => ({
    ...wiModel,
    setEnabled: wiSetEnabled,
    reorder: wiReorder,
    move: wiMove,
}));

let wiAdapter = null;
let wiLiveState = { name: null, data: null };
let wiQuery = '';
let wiPageSize = '1000';
const wiCharacters = [];
const wiWorldInfo = { charLore: [] };
const powerUser = { charListGrid: false, show_tag_filters: true, bogus_folders: false, personas: {}, persona_descriptions: {} };

const saveWorldInfo = jest.fn(async name => name);
const setOriginal = jest.fn();
const deleteOriginal = jest.fn();
const refreshWorldInfoEditor = jest.fn(async (navigation, flashOnNav) => wiAdapter?.render({ ...wiLiveState, navigation, flashOnNav }));
const setWorldInfoEditorAdapter = jest.fn(next => {
    wiAdapter = next;
    return next?.render(wiLiveState);
});
const getWorldInfoDisplayEntries = jest.fn(data => {
    const list = Object.values(data?.entries ?? {}).filter(entry => entry && typeof entry === 'object');
    if (!wiQuery) return list;
    const needle = wiQuery.toLowerCase();
    return list.filter(entry => String(entry.comment ?? '').toLowerCase().includes(needle));
});

await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    createWorldInfoEntry: jest.fn(),
    deleteWIOriginalDataValue: deleteOriginal,
    deleteWorldInfoEntry: jest.fn(),
    duplicateWorldInfoEntry: jest.fn(),
    getWorldInfoDisplayEntries,
    getWorldInfoEditorState: () => wiLiveState,
    moveWorldInfoEntry: jest.fn().mockResolvedValue(true),
    refreshWorldInfoEditor,
    saveWorldInfo,
    setWIOriginalDataValue: setOriginal,
    setWorldInfoEditorAdapter,
    SORT_ORDER_KEY: 'world_info_sort_order',
    worldInfoFilter: {
        setFilterData: jest.fn((_type, value, silent = false) => {
            wiQuery = value;
            if (!silent) return wiAdapter?.render(wiLiveState);
        }),
    },
    world_names: ['Perf Lorebook'],
    world_info: wiWorldInfo,
}));

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: powerUser }));
await jest.unstable_mockModule('../public/scripts/filters.js', () => ({ FILTER_TYPES: { WORLD_INFO_SEARCH: 'world_info_search' } }));
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    navigation_option: { none: -2000, previous: -1000 },
    flashHighlight: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: {
        getItem: jest.fn(key => key === 'WI_PerPage' ? wiPageSize : '0'),
        setItem: jest.fn((key, val) => {
            if (key === 'WI_PerPage') wiPageSize = String(val);
        }),
    },
}));
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: Object.assign(jest.fn(), { show: { confirm: jest.fn().mockResolvedValue(true) } }),
    POPUP_TYPE: { CONFIRM: 1 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CUSTOM1: 3, CUSTOM2: 4 },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-motion.js', () => ({
    play: jest.fn((_node, _frames, options) => { options?.onEnd?.(); return { cancel() {} }; }),
    stopMotion: jest.fn(),
    prefersReducedMotion: () => true,
    animateHeightFrom: jest.fn(),
    animateOut: jest.fn((_node, _frames, hide) => hide()),
    animateListChange: jest.fn((_rows, update) => update()),
    SPRING_NAVIGATION: {},
    MOTION_FAST: 0,
    MOTION_SLOW: 0,
    MOTION_EASE_OUT_CUBIC: 'cubic-bezier(0.33, 1, 0.68, 1)',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu: jest.fn(),
    closeActionMenu: jest.fn(),
    isActionMenuOpen: jest.fn(() => false),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-delete-confirm.js', () => ({
    confirmVerb: label => ({ okButton: label, defaultResult: 0 }),
    confirmDestructiveAction: jest.fn(async () => true),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/picker.js', () => ({
    openPicker: jest.fn(() => ({ close: jest.fn() })),
    closePicker: jest.fn(),
    isPickerOpen: jest.fn(() => false),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/tag-filter-menu.js', () => ({
    attachTagFilterMenu: jest.fn(() => ({ refresh: jest.fn(), destroy: jest.fn() })),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/navigation.js', () => ({
    registerEditorNavigation: jest.fn(() => () => {}),
    characterTabGuardSelector: name => `guard-${name}`,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/object-navigation.js', () => ({
    objectNavigation: { navigate: jest.fn(), back: jest.fn(), register: jest.fn(), setNotify: jest.fn(), bindTopLevelClear: jest.fn() },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-world-info-entry.js', () => ({
    mountWorldInfoEntry: jest.fn(({ host }) => {
        const input = document.createElement('input');
        host.append(input);
        return {
            isDirty: () => false,
            save: async () => true,
            discard: () => {},
            sync: jest.fn(),
            rebaseKey: jest.fn(),
            destroy: jest.fn(),
            focusTarget: () => input,
        };
    }),
    worldInfoDraftKey: (name, uid = '') => `draft-${name}-${uid}`,
}), { virtual: true });
await jest.unstable_mockModule('../public/scripts/sillybunny-world-info-settings.js', () => ({
    mountWorldInfoSettings: jest.fn(() => ({ destroy: jest.fn(), focusTarget: () => null })),
}), { virtual: true });

let charRenderer = null;
let charStateRenderer = null;
let charModel = null;
const charPages = { characters: 1, groups: 1 };
const charSizes = { characters: 50, groups: 50 };
const charSorts = { characters: { field: 'name', order: 'asc' }, groups: { field: 'name', order: 'asc' } };
const charLibrary = [];
const groupLibrary = [];
let activeSelectedGroup = null;
const getGroupRowDataSpy = jest.fn(group => ({
    id: group.id,
    name: group.name,
    memberCountText: '0 characters',
    memberNamesText: '',
}));

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: charLibrary,
    setCharacterListRenderer: value => { charRenderer = value; },
    printCharacters: jest.fn(async () => charRenderer?.render(charModel)),
    getCharacterRowData: (item, id) => ({
        ...item,
        id,
        chid: id,
        avatarUrl: item.avatarUrl ?? `/thumb/${item.avatar}`,
        creatorNotes: item.creatorNotes ?? item.data?.creator_notes ?? '',
        characterVersion: item.characterVersion ?? item.data?.character_version ?? '',
    }),
    getGroupRowData: getGroupRowDataSpy,
    entitiesFilter: { setFilterData: jest.fn(), clearFuzzySearchCaches: jest.fn() },
    getHiddenBlock: async count => {
        const div = document.createElement('div');
        div.innerHTML = `<p>${count} hidden</p>`;
        return div;
    },
    getEmptyBlock: async () => {
        const div = document.createElement('div');
        div.innerHTML = '<div><h1>No characters found</h1></div>';
        return div;
    },
    toggleCharacterFavoriteById: jest.fn(),
    duplicateCharacter: jest.fn(),
    deleteCharacterById: jest.fn(),
    characterGroupOverlay: {
        setLegacyRowSelectionEnabled: jest.fn(),
        notifySharedSelectionState: jest.fn(async () => {}),
        runBulkAction: jest.fn(async () => {}),
    },
    selectCharacterById: jest.fn(async () => true),
    setActiveCharacter: jest.fn(),
    setActiveGroup: jest.fn(),
    saveSettingsDebounced: jest.fn(),
    this_chid: 0,
}));

await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    groups: groupLibrary,
    get selected_group() { return activeSelectedGroup; },
    openGroupById: jest.fn(async () => true),
    toggleGroupFavoriteById: jest.fn(),
    deleteGroupById: jest.fn(),
    getGroupAvatarElement: group => {
        const wrapper = document.createElement('div');
        const img = document.createElement('img');
        img.src = `/group/${group.id}.png`;
        wrapper.append(img);
        return wrapper;
    },
}));

await jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    getTagsList: () => [],
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-character-list-state.js', () => ({
    getCharacterListView: () => charModel?.view ?? 'characters',
    registerCharacterListStateRenderer: fn => { charStateRenderer = fn; },
    getListPage: view => charPages[view],
    setListPage: jest.fn((view, page) => {
        charPages[view] = page;
        return charStateRenderer?.();
    }),
    getListPageSize: view => charSizes[view],
    setListPageSize: jest.fn((view, size) => {
        charSizes[view] = size;
        return charStateRenderer?.();
    }),
    getListSort: view => charSorts[view],
    setListSort: jest.fn(),
    getListSortOptions: () => [{ field: 'name', order: 'asc', label: 'Name (A-Z)' }],
}));

let bgImages = [];
let bgImageMap = new Map();
let bgFolderIndex = { folders: [], imageFolderMap: {} };
let bgGalleryHost = null;
const createThumbnailMock = jest.fn(imageData => {
    const cell = document.createElement('div');
    cell.className = 'bg_example flex-container';
    cell.setAttribute('bgfile', imageData.filename);
    cell.setAttribute('title', imageData.filename);
    cell.setAttribute('custom', 'false');
    cell.setAttribute('animated', String(Boolean(imageData.isAnimated)));
    cell.setAttribute('data-media-type', imageData.mediaType ?? 'image');
    cell.setAttribute('data-url', `url("backgrounds/${encodeURIComponent(imageData.filename)}")`);
    return cell;
});

await jest.unstable_mockModule('../public/scripts/backgrounds.js', () => ({
    attachBackgroundGallery: jest.fn(host => {
        bgGalleryHost = host;
        return {
            getImages: () => bgImages,
            getImageMap: () => bgImageMap,
            getFolderIndex: () => bgFolderIndex,
            sortFiles: files => [...files].sort(),
            createThumbnail: createThumbnailMock,
            activateLazyLoader: jest.fn(),
            refreshHighlights: jest.fn(),
            isVideo: file => file.endsWith('.mp4'),
            getThumbnailUrl: file => `/thumbnail/bg/${file}`,
            getActiveTab: () => 0,
            getTabs: () => ({ GLOBAL: 0, CHAT: 1 }),
            selectBackground: jest.fn(),
            isLocked: () => false,
            lockBackground: jest.fn(),
            unlockBackground: jest.fn(),
            renameBackground: jest.fn(),
            deleteBackgroundWithConfirmation: jest.fn(),
            deleteBackgrounds: jest.fn(async () => ({ deleted: [], failed: [] })),
            reload: jest.fn(),
            getRequestHeaders: () => ({}),
        };
    }),
}));

const {
    mountWorldInfoEditor,
    worldInfoRowSignature,
} = await import('../public/scripts/sillybunny-world-info-editor.js');
const {
    mountCharacterList,
    CHARACTER_LIST_MAX_MOUNTED_ROWS,
    compactTextKey,
    buildGroupMemberIndex,
    resolveGroupRowData,
    entityPresentationSignature,
} = await import('../public/scripts/sillybunny-character-list.js');
const {
    createEntityRow,
    limitTagChips,
    releaseTagChips,
    getObservedTagStripCount,
} = await import('../public/scripts/sillybunny-editor/entity-row.js');
const {
    initBackgroundGallery,
    createBackgroundFolderAdapter,
    buildBackgroundImageMap,
    reconcileBackgroundGrid,
} = await import('../public/scripts/sillybunny-background-gallery.js');
const folderStore = await import('../public/scripts/sillybunny-folders.js');

const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};

function makeLargeBook(count = 1000, contentBytes = 4096) {
    const paragraph = 'Lore entry payload: "Ancient citadel dialogue" & multiline notes.\n';
    const loreBody = paragraph.repeat(Math.ceil(contentBytes / paragraph.length));
    const entries = {};
    for (let index = 0; index < count; index++) {
        entries[index] = {
            uid: index,
            comment: `Lore Entry ${index}`,
            key: [`keyword_${index}`, `alias_${index}`],
            keysecondary: ['secondary'],
            content: `${loreBody}#${index}`,
            disable: false,
            displayIndex: index,
            position: 0,
            depth: 4,
            role: 0,
            order: 100 + (index % 50),
            selective: true,
            selectiveLogic: 0,
            probability: 100,
            useProbability: true,
            constant: index % 10 === 0,
            vectorized: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            triggers: [],
            characterFilter: { isExclude: false, names: [], tags: [] },
        };
    }
    return { entries };
}

describe('PR 14 Large-Lists Virtualization & Performance Benchmarks', () => {
    let wiMounted = null;
    let charMounted = null;

    beforeEach(() => {
        jest.clearAllMocks();
        wiAdapter = null;
        wiLiveState = { name: null, data: null };
        wiQuery = '';
        wiPageSize = '1000';
        wiCharacters.length = 0;
        charLibrary.length = 0;
        groupLibrary.length = 0;
        activeSelectedGroup = null;
        charPages.characters = 1;
        charPages.groups = 1;
        charSizes.characters = 50;
        charSizes.groups = 50;
        let folderSeq = 0;
        powerUser.sb_folders = folderStore.normalizeFoldersData(null, () => `f-${++folderSeq}`);
        folderStore.configureFolderStore({
            powerUser,
            saveSettingsDebounced: jest.fn(),
            idFactory: () => `f-${++folderSeq}`,
        });
        globalThis.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
        globalThis.ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
        globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn().mockResolvedValue() };
        globalThis.$ = jest.fn(() => ({
            on: jest.fn(),
            val: jest.fn(() => ({ trigger: jest.fn() })),
        }));
        jest.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(0); return 1; });
        jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        document.body.replaceChildren();
    });

    afterEach(() => {
        wiMounted?.destroy();
        wiMounted = null;
        charMounted?.destroy();
        charMounted = null;
        jest.restoreAllMocks();
        delete globalThis.SillyBunnyAssets;
        delete globalThis.$;
        document.body.replaceChildren();
    });

    describe('1. World Info Editor (1,000 entries)', () => {
        function setupWorldInfoDom() {
            document.body.innerHTML = `<div id="sb_character_world_info_panel"><div id="WorldInfo"><div id="wi-holder">
                <div id="wiTopBlock"></div><div id="world_popup">
                <select id="world_editor_select"><option value="0">Perf Lorebook</option></select>
                <input id="world_info_search">
                <select id="world_info_sort_order"><option value="0" data-rule="priority">Priority</option><option value="13" data-rule="custom">Custom</option></select>
                <button class="world_info_view_filter is-active" data-filter="all">All</button>
                <button id="world_popup_new"></button><button id="world_create_button"></button><button id="world_import_button"></button>
                <button id="world_refresh"></button><button id="world_apply_current_sorting"></button>
                </div></div></div></div>`;
            return document.getElementById('WorldInfo');
        }

        test('primitive signature excludes entry.content and entry.disable and beats JSON.stringify across 1,000 4KB entries', () => {
            const data = makeLargeBook(1000, 4096);
            const list = Object.values(data.entries);
            const first = list[0];

            const baseSig = worldInfoRowSignature(first, false);
            first.content = 'Updated multi-megabyte content '.repeat(500);
            first.disable = true;
            expect(worldInfoRowSignature(first, false)).toBe(baseSig);

            first.comment = 'Renamed Title';
            expect(worldInfoRowSignature(first, false)).not.toBe(baseSig);

            for (const entry of list) {
                JSON.stringify([entry, false, false]);
                worldInfoRowSignature(entry, false);
            }

            const rounds = 10;
            const jsonStart = performance.now();
            for (let iter = 0; iter < rounds; iter++) {
                for (const entry of list) JSON.stringify([entry, false, false]);
            }
            const jsonElapsed = (performance.now() - jsonStart) / rounds;

            const primStart = performance.now();
            for (let iter = 0; iter < rounds; iter++) {
                for (const entry of list) worldInfoRowSignature(entry, false);
            }
            const primElapsed = (performance.now() - primStart) / rounds;

            expect(primElapsed).toBeLessThan(10);
            expect(primElapsed).toBeLessThan(jsonElapsed * 0.25);
        });

        test('virtualizes 1,000-entry pages, updates toggle state in place under 10 ms, and preserves ARIA setsize/posinset + keyboard focus', async () => {
            const container = setupWorldInfoDom();
            const data = makeLargeBook(1000, 4096);
            wiLiveState = { name: 'Perf Lorebook', data };
            wiMounted = mountWorldInfoEditor(container);
            await settle();

            const listBody = container.querySelector('.sb-wi-list-body');
            Object.defineProperty(listBody, 'clientHeight', { configurable: true, value: 560 });

            await wiAdapter.render({ ...wiLiveState, navigation: -1000 });
            await settle();

            const mountedRows = () => [...container.querySelectorAll('.sb-wi-row')];
            expect(mountedRows().length).toBeLessThanOrEqual(60);
            expect(mountedRows()[0].getAttribute('aria-setsize')).toBe('1000');
            expect(mountedRows()[0].getAttribute('aria-posinset')).toBe('1');

            const rowZeroBefore = container.querySelector('.sb-wi-row[data-uid="0"]');
            const switchInput = rowZeroBefore.querySelector('.sb-wi-row-enable input');

            // Warm once so JIT tiering does not skew the measured single-toggle latency.
            switchInput.checked = false;
            switchInput.dispatchEvent(new Event('change', { bubbles: true }));
            await settle();

            const samples = [];
            for (let round = 0; round < 5; round++) {
                const nextChecked = round % 2 === 0;
                const t0 = performance.now();
                switchInput.checked = nextChecked;
                switchInput.dispatchEvent(new Event('change', { bubbles: true }));
                await settle();
                samples.push(performance.now() - t0);
            }
            samples.sort((a, b) => a - b);
            const medianToggleMs = samples[Math.floor(samples.length / 2)];

            expect(medianToggleMs).toBeLessThan(10);
            expect(container.querySelector('.sb-wi-row[data-uid="0"]')).toBe(rowZeroBefore);
            expect(rowZeroBefore.classList.contains('is-disabled')).toBe(false);

            rowZeroBefore.focus();
            rowZeroBefore.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
            expect(mountedRows().length).toBeLessThanOrEqual(60);
            const lastRow = container.querySelector('.sb-wi-row[data-uid="999"]');
            expect(lastRow).not.toBeNull();
            expect(document.activeElement).toBe(lastRow);
            expect(lastRow.getAttribute('aria-setsize')).toBe('1000');
            expect(lastRow.getAttribute('aria-posinset')).toBe('1000');

            lastRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
            const firstRowAgain = container.querySelector('.sb-wi-row[data-uid="0"]');
            expect(document.activeElement).toBe(firstRowAgain);
            expect(firstRowAgain.getAttribute('aria-posinset')).toBe('1');
        });

        test('keeps identical full-page rendering without virtual padding on small lists (<= 100 entries)', async () => {
            wiPageSize = '100';
            const container = setupWorldInfoDom();
            const data = makeLargeBook(80, 256);
            wiLiveState = { name: 'Perf Lorebook', data };
            wiMounted = mountWorldInfoEditor(container);
            await settle();

            const entryBox = container.querySelector('.sb-wi-list-box');
            expect(container.querySelectorAll('.sb-wi-row')).toHaveLength(80);
            expect(entryBox.style.paddingTop).toBe('');
            expect(entryBox.style.paddingBottom).toBe('');
        });
    });

    describe('2. Character List Virtualization, Primitive Signatures & Group Membership Map', () => {
        function setupCharacterListDom() {
            document.body.innerHTML = `<div id="rm_characters_block"><div id="charListFixedTop"><div id="rm_button_bar"><div id="rm_buttons_container"></div></div>
                <form id="form_character_search_form"><input id="character_search_bar"></form>
                <div class="rm_tag_controls"><div class="rm_tag_filter"><button class="filterByFavorites"></button><button class="filterByFolder"></button><button class="clearAllFilters"></button><button class="manageTags"></button><button class="showTagList"></button></div><div class="rm_tag_bogus_drilldown"></div></div></div>
                <div id="rm_print_characters_pagination"><button id="charListGridToggle"></button><button id="bulkEditButton"></button><span id="bulkSelectedCount"></span><button id="bulkSelectAllButton"></button><button id="bulkDeleteButton"></button></div>
                <div id="rm_print_characters_block"></div></div><button id="rm_button_create"></button><button id="rm_button_group_chats"></button>`;
        }

        function seedCharacters(count = 1000) {
            const longNotes = 'Creator notes paragraph with rich backstory. '.repeat(200);
            charLibrary.length = 0;
            const entities = [];
            for (let id = 0; id < count; id++) {
                const item = {
                    name: `Character ${id}`,
                    avatar: `char_${id}.png`,
                    creatorNotes: `${longNotes}#${id}`,
                    characterVersion: id % 3 === 0 ? `v${id}` : '',
                    tags: ['Fantasy', 'Adventure', 'SciFi', 'Mystery'],
                    active: false,
                };
                charLibrary.push(item);
                entities.push({ type: 'character', id, item });
            }
            return entities;
        }

        test('caps mounted DOM rows at <= 60 even when revealing active row #950 of 1,000, preserving aria-setsize/posinset and roving focus', async () => {
            setupCharacterListDom();
            const entities = seedCharacters(1000);
            entities[950].item.active = true;
            charModel = {
                view: 'characters',
                entities,
                sourceCount: 1000,
                hasAnyFilter: false,
                folderOpen: false,
                fullRefresh: false,
                pageLoaded: jest.fn(),
            };

            charMounted = await mountCharacterList(undefined, { render: false });
            jest.spyOn(charMounted.section, 'getClientRects').mockReturnValue([{}]);
            const box = charMounted.section.querySelector('.sb-character-list__box');
            Object.defineProperty(box, 'clientHeight', { configurable: true, value: 560 });

            const revealStart = performance.now();
            await charMounted.revealActiveEntity();
            const revealMs = performance.now() - revealStart;

            const mountedRows = () => [...document.querySelectorAll('#rm_print_characters_block > .ds-entity-row')];
            expect(mountedRows().length).toBeLessThanOrEqual(CHARACTER_LIST_MAX_MOUNTED_ROWS);
            expect(CHARACTER_LIST_MAX_MOUNTED_ROWS).toBeLessThanOrEqual(60);
            expect(revealMs).toBeLessThan(250);

            const activeRow = document.getElementById('CharID950');
            expect(activeRow).not.toBeNull();
            expect(activeRow.getAttribute('aria-current')).toBe('true');
            expect(activeRow.getAttribute('aria-setsize')).toBe('1000');
            expect(activeRow.getAttribute('aria-posinset')).toBe('951');

            expect(await charMounted.revealByKey('character:char_120.png')).toBe(true);
            expect(mountedRows().length).toBeLessThanOrEqual(60);
            const row120 = document.getElementById('CharID120');
            expect(document.activeElement).toBe(row120);
            expect(row120.getAttribute('aria-posinset')).toBe('121');

            row120.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
            const row0 = document.getElementById('CharID0');
            expect(document.activeElement).toBe(row0);
            expect(row0.tabIndex).toBe(0);
            expect(row0.getAttribute('aria-posinset')).toBe('1');
            expect(mountedRows().length).toBeLessThanOrEqual(60);

            for (let step = 0; step < 65; step++) {
                document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
            }
            const row65 = document.getElementById('CharID65');
            expect(document.activeElement).toBe(row65);
            expect(row65.tabIndex).toBe(0);
            expect(row65.getAttribute('aria-posinset')).toBe('66');
            expect(mountedRows().length).toBeLessThanOrEqual(60);

            row65.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
            const row999 = document.getElementById('CharID999');
            expect(document.activeElement).toBe(row999);
            expect(row999.tabIndex).toBe(0);
            expect(row999.getAttribute('aria-posinset')).toBe('1000');
            expect(mountedRows().length).toBeLessThanOrEqual(60);

            row999.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
            const row998 = document.getElementById('CharID998');
            expect(document.activeElement).toBe(row998);
            expect(row998.tabIndex).toBe(0);
            expect(row998.getAttribute('aria-posinset')).toBe('999');
        });

        test('compact primitive presentation keys avoid JSON.stringify(creatorNotes) and omit empty group subtitles', () => {
            const largeNotes = 'Detailed character lore '.repeat(800);
            const keyA = compactTextKey(largeNotes);
            const keyB = compactTextKey(`${largeNotes}!`);
            expect(keyA.length).toBeLessThan(120);
            expect(keyA).not.toBe(keyB);

            const entry = {
                kind: 'character',
                entity: { id: 1 },
                item: { name: 'Hero', avatar: 'hero.png' },
                data: { chid: 1, name: 'Hero', avatarTitle: 'Avatar', nameTitle: 'Hero' },
                label: 'Hero',
                auxText: 'v1',
                notesText: largeNotes,
                avatarFileText: 'hero.png',
                showAvatar: false,
                favorite: true,
                assistant: false,
                avatarSrc: '/thumb/hero.png',
            };
            const sig1 = entityPresentationSignature(entry, [{ id: 't1', name: 'Action', filter_state: 'SELECTED' }], ['Edit', 'Actions']);
            const sig2 = entityPresentationSignature(entry, [{ id: 't1', name: 'Action', filter_state: 'EXCLUDED' }], ['Edit', 'Actions']);
            expect(sig1).toBe(sig2);

            const emptyGroupRow = createEntityRow({
                key: 'group:empty',
                label: 'Empty Group',
                subtitle: null,
            });
            expect(emptyGroupRow.slots.subtitle).toBeNull();
        });

        test('pre-indexed group membership Map resolves 200 groups x 10 members across 1,000 characters in O(G*M + C) without calling O(G*M*C) getGroupRowData', async () => {
            setupCharacterListDom();
            seedCharacters(1000);
            // Add an intentional name/avatar collision case to verify Array.prototype.find precedence parity.
            charLibrary[5].name = 'char_900.png';

            const index = buildGroupMemberIndex(charLibrary);
            expect(index.findMember('char_900.png')).toBe(charLibrary[5]);
            expect(index.findByAvatar('char_900.png')).toBe(charLibrary[900]);

            groupLibrary.length = 0;
            const groupEntities = [];
            for (let g = 0; g < 200; g++) {
                const members = Array.from({ length: 10 }, (_, m) => `char_${(g * 7 + m * 97) % 1000}.png`);
                const group = {
                    id: `group-${g}`,
                    name: `Group ${g}`,
                    members,
                    fav: g % 2 === 0,
                    avatar_url: '',
                };
                groupLibrary.push(group);
                groupEntities.push({ type: 'group', id: group.id, item: group });
            }
            activeSelectedGroup = 'group-180';
            charSizes.groups = 200;
            charModel = {
                view: 'groups',
                entities: groupEntities,
                sourceCount: 200,
                hasAnyFilter: false,
                folderOpen: false,
                fullRefresh: false,
                pageLoaded: jest.fn(),
            };

            getGroupRowDataSpy.mockClear();
            const t0 = performance.now();
            const idx = buildGroupMemberIndex(charLibrary);
            const resolvedAll = groupLibrary.map(group => resolveGroupRowData(group, idx, activeSelectedGroup));
            const mapResolveMs = performance.now() - t0;

            expect(mapResolveMs).toBeLessThan(50);
            expect(resolvedAll[0].memberCount).toBe(10);
            expect(resolvedAll[0].avatarInfo.memberAvatars).toHaveLength(4);
            expect(resolvedAll[180].active).toBe(true);
            expect(resolvedAll[0].active).toBe(false);

            groupLibrary[180].active = true;
            charMounted = await mountCharacterList(undefined, { render: false });
            jest.spyOn(charMounted.section, 'getClientRects').mockReturnValue([{}]);
            await charMounted.revealActiveEntity();

            expect(getGroupRowDataSpy).not.toHaveBeenCalled();
            const mountedGroupRows = document.querySelectorAll('#rm_print_characters_block > .ds-entity-row');
            expect(mountedGroupRows.length).toBeLessThanOrEqual(60);
            const activeGroupRow = document.querySelector('[data-grid="group-180"]');
            expect(activeGroupRow).not.toBeNull();
            expect(activeGroupRow.getAttribute('aria-current')).toBe('true');
        });
    });

    describe('3. Entity Row limitTagChips Leak Elimination & Cached Width Fitting', () => {
        test('releases disconnected tag strips with zero retained strip count and performs zero probe allocations or layout reads on repeat resizes', () => {
            let resizeCallback = null;
            const observed = new Set();
            const observe = jest.fn(el => observed.add(el));
            const unobserve = jest.fn(el => observed.delete(el));
            globalThis.ResizeObserver = jest.fn(function (cb) {
                resizeCallback = cb;
                this.observe = observe;
                this.unobserve = unobserve;
                this.disconnect = () => observed.clear();
            });

            const chipRectSpy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
                const width = this.classList.contains('sb-tag-overflow--measure') ? 28 : 42;
                return { width, height: 24, top: 0, left: 0, right: width, bottom: 24 };
            });

            const rowsCreated = [];
            for (let i = 0; i < 100; i++) {
                const { row, slots } = createEntityRow({ key: `character:${i}.png`, label: `Char ${i}`, tags: true });
                slots.tags.style.columnGap = '6px';
                for (const tagName of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) {
                    const chip = document.createElement('span');
                    chip.className = 'tag';
                    chip.textContent = tagName;
                    slots.tags.append(chip);
                }
                document.body.append(row);
                limitTagChips(slots.tags);
                rowsCreated.push({ row, tags: slots.tags });
            }

            expect(getObservedTagStripCount()).toBe(100);

            resizeCallback(rowsCreated.map(({ tags }) => ({ target: tags, contentRect: { width: 140 } })));
            const initialReads = chipRectSpy.mock.calls.length;
            expect(initialReads).toBeLessThanOrEqual(302);

            chipRectSpy.mockClear();
            const createElementSpy = jest.spyOn(document, 'createElement');
            resizeCallback(rowsCreated.map(({ tags }) => ({ target: tags, contentRect: { width: 95 } })));
            expect(chipRectSpy).not.toHaveBeenCalled();
            expect(createElementSpy).not.toHaveBeenCalled();
            expect(rowsCreated[0].tags.querySelector('.sb-tag-overflow').textContent).toBe('+4');
            createElementSpy.mockRestore();

            for (let i = 0; i < 60; i++) {
                releaseTagChips(rowsCreated[i].row);
                rowsCreated[i].row.remove();
            }
            for (let i = 60; i < 100; i++) {
                rowsCreated[i].row.remove();
            }
            expect(getObservedTagStripCount()).toBe(0);
            expect(observed.size).toBe(0);
        });
    });

    describe('4. Background Gallery O(1) Map Lookup, Keyed Reconciliation & Lazy Folder Thumbnails', () => {
        function setupBackgroundGalleryDom() {
            document.body.innerHTML = `<div id="Backgrounds">
                <div id="bg-header-fixed"><div class="bg-header-row-2"><input id="bg-filter"><select id="bg-sort"><option value="az">A-Z</option><option value="za">Z-A</option></select></div></div>
                <button id="auto_background"></button>
                <div id="bg_tabs">
                    <div class="heading-controls"><button id="add_background_button_top"><span>Add</span></button><input id="add_bg_button"><button id="bg-scroll-top"></button></div>
                    <div class="bg_tab_panel" id="bg_global_tab"><div id="bg_menu_content"></div></div>
                </div>
            </div>`;
        }

        test('indexes 1,000 backgrounds in a Map without Array.find, batches via DocumentFragment, preserves DOM nodes across re-renders, and sets lazy/async on Folder Manager avatars', async () => {
            setupBackgroundGalleryDom();
            const rawImages = Array.from({ length: 1000 }, (_, i) => ({
                filename: `bg_${String(i).padStart(4, '0')}.jpg`,
                isAnimated: i % 20 === 0,
                mediaType: 'image',
            }));
            // Trap any accidental O(N^2) Array.prototype.find on the images list.
            bgImages = new Proxy(rawImages, {
                get(target, prop, receiver) {
                    if (prop === 'find') {
                        throw new Error('Unexpected linear Array.prototype.find() on background images');
                    }
                    return Reflect.get(target, prop, receiver);
                },
            });
            bgImageMap = buildBackgroundImageMap(rawImages);
            bgFolderIndex = { folders: [], imageFolderMap: {} };
            createThumbnailMock.mockClear();

            const fragmentSpy = jest.spyOn(document, 'createDocumentFragment');
            const t0 = performance.now();
            await initBackgroundGallery();
            const initialRenderMs = performance.now() - t0;

            const container = document.getElementById('bg_menu_content');
            expect(container.querySelectorAll('.bg_example')).toHaveLength(1000);
            expect(createThumbnailMock).toHaveBeenCalledTimes(1000);
            expect(fragmentSpy).toHaveBeenCalled();
            expect(initialRenderMs).toBeLessThan(250);

            const sampleCellBefore = container.querySelector('.bg_example[bgfile="bg_0500.jpg"]');
            expect(sampleCellBefore).not.toBeNull();

            createThumbnailMock.mockClear();
            bgGalleryHost.setQuery('bg_050');
            await settle();
            expect(container.querySelectorAll('.bg_example')).toHaveLength(10);
            expect(container.querySelector('.bg_example[bgfile="bg_0500.jpg"]')).toBe(sampleCellBefore);
            expect(createThumbnailMock).not.toHaveBeenCalled();

            const grid = document.createElement('div');
            const cache = new Map();
            const subset = ['bg_0001.jpg', 'bg_0002.jpg', 'bg_0003.jpg'];
            reconcileBackgroundGrid(grid, subset, {
                cache,
                imageMap: bgImageMap,
                createCell: file => createThumbnailMock({ filename: file }),
            });
            const [firstNode, secondNode, thirdNode] = [...grid.children];
            createThumbnailMock.mockClear();
            reconcileBackgroundGrid(grid, [...subset].reverse(), {
                cache,
                imageMap: bgImageMap,
                createCell: file => createThumbnailMock({ filename: file }),
            });
            expect([...grid.children]).toEqual([thirdNode, secondNode, firstNode]);
            expect(createThumbnailMock).not.toHaveBeenCalled();

            const adapter = createBackgroundFolderAdapter();
            const avatar = adapter.getAvatar('bg_0001.jpg');
            expect(avatar.tagName).toBe('IMG');
            expect(avatar.getAttribute('loading')).toBe('lazy');
            expect(avatar.getAttribute('decoding')).toBe('async');
        });
    });
});
