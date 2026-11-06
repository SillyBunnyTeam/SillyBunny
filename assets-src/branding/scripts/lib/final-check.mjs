import sharp from 'sharp';
import { DARK_BACKGROUND, LIGHT_BACKGROUND, renderSvg } from './logo-sheet.mjs';
import { GAP, SHEET_BACKGROUND, TITLE_HEIGHT, enlarge, escapeXml, strip, textSvg } from './plate-sheet.mjs';

export const CHECK_SIZE = 512;
export const PLATE_SIZES = [128, 64];
export const FAVICON_SIZES = [48, 32, 16];
export const FAVICON_ENLARGEMENT = 4;

/**
 * The sheet that shows the final logo files as they were written, on a light and a dark page:
 * 1. all four at 512 px;
 * 2. the plate with the emblem and its lines at 128 and 64 px, which is where the lines start to show;
 * 3. the plate with the emblem without lines at 48, 32 and 16 px at 1x, each with a 4x nearest-neighbour copy.
 * @param {{ emblem: string, emblemNolines: string, plate: string, plateNolines: string }} files the SVG text of each file
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildFinalCheck({ emblem, emblemNolines, plate, plateNolines }) {
    const layers = [];
    let top = GAP;
    let sheetWidth = 0;
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
    const pages = [[LIGHT_BACKGROUND, 'light'], [DARK_BACKGROUND, 'dark']];

    section(`The four files at ${CHECK_SIZE} px`);
    for (const [background, page] of pages) {
        place(await strip(await Promise.all([[emblem, 'logo-emblem'], [emblemNolines, 'logo-emblem-nolines'], [plate, 'logo-plate'], [plateNolines, 'logo-plate-nolines']].map(([svg, name]) => tile(svg, CHECK_SIZE, `${name} (${page})`))), background, GAP, top));
    }
    section('logo-plate at 128 and 64 px');
    for (const [background] of pages) {
        place(await strip(await Promise.all(PLATE_SIZES.map((size) => tile(plate, size, `${size} px`))), background, GAP, top));
    }
    section('logo-plate-nolines at 48, 32 and 16 px, each at 1x and with a 4x nearest-neighbour copy');
    for (const [background] of pages) {
        const items = [];
        for (const size of FAVICON_SIZES) {
            const png = await renderSvg(plateNolines, size);
            items.push({ input: png, size, caption: `${size}` }, { input: await enlarge(png, size, FAVICON_ENLARGEMENT), size: size * FAVICON_ENLARGEMENT, caption: `x${FAVICON_ENLARGEMENT}` });
        }
        place(await strip(items, background, GAP, top));
    }
    return sharp({ create: { width: Math.max(sheetWidth, 1400 + GAP * 2), height: top, channels: 3, background: SHEET_BACKGROUND } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
