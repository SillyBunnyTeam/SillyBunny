import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { dismissOpenDialogIfPresent, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats, pickFixtureCharacters } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { stubTheme } from './helpers/theme-stub.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 45_000;
const RECENT_COUNT = 8;
const PANEL = '#chat > .welcomePanel';
const WALLPAPER_FILE = new URL('../default/content/backgrounds/japan classroom side.jpg', import.meta.url);
const WALLPAPER_ROUTE = '**/__home_contrast_wallpaper.jpg*';

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } }, narrow: false },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, narrow: true },
];

/** The least contrast between a control's edge and the page behind it that reads as an edge. */
const EDGE_FLOOR = 1.24;
const TEXT_FLOOR = 4.5;
/** The least contrast between a line and the fill beside it that a fill alone, with no line, cannot give. */
const LINE_FLOOR = 1.1;
/** In forced colours the edge is the text colour on the canvas colour, so anything near a readable contrast shows it. */
const FORCED_EDGE_FLOOR = 3;
/** Regression floor: the edge contrast of the Home tiles in these themes, as measured before the column had a backing, rounded down, per width. */
const EDGE_BEFORE = {
    Libadwaita: { wide: 1.06, narrow: 1.03 },
    'Celestial Macaron': { wide: 1.44, narrow: 1.43 },
};
/** The tint alpha of the Everforest Dark chat column. */
const EVERFOREST_TINT_ALPHA = 0.05;

async function showWallpaper(page) {
    const body = readFileSync(WALLPAPER_FILE);
    await page.route(WALLPAPER_ROUTE, route => route.fulfill({ body, contentType: 'image/jpeg' }));
    await page.evaluate(async () => {
        const background = document.getElementById('bg1');
        background.style.backgroundImage = 'url("/__home_contrast_wallpaper.jpg")';
        await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = resolve;
            image.onerror = () => reject(new Error('The wallpaper did not load.'));
            image.src = '/__home_contrast_wallpaper.jpg';
        });
    });
}

/** More rows than the list shows collapsed, so Show More is in the page. The first rows open the fixture chats. */
function recentChatEntries(characters) {
    return Array.from({ length: RECENT_COUNT }, (_, index) => ({
        file_name: `${characters[index]?.chat ?? `qa-home-${index}`}.jsonl`,
        avatar: characters[index % characters.length].avatar,
        last_mes: Date.now() - index * 60_000,
        mes: `Preview ${index}`,
        chat_items: 3,
        file_size: '1kb',
    }));
}

async function bootHome(page, theme, { wallpaper = false, tint } = {}) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await stubTheme(page, theme, { tint });
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    const characters = await pickFixtureCharacters(page, 3);
    await page.route('**/api/chats/recent', route => route.fulfill({ json: recentChatEntries(characters) }));
    await page.evaluate(async () => {
        const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
        await openWelcomeScreen({ force: true });
    });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(page.locator(`${PANEL} .recentChat`)).not.toHaveCount(0);
    expect(await page.evaluate(() => window.SillyTavern.getContext().powerUserSettings.theme)).toBe(theme);
    if (wallpaper) {
        await showWallpaper(page);
    }
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
}

/** Resolves any CSS colour, including the `color(srgb ...)` form the browser computes for a mix, to 0-255 channels and a 0-1 alpha. */
async function resolveColor(page, css) {
    return page.evaluate((value) => {
        const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a: a / 255 };
    }, css);
}

const chatBackground = page => page.locator('#chat').evaluate(node => getComputedStyle(node).backgroundColor);

async function chatBackgroundAlpha(page) {
    return (await resolveColor(page, await chatBackground(page))).a;
}

/** The colour a CSS value paints as a background, with its alpha, resolved the way the browser computes it. */
async function paintOf(page, css) {
    return resolveColor(page, await page.evaluate((value) => {
        const probe = document.createElement('div');
        probe.style.background = value;
        document.body.append(probe);
        const { backgroundColor } = getComputedStyle(probe);
        probe.remove();
        return backgroundColor;
    }, css));
}

function over({ r, g, b, a }, below) {
    const mix = (top, bottom) => Math.round(top * a + bottom * (1 - a));
    return { r: mix(r, below.r), g: mix(g, below.g), b: mix(b, below.b) };
}

function luminance({ r, g, b }) {
    const linear = channel => (channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastOf(first, second) {
    const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Decodes a PNG in the page, so the spec needs no image library. Returns a reader of the pixel at a point of the clip. */
async function decodeClip(page, clip) {
    const png = await page.screenshot({ clip, scale: 'css', animations: 'disabled' });
    const flat = await page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, data: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
    }, png.toString('base64'));
    expect(flat.width, 'the screenshot is at CSS pixel scale').toBe(clip.width);
    return (x, y) => {
        const index = ((y - clip.y) * flat.width + (x - clip.x)) * 4;
        return { r: flat.data[index], g: flat.data[index + 1], b: flat.data[index + 2] };
    };
}

/** Median contrast between the top border of an element and the page three pixels above it, along the top edge. */
async function edgeContrast(page, selector) {
    const element = page.locator(`${PANEL} ${selector}`).first();
    await element.evaluate(node => node.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await element.evaluate((node) => {
        const { left, top, width } = node.getBoundingClientRect();
        return { left, top, width };
    });
    const y = Math.round(box.top);
    const left = Math.floor(box.left);
    const pixel = await decodeClip(page, { x: left, y: y - 6, width: Math.ceil(box.width), height: 12 });
    const samples = [0.2, 0.3, 0.4, 0.6, 0.7, 0.8].map((fraction) => {
        const x = Math.round(box.left + box.width * fraction);
        return contrastOf(pixel(x, y), pixel(x, y - 3));
    });
    return median(samples);
}

/** A pixel of the column in the gutter beside the Home content, which nothing else paints over. */
async function columnPixel(page) {
    const box = await page.locator('#chat').evaluate((node) => {
        const { left, top } = node.getBoundingClientRect();
        return { left, top };
    });
    const x = Math.round(box.left) + 4;
    const y = Math.round(box.top) + 400;
    return (await decodeClip(page, { x, y, width: 2, height: 2 }))(x, y);
}

/** How far the column is, in the worst channel, from the tint it paints without Home at the tint's own alpha over the Window layer. */
async function columnGapFromTintOverWindowLayer(page, columnTint) {
    const tint = await paintOf(page, columnTint);
    const windowLayer = await paintOf(page, 'var(--sb-layer-window)');
    return channelGap(await columnPixel(page), over(tint, windowLayer));
}

/** Pixels of the column's left edge at mid-height: the page just outside it, the edge itself and the column just inside. */
async function columnEdgePixels(page) {
    const box = await page.locator('#chat').evaluate((node) => {
        const { left, top, height } = node.getBoundingClientRect();
        return { left, top, height };
    });
    const x = Math.round(box.left);
    const y = Math.round(box.top + box.height / 2);
    const pixel = await decodeClip(page, { x: x - 6, y: y - 1, width: 16, height: 3 });
    return { outside: pixel(x - 4, y), edge: pixel(x, y), inside: pixel(x + 3, y) };
}

/** The colour of the 1px inset line the wide column draws, or null when it draws none. */
async function columnLineColor(page) {
    const shadow = await page.locator('#chat').evaluate(node => getComputedStyle(node).boxShadow);
    const line = /^(.*?)\s+0px 0px 0px 1px inset$/.exec(shadow);
    return line ? resolveColor(page, line[1]) : null;
}

/** The opaque colour that the page shows behind an element's text: its own fill and those of its ancestors up to the column, over the column. */
async function surfaceBehind(page, selector) {
    const fills = await page.locator(`${PANEL} ${selector}`).first().evaluate((node) => {
        const layers = [];
        for (let current = node; current && current.id !== 'chat'; current = current.parentElement) {
            layers.push(getComputedStyle(current).backgroundColor);
        }
        return layers;
    });
    let surface = await columnPixel(page);
    for (const fill of fills.reverse()) {
        surface = over(await resolveColor(page, fill), surface);
    }
    return surface;
}

const channelGap = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

const TARGETS = {
    tile: '.sbHomeTile',
    'assistant card': '.sbHomeCard:not(.sbHomeCard--choose)',
};

for (const { name, options, narrow } of VIEWPORTS) {
    // The wide column keeps the tint alpha scaled to 90%, and the narrow one uses the tint as it is.
    const width = narrow ? 'narrow' : 'wide';
    const tintAlpha = narrow ? EVERFOREST_TINT_ALPHA : EVERFOREST_TINT_ALPHA / 0.9;
    // What the chat column paints without Home: the scaled tint on a wide window, the raw tint on a narrow one.
    const columnTint = narrow ? 'var(--SmartThemeChatTintColor)' : 'var(--sb-chat-view-bg)';

    test.describe(`Home contrast at ${name}`, () => {
        test.use(options);

        test.describe('Everforest Dark without a wallpaper', () => {
            test.beforeEach(async ({ page }) => {
                await bootHome(page, 'Everforest Dark');
            });

            test('the chat column is the theme tint over the Window layer', async ({ page }) => {
                expect(await columnGapFromTintOverWindowLayer(page, columnTint), 'channels off the tint over the Window layer').toBeLessThanOrEqual(2);
            });
        });

        test.describe('Everforest Dark over a bright wallpaper', () => {
            test.beforeEach(async ({ page }) => {
                await bootHome(page, 'Everforest Dark', { wallpaper: true });
            });

            test('the chat column is opaque while Home is shown, whatever the wallpaper', async ({ page }) => {
                expect(await chatBackgroundAlpha(page)).toBe(1);
                expect(await columnGapFromTintOverWindowLayer(page, columnTint), 'channels off the tint over the Window layer').toBeLessThanOrEqual(2);
            });

            test('the backing follows Surface Transparency, so a raised transparency shows the wallpaper again', async ({ page }) => {
                await page.evaluate(() => document.documentElement.style.setProperty('--sb-page-overlay-opacity', '0.58'));

                expect(await chatBackgroundAlpha(page)).toBeCloseTo(0.58, 1);
            });

            test('the chat column returns to the tint of the theme when a chat opens', async ({ page }) => {
                await page.locator(`${PANEL} .recentChatOpen`).first().click();
                await dismissOpenDialogIfPresent(page);
                await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/, { timeout: STARTUP_TIMEOUT });

                expect(Math.abs(await chatBackgroundAlpha(page) - tintAlpha)).toBeLessThan(0.011);
                expect(await page.locator('#chat').evaluate(node => getComputedStyle(node).backgroundImage), 'the plain tint is all that is left').toBe('none');
                expect(await columnLineColor(page), 'the column line is left with Home').toBeNull();
            });

            for (const [label, selector] of Object.entries(TARGETS)) {
                test(`the edge of the ${label} stands out from the page by ${EDGE_FLOOR}:1`, async ({ page }) => {
                    expect(await edgeContrast(page, selector)).toBeGreaterThanOrEqual(EDGE_FLOOR);
                });
            }

            test('the title and the Assistants heading read against the backing', async ({ page }) => {
                const backing = await columnPixel(page);

                for (const selector of ['.sbHomeTitle', '#sb-home-assistants-title']) {
                    const text = await resolveColor(page, await page.locator(`${PANEL} ${selector}`).evaluate(node => getComputedStyle(node).color));
                    expect(contrastOf(text, backing), selector).toBeGreaterThanOrEqual(TEXT_FLOOR);
                }
            });

            test('every line of Home is a quarter of the text colour over the theme border', async ({ page }) => {
                const expected = await paintOf(page, 'color-mix(in srgb, var(--SmartThemeBodyColor) 25%, color-mix(in srgb, var(--sb-shell-border) 72%, transparent))');
                const lines = await page.locator(PANEL).evaluate((panel) => {
                    const first = selector => panel.querySelector(selector);
                    const pseudo = (selector, which, property) => getComputedStyle(first(selector), which)[property];
                    return {
                        'the tile border': getComputedStyle(first('.sbHomeTile')).borderTopColor,
                        'the card border': getComputedStyle(first('.sbHomeCard')).borderTopColor,
                        'the band border': getComputedStyle(first('.sbHomeBand')).borderTopColor,
                        'the Recent Chats border': getComputedStyle(first('.welcomeRecent')).borderTopColor,
                        'the row divider': pseudo('.welcomeRecent .recentChat ~ .recentChat', '::before', 'backgroundColor'),
                        'the Show More rule': getComputedStyle(first('.welcomeRecent .showMoreChats')).borderTopColor,
                        'the separator between counters': pseudo('.welcomeRecent .counterBlock:not(:last-child)', '::after', 'color'),
                    };
                });
                const resolved = await Promise.all(Object.entries(lines).map(async ([label, css]) => [label, await resolveColor(page, css)]));
                const wrong = resolved.filter(([, line]) => JSON.stringify(line) !== JSON.stringify(expected)).map(([label]) => label);

                expect(wrong, 'lines that are not the shared line colour').toEqual([]);
            });

            if (narrow) {
                test('the column fills the window, so it draws no line', async ({ page }) => {
                    expect(await columnLineColor(page)).toBeNull();
                });
            } else {
                test('the column draws a 1px line in the shared line colour, and half of the text colour with prefers-contrast: more', async ({ page }) => {
                    const shared = await paintOf(page, 'color-mix(in srgb, var(--SmartThemeBodyColor) 25%, color-mix(in srgb, var(--sb-shell-border) 72%, transparent))');
                    expect(await columnLineColor(page), 'the column line').toEqual(shared);

                    await page.emulateMedia({ contrast: 'more' });
                    const half = await paintOf(page, 'color-mix(in srgb, var(--SmartThemeBodyColor) 50%, transparent)');
                    expect(await columnLineColor(page), 'the column line with more contrast').toEqual(half);
                });
            }

            test('prefers-contrast: more draws the lines with half of the text colour', async ({ page }) => {
                await page.emulateMedia({ contrast: 'more' });
                const expected = await resolveColor(page, await page.locator(`${PANEL} .sbHomeLayout`).evaluate((layout) => {
                    const probe = document.createElement('div');
                    probe.style.color = 'color-mix(in srgb, var(--SmartThemeBodyColor) 50%, transparent)';
                    layout.append(probe);
                    const { color } = getComputedStyle(probe);
                    probe.remove();
                    return color;
                }));

                for (const selector of ['.sbHomeTile', '.sbHomeCard', '.welcomeRecent']) {
                    const line = await resolveColor(page, await page.locator(`${PANEL} ${selector}`).first().evaluate(node => getComputedStyle(node).borderTopColor));
                    expect(line, selector).toEqual(expected);
                }
            });
        });

        test.describe('Libadwaita Light', () => {
            test.beforeEach(async ({ page }) => {
                await bootHome(page, 'Libadwaita Light');
            });

            for (const [label, selector] of Object.entries(TARGETS)) {
                test(`the edge of the ${label} stands out from the page by ${EDGE_FLOOR}:1`, async ({ page }) => {
                    expect(await edgeContrast(page, selector)).toBeGreaterThanOrEqual(EDGE_FLOOR);
                });
            }

            for (const selector of ['.sbHomeTitle', '#sb-home-assistants-title', '.sbHomeTileTitle', '.sbHomeCardName']) {
                test(`${selector} reads at ${TEXT_FLOOR}:1 on what is behind it`, async ({ page }) => {
                    const text = await resolveColor(page, await page.locator(`${PANEL} ${selector}`).first().evaluate(node => getComputedStyle(node).color));

                    expect(text.a, 'the text is opaque').toBe(1);
                    expect(contrastOf(text, await surfaceBehind(page, selector))).toBeGreaterThanOrEqual(TEXT_FLOOR);
                });
            }
        });

        if (!narrow) {
            for (const theme of ['Everforest Dark', 'Black Orange']) {
                test.describe(`The edge of the Home column in ${theme}`, () => {
                    test.beforeEach(async ({ page }) => {
                        await bootHome(page, theme);
                    });

                    test(`stands out from the page around it by ${EDGE_FLOOR}:1, with its Window layer and with its line`, async ({ page }) => {
                        const { outside, edge, inside } = await columnEdgePixels(page);

                        expect(contrastOf(inside, outside), 'the column against the page').toBeGreaterThanOrEqual(EDGE_FLOOR);
                        expect(contrastOf(edge, outside), 'the line against the page').toBeGreaterThanOrEqual(EDGE_FLOOR);
                    });

                    test('draws a line along its edge that the fill alone does not give', async ({ page }) => {
                        const { outside, edge, inside } = await columnEdgePixels(page);

                        expect(contrastOf(edge, inside), 'the edge pixel against the column').toBeGreaterThanOrEqual(LINE_FLOOR);
                        expect(contrastOf(edge, outside), 'the edge pixel against the page').toBeGreaterThan(contrastOf(inside, outside));
                    });

                    test('draws the line in the shared line colour', async ({ page }) => {
                        const shared = await paintOf(page, 'color-mix(in srgb, var(--SmartThemeBodyColor) 25%, color-mix(in srgb, var(--sb-shell-border) 72%, transparent))');

                        expect(await columnLineColor(page)).toEqual(shared);
                    });
                });
            }

            test.describe('The edge of the Home column in forced colours', () => {
                test.beforeEach(async ({ page }) => {
                    await bootHome(page, 'Everforest Dark');
                    await page.emulateMedia({ forcedColors: 'active' });
                });

                test('is a 1px outline, because forced colours drop the shadow', async ({ page }) => {
                    const column = await page.locator('#chat').evaluate((node) => {
                        const { outlineStyle, outlineWidth, boxShadow } = getComputedStyle(node);
                        return { outlineStyle, outlineWidth, boxShadow };
                    });
                    expect(column).toMatchObject({ outlineStyle: 'solid', outlineWidth: '1px' });

                    const { outside, edge } = await columnEdgePixels(page);
                    expect(contrastOf(edge, outside), 'the edge pixel against the page beside it').toBeGreaterThanOrEqual(FORCED_EDGE_FLOOR);
                });
            });

            test.describe('A light theme whose chat tint is transparent and dark', () => {
                test.beforeEach(async ({ page }) => {
                    await bootHome(page, 'Catppuccin Latte', { tint: 'rgba(23, 23, 23, 0)' });
                });

                test('keeps a light column, because the colour of an unseen tint never becomes a surface', async ({ page }) => {
                    expect(await columnGapFromTintOverWindowLayer(page, columnTint), 'channels off the tint over the Window layer').toBeLessThanOrEqual(2);
                    const windowLayer = await paintOf(page, 'var(--sb-layer-window)');

                    expect(contrastOf(await columnPixel(page), windowLayer), 'the column and the Window layer are the same shade').toBeLessThan(1.05);
                });

                test('keeps the heading as readable as the Window layer makes it', async ({ page }) => {
                    const windowLayer = await paintOf(page, 'var(--sb-layer-window)');
                    const backing = await columnPixel(page);

                    for (const selector of ['.sbHomeTitle', '#sb-home-assistants-title']) {
                        const text = await resolveColor(page, await page.locator(`${PANEL} ${selector}`).evaluate(node => getComputedStyle(node).color));
                        expect(contrastOf(text, backing), selector).toBeGreaterThanOrEqual(contrastOf(text, windowLayer) - 0.05);
                    }
                });
            });
        }

        for (const theme of Object.keys(EDGE_BEFORE)) {
            test.describe(`${theme}`, () => {
                test.beforeEach(async ({ page }) => {
                    await bootHome(page, theme);
                });

                test('the column carries the tint of the theme at its own alpha over the Window layer', async ({ page }) => {
                    expect(await columnGapFromTintOverWindowLayer(page, columnTint), 'channels off the tint over the Window layer').toBeLessThanOrEqual(2);
                });

                for (const [label, selector] of Object.entries(TARGETS)) {
                    test(`the edge of the ${label} stays above the regression floor`, async ({ page }) => {
                        expect(await edgeContrast(page, selector)).toBeGreaterThanOrEqual(EDGE_BEFORE[theme][width]);
                    });
                }
            });
        }
    });
}
