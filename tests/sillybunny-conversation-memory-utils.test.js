import { describe, expect, test } from '@jest/globals';

import {
    collectGroupConversationMemorySummaries,
    collectSoloConversationMemorySummary,
} from '../public/scripts/sillybunny-conversation/memory-utils.js';

describe('sillybunny conversation memory utils', () => {
    test('collects the active solo memory summary for a character', () => {
        const store = {
            char_a: {
                activeBranchId: 'main',
                branches: {
                    main: { memorySummary: '  Solo promise and private joke.  ', updatedAt: 100 },
                },
            },
        };

        expect(collectSoloConversationMemorySummary(store, 'char_a')).toEqual({
            avatar: 'char_a',
            summary: 'Solo promise and private joke.',
            updatedAt: 100,
        });
        expect(collectSoloConversationMemorySummary(store, 'missing')).toBeNull();
    });

    test('collects group memories for the same avatar newest first', () => {
        const store = {
            char_a: {
                activeBranchId: 'main',
                branches: {
                    main: { memorySummary: 'Solo memory', updatedAt: 400 },
                },
            },
            'group:alpha:char_a': {
                activeBranchId: 'main',
                branches: {
                    main: { memorySummary: '  Alpha group memory.  ', updatedAt: 200 },
                },
            },
            'group:beta:char_a': {
                activeBranchId: 'branch_2',
                branches: {
                    main: { memorySummary: 'Old beta memory.', updatedAt: 100 },
                    branch_2: { memorySummary: 'Beta branch memory.', updatedAt: 300 },
                },
            },
            'group:gamma:char_b': {
                activeBranchId: 'main',
                branches: {
                    main: { memorySummary: 'Wrong avatar memory.', updatedAt: 500 },
                },
            },
            'group:empty:char_a': {
                activeBranchId: 'main',
                branches: {
                    main: { memorySummary: '   ', updatedAt: 600 },
                },
            },
        };

        expect(collectGroupConversationMemorySummaries(store, 'char_a', {
            getGroupName: groupId => ({ alpha: 'Alpha Squad', beta: 'Beta Crew' }[groupId]),
        })).toEqual([
            { groupId: 'beta', groupName: 'Beta Crew', summary: 'Beta branch memory.', updatedAt: 300 },
            { groupId: 'alpha', groupName: 'Alpha Squad', summary: 'Alpha group memory.', updatedAt: 200 },
        ]);
    });

    test('limits and excludes group memories', () => {
        const store = {
            'group:alpha:char_a': { branches: { main: { memorySummary: 'Alpha.', updatedAt: 100 } } },
            'group:beta:char_a': { branches: { main: { memorySummary: 'Beta.', updatedAt: 200 } } },
            'group:gamma:char_a': { branches: { main: { memorySummary: 'Gamma.', updatedAt: 300 } } },
        };

        expect(collectGroupConversationMemorySummaries(store, 'char_a', { excludeGroupId: 'gamma', max: 1 })).toEqual([
            { groupId: 'beta', groupName: '', summary: 'Beta.', updatedAt: 200 },
        ]);
    });
});
