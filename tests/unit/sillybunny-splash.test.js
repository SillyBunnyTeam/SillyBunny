/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readImageSize } from '../helpers/image-size.js';

const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
const splashSource = readFileSync(fileURLToPath(new URL('../../public/scripts/sillybunny-splash.js', import.meta.url)), 'utf8');

const PRELOADER_MARKUP = `
    <div id="preloader">
        <div class="sb-boot-splash">
            <img class="sb-boot-mascot" alt="">
            <p class="sb-boot-line" role="status">
                <span class="sb-boot-line-text"></span>
                <span class="sb-boot-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
            </p>
        </div>
    </div>`;

// Values chosen so each lands in a different third of [0, 1).
const RANDOM_FOR_VARIANT = { reisen: 0.1, tewi: 0.5, both: 0.9 };

function runSplash({ stored, random = 0.1, storageThrows = false } = {}) {
    document.body.innerHTML = PRELOADER_MARKUP;
    localStorage.clear();
    if (stored !== undefined) localStorage.setItem('sb-splash-character', stored);
    if (storageThrows) {
        jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage blocked');
        });
    }
    jest.spyOn(Math, 'random').mockReturnValue(random);
    new window.Function(splashSource)();
    return {
        preloader: document.getElementById('preloader'),
        mascot: document.querySelector('.sb-boot-mascot'),
        lineText: document.querySelector('.sb-boot-line-text'),
    };
}

beforeEach(() => {
    delete window.SillyBunnySplash;
});

afterEach(() => {
    delete window.matchMedia;
    window.innerHeight = 768;
    window.devicePixelRatio = 1;
    jest.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
});

describe('splash variant', () => {
    test.each(['reisen', 'tewi', 'both'])('uses the stored %s variant, not a random pick', (variant) => {
        const otherVariantRandom = RANDOM_FOR_VARIANT[variant === 'reisen' ? 'both' : 'reisen'];
        const { mascot } = runSplash({ stored: variant, random: otherVariantRandom });

        expect(mascot.dataset.variant).toBe(variant);
    });

    test.each([
        ['random', 'reisen'],
        ['random', 'tewi'],
        ['random', 'both'],
        [undefined, 'reisen'],
        [undefined, 'tewi'],
        [undefined, 'both'],
    ])('stored %s picks %s when the random draw falls in its third', (stored, variant) => {
        const { mascot } = runSplash({ stored, random: RANDOM_FOR_VARIANT[variant] });

        expect(mascot.dataset.variant).toBe(variant);
    });

    test.each(['nope', 'Tewi', ' tewi', ''])('treats the invalid value %j as random', (stored) => {
        const { mascot } = runSplash({ stored, random: RANDOM_FOR_VARIANT.both });

        expect(mascot.dataset.variant).toBe('both');
    });

    test('falls back to random when storage throws', () => {
        const { mascot } = runSplash({ storageThrows: true, random: RANDOM_FOR_VARIANT.tewi });

        expect(mascot.dataset.variant).toBe('tewi');
    });

    test('does nothing when the page has no preloader', () => {
        document.body.innerHTML = '';
        jest.spyOn(Math, 'random').mockReturnValue(0.1);

        expect(() => new window.Function(splashSource)()).not.toThrow();
    });
});

const SPEC = fileURLToPath(new URL('../../assets-src/branding/export-specs/shell.json', import.meta.url));

/** The viewport and screen scale that a splash is drawn on. */
function onScreen({ height, ratio }) {
    window.innerHeight = height;
    window.devicePixelRatio = ratio;
}

describe('splash fit', () => {
    test('the step is the largest whole one whose tallest picture is at most 42% of the viewport height', () => {
        runSplash();
        const { chooseFit, HEIGHT_SHARE, TALLEST_ROWS } = window.SillyBunnySplash;

        expect([HEIGHT_SHARE, TALLEST_ROWS]).toEqual([0.42, 366]);
        // 0.42 x 1000 x 3 = 1260 device pixels, which holds 3 steps of 366 (1098) and not 4 (1464).
        expect(chooseFit(1000, 3)).toEqual({ step: 3, smooth: false, cssPerArtPixel: 1 });
        // 0.42 x 1000 x 4 = 1680 holds 4 steps and not 5 (1830).
        expect(chooseFit(1000, 4).step).toBe(4);
    });

    test('a 1440x900 screen at 2x gets step 2, which is 41% of the height, and not step 1 at 20%', () => {
        runSplash();

        expect(window.SillyBunnySplash.chooseFit(900, 2)).toEqual({ step: 2, smooth: false, cssPerArtPixel: 1 });
    });

    test('stops at the step that lands exactly on the share', () => {
        runSplash();
        const { chooseFit, TALLEST_ROWS } = window.SillyBunnySplash;

        // Two steps of the tallest picture are exactly 42% of this height at 1x; one device pixel less is not enough.
        expect(chooseFit((2 * TALLEST_ROWS) / 0.42, 1).step).toBe(2);
        expect(chooseFit((2 * TALLEST_ROWS - 1) / 0.42, 1).step).toBe(1);
    });

    test('step 1 stays whole up to 60% of the viewport height, and a taller picture is shrunk', () => {
        runSplash();
        const { chooseFit, STEP_ONE_MAX_SHARE } = window.SillyBunnySplash;

        expect(STEP_ONE_MAX_SHARE).toBe(0.6);
        // 366 / 0.6 = 610 px: the picture is exactly 60% of the viewport.
        expect(chooseFit(610, 1)).toEqual({ step: 1, smooth: false, cssPerArtPixel: 1 });
        expect(chooseFit(609, 1).smooth).toBe(true);
    });

    test('a shrunk picture is 42% of the viewport height, with no step', () => {
        runSplash();

        const fit = window.SillyBunnySplash.chooseFit(390, 1);

        expect(fit.smooth).toBe(true);
        expect(fit.step).toBe(0);
        expect(366 * fit.cssPerArtPixel).toBeCloseTo(0.42 * 390, 6);
    });

    test.each([
        [768, 1],
        [600, 2],
        [390, 2],
        [390, 3],
    ])('is a whole step wherever one fits within 60%: %s px at %sx', (height, ratio) => {
        runSplash();
        const fit = window.SillyBunnySplash.chooseFit(height, ratio);

        expect(fit.smooth).toBe(false);
        expect(fit.step).toBeGreaterThanOrEqual(1);
        expect(fit.cssPerArtPixel).toBe(fit.step / ratio);
    });

    test('a viewport with no height keeps step 1', () => {
        runSplash();

        expect(window.SillyBunnySplash.chooseFit(0, 2)).toEqual({ step: 1, smooth: false, cssPerArtPixel: 0.5 });
    });

    test('grows with the screen scale, because the share is of device pixels', () => {
        runSplash();
        const { chooseFit } = window.SillyBunnySplash;

        const steps = [1, 2, 3, 4].map(ratio => chooseFit(900, ratio).step);

        expect(steps).toEqual([1, 2, 3, 4]);
    });
});

describe('splash picture', () => {
    test.each([
        ['reisen', 'splash-reisen@native.webp', 204, 366],
        ['tewi', 'splash-tewi@native.webp', 141, 320],
        ['both', 'splash-both@native.webp', 263, 366],
    ])('%s is %s, sized before its file loads, with the attributes of its own size', (variant, file, width, height) => {
        onScreen({ height: 768, ratio: 1 });
        const { mascot } = runSplash({ stored: variant });

        expect(mascot.getAttribute('src').startsWith(`/img/sillybunny/${file}?v=`)).toBe(true);
        expect(mascot.getAttribute('src').split('?v=')[1]).toBe(window.SillyBunnySplash.ART_VERSION);
        expect([mascot.getAttribute('width'), mascot.getAttribute('height')]).toEqual([String(width), String(height)]);
        expect([mascot.style.width, mascot.style.height]).toEqual([`${width}px`, `${height}px`]);
        expect([mascot.getAttribute('data-step'), mascot.getAttribute('data-fit')]).toEqual(['1', 'step']);
    });

    test.each(['reisen', 'tewi', 'both'])('%s is drawn at the step of the tallest picture: Tewi is not enlarged to fill the share', (variant) => {
        onScreen({ height: 1000, ratio: 3 });
        const { mascot } = runSplash({ stored: variant });
        const { width, height } = window.SillyBunnySplash.ART[variant];

        // 0.42 x 1000 x 3 = 1260 device pixels holds 3 steps of the 366 rows of the tallest picture.
        expect(mascot.getAttribute('data-step')).toBe('3');
        expect([mascot.style.width, mascot.style.height]).toEqual([`${width}px`, `${height}px`]);
    });

    test('on a 390x844 phone at 3x the art is two steps, which is 244px tall', () => {
        onScreen({ height: 844, ratio: 3 });
        const { mascot } = runSplash({ stored: 'reisen' });

        expect([mascot.getAttribute('data-step'), mascot.style.height]).toEqual(['2', '244px']);
    });

    test('the CSS size is the art size times the step over the screen scale, so every art pixel is whole device pixels', () => {
        onScreen({ height: 900, ratio: 4 });
        const { mascot } = runSplash({ stored: 'both' });

        expect(mascot.getAttribute('data-step')).toBe('4');
        expect([mascot.style.width, mascot.style.height]).toEqual(['263px', '366px']);
    });

    test('on a short screen at 1x the picture is shrunk to 42% of the height, in the same proportions, and drawn smooth', () => {
        onScreen({ height: 390, ratio: 1 });
        const { mascot } = runSplash({ stored: 'both' });
        const scale = (0.42 * 390) / 366;

        expect(mascot.getAttribute('data-fit')).toBe('smooth');
        expect(mascot.hasAttribute('data-step')).toBe(false);
        expect(Number.parseFloat(mascot.style.height)).toBeCloseTo(366 * scale, 6);
        expect(Number.parseFloat(mascot.style.width)).toBeCloseTo(263 * scale, 6);
    });

    test('Tewi keeps her height relative to Reisen when the picture is shrunk', () => {
        onScreen({ height: 390, ratio: 1 });
        const reisen = Number.parseFloat(runSplash({ stored: 'reisen' }).mascot.style.height);
        const tewi = Number.parseFloat(runSplash({ stored: 'tewi' }).mascot.style.height);

        expect(tewi / reisen).toBeCloseTo(320 / 366, 6);
    });

    test('is drawn again when the window changes size, with no new request for the file', () => {
        onScreen({ height: 768, ratio: 1 });
        const { mascot } = runSplash({ stored: 'reisen' });
        const source = mascot.getAttribute('src');

        onScreen({ height: 1200, ratio: 2 });
        window.dispatchEvent(new Event('resize'));

        // 0.42 x 1200 x 2 = 1008 device pixels holds two steps of 366.
        expect([mascot.getAttribute('data-step'), mascot.style.height]).toEqual(['2', '366px']);
        expect(mascot.getAttribute('src')).toBe(source);
    });

    test('goes from a whole step to a shrunk picture and back when the window changes height', () => {
        onScreen({ height: 768, ratio: 1 });
        const { mascot } = runSplash({ stored: 'reisen' });

        onScreen({ height: 390, ratio: 1 });
        window.dispatchEvent(new Event('resize'));
        expect(mascot.getAttribute('data-fit')).toBe('smooth');

        onScreen({ height: 768, ratio: 1 });
        window.dispatchEvent(new Event('resize'));
        expect([mascot.getAttribute('data-fit'), mascot.getAttribute('data-step')]).toEqual(['step', '1']);
    });

    test('stops listening to the window once the preloader has gone', () => {
        onScreen({ height: 768, ratio: 1 });
        const { mascot } = runSplash({ stored: 'reisen' });
        const removeListener = jest.spyOn(window, 'removeEventListener');
        mascot.remove();

        window.dispatchEvent(new Event('resize'));

        expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function));
    });

    describe('watching the screen scale', () => {
        function stubMatchMedia() {
            const pending = [];
            window.matchMedia = jest.fn(() => ({
                addEventListener: (_type, listener) => pending.push(listener),
            }));
            return {
                queries: window.matchMedia,
                fire: () => pending.splice(0).forEach(listener => listener()),
                armed: () => pending.length,
            };
        }

        test('draws the picture again after a change of scale and keeps watching', () => {
            onScreen({ height: 768, ratio: 1 });
            const screen = stubMatchMedia();
            const { mascot } = runSplash({ stored: 'reisen' });
            expect(screen.armed()).toBe(1);

            onScreen({ height: 768, ratio: 2 });
            screen.fire();

            expect(mascot.getAttribute('data-step')).toBe('1');
            expect(mascot.style.height).toBe('183px');
            expect(screen.queries).toHaveBeenCalledTimes(2);
            expect(screen.armed()).toBe(1);
        });

        test('does not ask for the next change once the preloader has gone', () => {
            onScreen({ height: 768, ratio: 1 });
            const screen = stubMatchMedia();
            const { mascot } = runSplash({ stored: 'reisen' });
            mascot.remove();

            screen.fire();

            expect(screen.queries).toHaveBeenCalledTimes(1);
            expect(screen.armed()).toBe(0);
        });
    });
});

describe('splash art files', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8'));

    test.each(['reisen', 'tewi', 'both'])('the %s picture is the file of the table, at the size of the table, from the snapped masters', (variant) => {
        runSplash({ stored: variant });
        const { file, width, height } = window.SillyBunnySplash.ART[variant];
        const bytes = readFileSync(`${publicRoot}img/sillybunny/${file}`);

        expect(readImageSize(bytes)).toEqual({ width, height });
        expect(spec.assets[`splash-${variant}`]).toMatchObject({ pixel: true, master: `approved/pixel/splash-${variant}.png` });
        expect(window.SillyBunnySplash.ART_VERSION).toMatch(/^\d{8}[a-z]$/);
    });
});

describe('splash line', () => {
    test.each([
        ['reisen', 'SPLASH-REISEN-*'],
        ['tewi', 'SPLASH-TEWI-*'],
        ['both', 'SPLASH-BOTH-*'],
    ])('the %s placeholder line is flagged with slot %s', (variant, slot) => {
        const { lineText } = runSplash({ stored: variant });

        expect(lineText.textContent).toBe('TODO(copy)');
        expect(lineText.getAttribute('data-sb-copy-placeholder')).toBe('true');
        expect(lineText.getAttribute('data-sb-copy-slot')).toBe(slot);
    });

    test('draws a line from the chosen variant pool and leaves real copy unflagged', () => {
        const { preloader, lineText } = runSplash({ stored: 'tewi' });
        const splash = window.SillyBunnySplash;
        splash.SPLASH_LINES.tewi = ['First tewi line', 'Second tewi line'];
        splash.SPLASH_LINES.reisen = ['A reisen line'];

        jest.spyOn(Math, 'random').mockReturnValue(0.9);
        splash.render(preloader);

        expect(lineText.textContent).toBe('Second tewi line');
        expect(lineText.hasAttribute('data-sb-copy-placeholder')).toBe(false);
        expect(lineText.hasAttribute('data-sb-copy-slot')).toBe(false);
    });

    test('no line contains an ellipsis, because the dots are appended', () => {
        runSplash();
        const lines = Object.values(window.SillyBunnySplash.SPLASH_LINES).flat();

        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(line).not.toMatch(/…|\.\.\./);
        }
    });
});

describe('splash line length', () => {
    test('a real line fits the line under the mascot on a phone, so none is longer than 32 characters', () => {
        runSplash();
        const realLines = Object.values(window.SillyBunnySplash.SPLASH_LINES).flat().filter(line => line !== 'TODO(copy)');

        for (const line of realLines) {
            expect(line.length).toBeLessThanOrEqual(32);
        }
    });
});

describe('splash boot mark', () => {
    test('is made as soon as the script runs, with or without a preloader', () => {
        const mark = jest.fn();
        window.performance.mark = mark;

        runSplash();
        document.body.innerHTML = '';
        new window.Function(splashSource)();

        expect(mark).toHaveBeenCalledTimes(2);
        expect(mark).toHaveBeenCalledWith('sb-boot-inline');
    });

    test('is skipped without a failure where the browser has no performance marks', () => {
        window.performance.mark = undefined;

        const { mascot } = runSplash({ stored: 'tewi' });

        expect(mascot.dataset.variant).toBe('tewi');
    });
});

describe('splash reduced motion', () => {
    test('adds sb-boot-reduced when the mirror says true', () => {
        localStorage.setItem('sb-reduced-motion', 'true');
        document.body.innerHTML = PRELOADER_MARKUP;
        jest.spyOn(Math, 'random').mockReturnValue(0.1);
        new window.Function(splashSource)();

        expect(document.getElementById('preloader').classList.contains('sb-boot-reduced')).toBe(true);
    });

    test.each([undefined, 'false', 'TRUE', '1'])('does not add it for %j', (mirror) => {
        document.body.innerHTML = PRELOADER_MARKUP;
        localStorage.clear();
        if (mirror !== undefined) localStorage.setItem('sb-reduced-motion', mirror);
        jest.spyOn(Math, 'random').mockReturnValue(0.1);
        new window.Function(splashSource)();

        expect(document.getElementById('preloader').classList.contains('sb-boot-reduced')).toBe(false);
    });

    test('does not add it when storage throws', () => {
        const { preloader } = runSplash({ storageThrows: true });

        expect(preloader.classList.contains('sb-boot-reduced')).toBe(false);
    });
});
