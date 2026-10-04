import { describe, test, expect } from '@jest/globals';
import {
    mapSillyBunnyVersionToStEquivalent,
    SILLYBUNNY_TO_ST_MINOR,
} from '../public/scripts/sillybunny-version-map.js';

describe('mapSillyBunnyVersionToStEquivalent', () => {
    test('maps SB 1.6.x to ST 1.18.x', () => {
        expect(mapSillyBunnyVersionToStEquivalent('1.6.4')).toBe('1.18.4');
        expect(mapSillyBunnyVersionToStEquivalent('1.6.0')).toBe('1.18.0');
        expect(mapSillyBunnyVersionToStEquivalent('1.6.99')).toBe('1.18.99');
    });

    test('preserves suffix', () => {
        expect(mapSillyBunnyVersionToStEquivalent('1.6.4-beta')).toBe('1.18.4-beta');
    });

    test('clamps future unmapped SB minors to the highest synced ST version', () => {
        // SB 1.7.0 is not yet in SILLYBUNNY_TO_ST_MINOR, but should map to ST 1.18.0
        // (the highest synced ST minor) instead of passing through as 1.7.0.
        expect(mapSillyBunnyVersionToStEquivalent('1.7.0')).toBe('1.18.0');
        expect(mapSillyBunnyVersionToStEquivalent('1.99.5')).toBe('1.18.5');
        expect(mapSillyBunnyVersionToStEquivalent('1.8.1')).toBe('1.18.1');
        expect(mapSillyBunnyVersionToStEquivalent('1.7.3-beta')).toBe('1.18.3-beta');
    });

    test('passes through SB minors lower than the minimum mapped entry', () => {
        // SB 1.5.x is below the minimum mapped entry (6); pass through unchanged.
        expect(mapSillyBunnyVersionToStEquivalent('1.5.0')).toBe('1.5.0');
        expect(mapSillyBunnyVersionToStEquivalent('1.0.1')).toBe('1.0.1');
    });

    test('passes through non-1.x major versions', () => {
        expect(mapSillyBunnyVersionToStEquivalent('2.0.0')).toBe('2.0.0');
        expect(mapSillyBunnyVersionToStEquivalent('0.9.1')).toBe('0.9.1');
    });

    test('passes through invalid version strings', () => {
        expect(mapSillyBunnyVersionToStEquivalent('not-a-version')).toBe('not-a-version');
        expect(mapSillyBunnyVersionToStEquivalent('1.6')).toBe('1.6');
        expect(mapSillyBunnyVersionToStEquivalent('')).toBe('');
    });

    test('handles version with v prefix stripped', () => {
        // versionCompare strips 'v' before calling this function
        expect(mapSillyBunnyVersionToStEquivalent('1.6.4')).toBe('1.18.4');
    });
});

describe('SILLYBUNNY_TO_ST_MINOR table', () => {
    test('documents current SB-to-ST minor mapping', () => {
        // SB 1.6.x tracks ST 1.18.x
        expect(SILLYBUNNY_TO_ST_MINOR[6]).toBe(18);
    });

    test('contains only integer keys and values', () => {
        for (const [sbMinor, stMinor] of Object.entries(SILLYBUNNY_TO_ST_MINOR)) {
            expect(Number.isInteger(Number(sbMinor))).toBe(true);
            expect(Number.isInteger(stMinor)).toBe(true);
        }
    });
});
