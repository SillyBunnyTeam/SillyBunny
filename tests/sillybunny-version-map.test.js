import { describe, test, expect } from '@jest/globals';
import {
    mapSillyBunnyVersionToStEquivalent,
    SILLYBUNNY_TO_ST_MINOR,
    SILLYBUNNY_TO_ST_MINOR_BY_MAJOR,
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
        expect(mapSillyBunnyVersionToStEquivalent('1.7.3-beta')).toBe('1.18.3-beta');
    });

    test('keeps SB 1.8.x on ST 1.18 because it tracked ST staging, not the 1.19 release', () => {
        expect(mapSillyBunnyVersionToStEquivalent('1.8.0')).toBe('1.18.0');
        expect(mapSillyBunnyVersionToStEquivalent('1.8.1')).toBe('1.18.1');
        expect(mapSillyBunnyVersionToStEquivalent('1.9.0-dev')).toBe('1.18.0-dev');
    });

    test('passes through SB minors lower than the minimum mapped entry', () => {
        // SB 1.5.x is below the minimum mapped entry (6); pass through unchanged.
        expect(mapSillyBunnyVersionToStEquivalent('1.5.0')).toBe('1.5.0');
        expect(mapSillyBunnyVersionToStEquivalent('1.0.1')).toBe('1.0.1');
    });

    test('maps SB 2.0.x to ST 1.19.x', () => {
        expect(mapSillyBunnyVersionToStEquivalent('2.0.0')).toBe('1.19.0');
        expect(mapSillyBunnyVersionToStEquivalent('2.0.4')).toBe('1.19.4');
        expect(mapSillyBunnyVersionToStEquivalent('2.0.0-rc.1')).toBe('1.19.0-rc.1');
    });

    test('clamps future unmapped SB 2.x minors to the highest ST version synced in 2.x', () => {
        expect(mapSillyBunnyVersionToStEquivalent('2.1.0')).toBe('1.19.0');
        expect(mapSillyBunnyVersionToStEquivalent('2.9.2-dev')).toBe('1.19.2-dev');
    });

    test('clamps unmapped future SB majors to the newest synced ST version', () => {
        expect(mapSillyBunnyVersionToStEquivalent('3.0.0')).toBe('1.19.0');
        expect(mapSillyBunnyVersionToStEquivalent('10.2.7')).toBe('1.19.7');
    });

    test('SB 2.x never compares below ST versions that SB 1.x already satisfied', () => {
        expect(mapSillyBunnyVersionToStEquivalent('2.0.0')
            .localeCompare(mapSillyBunnyVersionToStEquivalent('1.8.1'), undefined, { numeric: true }))
            .toBeGreaterThan(0);
    });

    test('passes through SB majors below the lowest mapped major', () => {
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

    test('documents current SB 2.x mapping', () => {
        // SB 2.0.x tracks ST 1.19.x
        expect(SILLYBUNNY_TO_ST_MINOR_BY_MAJOR[2][0]).toBe(19);
        expect(SILLYBUNNY_TO_ST_MINOR).toBe(SILLYBUNNY_TO_ST_MINOR_BY_MAJOR[1]);
    });

    test('contains only integer keys and values', () => {
        for (const [sbMajor, table] of Object.entries(SILLYBUNNY_TO_ST_MINOR_BY_MAJOR)) {
            expect(Number.isInteger(Number(sbMajor))).toBe(true);
            for (const [sbMinor, stMinor] of Object.entries(table)) {
                expect(Number.isInteger(Number(sbMinor))).toBe(true);
                expect(Number.isInteger(stMinor)).toBe(true);
            }
        }
    });

    test('tracked ST minors never go backwards across SB versions', () => {
        const stMinorsInOrder = Object.keys(SILLYBUNNY_TO_ST_MINOR_BY_MAJOR)
            .map(Number)
            .sort((a, b) => a - b)
            .flatMap(sbMajor => {
                const table = SILLYBUNNY_TO_ST_MINOR_BY_MAJOR[sbMajor];
                return Object.keys(table).map(Number).sort((a, b) => a - b).map(sbMinor => table[sbMinor]);
            });

        for (let i = 1; i < stMinorsInOrder.length; i++) {
            expect(stMinorsInOrder[i]).toBeGreaterThanOrEqual(stMinorsInOrder[i - 1]);
        }
    });
});
