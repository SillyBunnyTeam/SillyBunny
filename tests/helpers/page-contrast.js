import { readdirSync, readFileSync } from 'node:fs';
import { expect } from '@playwright/test';

/** DESIGN.md Contrast Rule: text needs 4.5:1; a glyph that carries meaning needs 3:1. */
export const TEXT_CONTRAST = 4.5;
export const GLYPH_CONTRAST = 3;

/**
 * Resolves any CSS colour, including the `color(srgb ...)` form the browser computes for a mix, to 0-255 channels and a 0-1 alpha.
 * @param {import('@playwright/test').Page} page
 * @param {string} css
 * @returns {Promise<{ r: number, g: number, b: number, a: number }>}
 */
export async function resolveColor(page, css) {
    return page.evaluate((value) => {
        const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a: a / 255 };
    }, css);
}

/** A colour with an alpha painted over an opaque one. */
export function over({ r, g, b, a }, below) {
    const mix = (top, bottom) => Math.round(top * a + bottom * (1 - a));
    return { r: mix(r, below.r), g: mix(g, below.g), b: mix(b, below.b) };
}

function luminance({ r, g, b }) {
    const linear = channel => (channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two opaque colours. */
export function contrastOf(first, second) {
    const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Reads the pixels of a clip of the page as it is painted, decoded in the page so the spec needs no image library.
 * @param {import('@playwright/test').Page} page
 * @param {{ x: number, y: number, width: number, height: number }} clip
 * @returns {Promise<(x: number, y: number) => { r: number, g: number, b: number }>} The pixel at a point inside the clip.
 */
export async function decodeClip(page, clip) {
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

const THEMES_DIRECTORY = new URL('../../default/content/themes/', import.meta.url);
/** The dark, the light and every other theme that ships with SillyBunny. */
export const BUNDLED_THEME_NAMES = readdirSync(THEMES_DIRECTORY).filter(file => file.endsWith('.json')).sort()
    .map(file => JSON.parse(readFileSync(new URL(file, THEMES_DIRECTORY), 'utf8')).name);

/**
 * Applies a bundled theme the way the theme select does, and waits until the page has drawn with it.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export async function selectTheme(page, name) {
    await page.evaluate((themeName) => {
        const select = document.getElementById('themes');
        if (![...select.options].some(option => option.value === themeName)) throw new Error(`The theme "${themeName}" is not in the list.`);
        window.$(select).val(themeName).trigger('change');
    }, name);
    expect(await page.evaluate(() => window.SillyTavern.getContext().powerUserSettings.theme)).toBe(name);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * The contrast of the text of a status chip, and of its check when it has one, against what is painted around it. The fill of
 * the chip is a tint, so it is laid over the pixels above and below the chip, which are the row behind it as rendered.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} chip
 * @param {string} where
 * @returns {Promise<{ where: string, part: 'text' | 'check', ratio: number, floor: number }[]>}
 */
export async function readChipContrast(page, chip, where) {
    await chip.scrollIntoViewIfNeeded();
    const look = await chip.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const icon = node.querySelector('i');
        return {
            box: { left: box.left, top: box.top, width: box.width, height: box.height },
            background: style.backgroundColor,
            color: style.color,
            checkColor: icon ? getComputedStyle(icon).color : null,
        };
    });
    const x = Math.round(look.box.left + look.box.width / 2);
    const above = Math.round(look.box.top) - 2;
    const below = Math.round(look.box.top + look.box.height) + 2;
    const pixel = await decodeClip(page, { x: x - 1, y: above - 1, width: 2, height: below - above + 2 });
    const background = await resolveColor(page, look.background);
    const parts = [{ part: 'text', color: await resolveColor(page, look.color), floor: TEXT_CONTRAST }];
    if (look.checkColor) {
        parts.push({ part: 'check', color: await resolveColor(page, look.checkColor), floor: GLYPH_CONTRAST });
    }
    return [pixel(x, above), pixel(x, below)].flatMap((backdrop) => {
        const fill = over(background, backdrop);
        return parts.map(({ part, color, floor }) => ({ where, part, ratio: contrastOf(over(color, fill), fill), floor }));
    });
}

/**
 * The contrast of the text of an element against what is painted behind it, read from the page as drawn: the fill of the
 * element is laid over the pixels just above and just below it, and the text colour over that.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} element
 * @returns {Promise<number>} The lower of the two ratios.
 */
export async function readTextContrast(page, element) {
    await element.scrollIntoViewIfNeeded();
    const look = await element.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { box: { left: box.left, top: box.top, width: box.width, height: box.height }, background: style.backgroundColor, color: style.color };
    });
    const x = Math.round(look.box.left + look.box.width / 2);
    const above = Math.round(look.box.top) - 2;
    const below = Math.round(look.box.top + look.box.height) + 2;
    const pixel = await decodeClip(page, { x: x - 1, y: above - 1, width: 2, height: below - above + 2 });
    const background = await resolveColor(page, look.background);
    const color = await resolveColor(page, look.color);
    return Math.min(...[pixel(x, above), pixel(x, below)].map((backdrop) => {
        const fill = over(background, backdrop);
        return contrastOf(over(color, fill), fill);
    }));
}
