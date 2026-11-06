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

    for (const [target, expectedOrder] of [
        ['c', ['unsectioned', 'b-divider', 'b-child', 'a-divider', 'a-marker', 'a-hidden', 'c-divider']],
        [null, ['unsectioned', 'b-divider', 'b-child', 'c-divider', 'a-divider', 'a-marker', 'a-hidden']],
    ]) {
        test(`moves omitted collapsed children with their section before ${target}`, () => {
            const order = [
                { identifier: 'unsectioned', enabled: false },
                { identifier: 'a-divider', enabled: true },
                { identifier: 'a-marker', enabled: true },
                { identifier: 'a-hidden', enabled: false, metadata: { authored: 'keep' } },
                { identifier: 'b-divider', enabled: true },
                { identifier: 'b-child', enabled: true },
                { identifier: 'c-divider', enabled: false },
            ];
            const blocks = buildSectionBlocks([
                promptRow('unsectioned', ''),
                sectionRow('a'),
                promptRow('a-divider', 'a'),
                promptRow('a-marker', 'a'),
                sectionRow('b'),
                promptRow('b-divider', 'b'),
                promptRow('b-child', 'b'),
                sectionRow('c'),
                promptRow('c-divider', 'c'),
            ]);

            const result = computeReorderedOrder(order, blocks, 'a', target);

            expect(result.map(entry => entry.identifier)).toEqual(expectedOrder);
            expect(result).toHaveLength(order.length);
            for (const entry of order) {
                expect(result.find(candidate => candidate.identifier === entry.identifier)).toBe(entry);
            }
            expect(order.map(entry => entry.identifier)).toEqual([
                'unsectioned', 'a-divider', 'a-marker', 'a-hidden', 'b-divider', 'b-child', 'c-divider',
            ]);
        });
    }

    test('moves a later collapsed section before an earlier collapsed section', () => {
        const order = [
            { identifier: 'unknown-leading', enabled: false },
            { identifier: 'a-divider' },
            { identifier: 'a-marker' },
            { identifier: 'a-hidden' },
            { identifier: 'b-divider' },
            { identifier: 'b-marker' },
            { identifier: 'b-hidden', enabled: false },
        ];
        const blocks = [
            { sectionId: 'a', promptIds: ['a-divider', 'a-marker'] },
            { sectionId: 'b', promptIds: ['b-divider', 'b-marker'] },
        ];

        expect(computeReorderedOrder(order, blocks, 'b', 'a')).toEqual([
            order[0], order[4], order[5], order[6], order[1], order[2], order[3],
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
