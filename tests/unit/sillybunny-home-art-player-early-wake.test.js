/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the player when the wait for the end of a page motion misbehaves. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseBreathScene } from '../../public/scripts/sillybunny-home/art-motion.js';

const SCENE = parseBreathScene({
    scene: 'fixture',
    grid: { width: 100, height: 120 },
    rhythm: { cycleSeconds: 3.5, breathsPerCycle: 2 },
    poses: ['c', 'b'],
    layers: [{ id: 'tall', z: 1, left: 4, top: 2, width: 40, height: 110, waist: 60, images: { c: { base: 'tall-c.webp' }, b: { base: 'tall-b.webp' } } }],
});

/** A wait that calls back in the next microtask whatever the state of the pages, which the real wait never does. */
let waits = 0;
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/page-motion.js', () => ({
    isPageMotionRunning: () => true,
    afterPageMotion: (_node, callback) => {
        waits++;
        // A loop would never let the test reach its assertions, so the mock stops answering long before that.
        if (waits < 50) {
            Promise.resolve().then(callback);
        }
        return () => {};
    },
}));

const { startArtMotion } = await import('../../public/scripts/sillybunny-home/art-player.js');
const { createPixelFigure, sizePixelFigure } = await import('../../public/scripts/sillybunny-home/pixel-art.js');

let observer = null;
class FakeIntersectionObserver {
    constructor(callback) {
        this.callback = callback;
        observer = this;
    }

    observe() {}

    disconnect() {}
}

const flush = async () => {
    for (let round = 0; round < 20; round++) {
        await Promise.resolve();
    }
};

beforeEach(() => {
    jest.useFakeTimers();
    waits = 0;
    window.IntersectionObserver = FakeIntersectionObserver;
    window.matchMedia = jest.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    window.HTMLImageElement.prototype.decode = () => Promise.resolve();
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.replaceChildren();
    delete window.IntersectionObserver;
    delete window.matchMedia;
});

describe('a wait that calls back while the pages still move', () => {
    test('is asked again on a timer, not in the same microtask, so a call that comes early cannot keep the page busy', async () => {
        const figure = createPixelFigure('hero-duo');
        document.body.append(figure);
        sizePixelFigure(figure, { step: 2, ratio: 2 });
        const player = startArtMotion(figure, { loadScene: () => Promise.resolve(SCENE), urlOf: file => `/img/${file}`, random: () => 0 });

        observer.callback([{ isIntersecting: true }]);
        await flush();

        expect(waits).toBeLessThan(5);
        expect(figure.querySelectorAll('img')).toHaveLength(1);
        expect(figure.dataset.sbArtMotion).toBeUndefined();

        player.stop();
        expect(jest.getTimerCount()).toBe(0);
    });
});
