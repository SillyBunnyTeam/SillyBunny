import { expect } from '@playwright/test';

/** What `srcset` offers for the logo of the Home header: its box in CSS pixels, and each file with the least screen scale that takes it. */
export const HOME_LOGO = { size: 32, files: [[1, 'logo-32.png'], [2, 'logo-64.png'], [3, 'logo.svg']] };
/** The same for the logo of the About window. */
export const ABOUT_LOGO = { size: 64, files: [[1, 'logo-64.png'], [2, 'logo.svg']] };

/**
 * The file that a screen of this scale takes: the first one made for that scale or a larger one, else the last, which is the vector.
 * @param {[number, string][]} files
 * @param {number} ratio The device pixel ratio.
 */
export function logoFileFor(files, ratio) {
    return (files.find(([scale]) => scale >= ratio) ?? files.at(-1))[1];
}

/**
 * The logo is a real picture that is decoration only: loaded, at its box, named by nothing, hidden from assistive technology,
 * and the file that the screen scale calls for.
 * @param {import('@playwright/test').Locator} image
 * @param {{ size: number, files: [number, string][] }} logo
 */
export async function expectRealLogo(image, { size, files }) {
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', '');
    await expect(image).toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth), 'the picture loaded').toBeGreaterThan(0);
    const read = await image.evaluate(node => ({ box: [node.offsetWidth, node.offsetHeight], source: node.currentSrc, ratio: window.devicePixelRatio }));
    expect(read.box, 'the box, which the layout size gives without the scale of an opening window').toEqual([size, size]);
    expect(new URL(read.source).pathname, `the file at a scale of ${read.ratio}`).toBe(`/img/sillybunny/${logoFileFor(files, read.ratio)}`);
}
