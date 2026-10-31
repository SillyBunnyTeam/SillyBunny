/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { describe, expect, test } from '@jest/globals';
import { createArtIntro } from '../../public/scripts/sillybunny-home/art-intro.js';

describe('createArtIntro', () => {
    test('puts the art first and the marked line after it, and hides the art from assistive technology', () => {
        const { intro } = createArtIntro({ art: 'help-reisen', slot: 'HELP-INTRO' });

        expect(intro.className).toBe('sbArtIntro');
        expect([...intro.children].map(child => child.tagName)).toEqual(['DIV', 'P']);
        expect(intro.children[0].dataset.sbArtPlaceholder).toBe('help-reisen');
        expect(intro.children[0].getAttribute('aria-hidden')).toBe('true');
        expect(intro.children[1].dataset).toMatchObject({ sbCopyPlaceholder: 'true', sbCopySlot: 'HELP-INTRO' });
        expect(intro.children[1].textContent).toBe('TODO(copy)');
    });

    test('swaps the art and the line together, and keeps the order', () => {
        const { intro, show } = createArtIntro({ art: 'gs-reisen', slot: 'GS-INTRO' });

        show({ art: 'gs-reisen-done', slot: 'GS-INTRO-DONE' });

        expect(intro.children).toHaveLength(2);
        expect(intro.children[0].dataset.sbArtPlaceholder).toBe('gs-reisen-done');
        expect(intro.children[1].dataset.sbCopySlot).toBe('GS-INTRO-DONE');
    });

    test('leaves an element alone when the swap names the one it already has', () => {
        const { intro, show } = createArtIntro({ art: 'gs-reisen', slot: 'GS-INTRO' });
        const [art, line] = intro.children;

        show({ art: 'gs-reisen', slot: 'GS-INTRO' });
        expect(intro.children[0]).toBe(art);
        expect(intro.children[1]).toBe(line);

        show({ art: 'gs-reisen', slot: 'GS-INTRO-DONE' });
        expect(intro.children[0]).toBe(art);
        expect(intro.children[1]).not.toBe(line);
    });
});
