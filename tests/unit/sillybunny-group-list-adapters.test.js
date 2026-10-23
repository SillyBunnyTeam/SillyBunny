/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

await import('../../public/lib/jquery-3.5.1.min.js');
const $ = window.jQuery;
const { createEntityRow, entityKey, limitTagChips } = await import('../../public/scripts/sillybunny-editor/entity-row.js');
const { bindListKeyboard, reconcileRows } = await import('../../public/scripts/sillybunny-editor/list-rows.js');
const { loadStylesheetAsync } = await import('../../public/scripts/dynamic-styles.js');
const source = readFileSync(new URL('../../public/scripts/group-chats.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.map(node => node.declaration ?? node);

function loadFunctions(names, overrides = {}) {
    const context = vm.createContext({ document, Element, requestAnimationFrame: callback => callback(), ...overrides });
    const functions = names.map(name => {
        const declaration = declarations.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
        if (!declaration) throw new Error(`Missing group function: ${name}`);
        return source.slice(declaration.start, declaration.end);
    });
    vm.runInContext(`${functions.join('\n')}\nthis.api = { ${names.join(', ')} };`, context);
    return context;
}

function rowCollection(rows) {
    return {
        length: rows.length,
        filter(predicate) { return rowCollection(rows.filter(row => predicate.call(row))); },
        first() { return { 0: rows[0], length: rows.length ? 1 : 0 }; },
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
    document.head.querySelectorAll('link').forEach(link => link.remove());
});

async function settle() {
    for (let index = 0; index < 30; index++) await Promise.resolve();
}

describe('group rows on the shared factory', () => {
    function setup() {
        const group = { members: ['alice.png'], disabled_members: ['alice.png'] };
        return loadFunctions([
            'getGroupCharacterBlock', 'updateGroupCharacterBlock', 'getGroupCharacterTags',
            'isGroupMember', 'isGroupMemberDisabled', 'reconcileGroupCharacterRows',
            'printGroupMembers', 'printGroupCandidates', 'getMemberRowsContainers',
        ], {
            $,
            createEntityRow,
            entityKey,
            limitTagChips: jest.fn(limitTagChips),
            reconcileRows,
            groupRowCaches: new WeakMap(),
            groupRowViews: new WeakMap(),
            getGroupListPagination: () => ({ setTotal: () => {}, slice: entries => entries }),
            syncGroupMembersFilteredState: jest.fn(),
            reportGroupList: jest.fn(),
            getEditedGroup: () => group,
            editorDraft: group,
            openGroupId: 'group-1',
            characters: [
                { avatar: 'alice.png', name: 'Alice', fav: true, data: { character_version: 'v2' } },
                { avatar: 'bob.png', name: 'Bob' },
            ],
            getThumbnailUrl: (type, avatar) => `/thumb/${avatar}`,
            getThumbnailUrlForViewport: (type, avatar) => `/thumb/${avatar}`,
            getGroupMemberModel: () => 'test-model',
            power_user: {},
            groupChatQueueOrder: new Map([['alice.png', 2]]),
            getTagsList: () => Array.from({ length: 5 }, (_, index) => ({ id: `tag-${index}`, name: `Tag ${index}` })),
            printTagList: (container, { tags }) => {
                container.empty();
                for (const tag of tags.slice(0, 50)) container.append($('<span class="tag"></span>').text(tag.name));
            },
            t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
        });
    }

    test('preserves member hooks, lazy avatars, state, tags and detached action transports', () => {
        const context = setup();
        const member = context.api.getGroupCharacterBlock(context.characters[0], { draftIndex: 4, grip: true });
        const row = member[0];
        expect(member.jquery).toBeDefined();
        expect(row.classList.contains('ds-entity-row')).toBe(true);
        expect(row.dataset).toMatchObject({ avatar: 'alice.png', chid: '0', sbMemberIndex: '4', sbListKey: 'character:alice.png' });
        expect(member.data('id')).toBe('alice.png');
        expect(row.tabIndex).toBe(0);
        expect(row.querySelector('.ds-entity-row__chevron')).not.toBeNull();
        expect(row.querySelector('.avatar img').getAttribute('loading')).toBe('lazy');
        expect(row.querySelector('.avatar img').getAttribute('decoding')).toBe('async');
        expect(row.querySelector('.avatar img').alt).toBe('');
        expect(row.querySelector('.group_member_name .ch_name').textContent).toBe('Alice');
        expect(row.querySelector('.ch_additional_info.character_version').textContent).toBe('v2');
        expect(row.querySelector('.sb-group-member-model').textContent).toBe('Model: test-model');
        expect(row.querySelector('.queue_position').textContent).toBe('2');
        expect(row.querySelector('.ch_fav').value).toBe('true');
        expect(row.matches('.is_fav.disabled.is_queued')).toBe(true);
        expect(row.querySelector('.sb-group-member-grip')).not.toBeNull();
        expect(row.querySelector('.group_member_icon').children).toHaveLength(2);
        expect(row.querySelector(':scope > .sb-group-member-legacy[hidden] [data-action="view"]')).not.toBeNull();
        expect(row.querySelector('.group_member_icon .sb-group-member-legacy')).toBeNull();
        expect(row.querySelectorAll('.tags.tags_inline .tag:not([hidden]):not(.sb-tag-overflow)')).toHaveLength(3);
        expect(row.querySelector('.sb-tag-overflow').textContent).toBe('+2');
    });

    test('candidates have one Add suffix control, no navigation chevron and no empty subtitle', () => {
        const context = setup();
        const row = context.api.getGroupCharacterBlock(context.characters[1])[0];
        expect(row.matches('.group_member.sb-group-candidate')).toBe(true);
        expect(row.tabIndex).toBe(0);
        expect(row.querySelector('.ds-entity-row__chevron')).toBeNull();
        expect(row.querySelector('.ds-entity-row__subtitle').style.display).toBe('none');
        expect(row.querySelector('.group_member_icon').children).toHaveLength(1);
        expect(row.querySelector('.group_member_icon [data-action="add"]')).not.toBeNull();
    });

    function listSetup() {
        document.body.innerHTML = '<div id="rm_group_members" class="rm_group_members"></div><div id="rm_group_add_members"></div>';
        const context = setup();
        context.getGroupCharacters = ({ onlyMembers = false } = {}) => context.characters
            .filter(character => context.editorDraft.members.includes(character.avatar) === onlyMembers)
            .map(item => ({ item }));
        return context;
    }

    test('unchanged member and candidate renders retain rows, controls and tag nodes', () => {
        const context = listSetup();
        context.api.printGroupMembers();
        context.api.printGroupCandidates();
        const member = document.querySelector('#rm_group_members .group_member');
        const candidate = document.querySelector('#rm_group_add_members .group_member');
        const control = member.querySelector('input[type="checkbox"]');
        const tag = member.querySelector('.tag');
        control.focus();
        context.api.printGroupMembers();
        context.api.printGroupCandidates();
        expect(document.querySelector('#rm_group_members .group_member')).toBe(member);
        expect(document.querySelector('#rm_group_add_members .group_member')).toBe(candidate);
        expect(member.querySelector('input[type="checkbox"]')).toBe(control);
        expect(member.querySelector('.tag')).toBe(tag);
        expect(document.activeElement).toBe(control);
    });

    test('changed member presentation updates in place through the factory', () => {
        const context = listSetup();
        context.api.printGroupMembers();
        const row = document.querySelector('#rm_group_members .group_member');
        const control = row.querySelector('.sb-group-member-switch');
        const image = row.querySelector('img');
        const character = context.characters[0];
        character.name = 'Alicia';
        character.fav = false;
        character.data.character_version = 'v3';
        context.editorDraft.disabled_members = [];
        context.editorDraft.members.unshift('missing.png');
        context.characters.reverse();
        context.getGroupMemberModel = () => 'new-model';
        context.getThumbnailUrlForViewport = () => '/thumb/new-revision';
        context.groupChatQueueOrder.set(character.avatar, 1);
        context.getTagsList = () => [{ id: 'new-tag', name: 'New tag' }];
        context.api.printGroupMembers();
        expect(document.querySelector('#rm_group_members .group_member')).toBe(row);
        expect(row.querySelector('.ch_name').textContent).toBe('Alicia');
        expect(row.getAttribute('aria-label')).toBe('Alicia');
        expect(row.querySelector('.ch_additional_info').textContent).toBe('v3');
        expect(row.querySelector('.sb-group-member-model').textContent).toBe('Model: new-model');
        expect(row.querySelector('img')).toBe(image);
        expect(image.getAttribute('src')).toBe('/thumb/new-revision');
        expect(row.dataset).toMatchObject({ chid: '1', sbMemberIndex: '1' });
        expect(row.matches('.is_fav, .disabled, .is_queued')).toBe(false);
        expect(row.classList.contains('is_active')).toBe(true);
        expect(row.querySelector('.ch_fav').value).toBe('false');
        expect(row.querySelector('.queue_position').textContent).toBe('1');
        expect(row.querySelector('.sb-group-member-switch')).toBe(control);
        expect(control.checked).toBe(true);
        expect(control.getAttribute('aria-label')).toBe('Replies from Alicia');
        expect(control.dataset.action).toBe('disable');
        expect(row.querySelector('.tag').textContent).toBe('New tag');
    });

    test('changed candidates update in place and removed keys leave the cache', () => {
        const context = listSetup();
        context.api.printGroupCandidates();
        const row = document.querySelector('#rm_group_add_members .group_member');
        context.characters[1].name = 'Bobby';
        context.characters[1].data = { character_version: 'candidate-version' };
        context.api.printGroupCandidates();
        expect(document.querySelector('#rm_group_add_members .group_member')).toBe(row);
        expect(row.querySelector('.ch_name').textContent).toBe('Bobby');
        expect(row.querySelector('.ch_additional_info').textContent).toBe('candidate-version');
        context.editorDraft.members.push('bob.png');
        context.api.printGroupCandidates();
        expect(row.isConnected).toBe(false);
        expect(context.groupRowCaches.get(document.getElementById('rm_group_add_members')).size).toBe(0);
    });

    test('popouts mirror current keyed rows as HTML-only clones with working transports', () => {
        const context = listSetup();
        const popout = document.createElement('div');
        popout.className = 'rm_group_members';
        document.body.append(popout);
        context.api.printGroupMembers();
        const main = document.querySelector('#rm_group_members .group_member');
        const clone = popout.firstElementChild;
        expect(clone).not.toBe(main);
        expect($(clone).data('id')).toBeUndefined();
        expect(clone.dataset.avatar).toBe('alice.png');
        context.editorDraft.disabled_members = [];
        context.api.printGroupMembers();
        expect(document.querySelector('#rm_group_members .group_member')).toBe(main);
        expect(popout.firstElementChild.querySelector('.sb-group-member-switch').checked).toBe(true);
        expect(popout.querySelector('.sb-group-member-legacy [data-action="view"]')).not.toBeNull();
    });

    test('passes all displayable tag names beyond upstream’s 50-chip limit', () => {
        const context = setup();
        const tags = Array.from({ length: 60 }, (_, index) => ({ id: `tag-${index}`, name: `Tag ${index}` }));
        context.getTagsList = jest.fn(() => [...tags, { id: 'hidden', name: 'Hidden', is_hidden_on_character_card: true }]);
        const row = context.api.getGroupCharacterBlock(context.characters[0])[0];
        expect(context.getTagsList).toHaveBeenCalledWith('alice.png');
        expect(row.querySelectorAll('.tag:not(.sb-tag-overflow)')).toHaveLength(50);
        expect(context.limitTagChips).toHaveBeenCalledWith(row.querySelector('.ds-entity-row__tags'), { allNames: tags.map(tag => tag.name) });
    });
});

describe('group row keyboard and pointer bindings', () => {
    test('member rows navigate with via; nested tags, grips and controls do not', async () => {
        document.body.innerHTML = '<div id="rm_group_members"><div class="group_member" data-avatar="alice.png" tabindex="0"><span class="ch_name">Alice</span><span class="tag">Tag</span><div class="sb-group-member-grip"></div><label><input type="checkbox"></label><button></button></div><div class="group_member" tabindex="0"></div></div>';
        const navigate = jest.fn(async () => ({ ok: true }));
        const context = loadFunctions(['bindGroupListKeyboard', 'runGroupEditorAction', 'reportGroupEditorError'], {
            bindListKeyboard,
            objectNavigation: { navigate },
            openGroupId: 'group-1',
        });
        const list = document.getElementById('rm_group_members');
        context.api.bindGroupListKeyboard(list, true);
        const row = list.querySelector('.group_member');
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement).toBe(list.lastElementChild);
        list.lastElementChild.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(document.activeElement).toBe(row);
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        row.querySelector('.ch_name').click();
        await settle();
        expect(navigate).toHaveBeenCalledTimes(3);
        expect(navigate).toHaveBeenCalledWith({ kind: 'character-editor', id: 'alice.png', via: 'group-member' }, {
            from: expect.any(Function),
        });
        const origin = navigate.mock.calls[0][1].from;
        expect(origin()).toEqual({ kind: 'group-editor', id: 'group-1' });
        context.openGroupId = null;
        expect(origin()).toEqual({ kind: 'group-editor', id: 'create' });
        context.openGroupId = 'newly-saved-group';
        expect(origin()).toEqual({ kind: 'group-editor', id: 'newly-saved-group' });
        for (const nested of row.querySelectorAll('.tag, .sb-group-member-grip, input, button, label')) {
            nested.click();
            nested.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        expect(navigate).toHaveBeenCalledTimes(3);
    });

    test('candidate background, static tags and Enter add, but the Add control is left to its transport', async () => {
        document.body.innerHTML = '<div id="rm_group_add_members"><div class="group_member" data-avatar="alice.png" tabindex="0"><span class="ch_name">Alice</span><span class="tag" role="button">Tag</span><button class="right_menu_button" data-action="add"></button></div></div>';
        const runGroupMemberAction = jest.fn(async () => {});
        const context = loadFunctions(['bindGroupListKeyboard', 'isGroupCandidateRowClick', 'runGroupEditorAction', 'reportGroupEditorError'], {
            $,
            bindListKeyboard,
            runGroupMemberAction,
        });
        const list = document.getElementById('rm_group_add_members');
        context.api.bindGroupListKeyboard(list, false);
        const row = list.firstElementChild;
        row.querySelector('.ch_name').click();
        row.querySelector('.tag').click();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        row.querySelector('button').click();
        await settle();
        expect(runGroupMemberAction).toHaveBeenCalledTimes(3);
        expect(runGroupMemberAction.mock.calls.every(([action, member]) => action === 'add' && member[0] === row)).toBe(true);
    });

    test.each(['click', 'Enter'])('candidate %s catches real hydration rejection and reconciles the mutated draft', async activation => {
        document.body.innerHTML = '<div id="rm_group_add_members"><div class="group_member" data-avatar="bob.png" tabindex="0"></div></div>';
        const failure = new Error('Offline');
        const context = loadFunctions([
            'bindGroupListKeyboard', 'isGroupCandidateRowClick', 'runGroupEditorAction', 'reportGroupEditorError',
            'runGroupMemberAction', 'applyGroupMemberAction', 'modifyGroupMember', 'refreshGroupMemberLists',
        ], {
            $, bindListKeyboard, editorDraft: { members: [] }, openGroupId: 'group-1',
            captureGroupMemberFocus: () => ({ draft: context.editorDraft, groupId: 'group-1' }),
            restoreGroupMemberFocus: jest.fn(),
            _applyMemberActionToEditor: (_action, id) => { context.editorDraft.members.push(id); return { owned: true, changed: true }; },
            unshallowGroupMembers: jest.fn().mockRejectedValue(failure),
            printGroupCandidates: jest.fn(), printGroupMembers: jest.fn(), printTagFilters: jest.fn(),
            tag_filter_type: {}, getGroupCharacters: () => context.editorDraft.members,
            eventSource: { emit: jest.fn(async () => {}) }, event_types: { GROUP_UPDATED: 'updated' },
            console: { error: jest.fn() }, toastr: { error: jest.fn() },
        });
        context.api.bindGroupListKeyboard(document.getElementById('rm_group_add_members'), false);
        const row = document.querySelector('.group_member');
        if (activation === 'click') row.click();
        else row.dispatchEvent(new KeyboardEvent('keydown', { key: activation, bubbles: true }));
        await settle();
        expect(context.toastr.error).toHaveBeenCalledWith('Offline');
        expect(context.console.error).toHaveBeenCalledWith(failure);
        expect(context.editorDraft.members).toEqual(['bob.png']);
        expect(context.printGroupCandidates).toHaveBeenCalled();
        expect(context.printGroupMembers).toHaveBeenCalled();
        expect(context.restoreGroupMemberFocus).toHaveBeenCalled();
        expect(context.eventSource.emit).toHaveBeenCalledWith('updated');
        await expect(context.api.runGroupMemberAction('add', $(row))).rejects.toBe(failure);
    });

    test('member menu actions and model override catch asynchronous failures', async () => {
        document.body.innerHTML = '<div class="group_member" data-avatar="alice.png"><span class="ch_name">Alice</span><button></button></div>';
        const failure = new Error('Offline');
        const context = loadFunctions(['onGroupMemberMenuClick', 'runGroupEditorAction', 'reportGroupEditorError'], {
            $, openGroupId: 'group-1', getEditedGroup: () => ({ members: ['alice.png', 'bob.png'] }),
            openActionMenu: jest.fn(), runGroupMemberAction: jest.fn().mockRejectedValue(failure),
            editGroupMemberModel: jest.fn().mockRejectedValue(failure),
            console: { error: jest.fn() }, toastr: { error: jest.fn() },
            t: strings => strings.join(''),
        });
        context.api.onGroupMemberMenuClick.call(document.querySelector('button'), { preventDefault() {}, stopPropagation() {} });
        const items = context.openActionMenu.mock.calls[0][0].sections.flatMap(section => section.items);
        for (const item of items.filter(item => !item.disabled)) await item.onSelect();
        expect(context.toastr.error).toHaveBeenCalledTimes(4);
    });
});

describe('pagination-independent group member actions', () => {
    function setup(rendered = false) {
        document.body.innerHTML = `<div id="rm_group_members">${rendered ? '<div class="group_member" data-chid="1" data-avatar="bob.png"></div>' : ''}</div>`;
        const detached = { detached: true };
        const context = loadFunctions(['runGroupMemberActionByChid'], {
            characters: [{ avatar: 'alice.png' }, { avatar: 'bob.png' }],
            $: selector => rowCollection([...document.querySelectorAll(selector)]),
            getGroupCharacterBlock: jest.fn(() => detached),
            runGroupMemberAction: jest.fn(async () => {}),
        });
        return { context, detached };
    }

    test('uses the rendered member without rebuilding it', async () => {
        const { context } = setup(true);
        await context.api.runGroupMemberActionByChid(1, 'disable');
        expect(context.getGroupCharacterBlock).not.toHaveBeenCalled();
        expect(context.runGroupMemberAction).toHaveBeenCalledWith('disable', expect.objectContaining({ 0: document.querySelector('.group_member') }));
    });

    test.each(['disable', 'enable', 'up', 'down', 'view', 'remove'])('uses a detached row for off-page %s without changing the page', async action => {
        const { context, detached } = setup();
        const goTo = jest.fn();
        context.membersPagination = { page: 2, goTo };
        await context.api.runGroupMemberActionByChid(1, action);
        expect(context.getGroupCharacterBlock).toHaveBeenCalledWith(context.characters[1]);
        expect(context.runGroupMemberAction).toHaveBeenCalledWith(action, detached);
        expect(context.membersPagination.page).toBe(2);
        expect(goTo).not.toHaveBeenCalled();
    });

    test.each([-1, 3, 0.5, 'missing'])('ignores missing character index %s', async chid => {
        const { context } = setup();
        await context.api.runGroupMemberActionByChid(chid, 'disable');
        expect(context.runGroupMemberAction).not.toHaveBeenCalled();
    });
});

describe('group member peek boundary', () => {
    function setup(overrides = {}) {
        return loadFunctions(['canPeekGroupMember', 'canRestoreGroupMemberPeek', 'openGroupMemberDefinition', 'openCharacterDefinition'], {
            selected_group: 'group-1',
            openGroupId: 'group-1',
            getEditedGroup: () => ({ members: ['alice.png'] }),
            characters: [{ avatar: 'alice.png' }],
            this_chid: undefined,
            is_group_generating: false,
            is_send_press: false,
            getGroupCharacterBlock: jest.fn(() => $('<div data-chid="0"></div>')),
            unshallowCharacter: jest.fn(async () => {}),
            setCharacterId: jest.fn(),
            select_selected_character: jest.fn(),
            RA_CountCharTokens: jest.fn(),
            applyTagsOnCharacterSelect: jest.fn(),
            ...overrides,
        });
    }

    test('peeks only an edited member of the selected chat group', async () => {
        const context = setup();
        expect(context.api.canPeekGroupMember('alice.png')).toBe(true);
        expect(context.api.canPeekGroupMember('bob.png')).toBe(false);
        await expect(context.api.openGroupMemberDefinition('alice.png')).resolves.toBe(true);
        expect(context.unshallowCharacter).toHaveBeenCalledWith('0');
        expect(context.setCharacterId).toHaveBeenCalledWith('0');
        expect(context.select_selected_character).toHaveBeenCalledWith('0');
    });

    test.each([
        { selected_group: null },
        { openGroupId: 'other-group' },
        { characters: [] },
        { is_group_generating: true },
        { is_send_press: true },
    ])('refuses unsafe or unavailable peeks: %p', async overrides => {
        const context = setup(overrides);
        await expect(context.api.openGroupMemberDefinition('alice.png')).resolves.toBe(false);
        expect(context.setCharacterId).not.toHaveBeenCalled();
        expect(context.unshallowCharacter).not.toHaveBeenCalled();
    });

    test('Back peeks the member already peeked over the selected chat group after another group editor opened', async () => {
        const context = setup({ openGroupId: 'other-group', this_chid: '0' });
        expect(context.api.canPeekGroupMember('alice.png')).toBe(false);
        expect(context.api.canRestoreGroupMemberPeek('alice.png')).toBe(true);
        expect(context.api.canRestoreGroupMemberPeek('bob.png')).toBe(false);
        await expect(context.api.openGroupMemberDefinition('alice.png')).resolves.toBe(false);
        expect(context.setCharacterId).not.toHaveBeenCalled();
        await expect(context.api.openGroupMemberDefinition('alice.png', { restore: true })).resolves.toBe(true);
        expect(context.setCharacterId).toHaveBeenCalledWith('0');
        expect(context.select_selected_character).toHaveBeenCalledWith('0');
    });

    test('Back peeks an edited member again after a group reply cleared the peeked character', () => {
        expect(setup().api.canRestoreGroupMemberPeek('alice.png')).toBe(true);
    });

    test.each([
        { selected_group: null, this_chid: '0' },
        { openGroupId: 'other-group' },
        { is_group_generating: true, this_chid: '0' },
        { is_send_press: true, this_chid: '0' },
    ])('Back refuses peeks outside a group chat, of members neither peekable nor peeked, or while busy: %p', async overrides => {
        const context = setup(overrides);
        await expect(context.api.openGroupMemberDefinition('alice.png', { restore: true })).resolves.toBe(false);
        expect(context.setCharacterId).not.toHaveBeenCalled();
        expect(context.unshallowCharacter).not.toHaveBeenCalled();
    });

    test('a superseded hydration cannot change selection, tokens or tags', async () => {
        let finishHydration;
        const hydration = new Promise(resolve => { finishHydration = resolve; });
        const context = setup({ unshallowCharacter: jest.fn(() => hydration) });
        let current = true;
        const opened = context.api.openGroupMemberDefinition('alice.png', { isCurrent: () => current });
        expect(context.unshallowCharacter).toHaveBeenCalledTimes(1);
        current = false;
        finishHydration();
        await expect(opened).resolves.toBe(false);
        expect(context.setCharacterId).not.toHaveBeenCalled();
        expect(context.select_selected_character).not.toHaveBeenCalled();
        expect(context.RA_CountCharTokens).not.toHaveBeenCalled();
        expect(context.applyTagsOnCharacterSelect).not.toHaveBeenCalled();
    });

    test('refuses a stale route before hydrating or constructing a row', async () => {
        const context = setup();
        await expect(context.api.openGroupMemberDefinition('alice.png', { isCurrent: () => false })).resolves.toBe(false);
        expect(context.unshallowCharacter).not.toHaveBeenCalled();
        expect(context.getGroupCharacterBlock).not.toHaveBeenCalled();
    });
});

describe('group list Back snapshots', () => {
    test('captures the sheet scroll, current page and focused avatar', () => {
        document.body.innerHTML = '<div id="sb_group_editor_content"></div><div id="rm_group_members"><div class="group_member" data-avatar="alice.png" tabindex="0"></div></div>';
        document.getElementById('sb_group_editor_content').scrollTop = 180;
        document.querySelector('.group_member').focus();
        const context = loadFunctions(['captureGroupEditorListState'], { membersPagination: { page: 3 } });
        expect(context.api.captureGroupEditorListState()).toEqual({ scrollTop: 180, membersPage: 3, focusedMemberAvatar: 'alice.png' });
    });

    test('restores page before scroll and focuses the replacement row without scrolling it', async () => {
        document.body.innerHTML = '<div id="sb_group_editor_content"></div><div id="rm_group_members"></div>';
        const scroller = document.getElementById('sb_group_editor_content');
        const goTo = jest.fn(() => {
            expect(scroller.scrollTop).toBe(0);
            document.getElementById('rm_group_members').innerHTML = '<div class="group_member" data-avatar="alice.png" tabindex="0"></div>';
        });
        const context = loadFunctions(['restoreGroupEditorListState'], { getGroupListPagination: () => ({ goTo }), editorDraft: {}, openGroupId: 'group-1' });
        await context.api.restoreGroupEditorListState({ scrollTop: 180, membersPage: 3, focusedMemberAvatar: 'alice.png' });
        expect(goTo).toHaveBeenCalledWith(3);
        expect(scroller.scrollTop).toBe(180);
        expect(document.activeElement).toBe(document.querySelector('.group_member'));
    });

    test('waits for pagination and reveal layout before restoring scroll and focus', async () => {
        document.body.innerHTML = '<div id="sb_group_editor_content"></div><div id="rm_group_members"></div>';
        const frames = [];
        let finishPage;
        const pageReady = new Promise(resolve => { finishPage = resolve; });
        const context = loadFunctions(['restoreGroupEditorListState'], {
            getGroupListPagination: () => ({ goTo: () => pageReady }),
            requestAnimationFrame: callback => frames.push(callback),
            editorDraft: {},
            openGroupId: 'group-1',
        });
        const restored = context.api.restoreGroupEditorListState({ scrollTop: 180, membersPage: 3, focusedMemberAvatar: 'alice.png' });
        expect(document.getElementById('sb_group_editor_content').scrollTop).toBe(0);
        document.getElementById('rm_group_members').innerHTML = '<div class="group_member" data-avatar="alice.png" tabindex="0"></div>';
        finishPage();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(frames).toHaveLength(1);
        frames.shift()();
        frames.shift()();
        await restored;
        expect(document.getElementById('sb_group_editor_content').scrollTop).toBe(180);
        expect(document.activeElement.dataset.avatar).toBe('alice.png');
    });

    test('does not apply a delayed Back snapshot to a newer editor draft', async () => {
        document.body.innerHTML = '<div id="sb_group_editor_content"></div><div id="rm_group_members"><div class="group_member" data-avatar="alice.png" tabindex="0"></div></div>';
        const context = loadFunctions(['restoreGroupEditorListState'], {
            getGroupListPagination: () => ({ goTo: async () => {} }),
            editorDraft: {},
            openGroupId: 'group-1',
        });
        const restored = context.api.restoreGroupEditorListState({ scrollTop: 180, membersPage: 3, focusedMemberAvatar: 'alice.png' });
        context.editorDraft = {};
        await restored;
        expect(document.getElementById('sb_group_editor_content').scrollTop).toBe(0);
        expect(document.activeElement).toBe(document.body);
    });
});

describe('group-editor opening boundary', () => {
    function setup(overrides = {}) {
        document.body.innerHTML = '<div id="rm_group_chats_block"></div>';
        document.getElementById('rm_group_chats_block').getClientRects = () => [{}];
        return loadFunctions(['openGroupEditor', 'groupEditorTargetExists'], {
            selected_group: 'group-1',
            openGroupId: 'group-1',
            editorDraft: { id: 'group-1' },
            groups: [{ id: 'group-1' }, { id: 'group-2' }],
            menu_type: 'group_edit',
            select_group_chats: jest.fn(),
            openGroupById: jest.fn(async () => true),
            captureGroupEditorSave: jest.fn(() => ({ context: { mode: 'edit' } })),
            groupEditorReady: Promise.resolve(true),
            ...overrides,
        });
    }

    test('reopens the selected chat group without switching chats', async () => {
        const context = setup();
        await expect(context.api.openGroupEditor('group-1')).resolves.toBe(true);
        expect(context.select_group_chats).toHaveBeenCalledWith('group-1', false);
        expect(context.openGroupById).not.toHaveBeenCalled();
    });

    test('Back opens a nonselected group presentation without switching the selected chat', async () => {
        const context = setup();
        await expect(context.api.openGroupEditor('group-2')).resolves.toBe(true);
        expect(context.select_group_chats).toHaveBeenCalledWith('group-2', false);
        expect(context.openGroupById).not.toHaveBeenCalled();
        expect(context.selected_group).toBe('group-1');
    });

    test('switches chat only when explicitly requested', async () => {
        const context = setup();
        await expect(context.api.openGroupEditor('group-2', { switchChat: true })).resolves.toBe(true);
        expect(context.openGroupById).toHaveBeenCalledWith('group-2', { switchMenu: true });
    });

    test('restores an existing unsaved create draft without switching chats', async () => {
        const context = setup({
            openGroupId: null, editorDraft: { id: null }, menu_type: 'group_create',
            captureGroupEditorSave: () => ({ context: { mode: 'create' } }),
        });
        await expect(context.api.openGroupEditor('create')).resolves.toBe(true);
        expect(context.select_group_chats).toHaveBeenCalledWith(null, false);
        expect(context.openGroupById).not.toHaveBeenCalled();
    });

    test('refuses a missing create draft rather than replacing a different editor draft', async () => {
        const context = setup();
        await expect(context.api.openGroupEditor('create')).resolves.toBe(false);
        expect(context.select_group_chats).not.toHaveBeenCalled();
    });

    test('propagates a refused chat switch', async () => {
        const context = setup({ openGroupById: jest.fn(async () => false) });
        await expect(context.api.openGroupEditor('group-2', { switchChat: true })).resolves.toBe(false);
    });

    test('create exists only while an unsaved create draft owns an open session', () => {
        const context = setup({ openGroupId: null, editorDraft: { id: null } });
        context.captureGroupEditorSave.mockReturnValue({ context: { mode: 'create' } });
        expect(context.api.groupEditorTargetExists('create')).toBe(true);
        context.captureGroupEditorSave.mockReturnValue(null);
        expect(context.api.groupEditorTargetExists('create')).toBe(false);
        context.captureGroupEditorSave.mockReturnValue({ context: { mode: 'create' } });
        context.editorDraft = null;
        expect(context.api.groupEditorTargetExists('create')).toBe(false);
        expect(context.api.groupEditorTargetExists('group-1')).toBe(true);
        expect(context.api.groupEditorTargetExists('missing')).toBe(false);
    });

    test('does not mutate presentation for an already superseded route', async () => {
        const context = setup();
        await expect(context.api.openGroupEditor('group-2', { isCurrent: () => false })).resolves.toBe(false);
        expect(context.select_group_chats).not.toHaveBeenCalled();
        expect(context.openGroupById).not.toHaveBeenCalled();
    });

    test('stops waiting for presentation once the route is superseded', async () => {
        const context = setup();
        let current = true;
        document.getElementById('rm_group_chats_block').getClientRects = () => [];
        context.delay = jest.fn(async () => { current = false; });
        await expect(context.api.openGroupEditor('group-2', { isCurrent: () => current })).resolves.toBe(false);
        expect(context.delay).toHaveBeenCalledTimes(1);
        expect(context.openGroupById).not.toHaveBeenCalled();
    });

    test('a superseded explicit chat switch cannot report successful readiness', async () => {
        let finishSwitch;
        const switching = new Promise(resolve => { finishSwitch = resolve; });
        const context = setup({ openGroupById: jest.fn(() => switching) });
        let current = true;
        const opened = context.api.openGroupEditor('group-2', { switchChat: true, isCurrent: () => current });
        current = false;
        finishSwitch(true);
        await expect(opened).resolves.toBe(false);
        expect(context.select_group_chats).not.toHaveBeenCalled();
    });
});

describe('native group stylesheet readiness', () => {
    test('an errored sheet prevents reveal and reopening retries the actual deferred dependencies', async () => {
        document.body.innerHTML = '<div id="rm_group_chats_block"></div>';
        const root = document.getElementById('rm_group_chats_block');
        root.getClientRects = () => [{}];
        const editorSource = readFileSync(new URL('../../public/scripts/sillybunny-group-editor.js', import.meta.url), 'utf8');
        const shellSource = readFileSync(new URL('../../public/scripts/sillybunny-editor/list-shell.js', import.meta.url), 'utf8');
        const reveal = editorSource.match(/^export async function prepareGroupEditorReveal\([\s\S]*?^}/m)[0].replace('export ', '');
        const sheets = editorSource.match(/^const GROUP_EDITOR_STYLESHEETS = \[[\s\S]*?^\];/m)[0];
        const shellSheet = shellSource.match(/^export const LIST_EDITOR_STYLESHEET = .*;/m)[0].replace('export ', '');
        const prepare = vm.runInNewContext(`${shellSheet}\n${sheets}\nconst groupEditorReveals = new WeakMap();\n${reveal}\nprepareGroupEditorReveal;`, { loadStylesheetAsync });
        const context = loadFunctions(['select_group_chats', 'openGroupEditor', 'groupEditorTargetExists', 'reportGroupEditorError'], {
            $, prepareGroupEditorReveal: prepare, menu_type: 'group_edit', groupEditorReady: null,
            beginGroupEditorLoad: () => 'reconciled', openGroupId: 'group-1', groups: [{ id: 'group-1' }], editorDraft: {},
            reconcileEditorDraft() {}, setMenuType() {}, selectRightMenuWithAnimation() {},
            writeGroupEditorFields() {}, applyTagsOnGroupSelect() {}, printGroupCandidates() {}, printGroupMembers() {},
            updateGroupSubmitState() {}, updateGroupAvatar() {}, updateFavButtonState() {}, updateGroupHeaderTitle() {},
            CSS: { supports: () => true }, updateGroupSpeakerControls() {},
            eventSource: { emit() {} }, openGroupEditorSession() {},
            console: { error: jest.fn() }, toastr: { error: jest.fn() }, t: strings => strings.join(''),
        });
        const opening = context.api.openGroupEditor('group-1');
        expect(root.style.visibility).toBe('hidden');
        expect(root.inert).toBe(true);
        const ids = ['deferred-editor-shell-css', 'deferred-entity-list-css', 'deferred-rm-groups-css'];
        const failed = document.getElementById(ids[1]);
        document.getElementById(ids[0]).dispatchEvent(new Event('load'));
        document.getElementById(ids[2]).dispatchEvent(new Event('load'));
        failed.dispatchEvent(new Event('error'));
        await expect(opening).resolves.toBe(false);
        expect(root.style.visibility).toBe('hidden');
        expect(context.toastr.error).toHaveBeenCalledTimes(1);
        const reopening = context.api.openGroupEditor('group-1');
        const retry = document.getElementById(ids[1]);
        expect(retry).not.toBe(failed);
        expect(failed.isConnected).toBe(false);
        expect(root.style.visibility).toBe('hidden');
        retry.dispatchEvent(new Event('load'));
        await expect(reopening).resolves.toBe(true);
        expect(root.inert).toBe(false);
        expect(root.style.visibility).toBe('');
        expect(document.head.querySelectorAll('link')).toHaveLength(3);
    });
});

describe('candidate Add focus', () => {
    function setup() {
        document.body.innerHTML = '<div class="ds-entity-list"><input id="rm_group_filter" type="search"><div id="rm_group_add_members"><div class="group_member" data-avatar="a.png" tabindex="0"></div><div class="group_member" data-avatar="b.png" tabindex="0"></div><div class="group_member" data-avatar="c.png" tabindex="0"></div></div></div>';
        return loadFunctions(['captureGroupMemberFocus', 'restoreGroupMemberFocus'], {
            editorDraft: {}, openGroupId: null, candidatesPagination: { page: 1 }, membersPagination: null,
        });
    }

    test.each([[0, 'b.png'], [2, 'b.png']])('focuses a neighbouring candidate when index %i is added', (index, expected) => {
        const context = setup();
        const row = document.querySelectorAll('.group_member')[index];
        const focus = context.api.captureGroupMemberFocus({ 0: row, data: () => row.dataset.avatar });
        row.remove();
        context.api.restoreGroupMemberFocus(focus, { removed: true, control: '' });
        expect(document.activeElement.dataset.avatar).toBe(expected);
    });

    test('focuses search when the last candidate leaves the list', () => {
        const context = setup();
        const row = document.querySelector('.group_member');
        const focus = context.api.captureGroupMemberFocus({ 0: row, data: () => row.dataset.avatar });
        document.getElementById('rm_group_add_members').replaceChildren();
        context.api.restoreGroupMemberFocus(focus, { removed: true, control: '' });
        expect(document.activeElement.id).toBe('rm_group_filter');
    });

    test('does not steal focus after the editor draft changes', () => {
        const context = setup();
        const row = document.querySelector('.group_member');
        const focus = context.api.captureGroupMemberFocus({ 0: row, data: () => row.dataset.avatar });
        context.editorDraft = {};
        context.api.restoreGroupMemberFocus(focus, { removed: true, control: '' });
        expect(document.activeElement).toBe(document.body);
    });

    test('focuses the previous page’s last row when the final candidate page disappears', () => {
        const context = setup();
        context.candidatesPagination.page = 2;
        const row = document.querySelector('.group_member');
        const focus = context.api.captureGroupMemberFocus({ 0: row, data: () => row.dataset.avatar });
        context.candidatesPagination.page = 1;
        context.api.restoreGroupMemberFocus(focus, { removed: true, control: '' });
        expect(document.activeElement.dataset.avatar).toBe('c.png');
    });
});

describe('group list search and pagination controllers', () => {
    test('mounts scoped, labelled 300ms search and keeps the field visible on Escape', () => {
        document.body.innerHTML = '<section class="sb-editor-section"><div class="ds-entity-list"><div><input id="rm_group_filter" type="search"></div><span data-sb-group-list-status></span></div></section>';
        const input = document.getElementById('rm_group_filter');
        const clear = jest.fn();
        const createListSearch = jest.fn(() => ({ clear }));
        const setFilterData = jest.fn();
        const context = loadFunctions(['mountGroupListSearch'], {
            groupListSearches: new Map(),
            createListSearch,
            groupCandidatesFilter: { setFilterData },
            FILTER_TYPES: { SEARCH: 'search' },
            t: strings => strings[0],
        });
        context.api.mountGroupListSearch(input, false);
        expect(createListSearch).toHaveBeenCalledWith(expect.objectContaining({
            debounce: 300,
            scope: document.querySelector('section'),
            status: document.querySelector('[data-sb-group-list-status]'),
        }));
        expect(input.getAttribute('aria-label')).toBe('Search');
        createListSearch.mock.calls[0][0].onChange('ALICE');
        expect(setFilterData).toHaveBeenCalledWith('search', 'alice');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(clear).toHaveBeenCalledTimes(1);
        expect(input.parentElement.hidden).toBe(false);
    });

    test('retains the native paginator, storage keys and member page across renders', () => {
        document.body.innerHTML = '<div id="rm_group_members_pagination"></div>';
        const pagination = { element: document.createElement('nav'), page: 2 };
        const getItem = jest.fn(() => null);
        const setItem = jest.fn();
        const createListPagination = jest.fn(() => pagination);
        const printGroupMembers = jest.fn();
        const context = loadFunctions(['getGroupListPagination'], {
            membersPagination: null,
            candidatesPagination: null,
            accountStorage: { getItem, setItem },
            createListPagination,
            printGroupMembers,
        });
        expect(context.api.getGroupListPagination(true)).toBe(pagination);
        expect(context.api.getGroupListPagination(true)).toBe(pagination);
        expect(createListPagination).toHaveBeenCalledTimes(1);
        const options = createListPagination.mock.calls[0][0];
        expect(options.keepSizeVisible).toBe(true);
        expect(options.pageSizes).toEqual([5, 10, 25, 50, 100, 200, 500, 1000]);
        expect(options.readPageSize()).toBe(5);
        expect(getItem).toHaveBeenCalledWith('GroupMembers_PerPage');
        options.writePageSize(25);
        expect(setItem).toHaveBeenCalledWith('GroupMembers_PerPage', '25');
        options.onChange();
        expect(printGroupMembers).toHaveBeenCalledWith({ animate: true });
        expect(pagination.page).toBe(2);
    });
});
