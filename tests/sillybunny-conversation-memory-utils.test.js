import { describe, expect, test } from '@jest/globals';

import {
    collectGroupConversationMemorySummaries,
    collectSoloConversationMemorySummary,
} from '../public/scripts/sillybunny-conversation/memory-utils.js';

const source = (overrides = {}) => ({ groupId: '', avatar: 'char_a', members: ['char_a'], summary: '', updatedAt: 0, ...overrides });

describe('sillybunny conversation memory utils', () => {
    test('collects the active solo memory summary for a character', () => {
        const sources = [
            source({ summary: '  Solo promise and private joke.  ', updatedAt: 100 }),
            source({ groupId: 'alpha', members: ['char_a', 'char_b'], summary: 'A group memory', updatedAt: 900 }),
        ];

        expect(collectSoloConversationMemorySummary(sources, 'char_a')).toEqual({
            avatar: 'char_a',
            summary: 'Solo promise and private joke.',
            updatedAt: 100,
        });
        expect(collectSoloConversationMemorySummary(sources, 'missing')).toBeNull();
        expect(collectSoloConversationMemorySummary([source({ summary: '   ' })], 'char_a')).toBeNull();
        expect(collectSoloConversationMemorySummary(null, 'char_a')).toBeNull();
    });

    test('collects group memories for a member newest first and skips empty ones', () => {
        const sources = [
            source({ summary: 'Solo memory', updatedAt: 400 }),
            source({ groupId: 'alpha', members: ['char_a', 'char_b'], summary: '  Alpha group memory.  ', updatedAt: 200 }),
            source({ groupId: 'beta', members: ['char_a', 'char_c'], summary: 'Beta memory.', updatedAt: 300 }),
            source({ groupId: 'gamma', members: ['char_b', 'char_c'], summary: 'Wrong member memory.', updatedAt: 500 }),
            source({ groupId: 'empty', members: ['char_a', 'char_b'], summary: '   ', updatedAt: 600 }),
        ];

        expect(collectGroupConversationMemorySummaries(sources, 'char_a', {
            getGroupName: groupId => ({ alpha: 'Alpha Squad', beta: 'Beta Crew' }[groupId]),
        })).toEqual([
            { groupId: 'beta', groupName: 'Beta Crew', summary: 'Beta memory.', updatedAt: 300 },
            { groupId: 'alpha', groupName: 'Alpha Squad', summary: 'Alpha group memory.', updatedAt: 200 },
        ]);
    });

    test('limits and excludes group memories', () => {
        const sources = [
            source({ groupId: 'alpha', members: ['char_a', 'char_b'], summary: 'Alpha.', updatedAt: 100 }),
            source({ groupId: 'beta', members: ['char_a', 'char_b'], summary: 'Beta.', updatedAt: 200 }),
            source({ groupId: 'gamma', members: ['char_a', 'char_b'], summary: 'Gamma.', updatedAt: 300 }),
        ];

        expect(collectGroupConversationMemorySummaries(sources, 'char_a', { excludeGroupId: 'gamma', max: 1 })).toEqual([
            { groupId: 'beta', groupName: '', summary: 'Beta.', updatedAt: 200 },
        ]);
        expect(collectGroupConversationMemorySummaries(sources, 'char_a', { max: 0 })).toEqual([]);
    });
});
