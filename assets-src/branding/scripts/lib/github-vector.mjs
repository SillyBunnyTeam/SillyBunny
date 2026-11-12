import sharp from 'sharp';
import { opaqueBox } from './raster.mjs';
import { WORDMARK_INK, WORDMARK_PATH, WORDMARK_UNITS_PER_EM } from './github-wordmark.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */

const ROOT_TAG = /<svg\b([^>]*)>/;
const VIEW_BOX = /\sviewBox="([^"]*)"/;
// Rendering the logo at twice its size finds its edge to half a unit.
const MEASURE_SCALE = 2;

/** Draws an SVG that carries its own pixel size (width and height on the root) as a raster of exactly that size. @param {string} svg */
export async function rasteriseSvg(svg) {
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
}

/** The numbers of the root element's viewBox. @param {string} svg */
function readViewBox(svg) {
    const tag = ROOT_TAG.exec(svg)?.[1] ?? '';
    const match = VIEW_BOX.exec(` ${tag}`);
    const numbers = match ? match[1].trim().split(/[\s,]+/).map(Number) : [];
    if (numbers.length !== 4 || numbers.some((number) => !Number.isFinite(number)) || numbers[2] <= 0 || numbers[3] <= 0) {
        throw new Error('The logo SVG needs a viewBox of four numbers on its root element.');
    }
    return { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
}

/** The same SVG at a pixel size, looking at `view` of its drawing. */
function sized(svg, { width, height }, view) {
    const tag = ROOT_TAG.exec(svg);
    if (!tag) {
        throw new Error('The logo SVG has no root element.');
    }
    const kept = ` ${tag[1]}`.replace(VIEW_BOX, '').replace(/\s(width|height)="[^"]*"/g, '');
    return svg.replace(ROOT_TAG, `<svg${kept} width="${width}" height="${height}" viewBox="${view.x} ${view.y} ${view.width} ${view.height}">`);
}

/** The box that the drawing really covers, in the SVG's own units: its viewBox is mostly empty margin. @param {string} svg */
async function measureInk(svg) {
    const view = readViewBox(svg);
    const probe = await rasteriseSvg(sized(svg, { width: view.width * MEASURE_SCALE, height: view.height * MEASURE_SCALE }, view));
    const box = opaqueBox(probe);
    if (!box) {
        throw new Error('The logo SVG draws nothing.');
    }
    return { x: view.x + box.x / MEASURE_SCALE, y: view.y + box.y / MEASURE_SCALE, width: box.width / MEASURE_SCALE, height: box.height / MEASURE_SCALE };
}

/**
 * The emblem with the empty margin of its drawing cut off, drawn `height` pixels tall. The width follows the drawing.
 * @param {string} svg
 * @param {{ height: number }} size
 * @returns {Promise<Raster>}
 */
export async function drawEmblem(svg, { height }) {
    const ink = await measureInk(svg);
    const width = Math.round((height * ink.width) / ink.height);
    return rasteriseSvg(sized(svg, { width, height }, ink));
}

/**
 * The plate, which is a square drawing with its own rounded corners, drawn `size` pixels wide and tall.
 * @param {string} svg
 * @param {{ size: number }} size
 * @returns {Promise<Raster>}
 */
export function drawPlate(svg, { size }) {
    return rasteriseSvg(sized(svg, { width: size, height: size }, readViewBox(svg)));
}

/** The pixel size of the wordmark at a font size, its ink box and nothing else. @param {number} size font size in pixels */
export function wordmarkSize(size) {
    const scale = size / WORDMARK_UNITS_PER_EM;
    return { width: Math.round((WORDMARK_INK.right - WORDMARK_INK.left) * scale), height: Math.round((WORDMARK_INK.bottom - WORDMARK_INK.top) * scale) };
}

/**
 * The wordmark as outlines, drawn at a font size in one flat colour.
 * @param {{ size: number, colour: string }} options
 * @returns {Promise<Raster>}
 */
export function drawWordmark({ size, colour }) {
    const { width, height } = wordmarkSize(size);
    const view = { x: WORDMARK_INK.left, y: WORDMARK_INK.top, width: WORDMARK_INK.right - WORDMARK_INK.left, height: WORDMARK_INK.bottom - WORDMARK_INK.top };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${view.x} ${view.y} ${view.width} ${view.height}"><path fill="${colour}" d="${WORDMARK_PATH}"/></svg>`;
    return rasteriseSvg(svg);
}

/**
 * Lays a picture with soft edges over the canvas (source over, rounded to whole values), so the same input is the same bytes.
 * Pixels past the canvas edge are dropped.
 * @param {Raster} canvas
 * @param {Raster} layer
 * @param {number} left
 * @param {number} top
 */
export function blendOver(canvas, layer, left, top) {
    for (let y = 0; y < layer.height; y++) {
        for (let x = 0; x < layer.width; x++) {
            const targetX = left + x;
            const targetY = top + y;
            if (targetX < 0 || targetY < 0 || targetX >= canvas.width || targetY >= canvas.height) {
                continue;
            }
            const from = (y * layer.width + x) * 4;
            const alpha = layer.data[from + 3];
            if (alpha === 0) {
                continue;
            }
            const to = (targetY * canvas.width + targetX) * 4;
            const below = canvas.data[to + 3];
            // What shows through the layer: all of the canvas pixel where it is opaque, part of it where it is not.
            const kept = Math.round((below * (255 - alpha)) / 255);
            const total = alpha + kept;
            for (let channel = 0; channel < 3; channel++) {
                canvas.data[to + channel] = Math.round((layer.data[from + channel] * alpha + canvas.data[to + channel] * kept) / total);
            }
            canvas.data[to + 3] = total;
        }
    }
}
