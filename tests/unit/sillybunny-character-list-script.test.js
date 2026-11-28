/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each assertions run inside test callbacks. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from '../util/script-harness.js';

let loaded = null;
const OriginalResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    localStorage.clear();
    globalThis.ResizeObserver = OriginalResizeObserver;
    jest.useRealTimers();
    jest.restoreAllMocks();
});

function buildCharacterEditorDom() {
    return `
        <div id="chat"></div>
        <textarea id="send_textarea"></textarea>
        <div id="rm_print_characters_block"></div>
        <div id="rm_print_characters_pagination"></div>
        <form id="form_character_search_form">
            <input id="character_search_bar" type="text" value="" />
            <button id="character_search_bar_search" type="button"></button>
        </form>
        <form id="form_create" actiontype="editcharacter">
            <div id="sb_character_editor_header">
                <button id="sb_character_editor_back" type="button"></button>
                <button id="sb_character_editor_title_button" type="button"><span id="sb_character_editor_title"></span></button>
                <span id="sb_character_editor_dirty" hidden></span>
                <button id="sb_character_editor_cancel" type="button"></button>
                <button id="sb_character_editor_save" type="button"></button>
                <button id="sb_character_editor_more" type="button"></button>
            </div>
            <div id="sb_character_editor_toolbar">
                <span id="sb_character_editor_tokens"></span>
                <button id="sb_character_editor_quick_edit" type="button"></button>
                <button id="favorite_button" type="button" class="fav_off"></button>
                <button id="dupe_button" type="button"></button>
                <button id="export_button" type="button"></button>
                <button id="char_connections_button" type="button"></button>
                <button class="chat_lorebook_button" type="button"></button>
                <button id="world_button" type="button"></button>
            </div>
            <div id="sb_character_editor_content" class="sb-editor-sheet__content">
                <input id="character_name_pole" name="ch_name" type="text" value="Alice" />
                <input name="avatar_url" type="hidden" value="alice.png" />
                <input id="selected_chat_pole" name="chat" type="hidden" value="Alice chat" />
                <input id="create_date_pole" name="create_date" type="hidden" value="Old creation date" />
                <input id="character_json_data" name="json_data" type="hidden" value="Old card data" />
                <input id="fav_checkbox" type="checkbox" />
                <div id="character_folder_row"></div>
                <textarea id="description_textarea" name="description"></textarea>
                <textarea id="personality_textarea" name="personality"></textarea>
                <textarea id="scenario_pole" name="scenario"></textarea>
                <textarea id="firstmessage_textarea" name="first_mes"></textarea>
                <textarea id="mes_example_textarea" name="mes_example"></textarea>
                <textarea id="creator_notes_textarea" name="creator_notes"></textarea>
                <textarea id="system_prompt_textarea" name="system_prompt"></textarea>
                <textarea id="post_history_instructions_textarea" name="post_history_instructions"></textarea>
                <textarea id="creator_textarea" name="creator"></textarea>
                <textarea id="character_version_textarea" name="character_version"></textarea>
                <div class="alternate_greetings_list"></div>
                <div class="group_only_greetings_list"></div>
                <input id="tagInput" type="text" />
                <div id="tagList"></div>
                <div id="tags_div"><div class="tags_view"></div></div>
                <select id="char-management-dropdown"></select>
                <button id="delete_button" type="button"></button>
            </div>
        </form>
        <input type="checkbox" id="del_char_checkbox" checked />
        <div id="character_template" hidden>
            <div class="character_select">
                <img />
                <div class="ch_name"></div>
                <div class="ch_fav"></div>
                <div class="ch_description"></div>
                <div class="ch_additional_info"></div>
                <div class="tags"></div>
            </div>
        </div>
        <div id="avatar_load_preview"></div>
        <div id="rm_info_avatar"></div>
    `;
}

async function setupListRuntime({
    fetchImpl = null,
    debounceImpl = null,
    folderMap = null,
    popupConfirm = null,
    objectNavigationBack = null,
    useRealCharEditor = true,
    bootReady = false,
    extraMocks = {},
} = {}) {
    localStorage.clear();
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };

    const folderAssignments = new Map(folderMap ?? [['alice.png', 'original-folder']]);
    const availableFolders = [
        { id: 'original-folder', name: 'Original Folder' },
        { id: 'pending-folder', name: 'Pending Folder' },
        { id: 'saved-folder', name: 'Saved Folder' },
        { id: 'create-folder', name: 'Create Folder' },
    ];
    const setFolder = jest.fn((_scope, keys, folderId) => {
        for (const key of keys) {
            if (folderId === null) folderAssignments.delete(String(key));
            else folderAssignments.set(String(key), String(folderId));
        }
    });

    const serverCharacters = [
        { name: 'Alice', avatar: 'alice.png', fav: false, chat: 'Alice chat', data: { extensions: { fav: false }, alternate_greetings: [], group_only_greetings: [] } },
    ];

    const fetchMock = fetchImpl ?? jest.fn(async (url) => {
        if (url === '/api/settings/get') {
            return { ok: true, status: 200, json: async () => ({ settings: '{}' }) };
        }
        if (url === '/api/characters/all') {
            return { ok: true, status: 200, json: async () => serverCharacters };
        }
        if (url === '/api/characters/chats') {
            return { ok: true, status: 200, json: async () => [] };
        }
        if (url === '/api/characters/get') {
            return { ok: true, status: 200, json: async () => serverCharacters[serverCharacters.length - 1] };
        }
        if (url === '/api/characters/create') {
            return { ok: true, status: 200, text: async () => 'created.png', json: async () => ({}) };
        }
        if (url === '/api/chats/get') {
            return { ok: true, status: 200, json: async () => [{ chat_metadata: {} }] };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => 'ok' };
    });

    const backSpy = objectNavigationBack ?? jest.fn(async () => {});
    const keepReal = ['scripts/filters.js', 'scripts/sillybunny-character-editor.js'];
    const { 'scripts/power-user.js': extraPowerUser, ...restExtraMocks } = extraMocks;

    loaded = await importScriptModule({
        dom: buildCharacterEditorDom(),
        keepReal,
        fetch: fetchMock,
        toastr: {
            info: jest.fn(() => window.jQuery('<div><button id="sb_draft_restore_btn"></button><button id="sb_draft_discard_btn"></button></div>')),
        },
        mocks: {
            'scripts/sillybunny-folders.js': {
                getFolderId: (_scope, key) => folderAssignments.get(String(key)) ?? null,
                getFolders: () => availableFolders,
                subscribe: () => () => {},
                setFolder,
                removeEntityKey: jest.fn((_scope, key) => folderAssignments.delete(String(key))),
            },
            'scripts/sillybunny-editor/object-navigation.js': {
                objectNavigation: {
                    back: backSpy,
                    navigate: jest.fn(async () => ({ ok: true })),
                    isRouting: false,
                },
            },
            'scripts/sillybunny-characters-navigation.js': {},
            'scripts/sillybunny-segmented-control.js': {
                createSegmentedControl: jest.fn(() => {
                    const el = document.createElement('div');
                    return { element: el, root: el, setValue: jest.fn(), getValue: jest.fn(() => 'character') };
                }),
                setSegmentedControlValue: jest.fn(),
            },
            'scripts/chats.js': {
                getCurrentEntityId: jest.fn(() => 'alice.png'),
            },
            'scripts/power-user.js': base => {
                const merged = { ...base, setCharacterEditorQuickEdit: jest.fn() };
                if (typeof extraPowerUser === 'function') return { ...extraPowerUser(merged), setCharacterEditorQuickEdit: jest.fn() };
                return extraPowerUser ? { ...merged, ...extraPowerUser } : merged;
            },
            'scripts/world-info.js': {
                world_info: {},
                world_names: [],
            },
            'scripts/sillybunny-action-menu.js': {
                MOBILE_QUERY: '(max-width: 767px)',
                getRevealScrollTop: jest.fn(() => 0),
                positionPopover: jest.fn(),
                openActionMenu: jest.fn(),
                openPopover: jest.fn(),
                closeActionMenu: jest.fn(),
                isActionMenuOpen: jest.fn(() => false),
                getActionMenuTrigger: jest.fn(() => null),
            },
            'scripts/user.js': {
                currentUser: { handle: 'default', name: 'User' },
                getCurrentUserHandle: () => 'default',
                setUserControls: jest.fn(),
            },
            'scripts/popup.js': {
                Popup: Object.assign(class { async show() { return 1; } }, {
                    show: {
                        confirm: popupConfirm ?? jest.fn(async () => true),
                        input: jest.fn(async () => ''),
                    },
                }),
            },
            'scripts/utils.js': {
                waitUntilCondition: jest.fn(async () => {}),
                ...(debounceImpl ? { debounce: debounceImpl } : {}),
                ...(restExtraMocks['scripts/utils.js'] ?? {}),
            },
            ...Object.fromEntries(Object.entries(restExtraMocks).filter(([key]) => key !== 'scripts/utils.js')),
        },
    });

    if (bootReady) {
        await loaded.runReady();
        fetchMock.mockClear();
    }

    const charEditor = await import('../../public/scripts/sillybunny-character-editor.js');
    if (useRealCharEditor) {
        charEditor.initCharacterEditor();
    }

    return {
        ...loaded,
        charEditor,
        fetchMock,
        folderAssignments,
        setFolder,
        backSpy,
        serverCharacters,
    };
}

describe('upstream main-list renderer boundary in script.js', () => {
    test('renderer receives the same sorted, folder-adjusted entities as legacy pagination', async () => {
        const pagination = jest.fn();
        const resetListPage = jest.fn();
        const recordListPage = jest.fn();
        const runtime = await setupListRuntime({
            useRealCharEditor: false,
            extraMocks: {
                'scripts/sillybunny-character-list-state.js': {
                    getCharacterListView: () => 'characters',
                    getListSort: () => ({ field: 'name', order: 'asc' }),
                    getListPage: () => 3,
                    getListPageSize: () => 25,
                    recordListPage,
                    resetListPage,
                    registerCharacterListSortAccessors: jest.fn(),
                    registerCharacterListStateRenderer: jest.fn(),
                },
                'scripts/power-user.js': base => ({
                    ...base,
                    power_user: { ...base.power_user, bogus_folders: true },
                    sortEntitiesList: jest.fn(entities => entities.sort((a, b) => a.item.name.localeCompare(b.item.name))),
                }),
                'scripts/tags.js': {
                    tags: [{ id: 'folder', name: 'Folder' }],
                    isBogusFolder: () => true,
                    isBogusFolderOpen: () => true,
                    filterByTagState: (entities, options) => (options?.subForEntity ? entities.filter(e => e.type !== 'tag') : entities),
                },
                'scripts/group-chats.js': {
                    groups: [{ id: 'g1', name: 'Group', members: [] }],
                },
            },
        });
        runtime.$.fn.pagination = pagination;
        runtime.state.accountStorage.setItem('Characters_PerPage', '25');
        runtime.script.characters.push(
            { name: 'Zebra', avatar: 'z.png', data: { extensions: {} } },
            { name: 'Alice', avatar: 'a.png', data: { extensions: {} } },
        );

        await runtime.script.printCharacters();
        const legacy = pagination.mock.calls[0][0];
        expect(legacy.pageSize).toBe(25);

        const render = jest.fn();
        runtime.script.setCharacterListRenderer({ render });
        await runtime.script.printCharacters(true);
        const model = render.mock.calls[0][0];
        expect(model.entities).not.toEqual(legacy.dataSource);
        expect(model.entities.map(entity => entity.type)).toEqual(['character', 'character']);
        expect(model).toMatchObject({ view: 'characters', sourceCount: 2, hasAnyFilter: false, folderOpen: false, fullRefresh: true });
        expect(resetListPage).toHaveBeenCalledWith('characters');
        expect(runtime.mocks['scripts/tags.js'].printTagFilters).toHaveBeenCalledTimes(2);
        expect(runtime.mocks['scripts/tags.js'].applyTagsOnCharacterSelect).toHaveBeenCalledTimes(2);
        expect(runtime.mocks['scripts/tags.js'].applyTagsOnGroupSelect).toHaveBeenCalledTimes(2);
        expect(runtime.mocks['scripts/RossAscends-mods.js'].favsToHotswap).toHaveBeenCalledTimes(2);
        expect(runtime.mocks['scripts/personas.js'].updatePersonaConnectionsAvatarList).toHaveBeenCalledTimes(2);

        const pageEvents = [];
        runtime.eventSource.on(runtime.script.event_types.CHARACTER_PAGE_LOADED, () => pageEvents.push('loaded'));
        model.pageLoaded();
        model.pageLoaded();
        expect(pageEvents).toHaveLength(2);

        runtime.script.setCharacterListRenderer(null);
        await runtime.script.printCharacters();
        expect(pagination).toHaveBeenCalledTimes(2);
        expect(render).toHaveBeenCalledTimes(1);

        await legacy.callback(legacy.dataSource);
        expect(document.querySelectorAll('#rm_print_characters_block .character_select')).toHaveLength(2);
        expect(pageEvents).toHaveLength(3);
        legacy.afterSizeSelectorChange({ target: { value: '100' } }, 100);
        expect(runtime.state.accountStorage.setItem).toHaveBeenCalledWith('Characters_PerPage', '100');
    });

    test.each(['SELECTED', 'EXCLUDED'])('GROUP %s is neutral in folders and main entities without mutating saved state', async state => {
        const runtime = await setupListRuntime({
            useRealCharEditor: false,
            extraMocks: {
                'scripts/group-chats.js': {
                    groups: [{ id: 'g1', name: 'Group', members: [] }],
                },
                'scripts/tags.js': {
                    tags: [{ id: 'folder', name: 'Folder' }],
                    isBogusFolder: () => true,
                    filterByTagState: entities => entities,
                },
            },
        });
        runtime.script.characters.push(
            { name: 'Zebra', avatar: 'z.png' },
            { name: 'Alice', avatar: 'a.png' },
        );
        runtime.script.entitiesFilter.setFilterData('group', state, true);

        const result = runtime.script.getEntitiesList({ doFilter: true, mainList: true });
        expect(result.filter(entity => entity.type !== 'tag')).toHaveLength(3);
        expect(runtime.script.entitiesFilter.getFilterData('group')).toBe(state);

        const fallback = runtime.script.getEntitiesList({ doFilter: true });
        expect(fallback.filter(entity => entity.type !== 'tag').map(entity => entity.type)).toEqual(
            state === 'SELECTED' ? ['group'] : ['character', 'character'],
        );
    });

    test('search debounce cannot overwrite another view or a restored query after a round trip', async () => {
        let capturedDebounce = null;
        let currentView = 'characters';
        const runtime = await setupListRuntime({
            useRealCharEditor: false,
            debounceImpl: (fn) => {
                const wrapped = (...args) => fn(...args);
                wrapped.cancel = () => {};
                if (!capturedDebounce && fn.length === 2) {
                    capturedDebounce = fn;
                }
                return wrapped;
            },
            extraMocks: {
                'scripts/sillybunny-character-list-state.js': {
                    getCharacterListView: () => currentView,
                    getListSort: () => ({ field: 'name', order: 'asc' }),
                    getListPage: () => 1,
                    getListPageSize: () => 50,
                    recordListPage: jest.fn(),
                    resetListPage: jest.fn(),
                    registerCharacterListSortAccessors: jest.fn(),
                    registerCharacterListStateRenderer: jest.fn(),
                },
            },
        });
        await runtime.runReady();
        expect(capturedDebounce).toBeTruthy();

        const setSpy = jest.spyOn(runtime.script.entitiesFilter, 'setFilterData');
        const input = document.getElementById('character_search_bar');
        input.value = 'restored';

        // Stale debounced call from another view ('groups') or stale value ('old') must be ignored.
        capturedDebounce('old', 'groups');
        capturedDebounce('old', 'characters');
        expect(setSpy).not.toHaveBeenCalled();

        // Matching view and current input value updates the filter.
        capturedDebounce('restored', 'characters');
        expect(setSpy).toHaveBeenCalledWith('search', 'restored');
    });
});

describe('character list actions and editor sessions in script.js + sillybunny-character-editor.js', () => {
    test('character favorite uses merge-attributes and updates both compatible favorite fields', async () => {
        const runtime = await setupListRuntime({ useRealCharEditor: false });
        runtime.script.characters.push({ name: 'Alice', avatar: 'alice.png', fav: false, data: { extensions: { fav: false } } });

        await expect(runtime.script.toggleCharacterFavoriteById('alice.png')).resolves.toBe(true);
        const [url, request] = runtime.fetchMock.mock.calls[0];
        expect(url).toBe('/api/characters/merge-attributes');
        expect(JSON.parse(request.body)).toMatchObject({ avatar: 'alice.png', fav: true, data: { extensions: { fav: true } } });
        expect(runtime.script.characters[0]).toMatchObject({ fav: true, data: { extensions: { fav: true } } });

        await runtime.script.toggleCharacterFavoriteById(0);
        expect(runtime.script.characters[0].fav).toBe(false);
        await expect(runtime.script.toggleCharacterFavoriteById('missing')).resolves.toBe(false);
        expect(runtime.fetchMock).toHaveBeenCalledTimes(2);
    });

    test('character deletion uses editor copy, respects cancellation and captures its stable avatar before confirmation', async () => {
        const confirm = jest.fn(async () => true);
        const runtime = await setupListRuntime({
            useRealCharEditor: false,
            popupConfirm: confirm,
            extraMocks: {
                'scripts/templates.js': {
                    renderTemplateAsync: jest.fn(async () => 'delete-template'),
                },
            },
        });
        runtime.script.characters.push({ name: 'Alice', avatar: 'alice.png', fav: false, data: { extensions: { fav: false } } });

        confirm.mockResolvedValueOnce(false);
        await expect(runtime.script.deleteCharacterById(0)).resolves.toBe(false);
        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/characters/delete')).toBe(false);

        confirm.mockImplementationOnce(async (title, template, options) => {
            expect(title).toBe('Delete the character?');
            expect(template).toBe('delete-template');
            options.onClose();
            runtime.script.characters.unshift({ name: 'Different', avatar: 'different.png', data: { extensions: {} } });
            return true;
        });

        await expect(runtime.script.deleteCharacterById(0)).resolves.toBe(true);
        const delCall = runtime.fetchMock.mock.calls.find(([url]) => url === '/api/characters/delete');
        expect(delCall).toBeTruthy();
        expect(JSON.parse(delCall[1].body)).toMatchObject({ avatar_url: 'alice.png', delete_chats: true });
    });

    const flushDirty = () => new Promise(resolve => setTimeout(resolve, 340));

    async function openAliceEditor(overrides = {}) {
        const customFetch = overrides.fetchImpl;
        const wrappedFetch = customFetch
            ? jest.fn(async (url, init) => {
                if (url === '/api/settings/get') return { ok: true, status: 200, json: async () => ({ settings: '{}' }) };
                if (url === '/api/characters/chats') return { ok: true, status: 200, json: async () => [] };
                return customFetch(url, init);
            })
            : null;
        const runtime = await setupListRuntime({
            ...overrides,
            bootReady: true,
            ...(wrappedFetch ? { fetchImpl: wrappedFetch } : {}),
        });
        runtime.script.characters.push({
            name: 'Alice',
            avatar: 'alice.png',
            fav: false,
            chat: 'Alice chat',
            data: { extensions: { fav: false }, alternate_greetings: [], group_only_greetings: [] },
        });
        runtime.script.setCharacterId(0);
        runtime.charEditor.loadCharacterEditorGreetings(0, 'edit');
        runtime.charEditor.openCharacterEditorSession(0);
        return runtime;
    }

    test('character Folder changes are dirty, discardable, and committed only after Save', async () => {
        const runtime = await openAliceEditor();
        const folderSelect = document.getElementById('character_folder');
        const cancelBtn = document.getElementById('sb_character_editor_cancel');
        const saveBtn = document.getElementById('sb_character_editor_save');

        expect(folderSelect.value).toBe('original-folder');
        folderSelect.value = 'pending-folder';
        folderSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(cancelBtn.disabled).toBe(false);

        cancelBtn.click();
        expect(folderSelect.value).toBe('original-folder');
        expect(cancelBtn.disabled).toBe(true);

        folderSelect.value = 'saved-folder';
        folderSelect.dispatchEvent(new Event('change', { bubbles: true }));
        saveBtn.click();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(runtime.folderAssignments.get('alice.png')).toBe('saved-folder');
        expect(cancelBtn.disabled).toBe(true);
    });

    test('character pencil-open, Back, list favorite and reopen stay clean and real Save retains the new value', async () => {
        const runtime = await openAliceEditor();

        document.getElementById('sb_character_editor_back').click();
        await new Promise(resolve => setTimeout(resolve, 15));
        expect(runtime.backSpy).toHaveBeenCalled();

        await runtime.script.toggleCharacterFavoriteById('alice.png');
        runtime.charEditor.openCharacterEditorSession(0);
        expect(runtime.script.characters[0].fav).toBe(true);
        expect(document.getElementById('sb_character_editor_cancel').disabled).toBe(true);
        expect(document.getElementById('favorite_button').classList.contains('fav_on')).toBe(true);

        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'Later edit';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        document.getElementById('sb_character_editor_save').click();
        await new Promise(resolve => setTimeout(resolve, 20));

        const editCall = runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/characters/edit').at(-1);
        expect(editCall).toBeTruthy();
        expect(editCall[1].body.get('fav')).toBe('true');
        expect(runtime.toastr.error).not.toHaveBeenCalled();
        expect(document.getElementById('sb_character_editor_cancel').disabled).toBe(true);
    });

    test('character favorite rebases only _fav while preserving other dirty fields and their backup', async () => {
        const runtime = await openAliceEditor();
        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'Pending';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        window.dispatchEvent(new Event('pagehide'));

        await runtime.script.toggleCharacterFavoriteById('alice.png');
        expect(document.getElementById('sb_character_editor_cancel').disabled).toBe(false);
        const stored = JSON.parse(localStorage.getItem('sb-editor-draft-default-alice.png'));
        expect(stored.snapshot).toMatchObject({ character_name_pole: 'Pending', _fav: true });

        document.getElementById('sb_character_editor_cancel').click();
        expect(nameInput.value).toBe('Alice');
        expect(document.getElementById('favorite_button').classList.contains('fav_on')).toBe(true);
    });

    test('character Save acknowledges V1 without cleaning V2 typed during the request', async () => {
        let finish;
        const runtime = await openAliceEditor({
            fetchImpl: jest.fn(async (url) => {
                if (url === '/api/characters/edit') {
                    return new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, json: async () => ({}) }); });
                }
                return { ok: true, status: 200, json: async () => ({}) };
            }),
        });

        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'V1';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        document.getElementById('sb_character_editor_save').click();
        await new Promise(resolve => setTimeout(resolve, 10));

        const editCall = runtime.fetchMock.mock.calls.find(([url]) => url === '/api/characters/edit');
        expect(editCall[1].body.get('ch_name')).toBe('V1');
        nameInput.value = 'V2';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        window.dispatchEvent(new Event('pagehide'));

        finish();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(document.getElementById('sb_character_editor_cancel').disabled).toBe(false);
        const stored = JSON.parse(localStorage.getItem('sb-editor-draft-default-alice.png'));
        expect(stored.snapshot.character_name_pole).toBe('V2');

        // Discarding now reverts to acknowledged baseline V1, not Alice!
        document.getElementById('sb_character_editor_cancel').click();
        expect(nameInput.value).toBe('V1');
    });

    test('avatar conversion cannot mix later form values into a submitted snapshot', async () => {
        let finishConversion;
        const runtime = await openAliceEditor({
            extraMocks: {
                'scripts/utils.js': {
                    ensureImageFormatSupported: jest.fn(file => new Promise(resolve => { finishConversion = () => resolve(file); })),
                },
            },
        });
        const avatar = document.createElement('input');
        avatar.type = 'file';
        avatar.name = 'avatar';
        Object.defineProperty(avatar, 'files', { configurable: true, value: [new File(['x'], 'avatar.png', { type: 'image/png' })] });
        document.getElementById('form_create').append(avatar);

        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'V1';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        document.getElementById('sb_character_editor_save').click();
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(runtime.mocks['scripts/utils.js'].ensureImageFormatSupported).toHaveBeenCalled();
        nameInput.value = 'V2';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        window.dispatchEvent(new Event('pagehide'));
        finishConversion();
        await new Promise(resolve => setTimeout(resolve, 20));

        const editCall = runtime.fetchMock.mock.calls.find(([url]) => url === '/api/characters/edit');
        expect(editCall[1].body.get('ch_name')).toBe('V1');
        const stored = JSON.parse(localStorage.getItem('sb-editor-draft-default-alice.png'));
        expect(stored.snapshot.character_name_pole).toBe('V2');
    });

    test('character create re-keys its submitted baseline and later edits to the returned avatar', async () => {
        let finishCreate;
        const runtime = await openAliceEditor({
            fetchImpl: jest.fn(async (url) => {
                if (url === '/api/characters/create') {
                    return new Promise(resolve => {
                        finishCreate = () => resolve({ ok: true, status: 200, text: async () => 'created.png' });
                    });
                }
                if (url === '/api/characters/all') {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => [
                            { name: 'Alice', avatar: 'alice.png', chat: 'Alice chat', data: { extensions: {} } },
                            { name: 'Created', avatar: 'created.png', chat: 'Created chat', create_date: '2026-10-19T00:00:00.000Z', json_data: '{"name":"Created"}', data: { extensions: {} } },
                        ],
                    };
                }
                if (url === '/api/characters/get') {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ name: 'Created', avatar: 'created.png', chat: 'Created chat', create_date: '2026-10-19T00:00:00.000Z', json_data: '{"name":"Created"}', data: { extensions: {} } }),
                    };
                }
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }),
        });

        runtime.charEditor.beginCharacterEditorLoad();
        document.getElementById('form_create').setAttribute('actiontype', 'createcharacter');
        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'V1';
        runtime.charEditor.loadCharacterEditorGreetings(null, 'create');
        runtime.charEditor.openCharacterEditorCreateSession();

        const folderSelect = document.getElementById('character_folder');
        folderSelect.value = 'create-folder';
        folderSelect.dispatchEvent(new Event('change', { bubbles: true }));

        document.getElementById('sb_character_editor_save').click();
        await new Promise(resolve => setTimeout(resolve, 10));

        nameInput.value = 'V2';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        window.dispatchEvent(new Event('pagehide'));

        finishCreate();
        await new Promise(resolve => setTimeout(resolve, 25));

        expect(runtime.toastr.error).not.toHaveBeenCalled();
        expect(localStorage.getItem('sb-editor-draft-default-new-character')).toBeNull();
        expect(JSON.parse(localStorage.getItem('sb-editor-draft-default-created.png')).snapshot.character_name_pole).toBe('V2');
        expect(document.getElementById('form_create').getAttribute('actiontype')).toBe('editcharacter');
        expect(document.querySelector('#form_create [name="avatar_url"]').value).toBe('created.png');
        expect(runtime.setFolder).toHaveBeenCalledWith('characters', ['created.png'], 'create-folder');

        document.getElementById('sb_character_editor_save').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        const editCall = runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/characters/edit').at(-1);
        expect(editCall[1].body.get('avatar_url')).toBe('created.png');
        expect(editCall[1].body.get('chat')).toBe('Created chat');
        expect(editCall[1].body.get('create_date')).toBe('2026-10-19T00:00:00.000Z');
        expect(editCall[1].body.get('json_data')).toBe('{"name":"Created"}');
        expect(document.getElementById('sb_character_editor_cancel').disabled).toBe(true);
    });

    test.each([false, true])('library refresh preserves an editor only when requested (%s)', async preserveEditor => {
        const runtime = await setupListRuntime({ useRealCharEditor: false });
        runtime.script.characters.push({ name: 'Alice', avatar: 'alice.png', chat: 'Alice chat', data: { extensions: {} } });
        runtime.script.setCharacterId(0);
        const editorOpened = [];
        runtime.eventSource.on(runtime.script.event_types.CHARACTER_EDITOR_OPENED, () => editorOpened.push('opened'));

        await runtime.script.getCharacters(preserveEditor ? { preserveEditor: true } : undefined);

        expect(Number(runtime.script.this_chid)).toBe(0);
        expect(editorOpened).toHaveLength(preserveEditor ? 0 : 1);
    });

    test.each(['createOrEditCharacter', 'flushCharacterSaveDebounced'])('external %s rebases only its submitted form and preserves later typing', async entry => {
        let finish;
        const runtime = await openAliceEditor({
            fetchImpl: jest.fn(async (url) => {
                if (url === '/api/characters/edit') {
                    if (!finish) {
                        return new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, json: async () => ({}) }); });
                    }
                    return { ok: true, status: 200, json: async () => ({}) };
                }
                return { ok: true, status: 200, json: async () => ({}) };
            }),
        });

        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'External V1';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        let saving;
        if (entry === 'flushCharacterSaveDebounced') {
            runtime.script.saveCharacterDebounced();
            saving = runtime.script.flushCharacterSaveDebounced();
        } else {
            saving = runtime.script.createOrEditCharacter();
        }
        await new Promise(resolve => setTimeout(resolve, 10));

        nameInput.value = 'Later V2';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        window.dispatchEvent(new Event('pagehide'));

        finish();
        await saving;

        expect(document.getElementById('sb_character_editor_cancel').disabled).toBe(false);
        expect(JSON.parse(localStorage.getItem('sb-editor-draft-default-alice.png')).snapshot.character_name_pole).toBe('Later V2');

        if (entry === 'flushCharacterSaveDebounced') {
            runtime.script.saveCharacterDebounced();
            await runtime.script.flushCharacterSaveDebounced();
        } else {
            await runtime.script.createOrEditCharacter();
        }
        expect(document.getElementById('sb_character_editor_cancel').disabled).toBe(true);
        expect(localStorage.getItem('sb-editor-draft-default-alice.png')).toBeNull();
    });

    test('legacy external CHARACTER_EDITED notifications rebase only the matching character', async () => {
        const runtime = await openAliceEditor();
        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'Externally saved';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();

        await runtime.eventSource.emit(runtime.script.event_types.CHARACTER_EDITED, { detail: { character: { avatar: 'bob.png' } } });
        expect(document.getElementById('sb_character_editor_cancel').disabled).toBe(false);

        await runtime.eventSource.emit(runtime.script.event_types.CHARACTER_EDITED, { detail: { character: { avatar: 'alice.png' } } });
        expect(document.getElementById('sb_character_editor_cancel').disabled).toBe(true);
    });

    test.each(['Alice', 'Bob'])('a late character acknowledgement and event leave a replacement %s editor untouched', async name => {
        let finish;
        const runtime = await openAliceEditor({
            fetchImpl: jest.fn(async (url) => {
                if (url === '/api/characters/edit') {
                    return new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, json: async () => ({}) }); });
                }
                return { ok: true, status: 200, json: async () => ({}) };
            }),
        });

        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'V1';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        document.getElementById('sb_character_editor_save').click();
        await new Promise(resolve => setTimeout(resolve, 10));

        document.getElementById('sb_character_editor_cancel').click();
        runtime.charEditor.beginCharacterEditorLoad();
        runtime.script.characters.push({ name: 'Bob', avatar: 'bob.png', data: { extensions: {} } });
        const chid = name === 'Alice' ? 0 : 1;
        const avatar = runtime.script.characters[chid].avatar;
        runtime.script.setCharacterId(chid);
        nameInput.value = name;
        document.querySelector('#form_create [name="avatar_url"]').value = avatar;
        runtime.charEditor.openCharacterEditorSession(chid);
        nameInput.value = `${name} pending`;
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        window.dispatchEvent(new Event('pagehide'));
        const backup = localStorage.getItem(`sb-editor-draft-default-${avatar}`);

        finish();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(localStorage.getItem(`sb-editor-draft-default-${avatar}`)).toBe(backup);
        document.getElementById('sb_character_editor_cancel').click();
        expect(nameInput.value).toBe(name);
    });

    test('confirmed character deletion closes its hidden session and removes the persisted draft key', async () => {
        const runtime = await openAliceEditor();
        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'Pending';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        window.dispatchEvent(new Event('pagehide'));
        expect(localStorage.getItem('sb-editor-draft-default-alice.png')).not.toBeNull();

        await expect(runtime.script.deleteCharacterById('alice.png')).resolves.toBe(true);
        expect(runtime.charEditor.captureCharacterEditorSave('alice.png')).toBeNull();
        expect(localStorage.getItem('sb-editor-draft-default-alice.png')).toBeNull();

        window.dispatchEvent(new Event('pagehide'));
        expect(localStorage.getItem('sb-editor-draft-default-alice.png')).toBeNull();
    });

    test('failed character deletion keeps the editor session and its recoverable draft', async () => {
        const runtime = await openAliceEditor({
            fetchImpl: jest.fn(async (url) => {
                if (url === '/api/characters/delete') {
                    return { ok: false, status: 500, statusText: 'Failure', json: async () => ({}) };
                }
                return { ok: true, status: 200, json: async () => ({}) };
            }),
        });
        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'Pending';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        window.dispatchEvent(new Event('pagehide'));

        await expect(runtime.script.deleteCharacterById('alice.png')).resolves.toBe(false);
        expect(runtime.charEditor.captureCharacterEditorSave('alice.png')).not.toBeNull();
        expect(JSON.parse(localStorage.getItem('sb-editor-draft-default-alice.png')).snapshot.character_name_pole).toBe('Pending');
    });

    test('deleting another character removes its dormant backup without closing the current editor', async () => {
        const runtime = await openAliceEditor();
        const nameInput = document.getElementById('character_name_pole');
        nameInput.value = 'Pending';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushDirty();
        window.dispatchEvent(new Event('pagehide'));

        runtime.script.characters.push({ name: 'Bob', avatar: 'bob.png', data: { extensions: {} } });
        localStorage.setItem('sb-editor-draft-default-bob.png', JSON.stringify({
            snapshot: { character_name_pole: 'Dormant' },
            savedAt: Date.now(),
        }));

        await expect(runtime.script.deleteCharacterById('bob.png')).resolves.toBe(true);
        expect(runtime.charEditor.captureCharacterEditorSave('alice.png')).not.toBeNull();
        expect(localStorage.getItem('sb-editor-draft-default-alice.png')).not.toBeNull();
        expect(localStorage.getItem('sb-editor-draft-default-bob.png')).toBeNull();
    });
});

describe('plain list row data in script.js', () => {
    test('character and group data match the upstream presentation without building DOM', async () => {
        let selectedGroup = null;
        const runtime = await setupListRuntime({
            useRealCharEditor: false,
            extraMocks: {
                'scripts/power-user.js': base => ({
                    ...base,
                    power_user: { ...base.power_user, aux_field: 'creator', show_card_avatar_urls: true },
                }),
                'scripts/welcome-screen.js': {
                    getPermanentAssistantAvatar: () => 'alice.png',
                },
                'scripts/group-chats.js': {
                    get selected_group() { return selectedGroup; },
                },
            },
        });
        const alice = { name: 'Alice', avatar: 'alice.png', fav: true, data: { creator_notes: 'Notes', creator: 'Creator' } };
        runtime.script.characters.push(alice, { name: 'Bob', avatar: 'none', data: {} });
        runtime.script.setCharacterId(0);

        const data = runtime.script.getCharacterRowData(alice, 0);
        expect(data).toMatchObject({
            name: 'Alice',
            creatorNotes: 'Notes',
            auxFieldValue: 'Creator',
            favorite: true,
            active: true,
            assistant: true,
            showCardAvatarUrls: true,
        });
        expect(data.avatarUrl).toContain('alice.png');
        expect(data.avatarTitle).toContain('File: alice.png');
        expect(runtime.script.getCharacterRowData({ name: 'Missing', avatar: 'none' }, 1).avatarUrl).toBe(runtime.script.default_avatar);

        const group = runtime.script.getGroupRowData({ id: 'g1', name: 'Friends', members: ['alice.png', 'Bob', 'deleted.png'], fav: true });
        expect(group).toMatchObject({
            favorite: true,
            memberNames: ['Alice', 'Bob'],
            memberNamesText: 'Alice, Bob',
            memberCount: 2,
            memberCountText: '2 characters',
            avatarInfo: { custom: false, memberAvatars: ['alice.png'] },
        });
        expect(JSON.parse(JSON.stringify(group))).toEqual(group);
        expect(Object.values(group).some(value => value instanceof Element)).toBe(false);
    });
});
