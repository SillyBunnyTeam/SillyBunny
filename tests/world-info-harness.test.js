import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { WORLD_INFO_LOGIC } from './util/world-info-cases.js';
import { createHarness } from './util/world-info-harness.js';

beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('World Info harness module exports and ordering', () => {
    test('exposes the real world-info.js scan enums and defaults', async () => {
        const { worldInfo } = await createHarness();

        expect(worldInfo.world_info_insertion_strategy).toEqual({ evenly: 0, character_first: 1, global_first: 2 });
        expect(worldInfo.world_info_logic).toEqual(WORLD_INFO_LOGIC);
        expect(worldInfo.scan_state).toEqual({ NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 });
        expect(worldInfo.world_info_position).toEqual({
            before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7,
        });
        expect(worldInfo.wi_anchor_position).toEqual({ before: 0, after: 1 });
        expect(worldInfo.DEFAULT_DEPTH).toBe(4);
        expect(worldInfo.DEFAULT_WEIGHT).toBe(100);
        expect(worldInfo.MAX_SCAN_DEPTH).toBe(1000);
    });

    test('orders entries descending by order during getSortedEntries', async () => {
        const harness = await createHarness({
            books: {
                'Order Book': {
                    entries: {
                        1: { uid: 1, key: ['a'], content: 'low', order: 10 },
                        2: { uid: 2, key: ['a'], content: 'high', order: 200 },
                        3: { uid: 3, key: ['a'], content: 'mid', order: 50 },
                    },
                },
            },
            selectedWorldInfo: ['Order Book'],
            charLore: [],
            state: {
                characters: [{ name: 'Aster', avatar: 'aster.png', data: { extensions: {} } }],
                chat_metadata: {},
                power_user: {},
            },
        });

        const sorted = await harness.worldInfo.getSortedEntries();
        expect(sorted.map(entry => entry.uid)).toEqual([2, 3, 1]);
    });
});
