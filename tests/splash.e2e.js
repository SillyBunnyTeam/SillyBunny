import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 60_000 });

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];
const STARTUP_TIMEOUT = 20_000;
const FRAME_BOXES = {
    tewi: { width: 128, height: 128 },
    reisen: { width: 128, height: 128 },
    both: { width: 192, height: 128 },
};

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
            backgroundImage: style.backgroundImage,
            imageRendering: style.imageRendering,
            animationName: style.animationName,
            backgroundPosition: style.backgroundPosition,
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

        for (const variant of ['tewi', 'both']) {
            test(`shows the ${variant} variant as one frame at 1x with a running animation`, async ({ page }) => {
                await openSplash(page, { variant });

                const mascot = await readMascot(page);
                expect(mascot.variant).toBe(variant);
                expect(mascot.backgroundImage).toContain(`splash-${variant}.png`);
                expect(mascot.imageRendering).toBe('pixelated');
                expect(mascot.animationName).not.toBe('none');
                expect({ width: mascot.width, height: mascot.height }).toEqual(FRAME_BOXES[variant]);

                // Both frames of the strip must show, or the animation is invisible.
                const seenPositions = new Set();
                await expect.poll(async () => {
                    seenPositions.add((await readMascot(page)).backgroundPosition);
                    return seenPositions.size;
                }, { timeout: 5_000 }).toBeGreaterThan(1);

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

        for (const scenario of [
            { title: 'under prefers-reduced-motion', reducedMotion: 'reduce', mirror: false },
            { title: 'when the saved Reduced Motion setting is mirrored', reducedMotion: 'no-preference', mirror: true },
        ]) {
            test(`shows frame 0 and three static dots ${scenario.title}`, async ({ page }) => {
                await page.emulateMedia({ reducedMotion: scenario.reducedMotion });
                await openSplash(page, { variant: 'tewi', reducedMotionMirror: scenario.mirror });

                const mascot = await readMascot(page);
                expect(mascot.animationName).toBe('none');
                expect(mascot.backgroundPosition).toBe('0px 0px');
                const dots = await readDots(page);
                expect(dots).toHaveLength(3);
                for (const dot of dots) {
                    expect(dot.animationName).toBe('none');
                    expect(dot.opacity).toBe('1');
                }
            });
        }

        test('stops its own animations under prefers-reduced-motion, not through the theme global rule', async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await openSplash(page, { variant: 'tewi' });

            expect(await removeGlobalReducedMotionRules(page)).toBeGreaterThan(0);

            const mascot = await readMascot(page);
            expect(mascot.animationName).toBe('none');
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
