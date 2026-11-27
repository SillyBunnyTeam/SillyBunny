/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importTagsModule } from '../util/tags-module-harness.js';

afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('tag filter presentation caching', () => {
    test('skips rebuilding unchanged tag filter bars and invalidates only the affected list', async () => {
        document.body.innerHTML = `
            <div id="rm_characters_block">
                <div class="rm_tag_controls">
                    <div class="rm_tag_filter" id="characters_tags"></div>
                </div>
            </div>
            <div id="currentGroupMembers">
                <div id="rm_group_members_header"></div>
                <div class="rm_tag_controls">
                    <div class="rm_tag_filter" id="members_tags"></div>
                </div>
            </div>
            <div id="unaddedCharList">
                <div id="rm_group_add_members_header"></div>
                <div class="rm_tag_controls">
                    <div class="rm_tag_filter" id="candidates_tags"></div>
                </div>
            </div>
        `;

        const filterState = {
            characters: { tag: { selected: [], excluded: [] }, search: '', fav: 'UNDEFINED', folder: 'UNDEFINED', group: 'UNDEFINED' },
            members: { tag: { selected: [], excluded: [] }, search: '', fav: 'UNDEFINED', folder: 'UNDEFINED', group: 'UNDEFINED' },
            candidates: { tag: { selected: [], excluded: [] }, search: '', fav: 'UNDEFINED', folder: 'UNDEFINED', group: 'UNDEFINED' },
        };

        const makeFilterHelper = bucket => ({
            getFilterData: jest.fn(type => filterState[bucket][type]),
            setFilterData: jest.fn((type, val) => { filterState[bucket][type] = val; }),
            applyFilters: jest.fn(list => list),
            getScore: jest.fn(() => 0),
        });

        const loaded = await importTagsModule({
            entitiesFilter: makeFilterHelper('characters'),
            groupMembersFilter: makeFilterHelper('members'),
            groupCandidatesFilter: makeFilterHelper('candidates'),
            characters: [{ avatar: 'a.png', name: 'Alpha' }],
            groups: [{ id: 'g1', name: 'Group', members: ['a.png'] }],
            selected_group: 'g1',
        });

        loaded.tagsModule.loadTagsSettings({
            tags: [{ id: 'a', name: 'Tag A', color: '', color2: '', folder_type: 'NONE', filter_state: 'UNDEFINED' }],
            tag_map: { 'a.png': ['a'] },
        });

        const charRoot = document.getElementById('characters_tags');
        const membersRoot = document.getElementById('members_tags');
        const candidatesRoot = document.getElementById('candidates_tags');

        const types = [0, 1, 2]; // character, group_members_list, group_candidates_list
        for (const type of types) loaded.tagsModule.printTagFilters(type);

        expect(charRoot.childElementCount).toBeGreaterThan(0);
        expect(membersRoot.childElementCount).toBeGreaterThan(0);
        expect(candidatesRoot.childElementCount).toBeGreaterThan(0);

        const charFirst = charRoot.firstElementChild;
        const membersFirst = membersRoot.firstElementChild;
        const candidatesFirst = candidatesRoot.firstElementChild;

        // Re-running with identical state must keep all rendered DOM nodes intact.
        for (const type of types) loaded.tagsModule.printTagFilters(type);
        expect(charRoot.firstElementChild).toBe(charFirst);
        expect(membersRoot.firstElementChild).toBe(membersFirst);
        expect(candidatesRoot.firstElementChild).toBe(candidatesFirst);

        // Changing search query or legacy tag.filter_state must NOT invalidate cached filter bars.
        filterState.characters.search = 'new query';
        loaded.tagsModule.tags[0].filter_state = 'SELECTED';
        for (const type of types) loaded.tagsModule.printTagFilters(type);
        expect(charRoot.firstElementChild).toBe(charFirst);
        expect(membersRoot.firstElementChild).toBe(membersFirst);
        expect(candidatesRoot.firstElementChild).toBe(candidatesFirst);

        // Changing members tag selection rebuilds ONLY the members bar, leaving characters & candidates cached.
        filterState.members.tag = { selected: ['a'], excluded: [] };
        for (const type of types) loaded.tagsModule.printTagFilters(type);
        expect(charRoot.firstElementChild).toBe(charFirst);
        expect(candidatesRoot.firstElementChild).toBe(candidatesFirst);
        expect(membersRoot.firstElementChild).not.toBe(membersFirst);
    });
});
