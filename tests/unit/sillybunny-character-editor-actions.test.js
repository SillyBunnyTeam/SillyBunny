/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));

const EDITOR_TRANSPORTS_DOM = `
    <style>.sb-editor-transport { display: none !important; }</style>
    <div id="right-nav-panel" class="sb-settings-mounted-shell openDrawer" data-menu-type="character_edit">
        <div id="rm_ch_create_block">
            <form id="form_create">
                <div id="sb_character_editor_header">
                    <button id="sb_character_editor_back" type="button"></button>
                    <button id="sb_character_editor_cancel" type="button"></button>
                    <button id="sb_character_editor_save" type="button"></button>
                    <span id="sb_character_editor_title"></span>
                    <button id="sb_character_editor_title_button" type="button"></button>
                    <span id="sb_character_editor_dirty"></span>
                    <button id="sb_character_editor_more" type="button"></button>
                </div>
                <div id="sb_character_editor_toolbar">
                    <span id="sb_character_editor_tokens"></span>
                    <button id="sb_character_editor_quick_edit" type="button"></button>
                </div>
                <div class="sb-editor-sheet__content">
                    <input id="character_name_pole" value="Alice">
                    <select id="char-management-dropdown" class="sb-editor-transport">
                        <option id="renameCharButton" value="rename">Rename Character</option>
                    </select>
                    <div id="creators_note_styles_button" class="sb-editor-transport"></div>
                    <div id="character_open_media_overrides" class="sb-editor-transport"></div>
                    <div class="rm_stats_button sb-editor-transport"></div>
                    <div id="delete_button" class="sb-editor-transport"></div>
                </div>
            </form>
        </div>
    </div>
`;

afterEach(() => {
    document.head.innerHTML = '';
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

function recoveredLabels(sections) {
    return sections[1].items.map(item => item.label);
}

async function mountCharacterEditorWithSession({ mode = 'edit', entityId = 'alice.png' } = {}) {
    jest.resetModules();
    window.$ = jest.fn(() => ({ on: jest.fn(), off: jest.fn() }));

    let capturedChromeConfig = null;
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
        characters: [{ name: 'Alice', avatar: 'alice.png', data: { extensions: {} } }],
        this_chid: 0,
        create_save: {},
        createOrEditCharacter: jest.fn(),
        converter: { makeHtml: v => String(v ?? '') },
    }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        t: (strings, ...values) => strings.reduce((acc, part, idx) => acc + part + (values[idx] ?? ''), ''),
        translate: text => text,
    }));
    await jest.unstable_mockModule(pub('scripts/user.js'), () => ({ getCurrentUserHandle: () => 'default-user' }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-segmented-control.js'), () => ({ createSegmentedControl: jest.fn(), setSegmentedControlValue: jest.fn() }));
    await jest.unstable_mockModule(pub('lib.js'), () => ({ DOMPurify: { sanitize: v => String(v ?? '') } }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/session.js'), () => ({
        createEditorSession: () => ({
            isOpen: () => true,
            isDirty: () => false,
            open: jest.fn(),
            close: jest.fn(),
            save: jest.fn(),
            rebase: jest.fn(),
            context: { mode, entityId },
        }),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/drafts.js'), () => ({ createEditorDraftStore: () => ({}) }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/chrome.js'), () => ({
        mountEditorChrome: jest.fn(config => {
            capturedChromeConfig = config;
            return { update: jest.fn(), destroy: jest.fn(), setTokens: jest.fn(), setDirty: jest.fn(), setTitle: jest.fn() };
        }),
        showDraftRecoveryToast: jest.fn(),
        dismissDraftRecoveryToast: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/navigation.js'), () => ({ registerEditorNavigation: jest.fn(), confirmEditorLeave: jest.fn(), discardEditorChanges: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/list-shell.js'), () => ({ holdEditorsUntilStyled: jest.fn(async () => {}) }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/object-navigation.js'), () => ({ objectNavigation: { navigate: jest.fn() } }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/rows.js'), () => ({
        adoptExpanderRow: jest.fn(), adoptEditorFields: jest.fn(), createDefinitionsReveal: jest.fn(), createExpanderRow: jest.fn(), createRow: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/tag-filter-menu.js'), () => ({ adoptTagField: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/select-row.js'), () => ({ createSelectRow: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/list-rows.js'), () => ({ reconcileRows: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-folders.js'), () => ({ getFolderId: () => null, getFolders: () => [], setFolder: jest.fn(), subscribe: jest.fn() }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-characters-navigation.js'), () => ({}));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/preview.js'), () => ({ mountEditorPreviews: jest.fn() }));

    const { initCharacterEditor } = await import('../../public/scripts/sillybunny-character-editor.js');
    initCharacterEditor();
    expect(capturedChromeConfig).not.toBeNull();
    return { getActionSections: capturedChromeConfig.getActionSections };
}

describe('character editor action menu External Media visibility (group peek and create form)', () => {
    test('action menu omits External Media when #character_open_media_overrides is hidden inline and includes it for solo edits', async () => {
        document.body.innerHTML = EDITOR_TRANSPORTS_DOM;
        const mediaTransport = document.getElementById('character_open_media_overrides');
        expect(getComputedStyle(mediaTransport).display).toBe('none');

        const { getActionSections } = await mountCharacterEditorWithSession({ mode: 'edit', entityId: 'alice.png' });

        // Group peek state (inline display: none).
        mediaTransport.style.display = 'none';
        const groupPeekLabels = recoveredLabels(getActionSections());
        expect(groupPeekLabels).toEqual(['Global Styles', 'Character Stats']);
        expect(groupPeekLabels).not.toContain('External Media');

        // Solo edit state (inline display cleared or restored to visible by jQuery .toggle(true)).
        for (const visibleInlineDisplay of ['', 'block']) {
            mediaTransport.style.display = visibleInlineDisplay;
            expect(recoveredLabels(getActionSections())).toEqual([
                'Global Styles',
                'External Media',
                'Character Stats',
            ]);
        }
    });

    test('omits External Media and Delete Character in the create form when the transport is hidden inline', async () => {
        document.body.innerHTML = EDITOR_TRANSPORTS_DOM;
        const mediaTransport = document.getElementById('character_open_media_overrides');
        mediaTransport.style.display = 'none';

        const { getActionSections } = await mountCharacterEditorWithSession({ mode: 'create', entityId: '' });
        const sections = getActionSections();

        expect(recoveredLabels(sections)).toEqual(['Global Styles', 'Character Stats']);
        expect(sections[2].items).toEqual([]);
    });
});
