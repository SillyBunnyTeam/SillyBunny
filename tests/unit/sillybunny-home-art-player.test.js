/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the player of the idle motion. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseBreathScene } from '../../public/scripts/sillybunny-home/art-motion.js';
import { attachArtMotion, startArtMotion } from '../../public/scripts/sillybunny-home/art-player.js';
import { createPixelFigure, sizePixelFigure } from '../../public/scripts/sillybunny-home/pixel-art.js';

const SCENE = parseBreathScene({
    scene: 'fixture',
    grid: { width: 100, height: 120 },
    rhythm: { cycleSeconds: 3.5, breathsPerCycle: 2 },
    poses: ['c', 'b'],
    backdrop: 'fixture--backdrop.webp',
    layers: [
        {
            id: 'tall',
            z: 1,
            left: 4,
            top: 2,
            width: 40,
            height: 110,
            waist: 60,
            images: { c: { base: 'tall-c.webp' }, b: { base: 'tall-b.webp' } },
        },
        {
            id: 'small',
            z: 2,
            left: 50,
            top: 30,
            width: 30,
            height: 80,
            waist: 40,
            images: {
                c: { base: 'small-c.webp', half: 'small-c-half.webp', closed: 'small-c-closed.webp' },
                b: { base: 'small-b.webp', half: 'small-b-half.webp', closed: 'small-b-closed.webp' },
            },
        },
    ],
});

/** The observer that the player gives to the page, which a test drives by hand. */
let observers = [];
class FakeIntersectionObserver {
    constructor(callback) {
        this.callback = callback;
        this.targets = new Set();
        this.disconnected = false;
        observers.push(this);
    }

    observe(target) {
        this.targets.add(target);
    }

    disconnect() {
        this.disconnected = true;
        this.targets.clear();
    }

    report(isIntersecting) {
        this.callback([{ isIntersecting }]);
    }
}

/** The system setting for Reduced Motion, which a test can change. */
const reducedQuery = { matches: false, listeners: new Set() };

function setSystemReducedMotion(matches) {
    reducedQuery.matches = matches;
    for (const listener of [...reducedQuery.listeners]) {
        listener({ matches });
    }
}

let hiddenValue = false;
function setDocumentHidden(hidden) {
    hiddenValue = hidden;
    document.dispatchEvent(new Event('visibilitychange'));
}

const urlOf = file => `/img/${file}`;
const flush = async () => {
    for (let round = 0; round < 6; round++) {
        await Promise.resolve();
    }
};

/** A figure in the page, with a still, sized as the layout sizes it. */
function mountFigure() {
    const figure = createPixelFigure('hero-duo');
    document.body.append(figure);
    sizePixelFigure(figure, { step: 2, ratio: 2 });
    return figure;
}

/** Every player that a test makes, so that none leaves a listener on the page for the next test. */
let players = [];

function start(figure, { loadScene = () => Promise.resolve(SCENE) } = {}) {
    const load = jest.fn(loadScene);
    const player = startArtMotion(figure, { loadScene: load, urlOf, random: () => 0 });
    players.push(player);
    return { player, load, observer: observers.at(-1) };
}

/** Shows the picture to the player and lets it load. */
async function appear(observer) {
    observer.report(true);
    await flush();
}

const layerImages = figure => [...figure.querySelectorAll('img[data-sb-art-layer]')];
const shown = figure => layerImages(figure)
    .filter(image => image.style.visibility === 'visible')
    .map(image => image.getAttribute('src').replace('/img/', ''));

beforeEach(() => {
    jest.useFakeTimers();
    observers = [];
    players = [];
    hiddenValue = false;
    reducedQuery.matches = false;
    reducedQuery.listeners.clear();
    window.IntersectionObserver = FakeIntersectionObserver;
    window.matchMedia = jest.fn(() => ({
        get matches() { return reducedQuery.matches; },
        addEventListener: (_type, listener) => reducedQuery.listeners.add(listener),
        removeEventListener: (_type, listener) => reducedQuery.listeners.delete(listener),
    }));
    window.HTMLImageElement.prototype.decode = () => Promise.resolve();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenValue });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    players.forEach(player => player.stop());
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.replaceChildren();
    document.body.className = '';
    delete window.IntersectionObserver;
    delete window.matchMedia;
});

describe('before the picture is seen', () => {
    test('loads nothing and starts no timer, so a picture that nobody sees costs nothing', async () => {
        const figure = mountFigure();

        const { load } = start(figure);
        await flush();

        expect(load).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        expect(figure.dataset.sbArtMotion).toBeUndefined();
        expect(figure.querySelectorAll('img')).toHaveLength(1);
    });

    test('does nothing at all where the page has no IntersectionObserver, and keeps the still', async () => {
        delete window.IntersectionObserver;
        const figure = mountFigure();

        const { player, load } = start(figure);
        await flush();

        expect(load).not.toHaveBeenCalled();
        expect(() => player.stop()).not.toThrow();
    });
});

describe('when the picture comes into view', () => {
    test('loads the scene once, and lays one picture of each figure over the still at its place in art pixels', async () => {
        const figure = mountFigure();
        const { load, observer } = start(figure);

        await appear(observer);
        observer.report(true);
        await flush();

        expect(load).toHaveBeenCalledTimes(1);
        const small = figure.querySelector('img[data-sb-art-layer="small"][data-sb-art-picture="base"][data-sb-art-pose="c"]');
        // The figure is sized at step 2 on a 2x screen, so an art pixel is one CSS pixel.
        expect([small.style.left, small.style.top, small.style.width, small.style.height]).toEqual(['50px', '30px', '30px', '80px']);
        expect(small.style.position).toBe('absolute');
        expect(small.getAttribute('alt')).toBe('');
        // Drawn like the still: as blocks, and not smoothed.
        expect(small.className).toBe('sbPixelArt');
    });

    test('draws the backdrop first and the figures in the order of their z, and keeps the still as the first child of the figure', async () => {
        const figure = mountFigure();
        const still = figure.firstElementChild;
        const { observer } = start(figure);

        await appear(observer);

        expect(figure.firstElementChild).toBe(still);
        const order = layerImages(figure).map(image => image.dataset.sbArtLayer);
        expect([...new Set(order)]).toEqual(['backdrop', 'tall', 'small']);
    });

    test('shows the backdrop and each figure in the breath pose it starts in, and hides the still', async () => {
        const figure = mountFigure();
        const { observer } = start(figure);

        await appear(observer);

        expect(shown(figure).sort()).toEqual(['fixture--backdrop.webp', 'small-b.webp', 'tall-b.webp']);
        expect(figure.firstElementChild.style.visibility).toBe('hidden');
        expect(figure.dataset.sbArtMotion).toBe('playing');
    });

    test('makes one picture for each file of a figure, however many poses use it', async () => {
        const figure = mountFigure();
        const { observer } = start(figure);

        await appear(observer);

        expect(layerImages(figure).filter(image => image.dataset.sbArtLayer === 'tall')).toHaveLength(2);
        expect(layerImages(figure).filter(image => image.dataset.sbArtLayer === 'small')).toHaveLength(6);
    });

    test('waits until every picture is decoded, so the still is never swapped for a blank', async () => {
        const releases = [];
        window.HTMLImageElement.prototype.decode = () => new Promise((resolve) => { releases.push(resolve); });
        const figure = mountFigure();
        const { observer } = start(figure);

        await appear(observer);

        expect(figure.querySelectorAll('img[data-sb-art-layer]')).toHaveLength(0);
        expect(figure.firstElementChild.style.visibility).toBe('');
        expect(jest.getTimerCount()).toBe(0);

        releases.forEach(release => release());
        await flush();

        expect(figure.dataset.sbArtMotion).toBe('playing');
    });
});

describe('while it plays', () => {
    test('breathes: the neutral pose after half a breath, the breath pose again after a whole one', async () => {
        const figure = mountFigure();
        const { observer } = start(figure);
        await appear(observer);

        jest.advanceTimersByTime(876);
        expect(shown(figure)).toContain('tall-c.webp');
        expect(shown(figure)).not.toContain('tall-b.webp');

        jest.advanceTimersByTime(875);
        expect(shown(figure)).toContain('tall-b.webp');
    });

    test('the second figure breathes a little behind the first', async () => {
        const figure = mountFigure();
        const { observer } = start(figure);
        await appear(observer);

        // The second figure is 1.7 radians of a breath in, so its pose turns 401.5 ms in.
        jest.advanceTimersByTime(404);

        expect(shown(figure)).toContain('small-c.webp');
        expect(shown(figure)).toContain('tall-b.webp');
    });

    test('blinks through half, closed and half again, in the pose it is in', async () => {
        const figure = mountFigure();
        const { observer } = start(figure);
        await appear(observer);
        // The first figure has no pictures to blink with. The second starts its first blink 2700 ms in.
        const picture = () => shown(figure).find(file => file.startsWith('small-'));

        jest.advanceTimersByTime(2699);
        const before = picture();
        jest.advanceTimersByTime(2);
        const half = picture();
        jest.advanceTimersByTime(70);
        const closed = picture();
        jest.advanceTimersByTime(110);
        const half2 = picture();
        jest.advanceTimersByTime(70);
        const after = picture();

        expect([before, half, closed, half2, after]).toEqual(['small-c.webp', 'small-c-half.webp', 'small-c-closed.webp', 'small-c-half.webp', 'small-c.webp']);
    });

    test('has one timer, for the next change, and never a frame loop', async () => {
        const figure = mountFigure();
        const requestFrame = jest.spyOn(window, 'requestAnimationFrame');
        const { observer } = start(figure);
        await appear(observer);

        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(20_000);

        expect(jest.getTimerCount()).toBe(1);
        expect(requestFrame).not.toHaveBeenCalled();
    });

    test('wakes only when a picture changes: about three times a second for two figures, not sixty', async () => {
        const figure = mountFigure();
        const { observer } = start(figure);
        await appear(observer);
        const wakes = jest.spyOn(window, 'setTimeout');

        // Each figure turns its breath about 34 times a minute, and the second blinks about 15 times, four changes each.
        jest.advanceTimersByTime(60_000);

        expect(wakes.mock.calls.length).toBeGreaterThan(100);
        expect(wakes.mock.calls.length).toBeLessThan(300);
    });
});

describe('when it cannot be seen or may not move', () => {
    test('pauses when it goes out of view: no timer is left, and the neutral pictures show', async () => {
        const figure = mountFigure();
        const { observer } = start(figure);
        await appear(observer);
        jest.advanceTimersByTime(900);
        expect(shown(figure)).toContain('tall-c.webp');
        jest.advanceTimersByTime(860);
        expect(shown(figure)).toContain('tall-b.webp');

        observer.report(false);

        expect(jest.getTimerCount()).toBe(0);
        expect(shown(figure).sort()).toEqual(['fixture--backdrop.webp', 'small-c.webp', 'tall-c.webp']);
        expect(figure.dataset.sbArtMotion).toBe('still');
    });

    test('starts again, from the start of the scene, when it comes back, without loading the scene a second time', async () => {
        const figure = mountFigure();
        const { observer, load } = start(figure);
        await appear(observer);
        observer.report(false);
        jest.advanceTimersByTime(10_000);

        observer.report(true);
        await flush();

        expect(load).toHaveBeenCalledTimes(1);
        expect(figure.dataset.sbArtMotion).toBe('playing');
        expect(shown(figure)).toContain('tall-b.webp');
        jest.advanceTimersByTime(876);
        expect(shown(figure)).toContain('tall-c.webp');
    });

    test('pauses while the tab is hidden, and plays again when it is shown', async () => {
        const figure = mountFigure();
        const { observer } = start(figure);
        await appear(observer);

        setDocumentHidden(true);
        expect(jest.getTimerCount()).toBe(0);
        expect(figure.dataset.sbArtMotion).toBe('still');

        setDocumentHidden(false);
        expect(jest.getTimerCount()).toBe(1);
        expect(figure.dataset.sbArtMotion).toBe('playing');
    });

    test('does not load while the tab is hidden', async () => {
        setDocumentHidden(true);
        const figure = mountFigure();
        const { observer, load } = start(figure);

        await appear(observer);

        expect(load).not.toHaveBeenCalled();
    });

    test('does not start, load or keep a timer under the Reduced Motion of the system: the still stays', async () => {
        reducedQuery.matches = true;
        const figure = mountFigure();
        const { observer, load } = start(figure);

        await appear(observer);

        // Its pictures are not even requested.
        expect(load).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        expect(figure.querySelectorAll('img')).toHaveLength(1);
        expect(figure.firstElementChild.style.visibility).toBe('');
    });

    test('does not start under the Reduced Motion of the app, which puts a class on the body', async () => {
        document.body.classList.add('reduced-motion');
        const figure = mountFigure();
        const { observer, load } = start(figure);

        await appear(observer);

        expect(load).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('stops moving when Reduced Motion is turned on while it plays, from the system or from the app', async () => {
        const figure = mountFigure();
        const { observer } = start(figure);
        await appear(observer);
        expect(jest.getTimerCount()).toBe(1);

        setSystemReducedMotion(true);
        expect(jest.getTimerCount()).toBe(0);
        expect(shown(figure)).toContain('tall-c.webp');

        setSystemReducedMotion(false);
        expect(jest.getTimerCount()).toBe(1);

        document.body.classList.add('reduced-motion');
        await flush();
        expect(jest.getTimerCount()).toBe(0);
        expect(figure.dataset.sbArtMotion).toBe('still');

        document.body.classList.remove('reduced-motion');
        await flush();
        expect(figure.dataset.sbArtMotion).toBe('playing');
    });

    test('starts when Reduced Motion is turned off for a picture that has not loaded yet', async () => {
        reducedQuery.matches = true;
        const figure = mountFigure();
        const { observer, load } = start(figure);
        await appear(observer);

        setSystemReducedMotion(false);
        await flush();

        expect(load).toHaveBeenCalledTimes(1);
        expect(figure.dataset.sbArtMotion).toBe('playing');
    });

    test('listens to the page only while it is in view, so a picture that has gone leaves no listener behind', async () => {
        const add = jest.spyOn(document, 'addEventListener');
        const remove = jest.spyOn(document, 'removeEventListener');
        const figure = mountFigure();
        const { observer } = start(figure);
        expect(add).not.toHaveBeenCalledWith('visibilitychange', expect.anything());

        await appear(observer);
        expect(add).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        expect(reducedQuery.listeners.size).toBe(1);

        observer.report(false);
        expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        expect(reducedQuery.listeners.size).toBe(0);
    });

    test('two pictures share the listeners, and the last one to go removes them', async () => {
        const first = start(mountFigure());
        const second = start(mountFigure());
        await appear(first.observer);
        await appear(second.observer);
        expect(reducedQuery.listeners.size).toBe(1);

        first.observer.report(false);
        expect(reducedQuery.listeners.size).toBe(1);

        second.observer.report(false);
        expect(reducedQuery.listeners.size).toBe(0);
    });
});

describe('a figure that the layout has not sized yet', () => {
    /** A figure in the page that the layout has not sized, so its art pixels have no size. */
    function mountUnsizedFigure() {
        const figure = createPixelFigure('hero-duo');
        document.body.append(figure);
        return figure;
    }

    test('is not a failure: it loads nothing and waits, and plays when it is sized and asked again', async () => {
        const figure = mountUnsizedFigure();
        const { player, observer, load } = start(figure);

        await appear(observer);

        expect(load).not.toHaveBeenCalled();
        expect(figure.dataset.sbArtMotion).toBeUndefined();
        expect(console.warn).not.toHaveBeenCalled();

        sizePixelFigure(figure, { step: 2, ratio: 2 });
        player.refresh();
        await flush();

        expect(figure.dataset.sbArtMotion).toBe('playing');
    });

    test('is not a failure either when it loses its size while the scene loads', async () => {
        const figure = mountFigure();
        let release;
        const { player, observer, load } = start(figure, { loadScene: () => new Promise((resolve) => { release = () => resolve(SCENE); }) });
        observer.report(true);
        figure.style.removeProperty('--sb-art-unit');

        release();
        await flush();

        expect(figure.dataset.sbArtMotion).toBeUndefined();
        expect(console.warn).not.toHaveBeenCalled();
        sizePixelFigure(figure, { step: 2, ratio: 2 });
        player.refresh();
        await flush();

        expect(figure.dataset.sbArtMotion).toBe('playing');
        expect(load).toHaveBeenCalledTimes(1);
    });
});

describe('a figure that a layout fits', () => {
    test('loads nothing until the layout has said that it is done, because the fit may keep the still', async () => {
        const figure = mountFigure();
        const load = jest.fn(() => Promise.resolve(SCENE));
        const player = startArtMotion(figure, { loadScene: load, urlOf, random: () => 0, awaitsLayout: true });
        players.push(player);

        await appear(observers.at(-1));

        expect(load).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);

        player.refresh();
        await flush();

        expect(load).toHaveBeenCalledTimes(1);
        expect(figure.dataset.sbArtMotion).toBe('playing');
    });
});

describe('a figure that is resized while its pictures decode', () => {
    test('has its layers placed at the size of an art pixel that it has when they are put in, not the one from before', async () => {
        const releases = [];
        window.HTMLImageElement.prototype.decode = () => new Promise((resolve) => { releases.push(resolve); });
        const figure = mountFigure();
        const { observer } = start(figure);
        await appear(observer);
        expect(releases.length).toBeGreaterThan(0);

        // The layout moves to a step twice as big while the pictures are still on their way.
        sizePixelFigure(figure, { step: 4, ratio: 2 });
        releases.forEach(release => release());
        await flush();

        const tall = layerImages(figure).find(image => image.dataset.sbArtLayer === 'tall');
        expect(figure.dataset.sbArtMotion).toBe('playing');
        expect([tall.style.left, tall.style.width]).toEqual([`${4 * 2}px`, `${40 * 2}px`]);
    });

    test('is not a failure when the layout takes its size away meanwhile: it asks again at the next refresh', async () => {
        const releases = [];
        window.HTMLImageElement.prototype.decode = () => new Promise((resolve) => { releases.push(resolve); });
        const figure = mountFigure();
        const { player, observer } = start(figure);
        await appear(observer);

        figure.style.removeProperty('--sb-art-unit');
        releases.forEach(release => release());
        await flush();

        expect(figure.dataset.sbArtMotion).toBeUndefined();
        expect(figure.querySelectorAll('img[data-sb-art-layer]')).toHaveLength(0);
        expect(console.warn).not.toHaveBeenCalled();

        sizePixelFigure(figure, { step: 2, ratio: 2 });
        window.HTMLImageElement.prototype.decode = () => Promise.resolve();
        player.refresh();
        await flush();

        expect(figure.dataset.sbArtMotion).toBe('playing');
    });
});

describe('a figure that has left the document', () => {
    test('stops its timer at the next wake and shows the still, so a removed picture is not kept alive', async () => {
        const figure = mountFigure();
        const { observer } = start(figure);
        await appear(observer);
        expect(jest.getTimerCount()).toBe(1);

        figure.remove();
        jest.advanceTimersByTime(900);

        expect(jest.getTimerCount()).toBe(0);
        expect(figure.dataset.sbArtMotion).toBe('still');
    });
});

describe('a picture that the layout shrinks by a fraction', () => {
    /** The panel that holds a figure and says how it fits: the layout writes `data-sb-art-fit` on it. */
    function mountInPanel(fit) {
        const panel = document.createElement('span');
        panel.dataset.sbArtFit = fit;
        const figure = createPixelFigure('hero-duo');
        panel.append(figure);
        document.body.append(panel);
        sizePixelFigure(figure, { step: 1, ratio: 1.3 });
        return { panel, figure };
    }

    test('keeps its still: its art pixels are not whole device pixels, so layers on them would show seams', async () => {
        const { figure } = mountInPanel('smooth');
        const { observer, load } = start(figure);

        await appear(observer);

        expect(load).not.toHaveBeenCalled();
        expect(figure.querySelectorAll('img')).toHaveLength(1);
        expect(figure.firstElementChild.style.visibility).toBe('');
        expect(jest.getTimerCount()).toBe(0);
    });

    test('plays once the fit is a whole step again and the layout says so', async () => {
        const { panel, figure } = mountInPanel('smooth');
        const { player, observer } = start(figure);
        await appear(observer);

        panel.dataset.sbArtFit = 'step';
        player.refresh();
        await flush();

        expect(figure.dataset.sbArtMotion).toBe('playing');
    });

    test('goes back to its still while it plays when the fit becomes smooth, and shows no layer', async () => {
        const { panel, figure } = mountInPanel('fixed');
        const { player, observer } = start(figure);
        await appear(observer);
        expect(figure.dataset.sbArtMotion).toBe('playing');

        panel.dataset.sbArtFit = 'smooth';
        player.refresh();

        expect(jest.getTimerCount()).toBe(0);
        expect(figure.dataset.sbArtMotion).toBe('still');
        expect(figure.firstElementChild.style.visibility).toBe('');
        expect(layerImages(figure).every(image => image.style.display === 'none')).toBe(true);

        panel.dataset.sbArtFit = 'fixed';
        player.refresh();

        expect(figure.dataset.sbArtMotion).toBe('playing');
        expect(figure.firstElementChild.style.visibility).toBe('hidden');
        expect(shown(figure).length).toBeGreaterThan(0);
        expect(layerImages(figure).some(image => image.style.display === 'none')).toBe(false);
    });
});

describe('when the scene cannot be loaded', () => {
    test.each([
        ['the request fails', () => Promise.reject(new Error('offline'))],
        ['a picture does not decode', () => Promise.resolve(SCENE)],
    ])('keeps the still, says so once and stops watching when %s', async (name, loadScene) => {
        if (name === 'a picture does not decode') {
            window.HTMLImageElement.prototype.decode = () => Promise.reject(new Error('broken file'));
        }
        const figure = mountFigure();
        const { observer, load } = start(figure, { loadScene });

        await appear(observer);

        expect(load).toHaveBeenCalledTimes(1);
        expect(figure.dataset.sbArtMotion).toBe('failed');
        expect(figure.querySelectorAll('img[data-sb-art-layer]')).toHaveLength(0);
        expect(figure.firstElementChild.style.visibility).toBe('');
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(observer.disconnected).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        expect(reducedQuery.listeners.size).toBe(0);
    });
});

describe('a figure whose scene failed', () => {
    test('does not listen to the page again when the layout asks it to look again', async () => {
        const figure = mountFigure();
        const { player, observer } = start(figure, { loadScene: () => Promise.reject(new Error('offline')) });
        await appear(observer);
        expect(figure.dataset.sbArtMotion).toBe('failed');
        const add = jest.spyOn(document, 'addEventListener');

        player.refresh();
        player.refresh();

        expect(add).not.toHaveBeenCalled();
        expect(reducedQuery.listeners.size).toBe(0);
        expect(figure.dataset.sbArtMotion).toBe('failed');
    });
});

describe('stop', () => {
    test('takes the pictures away, shows the still, and leaves no timer, observer or listener', async () => {
        const figure = mountFigure();
        const { player, observer } = start(figure);
        await appear(observer);

        player.stop();

        expect(figure.querySelectorAll('img')).toHaveLength(1);
        expect(figure.firstElementChild.style.visibility).toBe('');
        expect(figure.dataset.sbArtMotion).toBeUndefined();
        expect(jest.getTimerCount()).toBe(0);
        expect(observer.disconnected).toBe(true);
        expect(reducedQuery.listeners.size).toBe(0);
    });

    test('is safe to call twice, and ends a picture that is still loading without showing it', async () => {
        const figure = mountFigure();
        let release = () => {};
        const { player, observer } = start(figure, { loadScene: () => new Promise((resolve) => { release = () => resolve(SCENE); }) });
        await appear(observer);

        player.stop();
        player.stop();
        release();
        await flush();

        expect(figure.querySelectorAll('img')).toHaveLength(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a stopped picture ignores what the observer says afterwards', async () => {
        const figure = mountFigure();
        const { player, observer, load } = start(figure);
        player.stop();

        observer.report(true);
        await flush();

        expect(load).not.toHaveBeenCalled();
    });
});

describe('whole device pixels', () => {
    test('the layout sets the size of an art pixel on the figure, and the layers read it, so they follow every step', () => {
        const figure = createPixelFigure('hero-duo');

        sizePixelFigure(figure, { step: 2, ratio: 3 });
        expect(Number.parseFloat(figure.style.getPropertyValue('--sb-art-unit'))).toBeCloseTo(2 / 3, 6);

        sizePixelFigure(figure, { step: 1, ratio: 1 });
        expect(figure.style.getPropertyValue('--sb-art-unit')).toBe('1px');
    });
});

describe('attachArtMotion', () => {
    test('does nothing for art that stands still', () => {
        const figure = createPixelFigure('gs-reisen');

        expect(attachArtMotion(figure, 'gs-reisen')).toBeNull();
        expect(observers).toHaveLength(0);
    });
});
