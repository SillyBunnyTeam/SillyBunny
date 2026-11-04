import { expect, test } from '@playwright/test';
import { SETTINGS_COPY } from './helpers/copy-settings.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { sizeFreeTestFor } from './helpers/matrix.js';
import { contrastOf, over, resolveColor, TEXT_CONTRAST } from './helpers/page-contrast.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';
import { stubTheme } from './helpers/theme-stub.js';

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 60_000 });

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
];
const STARTUP_TIMEOUT = 20_000;
/** The pictures at their own size in art pixels. The tallest one decides the step of all three. */
const ART = {
    reisen: { file: 'splash-reisen@native.webp', width: 204, height: 366 },
    tewi: { file: 'splash-tewi@native.webp', width: 141, height: 320 },
    both: { file: 'splash-both@native.webp', width: 263, height: 366 },
};
const TALLEST_ROWS = 366;
const HEIGHT_SHARE = 0.42;

/** Holds the settings read so the preloader stays up until the returned function runs. */
async function holdBoot(page) {
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    // Registered after protectMaintainerServer, so it runs first and falls back to the real route.
    await page.route('**/api/settings/get', async (route) => {
        await released;
        await route.fallback();
    });
    return release;
}

async function openSplash(page, { variant, reducedMotionMirror = false }) {
    await page.addInitScript(({ chosen, mirror }) => {
        localStorage.setItem('sb-splash-character', chosen);
        if (mirror) localStorage.setItem('sb-reduced-motion', 'true');
    }, { chosen: variant, mirror: reducedMotionMirror });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#preloader .sb-boot-mascot')).toBeVisible({ timeout: STARTUP_TIMEOUT });
}

function readMascot(page) {
    return page.locator('.sb-boot-mascot').evaluate((mascot) => {
        const style = getComputedStyle(mascot);
        const box = mascot.getBoundingClientRect();
        return {
            variant: mascot.dataset.variant,
            step: Number(mascot.dataset.step),
            fit: mascot.dataset.fit,
            tag: mascot.tagName,
            src: mascot.getAttribute('src'),
            imageRendering: style.imageRendering,
            animationName: style.animationName,
            loaded: mascot.complete ? mascot.naturalWidth : 0,
            ratio: devicePixelRatio,
            viewportHeight: innerHeight,
            width: box.width,
            height: box.height,
        };
    });
}

function readDots(page) {
    return page.locator('.sb-boot-dots > span').evaluateAll(dots => dots.map((dot) => {
        const style = getComputedStyle(dot);
        const animations = dot.getAnimations();
        return {
            opacity: style.opacity,
            animationName: style.animationName,
            running: animations.length > 0 && animations.every(animation => animation.playState === 'running'),
        };
    }));
}

function readLetters(page) {
    return page.locator('.sb-boot-letter').evaluateAll(letters => letters.map((letter) => {
        const style = getComputedStyle(letter);
        return {
            text: letter.textContent,
            opacity: style.opacity,
            animationName: style.animationName,
            // From the style and not from the animation, because a letter that has had its turn no longer has one.
            delay: style.animationName === 'none' ? null : Number.parseFloat(style.animationDelay) * 1000,
        };
    }));
}

function readStars(page) {
    return page.locator('.sb-boot-star').evaluateAll(stars => stars.map((star) => {
        const style = getComputedStyle(star);
        const box = star.getBoundingClientRect();
        return {
            cells: Number(star.getAttribute('viewBox').split(' ')[2]),
            width: box.width,
            height: box.height,
            left: box.left,
            right: box.right,
            middle: box.top + box.height / 2,
            opacity: style.opacity,
            visibility: style.visibility,
            animationName: style.animationName,
            twinkle: star.getAnimations().find(animation => animation.animationName === 'sb-boot-twinkle')?.effect.getTiming().delay ?? null,
        };
    }));
}

const SPLASH_LINES = ['Girls are writing stories', 'Girls are playing roles', 'Girls are conversing', 'Girls are preparing'];

/**
 * Deletes every `* { animation: none !important }` rule inside a reduced-motion media query, so a test
 * can see whether the splash stylesheet stops its own animations. Returns how many rules it removed.
 */
function removeGlobalReducedMotionRules(page) {
    return page.evaluate(() => {
        let removed = 0;
        const isGlobalAnimationKill = rule => rule.selectorText?.startsWith('*')
            && rule.style.getPropertyPriority('animation') === 'important';
        const walk = (container) => {
            for (let index = container.cssRules.length - 1; index >= 0; index--) {
                const rule = container.cssRules[index];
                if (rule.styleSheet) walk(rule.styleSheet);
                else if (rule.cssRules && /prefers-reduced-motion/.test(rule.conditionText ?? '')) {
                    for (let inner = rule.cssRules.length - 1; inner >= 0; inner--) {
                        if (!isGlobalAnimationKill(rule.cssRules[inner])) continue;
                        rule.deleteRule(inner);
                        removed++;
                    }
                } else if (rule.cssRules) walk(rule);
            }
        };
        for (const sheet of document.styleSheets) {
            try {
                walk(sheet);
            } catch (_error) {
                // Cross-origin sheets cannot be read and carry no rule of ours.
            }
        }
        return removed;
    });
}

for (const { name, options } of VIEWPORTS) {
    test.describe(`Splash at ${name}`, () => {
        test.use(options);

        let releaseBoot;

        test.beforeEach(async ({ page }) => {
            await protectMaintainerServer(page);
            releaseBoot = await holdBoot(page);
        });

        test.afterEach(() => {
            releaseBoot();
        });

        for (const variant of ['reisen', 'tewi', 'both']) {
            test(`shows the ${variant} variant as a still pixel-art picture at a whole step, with running dots`, async ({ page }) => {
                await openSplash(page, { variant });
                await expect.poll(async () => (await readMascot(page)).loaded).toBe(ART[variant].width);

                const mascot = await readMascot(page);
                const step = Math.max(1, Math.floor((HEIGHT_SHARE * mascot.viewportHeight * mascot.ratio) / TALLEST_ROWS + 1e-6));
                expect(mascot.variant).toBe(variant);
                expect(mascot.tag).toBe('IMG');
                expect(mascot.src).toContain(`/img/sillybunny/${ART[variant].file}?v=`);
                expect(mascot.imageRendering).toBe('pixelated');
                expect(mascot.animationName, 'the mascot is a still').toBe('none');
                expect([mascot.step, mascot.fit]).toEqual([step, 'step']);
                expect(mascot.width).toBeCloseTo((ART[variant].width * step) / mascot.ratio, 1);
                expect(mascot.height).toBeCloseTo((ART[variant].height * step) / mascot.ratio, 1);
                await expect(page.locator('.sb-boot-mascot')).toHaveAttribute('alt', '');

                await expect(page.locator('.sb-boot-line')).toHaveAttribute('role', 'status');
                await expect(page.locator('.sb-boot-line')).toContainText('Loading SillyBunny');
                await expect(page.locator('.sb-boot-dots')).toHaveAttribute('aria-hidden', 'true');
                await expect(page.locator('.sb-boot-line-text')).not.toBeEmpty();
                const dots = await readDots(page);
                expect(dots).toHaveLength(3);
                for (const dot of dots) {
                    expect(dot.animationName).not.toBe('none');
                    expect(dot.running).toBe(true);
                }
            });
        }

        test('keeps the picture where it was while its file loads, and the line under it does not move', async ({ page }) => {
            let releaseFile = () => {};
            const held = new Promise((resolve) => { releaseFile = resolve; });
            await page.route('**/img/sillybunny/splash-both@native.webp*', async (route) => {
                await held;
                await route.fallback();
            });
            await openSplash(page, { variant: 'both' });
            const lineBefore = await page.locator('.sb-boot-line').boundingBox();
            const mascotBefore = await page.locator('.sb-boot-mascot').boundingBox();
            expect(mascotBefore.width, 'the box has its size before the file arrives').toBeGreaterThan(0);

            releaseFile();
            await expect.poll(async () => (await readMascot(page)).loaded).toBe(ART.both.width);

            expect(await page.locator('.sb-boot-line').boundingBox()).toEqual(lineBefore);
            expect(await page.locator('.sb-boot-mascot').boundingBox()).toEqual(mascotBefore);
        });

        test('keeps the mascot and line inside the viewport', async ({ page }) => {
            await openSplash(page, { variant: 'both' });

            const viewport = page.viewportSize();
            for (const selector of ['.sb-boot-mascot', '.sb-boot-line']) {
                const box = await page.locator(selector).boundingBox();
                expect(box.x).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
                expect(box.y).toBeGreaterThanOrEqual(0);
                expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
            }
        });

        test('shows one of the four lines, in the theme text colour, with no tracking and no small caps', async ({ page }) => {
            await openSplash(page, { variant: 'tewi' });

            const line = page.locator('.sb-boot-line-text');
            await expect.poll(() => line.evaluate(node => node.textContent)).toMatch(new RegExp(`^(${SPLASH_LINES.join('|')})$`));
            const style = await line.evaluate((node) => {
                const computed = getComputedStyle(node);
                return {
                    letterSpacing: computed.letterSpacing,
                    fontVariantCaps: computed.fontVariantCaps,
                    textTransform: computed.textTransform,
                    color: computed.color,
                    boot: getComputedStyle(document.querySelector('#preloader')).color,
                };
            });
            expect(style.letterSpacing).toBe('normal');
            expect(style.fontVariantCaps).toBe('normal');
            expect(style.textTransform).toBe('none');
            expect(style.color).toBe(style.boot);
            await expect(page.locator('.sb-boot-line-text')).not.toHaveAttribute('data-sb-copy-placeholder', /./);
        });

        test('gives assistive technology the whole line from one element and hides the letters, which are separate elements', async ({ page }) => {
            await openSplash(page, { variant: 'tewi' });

            await expect(page.locator('.sb-boot-line-text')).toHaveAttribute('aria-hidden', 'true');
            const reader = page.locator('.sb-boot-line-reader');
            await expect(reader).toHaveText(new RegExp(`^(${SPLASH_LINES.join('|')})$`));
            await expect(reader).toHaveText(await page.locator('.sb-boot-line-text').innerText());
            expect(await reader.evaluate(node => node.closest('[aria-hidden="true"]'))).toBeNull();
            // The reader is out of sight and takes no room.
            expect((await reader.boundingBox()).width).toBeLessThanOrEqual(1);
        });

        test('types the line out one letter at a time, and starts the dots after the last letter', async ({ page }) => {
            await openSplash(page, { variant: 'both' });

            const letters = await readLetters(page);
            const dots = await page.locator('.sb-boot-dots > span').evaluateAll(spans => spans.map(span => span.getAnimations()[0].effect.getTiming().delay));
            expect(letters.map(letter => letter.text).join('')).toBe((await page.locator('.sb-boot-line-text').textContent()).replaceAll(' ', ''));
            expect(letters[0].delay, 'the first letter waits for the picture to settle').toBeCloseTo(300, 0);
            letters.slice(1).forEach((letter, index) => {
                expect(letter.delay - letters[index].delay, `letter ${index + 1} follows the one before`).toBeCloseTo(45, 0);
            });
            for (const delay of dots) {
                expect(delay, 'the dots wait for the last letter').toBeGreaterThan(letters.at(-1).delay);
            }
            await expect.poll(async () => (await readLetters(page)).every(letter => letter.opacity === '1'), { timeout: 5000 }).toBe(true);
        });

        test('shows four sparkles, two on each side of the line, drawn at the size of an art pixel of the mascot', async ({ page }) => {
            await openSplash(page, { variant: 'both' });

            const mascot = await readMascot(page);
            const unit = mascot.width / ART.both.width;
            const stars = await readStars(page);
            const text = await page.locator('.sb-boot-flavour-text').boundingBox();
            expect(stars.map(star => star.cells)).toEqual([7, 11, 11, 7]);
            for (const star of stars) {
                expect(star.width).toBeCloseTo(star.cells * unit, 1);
                expect(star.height).toBeCloseTo(star.cells * unit, 1);
                expect(Math.abs(star.middle - (text.y + text.height / 2)), 'on the line').toBeLessThanOrEqual(text.height / 2);
            }
            expect(stars[0].right).toBeLessThanOrEqual(stars[1].left);
            expect(stars[1].right).toBeLessThanOrEqual(text.x + 0.5);
            expect(stars[2].left).toBeGreaterThanOrEqual(text.x + text.width - 0.5);
            expect(stars[2].right).toBeLessThanOrEqual(stars[3].left);
            await expect(page.locator('.sb-boot-star')).toHaveCount(4);
            for (const hidden of await page.locator('.sb-boot-star').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-hidden')))) {
                expect(hidden).toBe('true');
            }
        });

        test('the sparkles appear with the first letter and twinkle, each a little after the one before', async ({ page }) => {
            await openSplash(page, { variant: 'tewi' });

            await expect.poll(async () => (await readStars(page)).every(star => star.visibility === 'visible'), { timeout: 5000 }).toBe(true);
            const stars = await readStars(page);
            for (const star of stars) {
                expect(star.animationName).toContain('sb-boot-twinkle');
            }
            const delays = stars.map(star => star.twinkle);
            expect(delays.slice(1).every((delay, index) => delay > delays[index])).toBe(true);
        });

        test('keeps the sparkles and the line inside the viewport at the largest text size', async ({ page }) => {
            await page.addInitScript(() => { document.documentElement.style.fontSize = '32px'; });
            await openSplash(page, { variant: 'both' });

            const viewport = page.viewportSize();
            for (const selector of ['.sb-boot-flavour', '.sb-boot-star >> nth=0', '.sb-boot-star >> nth=3']) {
                const box = await page.locator(selector).boundingBox();
                expect(box.x).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
            }
        });

        for (const scenario of [
            { title: 'under prefers-reduced-motion', reducedMotion: 'reduce', mirror: false },
            { title: 'when the saved Reduced Motion setting is mirrored', reducedMotion: 'no-preference', mirror: true },
        ]) {
            test(`shows the finished line, still sparkles and three static dots ${scenario.title}`, async ({ page }) => {
                await page.emulateMedia({ reducedMotion: scenario.reducedMotion });
                await openSplash(page, { variant: 'tewi', reducedMotionMirror: scenario.mirror });

                const letters = await readLetters(page);
                expect(letters.length).toBeGreaterThan(0);
                for (const letter of letters) {
                    expect(letter.animationName).toBe('none');
                    expect(letter.opacity).toBe('1');
                }
                const stars = await readStars(page);
                expect(stars).toHaveLength(4);
                for (const star of stars) {
                    expect(star.animationName).toBe('none');
                    expect([star.visibility, star.opacity]).toEqual(['visible', '1']);
                }
                const dots = await readDots(page);
                expect(dots).toHaveLength(3);
                for (const dot of dots) {
                    expect(dot.animationName).toBe('none');
                    expect(dot.opacity).toBe('1');
                }
            });
        }

        test('plays the reveal: the last letter and every sparkle are hidden until their turn, and then shown', async ({ page }) => {
            await openSplash(page, { variant: 'tewi' });

            // The turns are counted from the start delay that the script sets. Putting it far away puts every turn in the
            // future, so the test does not race the 300ms before the first letter.
            const setStart = value => page.evaluate(start => document.querySelector('#preloader').style.setProperty('--sb-boot-reveal-start', start), value);
            await setStart('600000ms');

            await expect.poll(async () => (await readLetters(page)).at(-1).opacity, { message: 'the last letter waits for its turn' }).toBe('0');
            for (const star of await readStars(page)) {
                expect(star.visibility, 'a sparkle waits for the typing to start').toBe('hidden');
            }

            await setStart('0ms');

            await expect.poll(async () => (await readLetters(page)).every(letter => letter.opacity === '1'), { timeout: 8000 }).toBe(true);
            for (const star of await readStars(page)) {
                expect(star.visibility).toBe('visible');
            }
        });

        test('keeps the whole line and every sparkle when the theme turns animations off while the reveal is running', async ({ page }) => {
            await openSplash(page, { variant: 'tewi' });
            const hidden = await readLetters(page);
            expect(hidden.length, 'the reveal has letters to type').toBeGreaterThan(0);

            // The Reduced Motion class arrives from the settings, after the splash has painted and without the mirror.
            await page.evaluate(() => document.body.classList.add('reduced-motion'));

            await expect.poll(async () => (await readLetters(page)).every(letter => letter.animationName === 'none'), { message: 'the theme rule has taken the animations' }).toBe(true);
            for (const letter of await readLetters(page)) {
                expect(letter.opacity).toBe('1');
            }
            for (const star of await readStars(page)) {
                expect([star.visibility, star.opacity]).toEqual(['visible', '1']);
            }
        });

        test('stops its own animations under prefers-reduced-motion, not through the theme global rule', async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await openSplash(page, { variant: 'tewi' });

            expect(await removeGlobalReducedMotionRules(page)).toBeGreaterThan(0);

            for (const letter of await readLetters(page)) {
                expect([letter.animationName, letter.opacity]).toEqual(['none', '1']);
            }
            for (const star of await readStars(page)) {
                expect([star.animationName, star.visibility, star.opacity]).toEqual(['none', 'visible', '1']);
            }
            const dots = await readDots(page);
            expect(dots).toHaveLength(3);
            for (const dot of dots) {
                expect(dot.animationName).toBe('none');
                expect(dot.opacity).toBe('1');
            }
        });

        test('removes the preloader once the app has booted', async ({ page }) => {
            await openSplash(page, { variant: 'reisen' });

            releaseBoot();

            await expect(page.locator('#preloader')).toHaveCount(0, { timeout: STARTUP_TIMEOUT });
        });
    });
}

/**
 * The size of the pictures on screens of every kind, worked out by hand from the rule, with the 366 rows of the tallest
 * picture: the largest whole step whose art is at most 42% of the viewport height. A screen that cannot hold step 1 in
 * 42% still gets step 1 up to 60%, and a shorter one gets the pictures shrunk by a fraction so that the tallest is 42%.
 * `px` is the CSS size of one art pixel, which all three pictures share. The expected values are not computed by the
 * code under test.
 */
const SIZE_TABLE = [
    { width: 1920, height: 1080, ratio: 1, fit: 'step', step: 1, px: 1 },
    { width: 1920, height: 1080, ratio: 2, fit: 'step', step: 2, px: 1 },
    { width: 1440, height: 900, ratio: 1, fit: 'step', step: 1, px: 1 },
    { width: 1440, height: 900, ratio: 2, fit: 'step', step: 2, px: 1 },
    { width: 1366, height: 768, ratio: 1, fit: 'step', step: 1, px: 1 },
    { width: 1366, height: 768, ratio: 2, fit: 'step', step: 1, px: 0.5 },
    { width: 1024, height: 600, ratio: 1, fit: 'smooth', px: (0.42 * 600) / 366 },
    { width: 1024, height: 600, ratio: 2, fit: 'step', step: 1, px: 0.5 },
    { width: 768, height: 1024, ratio: 1, fit: 'step', step: 1, px: 1 },
    { width: 768, height: 1024, ratio: 2, fit: 'step', step: 2, px: 1 },
    { width: 390, height: 844, ratio: 1, fit: 'step', step: 1, px: 1 },
    { width: 390, height: 844, ratio: 2, fit: 'step', step: 1, px: 0.5 },
    { width: 390, height: 844, ratio: 3, fit: 'step', step: 2, px: 2 / 3 },
    { width: 844, height: 390, ratio: 1, fit: 'smooth', px: (0.42 * 390) / 366 },
    { width: 844, height: 390, ratio: 2, fit: 'step', step: 1, px: 0.5 },
    { width: 844, height: 390, ratio: 3, fit: 'step', step: 1, px: 1 / 3 },
];

for (const { width, height, ratio, fit, step, px } of SIZE_TABLE) {
    test.describe(`Splash size at ${width}x${height} on a ${ratio}x screen`, () => {
        test.use({ viewport: { width, height }, deviceScaleFactor: ratio });

        for (const variant of ['reisen', 'tewi', 'both']) {
            test(`draws ${variant} ${fit === 'smooth' ? 'shrunk to 42% of the height, smooth' : `at ${step} device pixel${step === 1 ? '' : 's'} per art pixel`}`, async ({ page }) => {
                await protectMaintainerServer(page);
                const releaseBoot = await holdBoot(page);
                try {
                    await openSplash(page, { variant });

                    const mascot = await readMascot(page);
                    expect(mascot.fit).toBe(fit);
                    expect(mascot.width).toBeCloseTo(ART[variant].width * px, 1);
                    expect(mascot.height).toBeCloseTo(ART[variant].height * px, 1);
                    if (fit === 'smooth') {
                        expect(Number.isNaN(mascot.step), 'a shrunk picture has no step').toBe(true);
                        expect(mascot.imageRendering).toBe('auto');
                        expect(mascot.height / height, 'the tallest picture is 42%, and Tewi is shorter').toBeLessThanOrEqual(0.42 + 0.001);
                        return;
                    }
                    expect(mascot.step).toBe(step);
                    expect(mascot.imageRendering).toBe('pixelated');
                } finally {
                    releaseBoot();
                }
            });
        }
    });
}

test.describe('Splash on a window that changes size', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('draws the picture again at the step of the new height, without a new request for the file', async ({ page }) => {
        await protectMaintainerServer(page);
        const releaseBoot = await holdBoot(page);
        const requests = [];
        page.on('request', request => requests.push(request.url()));
        try {
            await openSplash(page, { variant: 'both' });
            expect((await readMascot(page)).step).toBe(1);

            // 0.42 x 2000 = 840 CSS pixels at 1x holds two steps of 366.
            await page.setViewportSize({ width: 1440, height: 2000 });

            await expect.poll(async () => (await readMascot(page)).step).toBe(2);
            expect((await readMascot(page)).height).toBe(732);

            // A step of 366 is 73% of 500, which is past the 60% that step 1 may take.
            await page.setViewportSize({ width: 1440, height: 500 });

            await expect.poll(async () => (await readMascot(page)).fit).toBe('smooth');
            expect((await readMascot(page)).height).toBeCloseTo(0.42 * 500, 1);
            expect(requests.filter(url => url.includes('splash-both@native.webp'))).toHaveLength(1);
        } finally {
            releaseBoot();
        }
    });
});

const BOOT_MARKS = ['sb-boot-inline', 'sb-boot-init-start', 'sb-boot-dismiss', 'sb-app-ready'];
const SPLASH_CHARACTER_KEY = 'sb-splash-character';
const SPLASH_ACCOUNT_KEY = 'WelcomePage_SplashCharacter';
const APP_STARTUP_TIMEOUT = 60_000;

/**
 * Boots the app past the splash. `account` is merged over the saved account storage and `reducedMotion`, when given,
 * replaces the saved setting, so a test does not depend on what the test data holds. An `undefined` value removes a key.
 */
async function bootApp(page, { account = {}, reducedMotion } = {}) {
    await protectMaintainerServer(page);
    await page.route('**/api/settings/get', async (route) => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.accountStorage = { ...settings.accountStorage, ...account };
        if (reducedMotion !== undefined) settings.power_user.reduced_motion = reducedMotion;
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'),
        null,
        { timeout: APP_STARTUP_TIMEOUT },
    );
}

async function openInterface(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
    await page.locator('button[data-sb-settings-tab="interface"]').evaluate(element => element.click());
    const panel = page.locator('[data-sb-panel="interface"]');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    return panel.locator('[data-sb-editor-field="splash-character"]');
}

const readLocal = (page, key) => page.evaluate(name => localStorage.getItem(name), key);
const readAccount = (page, key) => page.evaluate(async (name) => {
    const { accountStorage } = await import('/scripts/util/AccountStorage.js');
    return accountStorage.getItem(name);
}, key);

for (const { name, options } of VIEWPORTS) {
    test.describe(`Splash settings at ${name}`, () => {
        test.use(options);
        // Only the tests that fit a row or the debug text to the window use `test`; the rest do not depend on the size.
        const sizeFreeTest = sizeFreeTestFor(test, options.viewport);

        test('Splash Character sits in Customize, Interface, with its four choices and a copy placeholder subtitle', async ({ page }) => {
            await bootApp(page, { account: { [SPLASH_ACCOUNT_KEY]: undefined } });
            await page.evaluate(key => localStorage.removeItem(key), SPLASH_CHARACTER_KEY);

            const row = await openInterface(page);

            await expect(row).toBeVisible();
            await expect(row.locator('.ds-row-label')).toHaveText('Splash Character');
            const select = row.getByRole('combobox', { name: 'Splash Character' });
            await expect(select.locator('option')).toHaveText(['Random', 'Reisen', 'Tewi', 'Both']);
            await expect(select).toHaveValue('random');
            await expect(row.locator('.ds-row-subtitle')).toHaveText(SETTINGS_COPY.splashSubtitle);
            await expect(row.locator('.ds-row-subtitle')).not.toHaveAttribute('data-sb-copy-placeholder', /.*/);
            const fitsBeside = await row.evaluate(node => node.getBoundingClientRect().right <= document.documentElement.clientWidth + 1);
            expect(fitsBeside).toBe(true);
        });

        sizeFreeTest('choosing a character stores it in this browser and in the account, and the next start shows it', async ({ page }) => {
            await bootApp(page, { account: { [SPLASH_ACCOUNT_KEY]: undefined } });
            const row = await openInterface(page);

            await row.getByRole('combobox', { name: 'Splash Character' }).selectOption('both');

            expect(await readLocal(page, SPLASH_CHARACTER_KEY)).toBe('both');
            expect(await readAccount(page, SPLASH_ACCOUNT_KEY)).toBe('both');

            const nextStart = await page.context().newPage();
            await protectMaintainerServer(nextStart);
            const releaseBoot = await holdBoot(nextStart);
            try {
                await nextStart.goto('/', { waitUntil: 'domcontentloaded' });
                await expect(nextStart.locator('#preloader .sb-boot-mascot')).toHaveAttribute('data-variant', 'both', { timeout: STARTUP_TIMEOUT });
            } finally {
                releaseBoot();
                await nextStart.close();
            }
        });

        sizeFreeTest('a new browser copies the account character after the settings load, and shows it in the row', async ({ page }) => {
            await bootApp(page, { account: { [SPLASH_ACCOUNT_KEY]: 'reisen' } });

            await expect.poll(() => readLocal(page, SPLASH_CHARACTER_KEY)).toBe('reisen');
            const row = await openInterface(page);
            await expect(row.getByRole('combobox', { name: 'Splash Character' })).toHaveValue('reisen');
        });

        sizeFreeTest('Reduced Motion is mirrored to this browser when the settings load and on every save', async ({ page }) => {
            await bootApp(page, { reducedMotion: false });
            const setReducedMotion = checked => page.evaluate((value) => {
                const box = document.querySelector('#reduced_motion');
                box.checked = value;
                box.dispatchEvent(new Event('input', { bubbles: true }));
            }, checked);

            await expect.poll(() => readLocal(page, 'sb-reduced-motion')).toBe('false');
            await setReducedMotion(true);
            await expect.poll(() => readLocal(page, 'sb-reduced-motion')).toBe('true');
            await setReducedMotion(false);
            await expect.poll(() => readLocal(page, 'sb-reduced-motion')).toBe('false');
        });

        test('the four boot marks are made in order, and About, Troubleshooting lists them', async ({ page }) => {
            await bootApp(page);

            const marks = await page.evaluate(names => Object.fromEntries(names.map(mark => [mark, performance.getEntriesByName(mark).map(entry => entry.startTime)])), BOOT_MARKS);
            for (const mark of BOOT_MARKS) expect(marks[mark], mark).toHaveLength(1);
            expect(marks['sb-boot-inline'][0]).toBeLessThan(marks['sb-boot-init-start'][0]);
            expect(marks['sb-boot-init-start'][0]).toBeLessThan(marks['sb-boot-dismiss'][0]);
            expect(marks['sb-boot-init-start'][0]).toBeLessThan(marks['sb-app-ready'][0]);

            await page.evaluate(async () => (await import('/scripts/sillybunny-home/windows.js')).openAbout());
            const host = page.locator('dialog.sb-dialog-host:not([closing])');
            await host.getByRole('button', { name: 'Troubleshooting', exact: true }).click();
            const info = host.locator('.sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving)').getByRole('textbox', { name: 'Debug Information' });
            await expect(info).toBeVisible();

            const text = await info.inputValue();
            for (const mark of BOOT_MARKS) {
                expect(text).toContain(`Boot mark ${mark}: ${Math.round(marks[mark][0])} ms`);
            }
            const fit = await info.evaluate(node => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
            expect(fit.scrollHeight).toBeLessThanOrEqual(fit.clientHeight + 1);
        });
    });
}

test.describe('Splash colours', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    let releaseBoot;

    test.afterEach(() => {
        releaseBoot?.();
        releaseBoot = undefined;
    });

    /** What the splash is painted with: its own surface, and the colour of the line, resolved to opaque channels. */
    async function readSplashColours(page) {
        const painted = await page.evaluate(() => ({
            background: getComputedStyle(document.getElementById('preloader')).backgroundColor,
            line: getComputedStyle(document.querySelector('.sb-boot-line')).color,
        }));
        const background = await resolveColor(page, painted.background);
        const line = await resolveColor(page, painted.line);
        return { background, line, ratio: contrastOf(over(line, over(background, { r: 255, g: 255, b: 255 })), over(background, { r: 255, g: 255, b: 255 })) };
    }

    test('the line reads at 4.5:1 on the surface that a Libadwaita Light session leaves for the next start', async ({ page }) => {
        await protectMaintainerServer(page);
        await stubTheme(page, 'Libadwaita Light');
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60_000 });
        await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-boot-surface'))).not.toBeNull();
        const surface = JSON.parse(await page.evaluate(() => localStorage.getItem('sb-boot-surface')));
        const seeded = { bg: await resolveColor(page, surface.bg), fg: await resolveColor(page, surface.fg) };
        expect(contrastOf(over(seeded.bg, { r: 255, g: 255, b: 255 }), { r: 0, g: 0, b: 0 }), 'the session was a light one').toBeGreaterThan(10);

        releaseBoot = await holdBoot(page);
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#preloader .sb-boot-mascot')).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await expect(page.locator('.sb-boot-line-text')).not.toBeEmpty();

        const colours = await readSplashColours(page);
        expect(colours.background, 'the splash paints the surface that was stored').toEqual(seeded.bg);
        expect(colours.line, 'and the line the stored text colour').toEqual(seeded.fg);
        expect(colours.background.a, 'the surface is opaque').toBe(1);
        expect(colours.ratio, 'the line against the surface').toBeGreaterThanOrEqual(TEXT_CONTRAST);
    });

    test.describe('in forced colours', () => {
        test.use({ forcedColors: 'active' });

        test('the mascot is visible, the line is CanvasText on Canvas, and the dots show', async ({ page }) => {
            await protectMaintainerServer(page);
            releaseBoot = await holdBoot(page);
            await openSplash(page, { variant: 'both' });
            await expect.poll(async () => (await readMascot(page)).loaded).toBe(ART.both.width);
            await expect(page.locator('.sb-boot-line-text')).not.toBeEmpty();

            const system = await page.evaluate(() => {
                const probe = document.createElement('span');
                probe.style.cssText = 'color: CanvasText; background-color: Canvas;';
                document.body.append(probe);
                const style = getComputedStyle(probe);
                const colours = { text: style.color, canvas: style.backgroundColor };
                probe.remove();
                return colours;
            });
            const painted = await page.evaluate(() => ({
                background: getComputedStyle(document.getElementById('preloader')).backgroundColor,
                line: getComputedStyle(document.querySelector('.sb-boot-line')).color,
                dots: [...document.querySelectorAll('.sb-boot-dots > span')].map(dot => getComputedStyle(dot).color),
                mascot: (() => {
                    const style = getComputedStyle(document.querySelector('.sb-boot-mascot'));
                    return { opacity: style.opacity, visibility: style.visibility, display: style.display };
                })(),
            }));
            expect(painted.background, 'the splash is on Canvas').toBe(system.canvas);
            expect(painted.line, 'the line is CanvasText').toBe(system.text);
            expect(painted.dots, 'the dots are CanvasText').toEqual([system.text, system.text, system.text]);
            expect(painted.mascot).toEqual({ opacity: '1', visibility: 'visible', display: 'block' });

            // The dots come in one after the other and loop, so poll for the moment that all three are in.
            await expect.poll(async () => (await readDots(page)).map(dot => dot.opacity), { timeout: 5000 }).toEqual(['1', '1', '1']);
        });
    });
});
