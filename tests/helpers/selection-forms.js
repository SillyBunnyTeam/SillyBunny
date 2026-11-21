import { expect } from '@playwright/test';
import { contrastOf, decodeClip, over } from './page-contrast.js';

/**
 * Reads a computed colour exactly. A canvas round trip premultiplies by alpha and loses the channels of a colour that is
 * mostly transparent, which is what a tint of the body colour is.
 * @param {string} value `rgb()`, `rgba()` or `color(srgb ...)` as a computed style returns it.
 * @returns {{ r: number, g: number, b: number, a: number }} Channels 0-255 and alpha 0-1.
 */
export function parseComputedColor(value) {
    const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
    if (rgb) {
        const [r, g, b, a = 1] = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return { r, g, b, a };
    }
    const oklab = /^oklab\(([^)]+)\)$/.exec(value);
    if (oklab) {
        // A colour in the middle of a transition is interpolated in Oklab.
        const [lightness, a, b, alpha = 1] = oklab[1].split(/[\s/]+/).filter(Boolean).map(Number);
        const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
        const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
        const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
        const linear = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
        const [r, g, bl] = linear.map(channel => 255 * (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055));
        return { r, g, b: bl, a: alpha };
    }
    const srgb = /^color\(srgb ([^)]+)\)$/.exec(value);
    if (!srgb) throw new Error(`Not a colour the spec can read: ${value}`);
    const [r, g, b, a = 1] = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
    return { r: r * 255, g: g * 255, b: b * 255, a };
}

/** The two bundled tones the selection forms are checked in. */
export const SELECTION_TONES = Object.freeze([
    { tone: 'dark', theme: 'Libadwaita Dark' },
    { tone: 'light', theme: 'Libadwaita Light' },
]);

/**
 * The rendered outline of an unchecked selection check against the row fill around it. The fill is read from the pixels just
 * above and below the check as painted, the outline colour from the computed border laid over them.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} check
 * @returns {Promise<{ border: { r: number, g: number, b: number, a: number }, ratio: number, size: { width: number, height: number } }>}
 */
export async function readSelectionCheckOutline(page, check) {
    await check.scrollIntoViewIfNeeded();
    const look = await check.evaluate(async (node) => {
        await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {})));
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { box: { left: box.left, top: box.top, width: box.width, height: box.height }, border: style.borderTopColor };
    });
    const x = Math.round(look.box.left + look.box.width / 2);
    const above = Math.round(look.box.top) - 3;
    const below = Math.round(look.box.top + look.box.height) + 3;
    const pixel = await decodeClip(page, { x: x - 1, y: above - 1, width: 2, height: below - above + 2 });
    const border = parseComputedColor(look.border);
    const ratio = Math.min(...[pixel(x, above), pixel(x, below)].map(fill => contrastOf(over(border, fill), fill)));
    return { border, ratio, size: { width: look.box.width, height: look.box.height } };
}

/**
 * What a toggle group (AdwToggleGroup) draws: a tray of the raised fill with 3px of padding, the selected toggle raised and
 * lighter with its label in the body colour, a toggle radius of the tray's less its padding, and a floor on the toggle's height.
 * Run inside a spec with the tone to check set; `contrast: 'more'` adds the rings.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} group
 * @param {{ tone: 'dark' | 'light', floor: number, more?: boolean }} options
 */
export async function expectToggleGroupForm(page, group, { tone, floor, more = false }) {
    const probe = await page.evaluate(() => {
        const element = document.createElement('span');
        element.style.cssText = 'position: absolute; background-color: var(--sb-toggle-raised-bg); box-shadow: var(--sb-toggle-raised-shadow); border-radius: var(--sb-radius-control)';
        const tray = document.createElement('span');
        tray.style.cssText = 'position: absolute; background-color: var(--sb-raised-bg)';
        document.body.append(element, tray);
        const style = getComputedStyle(element);
        const read = { fill: style.backgroundColor, shadow: style.boxShadow, radius: style.borderTopLeftRadius, tray: getComputedStyle(tray).backgroundColor };
        element.remove();
        tray.remove();
        return read;
    });
    const raisedFill = parseComputedColor(probe.fill);
    expect([raisedFill.r, raisedFill.g, raisedFill.b].map(Math.round).concat(+raisedFill.a.toFixed(2)), 'the selected toggle: white at 20% on the dark tone, white on the light').toEqual(tone === 'dark' ? [255, 255, 255, 0.2] : [255, 255, 255, 1]);
    expect(probe.shadow).toContain('rgba(0, 0, 6, 0.07) 0px 1px 3px 1px');
    expect(probe.shadow).toContain('rgba(0, 0, 6, 0.03) 0px 2px 6px 2px');
    if (more) expect(probe.shadow, 'the ring is part of the raised shadow').toContain('inset');

    // A theme or contrast change transitions the fills, so the reading waits for the group to settle.
    await group.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
    const form = await group.evaluate((node) => {
        const read = (element, properties) => Object.fromEntries(properties.map(property => [property, getComputedStyle(element)[property]]));
        return {
            tray: read(node, ['paddingTop', 'paddingLeft', 'borderTopWidth', 'borderTopLeftRadius', 'backgroundColor', 'outlineStyle', 'outlineWidth', 'outlineOffset']),
            toggles: [...node.querySelectorAll('.sb-boolean-radio-option')].map((option) => {
                const span = option.querySelector(':scope > span');
                return {
                    text: span.textContent.trim(),
                    checked: option.querySelector(':scope > input').checked,
                    height: span.getBoundingClientRect().height,
                    ...read(span, ['backgroundColor', 'color', 'fontWeight', 'boxShadow', 'borderTopLeftRadius', 'borderTopWidth']),
                };
            }),
        };
    });
    const body = await readBodyColor(page);
    expect(form.tray.paddingTop).toBe('3px');
    expect(form.tray.paddingLeft).toBe('3px');
    expect(form.tray.borderTopWidth).toBe('0px');
    expect(form.tray.borderTopLeftRadius).toBe(probe.radius);
    expect(form.tray.backgroundColor).toBe(probe.tray);
    expect(form.toggles.filter(toggle => toggle.checked)).toHaveLength(1);
    for (const toggle of form.toggles) {
        const label = parseComputedColor(toggle.color);
        expect([label.r, label.g, label.b, label.a].map(Math.round), `${toggle.text}: the label is in the body colour`).toEqual([body.r, body.g, body.b, 1].map(Math.round));
        expect(toggle.fontWeight, `${toggle.text} is bold`).toBe('700');
        expect(toggle.borderTopLeftRadius, `${toggle.text} has the tray's radius less its padding`).toBe(`${parseFloat(probe.radius) - 3}px`);
        expect(toggle.borderTopWidth).toBe('0px');
        expect(toggle.height, `${toggle.text} is at least ${floor}px tall`).toBeGreaterThanOrEqual(floor);
        if (toggle.checked) {
            expect(toggle.backgroundColor, `${toggle.text} is raised`).toBe(probe.fill);
            expect(toggle.boxShadow).toBe(probe.shadow);
        } else {
            expect(toggle.backgroundColor, `${toggle.text} is flat`).toBe('rgba(0, 0, 0, 0)');
            expect(toggle.boxShadow).toBe('none');
        }
    }
    if (more) {
        expect(form.tray.outlineStyle).toBe('solid');
        expect(form.tray.outlineWidth).toBe('1px');
    }
}

/** The body colour of the page as 0-255 channels. */
export async function readBodyColor(page) {
    return parseComputedColor(await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--SmartThemeBodyColor)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
    }));
}
