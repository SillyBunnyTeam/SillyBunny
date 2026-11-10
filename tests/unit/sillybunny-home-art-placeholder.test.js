/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a DOM helper. */
import { describe, expect, test } from '@jest/globals';
import { createArtPlaceholder } from '../../public/scripts/sillybunny-home/art.js';

describe('createArtPlaceholder', () => {
    test('is a box that keeps its name for the styles and the specs, and shows no text', () => {
        const box = createArtPlaceholder('row-reisen');

        expect(box.className).toBe('sbHomeArt');
        expect(box.dataset.sbArtPlaceholder).toBe('row-reisen');
        expect(box.textContent).toBe('');
        expect(box.childElementCount).toBe(0);
    });

    test('is hidden from assistive technology', () => {
        expect(createArtPlaceholder('row-tewi').getAttribute('aria-hidden')).toBe('true');
    });
});
