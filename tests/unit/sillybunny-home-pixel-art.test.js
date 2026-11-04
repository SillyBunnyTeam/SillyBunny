/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pixel art helpers. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
    alignToDevicePixels,
    BANNER_SHARE,
    bannerRows,
    createPixelFigure,
    describeFit,
    largestStepThatFits,
    pixelCssSize,
    pixelStep,
    LAYER_EDGE_BIAS_CSS_PX,
    placePixelLayer,
    sizePixelFigure,
    watchPixelScale,
} from '../../public/scripts/sillybunny-home/pixel-art.js';

afterEach(() => {
    window.devicePixelRatio = 1;
    delete window.matchMedia;
    jest.restoreAllMocks();
});

describe('pixelStep', () => {
    test.each([
        [1, 1],
        [1.25, 1],
        [1.49, 1],
        [1.5, 2],
        [2, 2],
        [2.4, 2],
        [2.5, 3],
        [3, 3],
        [4, 4],
    ])('a screen scale of %s gives %s device pixels per art pixel', (ratio, step) => {
        expect(pixelStep(ratio)).toBe(step);
    });

    test.each([0.5, 0.75, 0.9])('never goes below 1: a zoomed-out page at %s still draws whole device pixels', (ratio) => {
        expect(pixelStep(ratio)).toBe(1);
    });

    test('reads the screen scale of the window when none is passed', () => {
        window.devicePixelRatio = 3;
        expect(pixelStep()).toBe(3);
    });

    test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('treats a screen scale of %s as 1', (ratio) => {
        window.devicePixelRatio = ratio;
        expect(pixelStep()).toBe(1);
    });
});

describe('pixelCssSize', () => {
    test('is the art size times the step, over the screen scale', () => {
        expect(pixelCssSize(189, 1, 1)).toBe(189);
        expect(pixelCssSize(189, 2, 2)).toBe(189);
        expect(pixelCssSize(189, 3, 3)).toBe(189);
    });

    test('a fractional screen scale gives a fractional CSS size that still covers whole device pixels', () => {
        const cssSize = pixelCssSize(189, 2, 1.5);
        expect(cssSize).toBeCloseTo(252, 10);
        expect(cssSize * 1.5).toBeCloseTo(378, 10);
        expect(pixelCssSize(189, 1, 1.25) * 1.25).toBeCloseTo(189, 10);
    });
});

describe('bannerRows', () => {
    test('cuts on a whole art pixel, at 62% of the figure', () => {
        expect(BANNER_SHARE).toBe(0.62);
        expect(bannerRows(368)).toBe(228);
        expect(bannerRows(305)).toBe(189);
        expect(bannerRows(425)).toBe(263);
    });

    test('always shows at least one row', () => {
        expect(bannerRows(1)).toBe(1);
    });

    test('takes a share other than the default', () => {
        expect(bannerRows(100, 0.5)).toBe(50);
    });
});

describe('largestStepThatFits', () => {
    const pair = [183, 145];
    const pairAtOneToOne = 183 + 145 + 8;

    test('keeps the fixed step when the row fits', () => {
        expect(largestStepThatFits({ widths: pair, gap: 8, step: 3, ratio: 3, availableWidth: 366 })).toEqual({ step: 3, ratio: 3 });
        expect(largestStepThatFits({ widths: [189], step: 2, ratio: 2, availableWidth: 300 })).toEqual({ step: 2, ratio: 2 });
    });

    test('keeps the step when the row is exactly as wide as the room', () => {
        expect(largestStepThatFits({ widths: pair, gap: 8, step: 1, ratio: 1, availableWidth: pairAtOneToOne })).toEqual({ step: 1, ratio: 1 });
    });

    test('goes down by whole device pixels until the row fits: a 1.5 screen cannot hold the pair at 2', () => {
        // Step 2 at 1.5 is 445 CSS pixels, wider than a 366px banner; step 1 is 227.
        expect(largestStepThatFits({ widths: pair, gap: 8, step: 2, ratio: 1.5, availableWidth: 366 })).toEqual({ step: 1, ratio: 1.5 });
    });

    test('takes the largest step that fits, not the smallest', () => {
        // At a ratio of 4 the pair is 336 CSS pixels at step 4 and 252 at step 3: 300px holds step 3.
        expect(largestStepThatFits({ widths: pair, gap: 8, step: 4, ratio: 4, availableWidth: 300 })).toEqual({ step: 3, ratio: 4 });
    });

    test('a hero of 332 art pixels on a 3x screen drops from step 3 to step 2 in a band of 320', () => {
        expect(largestStepThatFits({ widths: [332], step: 3, ratio: 3, availableWidth: 320 })).toEqual({ step: 2, ratio: 3 });
        expect(largestStepThatFits({ widths: [332], step: 3, ratio: 3, availableWidth: 332 })).toEqual({ step: 3, ratio: 3 });
    });

    test('shrinks the row by what it lacks only when even one device pixel per art pixel is too wide', () => {
        const fit = largestStepThatFits({ widths: pair, gap: 8, step: 1, ratio: 1, availableWidth: 296 });

        expect(fit.step).toBe(1);
        // The figures and the gap fill the room.
        expect((183 + 145) / fit.ratio + 8).toBeCloseTo(296, 5);
    });

    test('shrinks a single figure to the width it has: 361 art pixels in 320 CSS pixels', () => {
        const fit = largestStepThatFits({ widths: [361], step: 1, ratio: 1, availableWidth: 320 });

        expect(361 / fit.ratio).toBeCloseTo(320, 5);
    });

    test('has no gap to remove from a single figure, and does not shrink below what is there', () => {
        expect(largestStepThatFits({ widths: [200], step: 1, ratio: 1, availableWidth: 200 })).toEqual({ step: 1, ratio: 1 });
    });
});

describe('describeFit', () => {
    const fixed = { step: 3, ratio: 3 };

    test('the fixed scale is fixed, and a smaller whole step is a step', () => {
        expect(describeFit({ step: 3, ratio: 3 }, fixed)).toBe('fixed');
        expect(describeFit({ step: 2, ratio: 3 }, fixed)).toBe('step');
        expect(describeFit({ step: 1, ratio: 3 }, fixed)).toBe('step');
    });

    test('a scale with a ratio other than the one of the screen is smooth, because an art pixel is a fraction of a device pixel', () => {
        expect(describeFit({ step: 1, ratio: 3.4 }, fixed)).toBe('smooth');
        expect(describeFit(largestStepThatFits({ widths: [361], step: 1, ratio: 1, availableWidth: 320 }), { step: 1, ratio: 1 })).toBe('smooth');
    });
});

describe('createPixelFigure and sizePixelFigure', () => {
    test('a figure carries the art name, holds one picture without a text alternative, and fails fast on an unknown name', () => {
        const figure = createPixelFigure('gs-reisen');

        expect(figure.dataset.sbArtPlaceholder).toBe('gs-reisen');
        const image = figure.firstElementChild;
        expect(image.tagName).toBe('IMG');
        expect(image.getAttribute('alt')).toBe('');
        expect(image.getAttribute('src')).toMatch(/^\/img\/sillybunny\/gs-reisen@native\.webp\?v=\d+[a-z]$/);
        expect(image.getAttribute('width')).toBe('189');
        expect(image.getAttribute('height')).toBe('372');
        expect(() => createPixelFigure('no-such-art')).toThrow('no-such-art');
    });

    test('sizes the figure and its picture to the step', () => {
        const figure = createPixelFigure('about-tewi');

        sizePixelFigure(figure, { step: 2, ratio: 2 });

        expect([figure.style.width, figure.style.height]).toEqual(['145px', '305px']);
        expect([figure.firstElementChild.style.width, figure.firstElementChild.style.height]).toEqual(['145px', '305px']);
    });

    test('a banner clips the figure to its rows and leaves the picture whole', () => {
        const figure = createPixelFigure('about-tewi');

        sizePixelFigure(figure, { step: 3, ratio: 3, rows: bannerRows(305) });

        expect([figure.style.width, figure.style.height]).toEqual(['145px', '189px']);
        expect(figure.firstElementChild.style.height).toBe('305px');
    });
});

describe('placePixelLayer', () => {
    function layerAt(box) {
        const layer = document.createElement('img');
        layer.dataset.sbArtBox = box;
        return layer;
    }

    test('puts a layer at its box in art pixels, in the size of an art pixel that it is given', () => {
        const layer = layerAt('10 20 30 40');

        placePixelLayer(layer, 2);

        expect(layer.style.position).toBe('absolute');
        expect([layer.style.left, layer.style.top, layer.style.width, layer.style.height].map(Number.parseFloat).map(Math.floor)).toEqual([20, 40, 60, 80]);
    });

    // A length is cut down to a layout unit, so an edge that should be a whole device pixel can end under it. The bias is
    // the same in CSS pixels whatever the ratio of the screen, because the unit is, and every edge gets it.
    test.each([1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3])('adds the same bias in CSS pixels to every edge at a scale of %s', (ratio) => {
        window.devicePixelRatio = ratio;
        const layer = layerAt('7 9 11 13');
        const unit = 2 / ratio;

        placePixelLayer(layer, unit);

        const offsets = [[layer.style.left, 7], [layer.style.top, 9], [layer.style.width, 11], [layer.style.height, 13]]
            .map(([value, art]) => Number.parseFloat(value) - art * unit);
        for (const offset of offsets) {
            expect(offset).toBeCloseTo(LAYER_EDGE_BIAS_CSS_PX, 9);
        }
    });

    test('keeps the bias above two layout units and below four, where the layered evenness tests start to fail', () => {
        expect(LAYER_EDGE_BIAS_CSS_PX).toBeGreaterThan(2 / 64);
        expect(LAYER_EDGE_BIAS_CSS_PX).toBeLessThan(4 / 64);
    });
});

describe('watchPixelScale', () => {
    function stubMatchMedia() {
        const queries = [];
        window.matchMedia = jest.fn((text) => {
            const listeners = [];
            const query = {
                text,
                addEventListener: jest.fn((type, listener) => listeners.push(listener)),
                removeEventListener: jest.fn(),
                fire: () => listeners.splice(0).forEach(listener => listener()),
            };
            queries.push(query);
            return query;
        });
        return queries;
    }

    test('names the current ratio, and names the new one after a change, which re-arms the query', () => {
        const queries = stubMatchMedia();
        const onChange = jest.fn();
        window.devicePixelRatio = 1;

        watchPixelScale(onChange);
        expect(queries.map(query => query.text)).toEqual(['(resolution: 1dppx)']);

        window.devicePixelRatio = 2;
        queries[0].fire();
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(queries.map(query => query.text)).toEqual(['(resolution: 1dppx)', '(resolution: 2dppx)']);

        window.devicePixelRatio = 1.5;
        queries[1].fire();
        expect(onChange).toHaveBeenCalledTimes(2);
        expect(queries[2].text).toBe('(resolution: 1.5dppx)');
    });

    test('stops listening, and ignores a change that was already on its way', () => {
        const queries = stubMatchMedia();
        const onChange = jest.fn();

        const stop = watchPixelScale(onChange);
        stop();
        queries[0].fire();

        expect(onChange).not.toHaveBeenCalled();
        expect(queries).toHaveLength(1);
        expect(queries[0].removeEventListener).toHaveBeenCalled();
    });

    test('does nothing where the browser has no matchMedia', () => {
        expect(() => watchPixelScale(() => {})()).not.toThrow();
    });
});

describe('alignToDevicePixels', () => {
    function placeFigure({ transformedAncestor, left, top }) {
        const parent = document.createElement('div');
        const figure = document.createElement('span');
        parent.append(figure);
        document.body.append(parent);
        jest.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
            transform: transformedAncestor ? 'matrix(1, 0, 0, 1, 0, 0)' : 'none',
            translate: 'none',
            scale: 'none',
            rotate: 'none',
        }));
        figure.getBoundingClientRect = () => ({ left, top });
        return figure;
    }

    test('does nothing below an ancestor that has no transform, because the browser already rounds the box', () => {
        window.devicePixelRatio = 2;
        const figure = placeFigure({ transformedAncestor: false, left: 10.25, top: 20.25 });
        figure.style.translate = '3px 3px';

        alignToDevicePixels(figure);

        expect(figure.style.translate).toBe('');
    });

    test('moves the figure to the nearest device pixel below a transformed ancestor', () => {
        window.devicePixelRatio = 2;
        const figure = placeFigure({ transformedAncestor: true, left: 10.25, top: 20.75 });

        alignToDevicePixels(figure);

        // 10.25 CSS px is 20.5 device px, which rounds to 21; 20.75 is 41.5, which rounds to 42.
        expect(figure.style.translate).toBe('0.25px 0.25px');
    });

    test('leaves a figure that already starts on a device pixel alone', () => {
        window.devicePixelRatio = 2;
        const figure = placeFigure({ transformedAncestor: true, left: 10.5, top: 20 });

        alignToDevicePixels(figure);

        expect(figure.style.translate).toBe('');
    });
});
