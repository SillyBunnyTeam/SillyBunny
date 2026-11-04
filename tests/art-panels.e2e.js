import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { stubTheme } from './helpers/theme-stub.js';

/*
 * The art of a window is a panel beside its content on a wide screen and a banner above it on a narrow or a short one.
 * Every box is checked against the size that the fixed step gives it: one art pixel is `round(devicePixelRatio)`
 * device pixels, so a figure is `art size x step / ratio` CSS pixels wide. These tests use Playwright's
 * `deviceScaleFactor`, which lays the page out in CSS pixels, so they check sizes and places and not the evenness of
 * the pixels. `art-pixel-evenness.e2e.js` does that on a browser that runs at the real scale.
 */

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const STARTUP_TIMEOUT = 30_000;
const MIN_CONTENT = 360;
const GAP = 16;
const BANNER_SHARE = 0.62;
/** A banner is at most 30% of the viewport height, less the 12px above the art, in rows at a whole step. */
const BANNER_HEIGHT_SHARE = 0.3;
const PADDING = 12;

/**
 * `rowLimit` is the most rows that a banner shows, worked out by hand: 30% of the height, less 12, at one CSS pixel per
 * row on a screen of a whole scale. It is left out for a panel. A 1024x600 window has the room for the tallest panel, so
 * the cap does not touch it.
 */
const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } }, mode: 'panel' },
    { name: 'short desktop 1440x420', options: { viewport: { width: 1440, height: 420 } }, mode: 'banner', rowLimit: 114 },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, mode: 'banner', rowLimit: 241 },
    { name: 'landscape phone 844x390', options: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true }, mode: 'banner', rowLimit: 105, scales: [1, 2, 3] },
    { name: 'small laptop 1024x600', options: { viewport: { width: 1024, height: 600 } }, mode: 'panel' },
];

const openModule = (module, call) => `(async () => { await (await import('${module}')).${call}; })()`;

/** What each window shows, and how to get it on screen. `after` moves on to a page that has its own art. */
const WINDOWS = [
    { name: 'About', art: ['about-reisen', 'about-tewi'], open: openModule('/scripts/sillybunny-about.js', 'openAboutWindow()') },
    {
        name: 'About, Troubleshooting',
        art: ['troubleshooting-reisen'],
        open: openModule('/scripts/sillybunny-about.js', 'openAboutWindow()'),
        after: page => page.getByRole('button', { name: 'Troubleshooting', exact: true }).click(),
    },
    { name: 'Getting Started', art: ['gs-reisen'], open: openModule('/scripts/sillybunny-home/getting-started-window.js', 'openGettingStartedWindow()') },
    { name: 'Bundled Extras', art: ['extras-tewi'], open: openModule('/scripts/sillybunny-home/bundled-extras-window.js', 'openBundledExtrasWindow()') },
    {
        name: 'Help',
        art: ['help-reisen'],
        open: openModule('/scripts/sillybunny-help/help-window.js', 'openHelpWindow()'),
        // A phone opens Help on its list of sections, and the front page is its first row.
        after: page => page.locator('dialog.sb-dialog-host[open] .sb-list-editor__sidebar button.ds-row')
            .filter({ has: page.locator('.ds-row-label', { hasText: /^Overview$/ }) }).click(),
    },
    { name: 'Keyboard Shortcuts', art: ['shortcuts-tewi'], open: openModule('/scripts/sillybunny-shortcuts.js', 'openShortcutsWindow()') },
    { name: 'Welcome', art: ['welcome-both'], open: openModule('/scripts/sillybunny-welcome.js', 'openWelcomeDialog()') },
    {
        name: 'Welcome, Your Persona',
        art: ['welcome-persona-tewi'],
        open: openModule('/scripts/sillybunny-welcome.js', 'openWelcomeDialog()'),
        after: page => page.getByRole('button', { name: 'Next', exact: true }).click(),
    },
    {
        name: 'Welcome, What’s Next',
        art: ['welcome-next-reisen'],
        open: openModule('/scripts/sillybunny-welcome.js', 'openWelcomeDialog()'),
        after: async (page) => {
            await page.getByRole('button', { name: 'Next', exact: true }).click();
            await expect(page.locator('.sb-dialog__page:not(.is-underlay):not(.is-leaving) [data-sb-art-placeholder="welcome-persona-tewi"]')).toBeVisible();
            await page.getByRole('button', { name: 'Next', exact: true }).click();
        },
    },
];

/** The size of each picture and the rows that a banner shows, read from the table that the layout itself uses. */
async function readNative(page, ids) {
    return page.evaluate(async (names) => {
        const { getPixelArt } = await import('/scripts/sillybunny-home/art-sources.js');
        return Object.fromEntries(names.map(name => [name, getPixelArt(name)]));
    }, ids);
}

/** Everything about the art of the page that is on top, in CSS pixels. */
async function readLayout(page) {
    return page.evaluate(() => {
        const rect = (node) => {
            const box = node.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        };
        const panels = [...document.querySelectorAll('.sb-dialog-host[open] .sbArtPanel')].filter(node => node.getClientRects().length > 0 && !node.closest('[inert], .is-underlay, .is-leaving'));
        if (panels.length !== 1) {
            return { panels: panels.length };
        }
        const [panel] = panels;
        const host = panel.parentElement;
        const hostStyle = getComputedStyle(host);
        const surface = panel.closest('.sb-dialog');
        return {
            panels: 1,
            ratio: devicePixelRatio,
            viewport: { width: innerWidth, height: innerHeight },
            mode: panel.dataset.sbArtMode,
            fit: panel.dataset.sbArtFit ?? null,
            hostMode: host.dataset.sbArtMode ?? null,
            ariaHidden: panel.getAttribute('aria-hidden'),
            panel: rect(panel),
            surface: rect(surface),
            host: rect(host),
            hostPadding: { start: Number.parseFloat(hostStyle.paddingInlineStart), end: Number.parseFloat(hostStyle.paddingInlineEnd) },
            overflowsSideways: host.scrollWidth > host.clientWidth,
            figures: [...panel.querySelectorAll('.sbArtFigure')].map(figure => ({
                id: figure.dataset.sbArtPlaceholder,
                box: rect(figure),
                imageBox: rect(figure.firstElementChild),
                alt: figure.firstElementChild.getAttribute('alt'),
                loaded: figure.firstElementChild.complete ? figure.firstElementChild.naturalWidth : 0,
                rendering: getComputedStyle(figure.firstElementChild).imageRendering,
            })),
            siblings: [...host.children].filter(child => child !== panel && child.getBoundingClientRect().height > 0).map(rect),
        };
    });
}

async function startHome(page) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
}

/** Waits until the art of the page that is on top is the given set, loaded, and the layout has stopped changing. */
async function settle(page, art) {
    // A page that is sliding out or already covered can still be in the document, so only a panel that is drawn counts.
    const shown = page.locator('dialog.sb-dialog-host[open] .sbArtPanel > [data-sb-art-placeholder]');
    await expect.poll(() => shown.evaluateAll(nodes => nodes
        .filter(node => node.getClientRects().length > 0 && !node.closest('.is-underlay, .is-leaving, [inert]'))
        .map(node => node.dataset.sbArtPlaceholder))).toEqual(art);
    // Every figure has its file, and the layout has stopped changing.
    await expect.poll(async () => {
        const before = JSON.stringify(await readLayout(page));
        await page.waitForTimeout(200);
        const layout = await readLayout(page);
        return before === JSON.stringify(layout) && layout.figures?.every(figure => figure.loaded > 0);
    }, { timeout: 10_000 }).toBe(true);
}

async function openWindow(page, { open, after, art }) {
    await page.evaluate(open);
    await expect(page.locator('dialog.sb-dialog-host[open]')).toBeVisible();
    if (after) {
        await after(page);
    }
    await settle(page, art);
}

/** A window of the table by its name, so a change to the order of the table cannot change what a test opens. */
function windowNamed(name) {
    const found = WINDOWS.find(window => window.name === name);
    if (!found) {
        throw new Error(`No window named ${name} in the table`);
    }
    return found;
}

for (const viewport of VIEWPORTS) {
    for (const scale of viewport.scales ?? [1, 2]) {
        test.describe(`${viewport.name} at a screen scale of ${scale}`, () => {
            test.use({ ...viewport.options, deviceScaleFactor: scale });

            test.beforeEach(async ({ page }) => {
                await startHome(page);
            });

            for (const window of WINDOWS) {
                test(`${window.name}: ${viewport.mode === 'panel' ? 'a panel beside the content' : 'a banner above the content'}`, async ({ page }) => {
                    await openWindow(page, window);
                    const native = await readNative(page, window.art);
                    const layout = await readLayout(page);
                    const step = Math.max(1, Math.round(scale));
                    const css = (artPixels) => (artPixels * step) / scale;

                    expect(layout.panels).toBe(1);
                    expect(layout.ratio).toBe(scale);
                    expect(layout.ariaHidden, 'the art is hidden from assistive technology').toBe('true');
                    expect(layout.mode).toBe(viewport.mode);
                    expect(layout.hostMode).toBe(viewport.mode);
                    expect(layout.fit, 'a whole step of the screen').toBe('fixed');
                    expect(layout.figures.map(figure => figure.id)).toEqual(window.art);
                    expect(layout.overflowsSideways, 'the body does not scroll sideways').toBe(false);

                    for (const figure of layout.figures) {
                        const art = native[figure.id];
                        const rows = viewport.mode === 'banner' ? Math.min(Math.floor(art.height * BANNER_SHARE), viewport.rowLimit) : art.height;
                        expect(figure.alt, 'the picture has no text of its own').toBe('');
                        expect(figure.loaded, 'the file is the size in the table').toBe(art.width);
                        expect(figure.rendering).toBe('pixelated');
                        expect(figure.box.width, `${figure.id} is ${art.width} art pixels wide at ${step} device pixels each`).toBeCloseTo(css(art.width), 1);
                        expect(figure.box.height, `${figure.id} shows ${rows} rows`).toBeCloseTo(css(rows), 1);
                        expect(figure.imageBox.width).toBeCloseTo(css(art.width), 1);
                        expect(figure.imageBox.height).toBeCloseTo(css(art.height), 1);
                    }

                    expect(layout.panel.left, 'the art stays inside the window').toBeGreaterThanOrEqual(layout.surface.left - 0.5);
                    expect(layout.panel.right).toBeLessThanOrEqual(layout.surface.right + 0.5);
                    expect(layout.surface.left).toBeGreaterThanOrEqual(0);
                    expect(layout.surface.right).toBeLessThanOrEqual(layout.viewport.width + 0.5);

                    if (viewport.mode === 'panel') {
                        const column = layout.host.width - layout.hostPadding.end - layout.hostPadding.start;
                        expect(column, 'the content column keeps its width').toBeGreaterThanOrEqual(MIN_CONTENT - 1);
                        for (const sibling of layout.siblings) {
                            expect(sibling.left, 'the content starts after the panel and its gap').toBeGreaterThanOrEqual(layout.panel.right + GAP - 1);
                            expect(sibling.right).toBeLessThanOrEqual(layout.host.right + 0.5);
                        }
                        expect(layout.panel.height, 'the whole figure is shown').toBeGreaterThanOrEqual(css(native[window.art[0]].height));
                        expect(layout.panel.bottom, 'the panel is inside the window').toBeLessThanOrEqual(layout.surface.bottom);
                    } else {
                        const top = Math.min(...layout.siblings.map(sibling => sibling.top));
                        expect(layout.panel.bottom, 'the banner is above the content').toBeLessThanOrEqual(top + 1);
                        expect(layout.panel.width, 'the banner is as wide as the content').toBeCloseTo(layout.host.width - layout.hostPadding.start - layout.hostPadding.end, 0);
                        expect(layout.panel.height, 'the banner is at most 30% of the viewport height').toBeLessThanOrEqual(BANNER_HEIGHT_SHARE * layout.viewport.height + 0.5);
                        expect(layout.panel.height, 'and it is the padding above the tallest crop').toBeCloseTo(PADDING + Math.max(...layout.figures.map(figure => figure.box.height)), 1);
                    }
                });
            }
        });
    }
}

/**
 * A viewport that is too short to show 90 rows in 30% of its height (90 rows and the 12px above them need 340px) has no
 * art at all, and the content gets the room. The art is not drawn smaller or as a sliver.
 */
test.describe('a viewport too short for a banner', () => {
    test.use({ viewport: { width: 844, height: 339 }, deviceScaleFactor: 1 });

    /** The mode that the layout chose, and whether anything of the art takes room or is drawn. */
    const readArt = page => page.evaluate(() => {
        const panel = document.querySelector('.sb-dialog-host[open] .sbArtPanel');
        const host = panel.parentElement;
        const first = [...host.children].find(child => child !== panel && child.getBoundingClientRect().height > 0);
        return {
            mode: panel.dataset.sbArtMode,
            hostMode: host.dataset.sbArtMode,
            display: getComputedStyle(panel).display,
            rects: panel.getClientRects().length,
            contentTop: first.getBoundingClientRect().top - host.getBoundingClientRect().top,
            hostPaddingTop: Number.parseFloat(getComputedStyle(host).paddingBlockStart),
        };
    });

    for (const window of ['About', 'Getting Started', 'Welcome'].map(windowNamed)) {
        test(`${window.name}: the art is hidden, takes no room, and comes back when the viewport is tall enough`, async ({ page }) => {
            await startHome(page);
            await page.evaluate(window.open);
            await expect(page.locator('dialog.sb-dialog-host[open]')).toBeVisible();

            await expect.poll(async () => (await readArt(page)).mode).toBe('hidden');
            const hidden = await readArt(page);
            expect(hidden).toMatchObject({ hostMode: 'hidden', display: 'none', rects: 0 });
            expect(hidden.contentTop, 'the content starts at the top of the body').toBeCloseTo(hidden.hostPaddingTop, 0);

            // 340px is 30% of 90 rows and the padding: the least that shows a banner.
            await page.setViewportSize({ width: 844, height: 340 });
            await expect.poll(async () => (await readArt(page)).mode).toBe('banner');
            const shown = await readArt(page);
            expect(shown.rects).toBeGreaterThan(0);
            const panelHeight = await page.locator('.sb-dialog-host[open] .sbArtPanel').evaluate(node => node.getBoundingClientRect().height);
            expect(panelHeight).toBeCloseTo(PADDING + 90, 0);

            await page.setViewportSize({ width: 844, height: 339 });
            await expect.poll(async () => (await readArt(page)).mode).toBe('hidden');
        });
    }
});

/** The least contrast between the lavender backdrop of a panel and the surface of the window under it that still reads as a backdrop. */
const BACKDROP_FLOOR = 1.1;
/** The windows whose panel has the backdrop: one of two figures, and the two windows that have one figure. */
const BACKDROP_WINDOWS = ['About', 'Getting Started', 'Welcome'];
const THEME_AND_WINDOW = ['Libadwaita', 'Libadwaita Light'].flatMap(themeName => BACKDROP_WINDOWS.map(windowName => [themeName, windowName]));

test.describe('the backdrop of a panel', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    for (const [themeName, windowName] of THEME_AND_WINDOW) {
        test(`reads against the ${windowName} window in ${themeName}, as a lavender that fades from about 20% to about 5%`, async ({ page }) => {
            await protectMaintainerServer(page);
            await installFixtureChats(page);
            await stubTheme(page, themeName);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
            await openWindow(page, windowNamed(windowName));

            const read = await page.evaluate(() => {
                const panel = document.querySelector('.sb-dialog-host[open] .sbArtPanel');
                const surface = panel.closest('.sb-dialog');
                const channel = value => (value / 255 <= 0.03928 ? value / 255 / 12.92 : (((value / 255) + 0.055) / 1.055) ** 2.4);
                const luminance = ([red, green, blue]) => 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
                const parse = text => text.match(/[\d.]+/g).map(Number);
                const image = getComputedStyle(panel).backgroundImage;
                const stops = [...image.matchAll(/rgba?\([^)]+\)/g)].map(match => parse(match[0]));
                const surfaceColour = parse(getComputedStyle(surface).backgroundColor).slice(0, 3);
                const over = ([red, green, blue, alpha = 1]) => [red, green, blue].map((value, index) => value * alpha + surfaceColour[index] * (1 - alpha));
                const ratio = (first, second) => (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
                return {
                    stops,
                    topContrast: ratio(luminance(over(stops[0])), luminance(surfaceColour)),
                    bottomContrast: ratio(luminance(over(stops[1])), luminance(surfaceColour)),
                };
            });

            expect(read.stops.map(stop => stop.slice(0, 3))).toEqual([[185, 155, 242], [185, 155, 242]]);
            expect(read.stops[0][3]).toBeCloseTo(0.2, 2);
            expect(read.stops[1][3]).toBeCloseTo(0.05, 2);
            expect(read.topContrast, 'the top of the backdrop against the window').toBeGreaterThanOrEqual(BACKDROP_FLOOR);
            expect(read.bottomContrast).toBeLessThan(read.topContrast);
        });
    }

    for (const windowName of BACKDROP_WINDOWS) {
        test(`is dropped in forced colours, and the picture stays, in ${windowName}`, async ({ page }) => {
            await startHome(page);
            await page.emulateMedia({ forcedColors: 'active' });
            const shown = windowNamed(windowName);
            await openWindow(page, shown);

            const panel = page.locator('.sb-dialog-host[open] .sbArtPanel');
            await expect(panel).toHaveCSS('background-image', 'none');
            await expect(panel.locator('.sbArtFigure')).toHaveCount(shown.art.length);
            await expect(panel.locator('.sbPixelArt').first()).toBeVisible();
        });
    }
});

/**
 * A banner is as wide as the body of the window. A pair that is wider takes a smaller whole step, and when even one device
 * pixel per art pixel is too wide it is shrunk by a fraction and sampled smoothly, because blocks of uneven size would show
 * as stripes. The pair of About is 183 + 8 + 145 = 336px wide at one device pixel per art pixel.
 */
test.describe('a banner whose pair is wider than the body', () => {
    test.use({ deviceScaleFactor: 1, isMobile: true, hasTouch: true });

    test.describe('on a 320x568 phone, where the body is 296px', () => {
        test.use({ viewport: { width: 320, height: 568 } });

        test('the pair is shrunk to the body and drawn with smooth sampling', async ({ page }) => {
            await startHome(page);
            await openWindow(page, windowNamed('About'));

            const layout = await readLayout(page);

            expect(layout.mode).toBe('banner');
            expect(layout.fit).toBe('smooth');
            expect(layout.overflowsSideways, 'the body does not scroll sideways').toBe(false);
            const body = layout.host.width - layout.hostPadding.start - layout.hostPadding.end;
            expect(body).toBeCloseTo(296, 0);
            const pair = layout.figures[1].box.right - layout.figures[0].box.left;
            expect(pair, 'the pair fills the body, and is no wider').toBeCloseTo(body, 0);
            expect(layout.figures[1].box.right).toBeLessThanOrEqual(layout.host.right + 0.5);
            for (const figure of layout.figures) {
                expect(figure.rendering, `${figure.id} is smooth, not blocks of uneven size`).toBe('auto');
            }
            // The two figures keep the proportions of their art.
            const native = await readNative(page, ['about-reisen', 'about-tewi']);
            expect(layout.figures[0].box.width / layout.figures[1].box.width).toBeCloseTo(native['about-reisen'].width / native['about-tewi'].width, 2);
            expect(layout.panel.height, 'and the banner is at most 30% of the viewport height').toBeLessThanOrEqual(BANNER_HEIGHT_SHARE * 568 + 0.5);
        });
    });

    test.describe('on a 360x640 phone, where the body is 336px', () => {
        test.use({ viewport: { width: 360, height: 640 } });

        test('the pair fits exactly, so it keeps the fixed step and its blocks', async ({ page }) => {
            await startHome(page);
            await openWindow(page, windowNamed('About'));

            const layout = await readLayout(page);

            expect(layout.mode).toBe('banner');
            expect(layout.fit).toBe('fixed');
            for (const figure of layout.figures) {
                expect(figure.rendering).toBe('pixelated');
            }
        });
    });
});

/**
 * A banner steps down by whole steps for the height too. On a 1.5 screen a step-2 row is 4/3 CSS pixels, so 105px of
 * room hold 78 rows, which is under 90, and step 1 shows 157. Only when even step 1 shows fewer than 90 rows is the art
 * hidden, which on a 1.5 screen needs a viewport under 240px tall. A panel never steps down.
 */
test.describe('a banner on a short screen of scale 1.5', () => {
    test.use({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true });

    test('shows step 1 with the rows that fit, and is still blocks', async ({ page }) => {
        await startHome(page);
        await openWindow(page, windowNamed('Getting Started'));

        const layout = await readLayout(page);
        const native = await readNative(page, ['gs-reisen']);
        const [figure] = layout.figures;

        expect(layout.mode).toBe('banner');
        expect(layout.fit, 'a smaller whole step than the screen asks for').toBe('step');
        expect(figure.rendering).toBe('pixelated');
        expect(figure.box.width, 'one device pixel per art pixel').toBeCloseTo(native['gs-reisen'].width / 1.5, 1);
        expect(figure.box.height, '157 rows: 105px of room at 2/3 of a CSS pixel per row').toBeCloseTo(157 / 1.5, 1);
        expect(layout.panel.height).toBeLessThanOrEqual(BANNER_HEIGHT_SHARE * 390 + 0.5);
    });

    test.describe('and hidden under 240px', () => {
        test.use({ viewport: { width: 844, height: 239 } });

        test('the art is hidden, and comes back at 240px', async ({ page }) => {
            await startHome(page);
            await page.evaluate(windowNamed('Getting Started').open);
            await expect(page.locator('dialog.sb-dialog-host[open]')).toBeVisible();
            const panel = page.locator('dialog.sb-dialog-host[open] .sbArtPanel');
            await expect(panel).toHaveAttribute('data-sb-art-mode', 'hidden');

            await page.setViewportSize({ width: 844, height: 240 });

            await expect(panel).toHaveAttribute('data-sb-art-mode', 'banner');
            await expect(panel).toHaveAttribute('data-sb-art-fit', 'step');
        });
    });
});

/**
 * A window widens to hold the panel and never narrows again while it is open, so moving to a page whose art is narrower
 * does not make the window jump.
 */
test.describe('the width of a window across pages', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    const surfaceWidth = async page => (await readLayout(page)).surface.width;

    test('Welcome keeps its width from page 1 to page 3', async ({ page }) => {
        await startHome(page);
        const welcome = windowNamed('Welcome');
        await openWindow(page, welcome);
        const widths = [await surfaceWidth(page)];

        await page.getByRole('button', { name: 'Next', exact: true }).click();
        await settle(page, ['welcome-persona-tewi']);
        widths.push(await surfaceWidth(page));

        await page.getByRole('button', { name: 'Next', exact: true }).click();
        await settle(page, ['welcome-next-reisen']);
        widths.push(await surfaceWidth(page));

        expect(widths[1], 'page 2 is not narrower than page 1').toBeGreaterThanOrEqual(widths[0] - 0.5);
        expect(widths[2], 'page 3 is not narrower than page 2').toBeGreaterThanOrEqual(widths[1] - 0.5);
        expect((await readLayout(page)).mode).toBe('panel');
    });

    test('a page that a slide brings in has its mode as soon as it is in the document, before anything is painted', async ({ page }) => {
        await startHome(page);
        await openWindow(page, windowNamed('Welcome'));

        // A mutation observer runs in a microtask after the insertion, before the next frame. A panel that waited for the
        // next frame would still be a banner then, and the slide would measure the height of a banner.
        const modeAtInsertion = await page.evaluate(() => new Promise((resolve) => {
            const observer = new MutationObserver(() => {
                const art = document.querySelector('dialog.sb-dialog-host[open] [data-sb-art-placeholder="welcome-persona-tewi"]');
                if (art) {
                    observer.disconnect();
                    resolve(art.parentElement.dataset.sbArtMode);
                }
            });
            observer.observe(document.querySelector('dialog.sb-dialog-host[open]'), { childList: true, subtree: true });
            [...document.querySelectorAll('dialog.sb-dialog-host[open] button')].find(button => button.textContent.trim() === 'Next').click();
        }));

        expect(modeAtInsertion).toBe('panel');
    });

    test('About keeps its width when Troubleshooting has a narrower figure', async ({ page }) => {
        await startHome(page);
        await openWindow(page, windowNamed('About'));
        const before = await surfaceWidth(page);

        await page.getByRole('button', { name: 'Troubleshooting', exact: true }).click();
        await settle(page, ['troubleshooting-reisen']);

        expect(await surfaceWidth(page)).toBeGreaterThanOrEqual(before - 0.5);
        expect((await readLayout(page)).mode).toBe('panel');
    });
});

/**
 * The body pads and spaces its children by its own rules, which change with the density. The layout reads what the body
 * really has and gives it to the CSS, so a body with other values than the default is laid out as correctly. Compact
 * density is set here with the padding and the row gap that a compact body would have.
 */
test.describe('a body with the padding of Compact density', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('the content starts after the panel and its gap, and the panel takes no height', async ({ page }) => {
        await startHome(page);
        // The padding rule has fewer selectors than the rule of the panel, so the panel wins whichever sheet came first. The row gap
        // has more than the rule that sets it.
        await page.addStyleTag({ content: '[data-sb-compact-mode=true] .sb-dialog__body { padding: 10px; } :root[data-sb-compact-mode=true] .sb-dialog__body.sb-dialog__body { row-gap: 8px; }' });
        await page.evaluate(() => document.documentElement.setAttribute('data-sb-compact-mode', 'true'));
        await openWindow(page, windowNamed('About'));

        const read = await page.evaluate(() => {
            const panel = document.querySelector('.sb-dialog-host[open] .sbArtPanel');
            const host = panel.parentElement;
            const style = getComputedStyle(host);
            const first = [...host.children].find(child => child !== panel && child.getBoundingClientRect().height > 0);
            return {
                vars: ['--sb-art-gap', '--sb-art-inset', '--sb-art-inset-block', '--sb-art-row-gap'].map(name => host.style.getPropertyValue(name)),
                panelWidth: Number.parseFloat(host.style.getPropertyValue('--sb-art-w')),
                padding: { start: Number.parseFloat(style.paddingInlineStart), end: Number.parseFloat(style.paddingInlineEnd), top: Number.parseFloat(style.paddingBlockStart) },
                hostBox: host.getBoundingClientRect().toJSON(),
                panelBox: panel.getBoundingClientRect().toJSON(),
                firstBox: first.getBoundingClientRect().toJSON(),
                mode: panel.dataset.sbArtMode,
            };
        });

        expect(read.mode).toBe('panel');
        expect(read.vars, 'the gap of the layout and the padding and row gap that the body really has').toEqual(['16px', '10px', '20px', '8px']);
        expect(read.padding.end).toBe(10);
        expect(read.padding.start, 'the start padding holds the panel, the gap and the end padding').toBeCloseTo(read.panelWidth + 16 + 10, 1);
        expect(read.firstBox.left, 'the content starts one gap after the panel').toBeGreaterThanOrEqual(read.panelBox.right + 16 - 1);
        expect(read.firstBox.top - read.hostBox.top, 'the panel takes no height, so the content starts under the padding').toBeCloseTo(read.padding.top, 0);
        expect(read.hostBox.width - read.padding.start - read.padding.end, 'the column keeps its width').toBeGreaterThanOrEqual(MIN_CONTENT - 1);
    });
});

/**
 * The content column has to keep 360px at the default text size, and the app scales that with the text. At 200% text it
 * is 720px, which a 1024x600 window cannot hold beside the two figures of About, so its art goes above the content. The
 * single figure of Getting Started is narrower, so its window widens to hold the panel and the column keeps 720px.
 */
test.describe('a window at 200% text', () => {
    test.use({ viewport: { width: 1024, height: 600 }, deviceScaleFactor: 1 });

    const TEXT_SCALE = 2;
    const AT_200_PERCENT = [
        { windowName: 'About', mode: 'banner', minColumn: MIN_CONTENT },
        { windowName: 'Getting Started', mode: 'panel', minColumn: MIN_CONTENT * TEXT_SCALE },
    ];

    /** Sets the text scale the way the Global Font Size slider does, before the window opens. */
    const scaleText = (page, scale) => page.evaluate(value => document.documentElement.style.setProperty('--fontScale', String(value)), scale);

    for (const { windowName, mode, minColumn } of AT_200_PERCENT) {
        test(`${windowName}: at 100% text a panel, at 200% a ${mode}, and the column keeps ${minColumn}px`, async ({ page }) => {
            await startHome(page);
            const shown = windowNamed(windowName);

            await openWindow(page, shown);
            expect((await readLayout(page)).mode, 'at 100% text the window holds a panel').toBe('panel');
            await page.keyboard.press('Escape');
            await expect(page.locator('dialog.sb-dialog-host[open]')).toHaveCount(0);

            await scaleText(page, TEXT_SCALE);
            await openWindow(page, shown);
            const layout = await readLayout(page);

            expect(layout.mode, 'the mode at 200% text').toBe(mode);
            expect(layout.hostMode).toBe(mode);
            expect(layout.overflowsSideways, 'the body does not scroll sideways').toBe(false);
            const column = layout.host.width - layout.hostPadding.start - layout.hostPadding.end;
            expect(column, 'the content column').toBeGreaterThanOrEqual(minColumn - 1);
            expect(layout.surface.right, 'the window stays inside the viewport').toBeLessThanOrEqual(layout.viewport.width + 0.5);
        });
    }
});
