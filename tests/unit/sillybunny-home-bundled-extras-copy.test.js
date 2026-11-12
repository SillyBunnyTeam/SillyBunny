/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure data. */
import { describe, expect, jest, test } from '@jest/globals';
import { EXTRA_DESCRIPTIONS } from '../helpers/copy-home.js';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { BUNDLED_EXTRAS } = await import('../../public/scripts/sillybunny-bundled-extras.js');
const { getBundledExtraDescription } = await import('../../public/scripts/sillybunny-home/bundled-extras-copy.js');

describe('the description of a Bundled Extras item', () => {
    test('exists for every item that the window lists, and for no other', () => {
        expect(BUNDLED_EXTRAS.map(item => item.id).sort()).toEqual(Object.keys(EXTRA_DESCRIPTIONS).sort());
    });

    test.each(Object.entries(EXTRA_DESCRIPTIONS))('of %s is the approved line', (id, text) => {
        expect(getBundledExtraDescription(id)).toBe(text);
    });

    test('is an error for an item that has none, so a new item cannot go out without one', () => {
        expect(() => getBundledExtraDescription('not-an-item')).toThrow('No description for the Bundled Extras item: not-an-item');
    });
});
