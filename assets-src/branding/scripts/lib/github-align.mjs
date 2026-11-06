import { CAP_CENTRE, titleCapCentre } from './github-text.mjs';
import { WORDMARK_INK, WORDMARK_UNITS_PER_EM } from './github-wordmark.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */

/** The distance from the top of the wordmark's ink box to the middle of its capital letters, in pixels at a font size. @param {number} size */
export function wordmarkCapCentre(size) {
    return ((CAP_CENTRE - WORDMARK_INK.top) * size) / WORDMARK_UNITS_PER_EM;
}

/** The distance from the top of the wordmark's ink box to its baseline, in pixels at a font size. The baseline is at 0 in the outlines. @param {number} size */
export function wordmarkBaseline(size) {
    return (-WORDMARK_INK.top * size) / WORDMARK_UNITS_PER_EM;
}

/**
 * Where the baseline of the "SB" lettering of approved/logo-plate.svg is, as a share of the plate's height from its top. The lettering is
 * two holes in the body of the emblem (the first two inner contours of its first path), and the flat foot of the B is the baseline: the
 * hole of the B ends at y = 871.4 of the 1024 units of the drawing, and the S overshoots that by one unit, as a rounded letter does.
 * test/github-layouts.test.mjs measures it again from the drawing, so a changed logo is found there.
 */
export const PLATE_LETTERING_BASELINE = 871.4 / 1024;

/**
 * The row of the emblem that a line of text is centred on: the middle of its "SB" lettering, which is drawn as holes in the emblem. A
 * hole is a transparent pixel that the outside cannot reach. The ears are left out on purpose: they are tall and light, and centring
 * the whole drawing puts its weight, the badge, below the text.
 * @param {Raster} emblem
 * @returns {number} a distance in pixels from the top of the picture
 */
export function emblemLetteringCentre(emblem) {
    const { width, height, data } = emblem;
    const isClear = (at) => data[at * 4 + 3] < 128;
    const reached = new Uint8Array(width * height);
    const queue = [];
    const visit = (x, y) => {
        const at = y * width + x;
        if (!reached[at] && isClear(at)) {
            reached[at] = 1;
            queue.push(at);
        }
    };
    for (let x = 0; x < width; x++) {
        visit(x, 0);
        visit(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
        visit(0, y);
        visit(width - 1, y);
    }
    while (queue.length > 0) {
        const at = queue.pop();
        const x = at % width;
        const y = Math.floor(at / width);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height) {
                visit(x + dx, y + dy);
            }
        }
    }
    let first = -1;
    let last = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (isClear(y * width + x) && !reached[y * width + x]) {
                first = first < 0 ? y : first;
                last = y;
            }
        }
    }
    if (first < 0) {
        throw new Error('The emblem has no enclosed lettering, so there is nothing to centre a line of text on.');
    }
    return (first + last + 1) / 2;
}

/**
 * The distance from the top of an element's picture to the line that a `lineY` anchor puts at its y: the middle of the capitals of a
 * wordmark or a title (the baseline of a wordmark whose `line` is "baseline"), the middle of the lettering of the emblem, and the middle of
 * anything else.
 * @param {{ type: string, size?: number, title?: string, maxWidth?: number, line?: string }} element
 * @param {Raster} picture
 */
export function opticalCentreY(element, picture) {
    switch (element.type) {
        case 'wordmark':
            return element.line === 'baseline' ? wordmarkBaseline(element.size) : wordmarkCapCentre(element.size);
        case 'title':
            return titleCapCentre(element.title, { size: element.size, maxWidth: element.maxWidth });
        case 'emblem':
            return emblemLetteringCentre(picture);
        default:
            return picture.height / 2;
    }
}
