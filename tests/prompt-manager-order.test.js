import { describe, expect, test } from '@jest/globals';

import { reorderPromptOrder } from '../public/scripts/prompt-manager-order.js';

describe('prompt order with collapsed groups', () => {
    const order = [
        { identifier: 'main', enabled: true },
        { identifier: 'marker', enabled: true },
        { identifier: 'child-a', enabled: false, customMetadata: 'preserve' },
        { identifier: 'child-b', enabled: true },
        { identifier: 'next-marker', enabled: true },
        { identifier: 'next-child', enabled: false },
    ];

    test('moves collapsed groups intact, including disabled entries and metadata', () => {
        expect(reorderPromptOrder(order, ['next-marker', 'main', 'marker'])).toEqual([
            order[4], order[5], order[0], order[1], order[2], order[3],
        ]);
    });

    test('does not change the order when the visible order is unchanged', () => {
        expect(reorderPromptOrder(order, ['main', 'marker', 'next-marker'])).toEqual(order);
    });

    test('preserves ordinary per-row reordering when groups are expanded', () => {
        expect(reorderPromptOrder(order, ['child-b', 'main', 'marker', 'child-a', 'next-marker', 'next-child'])).toEqual([
            order[3], order[0], order[1], order[2], order[4], order[5],
        ]);
    });

    test('keeps omitted leading entries and trailing children', () => {
        expect(reorderPromptOrder(order, ['next-marker', 'marker'])).toEqual([
            order[0], order[4], order[5], order[1], order[2], order[3],
        ]);
    });

    test('preserves the full order when no rows are available', () => {
        expect(reorderPromptOrder(order, [])).toEqual(order);
    });

    test('preserves the previous order when DOM identifiers are duplicated or unknown', () => {
        expect(reorderPromptOrder(order, ['next-marker', 'main', 'marker', 'marker'])).toEqual(order);
        expect(reorderPromptOrder(order, ['next-marker', 'main', 'marker', '__runtime_agents__'])).toEqual(order);
    });

    test('preserves duplicate entries in the saved order without guessing their identity', () => {
        const duplicated = [...order, { identifier: 'main', enabled: false }];
        expect(reorderPromptOrder(duplicated, ['next-marker', 'main', 'marker'])).toEqual(duplicated);
    });

    test('does not mutate the source entries or array', () => {
        const input = order.map(entry => Object.freeze({ ...entry }));
        Object.freeze(input);
        const reordered = reorderPromptOrder(input, ['next-marker', 'main', 'marker']);
        expect(input).toEqual(order);
        expect(reordered[4]).toBe(input[2]);
    });
});
