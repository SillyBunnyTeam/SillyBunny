/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

await import('../../public/lib/jquery-3.5.1.min.js');
const $ = window.jQuery;
const { eventSource, event_types } = await import('../../public/scripts/events.js');
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/tag-filter-menu.js', () => ({ attachTagFilterMenu: () => ({ refresh() {}, destroy() {} }) }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker() {}, isPickerOpen: () => false }));
let overlay;
let renderer;
const groups = [{ id: '01', name: 'Group', chats: ['chat-01'] }];
const deleteCharacter = jest.fn();
const getCharacters = jest.fn();
const callGenericPopup = jest.fn();
const hideLoader = jest.fn();
const previousFetch = globalThis.fetch;
const overlayProxy = Object.fromEntries([
    'setLegacyRowSelectionEnabled', 'notifySharedSelectionState', 'runBulkAction', 'addStateChangeCallback',
    'selectState', 'browseState', 'updateSelectedCount', 'onPageLoad', 'handleContextMenuDelete', 'toggleSingleCharacter',
].map(name => [name, (...args) => overlay[name](...args)]));
Object.defineProperty(overlayProxy, 'legacyRowSelectionEnabled', { get: () => overlay.legacyRowSelectionEnabled });
await jest.unstable_mockModule('../../public/script.js', () => ({
    clearChat: jest.fn(), characterGroupOverlay: overlayProxy, characters: [], eventSource, event_types,
    getCharacters, getRequestHeaders: jest.fn(() => ({})), buildAvatarList: jest.fn(),
    characterToEntity: jest.fn(), groupToEntity: jest.fn(), printMessages: jest.fn(),
    printCharactersDebounced: jest.fn(), deleteCharacter, resetChatState: jest.fn(),
    setCharacterListRenderer: value => { renderer = value; },
    printCharacters: () => renderer?.render({ view: 'groups', entities: groups.map(item => ({ type: 'group', id: item.id, item })), sourceCount: 1 }),
    getGroupRowData: group => group,
}));
await jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({ favsToHotswap: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/action-loader.js', () => ({ loader: { show: jest.fn(() => ({ hide: hideLoader })), ToastMode: { STATIC: 1 } } }));
await jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({ groups, resetSelectedGroup: jest.fn(), selected_group: null, getGroupAvatarElement: () => document.createElement('span') }));
await jest.unstable_mockModule('../../public/scripts/personas.js', () => ({ convertCharacterToPersona: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({ callGenericPopup, POPUP_TYPE: { CONFIRM: 1 } }));
await jest.unstable_mockModule('../../public/scripts/tags.js', () => Object.fromEntries([
    'createTagInput', 'getTagKeyForEntity', 'printTagList', 'compareTagsForSort', 'removeTagFromMap', 'importTags',
].map(name => [name, jest.fn()]).concat([['getTagsList', jest.fn(() => [])], ['tag_map', {}], ['tag_import_setting', {}]])));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({ power_user: {} }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/object-navigation.js', () => ({ objectNavigation: {} }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-auto-load.js', () => ({ rememberOpenedEntity: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-character-list-state.js', () => ({ getListPage: () => 1, getListPageSize: () => 10 }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({ animateListChange: (_rows, update) => update(), play() {}, stopMotion() {}, animateOut() {}, MOTION_SLOW: 0, MOTION_FAST: 200, MOTION_EASE_OUT_CUBIC: 'ease-out', prefersReducedMotion: () => true }));
const { BulkEditOverlay } = await import('../../public/scripts/BulkEditOverlay.js');
const { initBulkEdit } = await import('../../public/scripts/bulk-edit.js');
const { mountCharacterList } = await import('../../public/scripts/sillybunny-character-list.js');
const settle = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };

beforeEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    globalThis.$ = $;
    renderer = null;
    document.body.innerHTML = `<div id="rm_characters_block"><div id="charListFixedTop"><input id="character_search_bar"><div class="rm_tag_controls"></div></div>
        <div id="rm_print_characters_block"><div class="character_select" data-chid="0"></div><div class="group_select" data-grid="01"></div><div class="bogus_folder_select"></div></div>
        <div id="rm_print_characters_pagination"><button id="bulkEditButton"></button><span id="bulkSelectedCount"></span><button id="bulkSelectAllButton"></button><button id="bulkDeleteButton"></button></div></div>
        <div id="character_context_menu" class="hidden">${['favorite', 'tag', 'duplicate', 'persona', 'delete'].map(action => `<button id="character_context_menu_${action}"></button>`).join('')}</div>`;
    // The upstream singleton freezes its public fields; release only that freeze so handlers can be spied on.
    const freeze = jest.spyOn(Object, 'freeze').mockImplementation(value => value);
    overlay = new BulkEditOverlay();
    freeze.mockRestore();
    // The singleton retains its container between tests, just as it does in the application.
    overlay.container = document.getElementById('rm_print_characters_block');
    overlay.stateChangeCallbacks.length = 0;
    overlay.setLegacyRowSelectionEnabled(true);
    overlay.browseState();
    await settle();
    overlay.clearSelectedCharacters();
    jest.clearAllMocks();
});

afterEach(async () => {
    await settle();
    globalThis.fetch = previousFetch;
    delete globalThis.$;
    jest.restoreAllMocks();
});

describe('explicit bulk actions', () => {
    test.each([
        ['favorite', 'handleContextMenuFavorite'], ['tag', 'handleContextMenuTag'],
        ['duplicate', 'handleContextMenuDuplicate'], ['persona', 'handleContextMenuPersona'], ['delete', 'handleContextMenuDelete'],
    ])('%s uses exactly the supplied selection until its handler settles', async (action, handler) => {
        let complete;
        const ids = action === 'tag' || action === 'delete' ? ['01', 'group'] : [0, 4];
        const callback = jest.spyOn(overlay, handler).mockImplementation(() => {
            expect(overlay.selectedCharacters).toEqual(ids);
            expect(overlay.selectedCharacters).not.toBe(ids);
            return new Promise(resolve => { complete = resolve; });
        });
        overlay.selectedCharacters.push('stale');
        const running = overlay.runBulkAction(action, ids);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(overlay.selectedCharacters).toEqual(ids);
        complete(false);
        await running;
        expect(overlay.selectedCharacters).toEqual([]);
    });

    test('rejection clears selection and allows a subsequent action', async () => {
        jest.spyOn(overlay, 'handleContextMenuDelete').mockRejectedValueOnce(new Error('handler failed')).mockResolvedValue(undefined);
        await expect(overlay.runBulkAction('delete', ['01'])).rejects.toThrow('handler failed');
        expect(overlay.selectedCharacters).toEqual([]);
        await overlay.runBulkAction('delete', ['01']);
        expect(overlay.selectedCharacters).toEqual([]);
    });

    test('rejects unknown actions and invalid ids before mutating selection', async () => {
        await expect(overlay.runBulkAction('unknown', [0])).rejects.toThrow('Unknown bulk action');
        await expect(overlay.runBulkAction('tag', [null])).rejects.toThrow('Bulk entity ids');
        expect(overlay.selectedCharacters).toEqual([]);
    });

    test('an overlapping action cannot replace the running handler selection', async () => {
        let complete;
        jest.spyOn(overlay, 'handleContextMenuFavorite').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
        const running = overlay.runBulkAction('favorite', [0, 1]);
        await expect(overlay.runBulkAction('delete', ['01'])).rejects.toThrow('A bulk action is already running');
        expect(overlay.selectedCharacters).toEqual([0, 1]);
        complete();
        await running;
        expect(overlay.selectedCharacters).toEqual([]);
    });

    test('disabling legacy selection removes row listeners and page load no longer binds or resets', () => {
        const row = document.querySelector('.character_select');
        const bind = jest.spyOn(row, 'addEventListener');
        const unbind = jest.spyOn(row, 'removeEventListener');
        overlay.onPageLoad();
        expect(bind).toHaveBeenCalledWith('mousedown', overlay.handleHold);
        overlay.setLegacyRowSelectionEnabled(false);
        expect(unbind).toHaveBeenCalledWith('mousedown', overlay.handleHold);
        bind.mockClear();
        const browse = jest.spyOn(overlay, 'browseState');
        overlay.onPageLoad();
        expect(bind).not.toHaveBeenCalled();
        expect(browse).not.toHaveBeenCalled();
        expect(overlay.legacyRowSelectionEnabled).toBe(false);
        overlay.setLegacyRowSelectionEnabled(true);
        expect(bind).toHaveBeenCalledWith('contextmenu', overlay.handleDefaultContextMenu);
    });

    test.each([false, true])('shared transitions preserve BEFORE/state/AFTER without legacy UI (legacy enabled=%s)', async enabled => {
        overlay.setLegacyRowSelectionEnabled(enabled);
        await settle();
        initBulkEdit();
        const observations = [];
        const before = next => { observations.push(['before', next, overlay.state]); };
        const after = next => { observations.push(['after', next, overlay.state]); };
        const callback = jest.fn();
        overlay.addStateChangeCallback(callback);
        eventSource.on(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE, before);
        eventSource.on(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER, after);
        const rowBinding = jest.spyOn(overlay.container.querySelector('.group_select'), 'addEventListener');
        try {
            const entering = overlay.notifySharedSelectionState('select');
            const exiting = overlay.notifySharedSelectionState('browse');
            await Promise.all([entering, exiting]);
            expect(observations).toEqual([['before', 1, 0], ['after', 1, 1], ['before', 0, 1], ['after', 0, 0]]);
            expect(callback.mock.calls).toEqual([[1], [0]]);
            expect(rowBinding).not.toHaveBeenCalled();
            expect(overlay.container.classList.contains('group_overlay_mode_select')).toBe(false);
            expect(overlay.container.querySelector('.bulk_select_checkbox')).toBeNull();
        } finally {
            eventSource.removeListener(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE, before);
            eventSource.removeListener(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER, after);
        }
    });

    test('disabling legacy selection queues browse after a pending legacy select transition', async () => {
        overlay.selectState();
        overlay.setLegacyRowSelectionEnabled(false);
        await settle();
        expect(overlay.state).toBe(0);
        expect(overlay.container.classList.contains('group_overlay_mode_select')).toBe(false);
        expect(overlay.container.querySelector('.bulk_select_checkbox')).toBeNull();
    });

    test('mount/destroy from legacy select mode cleans retained original rows before detaching', async () => {
        initBulkEdit();
        overlay.onPageLoad();
        overlay.selectState();
        await settle();
        const originalGroup = overlay.container.querySelector('.group_select');
        const originalFolder = overlay.container.querySelector('.bogus_folder_select');
        overlay.toggleSingleCharacter(originalGroup);
        expect(originalGroup.querySelector('.bulk_select_checkbox')).not.toBeNull();
        expect(originalGroup.classList.contains('character_selected')).toBe(true);
        expect(originalFolder.classList.contains('disabled')).toBe(true);
        const unbindGroup = jest.spyOn(originalGroup, 'removeEventListener');
        const unbindFolder = jest.spyOn(originalFolder, 'removeEventListener');
        const mounted = await mountCharacterList();
        try {
            expect(originalGroup.isConnected).toBe(false);
            expect(originalGroup.querySelector('.bulk_select_checkbox')).toBeNull();
            expect(originalGroup.classList.contains('character_selected')).toBe(false);
            expect(originalFolder.classList.contains('disabled')).toBe(false);
            expect(unbindGroup).toHaveBeenCalledWith('click', overlay.toggleCharacterSelected);
            expect(unbindFolder).toHaveBeenCalledWith('click', expect.any(Function));
        } finally {
            mounted.destroy();
            await settle();
        }
        expect(originalGroup.isConnected).toBe(true);
        expect(overlay.container.classList.contains('group_overlay_mode_select')).toBe(false);
        expect(overlay.container.classList.contains('bulk_select')).toBe(false);
        originalGroup.click();
        expect(overlay.selectedCharacters).toEqual([]);
        const bubbled = jest.fn();
        overlay.container.addEventListener('click', bubbled);
        originalFolder.click();
        expect(bubbled).toHaveBeenCalledTimes(1);
    });

    test('real group Delete sends the string id only to the groups endpoint', async () => {
        globalThis.fetch = jest.fn(async () => ({ ok: true }));
        callGenericPopup.mockResolvedValueOnce(true);
        await overlay.runBulkAction('delete', ['01']);
        await settle();
        expect(callGenericPopup).toHaveBeenCalledWith(expect.anything(), 1);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledWith('/api/groups/delete', expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: '01' }) }));
        expect(deleteCharacter).not.toHaveBeenCalled();
        expect(getCharacters).toHaveBeenCalledTimes(1);
        expect(hideLoader).toHaveBeenCalledTimes(1);
        expect(overlay.selectedCharacters).toEqual([]);
    });
});
