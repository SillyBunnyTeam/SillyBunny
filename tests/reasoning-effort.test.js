import { describe, expect, test } from '@jest/globals';
import {
    applyReasoningEffortNormalization,
    isKnownReasoningEffort,
    normalizeReasoningEffort,
    REASONING_EFFORT,
} from '../src/reasoning-effort.js';

describe('normalizeReasoningEffort', () => {
    test('leaves every canonical value untouched', () => {
        for (const value of Object.values(REASONING_EFFORT)) {
            expect(normalizeReasoningEffort(value)).toBe(value);
        }
    });

    test('lowercases values that arrive with UI casing', () => {
        // The reasoning effort <select> shows Title Case labels over lowercase values, so an
        // extension reading textContent instead of value ships "Medium" to the provider.
        expect(normalizeReasoningEffort('Medium')).toBe('medium');
        expect(normalizeReasoningEffort('HIGH')).toBe('high');
        expect(normalizeReasoningEffort('XHigh')).toBe('xhigh');
        expect(normalizeReasoningEffort('MiN')).toBe('min');
    });

    test('trims surrounding whitespace', () => {
        expect(normalizeReasoningEffort(' high ')).toBe('high');
        expect(normalizeReasoningEffort('\tmax\n')).toBe('max');
        expect(normalizeReasoningEffort(' Medium ')).toBe('medium');
    });

    test('reduces a whitespace-only value to an empty string', () => {
        // Every provider branch guards on truthiness, so this is what makes '  ' skip them.
        expect(normalizeReasoningEffort('   ')).toBe('');
        expect(normalizeReasoningEffort('')).toBe('');
    });

    test('preserves unrecognized values instead of dropping them', () => {
        // OpenAI-compatible proxies take vocabulary of their own; the backend forwards it.
        expect(normalizeReasoningEffort('minimal')).toBe('minimal');
        expect(normalizeReasoningEffort('Ultra')).toBe('ultra');
    });

    test('returns an empty string for anything that is not a string', () => {
        for (const value of [null, undefined, 42, {}, [], true]) {
            expect(normalizeReasoningEffort(value)).toBe('');
        }
    });
});

describe('isKnownReasoningEffort', () => {
    test('accepts every canonical value', () => {
        for (const value of Object.values(REASONING_EFFORT)) {
            expect(isKnownReasoningEffort(value)).toBe(true);
        }
    });

    test('rejects unrecognized values', () => {
        expect(isKnownReasoningEffort('ultra')).toBe(false);
        expect(isKnownReasoningEffort('')).toBe(false);
    });

    test('rejects inherited prototype keys', () => {
        // A bare index would resolve these through Object.prototype and report them as known.
        for (const key of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
            expect(isKnownReasoningEffort(key)).toBe(false);
        }
    });
});

describe('applyReasoningEffortNormalization', () => {
    test('normalizes the field in place', () => {
        const body = { reasoning_effort: 'Medium', model: 'test' };
        applyReasoningEffortNormalization(body);

        expect(body.reasoning_effort).toBe('medium');
        expect(body.model).toBe('test');
    });

    test('never adds the field when it is absent', () => {
        const body = { model: 'test' };
        applyReasoningEffortNormalization(body);

        expect(Object.hasOwn(body, 'reasoning_effort')).toBe(false);
    });

    test('leaves non-string values untouched', () => {
        const body = { reasoning_effort: 42 };
        applyReasoningEffortNormalization(body);

        expect(body.reasoning_effort).toBe(42);
    });

    test('keeps an unrecognized value rather than deleting it', () => {
        const body = { reasoning_effort: 'Ultra' };
        applyReasoningEffortNormalization(body);

        expect(Object.hasOwn(body, 'reasoning_effort')).toBe(true);
        expect(body.reasoning_effort).toBe('ultra');
    });

    test('tolerates a missing or non-object body', () => {
        expect(() => applyReasoningEffortNormalization(null)).not.toThrow();
        expect(() => applyReasoningEffortNormalization(undefined)).not.toThrow();
        expect(() => applyReasoningEffortNormalization('body')).not.toThrow();
    });
});
