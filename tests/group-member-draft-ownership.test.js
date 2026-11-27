/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { importGroupChatsModule } from './util/group-chats-module-harness.js';

function mountEditorDom() {
    document.body.innerHTML = `
        <div id="rm_group_chats_block">
            <div id="rm_group_members" class="rm_group_members"></div>
            <div id="rm_group_members_pagination"></div>
            <div id="rm_group_add_members"></div>
            <div id="rm_group_add_members_pagination"></div>
        </div>
    `;
}

async function setupDraftOwnedGroup({ liveMembers, unshallow = async () => {} }) {
    mountEditorDom();
    const editCalls = [];
    const group = {
        id: 'fixture',
        chat_id: 'chat-fixture',
        chats: ['chat-fixture'],
        name: 'Fixture Group',
        members: [...liveMembers],
        disabled_members: [],
        member_models: {},
    };
    const loaded = await importGroupChatsModule({
        characters: [
            { name: 'Candidate', avatar: 'candidate.png' },
            { name: 'Anchor', avatar: 'anchor.png' },
        ],
        fetch: jest.fn(async (url, request = {}) => {
            if (url === '/api/groups/all') {
                return { ok: true, json: async () => [structuredClone(group)] };
            }
            if (url === '/api/groups/edit') {
                editCalls.push(JSON.parse(request.body ?? '{}'));
                return { ok: true, json: async () => ({ ok: true }) };
            }
            return { ok: true, json: async () => ({ ok: true }) };
        }),
        script: {
            unshallowCharacter: jest.fn(unshallow),
        },
        groupEditor: {
            isGroupEditorOwner: jest.fn(() => true),
        },
    });
    await loaded.runReady();
    await loaded.groupChats.getGroups();
    loaded.groupChats.select_group_chats('fixture', false);
    return { ...loaded, editCalls };
}

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('group member draft ownership', () => {
    test('a duplicate add while unshallowing never falls through to live persistence', async () => {
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        // Live group holds anchor.png so unshallowGroupMembers genuinely pauses on unshallowCharacter.
        const { groupChats, editCalls } = await setupDraftOwnedGroup({
            liveMembers: ['anchor.png'],
            unshallow: () => pending,
        });

        const firstAdd = groupChats.runGroupMemberActionByChid(0, 'add');
        try {
            await groupChats.runGroupMemberActionByChid(0, 'add');
            expect(document.querySelectorAll('#rm_group_members .group_member[data-avatar="candidate.png"]')).toHaveLength(1);
            expect(groupChats.groups[0].members).toEqual(['anchor.png']);
            expect(editCalls).toEqual([]);
        } finally {
            release();
            await firstAdd;
        }
        expect(groupChats.groups[0].members).toEqual(['anchor.png']);
        expect(editCalls).toEqual([]);
    });

    test('removing an already-removed draft member never removes the live member', async () => {
        const { groupChats, editCalls } = await setupDraftOwnedGroup({
            liveMembers: ['candidate.png'],
        });

        // First remove takes candidate.png out of editorDraft while keeping live groups[0].members intact.
        await groupChats.runGroupMemberActionByChid(0, 'remove');
        expect(document.querySelectorAll('#rm_group_members .group_member')).toHaveLength(0);
        expect(groupChats.groups[0].members).toEqual(['candidate.png']);

        // Removing the already-removed member a second time must not fall through to the live group.
        await groupChats.runGroupMemberActionByChid(0, 'remove');
        expect(groupChats.groups[0].members).toEqual(['candidate.png']);
        expect(editCalls).toEqual([]);
    });
});
