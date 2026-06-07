import { describe, expect, test } from '@jest/globals';

import {
    TOOL_CALL_RECURSE_LIMIT_DEFAULT,
    normalizeToolCallRecurseLimit,
} from '../public/scripts/tool-call-recurse-limit.js';

describe('tool call recurse limit settings', () => {
    test('keeps the current runtime default', () => {
        expect(TOOL_CALL_RECURSE_LIMIT_DEFAULT).toBe(5);
        expect(normalizeToolCallRecurseLimit(undefined)).toBe(5);
    });

    test('clamps saved and manual control values to the UI range', () => {
        expect(normalizeToolCallRecurseLimit(0)).toBe(1);
        expect(normalizeToolCallRecurseLimit(12)).toBe(12);
        expect(normalizeToolCallRecurseLimit('26')).toBe(26);
        expect(normalizeToolCallRecurseLimit(99)).toBe(50);
    });

    test('uses fallback when a saved value is not numeric', () => {
        expect(normalizeToolCallRecurseLimit('nope', 7)).toBe(7);
    });
});
