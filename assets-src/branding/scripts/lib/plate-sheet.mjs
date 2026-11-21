import sharp from 'sharp';
import { DARK_BACKGROUND, LIGHT_BACKGROUND, renderSvg } from './logo-sheet.mjs';

export const TILE_SIZE = 360;
export const SMALL_SIZES = [64, 32];
export const SMALL_ENLARGEMENT = 4;

export const GAP = 16;
const PADDING = 14;
const CAPTION_HEIGHT = 30;
export const TITLE_HEIGHT = 30;
export const SHEET_BACKGROUND = '#3a3a42';
const MIN_WIDTH = 1440;

export const escapeXml = (text) => text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&apos;' })[c]);
export const textSvg = (inner, width, height) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif">${inner}</svg>`);
export const enlarge = (bytes, from, factor) => sharp(bytes).resize(from * factor, from * factor, { kernel: 'nearest' }).png().toBuffer();

/** One strip on a page colour: items side by side, each with a one line caption underneath. */
export async function strip(items, background, left, top) {
    const width = items.reduce((total, { size }) => total + size + GAP, PADDING * 2 - GAP);
    const tallest = Math.max(...items.map(({ size }) => size));
    const height = tallest + PADDING * 2 + CAPTION_HEIGHT;
    const captionColour = background === LIGHT_BACKGROUND ? '#555560' : '#aaaab4';
    const layers = [{ input: await sharp({ create: { width, height, channels: 3, background } }).png().toBuffer(), left, top }];
    let x = left + PADDING;
    for (const { input, size, caption } of items) {
        layers.push({ input, left: x, top: top + PADDING + Math.round((tallest - size) / 2) });
        layers.push({ input: textSvg(`<text x="0" y="15" font-size="13" fill="${captionColour}">${escapeXml(caption)}</text>`, Math.max(size, 120), CAPTION_HEIGHT), left: x, top: top + PADDING + tallest + 4 });
        x += size + GAP;
    }
    return { layers, width, height };
}

/**
 * One contact sheet for the plate options:
 * 1. at the top, the emblem with no plate on a light and a dark page, next to the numbers (`notes`);
 * 2. each plate with the emblem and its lines, then without them, at 360 px, on a light page and then a dark one;
 * 3. each plate with the emblem without lines at 64 and 32 px at 1x, with a 4x nearest-neighbour copy of each, on both pages.
 * @param {{ reference: string, plates: { id: string, label: string, withLines: string, withoutLines: string }[], notes: string[] }} content `reference` and the plate pictures are SVG text
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildPlateSheet({ reference, plates, notes }) {
    if (plates.length === 0) {
        throw new Error('The plate sheet has no plates.');
    }
    const layers = [];
    let top = GAP;
    let sheetWidth = MIN_WIDTH;
    const section = (title) => {
        layers.push({ input: textSvg(`<text x="4" y="21" font-size="18" fill="#ffffff">${escapeXml(title)}</text>`, 1400, TITLE_HEIGHT), left: GAP, top });
        top += TITLE_HEIGHT;
    };
    const place = ({ layers: placed, width, height }) => {
        layers.push(...placed);
        top += height + GAP / 2;
        sheetWidth = Math.max(sheetWidth, width + GAP * 2);
    };
    const tile = async (svg, size, caption) => ({ input: await renderSvg(svg, size), size, caption });

    section('Reference: the emblem with clean line geometry and shading B, no plate');
    const referenceStrips = await Promise.all([LIGHT_BACKGROUND, DARK_BACKGROUND].map(async (background) => strip([await tile(reference, TILE_SIZE, background === LIGHT_BACKGROUND ? 'light page' : 'dark page')], background, 0, 0)));
    const referenceTop = top;
    let referenceLeft = GAP;
    for (const { layers: placed, width, height } of referenceStrips) {
        layers.push(...placed.map((layer) => ({ ...layer, left: layer.left + referenceLeft, top: layer.top + referenceTop })));
        referenceLeft += width + GAP;
        top = Math.max(top, referenceTop + height + GAP / 2);
    }
    const noteHeight = notes.length * 20 + 10;
    layers.push({ input: textSvg(notes.map((line, row) => `<text x="0" y="${16 + row * 20}" font-size="14" fill="#e6e6ee">${escapeXml(line)}</text>`).join(''), 1000, noteHeight), left: referenceLeft, top: referenceTop + PADDING });
    sheetWidth = Math.max(sheetWidth, referenceLeft + 1000 + GAP);

    for (const [background, page] of [[LIGHT_BACKGROUND, 'light'], [DARK_BACKGROUND, 'dark']]) {
        section(`Plates on a ${page} page, at ${TILE_SIZE} px: with the lines, then without`);
        for (const [key, name] of [['withLines', 'with lines'], ['withoutLines', 'no lines']]) {
            place(await strip(await Promise.all(plates.map(({ label, ...svgs }) => tile(svgs[key], TILE_SIZE, `${label}, ${name}`))), background, GAP, top));
        }
    }

    section('Small sizes, no lines: 64 and 32 px at 1x, each with a 4x nearest-neighbour copy');
    for (const [background, page] of [[LIGHT_BACKGROUND, 'light'], [DARK_BACKGROUND, 'dark']]) {
        const items = [];
        for (const { label, withoutLines } of plates) {
            for (const size of SMALL_SIZES) {
                const png = await renderSvg(withoutLines, size);
                items.push({ input: png, size, caption: `${label} ${size}` });
                items.push({ input: await enlarge(png, size, SMALL_ENLARGEMENT), size: size * SMALL_ENLARGEMENT, caption: `x${SMALL_ENLARGEMENT} (${page})` });
            }
        }
        place(await strip(items, background, GAP, top));
    }
    return sharp({ create: { width: sheetWidth, height: top, channels: 3, background: SHEET_BACKGROUND } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
