/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));
const settle = async () => {
    for (let count = 0; count < 10; count++) await Promise.resolve();
};

afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('Character editor deferred visibility work', () => {
    test('hidden character editor defers Related links reconciliation until visible', async () => {
        jest.resetModules();
        window.$ = jest.fn(() => ({ on: jest.fn(), off: jest.fn() }));
        document.body.innerHTML = `
            <div id="right-nav-panel" class="closedDrawer" data-menu-type="characters">
                <div id="rm_ch_create_block">
                    <form id="form_create"></form>
                    <section id="sb_character_related"><div id="sb_character_related_rows"></div></section>
                </div>
            </div>
        `;
        const reconcileRows = jest.fn();
        const { EventEmitter } = await import('../../public/lib/eventemitter.js');
        const eventSource = new EventEmitter();
        const { event_types } = await import('../../public/scripts/events.js');

        await jest.unstable_mockModule(pub('scripts/events.js'), () => ({ eventSource, event_types }));
        await jest.unstable_mockModule(pub('scripts/chats.js'), () => ({ formatCreatorNotes: v => v, getCurrentEntityId: () => null }));
        await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({ Popup: class {}, POPUP_TYPE: {}, POPUP_RESULT: {} }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({ confirmVerb: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-action-menu.js'), () => ({ openActionMenu: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({ power_user: {}, setCharacterEditorQuickEdit: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({ groups: [] }));
        await jest.unstable_mockModule(pub('scripts/world-info.js'), () => ({ world_info: {}, world_names: [] }));
        await jest.unstable_mockModule(pub('script.js'), () => ({
            characters: [{ avatar: 'alice.png', name: 'Alice', data: {} }],
            chat: [],
            this_chid: undefined,
            create_save: {},
            createOrEditCharacter: jest.fn(),
            converter: { makeHtml: v => String(v ?? '') },
            getThumbnailUrl: () => '',
            saveSettingsDebounced: jest.fn(),
            getCharacterSource: () => '',
            isExternalMediaAllowed: () => true,
            selectCharacterById: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({ t: s => s.join(''), translate: v => v }));
        await jest.unstable_mockModule(pub('scripts/user.js'), () => ({ getCurrentUserHandle: () => 'default-user' }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-segmented-control.js'), () => ({ createSegmentedControl: jest.fn(), setSegmentedControlValue: jest.fn() }));
        await jest.unstable_mockModule(pub('lib.js'), () => ({ DOMPurify: { sanitize: v => String(v ?? '') } }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/session.js'), () => ({
            createEditorSession: () => ({ isOpen: () => true, open: jest.fn(), close: jest.fn(), context: { mode: 'edit', entityId: 'alice.png' } }),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/drafts.js'), () => ({ createEditorDraftStore: () => ({}) }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/chrome.js'), () => ({ mountEditorChrome: jest.fn(), showDraftRecoveryToast: jest.fn(), dismissDraftRecoveryToast: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/navigation.js'), () => ({ registerEditorNavigation: jest.fn(), confirmEditorLeave: jest.fn(), discardEditorChanges: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/list-shell.js'), () => ({ holdEditorsUntilStyled: jest.fn(async () => {}) }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/object-navigation.js'), () => ({ objectNavigation: { navigate: jest.fn() } }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/rows.js'), () => ({
            adoptExpanderRow: jest.fn(), adoptEditorFields: jest.fn(), createDefinitionsReveal: jest.fn(), createExpanderRow: jest.fn(), createRow: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/tag-filter-menu.js'), () => ({ adoptTagField: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/select-row.js'), () => ({ createSelectRow: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/list-rows.js'), () => ({ reconcileRows }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-folders.js'), () => ({ getFolderId: () => null, getFolders: () => [], setFolder: jest.fn(), subscribe: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-characters-navigation.js'), () => ({}));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/preview.js'), () => ({ mountEditorPreviews: jest.fn() }));

        const { initCharacterEditor } = await import('../../public/scripts/sillybunny-character-editor.js');
        initCharacterEditor();
        expect(reconcileRows).not.toHaveBeenCalled();

        // Showing the editor panel flushes the deferred Related links reconciliation once.
        const panel = document.getElementById('right-nav-panel');
        panel.classList.remove('closedDrawer');
        panel.classList.add('openDrawer');
        panel.dataset.menuType = 'character_edit';
        await settle();

        expect(reconcileRows).toHaveBeenCalledTimes(1);
    });
});
