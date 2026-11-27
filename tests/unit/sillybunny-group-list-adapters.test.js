/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions exercise real group-chats.js. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

import { importGroupChatsModule } from '../util/group-chats-module-harness.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));

// Capture the real prepareGroupEditorReveal before any test mocks sillybunny-group-editor.js.
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/option-details.js'), () => ({
    renderDetails: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/picker.js'), () => ({
    openPicker: jest.fn(),
    closePicker: jest.fn(),
    isPickerOpen: jest.fn(() => false),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/chrome.js'), () => ({
    mountEditorChrome: jest.fn(),
    showDraftRecoveryToast: jest.fn(),
    dismissDraftRecoveryToast: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/tag-filter-menu.js'), () => ({
    adoptTagField: jest.fn(),
    attachTagFilterMenu: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/navigation.js'), () => ({
    registerEditorNavigation: jest.fn(),
    confirmEditorLeave: jest.fn(async () => true),
    discardEditorChanges: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/object-navigation.js'), () => ({
    objectNavigation: { navigate: jest.fn(async () => ({ ok: true })) },
}));
await jest.unstable_mockModule(pub('scripts/user.js'), () => ({
    getCurrentUserHandle: () => 'test-user',
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-folders.js'), () => ({
    getFolders: () => [],
    subscribe: () => () => {},
    getFolderId: () => null,
    removeEntityKey: () => {},
    setFolder: async () => {},
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/leave-dialog.js'), () => ({
    askLeaveEditor: jest.fn(async () => 'stay'),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/session.js'), () => ({
    createEditorSession: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/drafts.js'), () => ({
    createEditorDraftStore: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
const { prepareGroupEditorReveal: realPrepareGroupEditorReveal } = await import('../../public/scripts/sillybunny-group-editor.js');

function mountFullGroupEditorDom() {
    document.body.innerHTML = `
        <div id="chat"></div>
        <textarea id="send_textarea"></textarea>
        <div id="rm_group_chats_block">
            <div id="sb_group_editor_content">
                <section class="sb-editor-section">
                    <div class="ds-entity-list">
                        <div><input id="rm_group_members_filter" type="search" value=""></div>
                        <span data-sb-group-list-status></span>
                        <div id="rm_group_members" class="rm_group_members"></div>
                        <div id="rm_group_members_pagination"></div>
                    </div>
                </section>
                <section class="sb-editor-section">
                    <div class="ds-entity-list">
                        <div><input id="rm_group_filter" type="search" value=""></div>
                        <span data-sb-group-list-status></span>
                        <div id="rm_group_add_members"></div>
                        <div id="rm_group_add_members_pagination"></div>
                    </div>
                </section>
            </div>
        </div>
    `;
    document.getElementById('rm_group_chats_block').getClientRects = () => [{}];
}

function makeStatusPageStub() {
    return function createStatusPage({ state, title, compact }) {
        const element = document.createElement('div');
        element.className = `sb-status-page${compact ? ' sb-status-page--compact' : ''}`;
        const heading = document.createElement('h3');
        element.append(heading);
        const update = values => {
            if (values.state) element.dataset.state = values.state;
            if (values.title !== undefined) heading.textContent = values.title;
        };
        update({ state, title });
        return { element, update };
    };
}

async function setupGroupApp({
    groups = [{
        id: 'group-1',
        name: 'Test Group',
        chat_id: 'chat-1',
        chats: ['chat-1'],
        members: ['alice.png'],
        disabled_members: ['alice.png'],
        member_models: { 'alice.png': 'test-model' },
    }],
    characters = [
        { avatar: 'alice.png', name: 'Alice', fav: true, data: { character_version: 'v2' } },
        { avatar: 'bob.png', name: 'Bob' },
    ],
    openGroup = false,
    selectEditor = 'group-1',
    extraOptions = {},
} = {}) {
    mountFullGroupEditorDom();
    const fetchMock = jest.fn(async (url) => {
        if (url === '/api/groups/all') {
            return { ok: true, json: async () => structuredClone(groups) };
        }
        if (url === '/api/chats/group/get') {
            return { ok: true, json: async () => [{ user_name: 'User', character_name: 'Group', chat_metadata: { tainted: true } }] };
        }
        return { ok: true, json: async () => ({ ok: true }) };
    });

    const loaded = await importGroupChatsModule({
        characters,
        fetch: fetchMock,
        mockStatusPage: { createStatusPage: makeStatusPageStub() },
        script: {
            getThumbnailUrl: jest.fn((_type, avatar) => `/thumb/${avatar}`),
            getThumbnailUrlForViewport: jest.fn((_type, avatar) => `/thumb/${avatar}`),
            ...(extraOptions.script ?? {}),
        },
        tags: {
            getTagsList: jest.fn(() => Array.from({ length: 5 }, (_, index) => ({ id: `tag-${index}`, name: `Tag ${index}` }))),
            ...(extraOptions.tags ?? {}),
        },
        ...extraOptions,
    });
    await loaded.runReady();
    await loaded.groupChats.getGroups();
    if (openGroup) {
        await loaded.groupChats.openGroupById(typeof openGroup === 'string' ? openGroup : groups[0].id, { switchMenu: false });
    }
    if (selectEditor !== false) {
        loaded.groupChats.select_group_chats(selectEditor, false);
    }
    return { ...loaded, fetchMock };
}

async function settle() {
    for (let index = 0; index < 30; index++) await Promise.resolve();
}

beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    document.body.innerHTML = '';
    document.head.querySelectorAll('link').forEach(link => link.remove());
});

afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = '';
    document.head.querySelectorAll('link').forEach(link => link.remove());
});

describe('group rows on the shared factory', () => {
    test('preserves member hooks, lazy avatars, state, tags and detached action transports', async () => {
        const { $, groupChats, mocks } = await setupGroupApp({
            openGroup: 'group-1',
            selectEditor: false,
            groups: [{
                id: 'group-1',
                name: 'Test Group',
                chat_id: 'chat-1',
                chats: ['chat-1'],
                members: ['bob.png', 'alice.png'],
                disabled_members: [],
                member_models: { 'alice.png': 'test-model' },
            }],
            extraOptions: { power_user: { show_group_chat_queue: true } },
        });

        // Start a 2-speaker forced round and pause on speaker 1 (Bob) so Alice sits at queue position 2.
        let finishBob;
        const bobPending = new Promise(resolve => { finishBob = resolve; });
        mocks.script.Generate.mockImplementationOnce(() => bobPending).mockResolvedValue(undefined);
        const running = groupChats.generateGroupWrapper(false, 'normal', { force_chids: [1, 0] });
        await settle();

        try {
            groupChats.groups[0].disabled_members = ['alice.png'];
            groupChats.select_group_chats('group-1', false);
            const row = document.querySelector('#rm_group_members .group_member[data-avatar="alice.png"]');
            const member = $(row);
            expect(member.jquery).toBeDefined();
            expect(row.classList.contains('ds-entity-row')).toBe(true);
            expect(row.dataset).toMatchObject({ avatar: 'alice.png', chid: '0', sbMemberIndex: '1', sbListKey: 'character:alice.png' });
            expect(member.data('id')).toBe('alice.png');
            expect(row.tabIndex).toBe(0);
            expect(row.querySelector('.ds-entity-row__chevron')).toBeNull();
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
        } finally {
            finishBob();
            await running;
        }
    });

    test('candidates have one Add suffix control, no navigation chevron and no empty subtitle', async () => {
        await setupGroupApp();
        const row = document.querySelector('#rm_group_add_members .group_member[data-avatar="bob.png"]');
        expect(row.matches('.group_member.sb-group-candidate')).toBe(true);
        expect(row.tabIndex).toBe(0);
        expect(row.querySelector('.ds-entity-row__chevron')).toBeNull();
        expect(row.querySelector('.ds-entity-row__subtitle').style.display).toBe('none');
        expect(row.querySelector('.group_member_icon').children).toHaveLength(1);
        expect(row.querySelector('.group_member_icon [data-action="add"]')).not.toBeNull();
    });

    test('unchanged member and candidate renders retain rows, controls and tag nodes', async () => {
        const { groupChats, mocks } = await setupGroupApp();
        const member = document.querySelector('#rm_group_members .group_member');
        const candidate = document.querySelector('#rm_group_add_members .group_member');
        const control = member.querySelector('input[type="checkbox"]');
        const tag = member.querySelector('.tag');
        control.focus();

        mocks.groupEditor.beginGroupEditorLoad.mockReturnValue('reconciled');
        groupChats.select_group_chats('group-1', false);

        expect(document.querySelector('#rm_group_members .group_member')).toBe(member);
        expect(document.querySelector('#rm_group_add_members .group_member')).toBe(candidate);
        expect(member.querySelector('input[type="checkbox"]')).toBe(control);
        expect(member.querySelector('.tag')).toBe(tag);
        expect(document.activeElement).toBe(control);
    });

    test('an empty list shows the compact status page beside its rows and drops it when rows return', async () => {
        const { groupChats, mocks } = await setupGroupApp({
            groups: [{
                id: 'group-1',
                name: 'Empty Group',
                chat_id: 'chat-1',
                chats: ['chat-1'],
                members: [],
                disabled_members: [],
                member_models: {},
            }],
        });

        const rows = document.getElementById('rm_group_members');
        const page = rows.nextElementSibling;
        expect(rows.childElementCount).toBe(0);
        expect(page.matches('.sb-status-page.sb-status-page--compact[data-state="empty"]')).toBe(true);
        expect(page.querySelector('h3').textContent).toBe('Group is empty.');

        mocks.groupEditor.beginGroupEditorLoad.mockReturnValue('reconciled');
        groupChats.select_group_chats('group-1', false);
        expect(rows.nextElementSibling).toBe(page);

        await groupChats.runGroupMemberActionByChid(0, 'add');
        expect(document.querySelector('.sb-status-page')).toBeNull();
        expect(rows.childElementCount).toBe(1);
    });

    test('changed member presentation updates in place through the factory', async () => {
        const { groupChats, state, mocks } = await setupGroupApp({
            openGroup: 'group-1',
            selectEditor: 'group-1',
            extraOptions: { power_user: { show_group_chat_queue: true } },
        });

        const row = document.querySelector('#rm_group_members .group_member[data-avatar="alice.png"]');
        const control = row.querySelector('.sb-group-member-switch');
        const image = row.querySelector('img');

        // Enable Alice and start a forced generation so queue position becomes 1 (is_active).
        groupChats.groups[0].disabled_members = [];
        let finishAlice;
        const alicePending = new Promise(resolve => { finishAlice = resolve; });
        mocks.script.Generate.mockImplementationOnce(() => alicePending);
        const running = groupChats.generateGroupWrapper(false, 'normal', { force_chids: [0] });
        await settle();

        try {
            const character = state.characters[0];
            character.name = 'Alicia';
            character.fav = false;
            character.data.character_version = 'v3';
            groupChats.groups[0].members = ['missing.png', 'alice.png'];
            groupChats.groups[0].member_models = { 'alice.png': 'new-model' };
            state.characters.reverse();
            mocks.script.getThumbnailUrlForViewport.mockReturnValue('/thumb/new-revision');
            mocks.tags.getTagsList.mockReturnValue([{ id: 'new-tag', name: 'New tag' }]);

            // Reload editor fields from live group so draft updates and re-reconciles the existing row node.
            groupChats.select_group_chats('group-1', false);

            expect(document.querySelector('#rm_group_members .group_member[data-avatar="alice.png"]')).toBe(row);
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
            expect(control.getAttribute('aria-label')).toBe('Replies From Alicia');
            expect(control.dataset.action).toBe('disable');
            expect(row.querySelector('.tag').textContent).toBe('New tag');
        } finally {
            finishAlice();
            await running;
        }
    });

    test('changed candidates update in place and removed keys leave the list cleanly', async () => {
        const { groupChats, state, mocks } = await setupGroupApp();
        const row = document.querySelector('#rm_group_add_members .group_member[data-avatar="bob.png"]');
        state.characters[1].name = 'Bobby';
        state.characters[1].data = { character_version: 'candidate-version' };

        mocks.groupEditor.beginGroupEditorLoad.mockReturnValue('reconciled');
        groupChats.select_group_chats('group-1', false);
        expect(document.querySelector('#rm_group_add_members .group_member[data-avatar="bob.png"]')).toBe(row);
        expect(row.querySelector('.ch_name').textContent).toBe('Bobby');
        expect(row.querySelector('.ch_additional_info').textContent).toBe('candidate-version');

        await groupChats.runGroupMemberActionByChid(1, 'add');
        expect(row.isConnected).toBe(false);
        expect(document.querySelector('#rm_group_add_members .group_member[data-avatar="bob.png"]')).toBeNull();
    });

    test('popouts mirror current keyed rows as HTML-only clones with working transports', async () => {
        const { $, groupChats } = await setupGroupApp();
        const popout = document.createElement('div');
        popout.className = 'rm_group_members';
        document.body.append(popout);

        groupChats.select_group_chats('group-1', false);
        const main = document.querySelector('#rm_group_members .group_member');
        const clone = popout.firstElementChild;
        expect(clone).not.toBe(main);
        expect($(clone).data('id')).toBeUndefined();
        expect(clone.dataset.avatar).toBe('alice.png');

        groupChats.groups[0].disabled_members = [];
        groupChats.select_group_chats('group-1', false);
        expect(document.querySelector('#rm_group_members .group_member')).toBe(main);
        expect(popout.firstElementChild.querySelector('.sb-group-member-switch').checked).toBe(true);
        expect(popout.querySelector('.sb-group-member-legacy [data-action="view"]')).not.toBeNull();
    });

    test('passes all displayable tag names beyond upstream’s 50-chip limit', async () => {
        const tags = Array.from({ length: 60 }, (_, index) => ({ id: `tag-${index}`, name: `Tag ${index}` }));
        const { mocks } = await setupGroupApp({
            extraOptions: {
                tags: {
                    getTagsList: jest.fn(() => [...tags, { id: 'hidden', name: 'Hidden', is_hidden_on_character_card: true }]),
                },
            },
        });
        const row = document.querySelector('#rm_group_members .group_member[data-avatar="alice.png"]');
        expect(mocks.tags.getTagsList).toHaveBeenCalledWith('alice.png');
        expect(row.querySelectorAll('.tag:not(.sb-tag-overflow)')).toHaveLength(50);
        // Overflow badge counts the hidden displayable tags beyond the visible chip cap (60 - 3 = 57).
        expect(row.querySelector('.sb-tag-overflow').textContent).toBe('+57');
    });
});

describe('group row keyboard and pointer bindings', () => {
    test('member rows navigate with via; nested tags, grips and controls do not', async () => {
        const { groupChats, mocks } = await setupGroupApp({
            groups: [{
                id: 'group-1',
                name: 'Test Group',
                chat_id: 'chat-1',
                chats: ['chat-1'],
                members: ['alice.png', 'bob.png'],
                disabled_members: [],
                member_models: {},
            }],
        });

        const list = document.getElementById('rm_group_members');
        const rows = list.querySelectorAll('.group_member');
        const row = rows[0];
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement).toBe(rows[1]);
        rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(document.activeElement).toBe(row);

        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        row.querySelector('.ch_name').click();
        await settle();

        expect(mocks.objectNavigation.navigate).toHaveBeenCalledTimes(3);
        expect(mocks.objectNavigation.navigate).toHaveBeenCalledWith(
            { kind: 'character-editor', id: 'alice.png', via: 'group-member' },
            { from: expect.any(Function) },
        );
        const origin = mocks.objectNavigation.navigate.mock.calls[0][1].from;
        expect(origin()).toEqual({ kind: 'group-editor', id: 'group-1' });
        groupChats.select_group_chats(null, false);
        expect(origin()).toEqual({ kind: 'group-editor', id: 'create' });

        // Nested interactive controls on the row must not trigger row navigation.
        groupChats.select_group_chats('group-1', false);
        const refreshedRow = list.querySelector('.group_member[data-avatar="alice.png"]');
        mocks.objectNavigation.navigate.mockClear();
        for (const nested of refreshedRow.querySelectorAll('.tag, .sb-group-member-grip, input, button, label')) {
            nested.click();
            nested.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        await settle();
        expect(mocks.objectNavigation.navigate).not.toHaveBeenCalled();
    });

    test('candidate background, static tags and Enter add, while the Add button uses its own transport', async () => {
        const { groupChats } = await setupGroupApp({
            characters: [
                { avatar: 'alice.png', name: 'Alice' },
                { avatar: 'bob.png', name: 'Bob' },
                { avatar: 'cara.png', name: 'Cara' },
                { avatar: 'dan.png', name: 'Dan' },
            ],
            groups: [{
                id: 'group-1', name: 'Test Group', chat_id: 'chat-1', chats: ['chat-1'],
                members: [], disabled_members: [], member_models: {},
            }],
        });

        // 1. Clicking candidate name adds Alice.
        document.querySelector('#rm_group_add_members .group_member[data-avatar="alice.png"] .ch_name').click();
        await settle();
        expect(document.querySelector('#rm_group_members .group_member[data-avatar="alice.png"]')).not.toBeNull();

        // 2. Clicking a static tag chip adds Bob.
        document.querySelector('#rm_group_add_members .group_member[data-avatar="bob.png"] .tag').click();
        await settle();
        expect(document.querySelector('#rm_group_members .group_member[data-avatar="bob.png"]')).not.toBeNull();

        // 3. Pressing Enter on candidate row adds Cara.
        document.querySelector('#rm_group_add_members .group_member[data-avatar="cara.png"]')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();
        expect(document.querySelector('#rm_group_members .group_member[data-avatar="cara.png"]')).not.toBeNull();

        // 4. Clicking the Add button invokes its dedicated .right_menu_button handler once (no duplicate add).
        document.querySelector('#rm_group_add_members .group_member[data-avatar="dan.png"] button[data-action="add"]').click();
        await settle();
        expect(document.querySelectorAll('#rm_group_members .group_member[data-avatar="dan.png"]')).toHaveLength(1);
        expect(groupChats.groups[0].members).toEqual([]);
    });

    test.each(['click', 'Enter'])('candidate %s catches real hydration rejection and reconciles the mutated draft', async activation => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const failure = new Error('Offline');
        const { groupChats, mocks, eventSource } = await setupGroupApp({
            groups: [{
                id: 'group-1', name: 'Test Group', chat_id: 'chat-1', chats: ['chat-1'],
                members: ['alice.png'], disabled_members: [], member_models: {},
            }],
            extraOptions: {
                script: {
                    unshallowCharacter: jest.fn().mockRejectedValue(failure),
                },
            },
        });
        const updatedSpy = jest.fn();
        eventSource.on('group_updated', updatedSpy);

        try {
            const row = document.querySelector('#rm_group_add_members .group_member[data-avatar="bob.png"]');
            if (activation === 'click') row.querySelector('.ch_name').click();
            else row.dispatchEvent(new KeyboardEvent('keydown', { key: activation, bubbles: true }));
            await settle();

            expect(mocks.toastr.error).toHaveBeenCalledWith('Offline');
            expect(errorSpy).toHaveBeenCalledWith(failure);
            expect(document.querySelector('#rm_group_members .group_member[data-avatar="bob.png"]')).not.toBeNull();
            expect(document.querySelector('#rm_group_add_members .group_member[data-avatar="bob.png"]')).toBeNull();
            expect(updatedSpy).toHaveBeenCalled();

            // Direct programmatic API still rejects so command callers observe failures.
            await expect(groupChats.runGroupMemberActionByChid(1, 'remove')).resolves.toBeUndefined();
            await expect(groupChats.runGroupMemberActionByChid(1, 'add')).rejects.toBe(failure);
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('member menu actions and model override catch asynchronous failures', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const failure = new Error('Offline');
        const { mocks } = await setupGroupApp({
            groups: [{
                id: 'group-1', name: 'Test Group', chat_id: 'chat-1', chats: ['chat-1'],
                members: ['alice.png', 'bob.png'], disabled_members: [], member_models: {},
            }],
            extraOptions: {
                objectNavigation: { navigate: jest.fn().mockRejectedValue(failure) },
                popup: {
                    Popup: Object.assign(jest.fn(), {
                        show: {
                            confirm: jest.fn().mockRejectedValue(failure),
                            input: jest.fn().mockRejectedValue(failure),
                        },
                    }),
                },
            },
        });

        try {
            document.querySelector('#rm_group_members .group_member[data-avatar="alice.png"] .sb-group-member-menu').click();
            expect(mocks.actionMenu.openActionMenu).toHaveBeenCalledTimes(1);
            const items = mocks.actionMenu.openActionMenu.mock.calls[0][0].sections.flatMap(section => section.items);
            expect(items.filter(item => item.data?.sbReorder).map(item => item.data.sbReorder)).toEqual(['down']);

            const viewItem = items.find(item => /view/i.test(item.label));
            const modelItem = items.find(item => /model/i.test(item.label));
            await viewItem.onSelect();
            await modelItem.onSelect();
            await settle();
            expect(mocks.toastr.error).toHaveBeenCalledTimes(2);
            expect(errorSpy).toHaveBeenCalledWith(failure);
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('member menu leaves the move items out while a member filter is active', async () => {
        const { mocks } = await setupGroupApp({
            characters: [
                { avatar: 'bob.png', name: 'Bob' },
                { avatar: 'alice.png', name: 'Alice' },
                { avatar: 'cara.png', name: 'Cara' },
            ],
            groups: [{
                id: 'group-1', name: 'Test Group', chat_id: 'chat-1', chats: ['chat-1'],
                members: ['bob.png', 'alice.png', 'cara.png'], disabled_members: [], member_models: {},
            }],
        });

        document.getElementById('rm_group_members_filter').value = 'al';
        document.querySelector('#rm_group_members .group_member[data-avatar="alice.png"] .sb-group-member-menu').click();
        const items = mocks.actionMenu.openActionMenu.mock.calls[0][0].sections.flatMap(section => section.items);
        expect(items.some(item => item.data?.sbReorder)).toBe(false);
    });
});

describe('pagination-independent group member actions', () => {
    test('uses the rendered member without rebuilding it and handles off-page members without changing the page', async () => {
        const characters = Array.from({ length: 7 }, (_, index) => ({
            avatar: `char-${index}.png`,
            name: `Char ${index}`,
        }));
        const { groupChats, mocks } = await setupGroupApp({
            characters,
            groups: [{
                id: 'group-1', name: 'Paged Group', chat_id: 'chat-1', chats: ['chat-1'],
                members: characters.map(c => c.avatar), disabled_members: [], member_models: {},
            }],
        });

        // Page 1 shows 5 members (char-0..char-4); char-6 is off-page on page 2.
        const renderedRow = document.querySelector('#rm_group_members .group_member[data-avatar="char-1.png"]');
        expect(renderedRow).not.toBeNull();
        expect(document.querySelector('#rm_group_members .group_member[data-avatar="char-6.png"]')).toBeNull();

        // Rendered member disables in place without rebuilding the row.
        await groupChats.runGroupMemberActionByChid(1, 'disable');
        expect(document.querySelector('#rm_group_members .group_member[data-avatar="char-1.png"]')).toBe(renderedRow);
        expect(renderedRow.classList.contains('disabled')).toBe(true);

        // Off-page member actions execute without switching off page 1.
        await groupChats.runGroupMemberActionByChid(6, 'disable');
        expect(groupChats.captureGroupEditorListState().membersPage).toBe(1);
        await groupChats.runGroupMemberActionByChid(6, 'enable');
        await groupChats.runGroupMemberActionByChid(6, 'up');
        await groupChats.runGroupMemberActionByChid(6, 'down');
        await groupChats.runGroupMemberActionByChid(6, 'remove');
        expect(groupChats.captureGroupEditorListState().membersPage).toBe(1);

        // Invalid character indices are ignored safely.
        mocks.groupEditor.notifyGroupEditorChanged.mockClear();
        for (const bad of [-1, 99, 0.5, 'missing']) {
            await groupChats.runGroupMemberActionByChid(bad, 'disable');
        }
        expect(mocks.groupEditor.notifyGroupEditorChanged).not.toHaveBeenCalled();
    });
});

describe('group member peek boundary', () => {
    test('peeks only an edited member of the selected chat group', async () => {
        const { groupChats, mocks } = await setupGroupApp({ openGroup: 'group-1', selectEditor: 'group-1' });

        expect(groupChats.canPeekGroupMember('alice.png')).toBe(true);
        expect(groupChats.canPeekGroupMember('bob.png')).toBe(false);
        await expect(groupChats.openGroupMemberDefinition('alice.png')).resolves.toBe(true);
        expect(mocks.script.unshallowCharacter).toHaveBeenCalledWith('0');
        expect(mocks.script.setCharacterId).toHaveBeenCalledWith('0');
        expect(mocks.script.select_selected_character).toHaveBeenCalledWith('0');
    });

    test('refuses unsafe or unavailable peeks when no group is open, another editor is open, character is missing, or busy', async () => {
        const noSelected = await setupGroupApp({ openGroup: false, selectEditor: 'group-1' });
        await expect(noSelected.groupChats.openGroupMemberDefinition('alice.png')).resolves.toBe(false);
        expect(noSelected.mocks.script.setCharacterId).not.toHaveBeenCalled();

        const otherEditor = await setupGroupApp({
            openGroup: 'group-1',
            selectEditor: 'group-2',
            groups: [
                { id: 'group-1', name: 'One', chat_id: 'chat-1', chats: ['chat-1'], members: ['alice.png'], disabled_members: [] },
                { id: 'group-2', name: 'Two', chat_id: 'chat-2', chats: ['chat-2'], members: ['alice.png'], disabled_members: [] },
            ],
        });
        otherEditor.mocks.script.setCharacterId.mockClear();
        otherEditor.mocks.script.unshallowCharacter.mockClear();
        await expect(otherEditor.groupChats.openGroupMemberDefinition('alice.png')).resolves.toBe(false);
        expect(otherEditor.mocks.script.setCharacterId).not.toHaveBeenCalled();

        const sendBusy = await setupGroupApp({
            openGroup: 'group-1',
            selectEditor: 'group-1',
            extraOptions: { is_send_press: true },
        });
        await expect(sendBusy.groupChats.openGroupMemberDefinition('alice.png')).resolves.toBe(false);

        // Generating mid-turn refuses peek cleanly.
        const genBusy = await setupGroupApp({ openGroup: 'group-1', selectEditor: 'group-1' });
        let finishGen;
        genBusy.mocks.script.Generate.mockImplementationOnce(() => new Promise(resolve => { finishGen = resolve; }));
        const running = genBusy.groupChats.generateGroupWrapper(false, 'normal', { force_chids: [0] });
        await settle();
        try {
            genBusy.mocks.script.setCharacterId.mockClear();
            await expect(genBusy.groupChats.openGroupMemberDefinition('alice.png')).resolves.toBe(false);
            expect(genBusy.mocks.script.setCharacterId).not.toHaveBeenCalled();
        } finally {
            finishGen();
            await running;
        }
    });

    test('Back peeks the member already peeked over the selected chat group after another group editor opened', async () => {
        const { groupChats, mocks } = await setupGroupApp({
            openGroup: 'group-1',
            selectEditor: 'group-2',
            groups: [
                { id: 'group-1', name: 'One', chat_id: 'chat-1', chats: ['chat-1'], members: ['alice.png'], disabled_members: [] },
                { id: 'group-2', name: 'Two', chat_id: 'chat-2', chats: ['chat-2'], members: ['bob.png'], disabled_members: [] },
            ],
            extraOptions: { this_chid: '0' },
        });
        mocks.script.setCharacterId.mockClear();
        mocks.script.select_selected_character.mockClear();

        expect(groupChats.canPeekGroupMember('alice.png')).toBe(false);
        expect(groupChats.canRestoreGroupMemberPeek('alice.png')).toBe(true);
        expect(groupChats.canRestoreGroupMemberPeek('bob.png')).toBe(false);
        await expect(groupChats.openGroupMemberDefinition('alice.png')).resolves.toBe(false);
        expect(mocks.script.setCharacterId).not.toHaveBeenCalled();
        await expect(groupChats.openGroupMemberDefinition('alice.png', { restore: true })).resolves.toBe(true);
        expect(mocks.script.setCharacterId).toHaveBeenCalledWith('0');
        expect(mocks.script.select_selected_character).toHaveBeenCalledWith('0');
    });

    test('Back peeks an edited member again after a group reply cleared the peeked character', async () => {
        const { groupChats } = await setupGroupApp({ openGroup: 'group-1', selectEditor: 'group-1' });
        expect(groupChats.canRestoreGroupMemberPeek('alice.png')).toBe(true);
    });

    test('Back refuses peeks outside a group chat, of unpeeked members in another editor, or while busy', async () => {
        const outside = await setupGroupApp({ openGroup: false, selectEditor: 'group-1', extraOptions: { this_chid: '0' } });
        await expect(outside.groupChats.openGroupMemberDefinition('alice.png', { restore: true })).resolves.toBe(false);

        const other = await setupGroupApp({
            openGroup: 'group-1',
            selectEditor: 'group-2',
            groups: [
                { id: 'group-1', name: 'One', chat_id: 'chat-1', chats: ['chat-1'], members: ['alice.png'], disabled_members: [] },
                { id: 'group-2', name: 'Two', chat_id: 'chat-2', chats: ['chat-2'], members: ['bob.png'], disabled_members: [] },
            ],
        });
        await expect(other.groupChats.openGroupMemberDefinition('alice.png', { restore: true })).resolves.toBe(false);

        const busy = await setupGroupApp({ openGroup: 'group-1', selectEditor: 'group-1', extraOptions: { this_chid: '0', is_send_press: true } });
        await expect(busy.groupChats.openGroupMemberDefinition('alice.png', { restore: true })).resolves.toBe(false);
    });

    test('a superseded hydration cannot change selection, tokens or tags', async () => {
        let finishHydration;
        const hydration = new Promise(resolve => { finishHydration = resolve; });
        const { groupChats, mocks } = await setupGroupApp({ openGroup: 'group-1', selectEditor: 'group-1' });
        mocks.script.unshallowCharacter.mockReset().mockReturnValue(hydration);
        mocks.script.setCharacterId.mockClear();
        mocks.script.select_selected_character.mockClear();
        mocks.rossAscends.RA_CountCharTokens.mockClear();
        mocks.tags.applyTagsOnCharacterSelect.mockClear();

        let current = true;
        const opened = groupChats.openGroupMemberDefinition('alice.png', { isCurrent: () => current });
        expect(mocks.script.unshallowCharacter).toHaveBeenCalledTimes(1);
        current = false;
        finishHydration();
        await expect(opened).resolves.toBe(false);
        expect(mocks.script.setCharacterId).not.toHaveBeenCalled();
        expect(mocks.script.select_selected_character).not.toHaveBeenCalled();
        expect(mocks.rossAscends.RA_CountCharTokens).not.toHaveBeenCalled();
        expect(mocks.tags.applyTagsOnCharacterSelect).not.toHaveBeenCalled();
    });

    test('refuses a stale route before hydrating', async () => {
        const { groupChats, mocks } = await setupGroupApp({ openGroup: 'group-1', selectEditor: 'group-1' });
        mocks.script.unshallowCharacter.mockClear();
        await expect(groupChats.openGroupMemberDefinition('alice.png', { isCurrent: () => false })).resolves.toBe(false);
        expect(mocks.script.unshallowCharacter).not.toHaveBeenCalled();
    });
});

describe('group list Back snapshots', () => {
    test('captures the sheet scroll, current page and focused avatar', async () => {
        const characters = Array.from({ length: 12 }, (_, index) => ({ avatar: `c${index}.png`, name: `C${index}` }));
        const { groupChats } = await setupGroupApp({
            characters,
            groups: [{
                id: 'group-1', name: 'Paged', chat_id: 'chat-1', chats: ['chat-1'],
                members: characters.map(c => c.avatar), disabled_members: [], member_models: {},
            }],
        });

        await groupChats.restoreGroupEditorListState({ scrollTop: 180, membersPage: 3, focusedMemberAvatar: 'c10.png' });
        expect(groupChats.captureGroupEditorListState()).toEqual({
            scrollTop: 180,
            membersPage: 3,
            focusedMemberAvatar: 'c10.png',
        });
    });

    test('waits for pagination and reveal layout before restoring scroll and focus', async () => {
        const frames = [];
        const origRaf = globalThis.requestAnimationFrame;
        let finishPage;
        const pageReady = new Promise(resolve => { finishPage = resolve; });
        const goTo = jest.fn(() => pageReady);
        const paginationObj = {
            element: document.createElement('nav'),
            page: 1,
            setTotal: jest.fn(),
            slice: entries => entries,
            goTo,
        };

        try {
            const { groupChats } = await setupGroupApp({
                extraOptions: {
                    mockListPagination: { createListPagination: jest.fn(() => paginationObj) },
                },
            });
            globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
            window.requestAnimationFrame = globalThis.requestAnimationFrame;

            const scroller = document.getElementById('sb_group_editor_content');
            const restored = groupChats.restoreGroupEditorListState({ scrollTop: 180, membersPage: 3, focusedMemberAvatar: 'alice.png' });
            expect(scroller.scrollTop).toBe(0);
            finishPage();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(frames).toHaveLength(1);
            frames.shift()();
            frames.shift()();
            await restored;
            expect(goTo).toHaveBeenCalledWith(3);
            expect(scroller.scrollTop).toBe(180);
            expect(document.activeElement.dataset.avatar).toBe('alice.png');
        } finally {
            globalThis.requestAnimationFrame = origRaf;
            window.requestAnimationFrame = origRaf;
        }
    });

    test('does not apply a delayed Back snapshot to a newer editor draft', async () => {
        let finishPage;
        const pageReady = new Promise(resolve => { finishPage = resolve; });
        const paginationObj = {
            element: document.createElement('nav'),
            page: 1,
            setTotal: jest.fn(),
            slice: entries => entries,
            goTo: jest.fn(() => pageReady),
        };
        const { groupChats } = await setupGroupApp({
            extraOptions: {
                mockListPagination: { createListPagination: jest.fn(() => paginationObj) },
            },
        });
        const scroller = document.getElementById('sb_group_editor_content');
        const restored = groupChats.restoreGroupEditorListState({ scrollTop: 180, membersPage: 3, focusedMemberAvatar: 'alice.png' });
        // Selecting a fresh draft replaces editorDraft before the delayed restore finishes.
        groupChats.select_group_chats('group-1', false);
        finishPage();
        await restored;
        expect(scroller.scrollTop).toBe(0);
        expect(document.activeElement).toBe(document.body);
    });
});

describe('group-editor opening boundary', () => {
    const twoGroups = [
        { id: 'group-1', name: 'One', chat_id: 'chat-1', chats: ['chat-1'], members: ['alice.png'], disabled_members: [] },
        { id: 'group-2', name: 'Two', chat_id: 'chat-2', chats: ['chat-2'], members: ['bob.png'], disabled_members: [] },
    ];

    test('reopens selected or nonselected group presentations without switching chats unless requested', async () => {
        const { groupChats, mocks } = await setupGroupApp({ groups: twoGroups, openGroup: 'group-1', selectEditor: 'group-1' });
        mocks.script.selectRightMenuWithAnimation.mockClear();

        await expect(groupChats.openGroupEditor('group-1')).resolves.toBe(true);
        expect(groupChats.selected_group).toBe('group-1');
        expect(groupChats.openGroupId).toBe('group-1');

        await expect(groupChats.openGroupEditor('group-2')).resolves.toBe(true);
        expect(groupChats.openGroupId).toBe('group-2');
        expect(groupChats.selected_group).toBe('group-1');

        await expect(groupChats.openGroupEditor('group-2', { switchChat: true })).resolves.toBe(true);
        expect(groupChats.selected_group).toBe('group-2');
    });

    test('restores an existing unsaved create draft and refuses a missing create draft', async () => {
        const editApp = await setupGroupApp({ groups: twoGroups, openGroup: 'group-1', selectEditor: 'group-1' });
        expect(editApp.groupChats.groupEditorTargetExists('create')).toBe(false);
        expect(editApp.groupChats.groupEditorTargetExists('group-1')).toBe(true);
        expect(editApp.groupChats.groupEditorTargetExists('missing')).toBe(false);
        await expect(editApp.groupChats.openGroupEditor('create')).resolves.toBe(false);

        const createApp = await setupGroupApp({
            groups: twoGroups,
            openGroup: 'group-1',
            selectEditor: null,
            extraOptions: {
                menu_type: 'group_create',
                groupEditor: { captureGroupEditorSave: jest.fn(() => ({ context: { mode: 'create' } })) },
            },
        });
        expect(createApp.groupChats.groupEditorTargetExists('create')).toBe(true);
        await expect(createApp.groupChats.openGroupEditor('create')).resolves.toBe(true);
        expect(createApp.groupChats.openGroupId).toBeNull();
        expect(createApp.groupChats.selected_group).toBe('group-1');
    });

    test('propagates refused chat switches and stops waiting once superseded', async () => {
        const refusedApp = await setupGroupApp({
            groups: twoGroups,
            openGroup: 'group-1',
            selectEditor: 'group-1',
            extraOptions: { is_send_press: true },
        });
        await expect(refusedApp.groupChats.openGroupEditor('group-2', { switchChat: true })).resolves.toBe(false);

        const staleApp = await setupGroupApp({ groups: twoGroups, openGroup: 'group-1', selectEditor: 'group-1' });
        await expect(staleApp.groupChats.openGroupEditor('group-2', { isCurrent: () => false })).resolves.toBe(false);
        expect(staleApp.groupChats.openGroupId).toBe('group-1');

        let current = true;
        document.getElementById('rm_group_chats_block').getClientRects = () => [];
        staleApp.mocks.utils.delay.mockImplementation(async () => { current = false; });
        await expect(staleApp.groupChats.openGroupEditor('group-2', { isCurrent: () => current })).resolves.toBe(false);
        expect(staleApp.mocks.utils.delay).toHaveBeenCalledTimes(1);

        // Superseded explicit chat switch cannot report readiness.
        let finishFlush;
        const switchApp = await setupGroupApp({ groups: twoGroups, openGroup: 'group-1', selectEditor: 'group-1' });
        switchApp.mocks.script.flushPendingChatSavesForNavigation.mockReturnValueOnce(new Promise(resolve => { finishFlush = resolve; }));
        let active = true;
        const opening = switchApp.groupChats.openGroupEditor('group-2', { switchChat: true, isCurrent: () => active });
        active = false;
        finishFlush(true);
        await expect(opening).resolves.toBe(false);
    });
});

describe('native group stylesheet readiness', () => {
    test('an errored sheet prevents reveal and reopening retries the actual deferred dependencies', async () => {
        const { groupChats, mocks } = await setupGroupApp({
            selectEditor: false,
            extraOptions: {
                groupEditor: {
                    prepareGroupEditorReveal: realPrepareGroupEditorReveal,
                },
            },
        });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const root = document.getElementById('rm_group_chats_block');

        try {
            const opening = groupChats.openGroupEditor('group-1');
            expect(root.style.visibility).toBe('hidden');
            expect(root.inert).toBe(true);
            const ids = ['deferred-editor-shell-css', 'deferred-entity-list-css', 'deferred-rm-groups-css', 'deferred-editor-chrome-css'];
            const failed = document.getElementById(ids[1]);
            document.getElementById(ids[0]).dispatchEvent(new Event('load'));
            document.getElementById(ids[2]).dispatchEvent(new Event('load'));
            document.getElementById(ids[3]).dispatchEvent(new Event('load'));
            failed.dispatchEvent(new Event('error'));
            await expect(opening).resolves.toBe(false);
            expect(root.style.visibility).toBe('hidden');
            expect(mocks.toastr.error).toHaveBeenCalledTimes(1);

            const reopening = groupChats.openGroupEditor('group-1');
            const retry = document.getElementById(ids[1]);
            expect(retry).not.toBe(failed);
            expect(failed.isConnected).toBe(false);
            expect(root.style.visibility).toBe('hidden');
            retry.dispatchEvent(new Event('load'));
            await expect(reopening).resolves.toBe(true);
            expect(root.inert).toBe(false);
            expect(root.style.visibility).toBe('');
            expect(document.head.querySelectorAll('link')).toHaveLength(4);
        } finally {
            errorSpy.mockRestore();
        }
    });
});

describe('candidate Add focus', () => {
    const threeCandidates = [
        { avatar: 'a.png', name: 'A' },
        { avatar: 'b.png', name: 'B' },
        { avatar: 'c.png', name: 'C' },
    ];

    test.each([[0, 'b.png'], [2, 'b.png']])('focuses a neighbouring candidate when index %i is added', async (index, expected) => {
        await setupGroupApp({
            characters: threeCandidates,
            groups: [{ id: 'group-1', name: 'G', chat_id: 'c1', chats: ['c1'], members: [], disabled_members: [], member_models: {} }],
        });
        const rows = document.querySelectorAll('#rm_group_add_members .group_member');
        rows[index].querySelector('.ch_name').click();
        await settle();
        expect(document.activeElement.dataset.avatar).toBe(expected);
    });

    test('focuses search when the last candidate leaves the list', async () => {
        await setupGroupApp({
            characters: [{ avatar: 'a.png', name: 'A' }],
            groups: [{ id: 'group-1', name: 'G', chat_id: 'c1', chats: ['c1'], members: [], disabled_members: [], member_models: {} }],
        });
        document.querySelector('#rm_group_add_members .group_member .ch_name').click();
        await settle();
        expect(document.activeElement.id).toBe('rm_group_filter');
    });

    test('does not steal focus after the editor draft changes during hydration', async () => {
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        const { groupChats } = await setupGroupApp({
            characters: [
                { avatar: 'anchor.png', name: 'Anchor' },
                { avatar: 'a.png', name: 'A' },
            ],
            groups: [{ id: 'group-1', name: 'G', chat_id: 'c1', chats: ['c1'], members: ['anchor.png'], disabled_members: [], member_models: {} }],
            extraOptions: {
                script: { unshallowCharacter: jest.fn(() => pending) },
            },
        });
        document.querySelector('#rm_group_add_members .group_member[data-avatar="a.png"] .ch_name').click();
        await settle();
        // Replace editor draft before unshallow finishes.
        groupChats.select_group_chats('group-1', false);
        document.body.focus();
        release();
        await settle();
        expect(document.activeElement).toBe(document.body);
    });

    test('focuses the previous page’s last row when the final candidate page disappears', async () => {
        const characters = Array.from({ length: 6 }, (_, index) => ({ avatar: `c${index}.png`, name: `C${index}` }));
        await setupGroupApp({
            characters,
            groups: [{ id: 'group-1', name: 'G', chat_id: 'c1', chats: ['c1'], members: [], disabled_members: [], member_models: {} }],
        });
        // Navigate candidates to page 2 (contains only c5.png), then add c5.png so page 2 collapses to page 1.
        const nextButton = document.querySelector('#rm_group_add_members_pagination button[aria-label*="Next"], #rm_group_add_members_pagination .ds-pagination__next');
        if (nextButton) {
            nextButton.click();
        } else {
            const pageButtons = [...document.querySelectorAll('#rm_group_add_members_pagination button')];
            pageButtons.find(btn => btn.textContent.trim() === '2' || btn.dataset.page === '2')?.click();
        }
        const onlyRowOnPage2 = document.querySelector('#rm_group_add_members .group_member');
        expect(onlyRowOnPage2.dataset.avatar).toBe('c5.png');
        onlyRowOnPage2.querySelector('.ch_name').click();
        await settle();
        expect(document.activeElement.dataset.avatar).toBe('c4.png');
    });
});

describe('group list search and pagination controllers', () => {
    test('mounts scoped, labelled 300ms search and keeps the field visible on Escape', async () => {
        const clear = jest.fn();
        const createListSearch = jest.fn(() => ({ clear }));
        const { groupChats } = await setupGroupApp({
            selectEditor: false,
            extraOptions: {
                mockListSearch: { createListSearch },
            },
        });
        const input = document.getElementById('rm_group_filter');
        const candidateCall = createListSearch.mock.calls.find(([opts]) => opts.input === input)[0];
        expect(candidateCall).toEqual(expect.objectContaining({
            debounce: 300,
            scope: input.closest('section'),
            status: input.closest('section').querySelector('[data-sb-group-list-status]'),
        }));
        expect(input.getAttribute('aria-label')).toBe('Search');

        const setFilterSpy = jest.spyOn(groupChats.groupCandidatesFilter, 'setFilterData');
        candidateCall.onChange('ALICE');
        expect(setFilterSpy).toHaveBeenCalledWith('search', 'alice');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(clear).toHaveBeenCalledTimes(1);
        expect(input.parentElement.hidden).toBe(false);
    });

    test('retains the native paginator, storage keys and member page across renders', async () => {
        const created = [];
        const createListPagination = jest.fn(options => {
            const pagination = {
                element: document.createElement('nav'),
                page: 2,
                setTotal: jest.fn(),
                slice: entries => entries,
                goTo: jest.fn(),
            };
            created.push({ options, pagination });
            return pagination;
        });
        const { groupChats, mocks } = await setupGroupApp({
            extraOptions: {
                mockListPagination: { createListPagination },
            },
        });

        const membersHost = document.getElementById('rm_group_members_pagination');
        const membersEntry = created.find(entry => membersHost.contains(entry.pagination.element));
        expect(membersEntry).toBeDefined();
        const { options, pagination } = membersEntry;
        expect(options.keepSizeVisible).toBe(true);
        expect(options.pageSizes).toEqual([5, 10, 25, 50, 100, 200, 500, 1000]);
        expect(options.readPageSize()).toBe(5);
        expect(mocks.accountStorage.getItem).toHaveBeenCalledWith('GroupMembers_PerPage');
        options.writePageSize(25);
        expect(mocks.accountStorage.setItem).toHaveBeenCalledWith('GroupMembers_PerPage', '25');

        const candidatesHost = document.getElementById('rm_group_add_members_pagination');
        const candidatesEntry = created.find(entry => candidatesHost.contains(entry.pagination.element));
        expect(candidatesEntry).toBeDefined();
        expect(candidatesEntry.options.readPageSize()).toBe(5);
        expect(mocks.accountStorage.getItem).toHaveBeenCalledWith('GroupCandidates_PerPage');
        candidatesEntry.options.writePageSize(10);
        expect(mocks.accountStorage.setItem).toHaveBeenCalledWith('GroupCandidates_PerPage', '10');

        // Re-selecting keeps the same paginator instance and preserves its page.
        const initialCalls = createListPagination.mock.calls.length;
        groupChats.select_group_chats('group-1', false);
        expect(createListPagination).toHaveBeenCalledTimes(initialCalls);
        options.onChange();
        expect(pagination.page).toBe(2);
    });
});
