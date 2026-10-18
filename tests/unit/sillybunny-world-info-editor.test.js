/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom tests assert DOM synchronously. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const model = await import('../../public/scripts/sillybunny-world-info-model.js');
const setEnabled = jest.fn(model.setEnabled);
const reorder = jest.fn(model.reorder);
const move = jest.fn(model.move);
await jest.unstable_mockModule('../../public/scripts/sillybunny-world-info-model.js', () => ({ ...model, setEnabled, reorder, move }));

let adapter;
let liveState;
let query;
let visibleEntries;
const worldNames = ['Book A', 'Book B'];
const characters = [];
const world_info = {};
const power_user = {};
const navigate = jest.fn();
const back = jest.fn();
await jest.unstable_mockModule('../../public/script.js', () => ({ characters }));
await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({ power_user }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/object-navigation.js', () => ({ objectNavigation: { navigate, back } }));
const saveWorldInfo = jest.fn(async name => name);
const setOriginal = jest.fn();
const deleteOriginal = jest.fn();
const createEntry = jest.fn();
const duplicateEntry = jest.fn();
const deleteEntry = jest.fn();
const moveEntry = jest.fn().mockResolvedValue(true);
const refresh = jest.fn(async (navigation, flashOnNav) => adapter?.render({ ...liveState, navigation, flashOnNav }));
const setAdapter = jest.fn(next => {
    adapter = next;
    return next?.render(liveState);
});
const setFilterData = jest.fn((_type, value, silent = false) => {
    query = value;
    if (!silent) return adapter?.render(liveState);
});
const defaultDisplayEntries = data => {
    if (visibleEntries) return visibleEntries;
    return Object.values(data?.entries ?? {}).filter(entry => !query || entry.comment.toLowerCase().includes(query.toLowerCase()));
};
const displayEntries = jest.fn(defaultDisplayEntries);
await jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    createWorldInfoEntry: createEntry,
    deleteWIOriginalDataValue: deleteOriginal,
    deleteWorldInfoEntry: deleteEntry,
    duplicateWorldInfoEntry: duplicateEntry,
    getWorldInfoDisplayEntries: displayEntries,
    getWorldInfoEditorState: () => liveState,
    moveWorldInfoEntry: moveEntry,
    refreshWorldInfoEditor: refresh,
    saveWorldInfo,
    setWIOriginalDataValue: setOriginal,
    setWorldInfoEditorAdapter: setAdapter,
    SORT_ORDER_KEY: 'world_info_sort_order',
    worldInfoFilter: { setFilterData },
    world_names: worldNames,
    world_info,
}));
await jest.unstable_mockModule('../../public/scripts/filters.js', () => ({ FILTER_TYPES: { WORLD_INFO_SEARCH: 'world_info_search' } }));
const navigation = { none: -2000, previous: -1000 };
await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({ navigation_option: navigation }));
const accountStorage = { getItem: jest.fn(key => key === 'WI_PerPage' ? '10' : '0'), setItem: jest.fn() };
await jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({ accountStorage }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (values[index] ?? ''), ''),
    translate: value => value,
}));

let popupChoice;
const confirm = jest.fn().mockResolvedValue(true);
const popupShow = jest.fn(async () => popupChoice);
const Popup = jest.fn(function () {
    this.okButton = document.createElement('button');
    this.cancelButton = document.createElement('button');
    this.show = popupShow;
});
Popup.show = { confirm };
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup, POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CUSTOM1: 3, CUSTOM2: 4 },
}));
const play = jest.fn((_node, _frames, options) => { options?.onEnd?.(); return { cancel() {} }; });
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    play,
    stopMotion: jest.fn(), prefersReducedMotion: () => true,
    animateOut: jest.fn((_node, _frames, hide) => hide()),
    SPRING_NAVIGATION: {}, MOTION_FAST: 0, MOTION_SLOW: 0,
}));

let actionMenu;
const closeActionMenu = jest.fn(() => {
    const previous = actionMenu;
    actionMenu = null;
    previous?.trigger.setAttribute('aria-expanded', 'false');
    previous?.onClose?.();
});
const openActionMenu = jest.fn(options => {
    const toggling = actionMenu?.trigger === options.trigger;
    closeActionMenu();
    if (toggling) return;
    actionMenu = options;
    options.trigger.setAttribute('aria-expanded', 'true');
});
const isActionMenuOpen = jest.fn(trigger => Boolean(actionMenu) && (!trigger || actionMenu.trigger === trigger));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu, closeActionMenu, isActionMenuOpen,
}));
const openPicker = jest.fn(() => ({ close: jest.fn() }));
const isPickerOpen = jest.fn(() => false);
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ openPicker, isPickerOpen }));
const unregister = jest.fn();
const registerNavigation = jest.fn(() => unregister);
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/navigation.js', () => ({
    registerEditorNavigation: registerNavigation,
    characterTabGuardSelector: name => `guard-${name}`,
}));

let dirty;
let entryControllers;
const mountEntry = jest.fn(({ host, requestClose }) => {
    const input = document.createElement('input');
    host.append(input);
    const controller = {
        isDirty: jest.fn(() => dirty),
        save: jest.fn(async () => { dirty = false; return true; }),
        discard: jest.fn(() => { dirty = false; }),
        sync: jest.fn(), rebaseKey: jest.fn(), destroy: jest.fn(), focusTarget: () => input,
        requestClose,
    };
    entryControllers.push(controller);
    return controller;
});
const draftKey = (name, uid = '') => `sb-wi-editor-draft-test-user-${encodeURIComponent(name)}-${uid}`;
await jest.unstable_mockModule('../../public/scripts/sillybunny-world-info-entry.js', () => ({ mountWorldInfoEntry: mountEntry, worldInfoDraftKey: draftKey }), { virtual: true });
const settingsController = { destroy: jest.fn(), focusTarget: () => null };
const mountSettings = jest.fn(() => settingsController);
await jest.unstable_mockModule('../../public/scripts/sillybunny-world-info-settings.js', () => ({ mountWorldInfoSettings: mountSettings }), { virtual: true });

const { mountWorldInfoEditor, createWorldInfoDeps, pageForWorldInfoUid, preserveWorldInfoEntryOrder, collectWorldInfoUsers } = await import('../../public/scripts/sillybunny-world-info-editor.js');
const { eventSource, event_types } = await import('../../public/scripts/events.js');
let mounted;
let container;

function book(count = 1) {
    return { entries: Object.fromEntries(Array.from({ length: count }, (_, index) => [index * 7, {
        uid: index * 7, comment: `Entry ${index}`, key: [`key ${index}`], content: '', disable: false, displayIndex: index, position: 0, order: 100,
    }])) };
}

async function settle() {
    for (let index = 0; index < 20; index++) await Promise.resolve();
}

async function mount(state = { name: null, data: null }) {
    liveState = state;
    mounted = mountWorldInfoEditor(container);
    await settle();
    return mounted;
}

async function render(state, option = navigation.none) {
    liveState = state;
    await adapter.render({ ...state, navigation: option });
    await settle();
}

async function open(uid = 0) {
    container.querySelector(`[data-sb-list-key="entry:${uid}"]`).click();
    await settle();
    return entryControllers.at(-1);
}

async function selectMenuAction(label, selector = '.sb-wi-book-actions') {
    if (!isActionMenuOpen(container.querySelector(selector))) {
        container.querySelector(selector).click();
        await settle();
    }
    const item = actionMenu.sections.flatMap(section => section.items).find(item => item.label === label);
    closeActionMenu();
    item.onSelect();
    await settle();
}

function currentPage() {
    return container.querySelector('.sb-list-pagination__status').textContent;
}

test('hidden books defer filtering and DOM work until the next prepared reveal', async () => {
    await mount({ name: 'Book A', data: book(2) });
    const panel = document.getElementById('sb_character_world_info_panel');
    panel.hidden = true;
    const before = container.innerHTML;
    displayEntries.mockClear();
    await render({ name: 'Book B', data: book(3) });
    await render({ name: 'Book B', data: book(4) });
    expect(adapter.isOpen()).toBe(false);
    expect(container.innerHTML).toBe(before);
    expect(displayEntries).not.toHaveBeenCalled();
    await mounted.prepareReveal();
    expect(container.querySelector('.sb-wi-book-name').textContent).toBe('Book B');
    expect(container.querySelectorAll('.sb-wi-row')).toHaveLength(4);
    expect(refresh).toHaveBeenCalledTimes(1);
    await mounted.prepareReveal();
    expect(refresh).toHaveBeenCalledTimes(1);
});

test.each(['hidden', 'aria-hidden'])('an entry close transition completing while %s refreshes selection on the next reveal without a book update', async attribute => {
    await mount({ name: 'Book A', data: book(2) });
    const entry = await open();
    const row = container.querySelector('[data-sb-list-key="entry:0"]');
    expect(row.classList.contains('is-selected')).toBe(true);
    const completions = [];
    play.mockImplementation((_node, _frames, options) => {
        completions.push(options.onEnd);
        return { cancel() {} };
    });
    await entry.requestClose();
    expect(completions).toHaveLength(2);
    expect(container.querySelector('.sb-wi-editor').dataset.open).toBe('false');
    const panel = document.getElementById('sb_character_world_info_panel');
    panel.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '');
    const before = row.outerHTML;
    completions.forEach(complete => complete());
    expect(row.outerHTML).toBe(before);
    expect(row.classList.contains('is-selected')).toBe(true);
    refresh.mockClear();
    await mounted.prepareReveal();
    expect(row.classList.contains('is-selected')).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    adapter = null;
    liveState = { name: null, data: null };
    query = '';
    visibleEntries = null;
    dirty = false;
    popupChoice = 0;
    entryControllers = [];
    mounted = null;
    actionMenu = null;
    characters.splice(0);
    world_info.charLore = [];
    power_user.personas = {};
    power_user.persona_descriptions = {};
    saveWorldInfo.mockImplementation(async name => name);
    isActionMenuOpen.mockImplementation(trigger => Boolean(actionMenu) && (!trigger || actionMenu.trigger === trigger));
    isPickerOpen.mockImplementation(() => false);
    confirm.mockResolvedValue(true);
    localStorage.clear();
    document.body.innerHTML = `<div id="sb_character_world_info_panel"><div id="WorldInfo"><div id="wi-holder">
        <div id="wiTopBlock"></div><div id="world_popup">
        <select id="world_editor_select"><option value="">Pick</option><option value="0">Book A</option><option value="1">Book B</option></select>
        <input id="world_info_search"><select id="world_info_sort_order"><option value="0" data-rule="priority">Priority</option><option value="13" data-rule="custom">Custom</option></select>
        <button class="world_info_view_filter is-active" data-filter="all">All</button><button class="world_info_view_filter" data-filter="active">Active</button>
        <button id="world_popup_new"></button><button id="world_create_button"></button><button id="world_import_button"></button>
        <button id="world_refresh"></button><button id="world_apply_current_sorting"></button>
        </div></div></div></div>`;
    container = document.getElementById('WorldInfo');
    globalThis.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn().mockResolvedValue() };
    displayEntries.mockImplementation(defaultDisplayEntries);
    play.mockImplementation((_node, _frames, options) => { options?.onEnd?.(); return { cancel() {} }; });
});

afterEach(() => {
    mounted?.destroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete globalThis.SillyBunnyAssets;
    document.body.replaceChildren();
});

describe('World Info shell', () => {
    test('ready and whenBookShown wait for the mounted shell and loaded matching book', async () => {
        await mount();
        await mounted.ready;
        const shown = jest.fn();
        const waiting = mounted.whenBookShown('Book A').then(shown);
        await render({ name: 'Book A', data: null });
        await jest.advanceTimersByTimeAsync(50);
        expect(shown).not.toHaveBeenCalled();
        await render({ name: 'Book A', data: book() });
        await jest.advanceTimersByTimeAsync(50);
        await waiting;
        expect(shown).toHaveBeenCalledWith(true);
    });

    test.each(['timeout', 'superseded', 'destroyed'])('whenBookShown resolves false when %s', async reason => {
        await mount();
        let current = true;
        const waiting = mounted.whenBookShown('Book B', { isCurrent: () => current, timeout: 100 });
        if (reason === 'superseded') current = false;
        if (reason === 'destroyed') mounted.destroy();
        await jest.advanceTimersByTimeAsync(100);
        expect(await waiting).toBe(false);
    });

    test('same-book opens wait for their own render instead of accepting the previous loaded page', async () => {
        await mount({ name: 'Book A', data: book() });
        const done = jest.fn();
        const waiting = mounted.whenBookShown('Book A', { afterRender: mounted.renderRevision }).then(done);
        await jest.advanceTimersByTimeAsync(50);
        expect(done).not.toHaveBeenCalled();
        await render(liveState);
        await jest.advanceTimersByTimeAsync(50);
        await waiting;
        expect(done).toHaveBeenCalledWith(true);
    });

    test('captures and restores the same book query, page and list scroll', async () => {
        await mount({ name: 'Book A', data: book(25) });
        const snapshot = { name: 'Book A', query: 'Entry', searchOpen: true, page: 2, scrollTop: 123 };
        expect(await adapter.restoreState(snapshot, () => true)).toBe(true);
        expect(adapter.captureState()).toEqual(snapshot);
        expect(currentPage()).toBe('Page 2 of 3');
        expect(transportSearch().value).toBe('Entry');
        expect(await adapter.restoreState({ ...snapshot, name: 'Book B' }, () => true)).toBe(false);
        expect(await adapter.restoreState({ ...snapshot, query: 'stale' }, () => false)).toBe(false);
        expect(adapter.captureState()).toEqual(snapshot);
    });

    test('Used by collects primary, extra and persona links with stable ids and primary precedence', () => {
        const characterList = [
            { avatar: 'both.png', name: 'Both', data: { extensions: { world: 'Book A' } } },
            { avatar: 'extra.png', name: 'Extra' },
            { avatar: 'other.png', name: 'Other' },
        ];
        const links = [{ name: 'both.png', extraBooks: ['Book A'] }, { name: 'extra.png', extraBooks: ['Book A'] }];
        expect(collectWorldInfoUsers('Book A', characterList, links, { 'both.png': 'Persona', 'unlinked.png': 'Unlinked' }, { 'both.png': { lorebook: 'Book A' } })).toEqual([
            { value: 'character:both.png', label: 'Both', relation: 'primary', target: { kind: 'character-editor', id: 'both.png', via: 'world-info' } },
            { value: 'character:extra.png', label: 'Extra', relation: 'extra', target: { kind: 'character-editor', id: 'extra.png', via: 'world-info' } },
            { value: 'persona:both.png', label: 'Persona', relation: 'persona', target: { kind: 'persona-editor', id: 'both.png' } },
        ]);
        expect(collectWorldInfoUsers(null, characterList, links, {}, {})).toEqual([]);
        // Upstream stores charLore names without the avatar extension (getCharaFilename).
        expect(collectWorldInfoUsers('Book B', [{ avatar: 'Upstream Card.png', name: 'Upstream', data: {} }], [{ name: 'Upstream Card', extraBooks: ['Book B'] }], {}, {}))
            .toEqual([{ value: 'character:Upstream Card.png', label: 'Upstream', relation: 'extra', target: { kind: 'character-editor', id: 'Upstream Card.png', via: 'world-info' } }]);
    });

    test('Used by opens a single picker and navigates with the current book as origin', async () => {
        characters.push({ avatar: 'alice.png', name: 'Alice', data: { extensions: { world: 'Book A' } } });
        power_user.personas = { 'persona.png': 'Persona' };
        power_user.persona_descriptions = { 'persona.png': { lorebook: 'Book A' } };
        await mount({ name: 'Book A', data: book() });
        await selectMenuAction('lorum ipsum');
        const picker = openPicker.mock.calls.at(-1)[0];
        expect(picker.multiple).toBeUndefined();
        expect(picker.items.map(item => [item.value, item.subtitle])).toEqual([
            ['character:alice.png', 'Primary Lorebook · lorum ipsum'], ['persona:persona.png', 'Persona'],
        ]);
        picker.onSelect('persona:persona.png');
        await settle();
        expect(navigate).toHaveBeenCalledWith({ kind: 'persona-editor', id: 'persona.png' }, { from: { kind: 'world-info', id: 'Book A' } });
        picker.onSelect('character:alice.png');
        await settle();
        expect(navigate).toHaveBeenLastCalledWith({ kind: 'character-editor', id: 'alice.png', via: 'world-info' }, { from: { kind: 'world-info', id: 'Book A' } });
        await render({ name: 'Book B', data: book() });
        navigate.mockClear();
        picker.onSelect('persona:persona.png');
        await settle();
        expect(navigate).not.toHaveBeenCalled();
    });

    test('an unused book gets an empty picker and WI has no origin Back button', async () => {
        await mount({ name: 'Book A', data: book() });
        await selectMenuAction('lorum ipsum');
        expect(openPicker).toHaveBeenCalledWith(expect.objectContaining({ items: [], emptyText: 'No results' }));
        expect(container.querySelector('.sb-wi-origin-back')).toBeNull();
        expect(back).not.toHaveBeenCalled();
    });

    test('exports persistence dependencies without wrapping or cloning their tracked data', () => {
        expect(createWorldInfoDeps()).toEqual({ saveWorldInfo, setOriginal, deleteOriginal, createEntry, duplicateEntry, deleteEntry, moveEntry });
    });

    test('mount is idempotent and the shell stays inside WorldInfo', async () => {
        await mount();
        expect(mountWorldInfoEditor(container)).toBe(mounted);
        expect(container.querySelectorAll('.sb-wi-editor')).toHaveLength(1);
        expect(container.querySelector('.sb-wi-editor').closest('#WorldInfo')).toBe(container);
    });

    test('invalid hosts fail fast', () => {
        expect(() => mountWorldInfoEditor(null)).toThrow('HTMLElement');
        expect(() => mountWorldInfoEditor(document.createElement('div'))).toThrow('#WorldInfo');
    });

    test('shell is not revealed until both deferred stylesheets resolve', async () => {
        const resolvers = [];
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation(() => new Promise(done => { resolvers.push(done); }));
        mounted = mountWorldInfoEditor(container);
        await settle();
        expect(container.querySelector('.sb-wi-editor').hidden).toBe(true);
        expect(container.classList.contains('sb-wi-editor-mounted')).toBe(false);
        expect(globalThis.SillyBunnyAssets.loadStylesheetAsync).toHaveBeenCalledTimes(2);
        resolvers[0]();
        await settle();
        expect(container.querySelector('.sb-wi-editor').hidden).toBe(true);
        resolvers[1]();
        await settle();
        expect(container.querySelector('.sb-wi-editor').hidden).toBe(false);
        expect(container.classList.contains('sb-wi-editor-mounted')).toBe(true);
    });

    test('no book routes to the picker/new status while keeping settings reachable', async () => {
        await mount();
        expect(container.querySelector('.sb-wi-list-status').textContent).toContain('--- Pick to Edit ---');
        expect(container.querySelectorAll('.sb-wi-list-status button')).toHaveLength(3);
        expect(container.querySelector('.sb-wi-book-actions').hidden).toBe(false);
        expect(container.querySelector('.sb-wi-settings-button')).toBeNull();
        expect(container.querySelector('.sb-wi-list-heading').hidden).toBe(true);
        container.querySelector('.sb-wi-list-status button:last-child').click();
        await settle();
        expect(mountSettings).toHaveBeenCalled();
    });

    test.each([null, 'Book A'])('primary menu puts settings first and disables book actions without a book (%s)', async name => {
        await mount({ name, data: name ? book() : null });
        container.querySelector('.sb-wi-book-actions').click();
        await settle();
        const { title, sections } = actionMenu;
        expect(title).toBe(name ?? 'World Info');
        expect(sections[0].items.map(item => item.label)).toEqual(['Global Settings']);
        expect(sections[0].items[0].disabled).toBe(false);
        expect(sections.slice(1).flatMap(section => section.items).every(item => item.disabled === !name)).toBe(true);
    });

    test('an empty book routes to an empty status with New Entry', async () => {
        await mount({ name: 'Book A', data: book(0) });
        expect(container.querySelector('.sb-wi-list-status').textContent).toContain('New Entry');
        expect(container.querySelector('.sb-wi-list-box').hidden).toBe(true);
        expect(container.querySelector('.sb-wi-list-heading').hidden).toBe(true);
    });

    test('entries render as boxed rows without a persistent empty detail', async () => {
        await mount({ name: 'Book A', data: book(3) });
        expect(container.querySelectorAll('.sb-wi-row')).toHaveLength(3);
        expect(container.querySelector('.sb-wi-list-status').hidden).toBe(true);
        expect(container.querySelector('.sb-wi-empty-detail')).toBeNull();
        expect(container.querySelector('.sb-wi-detail').hidden).toBe(true);
        expect(container.querySelector('.sb-wi-list-heading').textContent).toBe('Lorebook entries');
        expect(container.querySelector('.sb-wi-list-heading').tabIndex).toBe(-1);
        expect(container.querySelector('.sb-wi-list-heading').hidden).toBe(false);
    });

    test('filtered nonempty books route to No results, including view-only filters', async () => {
        visibleEntries = [];
        await mount({ name: 'Book A', data: book(3) });
        expect(container.querySelector('.sb-wi-list-status').textContent).toBe('No results');
        expect(container.querySelector('.sb-wi-list-status button')).toBeNull();
        expect(container.querySelector('.sb-wi-list-heading').hidden).toBe(true);
    });

    test('the primary menu stays in the header while search reports only entry counts', async () => {
        await mount({ name: 'Book A', data: book(3) });
        const menu = container.querySelector('.sb-wi-book-actions');
        const search = container.querySelector('.sb-wi-search');
        search.value = 'missing';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(299);
        expect(setFilterData).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        await settle();
        expect(setFilterData).toHaveBeenCalledWith('world_info_search', 'missing');
        expect(container.querySelector('.sb-wi-book-actions')).toBe(menu);
        expect(menu.closest('.sb-wi-list-header')).not.toBeNull();
        expect(container.querySelector('.sb-wi-list-count')).toBeNull();
        expect(container.querySelector('.sb-wi-settings-row')).toBeNull();
        expect(container.querySelector('.sb-list-editor__status[aria-live="polite"]').textContent).toBe('No results');
    });

    test('arrow navigation stays within entries and the primary menu remains a native Tab stop', async () => {
        await mount({ name: 'Book A', data: book(2) });
        const first = container.querySelector('.sb-wi-row');
        first.focus();
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        expect(document.activeElement).toBe(first);
        const menu = container.querySelector('.sb-wi-book-actions');
        expect(menu.tabIndex).toBe(0);
        await selectMenuAction('Global Settings');
        expect(mountSettings).toHaveBeenCalledWith(expect.objectContaining({ host: container.querySelector('.sb-wi-detail') }));
    });

    test('Global Settings toggles its pane and returns focus to the primary menu', async () => {
        await mount();
        const menu = container.querySelector('.sb-wi-book-actions');
        await selectMenuAction('Global Settings');
        expect(container.querySelector('.sb-wi-editor').dataset.open).toBe('true');
        await selectMenuAction('Global Settings');
        expect(container.querySelector('.sb-wi-editor').dataset.open).toBe('false');
        expect(document.activeElement).toBe(menu);
    });

    test.each(['.sb-wi-sort-button', '.sb-wi-list-header button:has(.fa-ellipsis-vertical)', '.sb-wi-row-menu'])('reclicking %s closes its menu without reopening it', async selector => {
        await mount({ name: 'Book A', data: book() });
        const trigger = container.querySelector(selector);
        trigger.click();
        await settle();
        expect(isActionMenuOpen(trigger)).toBe(true);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        trigger.click();
        await settle();
        expect(isActionMenuOpen()).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    test('sorting exposes two titled radio groups and the picker opts into trigger-width placement', async () => {
        await mount({ name: 'Book A', data: book() });
        container.querySelector('.sb-wi-sort-button').click();
        await settle();
        const { sections } = openActionMenu.mock.calls.at(-1)[0];
        expect(sections.map(section => section.title)).toEqual(['lorum ipsum', 'lorum ipsum']);
        expect(sections.map(section => section.items.map(item => item.checked))).toEqual([[true, false], [true, false]]);
        const trigger = container.querySelector('.sb-wi-book-switcher');
        trigger.click();
        await settle();
        expect(openPicker).toHaveBeenCalledWith(expect.objectContaining({ trigger, matchTriggerWidth: true }));
    });

    test('numeric UID navigation opens its page, including UID zero', async () => {
        await mount({ name: 'Book A', data: book(25) });
        await render(liveState, 154);
        expect(currentPage()).toBe('Page 3 of 3');
        expect(mountEntry).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 154, data: liveState.data }));
        await render(liveState, 0);
        expect(currentPage()).toBe('Page 1 of 3');
        expect(mountEntry).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 0 }));
    });

    test('numeric navigation still opens entries excluded by the current filter', async () => {
        visibleEntries = [];
        await mount({ name: 'Book A', data: book(2) });
        await render(liveState, 7);
        expect(mountEntry).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 7, data: liveState.data }));
        expect(container.querySelector('.sb-wi-list-status').textContent).toBe('No results');
    });

    test.each([[0, null], [1, 'save'], [2, 'discard']])('delayed numeric navigation guards edits made after New Entry (choice %i)', async (choice, method) => {
        await mount({ name: 'Book A', data: book(25) });
        const detail = await open();
        const newRequest = jest.fn();
        document.getElementById('world_popup_new').addEventListener('click', newRequest);
        container.querySelector('[aria-label="New Entry"]').click();
        await settle();
        expect(newRequest).toHaveBeenCalledTimes(1);
        dirty = true;
        popupChoice = choice;
        await render(liveState, 154);
        expect(popupShow).toHaveBeenCalledTimes(1);
        expect(detail.save).toHaveBeenCalledTimes(method === 'save' ? 1 : 0);
        expect(detail.discard).toHaveBeenCalledTimes(method === 'discard' ? 1 : 0);
        expect(detail.destroy.mock.calls).toEqual(method ? [[{ keepDraft: false }]] : []);
        expect(mountEntry).toHaveBeenCalledTimes(method ? 2 : 1);
        expect(mountEntry).toHaveBeenLastCalledWith(expect.objectContaining({ uid: method ? 154 : 0 }));
        expect(container.querySelector('.sb-wi-row.is-selected').dataset.uid).toBe(method ? '154' : '0');
        expect(currentPage()).toBe(method ? 'Page 3 of 3' : 'Page 1 of 3');
    });

    test('a delayed deletion preserves edits made after its leave guard', async () => {
        const data = book(2);
        let finish;
        saveWorldInfo.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        deleteEntry.mockImplementationOnce(async (data, uid) => { delete data.entries[uid]; return true; });
        await mount({ name: 'Book A', data });
        const detail = await open();
        container.querySelector('.sb-wi-row-menu').click();
        await settle();
        openActionMenu.mock.calls.at(-1)[0].sections.flatMap(section => section.items).find(item => item.label === 'Delete').onSelect();
        await settle();
        dirty = true;
        finish('Book A');
        await settle();
        expect(detail.destroy).toHaveBeenCalledWith({ keepDraft: true });
    });

    test('guarded numeric navigation reaches its target page when Save refreshes the current entry', async () => {
        await mount({ name: 'Book A', data: book(25) });
        const detail = await open();
        detail.save.mockImplementationOnce(async () => {
            dirty = false;
            mountEntry.mock.calls[0][0].onSaved({ uid: 0 });
            await settle();
            return true;
        });
        dirty = true;
        popupChoice = 1;
        await render(liveState, 154);
        expect(detail.save).toHaveBeenCalledTimes(1);
        expect(mountEntry).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 154 }));
        expect(currentPage()).toBe('Page 3 of 3');
        expect(container.querySelector('.sb-wi-row.is-selected').dataset.uid).toBe('154');
    });

    test('previous preserves the current page and none follows the open entry', async () => {
        await mount({ name: 'Book A', data: book(25) });
        await render(liveState, 154);
        container.querySelector('.sb-list-pagination__prev').click();
        await settle();
        expect(currentPage()).toBe('Page 2 of 3');
        await render(liveState, navigation.previous);
        expect(currentPage()).toBe('Page 2 of 3');
        await render(liveState, navigation.none);
        expect(currentPage()).toBe('Page 3 of 3');
    });

    test('none defaults to page one when there is no open entry', async () => {
        await mount({ name: 'Book A', data: book(25) });
        container.querySelector('.sb-list-pagination__next').click();
        await settle();
        expect(currentPage()).toBe('Page 2 of 3');
        await render(liveState);
        expect(currentPage()).toBe('Page 1 of 3');
        expect(mountEntry).not.toHaveBeenCalled();
    });

    test('enable commits immediately, rebases only the affected open entry, then refreshes', async () => {
        const data = book(2);
        await mount({ name: 'Book A', data });
        const detail = await open(0);
        dirty = true;
        const input = container.querySelector('.sb-wi-row[data-uid="0"] input');
        input.checked = false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(setEnabled).toHaveBeenCalledWith(createWorldInfoDeps(), 'Book A', data, 0, false);
        expect(data.entries[0].disable).toBe(true);
        expect(detail.rebaseKey).toHaveBeenCalledWith('disable');
        expect(refresh).toHaveBeenCalledWith(navigation.previous, false);
        expect(detail.destroy).not.toHaveBeenCalled();
        expect(detail.isDirty()).toBe(true);
    });

    test('enabling a different row never rebases the open draft', async () => {
        await mount({ name: 'Book A', data: book(2) });
        const detail = await open(0);
        container.querySelector('.sb-wi-row[data-uid="7"] input').dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(detail.rebaseKey).not.toHaveBeenCalled();
    });

    test('switch activation never also opens its entry row', async () => {
        await mount({ name: 'Book A', data: book() });
        container.querySelector('.sb-wi-row input').click();
        await settle();
        expect(setEnabled).toHaveBeenCalled();
        expect(mountEntry).not.toHaveBeenCalled();
    });

    test.each([false, true])('row switches hold the priority order even when Active excludes the row (%s)', async activeOnly => {
        const data = book(3);
        displayEntries.mockImplementation(data => Object.values(data.entries)
            .filter(entry => !activeOnly || !entry.disable)
            .sort((left, right) => Number(left.disable) - Number(right.disable)));
        await mount({ name: 'Book A', data });
        container.querySelector('.sb-wi-row[data-uid="0"] input').click();
        await settle();
        expect([...container.querySelectorAll('.sb-wi-row')].map(row => row.dataset.uid)).toEqual(['0', '7', '14']);
        expect(container.querySelector('.sb-wi-row[data-uid="0"]').classList.contains('is-disabled')).toBe(true);
        await open(0);
        mountEntry.mock.calls.at(-1)[0].onSaved({ uid: 0 });
        await settle();
        expect(container.querySelector('.sb-wi-row').dataset.uid).toBe('0');
        document.getElementById('world_info_sort_order').dispatchEvent(new Event('change', { bubbles: true }));
        await render(liveState, navigation.previous);
        expect([...container.querySelectorAll('.sb-wi-row')].map(row => row.dataset.uid)).toEqual(activeOnly ? ['7', '14'] : ['7', '14', '0']);
    });

    test.each(['view', 'search', 'refresh', 'size', 'page', 'rename', 'reload'])('%s clears the held order', async action => {
        const data = book(25);
        displayEntries.mockImplementation(data => Object.values(data.entries)
            .filter(entry => !entry.disable && (!query || entry.comment.includes(query))));
        await mount({ name: 'Book A', data });
        container.querySelector('.sb-wi-row[data-uid="0"] input').click();
        await settle();
        expect(container.querySelector('.sb-wi-row[data-uid="0"]')).not.toBeNull();
        if (action === 'view') container.querySelector('.world_info_view_filter[data-filter="active"]').click();
        if (action === 'search') {
            const input = container.querySelector('.sb-wi-search');
            input.value = 'Entry';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            jest.advanceTimersByTime(300);
        }
        if (action === 'refresh') await selectMenuAction('Refresh');
        if (action === 'size') {
            const size = container.querySelector('.sb-list-pagination__size');
            size.value = '25';
            size.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (action === 'page') container.querySelector('.sb-list-pagination__next').click();
        await settle();
        await render({ name: action === 'rename' ? 'Renamed' : 'Book A', data: action === 'reload' ? JSON.parse(JSON.stringify(data)) : data }, navigation.previous);
        expect(container.querySelector('.sb-wi-row[data-uid="0"]')).toBeNull();
        expect(displayEntries).toHaveBeenCalled();
    });

    test('held order drops deleted entries and appends new entries without disturbing surviving rows', async () => {
        const data = book(3);
        await mount({ name: 'Book A', data });
        container.querySelector('.sb-wi-row[data-uid="0"] input').click();
        await settle();
        delete data.entries[7];
        data.entries[21] = { ...data.entries[14], uid: 21, comment: 'New Entry' };
        visibleEntries = [data.entries[21], data.entries[14], data.entries[0]];
        await render(liveState, navigation.previous);
        expect([...container.querySelectorAll('.sb-wi-row')].map(row => row.dataset.uid)).toEqual(['0', '14', '21']);
        visibleEntries.reverse();
        await render(liveState, navigation.previous);
        expect([...container.querySelectorAll('.sb-wi-row')].map(row => row.dataset.uid)).toEqual(['0', '14', '21']);
    });

    test.each([[3, false], [4, true]])('Move/Copy choice %i uses copy=%s without a second editor reload', async (choice, copy) => {
        await mount({ name: 'Book A', data: book() });
        container.querySelector('.sb-wi-row-menu').click();
        await settle();
        const action = openActionMenu.mock.calls.at(-1)[0].sections.flatMap(section => section.items).find(item => item.label === 'Move/Copy');
        action.onSelect();
        await settle();
        const picker = openPicker.mock.calls.at(-1)[0];
        expect(picker.items).toEqual([{ value: 'Book B', label: 'Book B' }]);
        popupChoice = choice;
        picker.onSelect('Book B');
        await settle();
        expect(move).toHaveBeenCalledWith(createWorldInfoDeps(), 'Book A', 'Book B', 0, { copy });
        expect(moveEntry).toHaveBeenCalledWith('Book A', 'Book B', 0, { deleteOriginal: !copy });
        expect(refresh).not.toHaveBeenCalled();
    });

    test('delete confirms once and delegates silent removal to the model', async () => {
        const data = book();
        deleteEntry.mockImplementation(async (bookData, uid) => { delete bookData.entries[uid]; return true; });
        await mount({ name: 'Book A', data });
        container.querySelector('.sb-wi-row-menu').click();
        await settle();
        const action = openActionMenu.mock.calls.at(-1)[0].sections.flatMap(section => section.items).find(item => item.label === 'Delete');
        action.onSelect();
        await settle();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(deleteEntry).toHaveBeenCalledWith(data, 0, { silent: true });
        expect(deleteOriginal).toHaveBeenCalledWith(data, 0);
        expect(saveWorldInfo).toHaveBeenCalledWith('Book A', data, true);
    });

    test('same-book renders sync the controller using the newly tracked object without remounting', async () => {
        await mount({ name: 'Book A', data: book(2) });
        const detail = await open();
        dirty = true;
        const replacement = book(2);
        await render({ name: 'Book A', data: replacement }, navigation.previous);
        expect(detail.sync).toHaveBeenLastCalledWith({ name: 'Book A', data: replacement });
        expect(mountEntry).toHaveBeenCalledTimes(1);
        expect(detail.destroy).not.toHaveBeenCalled();
    });

    test.each([true, false])('book changes destroy entry controllers with keepDraft=%s', async isDirty => {
        await mount({ name: 'Book A', data: book() });
        const detail = await open();
        dirty = isDirty;
        await render({ name: 'Book B', data: book() });
        expect(detail.destroy).toHaveBeenCalledWith({ keepDraft: isDirty });
        expect(container.querySelector('.sb-wi-editor').dataset.open).toBe('false');
    });

    test('book changes clear the visible search without scheduling another render', async () => {
        await mount({ name: 'Book A', data: book() });
        const input = container.querySelector('.sb-wi-search');
        input.value = 'Entry';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await render({ name: 'Book B', data: book() });
        jest.advanceTimersByTime(300);
        expect(input.value).toBe('');
        expect(transportSearch().value).toBe('');
        expect(setFilterData).toHaveBeenCalledWith('world_info_search', '', true);
    });

    test('book renames also retire the search-only sort option', async () => {
        await mount({ name: 'Book A', data: book() });
        const select = document.getElementById('world_info_sort_order');
        const searchOption = document.createElement('option');
        searchOption.dataset.rule = 'search';
        searchOption.value = '14';
        select.append(searchOption);
        select.value = '14';
        await render({ name: 'Renamed Book', data: liveState.data });
        expect(searchOption.hidden).toBe(true);
        expect(select.value).toBe('0');
    });

    test('book lifecycle events re-key and remove every backup, including unmounted entries and books', async () => {
        await mount({ name: 'Book B', data: book() });
        const name = 'Book A / %';
        const renamed = 'Renamed / %';
        const payloads = ['raw backup zero', '{"v":1,"ts":2,"snapshot":{"content":"second"}}'];
        for (const [index, uid] of [0, 42].entries()) localStorage.setItem(draftKey(name, uid), payloads[index]);
        const untouched = [draftKey('Book B', 0), draftKey(`${name} other`, 0), `sb-wi-editor-draft-another-user-${encodeURIComponent(name)}-0`, 'unrelated'];
        for (const key of untouched) localStorage.setItem(key, 'keep');
        await eventSource.emit(event_types.WORLDINFO_RENAMED, name, renamed);
        for (const [index, uid] of [0, 42].entries()) {
            expect(localStorage.getItem(draftKey(name, uid))).toBeNull();
            expect(localStorage.getItem(draftKey(renamed, uid))).toBe(payloads[index]);
        }
        await eventSource.emit(event_types.WORLDINFO_DELETED, renamed);
        expect(localStorage.getItem(draftKey(renamed, 0))).toBeNull();
        expect(localStorage.getItem(draftKey(renamed, 42))).toBeNull();
        for (const key of untouched) expect(localStorage.getItem(key)).toBe('keep');
        mounted.destroy();
        localStorage.setItem(draftKey(renamed, 7), 'after destroy');
        await eventSource.emit(event_types.WORLDINFO_DELETED, renamed);
        expect(localStorage.getItem(draftKey(renamed, 7))).toBe('after destroy');
    });

    test('the global settings controller survives book changes and never becomes dirty', async () => {
        await mount();
        await selectMenuAction('Global Settings');
        dirty = true;
        await render({ name: 'Book A', data: book() });
        const registration = registerNavigation.mock.calls[0][0];
        expect(registration.session.isDirty()).toBe(false);
        expect(settingsController.destroy).not.toHaveBeenCalled();
        expect(mountSettings).toHaveBeenCalledTimes(1);
    });

    test('navigation adapter delegates dirty/save/discard and uses the WI tab guard', async () => {
        await mount({ name: 'Book A', data: book() });
        const detail = await open();
        const registration = registerNavigation.mock.calls[0][0];
        dirty = true;
        expect(registration.session.isOpen()).toBe(true);
        expect(registration.session.isDirty()).toBe(true);
        expect(await registration.session.save()).toBe(true);
        registration.session.discard();
        expect(detail.save).toHaveBeenCalled();
        expect(detail.discard).toHaveBeenCalled();
        expect(registration.guardSelector).toBe('guard-world-info');
        expect(registration.escape).toBe(false);
    });

    test.each([[1, 'save'], [2, 'discard']])('shell dirty guard delegates result %i to %s', async (choice, method) => {
        await mount({ name: 'Book A', data: book(2) });
        const detail = await open();
        dirty = true;
        popupChoice = choice;
        await selectMenuAction('Global Settings');
        expect(detail[method]).toHaveBeenCalled();
        expect(mountSettings).toHaveBeenCalled();
        expect(detail.destroy).toHaveBeenCalledWith({ keepDraft: false });
    });

    test('a failed save keeps the current entry open', async () => {
        await mount({ name: 'Book A', data: book(2) });
        const detail = await open();
        dirty = true;
        popupChoice = 1;
        detail.save.mockResolvedValue(false);
        await selectMenuAction('Global Settings');
        expect(mountSettings).not.toHaveBeenCalled();
        expect(detail.destroy).not.toHaveBeenCalled();
        expect(container.querySelector('.sb-wi-editor').dataset.open).toBe('true');
    });

    test.each([0, 2])('sidebar Escape guards the open dirty entry instead of closing its settings page (choice %i)', async choice => {
        await mount({ name: 'Book A', data: book() });
        const detail = await open();
        dirty = true;
        popupChoice = choice;
        const pageEscape = jest.fn();
        container.addEventListener('keydown', pageEscape);
        const target = container.querySelector('.sb-wi-book-switcher');
        target.focus();
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        await settle();
        expect(pageEscape).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
        expect(popupShow).toHaveBeenCalledTimes(1);
        expect(detail.discard).toHaveBeenCalledTimes(choice === 2 ? 1 : 0);
        expect(detail.destroy.mock.calls).toEqual(choice === 2 ? [[{ keepDraft: false }]] : []);
        expect(container.querySelector('.sb-wi-editor').dataset.open).toBe(String(choice !== 2));
        container.removeEventListener('keydown', pageEscape);
    });

    test('search Escape clears and closes search before the shell considers deselecting', async () => {
        await mount({ name: 'Book A', data: book() });
        const detail = await open();
        dirty = true;
        container.querySelector('[aria-label="Search"]').click();
        await settle();
        const input = container.querySelector('.sb-wi-search');
        input.value = 'Entry';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await settle();
        expect(input.value).toBe('');
        expect(container.querySelector('.sb-wi-search-field').hidden).toBe(true);
        expect(popupShow).not.toHaveBeenCalled();
        expect(detail.destroy).not.toHaveBeenCalled();
    });

    test.each(['handled', 'composing', 'picker', 'menu', 'popup'])('shell Escape leaves %s events to their existing owner', async owner => {
        await mount({ name: 'Book A', data: book() });
        const detail = await open();
        dirty = true;
        if (owner === 'picker') isPickerOpen.mockReturnValue(true);
        if (owner === 'menu') isActionMenuOpen.mockReturnValue(true);
        if (owner === 'popup') document.body.append(Object.assign(document.createElement('dialog'), { className: 'popup', open: true }));
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: owner === 'composing' });
        if (owner === 'handled') event.preventDefault();
        container.querySelector('.sb-wi-book-switcher').dispatchEvent(event);
        await settle();
        expect(popupShow).not.toHaveBeenCalled();
        expect(detail.destroy).not.toHaveBeenCalled();
    });

    test('overlay cleanup tracks only the latest row menu trigger after rows are replaced', async () => {
        await mount({ name: 'Book A', data: book() });
        const triggers = [];
        for (let index = 0; index < 3; index++) {
            const trigger = container.querySelector('.sb-wi-row-menu');
            triggers.push(trigger);
            trigger.click();
            await settle();
            liveState.data.entries[0].comment = `Replacement ${index}`;
            await render(liveState, navigation.previous);
        }
        isActionMenuOpen.mockClear();
        mounted.destroy();
        expect(isActionMenuOpen.mock.calls).toEqual([[triggers.at(-1)]]);
    });

    test('closed row menus release their tracked trigger', async () => {
        await mount({ name: 'Book A', data: book() });
        container.querySelector('.sb-wi-row-menu').click();
        await settle();
        openActionMenu.mock.calls.at(-1)[0].onClose();
        isActionMenuOpen.mockClear();
        mounted.destroy();
        expect(isActionMenuOpen).not.toHaveBeenCalled();
    });

    test('pagination is guarded and page-size changes persist through accountStorage', async () => {
        await mount({ name: 'Book A', data: book(25) });
        await open();
        dirty = true;
        container.querySelector('.sb-list-pagination__next').click();
        await settle();
        expect(currentPage()).toBe('Page 1 of 3');
        dirty = false;
        const size = container.querySelector('.sb-list-pagination__size');
        size.value = '25';
        size.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(accountStorage.setItem).toHaveBeenCalledWith('WI_PerPage', '25');
    });

    test('destroy preserves dirty drafts, unregisters the adapter and allows remount', async () => {
        await mount({ name: 'Book A', data: book() });
        const detail = await open();
        dirty = true;
        mounted.destroy();
        expect(detail.destroy).toHaveBeenCalledWith({ keepDraft: true });
        expect(setAdapter).toHaveBeenLastCalledWith(null);
        expect(unregister).toHaveBeenCalled();
        expect(container.querySelector('.sb-wi-editor')).toBeNull();
        expect(container.classList.contains('sb-wi-editor-mounted')).toBe(false);
        const next = mountWorldInfoEditor(container);
        expect(next).not.toBe(mounted);
        mounted = next;
    });
});

function transportSearch() {
    return document.getElementById('world_info_search');
}

describe('World Info selection mode', () => {
    const selected = () => [...container.querySelectorAll('.sb-wi-row.is-selection-selected')].map(row => row.dataset.uid);
    const count = () => container.querySelector('.sb-selection-title').textContent;
    const action = async id => {
        container.querySelector(`.sb-selection-action[data-action-id="${id}"]`).click();
        await settle();
    };

    test.each([null, 'Book A'])('Select is disabled without entries (%s)', async name => {
        await mount({ name, data: name ? book(0) : null });
        container.querySelector('.sb-wi-book-actions').click();
        await settle();
        expect(actionMenu.sections.flatMap(section => section.items).find(item => item.label === 'Select').disabled).toBe(true);
    });

    test('menu entry swaps chrome, focuses Cancel, toggles rows without opening, and restores the menu trigger', async () => {
        await mount({ name: 'Book A', data: book(3) });
        const trigger = container.querySelector('.sb-wi-book-actions');
        await selectMenuAction('Select');
        expect(container.querySelector('.sb-wi-editor').dataset.selectionMode).toBe('true');
        expect(count()).toBe('0 lorum ipsum');
        expect(document.activeElement).toBe(container.querySelector('.sb-selection-cancel'));
        await open(0);
        await open(7);
        expect(selected()).toEqual(['0', '7']);
        expect(count()).toBe('2 lorum ipsum');
        expect(mountEntry).not.toHaveBeenCalled();
        const first = container.querySelector('.sb-wi-row');
        first.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        expect(selected()).toEqual(['7']);
        expect(first.querySelector('.sb-selection-check').getAttribute('aria-label')).toBe('Select Entry 0');
        expect(first.querySelector('.sb-wi-row-enable').inert).toBe(true);
        container.querySelector('.sb-selection-cancel').click();
        expect(container.querySelector('.sb-wi-editor').dataset.selectionMode).toBe('false');
        expect(container.querySelector('.sb-selection-check')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    test('secondary click enters with its UID and Escape exits without closing the detail or bubbling', async () => {
        await mount({ name: 'Book A', data: book(2) });
        const detail = await open(0);
        const row = container.querySelector('.sb-wi-row[data-uid="7"]');
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        row.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(selected()).toEqual(['7']);
        const bubble = jest.fn();
        container.addEventListener('keydown', bubble);
        container.querySelector('.sb-selection-cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(bubble).not.toHaveBeenCalled();
        expect(detail.destroy).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(row);
    });

    test('selection survives paging and filtering, selects the current page, prunes deleted UIDs, and exits on a book switch', async () => {
        const data = book(25);
        await mount({ name: 'Book A', data });
        await selectMenuAction('Select');
        await open(0);
        container.querySelector('.sb-list-pagination__next').click();
        await settle();
        container.querySelector('.sb-selection-cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
        expect(count()).toBe('11 lorum ipsum');
        const input = container.querySelector('.sb-wi-search');
        input.value = 'Entry 2';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(300);
        await settle();
        expect(count()).toBe('11 lorum ipsum');
        delete data.entries[0];
        await render(liveState, navigation.previous);
        expect(count()).toBe('10 lorum ipsum');
        await render({ name: 'Book B', data: book(2) });
        expect(container.querySelector('.sb-wi-editor').dataset.selectionMode).toBe('false');
        expect(container.querySelector('.sb-selection-title')).toBeNull();
    });

    test.each([true, false])('bulk enabled=%s saves the tracked book once, holds order, and rebases the dirty open entry', async enabled => {
        const data = book(3);
        data.entries[0].disable = enabled;
        data.entries[7].disable = enabled;
        displayEntries.mockImplementation(data => Object.values(data.entries).filter(entry => !entry.disable).sort((left, right) => left.uid - right.uid));
        visibleEntries = null;
        // Both target entries are deliberately present in the initial filtered result.
        displayEntries.mockImplementationOnce(() => Object.values(data.entries));
        await mount({ name: 'Book A', data });
        const detail = await open(0);
        dirty = true;
        await selectMenuAction('Select');
        await open(0);
        await open(7);
        const before = [...container.querySelectorAll('.sb-wi-row')].map(row => row.dataset.uid);
        await action(enabled ? 'enable' : 'disable');
        expect(setEnabled).toHaveBeenCalledWith(createWorldInfoDeps(), 'Book A', data, ['0', '7'], enabled);
        expect(saveWorldInfo).toHaveBeenCalledTimes(1);
        expect(saveWorldInfo).toHaveBeenCalledWith('Book A', data, true);
        expect(data.entries[0].disable).toBe(!enabled);
        expect(data.entries[7].disable).toBe(!enabled);
        expect(detail.rebaseKey).toHaveBeenCalledTimes(1);
        expect(detail.rebaseKey).toHaveBeenCalledWith('disable');
        expect(detail.isDirty()).toBe(true);
        expect([...container.querySelectorAll('.sb-wi-row')].map(row => row.dataset.uid)).toEqual(before);
        expect(popupShow).not.toHaveBeenCalled();
    });

    test('bulk Delete confirms the count, saves once, closes the affected detail and clears deleted UIDs', async () => {
        const data = book(3);
        deleteEntry.mockImplementation(async (data, uid) => { delete data.entries[uid]; return true; });
        await mount({ name: 'Book A', data });
        const detail = await open(0);
        await selectMenuAction('Select');
        await open(0);
        await open(7);
        await action('delete');
        expect(confirm).toHaveBeenCalledWith('lorum ipsum (2)', 'This action is irreversible!');
        expect(deleteEntry.mock.calls).toEqual([[data, '0', { silent: true }], [data, '7', { silent: true }]]);
        expect(saveWorldInfo).toHaveBeenCalledTimes(1);
        expect(detail.destroy).toHaveBeenCalled();
        expect(container.querySelector('.sb-wi-editor').dataset.open).toBe('false');
        expect(count()).toBe('0 lorum ipsum');
        expect(container.querySelectorAll('.sb-wi-row')).toHaveLength(1);
    });

    test('cancelled dirty guard prevents destructive bulk deletion', async () => {
        await mount({ name: 'Book A', data: book(2) });
        await open(0);
        dirty = true;
        await selectMenuAction('Select');
        await open(0);
        await action('delete');
        expect(popupShow).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        expect(saveWorldInfo).not.toHaveBeenCalled();
    });

    test.each([[3, false], [4, true]])('bulk Move/Copy choice %i uses copy=%s and closes detail only for a move', async (choice, copy) => {
        await mount({ name: 'Book A', data: book(3) });
        const detail = await open(0);
        await selectMenuAction('Select');
        await open(0);
        await open(7);
        await action('move');
        const picker = openPicker.mock.calls.at(-1)[0];
        popupChoice = choice;
        picker.onSelect('Book B');
        await settle();
        expect(move).toHaveBeenCalledWith(createWorldInfoDeps(), 'Book A', 'Book B', ['0', '7'], { copy });
        expect(moveEntry.mock.calls).toEqual([['Book A', 'Book B', '0', { deleteOriginal: !copy }], ['Book A', 'Book B', '7', { deleteOriginal: !copy }]]);
        expect(detail.destroy).toHaveBeenCalledTimes(copy ? 0 : 1);
        expect(count()).toBe(copy ? '2 lorum ipsum' : '0 lorum ipsum');
    });

    test('a pending bulk save blocks duplicate actions and marks its toolbar busy', async () => {
        await mount({ name: 'Book A', data: book(2) });
        await selectMenuAction('Select');
        await open(0);
        let finish;
        saveWorldInfo.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await action('disable');
        const bar = container.querySelector('.sb-wi-selection-bar');
        expect(bar.inert).toBe(true);
        expect(bar.getAttribute('aria-busy')).toBe('true');
        await action('enable');
        expect(saveWorldInfo).toHaveBeenCalledTimes(1);
        finish('Book A');
        await settle();
        expect(bar.inert).toBe(false);
        expect(bar.hasAttribute('aria-busy')).toBe(false);
    });

    test('a partial bulk move retains failed UIDs and a detail that was not removed', async () => {
        const data = book(3);
        await mount({ name: 'Book A', data });
        const detail = await open(0);
        await selectMenuAction('Select');
        await open(0);
        await open(7);
        await action('move');
        move.mockImplementationOnce(async () => {
            delete data.entries[7];
            return { ok: true, moved: 1 };
        });
        popupChoice = 3;
        openPicker.mock.calls.at(-1)[0].onSelect('Book B');
        await settle();
        expect(selected()).toEqual(['0']);
        expect(count()).toBe('1 lorum ipsum');
        expect(detail.destroy).not.toHaveBeenCalled();
    });
});

describe('page-of-UID lookup', () => {
    test.each([[0, 1], [63, 1], [70, 2], [154, 3], [999, 1], ['70', 2]])('UID %s maps to page %i', (uid, page) => {
        expect(pageForWorldInfoUid(Object.values(book(25).entries), uid, 10)).toBe(page);
    });

    test.each([0, -1, 1.5, NaN])('rejects invalid page size %s', size => {
        expect(() => pageForWorldInfoUid([], 0, size)).toThrow(RangeError);
    });
});

describe('held World Info order', () => {
    test('uses live entries, preserves filtered UIDs and removes missing UIDs without mutating inputs', () => {
        const all = Object.values(book(3).entries);
        const fresh = [all[2]];
        const held = ['7', 0, 999];
        const ordered = preserveWorldInfoEntryOrder(held, fresh, all);
        expect(ordered).toEqual([all[1], all[0], all[2]]);
        expect(ordered[0]).toBe(all[1]);
        expect(held).toEqual(['7', 0, 999]);
        expect(fresh).toEqual([all[2]]);
    });

    test('appends new matches in their fresh order and never reintroduces unrelated filtered entries', () => {
        const all = Object.values(book(4).entries);
        expect(preserveWorldInfoEntryOrder([0], [all[2], all[0], all[1]], all)).toEqual([all[0], all[2], all[1]]);
        expect(preserveWorldInfoEntryOrder([], [], all)).toEqual([]);
    });
});
