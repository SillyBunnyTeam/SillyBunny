import sharp from 'sharp';

export const FRAME_SIZE = 420;
export const SMALL_SIZES = [64, 48, 32, 16];
export const SMALL_ENLARGEMENT = 4;
export const DRAFT_ENLARGEMENT = 8;
export const LIGHT_BACKGROUND = '#fafafb';
export const DARK_BACKGROUND = '#222226';
export const DOME_COLOUR = '#e8245f';
export const BOX_COLOUR = '#1f8fff';
const GUIDE_COLOUR = '#8a8a96';

const GAP = 24;
const PADDING = 20;
const TITLE_HEIGHT = 34;
const CAPTION_HEIGHT = 40;
const LEGEND_HEIGHT = 30;
const SHEET_BACKGROUND = '#3a3a42';
// Titles and legends are drawn on a strip this wide, so the sheet is never narrower than that or the strip would not fit.
const TEXT_WIDTH = 1200;

const escapeXml = (text) => text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&apos;' })[c]);
const textSvg = (inner, width, height) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif">${inner}</svg>`);

/** The side of a square SVG, from its viewBox. */
export function svgSide(svg) {
    const match = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
    if (!match || match[1] !== match[2]) {
        throw new Error('The SVG needs a square viewBox that starts at 0 0.');
    }
    return Number(match[1]);
}

// Small sizes are drawn at this many pixels first and then reduced, which is how a browser's smoothing reads, and keeps the density valid.
const MIN_RENDER = 128;

/** The SVG drawn crisply at `size` pixels square on a transparent background, as PNG bytes. */
export async function renderSvg(svg, size) {
    const density = (72 * Math.max(size, MIN_RENDER)) / svgSide(svg);
    return sharp(Buffer.from(svg), { density }).resize(size, size, { fit: 'fill' }).png().toBuffer();
}

const enlarge = (bytes, from, factor) => sharp(bytes).resize(from * factor, from * factor, { kernel: 'nearest' }).png().toBuffer();

/**
 * A strip of items on one background, bottom-aligned captions under each. Returns the layers (placed at `left`, `top`) and the strip's size.
 * @param {{ input: Buffer, size: number, caption?: string }[]} items
 */
async function strip(items, background, left, top) {
    const width = items.reduce((total, { size }) => total + size + GAP, PADDING * 2 - GAP);
    const tallest = Math.max(...items.map(({ size, height }) => height ?? size));
    const height = tallest + PADDING * 2 + CAPTION_HEIGHT;
    const captionColour = background === LIGHT_BACKGROUND ? '#555560' : '#aaaab4';
    const layers = [{ input: await sharp({ create: { width, height, channels: 3, background } }).png().toBuffer(), left, top }];
    let x = left + PADDING;
    for (const { input, size, height: itemHeight, caption } of items) {
        layers.push({ input, left: x, top: top + PADDING + Math.round((tallest - (itemHeight ?? size)) / 2) });
        if (caption) {
            const lines = caption.split('\n').map((line, row) => `<text x="0" y="${15 + row * 16}" font-size="13" fill="${captionColour}">${escapeXml(line)}</text>`).join('');
            layers.push({ input: textSvg(lines, Math.max(size, 90), CAPTION_HEIGHT), left: x, top: top + PADDING + tallest + 4 });
        }
        x += size + GAP;
    }
    return { layers, width, height };
}

/** The guides drawn over a frame: its centre lines, and a tick for the dome's centre and one for the bounding box's centre, on both edges. */
function frameOverlay(size, side, domeX, boxX) {
    const scale = size / side;
    const tick = (x, colour, length, thickness) => [0, size - length].map((y) => `<rect x="${(x * scale - thickness / 2).toFixed(2)}" y="${y}" width="${thickness}" height="${length}" fill="${colour}"/>`).join('');
    return textSvg([
        `<rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" fill="none" stroke="${GUIDE_COLOUR}" stroke-width="1"/>`,
        `<line x1="${size / 2}" y1="0" x2="${size / 2}" y2="${size}" stroke="${GUIDE_COLOUR}" stroke-width="1" stroke-dasharray="4 3"/>`,
        `<line x1="0" y1="${size / 2}" x2="${size}" y2="${size / 2}" stroke="${GUIDE_COLOUR}" stroke-width="1" stroke-dasharray="4 3"/>`,
        tick(domeX, DOME_COLOUR, 22, 5),
        tick(boxX, BOX_COLOUR, 14, 2),
    ].join(''), size, size);
}

/** How far a mark is from the frame's axis, in the SVG's own units, as text. */
const offsetText = (x, side) => {
    const offset = Math.round((x - side / 2) * 10) / 10;
    return offset === 0 ? 'on the axis' : `${offset > 0 ? '+' : ''}${offset} ${offset > 0 ? 'right' : 'left'}`;
};

const CROP_ENLARGEMENT = 4;

/** A window of the SVG, in the SVG's own units, drawn 4 times larger than its units (a vector render, then cropped). */
async function renderCrop(svg, box) {
    const side = svgSide(svg);
    const full = await sharp(Buffer.from(svg), { density: 72 * CROP_ENLARGEMENT }).resize(side * CROP_ENLARGEMENT, side * CROP_ENLARGEMENT, { fit: 'fill' }).png().toBuffer();
    return sharp(full).extract({ left: Math.round(box.x * CROP_ENLARGEMENT), top: Math.round(box.y * CROP_ENLARGEMENT), width: box.width * CROP_ENLARGEMENT, height: box.height * CROP_ENLARGEMENT }).png().toBuffer();
}

/**
 * One contact sheet with separate sections, each on a light and a dark strip:
 * 1. the centring: each SVG in a square frame with its centre lines and ticks for the dome's centre and the bounding box's centre;
 * 2. the line shading: the frames of the variants side by side, then a close-up of one line and dot at 4x;
 * 3. small sizes: each SVG at 64, 48, 32 and 16 px at 1x with the same render enlarged 4x (nearest);
 * 4. the pixel drafts at 1x and 8x (nearest), which are starting points for hand work, not the vector.
 * `domeX` and `boxX` are x positions in the SVG's own units; a crop's `box` is in the same units.
 * @param {{ centring: { label: string, svg: string, domeX: number, boxX: number }[], shading: { label: string, svg: string, domeX: number, boxX: number }[], crops: { label: string, svg: string, box: { x: number, y: number, width: number, height: number } }[], small: { label: string, svg: string }[], drafts: { label: string, grid: number, bytes: Buffer }[] }} content
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildLogoSheet({ centring, shading = [], crops = [], small = [], drafts = [] }) {
    if (centring.length === 0) {
        throw new Error('The logo sheet has no frames.');
    }
    const layers = [];
    let top = GAP;
    let sheetWidth = TEXT_WIDTH + GAP * 2;
    const section = (title) => {
        layers.push({ input: textSvg(`<text x="4" y="24" font-size="20" fill="#ffffff">${escapeXml(title)}</text>`, TEXT_WIDTH, TITLE_HEIGHT), left: GAP, top });
        top += TITLE_HEIGHT;
    };
    const place = (placed, width, height) => {
        layers.push(...placed);
        top += height + GAP / 2;
        sheetWidth = Math.max(sheetWidth, width + GAP * 2);
    };
    const note = (inner, height = LEGEND_HEIGHT) => {
        layers.push({ input: textSvg(inner, TEXT_WIDTH, height), left: GAP, top });
        top += height;
    };
    const framed = async (frames, background) => strip(await Promise.all(frames.map(async ({ label, svg, domeX, boxX }) => {
        const side = svgSide(svg);
        return {
            input: await sharp(await renderSvg(svg, FRAME_SIZE)).composite([{ input: frameOverlay(FRAME_SIZE, side, domeX, boxX) }]).png().toBuffer(),
            size: FRAME_SIZE,
            caption: `${label}\ndome ${offsetText(domeX, side)}, box ${offsetText(boxX, side)}`,
        };
    })), background, GAP, top);

    section('Centring: centre lines of each frame, with the dome centre and the bounding box centre marked');
    for (const background of [LIGHT_BACKGROUND, DARK_BACKGROUND]) {
        const { layers: placed, width, height } = await framed(centring, background);
        place(placed, width, height);
    }
    note(`<text x="4" y="20" font-size="14" fill="#ffffff"><tspan fill="${DOME_COLOUR}">&#9632; red tick: centre of the SB dome</tspan>   <tspan fill="${BOX_COLOUR}">&#9632; blue tick: centre of the bounding box</tspan>   <tspan fill="#c0c0ca">dashed: centre of the frame</tspan></text>`);
    top += GAP;

    if (shading.length > 0) {
        section('Line and dot shading, dome-centred: the unshaded logo beside each variant');
        for (const background of [LIGHT_BACKGROUND, DARK_BACKGROUND]) {
            const { layers: placed, width, height } = await framed(shading, background);
            place(placed, width, height);
        }
        top += GAP;
    }
    if (crops.length > 0) {
        section('Close-up of one line and its dot, 4x');
        const rendered = await Promise.all(crops.map(async ({ label, svg, box }) => ({ input: await renderCrop(svg, box), size: Math.max(box.width, box.height) * CROP_ENLARGEMENT, width: box.width * CROP_ENLARGEMENT, height: box.height * CROP_ENLARGEMENT, caption: label })));
        for (const background of [LIGHT_BACKGROUND, DARK_BACKGROUND]) {
            const items = rendered.map(({ input, width, height, caption }) => ({ input, size: width, height, caption }));
            const { layers: placed, width, height } = await strip(items, background, GAP, top);
            place(placed, width, height);
        }
        top += GAP;
    }

    if (small.length > 0) {
        section('Small sizes: 1x, then the same render enlarged 4x with nearest-neighbour');
        for (const { label, svg } of small) {
            note(`<text x="4" y="18" font-size="15" fill="#ffffff">${escapeXml(label)}</text>`, LEGEND_HEIGHT - 6);
            for (const background of [LIGHT_BACKGROUND, DARK_BACKGROUND]) {
                const items = [];
                for (const size of SMALL_SIZES) {
                    const png = await renderSvg(svg, size);
                    items.push({ input: png, size, caption: `${size}` });
                    items.push({ input: await enlarge(png, size, SMALL_ENLARGEMENT), size: size * SMALL_ENLARGEMENT, caption: 'x4' });
                }
                const { layers: placed, width, height } = await strip(items, background, GAP, top);
                place(placed, width, height);
            }
        }
        top += GAP;
    }

    if (drafts.length > 0) {
        section('Pixel drafts (starting points for pixel-fix, not the vector): 1x and 8x, nearest-neighbour');
        for (const background of [LIGHT_BACKGROUND, DARK_BACKGROUND]) {
            const items = [];
            for (const { label, grid, bytes } of drafts) {
                items.push({ input: bytes, size: grid, caption: '1x' });
                items.push({ input: await enlarge(bytes, grid, DRAFT_ENLARGEMENT), size: grid * DRAFT_ENLARGEMENT, caption: `${label} (x8)` });
            }
            const { layers: placed, width, height } = await strip(items, background, GAP, top);
            place(placed, width, height);
        }
    }
    return sharp({ create: { width: sheetWidth, height: top, channels: 3, background: SHEET_BACKGROUND } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
