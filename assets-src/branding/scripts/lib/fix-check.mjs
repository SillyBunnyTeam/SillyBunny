import sharp from 'sharp';
import { renderSvg, svgSide } from './logo-sheet.mjs';
import { GAP, SHEET_BACKGROUND, TITLE_HEIGHT, escapeXml, textSvg } from './plate-sheet.mjs';

export const WHOLE_SIZE = 512;
// The regions are shown at this many pixels to a pixel of the master.
export const CROP_SCALE = 4;
export const MAX_SHEET_WIDTH = 2400;
const CAPTION_HEIGHT = 24;
// The first look for the letters is at this size, which is enough to tell how big the picture is.
const LOCATE_SIZE = 1024;
// A pixel is the page when every channel is within this much of the lip or the plate colour.
const PAGE_TOLERANCE = 28;

/**
 * Parts of the master that the sheet shows, in the master's pixels. They are chosen to hold the places where the old files had steps and kinks:
 * the two sides of the dome where the lines used to join, the letters, and where the light band meets the dome's top left.
 */
export const REGIONS = [
    { id: 'dome-left', label: 'dome, left side', x: 282, y: 826, width: 84, height: 118 },
    { id: 'dome-right', label: 'dome, right side', x: 660, y: 826, width: 84, height: 118 },
    { id: 's', label: 'the S', x: 366, y: 764, width: 134, height: 184 },
    { id: 'b', label: 'the B', x: 510, y: 764, width: 150, height: 184 },
    { id: 'top-left', label: 'dome, top left', x: 300, y: 728, width: 100, height: 72 },
];

/** The lip colour and the plate colour of a plate file, which are the fills of the first two uses of its outline. */
export function plateFills(svg) {
    const fills = [...svg.matchAll(/<use\b[^>]*\sfill="(#[0-9a-fA-F]{6})"/g)].map(([, fill]) => fill.toLowerCase());
    if (fills.length < 2) {
        throw new Error('The plate has no lip and plate colours to tell the page from the emblem.');
    }
    return { lip: fills[0], plate: fills[1] };
}

const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

/**
 * The box of the pixels that look like the page but are shut in by the emblem: the letters, which show the plate through them. The page
 * is the pixels that are the lip or the plate colour; those that reach the edge of the picture through other page pixels are outside.
 * @param {{ data: Buffer, width: number, height: number, backgrounds: string[] }} picture `data` is RGBA, `backgrounds` are hex colours
 * @returns {{ left: number, top: number, right: number, bottom: number } | undefined} in pixels, `right` and `bottom` one past the last pixel
 */
export function enclosedBox({ data, width, height, backgrounds }) {
    const colours = backgrounds.map(channels);
    const isPage = (at) => data[at * 4 + 3] < 128 || colours.some((colour) => colour.every((value, channel) => Math.abs(value - data[at * 4 + channel]) <= PAGE_TOLERANCE));
    const outside = new Uint8Array(width * height);
    const queue = [];
    const reach = (x, y) => {
        const at = y * width + x;
        if (outside[at] === 0 && isPage(at)) {
            outside[at] = 1;
            queue.push(at);
        }
    };
    for (let x = 0; x < width; x++) {
        reach(x, 0);
        reach(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
        reach(0, y);
        reach(width - 1, y);
    }
    for (let head = 0; head < queue.length; head++) {
        const [x, y] = [queue[head] % width, Math.floor(queue[head] / width)];
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) {
                reach(x + dx, y + dy);
            }
        }
    }
    let [left, top, right, bottom] = [width, height, -1, -1];
    for (let at = 0; at < outside.length; at++) {
        if (outside[at] === 0 && isPage(at)) {
            const [x, y] = [at % width, Math.floor(at / width)];
            [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)];
        }
    }
    return right < 0 ? undefined : { left, top, right: right + 1, bottom: bottom + 1 };
}

async function rawPicture(svg, size) {
    const { data, info } = await sharp(Buffer.from(svg), { density: (72 * size) / svgSide(svg) }).resize(size, size, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}

/**
 * Where the letters are in a plate drawn so that one master pixel is `scale` pixels. The letters are found in a first drawing, which tells
 * how many pixels one master pixel is in this file (the emblem is scaled a little differently on each), and again in a second drawing at the
 * size that gives `scale`, so a region of the master can be cut from the same place in every file.
 * @param {string} svg
 * @param {{ left: number, top: number, right: number, bottom: number }} letters the letters' box in the master, in master pixels
 * @param {number} scale
 * @returns {Promise<{ size: number, perSource: number, origin: { x: number, y: number } }>} `size` is the side to draw the file at
 */
export async function placeLetters(svg, letters, scale) {
    const backgrounds = Object.values(plateFills(svg));
    const locate = async (size) => {
        const picture = await rawPicture(svg, size);
        const box = enclosedBox({ ...picture, backgrounds });
        if (!box) {
            throw new Error('There are no letters shut in by the emblem, so there is nothing to place the regions from.');
        }
        return box;
    };
    const lettersWidth = letters.right - letters.left;
    const first = await locate(LOCATE_SIZE);
    const size = Math.round((LOCATE_SIZE * scale * lettersWidth) / (first.right - first.left));
    const box = await locate(size);
    return { size, perSource: (box.right - box.left) / lettersWidth, origin: { x: box.left, y: box.top } };
}

/** A region of the master in the pixels of a drawing placed by `placeLetters`, kept inside the drawing. */
export function regionPixels({ size, perSource, origin }, letters, { x, y, width, height, label }) {
    const left = Math.max(0, Math.round(origin.x + (x - letters.left) * perSource));
    const top = Math.max(0, Math.round(origin.y + (y - letters.top) * perSource));
    const pixels = { left, top, width: Math.min(size - left, Math.round(width * perSource)), height: Math.min(size - top, Math.round(height * perSource)) };
    if (pixels.width < 1 || pixels.height < 1) {
        throw new Error(`The region "${label ?? `${x},${y}`}" is outside the drawing.`);
    }
    return pixels;
}

/**
 * Positions for groups of tiles: each group stays in one piece, left to right, and a group that would pass `maxWidth` starts a new row.
 * Tiles in a group are top-aligned and each group is as tall as its tallest tile and a caption.
 * @param {{ width: number, height: number }[][]} groups
 * @param {number} maxWidth
 * @param {{ gap: number, caption: number }} spacing
 * @returns {{ positions: { left: number, top: number }[][], width: number, height: number }}
 */
export function flowGroups(groups, maxWidth, { gap, caption }) {
    const positions = [];
    let [rowTop, rowHeight, cursor, widest] = [0, 0, 0, 0];
    for (const group of groups) {
        const groupWidth = group.reduce((total, { width }) => total + width, gap * (group.length - 1));
        const groupHeight = Math.max(...group.map(({ height }) => height)) + caption;
        if (cursor > 0 && cursor + gap + groupWidth > maxWidth) {
            [rowTop, rowHeight, cursor] = [rowTop + rowHeight + gap, 0, 0];
        }
        const left = cursor === 0 ? 0 : cursor + gap;
        let x = left;
        positions.push(group.map(({ width }) => {
            const position = { left: x, top: rowTop };
            x += width + gap;
            return position;
        }));
        cursor = left + groupWidth;
        widest = Math.max(widest, cursor);
        rowHeight = Math.max(rowHeight, groupHeight);
    }
    return { positions, width: widest, height: rowTop + rowHeight };
}

const caption = (text, width) => textSvg(`<text x="0" y="16" font-size="13" fill="#e6e6ee">${escapeXml(text)}</text>`, Math.max(width, 160), CAPTION_HEIGHT);

/**
 * The sheet for checking a redraw against the files it replaces. For each plate: the old file beside the new one at `wholeSize` px, then
 * each region of the master cut from both at `scale` pixels to a master pixel, old beside new.
 * @param {{ letters: { left: number, top: number, right: number, bottom: number }, plates: { label: string, oldSvg: string, newSvg: string }[], regions?: typeof REGIONS, wholeSize?: number, scale?: number, maxWidth?: number }} request
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildFixSheet({ letters, plates, regions = REGIONS, wholeSize = WHOLE_SIZE, scale = CROP_SCALE, maxWidth = MAX_SHEET_WIDTH }) {
    if (plates.length === 0) {
        throw new Error('The sheet has no plates to compare.');
    }
    const layers = [];
    const titles = [];
    let top = GAP;
    let sheetWidth = 0;
    for (const { label, oldSvg, newSvg } of plates) {
        titles.push({ text: `${label}: old (left) and new (right)`, top });
        top += TITLE_HEIGHT;
        const placed = {};
        for (const [which, svg] of [['old', oldSvg], ['new', newSvg]]) {
            try {
                placed[which] = await placeLetters(svg, letters, scale);
            } catch (error) {
                throw new Error(`${label}, ${which}: ${error.message}`);
            }
        }
        const groups = [[
            { input: await renderSvg(oldSvg, wholeSize), width: wholeSize, height: wholeSize, text: `old, ${wholeSize} px` },
            { input: await renderSvg(newSvg, wholeSize), width: wholeSize, height: wholeSize, text: `new, ${wholeSize} px` },
        ]];
        const drawings = { old: await sharp(Buffer.from(oldSvg), { density: (72 * placed.old.size) / svgSide(oldSvg) }).resize(placed.old.size, placed.old.size, { fit: 'fill' }).png().toBuffer(), new: await sharp(Buffer.from(newSvg), { density: (72 * placed.new.size) / svgSide(newSvg) }).resize(placed.new.size, placed.new.size, { fit: 'fill' }).png().toBuffer() };
        for (const region of regions) {
            const pair = [];
            for (const which of ['old', 'new']) {
                const pixels = regionPixels(placed[which], letters, region);
                pair.push({ input: await sharp(drawings[which]).extract(pixels).png().toBuffer(), width: pixels.width, height: pixels.height, text: `${which}: ${region.label}, ${scale}x` });
            }
            groups.push(pair);
        }
        const { positions, width, height } = flowGroups(groups, maxWidth, { gap: GAP, caption: CAPTION_HEIGHT });
        groups.forEach((group, at) => group.forEach((tile, index) => {
            const { left, top: tileTop } = positions[at][index];
            layers.push({ input: tile.input, left: GAP + left, top: top + tileTop });
            layers.push({ input: caption(tile.text, tile.width), left: GAP + left, top: top + tileTop + tile.height + 4 });
        }));
        top += height + GAP * 2;
        sheetWidth = Math.max(sheetWidth, width + GAP * 2);
    }
    // The titles are as wide as the sheet, which is only known now.
    for (const { text, top: titleTop } of titles) {
        layers.push({ input: textSvg(`<text x="4" y="21" font-size="18" fill="#ffffff">${escapeXml(text)}</text>`, sheetWidth - GAP * 2, TITLE_HEIGHT), left: GAP, top: titleTop });
    }
    return sharp({ create: { width: sheetWidth, height: top, channels: 3, background: SHEET_BACKGROUND } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
