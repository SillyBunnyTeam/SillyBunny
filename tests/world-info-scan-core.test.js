import { describe, expect, jest, test } from '@jest/globals';

import {
    getWorldInfoEntryKey,
    getWorldInfoGroupNames,
    normalizeWorldInfoKey,
    normalizeWorldInfoProbability,
    passesWorldInfoProbability,
} from '../public/scripts/world-info-scan-core.js';

describe('World Info scan probability', () => {
    test('normalizes CharacterBook extension fields', () => {
        expect(normalizeWorldInfoProbability({ extensions: { probability: 25, useProbability: false } })).toMatchObject({
            probability: 25,
            useProbability: false,
        });
    });

    test('preserves explicit top-level zero and false values', () => {
        expect(normalizeWorldInfoProbability({
            probability: 0,
            useProbability: false,
            extensions: { probability: 75, useProbability: true },
        })).toMatchObject({
            probability: 0,
            useProbability: false,
        });
    });

    test('never activates zero percent, including a zero roll', () => {
        expect(passesWorldInfoProbability({ probability: 0, useProbability: true }, () => 0)).toBe(false);
    });

    test('uses a strict percentage boundary', () => {
        expect(passesWorldInfoProbability({ probability: 50, useProbability: true }, () => 0.499)).toBe(true);
        expect(passesWorldInfoProbability({ probability: 50, useProbability: true }, () => 0.5)).toBe(false);
    });

    test('always activates disabled, sticky, and 100 percent checks without rolling', () => {
        const random = jest.fn(() => 0.99);
        expect(passesWorldInfoProbability({ probability: 1, useProbability: false }, random)).toBe(true);
        expect(passesWorldInfoProbability({ probability: 1, useProbability: true }, random, true)).toBe(true);
        expect(passesWorldInfoProbability({ probability: 100, useProbability: true }, random)).toBe(true);
        expect(random).not.toHaveBeenCalled();
    });
});

describe('World Info scan normalization', () => {
    test('rejects keys that are empty after substitution and trimming', () => {
        expect(normalizeWorldInfoKey('   ', value => value)).toBeNull();
        expect(normalizeWorldInfoKey('{{empty}}', () => '')).toBeNull();
        expect(normalizeWorldInfoKey('  {{user}}  ', () => ' Alice ')).toBe('Alice');
    });

    test('parses unique nonempty inclusion-group names', () => {
        expect(getWorldInfoGroupNames(' alpha, beta, alpha, , gamma ')).toEqual(['alpha', 'beta', 'gamma']);
        expect(getWorldInfoGroupNames(null)).toEqual([]);
    });

    test('uses the world and UID as stable entry identity', () => {
        expect(getWorldInfoEntryKey({ world: 'Lore', uid: 7 })).toBe('Lore.7');
    });
});
