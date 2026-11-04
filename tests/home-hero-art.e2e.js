import { expect, test } from '@playwright/test';
import { getPixelArt } from '../public/scripts/sillybunny-home/art-sources.js';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { settledRead } from './helpers/settled-read.js';
import { stubTheme } from './helpers/theme-stub.js';

/*
 * The hero of Home is pixel art on the lavender panel of the art panels. It is drawn at the fixed step of the screen when
 * the band holds it, at the largest whole step that does when it does not, and shrunk by a fraction only when one device
 * pixel per art pixel is still wider than the band. The band has to hold the picture and the padding of the panel, which
 * is 12px, and 8px on a narrow container where every pixel counts. The size of each picture comes from `art-sources.js`
 * and the rule is written out here, so the test follows a new picture and does not compute its answer with the code
 * under test. These tests use Playwright's `deviceScaleFactor`, which checks sizes and not the evenness of the pixels;
 * `art-pixel-evenness.e2e.js` does that on a browser that runs at the real scale.
 */

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const STARTUP_TIMEOUT = 30_000;
const DAY = { hour: 12, art: getPixelArt('hero-duo') };
const NIGHT = { hour: 21, art: getPixelArt('hero-duo-night') };
/** The container width up to which Home gives the hero's panel 8px of padding instead of 12px. */
const NARROW_CONTAINER = 390;
const BACKDROP_FLOOR = 1.1;

/**
 * Widths that include common phones and both sides of each change in the paddings of Home. The container of Home is
 * narrower than the window, so a rule at 390px or 414px of container switches at a window that is wider than that.
 */
const WIDTHS = [360, 375, 380, 388, 390, 396, 404, 405, 414, 428, 430, 440, 460, 1440];
const RATIOS = [1, 1.5, 2, 3];

async function startHome(page, hour) {
    await page.clock.setFixedTime(new Date(2026, 9, 30, hour, 0));
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
    await expect(page.locator('.welcomePanel .sbHomeHeroArt img')).toBeVisible();
    await expect.poll(() => page.locator('.welcomePanel .sbHomeHeroArt img').evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
}

/** The hero, its panel, its band and what the band leaves it, in CSS pixels, once the layout has stopped changing. */
async function readHero(page) {
    return page.evaluate(() => {
        const panel = document.querySelector('.welcomePanel .sbHomeHeroArt');
        const figure = panel.querySelector('.sbArtFigure');
        const band = panel.closest('.sbHomeBand');
        const welcome = document.querySelector('.welcomePanel');
        const bandStyle = getComputedStyle(band);
        const panelStyle = getComputedStyle(panel);
        const welcomeStyle = getComputedStyle(welcome);
        const figureBox = figure.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        const bandBox = band.getBoundingClientRect();
        const image = figure.querySelector('img');
        return {
            id: figure.dataset.sbArtPlaceholder,
            fit: panel.dataset.sbArtFit,
            figure: [figureBox.width, figureBox.height],
            panel: [panelBox.width, panelBox.height],
            padding: [Number.parseFloat(panelStyle.paddingLeft), Number.parseFloat(panelStyle.paddingTop)],
            inner: band.clientWidth - Number.parseFloat(bandStyle.paddingLeft) - Number.parseFloat(bandStyle.paddingRight),
            container: welcome.clientWidth - Number.parseFloat(welcomeStyle.paddingLeft) - Number.parseFloat(welcomeStyle.paddingRight),
            natural: [image.naturalWidth, image.naturalHeight],
            ratio: devicePixelRatio,
            centre: [(panelBox.left + panelBox.right) / 2, (bandBox.left + bandBox.right) / 2],
            sideways: welcome.scrollWidth > welcome.clientWidth,
            ariaHidden: panel.getAttribute('aria-hidden'),
            alt: image.getAttribute('alt'),
            rendering: getComputedStyle(image).imageRendering,
        };
    });
}

const settledHero = page => settledRead(page, readHero);

/**
 * What the rule gives for a picture `artWidth` art pixels wide on a screen of `ratio`, in a band that leaves `available`
 * CSS pixels beside the padding of the panel: the fixed step if it fits, else the largest whole step that does, else the
 * band, shrunk.
 */
function expectedDrawing({ artWidth, ratio, available }) {
    const fixed = Math.max(1, Math.round(ratio));
    for (let step = fixed; step >= 1; step--) {
        const width = (artWidth * step) / ratio;
        if (width <= available + 0.01) {
            return { fit: step === fixed ? 'fixed' : 'step', width };
        }
    }
    return { fit: 'smooth', width: available };
}

/** The padding that Home gives the panel of the hero: less on a narrow container. */
const paddingOf = read => (read.container <= NARROW_CONTAINER ? 8 : 12);

/** A whole step is drawn as blocks, and a shrunk picture is sampled smoothly because blocks of uneven size would show as stripes. */
const renderingOf = fit => (fit === 'smooth' ? 'auto' : 'pixelated');

/** What every hero shows, whatever its size: the file, the hiding from assistive technology, and a place inside its band. */
function expectHeroBasics(read, { art }, where) {
    expect(read.natural, `${where}: the file is the size in the table`).toEqual([art.width, art.height]);
    expect(read.ariaHidden, where).toBe('true');
    expect(read.alt, where).toBe('');
    expect(read.panel[0], `${where}: the panel is never wider than its band`).toBeLessThanOrEqual(read.inner + 0.05);
    expect(read.sideways, `${where}: Home does not scroll sideways`).toBe(false);
    expect(Math.abs(read.centre[0] - read.centre[1]), `${where}: the panel is centred in its band`).toBeLessThanOrEqual(1);
    // The proportions of the picture hold at every size, so a smooth hero is not squashed.
    expect(read.figure[1] / read.figure[0], where).toBeCloseTo(art.height / art.width, 2);
}

for (const hero of [DAY, NIGHT]) {
    for (const ratio of RATIOS) {
        test.describe(`${hero.art.id} on a ${ratio}x screen`, () => {
            test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: ratio });

            test('is drawn as the rule says at every width, on a panel with the padding of its container', async ({ page }) => {
                await startHome(page, hero.hour);

                for (const width of WIDTHS) {
                    await page.setViewportSize({ width, height: 900 });
                    const read = await settledHero(page);
                    const where = `${hero.art.id} at ${width}px on ${ratio}x`;
                    const padding = paddingOf(read);
                    const expected = expectedDrawing({ artWidth: hero.art.width, ratio, available: read.inner - 2 * padding });

                    expectHeroBasics(read, hero, where);
                    expect(read.padding, `${where}: the panel pads its picture all round`).toEqual([padding, padding]);
                    expect(read.fit, where).toBe(expected.fit);
                    expect(read.figure[0], where).toBeCloseTo(expected.width, 1);
                    expect(read.panel[0], `${where}: the panel is the picture and its padding`).toBeCloseTo(expected.width + 2 * padding, 1);
                    expect(read.rendering, `${where}: blocks for a whole step, smooth for a shrunk one`).toBe(renderingOf(expected.fit));
                }
            });
        });
    }
}

/*
 * The phones that matter most. The padding of the panel counts against the band, so these are the widths where a
 * change in the paddings of Home would shrink a picture that had fitted. The day picture is the one that is meant to
 * keep the fixed step on every phone that is wide enough to hold it.
 */
test.describe('the hero on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });

    test('keeps the fixed step on a 390px phone when the picture and its panel fit the band, and says so', async ({ page }) => {
        await startHome(page, DAY.hour);

        const read = await settledHero(page);

        expect(read.container).toBeLessThanOrEqual(NARROW_CONTAINER);
        expect(read.padding[0], 'the panel gives up 4px of padding on a narrow container').toBe(8);
        expect(read.fit, 'the picture and its padding fit the band, so there is no reason to shrink').toBe('fixed');
        expect(read.inner).toBeGreaterThanOrEqual(DAY.art.width + 16);
    });

    test('shrinks a picture that cannot fit even with the smaller padding, to the band, on a 360px phone', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 640 });
        await startHome(page, DAY.hour);

        const read = await settledHero(page);

        expect(read.inner).toBeLessThan(DAY.art.width + 16);
        expect(read.fit).toBe('smooth');
        expect(read.panel[0]).toBeCloseTo(read.inner, 0);
    });
});

/** The panel behind the hero is the panel behind the art of a window: same lavender, same fade, same radius. */
test.describe('the backdrop of the hero', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    /** @param {import('@playwright/test').Page} page */
    function readBackdrop(page) {
        return page.evaluate(() => {
            const panel = document.querySelector('.welcomePanel .sbHomeHeroArt');
            const band = panel.closest('.sbHomeBand');
            const channel = value => (value / 255 <= 0.03928 ? value / 255 / 12.92 : (((value / 255) + 0.055) / 1.055) ** 2.4);
            const luminance = ([red, green, blue]) => 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
            const parse = text => text.match(/[\d.]+/g).map(Number);
            const stops = [...getComputedStyle(panel).backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map(match => parse(match[0]));
            const surface = parse(getComputedStyle(band).backgroundColor).slice(0, 3);
            const over = ([red, green, blue, alpha = 1]) => [red, green, blue].map((value, index) => value * alpha + surface[index] * (1 - alpha));
            const ratio = (first, second) => (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
            const probe = document.createElement('div');
            probe.className = 'sbArtPanel';
            document.body.append(probe);
            const windowPanel = getComputedStyle(probe);
            const shared = { radius: windowPanel.borderRadius, image: windowPanel.backgroundImage };
            probe.remove();
            return {
                stops,
                shared,
                radius: getComputedStyle(panel).borderRadius,
                image: getComputedStyle(panel).backgroundImage,
                topContrast: ratio(luminance(over(stops[0])), luminance(surface)),
                bottomContrast: ratio(luminance(over(stops[1])), luminance(surface)),
            };
        });
    }

    for (const hero of [DAY, NIGHT]) {
        for (const themeName of ['Libadwaita', 'Libadwaita Light']) {
            test(`behind the ${hero.art.id} hero is the lavender of a window's panel in ${themeName}, as a fade from about 20% to about 5%`, async ({ page }) => {
                await page.clock.setFixedTime(new Date(2026, 9, 30, hero.hour, 0));
                await protectMaintainerServer(page);
                await installFixtureChats(page);
                await stubTheme(page, themeName);
                await openQuietChatForSmoke(page, { selectCharacter: false });
                await expect(page.locator('.welcomePanel .sbHomeHeroArt img')).toBeVisible({ timeout: STARTUP_TIMEOUT });

                const read = await readBackdrop(page);

                expect(read.stops.map(stop => stop.slice(0, 3))).toEqual([[185, 155, 242], [185, 155, 242]]);
                expect(read.stops[0][3]).toBeCloseTo(0.2, 2);
                expect(read.stops[1][3]).toBeCloseTo(0.05, 2);
                expect(read.image, 'the same gradient as the panel of a window').toBe(read.shared.image);
                expect(read.radius, 'and the same radius').toBe(read.shared.radius);
                expect(read.topContrast, 'the top of the backdrop against the band').toBeGreaterThanOrEqual(BACKDROP_FLOOR);
                expect(read.bottomContrast).toBeLessThan(read.topContrast);
            });
        }
    }

    test('is dropped in forced colours, and the picture stays', async ({ page }) => {
        await startHome(page, DAY.hour);
        await page.emulateMedia({ forcedColors: 'active' });

        const panel = page.locator('.welcomePanel .sbHomeHeroArt');
        await expect(panel).toHaveCSS('background-image', 'none');
        await expect(panel.locator('.sbPixelArt')).toBeVisible();
        await expect(panel.locator('.sbArtFigure')).toHaveCount(1);
    });

    test.describe('when the picture is shrunk smooth', () => {
        test.use({ viewport: { width: 360, height: 640 } });

        test('stays a crisp rounded rectangle of the same gradient, while only the picture is sampled smoothly', async ({ page }) => {
            await startHome(page, NIGHT.hour);

            const read = await settledHero(page);
            const backdrop = await readBackdrop(page);

            expect(read.fit).toBe('smooth');
            expect(read.rendering).toBe('auto');
            expect(backdrop.image).toBe(backdrop.shared.image);
            expect(backdrop.radius).toBe(backdrop.shared.radius);
            // The panel is a box of whole CSS pixels that fills the band, and only the picture inside it is scaled.
            expect(read.panel[0]).toBeCloseTo(read.inner, 0);
            await expect(page.locator('.welcomePanel .sbHomeHeroArt')).toHaveCSS('image-rendering', 'auto');
            await expect(page.locator('.welcomePanel .sbHomeHeroArt')).toHaveCSS('background-image', backdrop.shared.image);
        });
    });
});

test.describe('the hero while the window changes size', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('is drawn again to fit the band, and goes back to the fixed step when the band is wide again', async ({ page }) => {
        await startHome(page, NIGHT.hour);
        expect((await settledHero(page)).fit).toBe('fixed');

        await page.setViewportSize({ width: 360, height: 900 });
        const narrow = await settledHero(page);
        expect(narrow.fit).toBe('smooth');
        expect(narrow.panel[0]).toBeCloseTo(narrow.inner, 0);

        await page.setViewportSize({ width: 1440, height: 900 });
        const wide = await settledHero(page);
        expect(wide.fit).toBe('fixed');
        expect(wide.figure[0]).toBeCloseTo(NIGHT.art.width, 1);
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
        expect(read.panel[0]).toBeCloseTo(read.inner, 0);
        expect(read.panel[0]).toBeGreaterThan(0);
    });
});
