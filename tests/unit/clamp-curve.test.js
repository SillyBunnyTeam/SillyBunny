import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
    BEGIN_MARKER,
    END_MARKER,
    SEGMENTS,
    STYLESHEET,
    chordClamp,
    chordLines,
    exactClamp,
    renderDeclaration,
    run,
    updateStylesheet,
} from '../../scripts/generate-clamp-curve.js';

const CSS = readFileSync(new URL(`../../${STYLESHEET}`, import.meta.url), 'utf8');
const BLOCK = CSS.slice(CSS.indexOf(BEGIN_MARKER) + BEGIN_MARKER.length, CSS.indexOf(END_MARKER));

/** The chords as the stylesheet states them: `calc(<maxPart> * var(--sb-page-max) + <slope> * var(--sb-page-available))`. */
function readStylesheetLines() {
    return [...BLOCK.matchAll(/calc\(([\d.]+) \* var\(--sb-page-max\) \+ ([\d.]+) \* var\(--sb-page-available\)\)/g)]
        .map(([, maxPart, slope]) => ({ maxPart: Number(maxPart), slope: Number(slope) }));
}

/** A maximum `max` with its threshold at two thirds of it, as the settings page sets them. */
const thresholdOf = max => (max * 2) / 3;

/** libadwaita's curve, written from `child_size_from_clamp` once more, so the check does not rest on the module under test. */
function libadwaitaCurve(available, max, threshold) {
    const lower = Math.min(threshold, max);
    const upper = lower + 3 * (max - lower);
    if (available <= lower) return available;
    if (available >= upper) return max;
    const progress = (available - lower) / (upper - lower);
    const eased = (progress - 1) ** 3 + 1;
    return lower + eased * (max - lower);
}

describe('the AdwClamp curve of the settings pages', () => {
    test('the stylesheet holds what the generator writes, and writing it again changes nothing', () => {
        expect(BLOCK.trim()).toBe(renderDeclaration());
        expect(updateStylesheet(CSS)).toBe(CSS);
        expect(run({ check: true })).toMatchObject({ changed: false });
    });

    test('the generator refuses a stylesheet that has lost its markers', () => {
        expect(() => updateStylesheet('a { color: red }')).toThrow(/clamp-curve/);
    });

    test('the stylesheet has one chord line for each segment, with the maximum and the room as its only inputs', () => {
        expect(readStylesheetLines()).toHaveLength(SEGMENTS);
        expect(BLOCK).toMatch(/^\s*--sb-page-content: min\(\s*var\(--sb-page-available\),/);
        expect(BLOCK).toMatch(/var\(--sb-page-max\)\s*\);\s*$/);
        expect(BLOCK).not.toMatch(/\d(px|em|rem|vw|dvw)\b/);
    });

    test('each chord is the straight line through two points of libadwaita\'s curve, at a threshold of 2/3 of the maximum', () => {
        // At a maximum of 1 the threshold is 2/3 and the room is the pane's width in units of the maximum. A chord is
        // `a * max + slope * room`, so each coefficient follows from the two points of the curve that the chord joins.
        const knots = Array.from({ length: SEGMENTS + 1 }, (_, index) => 1 - (1 - index / SEGMENTS) ** (2 / 3));
        const roomAt = progress => thresholdOf(1) + progress * 3 * (1 - thresholdOf(1));
        readStylesheetLines().forEach(({ maxPart, slope }, index) => {
            const [room1, room2] = [roomAt(knots[index]), roomAt(knots[index + 1])];
            const [width1, width2] = [libadwaitaCurve(room1, 1, thresholdOf(1)), libadwaitaCurve(room2, 1, thresholdOf(1))];
            const expectedSlope = (width2 - width1) / (room2 - room1);
            expect(slope).toBeCloseTo(expectedSlope, 5);
            expect(maxPart).toBeCloseTo(width1 - expectedSlope * room1, 5);
        });
    });

    test('the chords never give a page more than AdwClamp, and at most 3px less, for both maximums at text size 1', () => {
        const lines = readStylesheetLines();
        const worst = {};
        const tooWide = [];
        for (const max of [1000, 1440]) {
            let largest = 0;
            for (let available = 0; available <= 4 * max; available += 0.25) {
                const exact = libadwaitaCurve(available, max, thresholdOf(max));
                const approximated = chordClamp(available, max, lines);
                if (approximated > exact + 1e-6) tooWide.push(`${max} at ${available}: ${approximated} against ${exact}`);
                largest = Math.max(largest, exact - approximated);
            }
            worst[max] = largest;
        }
        expect(tooWide).toEqual([]);
        expect(worst[1000]).toBeLessThan(3);
        expect(worst[1440]).toBeLessThan(3);
        expect(worst[1440]).toBeGreaterThan(worst[1000]);
    });

    test('the curve of the module gives the widths that libadwaita rounds to for the pages the settings tests measure', () => {
        const rounded = (available, max) => {
            const exact = exactClamp(available, max, thresholdOf(max));
            return available >= 3 * max - 2 * thresholdOf(max) ? Math.ceil(exact) : Math.floor(exact);
        };
        // Customize > Interface (preference, room = pane less 24px) and Characters > World Info (wide, room = pane less 28px or 64px).
        expect(rounded(1136, 1000)).toBe(950);
        expect(rounded(1616, 1000)).toBe(999);
        expect(rounded(972, 1440)).toBe(971);
        expect(rounded(1096, 1440)).toBe(1083);
        expect(rounded(1576, 1440)).toBe(1350);
        expect(rounded(3136, 1000)).toBe(1000);
        expect(rounded(3096, 1440)).toBe(1440);
    });

    test('a page is as wide as the room up to the threshold, and never wider than the maximum', () => {
        const lines = chordLines();
        for (const max of [1000, 1440]) {
            const threshold = thresholdOf(max);
            for (const available of [0, 100, threshold / 2, threshold - 1, threshold]) {
                expect(chordClamp(available, max, lines)).toBeCloseTo(available, 6);
            }
            expect(chordClamp(10 * max, max, lines)).toBe(max);
        }
    });
});
