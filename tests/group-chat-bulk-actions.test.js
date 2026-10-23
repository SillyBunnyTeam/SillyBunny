/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, expect, test, afterEach } from '@jest/globals';

let renderer;
let menu;
let mounted;
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/tag-filter-menu.js', () => ({ attachTagFilterMenu: () => ({ refresh() {}, destroy() {} }) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker() {}, isPickerOpen: () => false }));
const groups = [{ id: '0012', name: 'First' }, { id: 'group-2', name: 'Second' }];
const overlay = { legacyRowSelectionEnabled: true, runBulkAction: jest.fn(async () => {}), notifySharedSelectionState: jest.fn(async () => {}) };
overlay.setLegacyRowSelectionEnabled = jest.fn(enabled => { overlay.legacyRowSelectionEnabled = enabled; });
const model = { view: 'groups', entities: groups.map(item => ({ type: 'group', id: item.id, item })), sourceCount: 2 };
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (strings, ...values) => strings.reduce((text, string, index) => text + string + (values[index] ?? ''), '') }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));
await jest.unstable_mockModule('../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu: options => { menu = options; } }));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/object-navigation.js', () => ({ objectNavigation: {} }));
await jest.unstable_mockModule('../public/scripts/sillybunny-auto-load.js', () => ({ rememberOpenedEntity: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-motion.js', () => ({ animateListChange: (_rows, update) => update(), play() {}, stopMotion() {}, animateOut() {}, MOTION_SLOW: 0, MOTION_FAST: 200, MOTION_EASE_OUT_CUBIC: 'ease-out', prefersReducedMotion: () => true }));
await jest.unstable_mockModule('../public/script.js', () => ({
    characterGroupOverlay: overlay, characters: [],
    setCharacterListRenderer: value => { renderer = value; },
    printCharacters: () => renderer?.render(model),
    getGroupRowData: group => group,
}));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ groups, getGroupAvatarElement: () => document.createElement('span') }));
await jest.unstable_mockModule('../public/scripts/tags.js', () => ({}));
await jest.unstable_mockModule('../public/scripts/sillybunny-character-list-state.js', () => ({ getListPage: () => 1, getListPageSize: () => 10 }));
const { mountCharacterList } = await import('../public/scripts/sillybunny-character-list.js');
const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

afterEach(() => {
    mounted?.destroy();
    mounted = null;
    document.body.replaceChildren();
    jest.clearAllMocks();
});

describe('Group chat shared bulk actions', () => {
    test.each(['tag', 'delete'])('selects shared group rows and routes %s with string ids', async action => {
        document.body.innerHTML = `<div id="rm_characters_block"><div id="charListFixedTop">
            <input id="character_search_bar"><div class="rm_tag_controls"></div></div>
            <div id="rm_print_characters_block"></div><div id="rm_print_characters_pagination">
            <button id="bulkEditButton"></button><button id="bulkSelectAllButton"></button><button id="bulkDeleteButton"></button><span id="bulkSelectedCount"></span></div></div>`;
        mounted = await mountCharacterList();
        expect(overlay.legacyRowSelectionEnabled).toBe(false);
        mounted.section.querySelector('[data-action-id="more"]').click();
        menu.sections.flatMap(section => section.items).find(item => item.label === 'Select').onSelect();
        await settle();
        const rows = mounted.section.querySelectorAll('.group_select');
        for (const row of rows) row.querySelector('.ch_name').click();
        expect(mounted.section.querySelectorAll('.sb-selection-check:checked')).toHaveLength(2);
        expect([...mounted.section.querySelectorAll('.sb-selection-action')].map(button => button.dataset.actionId)).toEqual(['tag', 'folder', 'delete']);
        mounted.section.querySelector(`.sb-selection-action[data-action-id="${action}"]`).click();
        await settle();
        expect(overlay.runBulkAction).toHaveBeenCalledWith(action, ['0012', 'group-2']);
        expect(mounted.section.dataset.selectionMode).toBe('false');
        expect(document.getElementById('bulkEditButton')).not.toBeNull();
        mounted.destroy();
        expect(overlay.legacyRowSelectionEnabled).toBe(true);
    });
});
