/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readImageSize } from '../helpers/image-size.js';

const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
const splashSource = readFileSync(fileURLToPath(new URL('../../public/scripts/sillybunny-splash.js', import.meta.url)), 'utf8');

// The markup of the real page, so the script is tested against the elements it will find and not against a copy.
const indexHtml = readFileSync(fileURLToPath(new URL('../../public/index.html', import.meta.url)), 'utf8');
const SPLASH_MARKUP = indexHtml.match(/<div class="sb-boot-splash">[\s\S]*?<\/p>\s*<\/div>/)[0];
const PRELOADER_MARKUP = `<div id="preloader">${SPLASH_MARKUP}</div>`;

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
    const LINES = ['Girls are writing stories', 'Girls are playing roles', 'Girls are conversing', 'Girls are preparing'];

    test('the pool is the four lines the user wrote, shared by every character', () => {
        runSplash();

        expect(window.SillyBunnySplash.SPLASH_LINES).toEqual(LINES);
    });

    test.each(['reisen', 'tewi', 'both'])('%s draws its line from the shared pool, and the line is real copy, not a placeholder', (variant) => {
        const { lineText } = runSplash({ stored: variant });

        expect(LINES).toContain(lineText.textContent);
        expect(lineText.hasAttribute('data-sb-copy-placeholder')).toBe(false);
        expect(lineText.hasAttribute('data-sb-copy-slot')).toBe(false);
    });

    test.each(LINES.map((line, index) => [line, (index + 0.5) / LINES.length]))('picks "%s" when the random draw is %s', (line, random) => {
        const { lineText } = runSplash({ stored: 'tewi', random });

        expect(lineText.textContent).toBe(line);
    });

    test('is picked again at random each time it is drawn, whatever the character', () => {
        const { preloader, lineText } = runSplash({ stored: 'tewi', random: 0.1 });
        jest.spyOn(Math, 'random').mockReturnValue(0.9);

        window.SillyBunnySplash.render(preloader);

        expect(lineText.textContent).toBe('Girls are preparing');
    });

    test('assistive technology gets the whole line from one element, and skips the letters that are typed out', () => {
        const { lineText } = runSplash({ stored: 'tewi', random: 0.3 });
        const reader = document.querySelector('.sb-boot-line-reader');

        expect(lineText.getAttribute('aria-hidden')).toBe('true');
        expect(reader.textContent).toBe(lineText.textContent);
        expect(reader.classList.contains('sr-only')).toBe(true);
        expect(reader.closest('[aria-hidden="true"]')).toBeNull();
        expect(document.querySelector('.sb-boot-line').getAttribute('role')).toBe('status');
    });

    test('the line for assistive technology follows the line that is drawn again', () => {
        const { preloader } = runSplash({ stored: 'tewi', random: 0.1 });
        jest.spyOn(Math, 'random').mockReturnValue(0.9);

        window.SillyBunnySplash.render(preloader);

        expect(document.querySelector('.sb-boot-line-reader').textContent).toBe('Girls are preparing');
    });

    test('no line contains an ellipsis, because the dots are appended', () => {
        runSplash();

        for (const line of window.SillyBunnySplash.SPLASH_LINES) {
            expect(line).not.toMatch(/…|\.\.\./);
        }
    });
});

describe('splash line reveal', () => {
    const letters = lineText => [...lineText.querySelectorAll('.sb-boot-letter')];

    test('every letter is its own element and every space is text between them, so the line still reads as itself', () => {
        const { lineText } = runSplash({ random: 0.1 });

        expect(lineText.textContent).toBe('Girls are writing stories');
        expect(letters(lineText).map(letter => letter.textContent).join('')).toBe('Girlsarewritingstories');
        expect([...lineText.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent)).toEqual([' ', ' ', ' ']);
    });

    test('the letters take turns in order, one after another, and a space takes none', () => {
        const { lineText } = runSplash({ random: 0.3 });

        expect(lineText.textContent).toBe('Girls are playing roles');
        expect(letters(lineText).map(letter => letter.style.getPropertyValue('--n'))).toEqual(
            Array.from({ length: 'Girlsareplayingroles'.length }, (_, index) => String(index)),
        );
    });

    test('the dots start after the last letter and a short pause, and the three times are set on the preloader', () => {
        const { preloader, lineText } = runSplash({ random: 0.5 });
        const read = name => Number.parseFloat(preloader.style.getPropertyValue(name));
        const typed = letters(lineText).length;

        expect(preloader.style.getPropertyValue('--sb-boot-reveal-start')).toBe('300ms');
        expect(preloader.style.getPropertyValue('--sb-boot-letter-step')).toBe('45ms');
        const lastLetterAt = read('--sb-boot-reveal-start') + (typed - 1) * read('--sb-boot-letter-step');
        expect(read('--sb-boot-dots-start')).toBeGreaterThan(lastLetterAt + read('--sb-boot-letter-step'));
    });

    test('a longer line starts its dots later', () => {
        const short = runSplash({ random: 0.65 });
        const shortStart = short.preloader.style.getPropertyValue('--sb-boot-dots-start');
        const long = runSplash({ random: 0.1 });

        expect(Number.parseFloat(long.preloader.style.getPropertyValue('--sb-boot-dots-start'))).toBeGreaterThan(Number.parseFloat(shortStart));
    });

    test('is drawn again without keeping the letters of the line before', () => {
        const { preloader, lineText } = runSplash({ random: 0.1 });
        jest.spyOn(Math, 'random').mockReturnValue(0.65);

        window.SillyBunnySplash.render(preloader);

        expect(lineText.textContent).toBe('Girls are conversing');
        expect(letters(lineText)).toHaveLength('Girlsareconversing'.length);
    });
});

describe('splash sparkles', () => {
    test('there are four, two either side of the line, and assistive technology skips them', () => {
        runSplash();
        const flavour = document.querySelector('.sb-boot-flavour');

        const order = [...flavour.children].map(child => (child.matches('svg.sb-boot-star') ? (child.classList.contains('sb-boot-star--big') ? 'big' : 'small') : 'text'));
        expect(order).toEqual(['small', 'big', 'text', 'big', 'small']);
        for (const star of flavour.querySelectorAll('.sb-boot-star')) {
            expect(star.getAttribute('aria-hidden')).toBe('true');
        }
    });

    test('each is drawn from whole cells of its own grid: 7 by 7 and 11 by 11', () => {
        runSplash();

        const boxes = [...document.querySelectorAll('.sb-boot-star')].map(star => star.getAttribute('viewBox'));

        expect(boxes).toEqual(['0 0 7 7', '0 0 11 11', '0 0 11 11', '0 0 7 7']);
    });

    test('the size of an art pixel of the mascot is the size of a cell, so they stay on its grid', () => {
        onScreen({ height: 844, ratio: 3 });
        runSplash({ stored: 'both' });

        // Step 2 at 3x: one art pixel is 2/3 of a CSS pixel.
        expect(Number.parseFloat(document.querySelector('.sb-boot-splash').style.getPropertyValue('--sb-boot-px'))).toBeCloseTo(2 / 3, 6);
    });

    test('follow the mascot when the window changes size', () => {
        onScreen({ height: 768, ratio: 1 });
        runSplash({ stored: 'both' });
        const splash = document.querySelector('.sb-boot-splash');
        expect(splash.style.getPropertyValue('--sb-boot-px')).toBe('1px');

        // 0.42 x 2000 = 840 CSS pixels holds two steps of 366 at 1x.
        onScreen({ height: 2000, ratio: 1 });
        window.dispatchEvent(new Event('resize'));

        expect(splash.style.getPropertyValue('--sb-boot-px')).toBe('2px');
        onScreen({ height: 390, ratio: 1 });
        window.dispatchEvent(new Event('resize'));
        expect(Number.parseFloat(splash.style.getPropertyValue('--sb-boot-px'))).toBeCloseTo((0.42 * 390) / 366, 6);
    });
});

describe('splash line length', () => {
    test('a line fits the line under the mascot on a phone, so none is longer than 32 characters', () => {
        runSplash();

        for (const line of window.SillyBunnySplash.SPLASH_LINES) {
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
