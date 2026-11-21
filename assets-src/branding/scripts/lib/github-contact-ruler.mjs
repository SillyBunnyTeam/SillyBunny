import sharp from 'sharp';
import { enlarged } from './github-sheets.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */

const GROUND_COLOUR = '#b9c7a6';
const MAJOR = 10;

/**
 * The bottom rows of a scene at `zoom` times, on a flat ground colour, with a ruler in art pixels: a line every 10 columns and rows, each
 * labelled with its number. It is for placing contacts by eye, so the numbers are the ones that the config takes (columns `x0` and `x1`,
 * and `y` the row of art pixels).
 * @param {Raster} art the drawn picture, in art pixels
 * @param {{ rows?: number, zoom?: number }} [options] `rows` is how many of the bottom rows to show
 * @returns {Promise<Buffer>} a PNG
 */
export async function rulerCrop(art, { rows = 150, zoom = 5 } = {}) {
    const top = Math.max(0, art.height - rows);
    const shown = art.height - top;
    const margin = 36;
    const width = art.width * zoom;
    const height = shown * zoom;
    const { input: picture } = await enlarged(art, { zoom, box: { x: 0, y: top, width: art.width, height: shown } });
    const lines = [];
    for (let x = 0; x < art.width; x += MAJOR) {
        lines.push(`<line x1="${margin + x * zoom}" y1="${margin}" x2="${margin + x * zoom}" y2="${margin + height}" stroke="#0007" stroke-width="1"/>`);
        lines.push(`<text x="${margin + x * zoom + 2}" y="${margin - 8}" font-family="sans-serif" font-size="13" fill="#000">${x}</text>`);
    }
    for (let y = Math.ceil(top / MAJOR) * MAJOR; y < art.height; y += MAJOR) {
        const at = margin + (y - top) * zoom;
        lines.push(`<line x1="${margin}" y1="${at}" x2="${margin + width}" y2="${at}" stroke="#0007" stroke-width="1"/>`);
        lines.push(`<text x="2" y="${at + 5}" font-family="sans-serif" font-size="13" fill="#000">${y}</text>`);
    }
    const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + margin}" height="${height + margin}">${lines.join('')}</svg>`;
    return sharp({ create: { width: width + margin, height: height + margin, channels: 3, background: GROUND_COLOUR } })
        .composite([{ input: picture, left: margin, top: margin }, { input: Buffer.from(overlay), left: 0, top: 0 }])
        .png()
        .toBuffer();
}
