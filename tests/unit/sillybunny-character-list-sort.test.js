/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importPowerUserModule } from '../util/power-user-harness.js';

afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('isolated entity list sorting in power-user.js', () => {
    test('group sorts do not mutate power_user and search relevance still takes priority', async () => {
        jest.resetModules();
        document.body.innerHTML = '<select id="character_sort_order"><option data-field="search">Search</option><option selected data-field="name">Name</option></select>';

        const loaded = await importPowerUserModule({
            script: {
                entitiesFilter: {
                    getScore: (_type, id) => (id === 'group.a' ? 0.1 : 0.9),
                },
            },
        });
        Object.assign(loaded.powerUser.power_user, {
            sort_field: 'name',
            sort_order: 'desc',
            sort_rule: null,
        });

        const entities = [
            { id: 'a', type: 'group', item: { name: 'A', chat_size: 4 } },
            { id: 'b', type: 'group', item: { name: 'B', chat_size: 8 } },
        ];

        loaded.powerUser.sortEntitiesList(entities, false, null, { field: 'chat_size', order: 'desc' });
        expect(entities.map(entity => entity.id)).toEqual(['b', 'a']);
        expect(loaded.powerUser.power_user).toMatchObject({ sort_field: 'name', sort_order: 'desc', sort_rule: null });

        loaded.powerUser.sortEntitiesList(entities, true, null, { field: 'chat_size', order: 'desc' });
        expect(entities.map(entity => entity.id)).toEqual(['a', 'b']);

        loaded.powerUser.sortEntitiesList(entities, false);
        expect(entities.map(entity => entity.id)).toEqual(['b', 'a']);
    });
});
