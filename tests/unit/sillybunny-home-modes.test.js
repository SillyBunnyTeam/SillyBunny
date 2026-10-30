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

    test('Full renders the hero band, every tile, the assistant portraits, Recent Chats and the mascot art', () => {
        expect(sorted(getVisibleRegions('full'))).toEqual(sorted([
            'hero',
            'tiles',
            'getting-started',
            'assistants',
            'assistant-art',
            'recent-chats',
            'mascot-art',
        ]));
    });

    test('Compact drops the hero band, the Getting Started tile, the portraits and the mascot art', () => {
        expect(sorted(getVisibleRegions('compact'))).toEqual(sorted([
            'tiles',
            'assistants',
            'recent-chats',
        ]));
    });

    test('List Only keeps Recent Chats', () => {
        expect(sorted(getVisibleRegions('list'))).toEqual(['recent-chats']);
    });

    test('no mode names the header, which every mode shows', () => {
        for (const mode of DISPLAY_MODES) {
            expect(getVisibleRegions(mode)).not.toContain('bar-logo');
            expect(getVisibleRegions(mode)).not.toContain('links');
        }
    });

    test('an unknown mode renders like Full', () => {
        expect(sorted(getVisibleRegions('bogus'))).toEqual(sorted(getVisibleRegions('full')));
    });
});
