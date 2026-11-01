import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { decodeVariant, variantLines } from './export-run.mjs';
import { crop, upscaleNearest } from './raster.mjs';

const SHEET_BACKGROUND = { r: 58, g: 58, b: 66, alpha: 1 };
// Grey, so the white band of the sticker and a dark outline both show against it.
const BACKDROP = { r: 112, g: 112, b: 120, alpha: 1 };
const DEFAULT_LAYOUT = { labelWidth: 330, gap: 12, zoom: 4, window: 96 };
const FONT_SIZE = 15;
const LINE_HEIGHT = 22;

const escapeXml = (text) => text.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&apos;' })[char]);

function labelSvg(lines, width, height) {
    const text = lines.map((line, index) => `<text x="4" y="${LINE_HEIGHT * (index + 1)}" font-family="sans-serif" font-size="${FONT_SIZE}" fill="#ffffff">${escapeXml(line)}</text>`).join('');
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${text}</svg>`);
}

const toPng = (raster) => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png().toBuffer();

/** A picture on the grey backdrop, so transparency and the sticker's white edge can be judged. */
async function onBackdrop(raster) {
    return sharp({ create: { width: raster.width, height: raster.height, channels: 4, background: BACKDROP } }).composite([{ input: await toPng(raster) }]).png().toBuffer();
}

/**
 * The square window the zoom shows: centred on `focus` (shares of the picture's width and height), kept inside the picture,
 * and no larger than the picture.
 */
export function zoomBox(raster, focus, window) {
    const size = Math.min(window, raster.width, raster.height);
    const clamp = (value, max) => Math.min(Math.max(Math.round(value), 0), max);
    return { x: clamp(focus[0] * raster.width - size / 2, raster.width - size), y: clamp(focus[1] * raster.height - size / 2, raster.height - size), width: size, height: size };
}

/**
 * One picture of rows: the label, the picture at its own pixels (what a browser shows at that density, 1:1), and a nearest-neighbour
 * zoom of a window round the focus.
 * @param {Array<{ lines: string[], raster: import('./raster.mjs').Raster, focus: number[] }>} entries
 * @param {{ labelWidth: number, gap: number, zoom: number, window: number }} [layout]
 */
export async function renderVariantSheet(entries, layout = DEFAULT_LAYOUT) {
    if (entries.length === 0) {
        throw new Error('The sheet has nothing on it.');
    }
    const { labelWidth, gap, zoom, window } = layout;
    const zooms = entries.map(({ raster, focus }) => upscaleNearest(crop(raster, zoomBox(raster, focus, window)), zoom));
    const tileWidth = Math.max(...entries.map(({ raster }) => raster.width));
    const zoomWidth = Math.max(...zooms.map((raster) => raster.width));
    const tileLeft = gap + labelWidth + gap;
    const zoomLeft = tileLeft + tileWidth + gap;

    const layers = [];
    let top = gap;
    for (const [index, { lines, raster }] of entries.entries()) {
        const rowHeight = Math.max(raster.height, zooms[index].height);
        layers.push({ input: labelSvg(lines, labelWidth, rowHeight), left: gap, top });
        layers.push({ input: await onBackdrop(raster), left: tileLeft, top });
        layers.push({ input: await onBackdrop(zooms[index]), left: zoomLeft, top });
        top += rowHeight + gap;
    }
    return sharp({ create: { width: zoomLeft + zoomWidth + gap, height: top, channels: 4, background: SHEET_BACKGROUND } }).composite(layers).png().toBuffer();
}

/**
 * Writes one sheet per character into `outDir`: every variant of every asset of that character, with the real size of its file
 * in the label, the file as the browser decodes it at 1:1, and a 4x zoom of the part of it that holds the face.
 * @param {Awaited<ReturnType<typeof import('./export-run.mjs').exportAssets>>['assets']} assets
 * @param {string} outDir
 * @returns {Promise<string[]>} the paths written
 */
export async function renderExportSheets(assets, outDir) {
    mkdirSync(outDir, { recursive: true });
    const characters = [...new Set(assets.map((asset) => asset.character))];
    const paths = [];
    for (const character of characters) {
        const entries = [];
        for (const asset of assets.filter((candidate) => candidate.character === character)) {
            for (const variant of asset.variants) {
                entries.push({ lines: variantLines(asset, variant), raster: await decodeVariant(variant), focus: asset.focus });
            }
        }
        const path = join(outDir, `${character}-sheet.png`);
        writeFileSync(path, await renderVariantSheet(entries));
        paths.push(path);
    }
    return paths;
}
