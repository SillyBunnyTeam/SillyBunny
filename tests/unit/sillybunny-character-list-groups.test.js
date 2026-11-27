/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each assertions run inside test callbacks. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { importGroupChatsModule } from '../util/group-chats-module-harness.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
const OriginalResizeObserver = globalThis.ResizeObserver;
let trackedNativeListeners = [];
let restoreNativeListeners = null;

afterEach(() => {
    for (const [target, type, listener, opts] of trackedNativeListeners) {
        try {
            target.removeEventListener(type, listener, opts);
        } catch {
            // Ignore teardown errors.
        }
    }
    trackedNativeListeners = [];
    restoreNativeListeners?.();
    restoreNativeListeners = null;
    document.body.innerHTML = '';
    localStorage.clear();
    globalThis.ResizeObserver = OriginalResizeObserver;
    if (typeof window !== 'undefined' && window.jQuery) {
        window.jQuery(document).off();
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
});

function mountGroupEditorDom() {
    document.body.innerHTML = `
        <div id="chat"></div>
        <div id="rm_group_chats_block">
            <div id="sb_group_editor_header">
                <button id="sb_group_editor_back" type="button"></button>
                <button id="sb_group_editor_title_button" type="button"><span id="sb_group_editor_title"></span></button>
                <span id="sb_group_editor_dirty" hidden></span>
                <button id="sb_group_editor_cancel" type="button"></button>
                <button id="sb_group_editor_save" type="button"></button>
                <button id="sb_group_editor_more" type="button"></button>
            </div>
            <div id="sb_group_editor_toolbar">
                <div id="group_favorite_button" class="fav_off"></div>
                <button id="rm_group_restore_avatar" type="button"></button>
                <button id="rm_group_delete" type="button"></button>
            </div>
            <div id="sb_group_editor_content">
                <input id="rm_group_chat_name" type="text" value="" />
                <div id="group_folder_row"></div>
                <input id="rm_group_allow_self_responses" type="checkbox" />
                <input id="rm_group_hidemutedsprites" type="checkbox" />
                <select id="rm_group_activation_strategy"><option value="0">Natural</option></select>
                <select id="rm_group_generation_mode"><option value="0">Swap</option></select>
                <input id="rm_group_generation_mode_join_prefix" type="text" value="" />
                <input id="rm_group_generation_mode_join_suffix" type="text" value="" />
                <div class="sb-editor-section">
                    <span data-sb-group-list-status></span>
                    <div><input id="rm_group_members_filter" type="text" value="" /></div>
                    <div id="rm_group_members"></div>
                </div>
                <div class="sb-editor-section">
                    <span data-sb-group-list-status></span>
                    <div><input id="rm_group_filter" type="text" value="" /></div>
                    <div id="rm_group_add_members"></div>
                </div>
                <button id="rm_group_submit" type="button"></button>
                <select id="group-chat-lorebook-dropdown"></select>
                <input id="groupTagInput" type="text" />
                <div id="groupTagList"></div>
                <div id="group_tags_div"><div class="tags_view"></div></div>
            </div>
        </div>
        <div id="group_avatar_preview"><img src="" /></div>
        <div id="group_avatars_template" hidden>
            <div class="collage_1"><img class="img_1" /></div>
        </div>
        <select id="group_member_model_select"></select>
        <div id="rm_button_selected_ch"><h2></h2></div>
    `;
    const block = document.getElementById('rm_group_chats_block');
    block.getClientRects = () => [{ width: 320, height: 600 }];
}

async function setupGroupRuntime({
    groups = [{ id: 'g1', name: 'Saved', fav: false, members: [], disabled_members: [], avatar_url: '', chat_id: 'chat-g1', chats: ['chat-g1'] }],
    fetchImpl = null,
    folderMap = null,
    isGroupGenerating = false,
    popupConfirm = null,
    objectNavigationBack = null,
} = {}) {
    mountGroupEditorDom();
    localStorage.clear();

    const origWinAdd = window.addEventListener.bind(window);
    const origDocAdd = document.addEventListener.bind(document);
    window.addEventListener = (type, listener, opts) => {
        trackedNativeListeners.push([window, type, listener, opts]);
        return origWinAdd(type, listener, opts);
    };
    document.addEventListener = (type, listener, opts) => {
        trackedNativeListeners.push([document, type, listener, opts]);
        return origDocAdd(type, listener, opts);
    };
    restoreNativeListeners = () => {
        window.addEventListener = origWinAdd;
        document.addEventListener = origDocAdd;
    };

    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };

    const folderAssignments = new Map(folderMap ?? [['g1', 'saved-folder']]);
    const availableFolders = [
        { id: 'saved-folder', name: 'Saved Folder' },
        { id: 'discarded-folder', name: 'Discarded Folder' },
        { id: 'saved-next-folder', name: 'Next Folder' },
        { id: 'new-group-folder', name: 'New Group Folder' },
    ];
    const setFolder = jest.fn(async (_scope, keys, folderId) => {
        for (const key of keys) {
            if (folderId === null) folderAssignments.delete(String(key));
            else folderAssignments.set(String(key), String(folderId));
        }
    });
    const removeEntityKey = jest.fn((_scope, key) => folderAssignments.delete(String(key)));

    const fetchMock = fetchImpl ?? jest.fn(async (url, init = {}) => {
        if (url === '/api/groups/create') {
            const parsed = JSON.parse(init.body);
            return { ok: true, status: 200, json: async () => ({ ...parsed, id: 'created-group' }) };
        }
        if (url === '/api/chats/group/get') {
            return { ok: true, status: 200, json: async () => [{ chat_metadata: {} }] };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    await jest.unstable_mockModule(pub('scripts/user.js'), () => ({
        getCurrentUserHandle: () => 'default',
    }));
    await jest.unstable_mockModule(pub('scripts/dynamic-styles.js'), () => ({
        loadStylesheetAsync: jest.fn(async () => {}),
    }));

    let currentMenuType = 'group_edit';
    const backSpy = objectNavigationBack ?? jest.fn(async () => {});
    const loaded = await importGroupChatsModule({
        fetch: fetchMock,
        useRealGroupEditor: true,
        script: {
            get menu_type() { return currentMenuType; },
            setMenuType: jest.fn(next => { currentMenuType = next; }),
        },
        folders: {
            getFolderId: (_scope, key) => folderAssignments.get(String(key)) ?? null,
            getFolders: () => availableFolders,
            subscribe: () => () => {},
            setFolder,
            removeEntityKey,
        },
        popup: {
            Popup: Object.assign(jest.fn(() => ({ show: jest.fn(async () => 1) })), {
                show: {
                    confirm: popupConfirm ?? jest.fn(async () => true),
                    input: jest.fn(async () => ''),
                },
            }),
        },
        objectNavigation: {
            back: backSpy,
            isRouting: false,
        },
    });

    loaded.groupChats.groups.push(...groups);
    if (isGroupGenerating) {
        loaded.groupChats.setIsGroupGenerating?.(true);
    }

    const groupEditor = await import('../../public/scripts/sillybunny-group-editor.js');
    await loaded.runReady();

    return {
        ...loaded,
        groupEditor,
        fetchMock,
        folderAssignments,
        setFolder,
        removeEntityKey,
        backSpy,
    };
}

describe('group list actions and editor sessions in group-chats.js', () => {
    test('rapid group favorite toggles both persist through the real immediate save path', async () => {
        jest.useFakeTimers();
        const runtime = await setupGroupRuntime({
            groups: [
                { id: 'g1', name: 'One', fav: false, members: [] },
                { id: 'g2', name: 'Two', fav: false, members: [] },
            ],
        });

        await Promise.all([
            runtime.groupChats.toggleGroupFavoriteById('g1'),
            runtime.groupChats.toggleGroupFavoriteById('g2'),
        ]);
        await jest.runAllTimersAsync();

        expect(runtime.fetchMock.mock.calls.map(([url, req]) => [url, JSON.parse(req.body).id])).toEqual([
            ['/api/groups/edit', 'g1'],
            ['/api/groups/edit', 'g2'],
        ]);
    });

    test.each(['http', 'network'])('a rejected %s group favorite save restores the live value, refreshes and reports the existing error', async failure => {
        const fetchMock = failure === 'http'
            ? jest.fn(async () => ({ ok: false, statusText: 'Bad Gateway' }))
            : jest.fn(async () => { throw new Error('Network failure'); });
        const runtime = await setupGroupRuntime({ fetchImpl: fetchMock });

        await expect(runtime.groupChats.toggleGroupFavoriteById('g1')).resolves.toBe(false);
        expect(runtime.groupChats.groups[0].fav).toBe(false);
        expect(runtime.mocks.script.printCharactersDebounced).toHaveBeenCalled();
        expect(runtime.mocks.toastr.error).toHaveBeenCalledWith(
            'Check the server connection and reload the page to prevent data loss.',
            'Group chat could not be saved',
        );
    });

    test('group favorite awaits the server acknowledgement before reporting success', async () => {
        let acknowledge;
        const response = new Promise(resolve => { acknowledge = resolve; });
        const runtime = await setupGroupRuntime({ fetchImpl: jest.fn(() => response) });

        let completed = false;
        const toggling = runtime.groupChats.toggleGroupFavoriteById('g1').then(result => { completed = true; return result; });
        await Promise.resolve();
        expect(completed).toBe(false);
        expect(runtime.mocks.script.printCharactersDebounced).not.toHaveBeenCalled();

        acknowledge({ ok: true });
        await expect(toggling).resolves.toBe(true);
        expect(runtime.mocks.script.printCharactersDebounced).toHaveBeenCalledTimes(1);
    });

    test('a delayed group favorite acknowledgement cannot modify a successor editor draft', async () => {
        let acknowledge;
        const response = new Promise(resolve => { acknowledge = resolve; });
        const runtime = await setupGroupRuntime({
            useRealGroupEditor: true,
            groups: [
                { id: 'g1', name: 'One', fav: false, members: ['alice.png'], disabled_members: [] },
                { id: 'g2', name: 'Two', fav: false, members: ['bob.png'], disabled_members: [] },
            ],
            fetchImpl: jest.fn(async (url) => {
                if (url === '/api/groups/edit') return response;
                return { ok: true, json: async () => [{ chat_metadata: {} }] };
            }),
        });

        await runtime.groupChats.openGroupEditor('g1');
        const toggling = runtime.groupChats.toggleGroupFavoriteById('g1');
        await runtime.groupChats.openGroupEditor('g2');
        const nameInput = document.getElementById('rm_group_chat_name');
        nameInput.value = 'Pending';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));

        acknowledge({ ok: true });
        await expect(toggling).resolves.toBe(true);
        expect(runtime.groupChats.groups[0].fav).toBe(true);
        expect(runtime.groupChats.groups[1].fav).toBe(false);
        expect(runtime.groupEditor.isGroupEditorOwner('g2')).toBe(true);
        expect(runtime.groupEditor.readGroupEditorBaseline()).toMatchObject({ id: 'g2', fav: false, name: 'Two' });
        expect(nameInput.value).toBe('Pending');
    });

    test('group Folder changes participate in discard and save without entering the group payload', async () => {
        const runtime = await setupGroupRuntime({ useRealGroupEditor: true });
        await runtime.groupChats.openGroupEditor('g1');

        expect(runtime.groupEditor.readGroupEditorBaseline()._folder).toBe('saved-folder');
        const folderSelect = document.getElementById('group_folder');
        const cancelBtn = document.getElementById('sb_group_editor_cancel');
        const saveBtn = document.getElementById('sb_group_editor_save');

        // Changing folder marks dirty; Cancel discards back to saved-folder.
        folderSelect.value = 'discarded-folder';
        folderSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(cancelBtn.disabled).toBe(false);
        cancelBtn.click();
        expect(folderSelect.value).toBe('saved-folder');
        expect(cancelBtn.disabled).toBe(true);

        // Changing folder and clicking Save commits folder and omits _folder from /api/groups/edit.
        folderSelect.value = 'saved-next-folder';
        folderSelect.dispatchEvent(new Event('change', { bubbles: true }));
        saveBtn.click();
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(runtime.setFolder).toHaveBeenCalledWith('groups', ['g1'], 'saved-next-folder');
        const editCall = runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/groups/edit').at(-1);
        expect(editCall).toBeTruthy();
        expect(JSON.parse(editCall[1].body)).not.toHaveProperty('_folder');
        expect(runtime.groupEditor.readGroupEditorBaseline()._folder).toBe('saved-next-folder');
    });

    test('group create acknowledges the submitted Folder in its saved baseline', async () => {
        const runtime = await setupGroupRuntime({
            groups: [],
        });

        await runtime.groupChats.select_group_chats(null, false);
        const nameInput = document.getElementById('rm_group_chat_name');
        nameInput.value = 'New group';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));

        const folderSelect = document.getElementById('group_folder');
        folderSelect.value = 'new-group-folder';
        folderSelect.dispatchEvent(new Event('change', { bubbles: true }));

        const submitBtn = document.getElementById('rm_group_submit');
        submitBtn.disabled = false;
        submitBtn.click();
        await new Promise(resolve => setTimeout(resolve, 15));

        expect(runtime.setFolder).toHaveBeenCalledWith('groups', ['created-group'], 'new-group-folder');
        expect(runtime.groupEditor.isGroupEditorOwner('created-group')).toBe(true);
        expect(runtime.groupEditor.readGroupEditorBaseline()).toMatchObject({
            id: 'created-group',
            _folder: 'new-group-folder',
        });
    });

    test('group pencil-open, Back, list favorite and reopen stay clean and a later Save preserves the favorite', async () => {
        const runtime = await setupGroupRuntime({ useRealGroupEditor: true });
        await runtime.groupChats.openGroupEditor('g1');

        document.getElementById('sb_group_editor_back').click();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(runtime.backSpy).toHaveBeenCalled();
        expect(runtime.groupEditor.isGroupEditorOwner('g1')).toBe(true);

        await runtime.groupChats.toggleGroupFavoriteById('g1');
        await runtime.groupChats.openGroupEditor('g1');
        expect(runtime.groupChats.groups[0].fav).toBe(true);
        expect(runtime.groupEditor.readGroupEditorBaseline().fav).toBe(true);
        expect(document.getElementById('sb_group_editor_cancel').disabled).toBe(true);

        const nameInput = document.getElementById('rm_group_chat_name');
        nameInput.value = 'Later edit';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        runtime.groupEditor.notifyGroupEditorChanged({ immediate: true });
        document.getElementById('sb_group_editor_save').click();
        await new Promise(resolve => setTimeout(resolve, 10));

        const editCalls = runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/groups/edit');
        expect(editCalls.map(([, req]) => JSON.parse(req.body).fav)).toEqual([true, true]);
        expect(runtime.groupChats.groups[0]).toMatchObject({ name: 'Later edit', fav: true });
        expect(document.getElementById('sb_group_editor_cancel').disabled).toBe(true);
    });

    test('group favorite rebases only fav and patches a stored backup without cleaning unrelated pending edits', async () => {
        const runtime = await setupGroupRuntime({ useRealGroupEditor: true });
        await runtime.groupChats.openGroupEditor('g1');

        const nameInput = document.getElementById('rm_group_chat_name');
        nameInput.value = 'Pending';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        // Wait for dirty debounce or flush via pagehide.
        window.dispatchEvent(new Event('pagehide'));

        await runtime.groupChats.toggleGroupFavoriteById('g1');
        expect(document.getElementById('sb_group_editor_cancel').disabled).toBe(false);
        expect(runtime.groupEditor.readGroupEditorBaseline()).toMatchObject({ name: 'Saved', fav: true });
        const stored = JSON.parse(localStorage.getItem('sb-group-editor-draft-default-g1'));
        expect(stored.snapshot).toMatchObject({ name: 'Pending', fav: true });

        const editCall = runtime.fetchMock.mock.calls.find(([url]) => url === '/api/groups/edit');
        expect(JSON.parse(editCall[1].body).name).toBe('Saved');

        document.getElementById('sb_group_editor_cancel').click();
        expect(nameInput.value).toBe('Saved');
        expect(document.getElementById('group_favorite_button').classList.contains('fav_on')).toBe(true);
    });

    test('a failed group favorite leaves an owned draft, baseline and backup unchanged', async () => {
        const runtime = await setupGroupRuntime({ useRealGroupEditor: true });
        await runtime.groupChats.openGroupEditor('g1');

        const nameInput = document.getElementById('rm_group_chat_name');
        nameInput.value = 'Pending';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        window.dispatchEvent(new Event('pagehide'));

        runtime.fetchMock.mockResolvedValueOnce({ ok: false });
        await expect(runtime.groupChats.toggleGroupFavoriteById('g1')).resolves.toBe(false);
        expect(runtime.groupChats.groups[0].fav).toBe(false);
        expect(nameInput.value).toBe('Pending');
        expect(runtime.groupEditor.readGroupEditorBaseline()).toMatchObject({ name: 'Saved', fav: false });
        const stored = JSON.parse(localStorage.getItem('sb-group-editor-draft-default-g1'));
        expect(stored.snapshot).toMatchObject({ name: 'Pending', fav: false });
    });

    test('confirmed group deletion closes its hidden editor and removes the persisted draft key', async () => {
        const runtime = await setupGroupRuntime({ useRealGroupEditor: true });
        await runtime.groupChats.openGroupEditor('g1');

        const nameInput = document.getElementById('rm_group_chat_name');
        nameInput.value = 'Pending';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        window.dispatchEvent(new Event('pagehide'));
        expect(localStorage.getItem('sb-group-editor-draft-default-g1')).not.toBeNull();

        await expect(runtime.groupChats.deleteGroupById('g1')).resolves.toBe(true);
        expect(runtime.groupEditor.isGroupEditorOwner('g1')).toBe(false);
        expect(localStorage.getItem('sb-group-editor-draft-default-g1')).toBeNull();

        window.dispatchEvent(new Event('pagehide'));
        expect(localStorage.getItem('sb-group-editor-draft-default-g1')).toBeNull();
    });

    test('failed group deletion keeps the editor session and its recoverable draft', async () => {
        const runtime = await setupGroupRuntime({ useRealGroupEditor: true });
        await runtime.groupChats.openGroupEditor('g1');

        const nameInput = document.getElementById('rm_group_chat_name');
        nameInput.value = 'Pending';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        window.dispatchEvent(new Event('pagehide'));

        runtime.fetchMock.mockResolvedValueOnce({ ok: false });
        await expect(runtime.groupChats.deleteGroupById('g1')).resolves.toBe(false);
        expect(runtime.groupEditor.isGroupEditorOwner('g1')).toBe(true);
        expect(JSON.parse(localStorage.getItem('sb-group-editor-draft-default-g1')).snapshot.name).toBe('Pending');
    });

    test('deleting another group removes its dormant backup without closing the current editor', async () => {
        const runtime = await setupGroupRuntime({
            useRealGroupEditor: true,
            groups: [
                { id: 'g1', name: 'Saved', fav: false, members: [] },
                { id: 'g2', name: 'Other', fav: false, members: [] },
            ],
        });
        await runtime.groupChats.openGroupEditor('g1');

        const nameInput = document.getElementById('rm_group_chat_name');
        nameInput.value = 'Pending';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        window.dispatchEvent(new Event('pagehide'));

        localStorage.setItem('sb-group-editor-draft-default-g2', JSON.stringify({
            snapshot: { id: 'g2', name: 'Dormant' },
            savedAt: Date.now(),
        }));

        await expect(runtime.groupChats.deleteGroupById('g2')).resolves.toBe(true);
        expect(runtime.groupEditor.isGroupEditorOwner('g1')).toBe(true);
        expect(nameInput.value).toBe('Pending');
        expect(localStorage.getItem('sb-group-editor-draft-default-g1')).not.toBeNull();
        expect(localStorage.getItem('sb-group-editor-draft-default-g2')).toBeNull();
    });

    test('group favorite saves the live group without reloading or replacing another draft, and handles missing id', async () => {
        const runtime = await setupGroupRuntime({
            useRealGroupEditor: true,
            groups: [
                { id: 'g1', name: 'One', fav: false, members: [] },
                { id: 'other', name: 'Other', fav: false, members: [] },
            ],
        });
        await runtime.groupChats.openGroupEditor('other');

        await expect(runtime.groupChats.toggleGroupFavoriteById('g1')).resolves.toBe(true);
        expect(runtime.groupChats.groups[0].fav).toBe(true);
        expect(runtime.mocks.script.printCharactersDebounced).toHaveBeenCalledTimes(1);
        expect(runtime.groupEditor.readGroupEditorBaseline().fav).toBe(false);
        await expect(runtime.groupChats.toggleGroupFavoriteById('missing')).resolves.toBe(false);
    });

    test('group deletion confirms, returns deletion success, and guards missing, generating, or cancelled targets', async () => {
        const confirm = jest.fn(async () => true);
        const runtime = await setupGroupRuntime({ popupConfirm: confirm });

        await expect(runtime.groupChats.deleteGroupById('missing')).resolves.toBe(false);

        confirm.mockResolvedValueOnce(false);
        await expect(runtime.groupChats.deleteGroupById('g1')).resolves.toBe(false);
        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/groups/delete')).toBe(false);

        await expect(runtime.groupChats.deleteGroupById('g1')).resolves.toBe(true);
        expect(confirm).toHaveBeenLastCalledWith(
            'Delete the group?',
            expect.stringContaining('delete all your chats'),
            expect.objectContaining({ okButton: 'Delete', defaultResult: 0 }),
        );
        expect(runtime.fetchMock.mock.calls.some(([url]) => url === '/api/groups/delete')).toBe(true);
    });

    test('getGroupAvatarElement returns a DOM element for a group', async () => {
        const runtime = await setupGroupRuntime();
        const el = runtime.groupChats.getGroupAvatarElement({ id: 'g1', name: 'Friends', members: ['alice.png'], avatar_url: '' });
        expect(el).toBeInstanceOf(Element);
    });
});
