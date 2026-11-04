import { chromium, expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { measureEvenness, readFigures } from './helpers/pixel-evenness.js';
import { getPixelArt } from '../public/scripts/sillybunny-home/art-sources.js';

/*
 * Pixel art is even only when one art pixel is a whole number of real device pixels. Playwright's `deviceScaleFactor`
 * option is not a real screen: it makes `devicePixelRatio` report the factor, but the page is laid out in CSS pixels
 * and then scaled, so a box of 151.2 CSS px shows seams that no real screen shows, and a layout that is right on a real
 * screen can look uneven. These tests start a Chromium that runs at the scale itself, with
 * `--force-device-scale-factor` and a window of the size they want, and open a context with `viewport: null` so the
 * page takes the size of the window. `window.innerWidth`, `getBoundingClientRect` and screenshots then behave as they
 * do on a screen of that scale, and the first assertion of each test fails loudly when the launch did not take.
 */

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 180_000 });

const STARTUP_TIMEOUT = 30_000;

const openModule = (module, call) => `(async () => { await (await import('${module}')).${call}; })()`;

const WINDOWS = [
    { name: 'About', open: openModule('/scripts/sillybunny-about.js', 'openAboutWindow()') },
    { name: 'Getting Started', open: openModule('/scripts/sillybunny-home/getting-started-window.js', 'openGettingStartedWindow()') },
    {
        name: 'Help',
        open: openModule('/scripts/sillybunny-help/help-window.js', 'openHelpWindow()'),
        // A phone opens Help on its list of sections, and the front page is its first row.
        after: page => page.locator('dialog.sb-dialog-host[open] .sb-list-editor__sidebar button.ds-row')
            .filter({ has: page.locator('.ds-row-label', { hasText: /^Overview$/ }) }).click(),
    },
    { name: 'Bundled Extras', open: openModule('/scripts/sillybunny-home/bundled-extras-window.js', 'openBundledExtrasWindow()') },
    { name: 'Keyboard Shortcuts', open: openModule('/scripts/sillybunny-shortcuts.js', 'openShortcutsWindow()') },
    { name: 'Welcome', open: openModule('/scripts/sillybunny-welcome.js', 'openWelcomeDialog()') },
];

async function launch(testInfo, { scale, width, height }) {
    const browser = await chromium.launch({ args: [`--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`] });
    const context = await browser.newContext({ viewport: null, baseURL: testInfo.project.use.baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    return { browser, page };
}

/**
 * The browser runs at the scale and size that the test asked for. A scale that a float cannot hold, such as 1.1, is
 * reported as the nearest float, and a window of 844 device pixels at 1.1 is 845 CSS pixels wide at most, so those two are
 * compared with the room that the rounding has.
 */
async function expectLaunched(page, { scale, width, height }) {
    const [ratio, innerW, innerH] = await page.evaluate(() => [devicePixelRatio, innerWidth, innerHeight]);
    expect(ratio, 'the browser runs at the scale that the test asked for').toBeCloseTo(scale, 5);
    expect(Math.abs(innerW - width), 'and at the width').toBeLessThanOrEqual(1);
    expect(Math.abs(innerH - height), 'and at the height').toBeLessThanOrEqual(1);
}

async function startHome(page, { scale, width, height }) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
    await expectLaunched(page, { scale, width, height });
}

async function openAndSettle(page, { open, after }) {
    await page.evaluate(open);
    const host = page.locator('dialog.sb-dialog-host[open]');
    await expect(host).toBeVisible();
    await after?.(page);
    // Every picture decoded, and the layout stopped changing, which takes a few frames after the window opens.
    await expect.poll(() => host.evaluate(root => [...root.querySelectorAll('.sbPixelArt')].every(image => image.complete && image.naturalWidth > 0))).toBe(true);
    await expect.poll(async () => {
        const first = JSON.stringify(await readFigures(page, { scope: 'dialog.sb-dialog-host[open]' }));
        await page.waitForTimeout(250);
        return first === JSON.stringify(await readFigures(page, { scope: 'dialog.sb-dialog-host[open]' }));
    }, { timeout: 10_000 }).toBe(true);
}

async function closeWindow(page) {
    for (let attempt = 0; attempt < 4 && await page.locator('dialog.sb-dialog-host[open]').count() > 0; attempt++) {
        await page.locator('dialog.sb-dialog-host[open] .sb-dialog__close, dialog.sb-dialog-host[open] .sb-dialog__cancel').last().click({ force: true });
        await page.waitForTimeout(300);
    }
    await expect(page.locator('dialog.sb-dialog-host[open]')).toHaveCount(0);
}

async function expectEven(page, { scale, step, expectMode, exactStep = false, readOptions = { scope: 'dialog.sb-dialog-host[open]' } }) {
    const figures = await readFigures(page, readOptions);
    expect(figures.length).toBeGreaterThan(0);
    expect(new Set(figures.map(figure => figure.mode))).toEqual(new Set([expectMode]));
    // A banner may draw a pair at a lower step than the screen's when the pair is wider than the banner. The step a
    // figure really has must still be a whole number of device pixels, and never larger than the fixed step.
    const drawn = figures.map((figure) => {
        const drawnStep = (figure.width * scale) / figure.nativeWidth;
        expect(Math.abs(drawnStep - Math.round(drawnStep)), `${figure.id} is ${drawnStep} device pixels per art pixel`).toBeLessThan(0.01);
        expect(Math.round(drawnStep), `${figure.id} is no larger than the fixed step`).toBeLessThanOrEqual(step);
        if (exactStep) {
            expect(Math.round(drawnStep), `${figure.id} is drawn at the step that the rule gives`).toBe(step);
        }
        expect(Math.round(drawnStep), `${figure.id} is drawn`).toBeGreaterThanOrEqual(1);
        return { ...figure, step: Math.round(drawnStep) };
    });
    const shot = await page.screenshot();
    const results = await measureEvenness(page, { figures: drawn, ratio: scale, shot });
    for (const { id, total, bad, offset } of results) {
        expect(total, `${id} has opaque art pixels to check`).toBeGreaterThan(1000);
        expect(bad, `${id}: art pixels that are not one even block (best offset ${offset})`).toBe(0);
    }
}

/*
 * 1.1 and 1.75 are what browser zoom gives on a 1x and a 2x screen. They are not whole, so the step rounds (to 1 and
 * to 2), and one CSS pixel is not a whole number of device pixels: the layout lands on fractions of a device pixel that
 * the art has to be placed around.
 */
const SCALES = [1, 1.1, 1.25, 1.5, 1.75, 2, 3];

for (const scale of SCALES) {
    const step = Math.max(1, Math.round(scale));
    test.describe(`on a screen of scale ${scale}`, () => {
        test(`every window draws its panel in even blocks of ${step} device pixels`, async ({}, testInfo) => {
            const size = { scale, width: 1440, height: 900 };
            const { browser, page } = await launch(testInfo, size);
            try {
                await startHome(page, size);
                for (const window of WINDOWS) {
                    await test.step(window.name, async () => {
                        await openAndSettle(page, window);
                        await expectEven(page, { scale, step, expectMode: 'panel' });
                        await closeWindow(page);
                    });
                }
            } finally {
                await browser.close();
            }
        });

        test(`a banner on a phone-sized window draws the top of the figure in even blocks of ${step} device pixels`, async ({}, testInfo) => {
            const size = { scale, width: 390, height: 844 };
            const { browser, page } = await launch(testInfo, size);
            try {
                await startHome(page, size);
                for (const window of WINDOWS) {
                    await test.step(window.name, async () => {
                        await openAndSettle(page, window);
                        await expectEven(page, { scale, step, expectMode: 'banner' });
                        await closeWindow(page);
                    });
                }
            } finally {
                await browser.close();
            }
        });
    });
}

/*
 * A landscape phone is 390px tall, so a banner there shows at most 105 rows, cut across the figure at a whole art pixel.
 * The cut must not break the blocks.
 */
for (const scale of [1, 1.1, 1.25, 1.75, 2, 3]) {
    const step = Math.max(1, Math.round(scale));
    test(`a banner on a landscape phone is cut at a whole art pixel and draws even blocks of ${step} device pixels at scale ${scale}`, async ({}, testInfo) => {
        const size = { scale, width: 844, height: 390 };
        const { browser, page } = await launch(testInfo, size);
        try {
            await startHome(page, size);
            for (const window of WINDOWS) {
                await test.step(window.name, async () => {
                    await openAndSettle(page, window);
                    await expectEven(page, { scale, step, expectMode: 'banner' });
                    const heights = await page.locator('dialog.sb-dialog-host[open] .sbArtPanel').evaluate(panel => panel.getBoundingClientRect().height);
                    expect(heights, 'the banner is at most 30% of the height').toBeLessThanOrEqual(0.3 * await page.evaluate(() => innerHeight) + 0.5);
                    await closeWindow(page);
                });
            }
        } finally {
            await browser.close();
        }
    });
}

/*
 * On a 1.5 screen a step-2 row is 4/3 CSS pixels, so 105 CSS pixels hold 78 rows, which is under 90. A banner then
 * takes step 1, a row of 2/3 CSS pixels, and shows 157 rows cut to 105 CSS pixels. It does not disappear.
 */
test('a banner on a landscape phone of scale 1.5 steps down to one device pixel per art pixel and is still even', async ({}, testInfo) => {
    const size = { scale: 1.5, width: 844, height: 390 };
    const { browser, page } = await launch(testInfo, size);
    try {
        await startHome(page, size);
        for (const window of WINDOWS) {
            await test.step(window.name, async () => {
                await openAndSettle(page, window);
                await expectEven(page, { scale: 1.5, step: 1, expectMode: 'banner', exactStep: true });
                const height = await page.locator('dialog.sb-dialog-host[open] .sbArtPanel').evaluate(panel => panel.getBoundingClientRect().height);
                expect(height, 'the banner is at most 30% of the height').toBeLessThanOrEqual(0.3 * await page.evaluate(() => innerHeight) + 0.5);
                await closeWindow(page);
            });
        }
    } finally {
        await browser.close();
    }
});

/*
 * The splash draws the mascot at the largest whole step whose art is at most 42% of the viewport height. It is a still
 * picture on an opaque surface, so every opaque art pixel must be one even block of device pixels at that step.
 */
for (const scale of [1, 1.1, 1.5, 1.75, 2, 3]) {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
        test(`the splash draws every art pixel as an even block at ${width}x${height} on a screen of scale ${scale}`, async ({}, testInfo) => {
            const { browser, page } = await launch(testInfo, { scale, width, height });
            try {
                await protectMaintainerServer(page);
                let releaseBoot = () => {};
                const released = new Promise((resolve) => { releaseBoot = resolve; });
                await page.route('**/api/settings/get', async (route) => {
                    await released;
                    await route.fallback();
                });
                await page.addInitScript(() => localStorage.setItem('sb-splash-character', 'both'));
                await page.goto('/', { waitUntil: 'domcontentloaded' });
                const mascot = page.locator('#preloader .sb-boot-mascot');
                await expect(mascot).toBeVisible({ timeout: STARTUP_TIMEOUT });
                await expect.poll(() => mascot.evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
                await expectLaunched(page, { scale, width, height });

                // The step is the one the rule gives, not only a whole one.
                const step = Math.max(1, Math.floor((0.42 * height * scale) / 366 + 1e-6));
                await expectEven(page, { scale, step, expectMode: 'panel', exactStep: true, readOptions: { scope: '#preloader', figureSelector: '.sb-boot-mascot' } });
                releaseBoot();
            } finally {
                await browser.close();
            }
        });
    }
}

/*
 * The hero of Home is drawn at the fixed step when it fits its band, and at a smaller whole step when it does not;
 * both are even. One that had to be shrunk to its band by a fraction cannot be even, so it is drawn with smooth
 * sampling instead, which is checked for what it is: smooth, no wider than the band, and not pixelated. The picture
 * sits on a panel, so the band has to hold the picture and the padding of the panel.
 */
const HEROES = [
    { name: 'day', hour: 12, art: getPixelArt('hero-duo') },
    { name: 'night', hour: 21, art: getPixelArt('hero-duo-night') },
];

/** What Home leaves the hero's panel on a 390px phone: the width of the band's content, and the padding that the panel takes there. */
const PHONE_BAND = 350;
const PHONE_PANEL_PADDING = 8;

/** At one device pixel per art pixel the picture is `art.width / scale` CSS pixels wide, which a phone band may not hold. */
const isShrunk = ({ art, width, scale }) => width === 390 && art.width / scale + 2 * PHONE_PANEL_PADDING > PHONE_BAND;

const HERO_FIGURES = { scope: '.welcomePanel', figureSelector: '.sbHomeHeroArt .sbArtFigure' };

/** Opens Home with the hero of this hour and waits until the hero is drawn and has stopped changing. */
async function openHero(testInfo, { scale, width, height, hour }) {
    const { browser, page } = await launch(testInfo, { scale, width, height });
    await page.clock.setFixedTime(new Date(2026, 9, 30, hour, 0));
    await startHome(page, { scale, width, height });
    const hero = page.locator('.welcomePanel .sbHomeHeroArt');
    await expect(hero).toBeVisible();
    await expect.poll(() => hero.locator('img').evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
    await hero.scrollIntoViewIfNeeded();
    await expect.poll(async () => {
        const first = JSON.stringify(await readFigures(page, HERO_FIGURES));
        await page.waitForTimeout(250);
        return first === JSON.stringify(await readFigures(page, HERO_FIGURES));
    }, { timeout: 10_000 }).toBe(true);
    return { browser, page, hero };
}

for (const scale of [1, 1.1, 1.5, 1.75, 2, 3]) {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
        for (const { name, hour } of HEROES.filter(entry => !isShrunk({ art: entry.art, width, scale }))) {
            test(`the ${name} hero draws every art pixel as an even block at ${width}x${height} on a screen of scale ${scale}`, async ({}, testInfo) => {
                const { browser, page } = await openHero(testInfo, { scale, width, height, hour });
                try {
                    // A wide Home keeps the fixed step, so the step is the one of the screen, not only a whole one.
                    const fixedStep = Math.max(1, Math.round(scale));
                    await expectEven(page, { scale, step: fixedStep, expectMode: 'panel', exactStep: width === 1440, readOptions: HERO_FIGURES });
                } finally {
                    await browser.close();
                }
            });
        }
    }
}

for (const scale of [1, 1.1, 1.5, 1.75, 2, 3]) {
    for (const { name, hour, art } of HEROES.filter(entry => isShrunk({ art: entry.art, width: 390, scale }))) {
        test(`the ${name} hero is shrunk to its band and sampled smoothly at 390x844 on a screen of scale ${scale}`, async ({}, testInfo) => {
            const { browser, hero } = await openHero(testInfo, { scale, width: 390, height: 844, hour });
            try {
                const read = await hero.evaluate((panel) => {
                    const band = panel.closest('.sbHomeBand');
                    const style = getComputedStyle(band);
                    const figure = panel.querySelector('.sbArtFigure');
                    return {
                        fit: panel.dataset.sbArtFit,
                        rendering: getComputedStyle(figure.querySelector('img')).imageRendering,
                        figureWidth: figure.getBoundingClientRect().width,
                        panelWidth: panel.getBoundingClientRect().width,
                        inner: band.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
                    };
                });
                expect(read.fit, 'the hero had to be shrunk by a fraction').toBe('smooth');
                expect(read.rendering, 'and a shrunk picture is sampled smoothly, not as blocks of uneven size').toBe('auto');
                expect(read.panelWidth, 'its panel fills its band').toBeCloseTo(read.inner, 0);
                expect(read.figureWidth, 'and the picture is smaller than its file').toBeLessThan(art.width);
            } finally {
                await browser.close();
            }
        });
    }
}
