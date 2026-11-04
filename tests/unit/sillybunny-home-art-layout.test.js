/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the art layout. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    ART_GAP,
    createArtPanel,
    BANNER_HEIGHT_SHARE,
    createHeroArt,
    FIGURE_GAP,
    maxBannerRows,
    measureArtPanel,
    MIN_BANNER_ROWS,
    MIN_CONTENT_WIDTH,
    PANEL_PADDING,
    planArtMode,
    planBanner,
    planWidening,
} from '../../public/scripts/sillybunny-home/art-layout.js';

// jsdom has no ResizeObserver. The stub records what the layout asks of it.
const observer = { observe: jest.fn(), unobserve: jest.fn(), disconnect: jest.fn() };
window.ResizeObserver = class {
    observe(...args) { observer.observe(...args); }
    unobserve(...args) { observer.unobserve(...args); }
    disconnect(...args) { observer.disconnect(...args); }
};

/** A host with a width, which jsdom does not lay out. `width` can change through the returned object. */
function hostOfWidth(initial) {
    const state = { width: initial };
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { get: () => state.width });
    return Object.assign(host, { state });
}

beforeEach(() => {
    Object.values(observer).forEach(mock => mock.mockClear());
});

afterEach(() => {
    document.body.replaceChildren();
    window.devicePixelRatio = 1;
    window.innerHeight = 768;
});

describe('measureArtPanel', () => {
    test('a single figure at 1x is its art size plus the padding', () => {
        const size = measureArtPanel(['gs-reisen'], { step: 1, ratio: 1 });

        expect(size.panelWidth).toBe(189 + 2 * PANEL_PADDING);
        expect(size.panelHeight).toBe(372 + 2 * PANEL_PADDING);
    });

    test('the same art is the same CSS size at 1x, 2x and 3x, because the step follows the ratio', () => {
        const at = (step, ratio) => measureArtPanel(['gs-reisen'], { step, ratio });

        expect(at(2, 2)).toEqual(at(1, 1));
        expect(at(3, 3)).toEqual(at(1, 1));
    });

    test('two figures stand side by side at one step, and the panel is as tall as the taller', () => {
        const size = measureArtPanel(['about-reisen', 'about-tewi'], { step: 1, ratio: 1 });

        expect(size.panelWidth).toBe(183 + 145 + FIGURE_GAP + 2 * PANEL_PADDING);
        expect(size.panelHeight).toBe(368 + 2 * PANEL_PADDING);
    });

    test('a 1.5 screen draws the art a third larger than 1x, and still in whole device pixels', () => {
        const size = measureArtPanel(['gs-reisen'], { step: 2, ratio: 1.5 });

        expect(size.panelWidth - 2 * PANEL_PADDING).toBeCloseTo(189 * 2 / 1.5, 10);
        expect((size.panelWidth - 2 * PANEL_PADDING) * 1.5).toBeCloseTo(189 * 2, 10);
    });

    test('fails fast on art that is not in the export', () => {
        expect(() => measureArtPanel(['not-art'], { step: 1, ratio: 1 })).toThrow('not-art');
    });
});

describe('planArtMode', () => {
    test('the content column keeps 360px beside a panel, and a panel is 16px from it', () => {
        expect([MIN_CONTENT_WIDTH, ART_GAP]).toEqual([360, 16]);
    });

    const panelWidth = 213 + 2 * PANEL_PADDING;
    const base = { panelWidth, panelHeight: 396, availableHeight: 600 };
    const wide = panelWidth + ART_GAP + MIN_CONTENT_WIDTH;

    test('a panel when the content column keeps its width and the panel fits the height', () => {
        expect(planArtMode({ ...base, contentWidth: wide })).toBe('panel');
        expect(planArtMode({ ...base, contentWidth: 1200 })).toBe('panel');
    });

    test('a banner when the column would be even a pixel narrower than the minimum', () => {
        expect(planArtMode({ ...base, contentWidth: wide - 1 })).toBe('banner');
        expect(planArtMode({ ...base, contentWidth: 300 })).toBe('banner');
    });

    test('a banner when the panel is taller than the room, however wide the window is', () => {
        expect(planArtMode({ ...base, contentWidth: 1200, availableHeight: 395 })).toBe('banner');
        expect(planArtMode({ ...base, contentWidth: 1200, availableHeight: 396 })).toBe('panel');
    });

    test('a panel that is shown stays until the column is more than 16px short, so a scrollbar does not flip it', () => {
        expect(planArtMode({ ...base, contentWidth: wide - 15, current: 'panel' })).toBe('panel');
        expect(planArtMode({ ...base, contentWidth: wide - 17, current: 'panel' })).toBe('banner');
        expect(planArtMode({ ...base, contentWidth: wide - 15, current: 'banner' })).toBe('banner');
    });

    test('a larger text size asks for a wider column', () => {
        const minContentWidth = MIN_CONTENT_WIDTH * 1.25;

        expect(planArtMode({ ...base, contentWidth: wide, minContentWidth })).toBe('banner');
        expect(planArtMode({ ...base, contentWidth: wide + 90, minContentWidth })).toBe('panel');
    });

    test('a host that has no limit on its height only looks at the width', () => {
        expect(planArtMode({ ...base, contentWidth: 1200, availableHeight: Number.POSITIVE_INFINITY })).toBe('panel');
    });
});

describe('maxBannerRows and planBanner', () => {
    const at = (viewportHeight, step = 1, ratio = 1) => ({ viewportHeight, step, ratio });
    const plan = (ids, viewportHeight, step = 1, ratio = 1) => planBanner({ ids, scale: { step, ratio }, viewportHeight });

    test('a banner may be 30% of the viewport height, with the padding above the art counted', () => {
        expect(BANNER_HEIGHT_SHARE).toBe(0.3);
        // 0.3 x 390 = 117 CSS pixels, less the 12 above the art.
        expect(maxBannerRows(at(390))).toBe(105);
        expect(maxBannerRows(at(600))).toBe(168);
    });

    test('a whole step covers one CSS pixel per row at its own ratio, so the limit is the same at 1x, 2x and 3x', () => {
        expect(maxBannerRows(at(390, 2, 2))).toBe(105);
        expect(maxBannerRows(at(390, 3, 3))).toBe(105);
    });

    test('a 1.5 screen draws a row 4/3 CSS pixels tall at step 2, so the limit is lower', () => {
        // 105 CSS pixels of room hold 78 rows of 4/3 pixels.
        expect(maxBannerRows(at(390, 2, 1.5))).toBe(78);
    });

    test('stops at the row that lands exactly on 30%', () => {
        expect(maxBannerRows(at((100 + PANEL_PADDING) / 0.3))).toBe(100);
        expect(maxBannerRows(at((100 + PANEL_PADDING) / 0.3 - 1))).toBe(99);
    });

    test('the rows of each figure are its usual crop, cut shorter on a short viewport', () => {
        // 62% of 368 and 305 rows is 228 and 189.
        expect(plan(['about-reisen', 'about-tewi'], 2000).rows).toEqual([228, 189]);
        expect(plan(['about-reisen', 'about-tewi'], 390).rows).toEqual([105, 105]);
        expect(plan(['about-reisen', 'about-tewi'], 600).rows).toEqual([168, 168]);
    });

    test('a figure whose usual crop is already short keeps it', () => {
        // 0.3 x 800 = 240, less 12, is 228 rows: the 189 rows of Tewi are under it.
        expect(plan(['about-reisen', 'about-tewi'], 800).rows).toEqual([228, 189]);
    });

    test('keeps the scale it was given when the rows fit', () => {
        expect(plan(['gs-reisen'], 2000, 2, 1.5).scale).toEqual({ step: 2, ratio: 1.5 });
    });

    test('the art is hidden when even step 1 shows fewer than 90 rows', () => {
        expect(MIN_BANNER_ROWS).toBe(90);
        // 90 rows need 102 CSS pixels, which is 30% of 340.
        expect(plan(['gs-reisen'], 340).rows).toEqual([90]);
        expect(plan(['gs-reisen'], 339)).toBeNull();
        expect(plan(['gs-reisen'], 0)).toBeNull();
    });

    test('a landscape phone at 1.5x steps down to step 1 instead of hiding the banner', () => {
        // Step 2 on a 390px viewport shows 78 rows. Step 1 is 2/3 of a CSS pixel per row and shows 157.
        expect(plan(['gs-reisen'], 390, 2, 1.5)).toEqual({ scale: { step: 1, ratio: 1.5 }, rows: [157] });
    });

    test('steps down by whole steps, to the largest that shows 90 rows', () => {
        // At 4x a row of step 4 is 1 CSS pixel and a row of step 3 is 3/4. 339px leaves 89.7 CSS pixels of room.
        expect(plan(['gs-reisen'], 339, 4, 4).scale).toEqual({ step: 3, ratio: 4 });
        // 250px leaves 63: step 3 shows 84 rows and step 2 shows 126.
        expect(plan(['gs-reisen'], 250, 4, 4).scale).toEqual({ step: 2, ratio: 4 });
    });

    test('a viewport under 240px tall at 1.5x hides the banner even at step 1', () => {
        // 90 rows of 2/3 pixels are 60 CSS pixels, plus 12, which is 30% of 240.
        expect(plan(['gs-reisen'], 240, 2, 1.5).scale).toEqual({ step: 1, ratio: 1.5 });
        expect(plan(['gs-reisen'], 239, 2, 1.5)).toBeNull();
    });
});

describe('planWidening', () => {
    test('is done when the column has enough, and when the screen has no room', () => {
        expect(planWidening({ shortfall: 0, gain: 0.7, probed: false, room: 100 })).toEqual({ action: 'done' });
        expect(planWidening({ shortfall: -20, gain: null, probed: false, room: 100 })).toEqual({ action: 'done' });
        expect(planWidening({ shortfall: 35, gain: null, probed: false, room: 0 })).toEqual({ action: 'done' });
    });

    test('probes with the shortfall once when no gain is known, and never past the room', () => {
        expect(planWidening({ shortfall: 34.2, gain: null, probed: false, room: 100 })).toEqual({ action: 'probe', extra: 35 });
        expect(planWidening({ shortfall: 35, gain: null, probed: false, room: 20 })).toEqual({ action: 'probe', extra: 20 });
    });

    test('takes a probe back when it gained under 5%, because the screen limits the window', () => {
        expect(planWidening({ shortfall: 35, gain: 0.04, probed: true, room: 100 })).toEqual({ action: 'take-back' });
        expect(planWidening({ shortfall: 35, gain: 0.05, probed: true, room: 100 })).toEqual({ action: 'correct', extra: 100 });
    });

    test('leaves a first widening that gained next to nothing where it is', () => {
        expect(planWidening({ shortfall: 35, gain: 0.01, probed: false, room: 100 })).toEqual({ action: 'done' });
    });

    test('corrects by the shortfall over the gain, never counting a gain above 1, and never past the room', () => {
        expect(planWidening({ shortfall: 35, gain: 0.75, probed: false, room: 500 })).toEqual({ action: 'correct', extra: 47 });
        expect(planWidening({ shortfall: 35, gain: 1.4, probed: true, room: 500 })).toEqual({ action: 'correct', extra: 35 });
        expect(planWidening({ shortfall: 35, gain: 0.75, probed: false, room: 40 })).toEqual({ action: 'correct', extra: 40 });
    });
});

describe('createArtPanel', () => {
    test('builds a hidden-from-assistive-technology panel of figures, sized as a banner before it is in the document', () => {
        window.innerHeight = 2000;
        const { panel } = createArtPanel(['about-reisen', 'about-tewi']);

        expect(panel.className).toBe('sbArtPanel');
        expect(panel.getAttribute('aria-hidden')).toBe('true');
        expect(panel.dataset.sbArtMode).toBe('banner');
        expect([...panel.children].map(figure => figure.dataset.sbArtPlaceholder)).toEqual(['about-reisen', 'about-tewi']);
        expect([...panel.children].map(figure => figure.style.height)).toEqual(['228px', '189px']);
        expect(panel.style.getPropertyValue('--sb-art-pad')).toBe(`${PANEL_PADDING}px`);
        expect(panel.style.getPropertyValue('--sb-art-figure-gap')).toBe(`${FIGURE_GAP}px`);
    });

    test('uses the step of the screen it is made on', () => {
        window.devicePixelRatio = 2;
        window.innerHeight = 2000;

        const { panel } = createArtPanel(['gs-reisen']);

        // Step 2 at ratio 2: 189 x 2 / 2.
        expect(panel.firstElementChild.style.width).toBe('189px');
        expect(panel.firstElementChild.style.height).toBe(`${Math.floor(372 * 0.62)}px`);
    });

    test('works out the scale again when its figures are swapped, because the screen may have changed', () => {
        window.innerHeight = 2000;
        const { panel, setArts } = createArtPanel(['gs-reisen']);
        expect(panel.firstElementChild.style.width).toBe('189px');

        window.devicePixelRatio = 3;
        setArts(['about-tewi']);

        // Step 3 at ratio 3 is the same CSS size as step 1 at 1x.
        expect(panel.firstElementChild.style.width).toBe('145px');
        expect(panel.firstElementChild.style.height).toBe(`${Math.floor(305 * 0.62)}px`);
    });

    test('is cut to 30% of the viewport height before it is in the document', () => {
        window.innerHeight = 390;

        const { panel } = createArtPanel(['about-reisen', 'about-tewi']);

        expect(panel.dataset.sbArtMode).toBe('banner');
        expect([...panel.children].map(figure => figure.style.height)).toEqual(['105px', '105px']);
    });

    test('is hidden before it is in the document when the viewport is too short for a banner', () => {
        window.innerHeight = 300;

        const { panel } = createArtPanel(['gs-reisen']);

        expect(panel.dataset.sbArtMode).toBe('hidden');
    });

    test('decides its mode in the same task that puts it in the document, so a slide measures the right height', () => {
        window.innerHeight = 2000;
        const host = document.createElement('div');
        Object.defineProperty(host, 'clientWidth', { value: 1200 });
        const { panel } = createArtPanel(['gs-reisen']);
        expect(panel.dataset.sbArtMode).toBe('banner');

        host.append(panel);
        document.body.append(host);

        expect([panel.dataset.sbArtMode, host.dataset.sbArtMode]).toEqual(['panel', 'panel']);
        host.remove();
    });

    test('keeps panel when its host is drawn with no width, as a page that a slide covers is', () => {
        window.innerHeight = 2000;
        const host = hostOfWidth(1200);
        const { panel } = createArtPanel(['gs-reisen']);
        host.append(panel);
        document.body.append(host);
        expect(panel.dataset.sbArtMode).toBe('panel');

        panel.remove();
        host.state.width = 0;
        host.append(panel);

        expect([panel.dataset.sbArtMode, host.dataset.sbArtMode]).toEqual(['panel', 'panel']);
    });

    test('defines its element once, however many panels are made', () => {
        const first = createArtPanel(['gs-reisen']).panel;
        const second = createArtPanel(['gs-reisen-done']).panel;

        expect(customElements.get('sb-art-panel')).toBeDefined();
        expect(first).toBeInstanceOf(customElements.get('sb-art-panel'));
        expect(second).toBeInstanceOf(customElements.get('sb-art-panel'));
    });

    test('is taken out of the layout when it leaves the document, and put back with a new layout when it returns', () => {
        window.innerHeight = 2000;
        const wide = hostOfWidth(1200);
        const { panel } = createArtPanel(['gs-reisen']);
        wide.append(panel);
        document.body.append(wide);
        expect(observer.observe).toHaveBeenCalledWith(panel);
        expect(observer.observe).toHaveBeenCalledWith(wide);

        panel.remove();

        expect(observer.unobserve).toHaveBeenCalledWith(panel);
        expect(observer.unobserve).toHaveBeenCalledWith(wide);
        expect(observer.disconnect).toHaveBeenCalledTimes(1);

        observer.observe.mockClear();
        const narrow = hostOfWidth(300);
        narrow.append(panel);
        document.body.append(narrow);

        expect(observer.observe).toHaveBeenCalledWith(panel);
        expect(observer.observe).toHaveBeenCalledWith(narrow);
        expect([panel.dataset.sbArtMode, narrow.dataset.sbArtMode]).toEqual(['banner', 'banner']);
    });

    test('stops once, and leaves nothing behind, when the panel was never in the document', () => {
        const { panel } = createArtPanel(['gs-reisen']);
        panel.remove();

        expect(observer.unobserve).not.toHaveBeenCalled();
        expect(observer.observe).not.toHaveBeenCalled();
    });

    test('keeps its mode in a host that is not drawn', () => {
        window.innerHeight = 2000;
        const host = document.createElement('div');
        const { panel } = createArtPanel(['gs-reisen']);

        host.append(panel);
        document.body.append(host);

        expect(panel.dataset.sbArtMode).toBe('banner');
        expect(host.dataset.sbArtMode).toBeUndefined();
        host.remove();
    });

    test('swaps its figures for another set, and leaves them alone when the set is the same', () => {
        const { panel, setArts } = createArtPanel(['gs-reisen']);
        const first = panel.firstElementChild;

        setArts(['gs-reisen']);
        expect(panel.firstElementChild).toBe(first);

        setArts(['gs-reisen-done']);
        expect(panel.children).toHaveLength(1);
        expect(panel.firstElementChild.dataset.sbArtPlaceholder).toBe('gs-reisen-done');
    });
});

describe('createHeroArt', () => {
    test.each([
        ['hero-duo', 332, 366],
        ['hero-duo-night', 361, 362],
    ])('%s is one hidden figure of its own size, in the class that the band styles', (id, width, height) => {
        const figure = createHeroArt(id);

        expect(figure.classList.contains('sbHomeHeroArt')).toBe(true);
        expect(figure.getAttribute('aria-hidden')).toBe('true');
        expect(figure.dataset.sbArtPlaceholder).toBe(id);
        expect(figure.querySelectorAll('img')).toHaveLength(1);
        expect([figure.style.width, figure.style.height]).toEqual([`${width}px`, `${height}px`]);
    });

    test('is sized at the fixed step of its screen before it is in the document: 3x is the same CSS size as 1x', () => {
        window.devicePixelRatio = 3;

        const figure = createHeroArt('hero-duo');

        expect([figure.style.width, figure.style.height]).toEqual(['332px', '366px']);
    });

    test('fails fast on a hero that is not in the export', () => {
        expect(() => createHeroArt('hero-trio')).toThrow('hero-trio');
    });
});
