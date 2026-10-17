/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const characters = [{ avatar: 'Bob.png' }, { avatar: 'Alice.png' }];
const groups = [{ id: 'qa-group' }];
const groupEditorTargetExists = jest.fn();
const selectCharacterById = jest.fn();
const canPeekGroupMember = jest.fn();
const openGroupMemberDefinition = jest.fn();
const openGroupEditor = jest.fn();
const openGroupById = jest.fn();
const captureGroupEditorListState = jest.fn();
const restoreGroupEditorListState = jest.fn();
const confirmActiveEditorLeave = jest.fn();
const mountCharacterList = jest.fn();
const restoreCharacterListState = jest.fn();
const switchCharacterListView = jest.fn();
let activeListView;

await jest.unstable_mockModule('../../public/scripts/sillybunny-character-list.js', () => ({ mountCharacterList, restoreCharacterListState }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-character-list-state.js', () => ({
    getCharacterListView: () => activeListView,
    switchCharacterListView,
}));

await jest.unstable_mockModule('../../public/script.js', () => ({ characters, this_chid: 1, selectCharacterById }));
await jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
    groups,
    groupEditorTargetExists,
    canPeekGroupMember,
    openGroupMemberDefinition,
    openGroupEditor,
    openGroupById,
    captureGroupEditorListState,
    restoreGroupEditorListState,
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/navigation.js', () => ({ confirmActiveEditorLeave }));

const { objectNavigation, createObjectNavigation } = await import('../../public/scripts/sillybunny-editor/object-navigation.js');
const register = jest.spyOn(objectNavigation, 'register');
const bindTopLevelClear = jest.spyOn(objectNavigation, 'bindTopLevelClear');
await import('../../public/scripts/sillybunny-characters-navigation.js');
const registrations = [...register.mock.calls];
const bindings = [...bindTopLevelClear.mock.calls];
const characterEditor = registrations.find(([kind]) => kind === 'character-editor')[1];
const groupEditor = registrations.find(([kind]) => kind === 'group-editor')[1];
const characterList = registrations.find(([kind]) => kind === 'character-list')[1];
const groupList = registrations.find(([kind]) => kind === 'group-list')[1];
const from = { kind: 'group-editor', id: 'qa-group' };
const target = { kind: 'character-editor', id: 'Alice.png', via: 'group-member' };
const currentRoute = { isCurrent: () => true };

beforeEach(() => {
    jest.clearAllMocks();
    objectNavigation.clear();
    characters[1] = { avatar: 'Alice.png' };
    groups.splice(1);
    groupEditorTargetExists.mockImplementation(id => id === 'create' || groups.some(group => group.id === id));
    confirmActiveEditorLeave.mockResolvedValue(true);
    canPeekGroupMember.mockReturnValue(true);
    openGroupEditor.mockResolvedValue(true);
    captureGroupEditorListState.mockReturnValue({ scrollTop: 240, membersPage: 2, focusedMemberAvatar: 'Alice.png' });
    restoreGroupEditorListState.mockResolvedValue(undefined);
    activeListView = 'characters';
    mountCharacterList.mockResolvedValue({});
    restoreCharacterListState.mockResolvedValue(undefined);
    switchCharacterListView.mockImplementation(async view => { activeListView = view; });
    window.SillyBunnyShell = { openTab: jest.fn(async () => true) };
    window.SillyBunnyCharacterListController = { captureState: jest.fn(() => ({ query: 'Alice', page: 2, scrollTop: 80, focusKey: 'character:Alice.png' })) };
    selectCharacterById.mockImplementation(async () => { showCharacterEditor(); return true; });
    openGroupMemberDefinition.mockImplementation(async () => { showCharacterEditor(); return true; });
    window.toastr = { warning: jest.fn(), error: jest.fn() };
    document.body.innerHTML = `
        <div id="right-nav-panel" class="openDrawer" data-menu-type="group_edit">
            <button data-sb-character-tab="editor" aria-selected="false"></button>
            <button data-sb-character-tab="characters"></button>
            <div id="rm_ch_create_block" style="display: none">
                <form id="form_create"><div class="sb-editor-sheet__content"></div></form>
            </div>
        </div>
        <div id="sb-settings-tab-list"><button data-sb-settings-tab="editor" aria-selected="false"></button></div>`;
    jest.spyOn(document.getElementById('rm_ch_create_block'), 'getClientRects').mockReturnValue([{}]);
});

afterEach(() => {
    objectNavigation.clear();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete window.toastr;
    delete window.SillyBunnyShell;
    delete window.SillyBunnyCharacterListController;
    document.body.replaceChildren();
});

function showCharacterEditor() {
    document.getElementById('right-nav-panel').dataset.menuType = 'character_edit';
    document.getElementById('rm_ch_create_block').style.display = 'block';
    document.querySelector('[data-sb-character-tab="editor"]').setAttribute('aria-selected', 'true');
}

function deferred() {
    let resolve;
    const promise = new Promise(onResolve => { resolve = onResolve; });
    return { promise, resolve };
}

describe('character and group editor destinations', () => {
    test('registers both editor and list destinations and binds top-level clearing once', () => {
        expect(registrations.map(([kind]) => kind)).toEqual(['character-editor', 'group-editor', 'character-list', 'group-list']);
        expect(bindings).toEqual([['[data-sb-character-tab], [data-sb-settings-tab]']]);
        expect(characterEditor.exists('Alice.png')).toBe(true);
        expect(characterEditor.exists('deleted.png')).toBe(false);
        expect(groupEditor.exists('qa-group')).toBe(true);
        expect(groupEditor.exists('create')).toBe(true);
        expect(groupEditor.exists('deleted')).toBe(false);
        expect(characterList.exists()).toBe(true);
        expect(groupList.exists()).toBe(true);
        expect(characterList.current()).toEqual({ kind: 'character-list' });
        expect(groupList.current()).toEqual({ kind: 'group-list' });
    });

    test.each([
        ['characters', 'character-list', characterList],
        ['groups', 'group-list', groupList],
    ])('%s list waits for the shell and mount before restoring its snapshot', async (view, kind, destination) => {
        const pending = deferred();
        window.SillyBunnyShell.openTab.mockReturnValueOnce(pending.promise);
        const snapshot = destination.captureState();
        const result = destination.open({ kind }, { restore: snapshot, ...currentRoute });
        expect(mountCharacterList).not.toHaveBeenCalled();
        pending.resolve(true);
        expect(await result).toBe(true);
        expect(window.SillyBunnyShell.openTab).toHaveBeenCalledWith('characters', view);
        expect(mountCharacterList).toHaveBeenCalledTimes(1);
        expect(activeListView).toBe(view);
        expect(restoreCharacterListState).toHaveBeenCalledWith(snapshot, currentRoute.isCurrent);
        expect(mountCharacterList.mock.invocationCallOrder[0]).toBeLessThan(restoreCharacterListState.mock.invocationCallOrder[0]);
    });

    test.each([characterList, groupList])('a superseded list destination never mounts or restores', async destination => {
        const pending = deferred();
        let current = true;
        window.SillyBunnyShell.openTab.mockReturnValueOnce(pending.promise);
        const result = destination.open(destination.current(), { restore: { page: 2 }, isCurrent: () => current });
        current = false;
        pending.resolve(true);
        expect(await result).toBe(false);
        expect(mountCharacterList).not.toHaveBeenCalled();
        expect(restoreCharacterListState).not.toHaveBeenCalled();
    });

    test('group pencil switches chat while group-editor Back stays presentation-only', async () => {
        expect(await groupEditor.open({ kind: 'group-editor', id: 'qa-group', via: 'group-list' }, currentRoute)).toBe(true);
        expect(openGroupEditor).toHaveBeenCalledWith('qa-group', { switchChat: true, isCurrent: currentRoute.isCurrent });
    });

    test('delegates group existence so an expired create draft cannot be revisited', () => {
        groupEditorTargetExists.mockReturnValue(false);
        expect(groupEditor.exists('create')).toBe(false);
        expect(groupEditorTargetExists).toHaveBeenCalledWith('create');
    });

    test('peeks an eligible member without switching chats and preserves via through the singleton', async () => {
        expect(await objectNavigation.navigate(target, { from })).toEqual({ ok: true });
        expect(canPeekGroupMember).toHaveBeenCalledWith('Alice.png');
        expect(openGroupMemberDefinition).toHaveBeenCalledWith('Alice.png', { isCurrent: expect.any(Function) });
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(objectNavigation.canGoBack(target)).toBe(true);
    });

    test('switches by current avatar index when a member cannot be peeked', async () => {
        canPeekGroupMember.mockReturnValue(false);
        expect(await characterEditor.open(target, currentRoute)).toBe(true);
        expect(selectCharacterById).toHaveBeenCalledWith(1, { switchMenu: true });
        expect(openGroupMemberDefinition).not.toHaveBeenCalled();
    });

    test('ordinary navigation switches even when peeking would be possible', async () => {
        expect(await characterEditor.open({ kind: 'character-editor', id: 'Alice.png' }, currentRoute)).toBe(true);
        expect(canPeekGroupMember).not.toHaveBeenCalled();
        expect(selectCharacterById).toHaveBeenCalledWith(1, { switchMenu: true });
    });

    test('a missing character does not invoke either open path', async () => {
        expect(await characterEditor.open({ ...target, id: 'deleted.png' }, currentRoute)).toBe(false);
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(openGroupMemberDefinition).not.toHaveBeenCalled();
    });

    test.each(['peek', 'switch'])('a refused %s does not report success or fall through', async path => {
        canPeekGroupMember.mockReturnValue(path === 'peek');
        openGroupMemberDefinition.mockResolvedValue(false);
        selectCharacterById.mockResolvedValue(false);
        expect(await characterEditor.open(target, currentRoute)).toBe(false);
        expect(openGroupMemberDefinition).toHaveBeenCalledTimes(path === 'peek' ? 1 : 0);
        expect(selectCharacterById).toHaveBeenCalledTimes(path === 'switch' ? 1 : 0);
    });

    test('waits for the visible editor and selected shell tab before pushing an origin', async () => {
        jest.useFakeTimers();
        openGroupMemberDefinition.mockResolvedValue(true);
        const result = objectNavigation.navigate(target, { from });
        await jest.advanceTimersByTimeAsync(100);
        expect(objectNavigation.depth).toBe(0);
        document.getElementById('rm_ch_create_block').style.display = 'block';
        document.getElementById('right-nav-panel').dataset.menuType = 'character_edit';
        await jest.advanceTimersByTimeAsync(100);
        expect(objectNavigation.depth).toBe(0);
        document.querySelector('[data-sb-settings-tab="editor"]').setAttribute('aria-selected', 'true');
        await jest.advanceTimersByTimeAsync(50);
        expect(await result).toEqual({ ok: true });
        expect(objectNavigation.depth).toBe(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test.each(['hidden', 'closed', 'wrong-menu', 'no-layout', 'unselected', 'wrong-avatar'])('times out for a %s editor without retaining timers', async state => {
        jest.useFakeTimers();
        showCharacterEditor();
        if (state === 'hidden') document.getElementById('rm_ch_create_block').style.visibility = 'hidden';
        if (state === 'closed') document.getElementById('right-nav-panel').classList.remove('openDrawer');
        if (state === 'wrong-menu') document.getElementById('right-nav-panel').dataset.menuType = 'group_edit';
        if (state === 'no-layout') document.getElementById('rm_ch_create_block').getClientRects.mockReturnValue([]);
        if (state === 'unselected') document.querySelector('[data-sb-character-tab="editor"]').setAttribute('aria-selected', 'false');
        openGroupMemberDefinition.mockResolvedValue(true);
        if (state === 'wrong-avatar') openGroupMemberDefinition.mockImplementation(async () => {
            characters[1] = { avatar: 'Bob.png' };
            return true;
        });
        const result = characterEditor.open(target, currentRoute);
        await jest.advanceTimersByTimeAsync(5000);
        expect(await result).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('captures and restores character sheet scroll only after readiness', async () => {
        jest.useFakeTimers();
        const scroller = document.querySelector('#form_create .sb-editor-sheet__content');
        scroller.scrollTop = 84;
        expect(characterEditor.captureState()).toEqual({ scrollTop: 84 });
        openGroupMemberDefinition.mockResolvedValue(true);
        const result = characterEditor.open(target, { ...currentRoute, restore: { scrollTop: 360 } });
        await jest.advanceTimersByTimeAsync(100);
        expect(scroller.scrollTop).toBe(84);
        showCharacterEditor();
        await jest.advanceTimersByTimeAsync(50);
        expect(await result).toBe(true);
        expect(scroller.scrollTop).toBe(360);
    });

    test('Back reopens the group before restoring its captured list state', async () => {
        const state = captureGroupEditorListState();
        captureGroupEditorListState.mockClear();
        await objectNavigation.navigate(target, { from });
        expect(captureGroupEditorListState).toHaveBeenCalledTimes(1);
        const fallback = jest.fn();
        expect(await objectNavigation.back({ current: target, fallback })).toEqual({ ok: true });
        expect(openGroupEditor).toHaveBeenCalledWith('qa-group', { switchChat: false, isCurrent: expect.any(Function) });
        expect(restoreGroupEditorListState).toHaveBeenCalledWith(state);
        expect(openGroupEditor.mock.invocationCallOrder[0]).toBeLessThan(restoreGroupEditorListState.mock.invocationCallOrder[0]);
        expect(fallback).not.toHaveBeenCalled();
    });

    test('opens create drafts and does not restore state after a refused group open', async () => {
        expect(await groupEditor.open({ kind: 'group-editor', id: 'create' }, currentRoute)).toBe(true);
        expect(openGroupEditor).toHaveBeenCalledWith('create', { switchChat: false, isCurrent: expect.any(Function) });
        expect(restoreGroupEditorListState).not.toHaveBeenCalled();
        openGroupEditor.mockResolvedValue(false);
        expect(await groupEditor.open(from, { ...currentRoute, restore: { scrollTop: 100 } })).toBe(false);
        expect(restoreGroupEditorListState).not.toHaveBeenCalled();
    });

    test.each(['character', 'group'])('a stale %s destination does not select or restore anything', async kind => {
        const destination = kind === 'character' ? characterEditor : groupEditor;
        const location = kind === 'character' ? target : from;
        expect(await destination.open(location, { restore: { scrollTop: 100 }, isCurrent: () => false })).toBe(false);
        expect(openGroupMemberDefinition).not.toHaveBeenCalled();
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(openGroupEditor).not.toHaveBeenCalled();
        expect(restoreGroupEditorListState).not.toHaveBeenCalled();
    });

    test('deferred peek A cannot change selection or report success after B starts', async () => {
        const pending = deferred();
        const selections = [];
        const results = [];
        const open = characterEditor.open;
        jest.spyOn(characterEditor, 'open').mockImplementation(async (...args) => {
            const result = await open(...args);
            results.push({ avatar: args[0].id, result });
            return result;
        });
        openGroupMemberDefinition.mockImplementation(async (avatar, { isCurrent }) => {
            if (avatar === 'Bob.png') await pending.promise;
            if (!isCurrent()) return false;
            selections.push(avatar);
            showCharacterEditor();
            return true;
        });

        const first = objectNavigation.navigate({ ...target, id: 'Bob.png' }, { from });
        await Promise.resolve();
        expect(openGroupMemberDefinition).toHaveBeenCalledWith('Bob.png', { isCurrent: expect.any(Function) });
        expect(await objectNavigation.navigate(target, { from })).toEqual({ ok: true });
        pending.resolve();
        expect(await first).toEqual({ ok: false, reason: 'superseded' });
        expect(results).toContainEqual({ avatar: 'Bob.png', result: false });
        expect(selections).toEqual(['Alice.png']);
        expect(selectCharacterById).not.toHaveBeenCalled();
    });

    test('readiness waiting stops when superseded and never restores stale character scroll', async () => {
        jest.useFakeTimers();
        const scroller = document.querySelector('#form_create .sb-editor-sheet__content');
        scroller.scrollTop = 84;
        let current = true;
        openGroupMemberDefinition.mockResolvedValue(true);
        const result = characterEditor.open(target, { restore: { scrollTop: 360 }, isCurrent: () => current });
        await jest.advanceTimersByTimeAsync(100);
        current = false;
        showCharacterEditor();
        await jest.advanceTimersByTimeAsync(50);
        expect(await result).toBe(false);
        expect(scroller.scrollTop).toBe(84);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a superseded group Back does not restore the old list after its open resolves', async () => {
        const pending = deferred();
        await objectNavigation.navigate(target, { from });
        openGroupEditor.mockReturnValueOnce(pending.promise);
        const backwards = objectNavigation.back({ current: target, fallback: jest.fn() });
        await Promise.resolve();
        const { isCurrent } = openGroupEditor.mock.calls[0][1];
        expect(isCurrent()).toBe(true);
        await objectNavigation.navigate(target, { from });
        expect(isCurrent()).toBe(false);
        pending.resolve(true);
        expect(await backwards).toEqual({ ok: false, reason: 'superseded' });
        expect(restoreGroupEditorListState).not.toHaveBeenCalled();
    });

    test('checks currency again after an asynchronous group state restore', async () => {
        const pending = deferred();
        let current = true;
        restoreGroupEditorListState.mockReturnValueOnce(pending.promise);
        const result = groupEditor.open(from, { restore: { scrollTop: 100 }, isCurrent: () => current });
        await Promise.resolve();
        expect(restoreGroupEditorListState).toHaveBeenCalledTimes(1);
        current = false;
        pending.resolve();
        expect(await result).toBe(false);
    });

    test('create then Save captures the saved group id and Back opens that group', async () => {
        let editedGroupId = 'create';
        const origin = jest.fn(() => ({ kind: 'group-editor', id: editedGroupId }));
        confirmActiveEditorLeave.mockImplementationOnce(async () => {
            editedGroupId = 'saved-group';
            groups.push({ id: editedGroupId });
            return true;
        });
        canPeekGroupMember.mockReturnValue(false);
        expect(await objectNavigation.navigate(target, { from: origin })).toEqual({ ok: true });
        expect(origin).toHaveBeenCalledTimes(1);
        const fallback = jest.fn();
        expect(await objectNavigation.back({ current: target, fallback })).toEqual({ ok: true });
        expect(openGroupEditor).toHaveBeenCalledWith('saved-group', { switchChat: false, isCurrent: expect.any(Function) });
        expect(fallback).not.toHaveBeenCalled();
    });

    test('Back presents an unselected group without using the chat-switch transport', async () => {
        canPeekGroupMember.mockReturnValue(false);
        openGroupEditor.mockImplementation(async (id, { switchChat }) => {
            if (switchChat) return openGroupById(id);
            return true;
        });
        await objectNavigation.navigate(target, { from });
        expect(selectCharacterById).toHaveBeenCalledTimes(1);
        expect(await objectNavigation.back({ current: target, fallback: jest.fn() })).toEqual({ ok: true });
        expect(openGroupEditor).toHaveBeenCalledWith('qa-group', { switchChat: false, isCurrent: expect.any(Function) });
        expect(openGroupById).not.toHaveBeenCalled();
    });

    test('warns for missing destinations and reports failed opens as errors', async () => {
        expect(await objectNavigation.navigate({ ...target, id: 'deleted.png' }, { from })).toEqual({ ok: false, reason: 'missing' });
        expect(window.toastr.warning).toHaveBeenCalledWith('lorum ipsum');
        openGroupMemberDefinition.mockResolvedValue(false);
        expect(await objectNavigation.navigate(target, { from })).toEqual({ ok: false, reason: 'failed' });
        expect(window.toastr.error).toHaveBeenCalledWith('lorum ipsum');
    });

    test.each(['data-sb-character-tab', 'data-sb-settings-tab'])('%s clicks clear the origin so Back uses the list fallback', async attribute => {
        await objectNavigation.navigate(target, { from });
        document.querySelector(`[${attribute}]`).click();
        const fallback = jest.fn();
        expect(await objectNavigation.back({ current: target, fallback })).toEqual({ ok: false, reason: 'empty' });
        expect(fallback).toHaveBeenCalledTimes(1);
        expect(openGroupEditor).not.toHaveBeenCalled();
    });

    test('cancelled leave guards keep the group open and do not call either destination', async () => {
        confirmActiveEditorLeave.mockResolvedValue(false);
        expect(await objectNavigation.navigate(target, { from })).toEqual({ ok: false, reason: 'cancelled' });
        expect(openGroupMemberDefinition).not.toHaveBeenCalled();
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(objectNavigation.depth).toBe(0);
    });
});

describe('object navigation notification setter', () => {
    test('replaces the injected handler without replacing destinations or the stack', async () => {
        const original = jest.fn();
        const replacement = jest.fn();
        const navigation = createObjectNavigation({ confirmLeave: async () => true, notify: original });
        navigation.register('character-editor', characterEditor);
        await navigation.navigate(target, { from });
        navigation.setNotify(replacement);
        const missing = { kind: 'missing' };
        expect(await navigation.navigate(missing, { from })).toEqual({ ok: false, reason: 'missing' });
        expect(replacement).toHaveBeenCalledWith('missing', missing);
        expect(original).not.toHaveBeenCalled();
        expect(navigation.depth).toBe(1);
        expect(navigation.canGoBack(target)).toBe(true);
    });

    test('rejects non-functions at the setter boundary', () => {
        const navigation = createObjectNavigation({ confirmLeave: async () => true });
        expect(() => navigation.setNotify(null)).toThrow('setNotify requires a function.');
    });
});
