/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { fitCardFooters, updateFooterLabels } from '../../public/scripts/sillybunny-home/footer-fit.js';

const COMPACT = 'data-sb-footer-compact';
const MEASURING = 'data-sb-footer-measure';

let observers;
let frames;

class FakeResizeObserver {
    constructor(callback) {
        this.callback = callback;
        this.observed = [];
        this.disconnected = false;
        observers.push(this);
    }

    observe(element) {
        this.observed.push(element);
    }

    disconnect() {
        this.disconnected = true;
    }
}

/**
 * jsdom has no layout, so the buttons span what the labels need only while the card is not compact, the way the
 * real row spans less once the labels are gone. The footer has 8px of padding at each end.
 */
function renderCard({ labelsNeed, footerWidth }) {
    const card = document.createElement('article');
    card.className = 'sbHomeCard';
    const footer = document.createElement('div');
    footer.className = 'sbHomeCardFooter';
    footer.style.paddingInlineStart = '8px';
    footer.style.paddingInlineEnd = '8px';
    const first = document.createElement('button');
    const last = document.createElement('button');
    footer.append(first, last);
    footer.getBoundingClientRect = () => ({ width: footer.dataset.width ? Number(footer.dataset.width) : footerWidth });
    first.getBoundingClientRect = () => ({ left: 8, right: 40 });
    last.getBoundingClientRect = () => ({ left: 100, right: 8 + (card.hasAttribute(COMPACT) ? 120 : labelsNeed) });
    card.append(footer);
    card.getClientRects = () => [{}];
    return { card, footer };
}

function renderPanel(...cards) {
    const panel = document.createElement('div');
    panel.append(...cards.map(({ card }) => card));
    document.body.append(panel);
    return panel;
}

function runFrames() {
    const pending = frames.splice(0);
    pending.forEach(callback => callback());
}

beforeEach(() => {
    observers = [];
    frames = [];
    window.ResizeObserver = FakeResizeObserver;
    window.requestAnimationFrame = (callback) => {
        frames.push(callback);
        return frames.length;
    };
});

afterEach(() => {
    document.body.replaceChildren();
    fitCardFooters(document.createElement('div'));
});

describe('footer label fit', () => {
    test('marks a card compact when its footer overflows with both labels shown, and leaves a fitting card alone', () => {
        const tight = renderCard({ labelsNeed: 340, footerWidth: 300 });
        const roomy = renderCard({ labelsNeed: 340, footerWidth: 360 });

        updateFooterLabels([tight.card, roomy.card]);

        expect(tight.card.hasAttribute(COMPACT)).toBe(true);
        expect(roomy.card.hasAttribute(COMPACT)).toBe(false);
    });

    test('measures with both labels shown, so a card that was compact can fit again after it grows', () => {
        const { card, footer } = renderCard({ labelsNeed: 340, footerWidth: 300 });
        updateFooterLabels([card]);
        expect(card.hasAttribute(COMPACT)).toBe(true);

        footer.dataset.width = '360';
        updateFooterLabels([card]);

        expect(card.hasAttribute(COMPACT)).toBe(false);
    });

    test.each([
        ['spill into the end padding', 350, true],
        ['fill the room up to the end padding exactly, where a fractional width cannot tell a fit from an overflow', 344, true],
        ['leave room before the end padding', 340, false],
    ])('a footer whose buttons %s', (_, labelsNeed, compact) => {
        const { card } = renderCard({ labelsNeed, footerWidth: 360 });

        updateFooterLabels([card]);

        expect(card.hasAttribute(COMPACT)).toBe(compact);
    });

    test('leaves no measuring state behind', () => {
        const { card } = renderCard({ labelsNeed: 340, footerWidth: 300 });

        updateFooterLabels([card]);

        expect(card.hasAttribute(MEASURING)).toBe(false);
    });

    test('skips a card that has no box, such as one in a hidden display mode', () => {
        const { card } = renderCard({ labelsNeed: 340, footerWidth: 300 });
        card.getClientRects = () => [];

        updateFooterLabels([card]);

        expect(card.hasAttribute(COMPACT)).toBe(false);
    });
});

describe('footer fit observer', () => {
    test('watches every card with a footer, and measures once per frame however many sizes change', () => {
        const first = renderCard({ labelsNeed: 340, footerWidth: 300 });
        const second = renderCard({ labelsNeed: 340, footerWidth: 360 });
        const panel = renderPanel(first, second);

        fitCardFooters(panel);
        const [observer] = observers;
        observer.callback();
        observer.callback();

        expect(observer.observed).toEqual([first.card, second.card]);
        expect(frames).toHaveLength(1);
        runFrames();
        expect(first.card.hasAttribute(COMPACT)).toBe(true);
        expect(second.card.hasAttribute(COMPACT)).toBe(false);
    });

    test('writes in a frame of its own, so the size change it causes is not a loop inside the observer callback', () => {
        const { card } = renderCard({ labelsNeed: 340, footerWidth: 300 });
        fitCardFooters(renderPanel({ card }));

        observers[0].callback();

        expect(card.hasAttribute(COMPACT)).toBe(false);
        runFrames();
        expect(card.hasAttribute(COMPACT)).toBe(true);
    });

    test('a second mount disconnects the observer of the first, and the first panel is no longer measured', () => {
        const old = renderCard({ labelsNeed: 340, footerWidth: 300 });
        const next = renderCard({ labelsNeed: 340, footerWidth: 300 });
        fitCardFooters(renderPanel(old));
        fitCardFooters(renderPanel(next));

        expect(observers.map(observer => observer.disconnected)).toEqual([true, false]);
        observers[0].callback();
        runFrames();
        expect(old.card.hasAttribute(COMPACT)).toBe(false);
    });

    test('a frame that was queued before the panel was replaced measures nothing', () => {
        const old = renderCard({ labelsNeed: 340, footerWidth: 300 });
        fitCardFooters(renderPanel(old));
        observers[0].callback();

        fitCardFooters(renderPanel(renderCard({ labelsNeed: 340, footerWidth: 360 })));
        runFrames();

        expect(old.card.hasAttribute(COMPACT)).toBe(false);
    });
});
