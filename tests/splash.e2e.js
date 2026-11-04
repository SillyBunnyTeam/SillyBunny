import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';

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

        for (const scenario of [
            { title: 'under prefers-reduced-motion', reducedMotion: 'reduce', mirror: false },
            { title: 'when the saved Reduced Motion setting is mirrored', reducedMotion: 'no-preference', mirror: true },
        ]) {
            test(`shows three static dots ${scenario.title}`, async ({ page }) => {
                await page.emulateMedia({ reducedMotion: scenario.reducedMotion });
                await openSplash(page, { variant: 'tewi', reducedMotionMirror: scenario.mirror });

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

        test('Splash Character sits in Customize, Interface, with its four choices and a copy placeholder subtitle', async ({ page }) => {
            await bootApp(page, { account: { [SPLASH_ACCOUNT_KEY]: undefined } });
            await page.evaluate(key => localStorage.removeItem(key), SPLASH_CHARACTER_KEY);

            const row = await openInterface(page);

            await expect(row).toBeVisible();
            await expect(row.locator('.ds-row-label')).toHaveText('Splash Character');
            const select = row.getByRole('combobox', { name: 'Splash Character' });
            await expect(select.locator('option')).toHaveText(['Random', 'Reisen', 'Tewi', 'Both']);
            await expect(select).toHaveValue('random');
            await expect(row.locator('.ds-row-subtitle')).toHaveText('TODO(copy)');
            await expect(row.locator('.ds-row-subtitle')).toHaveAttribute('data-sb-copy-placeholder', 'true');
            await expect(row.locator('.ds-row-subtitle')).toHaveAttribute('data-sb-copy-slot', 'SET-SPLASH-SUB');
            const fitsBeside = await row.evaluate(node => node.getBoundingClientRect().right <= document.documentElement.clientWidth + 1);
            expect(fitsBeside).toBe(true);
        });

        test('choosing a character stores it in this browser and in the account, and the next start shows it', async ({ page }) => {
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

        test('a new browser copies the account character after the settings load, and shows it in the row', async ({ page }) => {
            await bootApp(page, { account: { [SPLASH_ACCOUNT_KEY]: 'reisen' } });

            await expect.poll(() => readLocal(page, SPLASH_CHARACTER_KEY)).toBe('reisen');
            const row = await openInterface(page);
            await expect(row.getByRole('combobox', { name: 'Splash Character' })).toHaveValue('reisen');
        });

        test('Reduced Motion is mirrored to this browser when the settings load and on every save', async ({ page }) => {
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
