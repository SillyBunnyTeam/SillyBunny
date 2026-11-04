import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

/*
 * The hero of Home is pixel art. It is drawn at the fixed step of the screen when that fits the band, at the largest
 * whole step that does when it does not, and shrunk by a fraction only when one device pixel per art pixel is still
 * wider than the band. The sizes below were read from a sweep of the viewport width at each screen scale, and are
 * written down by hand, so the test does not compute them with the code that it checks. These tests use Playwright's
 * `deviceScaleFactor`, which checks sizes and not the evenness of the pixels; `art-pixel-evenness.e2e.js` does that on
 * a browser that runs at the real scale.
 */

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const DAY = { hour: 12, id: 'hero-duo', native: [332, 366] };
const NIGHT = { hour: 21, id: 'hero-duo-night', native: [361, 362] };

/**
 * `fit` is `fixed` (the fixed step), `step` (a smaller whole step) or `smooth` (shrunk to the band). `size` is the CSS
 * size of the figure; a smooth hero has `size: null` and is checked against the width of its band instead.
 */
const CASES = [
    { hero: DAY, ratio: 1, width: 1440, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 1, width: 420, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 1, width: 400, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 1, width: 372, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 1, width: 370, fit: 'smooth', size: null },
    { hero: DAY, ratio: 1, width: 390, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 1, width: 360, fit: 'smooth', size: null },
    { hero: NIGHT, ratio: 1, width: 1440, fit: 'fixed', size: [361, 362] },
    { hero: NIGHT, ratio: 1, width: 420, fit: 'smooth', size: null },
    { hero: NIGHT, ratio: 1, width: 402, fit: 'fixed', size: [361, 362] },
    { hero: NIGHT, ratio: 1, width: 410, fit: 'smooth', size: null },
    { hero: NIGHT, ratio: 1, width: 360, fit: 'smooth', size: null },
    { hero: DAY, ratio: 1.5, width: 1440, fit: 'fixed', size: [442.67, 488] },
    { hero: DAY, ratio: 1.5, width: 400, fit: 'step', size: [221.33, 244] },
    { hero: DAY, ratio: 2, width: 1440, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 2, width: 400, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 2, width: 390, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 2, width: 360, fit: 'step', size: [166, 183] },
    { hero: NIGHT, ratio: 2, width: 1440, fit: 'fixed', size: [361, 362] },
    { hero: NIGHT, ratio: 2, width: 390, fit: 'step', size: [180.5, 181] },
    { hero: DAY, ratio: 3, width: 1440, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 3, width: 390, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 3, width: 400, fit: 'fixed', size: [332, 366] },
    { hero: DAY, ratio: 3, width: 360, fit: 'step', size: [221.33, 244] },
    { hero: NIGHT, ratio: 3, width: 1440, fit: 'fixed', size: [361, 362] },
    { hero: NIGHT, ratio: 3, width: 390, fit: 'step', size: [240.67, 241.33] },
];

async function startHome(page, hour) {
    await page.clock.setFixedTime(new Date(2026, 9, 30, hour, 0));
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
    await expect(page.locator('.welcomePanel .sbHomeHeroArt img')).toBeVisible();
    await expect.poll(() => page.locator('.welcomePanel .sbHomeHeroArt img').evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
}

/** The hero, its band and what the band leaves it, in CSS pixels, once the layout has stopped changing. */
async function readHero(page) {
    return page.evaluate(() => {
        const hero = document.querySelector('.welcomePanel .sbHomeHeroArt');
        const band = hero.closest('.sbHomeBand');
        const style = getComputedStyle(band);
        const box = hero.getBoundingClientRect();
        const bandBox = band.getBoundingClientRect();
        const image = hero.querySelector('img');
        return {
            id: hero.dataset.sbArtPlaceholder,
            fit: hero.dataset.sbArtFit,
            size: [box.width, box.height],
            inner: band.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
            natural: [image.naturalWidth, image.naturalHeight],
            ratio: devicePixelRatio,
            centre: [(box.left + box.right) / 2, (bandBox.left + bandBox.right) / 2],
            sideways: document.querySelector('.welcomePanel').scrollWidth > document.querySelector('.welcomePanel').clientWidth,
            ariaHidden: hero.getAttribute('aria-hidden'),
            alt: image.getAttribute('alt'),
            rendering: getComputedStyle(image).imageRendering,
        };
    });
}

async function settledHero(page) {
    let last = '';
    await expect.poll(async () => {
        const now = JSON.stringify(await readHero(page));
        const same = now === last;
        last = now;
        return same;
    }, { timeout: 10_000 }).toBe(true);
    return readHero(page);
}

/** What every hero shows, whatever its size: the file, the hiding from assistive technology, and a place inside its band. */
function expectHeroBasics(read, hero) {
    expect(read.id).toBe(hero.id);
    expect(read.natural, 'the file is the size in the table').toEqual(hero.native);
    expect(read.ariaHidden).toBe('true');
    expect(read.alt).toBe('');
    expect(read.size[0], 'the hero is never wider than its band').toBeLessThanOrEqual(read.inner + 0.05);
    expect(read.sideways, 'Home does not scroll sideways').toBe(false);
    expect(Math.abs(read.centre[0] - read.centre[1]), 'the hero is centred in its band').toBeLessThanOrEqual(1);
    // The proportions of the picture hold at every size, so a smooth hero is not squashed.
    expect(read.size[1] / read.size[0]).toBeCloseTo(hero.native[1] / hero.native[0], 2);
}

for (const { hero, ratio, width, fit, size } of CASES.filter(entry => entry.size)) {
    test.describe(`${hero.id} at ${width}px on a ${ratio}x screen`, () => {
        test.use({ viewport: { width, height: 900 }, deviceScaleFactor: ratio });

        test(`is drawn ${fit === 'fixed' ? 'at the fixed step' : 'at a smaller whole step'}`, async ({ page }) => {
            await startHome(page, hero.hour);

            const read = await settledHero(page);

            expectHeroBasics(read, hero);
            expect(read.fit).toBe(fit);
            expect(read.rendering, 'a whole step is blocks').toBe('pixelated');
            expect(read.size[0]).toBeCloseTo(size[0], 1);
            expect(read.size[1]).toBeCloseTo(size[1], 1);
        });
    });
}

for (const { hero, ratio, width } of CASES.filter(entry => !entry.size)) {
    test.describe(`${hero.id} at ${width}px on a ${ratio}x screen`, () => {
        test.use({ viewport: { width, height: 900 }, deviceScaleFactor: ratio });

        test('is shrunk to its band and sampled smoothly', async ({ page }) => {
            await startHome(page, hero.hour);

            const read = await settledHero(page);

            expectHeroBasics(read, hero);
            expect(read.fit).toBe('smooth');
            expect(read.rendering, 'a shrunk picture is sampled smoothly').toBe('auto');
            expect(read.size[0], 'a smooth hero fills its band').toBeCloseTo(read.inner, 0);
            expect(read.size[0], 'and is smaller than one step').toBeLessThan(hero.native[0]);
        });
    });
}

test.describe('the hero while the window changes size', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('is drawn again to fit the band, and goes back to the fixed step when the band is wide again', async ({ page }) => {
        await startHome(page, NIGHT.hour);
        expect((await settledHero(page)).fit).toBe('fixed');

        await page.setViewportSize({ width: 360, height: 900 });
        const narrow = await settledHero(page);
        expect(narrow.fit).toBe('smooth');
        expect(narrow.size[0]).toBeCloseTo(narrow.inner, 0);

        await page.setViewportSize({ width: 1440, height: 900 });
        const wide = await settledHero(page);
        expect(wide.fit).toBe('fixed');
        expect(wide.size[0]).toBeCloseTo(361, 1);
    });

    test('is fitted to the band that comes back when the window changed size while Compact hid it', async ({ page }) => {
        await startHome(page, DAY.hour);
        const chooseMode = async (name) => {
            await page.getByRole('button', { name: 'Main Menu' }).click();
            await page.getByRole('menuitemradio', { name, exact: true }).click();
        };

        await chooseMode('Compact');
        await expect(page.locator('.welcomePanel .sbHomeHeroArt')).toBeHidden();
        await page.setViewportSize({ width: 360, height: 900 });
        await chooseMode('Full');

        const read = await settledHero(page);
        expect(read.fit).toBe('smooth');
        expect(read.size[0]).toBeCloseTo(read.inner, 0);
        expect(read.size[0]).toBeGreaterThan(0);
    });
});
