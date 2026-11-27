/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importTagsModule } from '../util/tags-module-harness.js';

afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

async function setupTagPersistence() {
    document.body.innerHTML = `
        <div id="rm_characters_block">
            <div class="rm_tag_controls">
                <div class="rm_tag_filter"></div>
            </div>
        </div>
        <div class="tags"></div>
    `;

    // Use the real FilterHelper from public/scripts/filters.js via a fresh state container.
    const filterState = {
        search: '',
        tag: { selected: [], excluded: [] },
        fav: false,
        folder: false,
        group: false,
        world_info_search: '',
        persona_search: '',
    };
    const entitiesFilter = {
        getFilterData: type => filterState[type],
        setFilterData: (type, value) => { filterState[type] = value; },
        applyFilters: list => list,
        getScore: () => 0,
    };

    const loaded = await importTagsModule({
        entitiesFilter,
        accountStorage: {
            CharacterList_TagFilterState_FAV: 'EXCLUDED',
            CharacterList_tag_character: 'SELECTED',
            GroupList_TagFilterState_FAV: 'SELECTED',
            GroupList_tag_group: 'EXCLUDED',
        },
        characters: [{ avatar: 'a.png', name: 'Alpha' }],
    });

    loaded.tagsModule.loadTagsSettings({
        tags: [
            { id: 'character', name: 'Character Tag', filter_state: 'SELECTED', color: '', color2: '', folder_type: 'NONE' },
            { id: 'group', name: 'Group Tag', filter_state: 'UNDEFINED', color: '', color2: '', folder_type: 'NONE' },
        ],
        tag_map: { 'a.png': ['character', 'group'] },
    });

    return { ...loaded, filterState };
}

describe('view-scoped upstream tag persistence in tags.js', () => {
    test('real replacing loader clears absent states and never appends outgoing tag arrays', async () => {
        const { tagsModule, filterState } = await setupTagPersistence();
        filterState.tag = { selected: ['outgoing'], excluded: ['old'] };
        filterState.group = 'SELECTED';

        tagsModule.loadMainListFilterStates('groups');
        expect(filterState.tag).toEqual({ selected: [], excluded: ['group'] });
        expect(filterState.fav).toBe('SELECTED');
        expect(filterState.group).toBe(false);
        expect(tagsModule.getMainListFilterStoragePrefix()).toBe('GroupList');

        tagsModule.loadMainListFilterStates('characters');
        expect(filterState.tag).toEqual({ selected: ['character'], excluded: [] });
        expect(filterState.fav).toBe('EXCLUDED');
        expect(tagsModule.getMainListFilterStoragePrefix()).toBe('CharacterList');
    });

    test('Groups persist clicks independently and leave Characters compatibility metadata untouched', async () => {
        const { tagsModule, state, mocks, $ } = await setupTagPersistence();
        tagsModule.initTags();
        tagsModule.loadMainListFilterStates('groups');
        tagsModule.printTagFilters(tagsModule.tag_filter_type.character);

        const filterRoot = $('#rm_characters_block .rm_tag_filter');
        const favTag = filterRoot.find('.filterByFavorites');
        const charTag = filterRoot.find('#character');
        expect(favTag.length).toBe(1);
        expect(charTag.length).toBe(1);

        // In GroupList, clicking Favorites cycles SELECTED -> EXCLUDED and stores under GroupList_* only.
        favTag.trigger('click');
        expect(state.storage.get('GroupList_TagFilterState_FAV')).toBe('EXCLUDED');

        // In GroupList, clicking regular tag #character cycles UNDEFINED -> SELECTED -> EXCLUDED without touching CharacterList metadata or saving settings.
        mocks.script.saveSettingsDebounced.mockClear();
        charTag.trigger('click');
        charTag.trigger('click');
        expect(state.storage.get('GroupList_tag_character')).toBe('EXCLUDED');
        expect(tagsModule.tags.find(t => t.id === 'character').filter_state).toBe('SELECTED');
        expect(mocks.script.saveSettingsDebounced).not.toHaveBeenCalled();

        // Switching back to CharacterList restores CharacterList state; clicking #character cycles SELECTED -> EXCLUDED and persists metadata.
        tagsModule.loadMainListFilterStates('characters');
        tagsModule.printTagFilters(tagsModule.tag_filter_type.character);
        $('#rm_characters_block .rm_tag_filter #character').trigger('click');
        expect(state.storage.get('CharacterList_tag_character')).toBe('EXCLUDED');
        expect(tagsModule.tags.find(t => t.id === 'character').filter_state).toBe('EXCLUDED');
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('a group-only active tag remains visible beyond the 50-tag cutoff without legacy state', async () => {
        const { tagsModule, filterState, $ } = await setupTagPersistence();
        filterState.tag = { selected: ['tag-59'], excluded: [] };
        const manyTags = Array.from({ length: 60 }, (_, index) => ({
            id: `tag-${index}`,
            name: `Tag ${index}`,
            filter_state: 'UNDEFINED',
            color: '',
            color2: '',
            folder_type: 'NONE',
        }));

        const container = $('.tags');
        tagsModule.printTagList(container, {
            tags: manyTags,
            empty: true,
            sort: false,
            tagOptions: { isGeneralList: true, isFilter: true },
        });

        const printedIds = container.find('.tag').toArray().map(el => el.id);
        expect(printedIds).toContain('tag-59');
        expect(printedIds).not.toContain('tag-58');
        expect(manyTags[59].filter_state).toBe('UNDEFINED');
    });
});
