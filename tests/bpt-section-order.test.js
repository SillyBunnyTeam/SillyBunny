import { describe, expect, test } from '@jest/globals';

import {
    buildSectionBlocks,
    computeReorderedOrder,
    getSectionLockState,
    setSectionLockState,
    stripDividerPrefix,
} from '../public/scripts/extensions/third-party/BunnyPresetTools/sectionOrder.js';

const sectionRow = sectionId => ({ className: 'bpt-section-row', dataset: { sectionId } });
const promptRow = (identifier, sectionId) => ({ dataset: { pmIdentifier: identifier, sectionId } });

describe('BunnyPresetTools section order helpers', () => {
    test('keeps divider section icons in display titles', () => {
        const dividerRegex = /^(=+|-{3,}|\*{3,}|(?:[^\w\s]+\s*)?[─━—-]\+)/u;

        expect(stripDividerPrefix('🐈‍⬛ ─+ Primary Toggles', dividerRegex)).toBe('🐈‍⬛ Primary Toggles');
        expect(stripDividerPrefix('🐈‍⬛─+ Main', dividerRegex)).toBe('🐈‍⬛ Main');
        expect(stripDividerPrefix('⭐─+ Tracker Toggles', dividerRegex)).toBe('⭐ Tracker Toggles');
        expect(stripDividerPrefix('=== Main Prompts ===', dividerRegex)).toBe('Main Prompts ===');
        expect(stripDividerPrefix('Main', dividerRegex)).toBe('Main');
    });

    test('defaults new sections to locked and stores id/name keys', () => {
        const settings = {};

        expect(getSectionLockState(settings, 'section-1', 'Main')).toBe(true);
        expect(settings.promptSectionLocks).toEqual({
            'section-1': true,
            Main: true,
        });
    });

    test('uses section-name fallback for existing lock state', () => {
        const settings = { promptSectionLocks: { Main: false } };

        expect(getSectionLockState(settings, 'section-1', 'Main')).toBe(false);
        expect(settings.promptSectionLocks['section-1']).toBe(false);
    });

    test('sets lock state by id and name', () => {
        const settings = {};

        setSectionLockState(settings, 'section-1', 'Main', false);

        expect(getSectionLockState(settings, 'section-1', 'Main')).toBe(false);
        expect(settings.promptSectionLocks).toEqual({
            'section-1': false,
            Main: false,
        });
    });

    test('builds section blocks from mixed section and prompt rows', () => {
        expect(buildSectionBlocks([
            sectionRow('main'),
            promptRow('main-divider', 'main'),
            promptRow('main-child', 'main'),
            sectionRow('prefills'),
            promptRow('prefill-divider', 'prefills'),
            promptRow('prefill-child', 'prefills'),
            promptRow('unsectioned', ''),
        ])).toEqual([
            { sectionId: 'main', promptIds: ['main-divider', 'main-child'] },
            { sectionId: 'prefills', promptIds: ['prefill-divider', 'prefill-child'] },
        ]);
    });

    test('moves a section block before a later section', () => {
        const order = [
            { identifier: 'a-divider', enabled: true },
            { identifier: 'a-child', enabled: false },
            { identifier: 'b-divider', enabled: true },
            { identifier: 'b-child', enabled: true },
            { identifier: 'c-divider', enabled: false },
        ];
        const blocks = [
            { sectionId: 'a', promptIds: ['a-divider', 'a-child'] },
            { sectionId: 'b', promptIds: ['b-divider', 'b-child'] },
            { sectionId: 'c', promptIds: ['c-divider'] },
        ];

        const result = computeReorderedOrder(order, blocks, 'a', 'c');

        expect(result.map(entry => entry.identifier)).toEqual(['b-divider', 'b-child', 'a-divider', 'a-child', 'c-divider']);
        expect(result[2]).toBe(order[0]);
        expect(result[3].enabled).toBe(false);
    });

    test('moves a section block before an earlier section', () => {
        const order = [
            { identifier: 'a-divider' },
            { identifier: 'b-divider' },
            { identifier: 'b-child' },
            { identifier: 'c-divider' },
        ];
        const blocks = [
            { sectionId: 'a', promptIds: ['a-divider'] },
            { sectionId: 'b', promptIds: ['b-divider', 'b-child'] },
            { sectionId: 'c', promptIds: ['c-divider'] },
        ];

        expect(computeReorderedOrder(order, blocks, 'c', 'a').map(entry => entry.identifier)).toEqual([
            'c-divider',
            'a-divider',
            'b-divider',
            'b-child',
        ]);
    });

    test('moves a section block to the end when target is null', () => {
        const order = [
            { identifier: 'a-divider' },
            { identifier: 'b-divider' },
            { identifier: 'c-divider' },
        ];
        const blocks = [
            { sectionId: 'a', promptIds: ['a-divider'] },
            { sectionId: 'b', promptIds: ['b-divider'] },
            { sectionId: 'c', promptIds: ['c-divider'] },
        ];

        expect(computeReorderedOrder(order, blocks, 'b', null).map(entry => entry.identifier)).toEqual([
            'a-divider',
            'c-divider',
            'b-divider',
        ]);
    });

    test('leaves self drops and missing sections unchanged', () => {
        const order = [{ identifier: 'a-divider' }, { identifier: 'b-divider' }];
        const blocks = [
            { sectionId: 'a', promptIds: ['a-divider'] },
            { sectionId: 'b', promptIds: ['b-divider'] },
        ];

        expect(computeReorderedOrder(order, blocks, 'a', 'a')).toEqual(order);
        expect(computeReorderedOrder(order, blocks, 'missing', 'a')).toEqual(order);
        expect(computeReorderedOrder(order, blocks, 'a', 'missing')).toEqual(order);
    });

    test('does not move empty source or anchor to empty target sections', () => {
        const order = [{ identifier: 'a-divider' }, { identifier: 'b-divider' }];
        const blocks = [
            { sectionId: 'empty', promptIds: [] },
            { sectionId: 'a', promptIds: ['a-divider'] },
            { sectionId: 'b', promptIds: ['b-divider'] },
        ];

        expect(computeReorderedOrder(order, blocks, 'empty', 'a')).toEqual(order);
        expect(computeReorderedOrder(order, blocks, 'a', 'empty')).toEqual(order);
    });
});
