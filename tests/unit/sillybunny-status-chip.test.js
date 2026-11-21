/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a DOM helper. */
import { describe, expect, test } from '@jest/globals';
import { createStatusChip } from '../../public/scripts/sillybunny-home/status-chip.js';

describe('a status chip', () => {
    test('is a span with the label as its text and the tone as its data attribute', () => {
        const chip = createStatusChip({ label: 'Done', tone: 'neutral' });

        expect(chip.tagName).toBe('SPAN');
        expect(chip.className).toBe('sbStatusChip');
        expect(chip.dataset.sbTone).toBe('neutral');
        expect(chip.textContent).toBe('Done');
    });

    test('of the success tone starts with a check that the screen reader skips, then the text', () => {
        const chip = createStatusChip({ label: 'Installed', tone: 'success' });

        expect(chip.dataset.sbTone).toBe('success');
        const icons = chip.querySelectorAll('i');
        expect(icons).toHaveLength(1);
        expect(icons[0].className).toBe('fa-solid fa-check');
        expect(icons[0].getAttribute('aria-hidden')).toBe('true');
        expect(chip.firstElementChild).toBe(icons[0]);
        expect(chip.textContent).toBe('Installed');
    });

    test('of the neutral tone has no icon', () => {
        expect(createStatusChip({ label: 'Not installed', tone: 'neutral' }).querySelector('i')).toBeNull();
    });

    test('keeps the label as text, so markup in it is not parsed', () => {
        const chip = createStatusChip({ label: '<b>x</b>', tone: 'neutral' });

        expect(chip.querySelector('b')).toBeNull();
        expect(chip.textContent).toBe('<b>x</b>');
    });

    test.each(['', 'danger', undefined, null])('throws for the tone %p', (tone) => {
        expect(() => createStatusChip({ label: 'x', tone })).toThrow(new TypeError(`Unknown status chip tone: ${String(tone)}`));
    });
});
