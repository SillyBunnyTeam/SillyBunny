/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the dialog width property. */
import { describe, expect, test } from '@jest/globals';
import { readDialogAside, writeDialogAside } from '../../public/scripts/sillybunny-editor/dialog-aside.js';

describe('the dialog aside', () => {
    test('is 0 until a width is written', () => {
        expect(readDialogAside(document.createElement('section'))).toBe(0);
    });

    test('is written as a pixel width on the surface, where the width rules of the tiers read it', () => {
        const surface = document.createElement('section');

        writeDialogAside(surface, 229);

        expect(surface.style.getPropertyValue('--sb-dialog-aside')).toBe('229px');
        expect(readDialogAside(surface)).toBe(229);
    });

    test('is removed by 0 or less', () => {
        const surface = document.createElement('section');
        writeDialogAside(surface, 229);

        writeDialogAside(surface, 0);

        expect(surface.style.getPropertyValue('--sb-dialog-aside')).toBe('');
        expect(readDialogAside(surface)).toBe(0);
    });

    test('keeps a fraction, because the art of a 1.5 screen is not a whole CSS size', () => {
        const surface = document.createElement('section');

        writeDialogAside(surface, 268.6667);

        expect(readDialogAside(surface)).toBeCloseTo(268.6667, 4);
    });
});
