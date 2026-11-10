/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for how the layout starts and ends the motion of its art. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const stops = [];
const attachArtMotion = jest.fn((figure, id) => {
    const stop = jest.fn();
    const motion = { stop, refresh: jest.fn() };
    stops.push({ id, figure, stop, refresh: motion.refresh });
    return motion;
});

jest.unstable_mockModule('../../public/scripts/sillybunny-home/art-player.js', () => ({ attachArtMotion }));

const { createArtPanel, createHeroArt } = await import('../../public/scripts/sillybunny-home/art-layout.js');

window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

beforeEach(() => {
    jest.useFakeTimers();
    attachArtMotion.mockClear();
    stops.length = 0;
});

afterEach(() => {
    document.body.replaceChildren();
    // The layout keeps a frame that it asked for in a variable, so a frame that never ran would block every later test.
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
});

describe('the figures of a panel', () => {
    test('each is given its motion when it is made, by the id of its art', () => {
        const { panel } = createArtPanel(['gs-reisen', 'about-tewi']);

        expect(attachArtMotion.mock.calls.map(([, id]) => id)).toEqual(['gs-reisen', 'about-tewi']);
        expect(attachArtMotion.mock.calls.map(([figure]) => figure)).toEqual([...panel.children]);
    });

    test('a change of art ends the motion of the figures it replaces, and gives the new ones theirs', () => {
        const { setArts } = createArtPanel(['gs-reisen']);
        const [first] = stops;

        setArts(['about-tewi']);

        expect(first.stop).toHaveBeenCalledTimes(1);
        expect(stops.map(({ id }) => id)).toEqual(['gs-reisen', 'about-tewi']);
        expect(stops[1].stop).not.toHaveBeenCalled();
    });

    test('the same art again changes nothing, so a figure that is playing is not restarted', () => {
        const { setArts } = createArtPanel(['gs-reisen']);

        setArts(['gs-reisen']);

        expect(attachArtMotion).toHaveBeenCalledTimes(1);
        expect(stops[0].stop).not.toHaveBeenCalled();
    });

    test('leaving the document does not end the motion, because the panel can come back', () => {
        const { panel } = createArtPanel(['gs-reisen']);
        document.body.append(panel);

        panel.remove();

        expect(stops[0].stop).not.toHaveBeenCalled();
    });
});

describe('the hero', () => {
    test('is given its motion once, by the id of its art', () => {
        createHeroArt('hero-duo');

        expect(attachArtMotion).toHaveBeenCalledTimes(1);
        expect(attachArtMotion.mock.calls[0][1]).toBe('hero-duo');
    });

    test('asks its motion to look again whenever the layout has set its fit, because a smooth fit keeps the still', () => {
        const { panel: hero } = createHeroArt('hero-duo');
        const band = document.createElement('div');
        band.append(hero);
        document.body.append(band);

        window.dispatchEvent(new Event('resize'));
        jest.advanceTimersByTime(50);

        expect(stops[0].refresh).toHaveBeenCalled();
        expect(hero.dataset.sbArtFit).toBeDefined();
    });

    test('ends its motion when it has been in the page and is taken out', () => {
        const { panel: hero } = createHeroArt('hero-duo');
        const band = document.createElement('div');
        band.append(hero);
        document.body.append(band);
        // A layout that finds the hero in the page is what tells the layout that it has been seen.
        window.dispatchEvent(new Event('resize'));
        jest.advanceTimersByTime(50);
        expect(stops[0].stop).not.toHaveBeenCalled();

        hero.remove();
        window.dispatchEvent(new Event('resize'));
        jest.advanceTimersByTime(50);

        expect(stops[0].stop).toHaveBeenCalledTimes(1);
    });

    test('its stop ends the motion at once and takes the hero out of the layout, so a later layout leaves it alone', () => {
        const { panel: hero, stop } = createHeroArt('hero-duo');
        const band = document.createElement('div');
        band.append(hero);
        document.body.append(band);
        window.dispatchEvent(new Event('resize'));
        jest.advanceTimersByTime(50);
        stops[0].refresh.mockClear();

        stop();
        window.dispatchEvent(new Event('resize'));
        jest.advanceTimersByTime(50);

        expect(stops[0].stop).toHaveBeenCalledTimes(1);
        expect(stops[0].refresh).not.toHaveBeenCalled();
    });

    test('its stop works while the hero is still in the page, which a render in place does, and twice', () => {
        const { panel: hero, stop } = createHeroArt('hero-duo');
        document.body.append(hero);

        stop();
        stop();

        expect(stops[0].stop).toHaveBeenCalled();
        expect(hero.isConnected).toBe(true);
    });
});
