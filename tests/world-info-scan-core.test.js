import { describe, expect, jest, test } from '@jest/globals';

import {
    getTimedEffectWindow,
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
});

describe('World Info timed effect windows', () => {
    test('uses the upstream duration boundary', () => {
        const { start, end } = getTimedEffectWindow(10, 1);
        expect(start).toBe(10);
        expect(end).toBe(11);
    });

    test('does not extend the duration window', () => {
        expect(getTimedEffectWindow(10, 3)).toEqual({ start: 10, end: 13 });
    });

    test('coerces string durations from legacy metadata', () => {
        expect(getTimedEffectWindow(5, '2')).toEqual({ start: 5, end: 7 });
    });
});
