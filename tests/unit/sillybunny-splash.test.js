/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
const splashSource = readFileSync(fileURLToPath(new URL('../../public/scripts/sillybunny-splash.js', import.meta.url)), 'utf8');

const PRELOADER_MARKUP = `
    <div id="preloader">
        <div class="sb-boot-splash">
            <div class="sb-boot-mascot" aria-hidden="true"></div>
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

describe('splash frame metadata', () => {
    test.each([
        ['reisen', 'splash-reisen.png', '128px'],
        ['tewi', 'splash-tewi.png', '128px'],
        ['both', 'splash-both.png', '192px'],
    ])('%s sets its sheet and frame size as custom properties', (variant, sheetFile, frameWidth) => {
        const { mascot } = runSplash({ stored: variant });

        expect(mascot.style.getPropertyValue('--sb-boot-sheet')).toContain(sheetFile);
        expect(mascot.style.getPropertyValue('--sb-boot-frames')).toBe('2');
        expect(mascot.style.getPropertyValue('--sb-boot-frame-w')).toBe(frameWidth);
        expect(mascot.style.getPropertyValue('--sb-boot-frame-h')).toBe('128px');
        expect(mascot.style.getPropertyValue('--sb-boot-duration')).toMatch(/^\d+ms$/);
    });
});

describe('splash sheets', () => {
    test.each(['reisen', 'tewi', 'both'])('the %s sheet is exactly frames x frame size and keyed for the cache', (variant) => {
        runSplash({ stored: variant });
        const { sheet, frames, frameWidth, frameHeight } = window.SillyBunnySplash.FRAMES[variant];
        const [sheetPath, query] = sheet.split('?');
        const png = readFileSync(`${publicRoot}${sheetPath.replace(/^\//, '')}`);

        // PNG layout: 8-byte signature, then the IHDR chunk with width and height at bytes 16 and 20.
        expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
        expect(png.readUInt32BE(16)).toBe(frames * frameWidth);
        expect(png.readUInt32BE(20)).toBe(frameHeight);
        expect(query).toMatch(/^v=\d{8}[a-z]$/);
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
