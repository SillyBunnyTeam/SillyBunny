/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { describe, expect, test } from '@jest/globals';
import { createArtIntro } from '../../public/scripts/sillybunny-home/art-intro.js';

describe('createArtIntro', () => {
    test('is a fragment of the art panel and the marked line, so both become children of the window body', () => {
        const { intro, panel } = createArtIntro({ art: 'help-reisen', slot: 'HELP-INTRO' });
        const body = document.createElement('div');

        expect(intro.nodeType).toBe(Node.DOCUMENT_FRAGMENT_NODE);
        body.append(intro);

        expect([...body.children].map(child => child.tagName)).toEqual(['SB-ART-PANEL', 'P']);
        expect(body.children[0]).toBe(panel);
        expect(panel.getAttribute('aria-hidden')).toBe('true');
        expect(panel.querySelector('[data-sb-art-placeholder]').dataset.sbArtPlaceholder).toBe('help-reisen');
        expect(body.children[1].dataset).toMatchObject({ sbCopyPlaceholder: 'true', sbCopySlot: 'HELP-INTRO' });
        expect(body.children[1].textContent).toBe('TODO(copy)');
    });

    test('swaps the art and the line together, and keeps the order', () => {
        const { intro, panel, show } = createArtIntro({ art: 'gs-reisen', slot: 'GS-INTRO' });
        const body = document.createElement('div');
        body.append(intro);

        show({ art: 'gs-reisen-done', slot: 'GS-INTRO-DONE' });

        expect(body.children).toHaveLength(2);
        expect(body.children[0]).toBe(panel);
        expect(panel.querySelector('[data-sb-art-placeholder]').dataset.sbArtPlaceholder).toBe('gs-reisen-done');
        expect(body.children[1].dataset.sbCopySlot).toBe('GS-INTRO-DONE');
    });

    test('leaves an element alone when the swap names the one it already has', () => {
        const { intro, panel, show } = createArtIntro({ art: 'gs-reisen', slot: 'GS-INTRO' });
        const body = document.createElement('div');
        body.append(intro);
        const figure = panel.firstElementChild;
        const line = body.children[1];

        show({ art: 'gs-reisen', slot: 'GS-INTRO' });
        expect(panel.firstElementChild).toBe(figure);
        expect(body.children[1]).toBe(line);

        show({ art: 'gs-reisen', slot: 'GS-INTRO-DONE' });
        expect(panel.firstElementChild).toBe(figure);
        expect(body.children[1]).not.toBe(line);
    });
});
