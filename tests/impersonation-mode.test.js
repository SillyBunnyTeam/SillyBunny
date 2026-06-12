import { describe, expect, test } from '@jest/globals';

import {
    IMPERSONATION_FORMATS,
    isNeutralImpersonationFormat,
    normalizeImpersonationFormat,
    shouldAppendImpersonationNamePrompt,
    shouldUseAssistantImpersonationPrefill,
} from '../public/scripts/impersonation-mode.js';

describe('impersonation mode helpers', () => {
    test('normalizes only explicit neutral impersonation requests', () => {
        expect(normalizeImpersonationFormat('neutral')).toBe(IMPERSONATION_FORMATS.NEUTRAL);
        expect(normalizeImpersonationFormat(' Neutral ')).toBe(IMPERSONATION_FORMATS.NEUTRAL);
        expect(normalizeImpersonationFormat('default')).toBe(IMPERSONATION_FORMATS.DEFAULT);
        expect(normalizeImpersonationFormat('')).toBe(IMPERSONATION_FORMATS.DEFAULT);
    });

    test('keeps the Claude impersonation prefill for plain impersonate only', () => {
        expect(shouldUseAssistantImpersonationPrefill('impersonate', undefined)).toBe(true);
        expect(shouldUseAssistantImpersonationPrefill('impersonate', 'default')).toBe(true);
        expect(shouldUseAssistantImpersonationPrefill('impersonate', 'neutral')).toBe(false);
        expect(shouldUseAssistantImpersonationPrefill('normal', 'neutral')).toBe(false);
    });

    test('skips the text-completion name prompt only for neutral impersonate', () => {
        expect(shouldAppendImpersonationNamePrompt({
            isInstruct: false,
            isImpersonate: true,
            isContinue: false,
            neutralImpersonate: false,
        })).toBe(true);
        expect(shouldAppendImpersonationNamePrompt({
            isInstruct: false,
            isImpersonate: true,
            isContinue: false,
            neutralImpersonate: true,
        })).toBe(false);
        expect(shouldAppendImpersonationNamePrompt({
            isInstruct: true,
            isImpersonate: true,
            isContinue: false,
            neutralImpersonate: false,
        })).toBe(false);
        expect(isNeutralImpersonationFormat('neutral')).toBe(true);
    });
});
