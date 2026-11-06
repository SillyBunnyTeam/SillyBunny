import { TITLE_LINE_HEIGHT, TITLE_UNITS_PER_EM, TITLE_WORDS, TITLES } from './github-titles.mjs';
import { rasteriseSvg } from './github-vector.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */

const SPACE = TITLE_WORDS[' '].advance;
/**
 * Where the middle of the capital letters is, in font units from the baseline, y-down. Adwaita Sans ExtraBold draws a capital 1490 units
 * high (the top of the B), so the middle is half of that above the baseline. The S is drawn with the same overshoot above and below, so
 * the middle of its ink is the same number.
 */
export const CAP_CENTRE = -745;

/** The words of a title, which must be the maintainer's own and nothing else. @param {string} key a key of TITLES */
export function titleWords(key) {
    if (!Object.hasOwn(TITLES, key)) {
        throw new Error(`"${key}" is not a section title. The titles are: ${Object.keys(TITLES).join(', ')}.`);
    }
    return TITLES[key].split(' ');
}

/**
 * Breaks a title into lines of whole words. A line takes the next word while it still fits `maxWidth` pixels at the font size; without a
 * `maxWidth` the title is one line. A word wider than `maxWidth` on its own is an error, not a reason to cut the word.
 * @param {string} key a key of TITLES
 * @param {{ size: number, maxWidth?: number }} options font size in pixels, and the widest line in pixels
 * @returns {string[][]} the words of each line
 */
export function breakTitle(key, { size, maxWidth }) {
    const scale = size / TITLE_UNITS_PER_EM;
    const lines = [];
    let widthOfLine = 0;
    for (const word of titleWords(key)) {
        const advance = TITLE_WORDS[word].advance;
        const fits = maxWidth === undefined || lines.length === 0 || widthOfLine + SPACE + advance <= maxWidth / scale;
        if (lines.length > 0 && fits) {
            lines.at(-1).push(word);
            widthOfLine += SPACE + advance;
            continue;
        }
        if (maxWidth !== undefined && advance * scale > maxWidth) {
            throw new Error(`The word "${word}" is ${Math.round(advance * scale)} px wide at the font size ${size}, wider than the ${maxWidth} px a line may have.`);
        }
        lines.push([word]);
        widthOfLine = advance;
    }
    return lines;
}

/** Where each word sits, in font units with the first baseline at 0, and the ink box of the whole title. */
function setTitle(lines) {
    const placed = [];
    let box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    lines.forEach((words, index) => {
        const baseline = index * TITLE_LINE_HEIGHT * TITLE_UNITS_PER_EM;
        let pen = 0;
        for (const word of words) {
            const { advance, ink } = TITLE_WORDS[word];
            placed.push({ word, x: pen, y: baseline });
            box = {
                left: Math.min(box.left, pen + ink.left),
                top: Math.min(box.top, baseline + ink.top),
                right: Math.max(box.right, pen + ink.right),
                bottom: Math.max(box.bottom, baseline + ink.bottom),
            };
            pen += advance + SPACE;
        }
    });
    return { placed, box };
}

/**
 * The pixel size of a title's ink at a font size, so a layout can place it before it is drawn.
 * @param {string} key a key of TITLES
 * @param {{ size: number, maxWidth?: number }} options
 */
export function titleSize(key, options) {
    const { box } = setTitle(breakTitle(key, options));
    const scale = options.size / TITLE_UNITS_PER_EM;
    return { width: Math.round((box.right - box.left) * scale), height: Math.round((box.bottom - box.top) * scale) };
}

/**
 * The distance from the top of a title's ink to the middle of the capitals of its first line, in pixels at a font size. The middle of a
 * capital is half of the cap height above the baseline, which is where the first line sits at 0 in font units.
 * @param {string} key a key of TITLES
 * @param {{ size: number, maxWidth?: number }} options
 */
export function titleCapCentre(key, options) {
    const { box } = setTitle(breakTitle(key, options));
    return ((CAP_CENTRE - box.top) * options.size) / TITLE_UNITS_PER_EM;
}

/**
 * A title as outlines in one flat colour, left aligned, every line starting at the left edge of the ink.
 * @param {{ title: string, size: number, colour: string, maxWidth?: number }} options
 * @returns {Promise<Raster>}
 */
export function drawTitle({ title, size, colour, maxWidth }) {
    const { placed, box } = setTitle(breakTitle(title, { size, maxWidth }));
    const { width, height } = titleSize(title, { size, maxWidth });
    const paths = placed.map(({ word, x, y }) => `<path transform="translate(${x} ${y})" d="${TITLE_WORDS[word].d}"/>`).join('');
    return rasteriseSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${box.left} ${box.top} ${box.right - box.left} ${box.bottom - box.top}"><g fill="${colour}">${paths}</g></svg>`);
}
