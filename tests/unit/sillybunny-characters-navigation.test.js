/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const characters = [{ avatar: 'Bob.png' }, { avatar: 'Alice.png' }];
const groups = [{ id: 'qa-group' }];
const groupEditorTargetExists = jest.fn();
const selectCharacterById = jest.fn();
const canPeekGroupMember = jest.fn();
const canRestoreGroupMemberPeek = jest.fn();
const openGroupMemberDefinition = jest.fn();
const openGroupEditor = jest.fn();
const openGroupById = jest.fn();
const captureGroupEditorListState = jest.fn();
const restoreGroupEditorListState = jest.fn();
const confirmActiveEditorLeave = jest.fn();
const mountCharacterList = jest.fn();
const restoreCharacterListState = jest.fn();
const cancelListRestore = jest.fn();
const prepareCharacterListRestore = jest.fn(() => cancelListRestore);
const switchCharacterListView = jest.fn();
let activeListView;
const world_names = ['Book A'];
const power_user = { personas: { 'persona.png': 'Persona' } };
const openWorldInfoEditor = jest.fn();
const captureWorldInfoEditorListState = jest.fn();
const restoreWorldInfoEditorListState = jest.fn();
const openPersonaEditor = jest.fn();
const rememberOpenedEntity = jest.fn();
await jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_names, openWorldInfoEditor,
    getWorldInfoEditorState: () => ({ name: 'Book A' }),
    captureWorldInfoEditorListState, restoreWorldInfoEditorListState,
}));
await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({ power_user }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-persona-editor.js', () => ({ openPersonaEditor }));

await jest.unstable_mockModule('../../public/scripts/sillybunny-character-list.js', () => ({ mountCharacterList, restoreCharacterListState, prepareCharacterListRestore }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-character-list-state.js', () => ({
    getCharacterListView: () => activeListView,
    switchCharacterListView,
}));

await jest.unstable_mockModule('../../public/script.js', () => ({ characters, this_chid: 1, selectCharacterById }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-auto-load.js', () => ({ rememberOpenedEntity }));
await jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
    groups,
    groupEditorTargetExists,
    canPeekGroupMember,
    canRestoreGroupMemberPeek,
    openGroupMemberDefinition,
    openGroupEditor,
    openGroupById,
    captureGroupEditorListState,
    restoreGroupEditorListState,
    selected_group: 'qa-group',
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
const worldInfo = registrations.find(([kind]) => kind === 'world-info')[1];
const personaEditor = registrations.find(([kind]) => kind === 'persona-editor')[1];
const from = { kind: 'group-editor', id: 'qa-group' };
const target = { kind: 'character-editor', id: 'Alice.png', via: 'group-member' };
const currentRoute = { isCurrent: () => true };

beforeEach(() => {
    jest.clearAllMocks();
    objectNavigation.clear();
    characters[0] = { avatar: 'Bob.png' };
    characters[1] = { avatar: 'Alice.png' };
    groups.splice(1);
    groupEditorTargetExists.mockImplementation(id => id === 'create' || groups.some(group => group.id === id));
    confirmActiveEditorLeave.mockResolvedValue(true);
    canPeekGroupMember.mockReturnValue(true);
    canRestoreGroupMemberPeek.mockReturnValue(false);
    openGroupEditor.mockResolvedValue(true);
    openWorldInfoEditor.mockResolvedValue(true);
    openPersonaEditor.mockResolvedValue(true);
    captureWorldInfoEditorListState.mockReturnValue({ name: 'Book A', page: 2, query: 'entry', scrollTop: 88 });
    restoreWorldInfoEditorListState.mockResolvedValue(true);
    captureGroupEditorListState.mockReturnValue({ scrollTop: 240, membersPage: 2, focusedMemberAvatar: 'Alice.png' });
    restoreGroupEditorListState.mockResolvedValue(undefined);
    activeListView = 'characters';
    mountCharacterList.mockResolvedValue({});
    restoreCharacterListState.mockResolvedValue(undefined);
    switchCharacterListView.mockImplementation(async view => { activeListView = view; });
    window.SillyBunnyShell = { openTab: jest.fn(async (_shell, view) => { activeListView = view; return true; }) };
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
        <div id="PersonaManagement"><div class="sb-persona-editor" data-persona-avatar-id="persona.png"><div class="sb-persona-entry-body"></div></div></div>
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
        expect(registrations.map(([kind]) => kind)).toEqual(['character-editor', 'group-editor', 'character-list', 'group-list', 'world-info', 'persona-editor']);
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
    ])('%s list supplies the restore snapshot before shell activation', async (view, kind, destination) => {
        const pending = deferred();
        window.SillyBunnyShell.openTab.mockReturnValueOnce(pending.promise);
        const snapshot = destination.captureState();
        const result = destination.open({ kind }, { restore: snapshot, ...currentRoute });
        expect(mountCharacterList).not.toHaveBeenCalled();
        pending.resolve(true);
        expect(await result).toBe(true);
        expect(window.SillyBunnyShell.openTab).toHaveBeenCalledWith('characters', view);
        expect(mountCharacterList).toHaveBeenCalledTimes(1);
        expect(prepareCharacterListRestore).toHaveBeenCalledWith(view, snapshot, currentRoute.isCurrent);
        expect(prepareCharacterListRestore.mock.invocationCallOrder[0]).toBeLessThan(window.SillyBunnyShell.openTab.mock.invocationCallOrder[0]);
        expect(restoreCharacterListState).not.toHaveBeenCalled();
        expect(cancelListRestore).toHaveBeenCalledTimes(1);
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
        expect(rememberOpenedEntity.mock.calls).toEqual([['group', 'qa-group']]);
    });

    test('a group pencil that never switches the chat records nothing', async () => {
        openGroupEditor.mockResolvedValue(false);
        expect(await groupEditor.open({ kind: 'group-editor', id: 'other-group', via: 'group-list' }, currentRoute)).toBe(false);
        expect(rememberOpenedEntity).not.toHaveBeenCalled();
    });

    test('a group pencil records the switched chat even when its editor never shows', async () => {
        openGroupEditor.mockResolvedValue(false);
        expect(await groupEditor.open({ kind: 'group-editor', id: 'qa-group', via: 'group-list' }, currentRoute)).toBe(false);
        expect(rememberOpenedEntity.mock.calls).toEqual([['group', 'qa-group']]);
    });

    test('delegates group existence so an expired create draft cannot be revisited', () => {
        groupEditorTargetExists.mockReturnValue(false);
        expect(groupEditor.exists('create')).toBe(false);
        expect(groupEditorTargetExists).toHaveBeenCalledWith('create');
    });

    test('peeks an eligible member without switching chats and preserves via through the singleton', async () => {
        expect(await objectNavigation.navigate(target, { from })).toEqual({ ok: true });
        expect(canPeekGroupMember).toHaveBeenCalledWith('Alice.png');
        expect(openGroupMemberDefinition).toHaveBeenCalledWith('Alice.png', { isCurrent: expect.any(Function), restore: false });
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(objectNavigation.canGoBack(target)).toBe(true);
        expect(rememberOpenedEntity).not.toHaveBeenCalled();
    });

    test('switches by current avatar index when a member cannot be peeked', async () => {
        canPeekGroupMember.mockReturnValue(false);
        expect(await characterEditor.open(target, currentRoute)).toBe(true);
        expect(selectCharacterById).toHaveBeenCalledWith(1, { switchMenu: true });
        expect(openGroupMemberDefinition).not.toHaveBeenCalled();
        expect(rememberOpenedEntity.mock.calls).toEqual([['character', 'Alice.png']]);
    });

    test('ordinary navigation switches even when peeking would be possible', async () => {
        expect(await characterEditor.open({ kind: 'character-editor', id: 'Alice.png' }, currentRoute)).toBe(true);
        expect(canPeekGroupMember).not.toHaveBeenCalled();
        expect(selectCharacterById).toHaveBeenCalledWith(1, { switchMenu: true });
        expect(rememberOpenedEntity.mock.calls).toEqual([['character', 'Alice.png']]);
    });

    test('a switched chat stays the Auto-load Last Chat entity when its navigation is superseded', async () => {
        let current = true;
        selectCharacterById.mockImplementation(async () => {
            current = false;
            return true;
        });
        expect(await characterEditor.open({ kind: 'character-editor', id: 'Alice.png' }, { isCurrent: () => current })).toBe(false);
        expect(rememberOpenedEntity.mock.calls).toEqual([['character', 'Alice.png']]);
    });

    test('Back to the selected character outside a group chat does not record it again', async () => {
        expect(await characterEditor.open({ kind: 'character-editor', id: 'Alice.png' }, { restore: { scrollTop: 0 }, ...currentRoute })).toBe(true);
        expect(canRestoreGroupMemberPeek).toHaveBeenCalledWith('Alice.png');
        expect(selectCharacterById).toHaveBeenCalledWith(1, { switchMenu: true });
        expect(openGroupMemberDefinition).not.toHaveBeenCalled();
        expect(rememberOpenedEntity).not.toHaveBeenCalled();
    });

    test.each(['Alice.png', 'Bob.png'])('Back to %s over its group chat peeks again instead of selecting it', async avatar => {
        canRestoreGroupMemberPeek.mockReturnValue(true);
        // The peek sets this_chid to the member; the static mock models that by moving it into this_chid's slot.
        openGroupMemberDefinition.mockImplementation(async id => {
            characters[1] = { avatar: id };
            showCharacterEditor();
            return true;
        });
        expect(await characterEditor.open({ kind: 'character-editor', id: avatar }, { restore: { scrollTop: 0 }, ...currentRoute })).toBe(true);
        expect(canRestoreGroupMemberPeek).toHaveBeenCalledWith(avatar);
        expect(openGroupMemberDefinition).toHaveBeenCalledWith(avatar, { isCurrent: currentRoute.isCurrent, restore: true });
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(window.SillyBunnyShell.openTab).not.toHaveBeenCalled();
        expect(rememberOpenedEntity).not.toHaveBeenCalled();
    });

    test('a refused Back peek does not fall through to selecting the member', async () => {
        canRestoreGroupMemberPeek.mockReturnValue(true);
        openGroupMemberDefinition.mockResolvedValue(false);
        expect(await characterEditor.open({ kind: 'character-editor', id: 'Alice.png' }, { restore: {}, ...currentRoute })).toBe(false);
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(window.SillyBunnyShell.openTab).not.toHaveBeenCalled();
    });

    test('Back from a peeked member\'s related group editor peeks the member again and keeps the group chat', async () => {
        canRestoreGroupMemberPeek.mockReturnValue(true);
        const member = { kind: 'character-editor', id: 'Alice.png' };
        expect(await objectNavigation.navigate(target, { from })).toEqual({ ok: true });
        // The character editor pushes its origin without via, as its Related rows and World Info button do.
        expect(await objectNavigation.navigate(from, { from: member })).toEqual({ ok: true });
        const fallback = jest.fn();
        expect(await objectNavigation.back({ current: from, fallback })).toEqual({ ok: true });
        expect(openGroupMemberDefinition.mock.calls).toEqual([
            ['Alice.png', { isCurrent: expect.any(Function), restore: false }],
            ['Alice.png', { isCurrent: expect.any(Function), restore: true }],
        ]);
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(rememberOpenedEntity).not.toHaveBeenCalled();
        expect(await objectNavigation.back({ current: member, fallback })).toEqual({ ok: true });
        expect(openGroupEditor.mock.calls.map(([id, { switchChat }]) => [id, switchChat])).toEqual([['qa-group', false], ['qa-group', false]]);
        expect(fallback).not.toHaveBeenCalled();
        expect(selectCharacterById).not.toHaveBeenCalled();
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
        expect(rememberOpenedEntity).not.toHaveBeenCalled();
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
        canRestoreGroupMemberPeek.mockReturnValue(true);
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
        expect(rememberOpenedEntity).not.toHaveBeenCalled();
    });

    test('opens create drafts and does not restore state after a refused group open', async () => {
        expect(await groupEditor.open({ kind: 'group-editor', id: 'create' }, currentRoute)).toBe(true);
        expect(openGroupEditor).toHaveBeenCalledWith('create', { switchChat: false, isCurrent: expect.any(Function) });
        expect(restoreGroupEditorListState).not.toHaveBeenCalled();
        openGroupEditor.mockResolvedValue(false);
        expect(await groupEditor.open(from, { ...currentRoute, restore: { scrollTop: 100 } })).toBe(false);
        expect(restoreGroupEditorListState).not.toHaveBeenCalled();
        expect(rememberOpenedEntity).not.toHaveBeenCalled();
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
        expect(openGroupMemberDefinition).toHaveBeenCalledWith('Bob.png', { isCurrent: expect.any(Function), restore: false });
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
        canRestoreGroupMemberPeek.mockReturnValue(true);
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
        expect(rememberOpenedEntity.mock.calls).toEqual([['character', 'Alice.png']]);
    });

    test('warns for missing destinations and reports failed opens as errors', async () => {
        expect(await objectNavigation.navigate({ ...target, id: 'deleted.png' }, { from })).toEqual({ ok: false, reason: 'missing' });
        expect(window.toastr.warning).toHaveBeenCalledWith('This item is no longer available.');
        openGroupMemberDefinition.mockResolvedValue(false);
        expect(await objectNavigation.navigate(target, { from })).toEqual({ ok: false, reason: 'failed' });
        expect(window.toastr.error).toHaveBeenCalledWith('This item could not be opened.');
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

describe('World Info and Persona destinations', () => {
    test('Back to an inactive character presents its list row without switching chat', async () => {
        characters[0].name = 'Bob';
        const list = document.createElement('div');
        list.className = 'sb-character-list';
        const row = document.createElement('div');
        row.dataset.sbListKey = 'character:Bob.png';
        row.tabIndex = 0;
        row.scrollIntoView = jest.fn();
        list.append(row);
        document.body.append(list);
        expect(await characterEditor.open({ kind: 'character-editor', id: 'Bob.png' }, { restore: { scrollTop: 12 }, ...currentRoute })).toBe(true);
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(openGroupMemberDefinition).not.toHaveBeenCalled();
        expect(window.SillyBunnyShell.openTab).toHaveBeenCalledWith('characters', 'characters');
        expect(restoreCharacterListState).toHaveBeenLastCalledWith({ query: 'Bob', page: 1, focusKey: 'character:Bob.png' }, currentRoute.isCurrent);
        expect(row).toBe(document.activeElement);
        expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    });

    test('inactive-character Back clears hiding filters and finds the stable avatar beyond duplicate names on page one', async () => {
        characters[0].name = characters[1].name = 'Duplicate';
        document.body.insertAdjacentHTML('beforeend', '<div id="rm_characters_block"><button class="clearAllFilters"></button></div><div class="sb-character-list"><button class="sb-list-pagination__next"></button></div>');
        const clear = jest.fn();
        document.querySelector('.clearAllFilters').addEventListener('click', clear);
        restoreCharacterListState.mockImplementation(async snapshot => {
            if (snapshot?.page !== 2) return;
            const row = document.createElement('div');
            row.dataset.sbListKey = 'character:Bob.png';
            row.tabIndex = 0;
            document.querySelector('.sb-character-list').append(row);
        });
        expect(await characterEditor.open({ kind: 'character-editor', id: 'Bob.png' }, { restore: {}, ...currentRoute })).toBe(true);
        expect(clear).toHaveBeenCalledTimes(1);
        expect(restoreCharacterListState).toHaveBeenLastCalledWith({ query: 'Duplicate', page: 2, focusKey: 'character:Bob.png' }, currentRoute.isCurrent);
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(document.activeElement.dataset.sbListKey).toBe('character:Bob.png');
    });

    test('existence uses book names and own persona avatar keys, not display names', () => {
        expect(worldInfo.exists('Book A')).toBe(true);
        expect(worldInfo.exists('missing')).toBe(false);
        expect(personaEditor.exists('persona.png')).toBe(true);
        expect(personaEditor.exists('Persona')).toBe(false);
        expect(personaEditor.exists('toString')).toBe(false);
        expect(worldInfo.current()).toEqual({ kind: 'world-info', id: 'Book A' });
        expect(personaEditor.current()).toEqual({ kind: 'persona-editor', id: 'persona.png' });
    });

    test('WI awaits loaded book readiness before restoring the captured list state', async () => {
        const pending = deferred();
        const snapshot = worldInfo.captureState();
        openWorldInfoEditor.mockReturnValueOnce(pending.promise);
        const opened = worldInfo.open({ kind: 'world-info', id: 'Book A' }, { restore: snapshot, ...currentRoute });
        expect(restoreWorldInfoEditorListState).not.toHaveBeenCalled();
        pending.resolve(true);
        expect(await opened).toBe(true);
        expect(openWorldInfoEditor).toHaveBeenCalledWith('Book A', currentRoute);
        expect(restoreWorldInfoEditorListState).toHaveBeenCalledWith(snapshot, currentRoute.isCurrent);
    });

    test('Persona awaits selection and section readiness before restoring detail scroll', async () => {
        const scroller = document.querySelector('.sb-persona-entry-body');
        scroller.scrollTop = 72;
        expect(personaEditor.captureState()).toEqual({ scrollTop: 72 });
        const pending = deferred();
        openPersonaEditor.mockReturnValueOnce(pending.promise);
        const opened = personaEditor.open({ kind: 'persona-editor', id: 'persona.png', section: 'connections' }, { restore: { scrollTop: 240 }, ...currentRoute });
        await Promise.resolve();
        expect(scroller.scrollTop).toBe(72);
        pending.resolve(true);
        expect(await opened).toBe(true);
        expect(openPersonaEditor).toHaveBeenCalledWith({ avatarId: 'persona.png', section: 'connections', isCurrent: currentRoute.isCurrent });
        expect(scroller.scrollTop).toBe(240);
    });

    test.each([worldInfo, personaEditor])('a stale or refused destination never restores presentation', async destination => {
        expect(await destination.open({}, { isCurrent: () => false })).toBe(false);
        expect(openWorldInfoEditor).not.toHaveBeenCalled();
        expect(openPersonaEditor).not.toHaveBeenCalled();
        openWorldInfoEditor.mockResolvedValue(false);
        openPersonaEditor.mockResolvedValue(false);
        expect(await destination.open({ id: 'Book A' }, { ...currentRoute, restore: { scrollTop: 99 } })).toBe(false);
        expect(restoreWorldInfoEditorListState).not.toHaveBeenCalled();
        expect(document.querySelector('.sb-persona-entry-body').scrollTop).toBe(0);
    });

    test.each([worldInfo, personaEditor])('supersession after readiness does not restore stale presentation', async destination => {
        const pending = deferred();
        let current = true;
        openWorldInfoEditor.mockReturnValueOnce(pending.promise);
        openPersonaEditor.mockReturnValueOnce(pending.promise);
        const opened = destination.open({ id: 'Book A' }, { isCurrent: () => current, restore: { scrollTop: 99 } });
        await Promise.resolve();
        current = false;
        pending.resolve(true);
        expect(await opened).toBe(false);
        expect(restoreWorldInfoEditorListState).not.toHaveBeenCalled();
        expect(document.querySelector('.sb-persona-entry-body').scrollTop).toBe(0);
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
