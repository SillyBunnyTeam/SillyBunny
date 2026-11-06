import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function loadMemberActions({ draftMembers, liveMembers, unshallow = async () => {} }) {
    const source = await fs.readFile(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
    const functions = ['async function modifyGroupMember(', 'function _applyMemberActionToEditor(', 'function _editDraft(', 'function applyMemberAction('];
    const extracted = functions.map(signature => {
        const start = source.indexOf(signature);
        const end = source.indexOf('\n}', start) + 2;
        if (start < 0 || end < 2) throw new Error(`Missing member function: ${signature}`);
        return source.slice(start, end);
    }).join('\n');
    const group = { id: 'fixture', members: [...liveMembers], disabled_members: [], member_models: {} };
    const draft = { ...structuredClone(group), members: [...draftMembers] };
    const editGroup = jest.fn();
    const context = vm.createContext({
        groups: [group],
        openGroupId: group.id,
        editorDraft: draft,
        editGroup,
        notifyGroupEditorChanged: jest.fn(),
        unshallowGroupMembers: unshallow,
        printGroupCandidates: jest.fn(),
        printGroupMembers: jest.fn(),
        printTagFilters: jest.fn(),
        tag_filter_type: {},
        getGroupCharacters: () => draft.members,
        updateGroupAvatar: jest.fn(),
        $: () => ({ prop: jest.fn() }),
    });
    vm.runInContext(`${extracted}\nthis.modifyGroupMember = modifyGroupMember;`, context);
    const member = { data: () => 'candidate.png', attr: () => 'candidate.png' };
    return { group, draft, editGroup, member, modify: context.modifyGroupMember };
}

describe('group member draft ownership', () => {
    test('a duplicate add while unshallowing never falls through to live persistence', async () => {
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        const actions = await loadMemberActions({ draftMembers: [], liveMembers: [], unshallow: () => pending });
        const firstAdd = actions.modify('fixture', actions.member, false);
        try {
            await actions.modify('fixture', actions.member, false);
            expect(actions.draft.members).toEqual(['candidate.png']);
            expect(actions.group.members).toEqual([]);
            expect(actions.editGroup).not.toHaveBeenCalled();
        } finally {
            release();
            await firstAdd;
        }
        expect(actions.editGroup).not.toHaveBeenCalled();
    });

    test('removing an already-removed draft member never removes the live member', async () => {
        const actions = await loadMemberActions({ draftMembers: [], liveMembers: ['candidate.png'] });
        await actions.modify('fixture', actions.member, true);
        expect(actions.draft.members).toEqual([]);
        expect(actions.group.members).toEqual(['candidate.png']);
        expect(actions.editGroup).not.toHaveBeenCalled();
    });
});
