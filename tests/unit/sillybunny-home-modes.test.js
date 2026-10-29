/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, test } from '@jest/globals';
import { DISPLAY_MODES, getVisibleRegions, parseDisplayMode } from '../../public/scripts/sillybunny-home/modes.js';

const sorted = regions => [...regions].sort();

describe('Home display modes', () => {
    test('lists Full, Compact and List Only with the stored values', () => {
        expect([...DISPLAY_MODES]).toEqual(['full', 'compact', 'list']);
    });

    test.each([
        ['full', 'full'],
        ['compact', 'compact'],
        ['list', 'list'],
        ['listOnly', 'full'],
        ['', 'full'],
        [null, 'full'],
        [undefined, 'full'],
    ])('parses %p as %p', (stored, expected) => {
        expect(parseDisplayMode(stored)).toBe(expected);
    });

    test('Full renders the hero, every section and the mascot art', () => {
        expect(sorted(getVisibleRegions('full'))).toEqual(sorted([
            'hero',
            'getting-started',
            'assistants',
            'links',
            'recent-chats',
            'mascot-art',
        ]));
    });

    test('Compact swaps the hero for the one-line header and drops Getting Started and the mascot art', () => {
        expect(sorted(getVisibleRegions('compact'))).toEqual(sorted([
            'bar-logo',
            'assistants',
            'links',
            'recent-chats',
        ]));
    });

    test('List Only keeps the one-line header and Recent Chats', () => {
        expect(sorted(getVisibleRegions('list'))).toEqual(sorted([
            'bar-logo',
            'recent-chats',
        ]));
    });

    test('an unknown mode renders like Full', () => {
        expect(sorted(getVisibleRegions('bogus'))).toEqual(sorted(getVisibleRegions('full')));
    });
});
