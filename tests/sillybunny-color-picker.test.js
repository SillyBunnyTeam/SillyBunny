import { describe, expect, test } from '@jest/globals';
import { parsePickerHex, positionColorMenu } from '../public/scripts/sillybunny-color-picker.js';

describe('colour picker hex input', () => {
    test('retains opacity when changing only the colour', () => {
        expect(parsePickerHex('#3584e4', 0.37)).toBe('rgba(53, 132, 228, 0.37)');
        expect(parsePickerHex('abc', 0.5)).toBe('rgba(170, 187, 204, 0.5)');
    });

    test('accepts explicit alpha, including fully transparent colours', () => {
        expect(parsePickerHex('#1230', 1)).toBe('rgba(17, 34, 51, 0)');
        expect(parsePickerHex('FF000080', 1)).toBe(`rgba(255, 0, 0, ${128 / 255})`);
    });

    for (const value of ['', '#', 'red', '12345', 'abcdefghi', 'rgb(0,0,0)', '12xz56']) {
        test(`rejects incomplete or invalid input ${value}`, () => {
            expect(parsePickerHex(value, 1)).toBeNull();
        });
    }
});

describe('colour menu placement', () => {
    const viewport = { left: 0, top: 0, right: 1280, bottom: 800 };
    const size = { width: 344, height: 440 };

    test('trailing-aligns below a top-edge trigger', () => {
        expect(positionColorMenu({ left: 1200, right: 1252, top: 20, bottom: 60 }, size, viewport))
            .toEqual({ left: 908, top: 68 });
    });

    test('flips above a bottom-edge trigger', () => {
        expect(positionColorMenu({ left: 1200, right: 1252, top: 740, bottom: 780 }, size, viewport))
            .toEqual({ left: 908, top: 292 });
    });

    test('keeps a left-edge trigger and short viewport within their bounds', () => {
        expect(positionColorMenu({ left: 0, right: 52, top: 100, bottom: 140 }, { width: 344, height: 276 },
            { left: 0, top: 0, right: 800, bottom: 300 })).toEqual({ left: 12, top: 12 });
    });

    test('respects visual viewport offsets', () => {
        expect(positionColorMenu({ left: 100, right: 152, top: 100, bottom: 140 }, size,
            { left: 50, top: 80, right: 1050, bottom: 800 })).toEqual({ left: 62, top: 148 });
    });
});
