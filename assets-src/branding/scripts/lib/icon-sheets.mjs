import sharp from 'sharp';
import { SAFE_ZONE_DIAMETER } from './icon-render.mjs';
import { LIGHT_BACKGROUND } from './logo-sheet.mjs';
import { SQUIRCLE_EXPONENT, plateOutline } from './plate.mjs';
import { GAP, SHEET_BACKGROUND, enlarge, escapeXml, textSvg } from './plate-sheet.mjs';
import { serialisePath } from './vector-path.mjs';

export const DARK_PAGE = '#242424';
export const ENLARGEMENT = 8;
export const MASK_PREVIEW_SIDE = 256;

const PADDING = 14;
const CAPTION_HEIGHT = 34;
const TITLE_HEIGHT = 34;
// A narrow picture still gets a slot this wide, so its caption does not run into the next one.
const MIN_SLOT_WIDTH = 64;
// Titles are drawn on a strip this wide, so the sheet is never narrower than that or the strip would not fit.
const TITLE_WIDTH = 1400;
const MIN_SHEET_WIDTH = TITLE_WIDTH + GAP * 2;
const GUIDE_COLOUR = '#e8245f';

// Browser tab geometry in CSS pixels. The tab grows when the icon slot is taller than the 16 px favicon slot.
const TAB_WIDTH = 200;
const TAB_HEIGHT = 34;
const TAB_PADDING = 12;
const TAB_TEXT_LEFT = 36;
// iOS draws app icons with corners 22.37% of the side wide.
const IOS_CORNER_SHARE = 0.2237;

const pages = [['light', LIGHT_BACKGROUND], ['dark', DARK_PAGE]];
const isLight = (background) => background === LIGHT_BACKGROUND;

const sideOf = async (png) => (await sharp(png).metadata()).width;

/**
 * A mock browser tab with the icon in it, drawn at `scale` device pixels per CSS pixel. The icon is `iconPixels` device pixels square
 * and is enlarged with nearest-neighbour when its own size differs, so a 16 px icon at 2x shows what a browser would stretch.
 * @param {{ png: Buffer, iconPixels: number, scale: number, background: string }} tab
 */
export async function tabPicture({ png, iconPixels, scale, background }) {
    const slot = iconPixels / scale;
    const height = Math.max(TAB_HEIGHT, slot + 18);
    const light = isLight(background);
    const barFill = light ? '#dee1e6' : '#161616';
    const ink = light ? '#3c4043' : '#e8eaed';
    const middle = height / 2;
    const frame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${TAB_WIDTH * scale}" height="${height * scale}" viewBox="0 0 ${TAB_WIDTH} ${height}" font-family="sans-serif"><rect width="${TAB_WIDTH}" height="${height}" fill="${barFill}"/><path d="M0 ${height} V10 a8 8 0 0 1 8 -8 H${TAB_WIDTH - 8} a8 8 0 0 1 8 8 V${height} Z" fill="${background}"/><text x="${TAB_TEXT_LEFT + Math.max(0, slot - 16)}" y="${middle + 4}" font-size="12" fill="${ink}">SillyBunny</text><text x="${TAB_WIDTH - 22}" y="${middle + 4}" font-size="13" fill="${ink}">&#215;</text></svg>`);
    const side = await sideOf(png);
    const icon = iconPixels === side ? png : await enlarge(png, side, iconPixels / side);
    return {
        input: await sharp(frame).composite([{ input: icon, left: TAB_PADDING * scale, top: Math.round((height * scale - iconPixels) / 2) }]).png().toBuffer(),
        width: TAB_WIDTH * scale,
        height: height * scale,
    };
}

/** One strip of pictures on a page colour, each with a caption under it. Returns the layers placed at (left, top) and the strip's size. */
async function strip(items, background, left, top) {
    const slotOf = (item) => Math.max(item.width, MIN_SLOT_WIDTH);
    const width = items.reduce((total, item) => total + slotOf(item) + GAP, PADDING * 2 - GAP);
    const tallest = Math.max(...items.map(({ height }) => height));
    const height = tallest + PADDING * 2 + CAPTION_HEIGHT;
    const captionColour = isLight(background) ? '#555560' : '#aaaab4';
    const layers = [{ input: await sharp({ create: { width, height, channels: 3, background } }).png().toBuffer(), left, top }];
    let x = left + PADDING;
    for (const { input, width: itemWidth, height: itemHeight, caption } of items) {
        const slot = slotOf({ width: itemWidth });
        layers.push({ input, left: x + Math.round((slot - itemWidth) / 2), top: top + PADDING + Math.round((tallest - itemHeight) / 2) });
        const lines = caption.split('\n').map((line, row) => `<text x="0" y="${15 + row * 15}" font-size="12" fill="${captionColour}">${escapeXml(line)}</text>`).join('');
        layers.push({ input: textSvg(lines, slot, CAPTION_HEIGHT), left: x, top: top + PADDING + tallest + 4 });
        x += slot + GAP;
    }
    return { layers, width, height };
}

/**
 * Stacks titled sections of strips into one sheet.
 * @param {{ title: string, strips: { background: string, items: { input: Buffer, width: number, height: number, caption: string }[] }[] }[]} sections
 */
async function assemble(sections) {
    const layers = [];
    let top = GAP;
    let sheetWidth = MIN_SHEET_WIDTH;
    for (const { title, strips } of sections) {
        layers.push({ input: textSvg(`<text x="4" y="22" font-size="18" fill="#ffffff">${escapeXml(title)}</text>`, TITLE_WIDTH, TITLE_HEIGHT), left: GAP, top });
        top += TITLE_HEIGHT;
        for (const { background, items } of strips) {
            const placed = await strip(items, background, GAP, top);
            layers.push(...placed.layers);
            top += placed.height + GAP / 2;
            sheetWidth = Math.max(sheetWidth, placed.width + GAP * 2);
        }
        top += GAP;
    }
    return sharp({ create: { width: sheetWidth, height: top, channels: 3, background: SHEET_BACKGROUND } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}

/** The icon at its own size, then enlarged 8x with nearest-neighbour. */
async function sizePair(png, label) {
    const side = await sideOf(png);
    return [
        { input: png, width: side, height: side, caption: `${label}\n1x` },
        { input: await enlarge(png, side, ENLARGEMENT), width: side * ENLARGEMENT, height: side * ENLARGEMENT, caption: `${label}\n${ENLARGEMENT}x, nearest` },
    ];
}

async function tabItem(png, iconPixels, scale, background, label) {
    const tab = await tabPicture({ png, iconPixels, scale, background });
    return { ...tab, caption: `${label}\nmock tab, ${scale}x` };
}

/**
 * The area-coverage drafts: each size at 1x and 8x on a light and a dark page, and in a mock browser tab at 1x and 2x. In the tabs the
 * icon keeps its own pixels at 1x and is doubled with nearest-neighbour at 2x.
 * @param {{ size: number, png: Buffer }[]} drafts
 */
export async function draftSheet(drafts) {
    const sections = [];
    for (const { size, png } of drafts) {
        const strips = [];
        for (const [page, background] of pages) {
            strips.push({
                background,
                items: [...await sizePair(png, `${size} px draft, ${page} page`), await tabItem(png, size, 1, background, `${size} px`), await tabItem(png, size * 2, 2, background, `${size} px`)],
            });
        }
        sections.push({ title: `${size} px area-coverage draft: 1x and 8x, then in a tab at 1x and 2x`, strips });
    }
    return assemble(sections);
}

/**
 * The hand-fixed sizes beside their drafts: 8x of each, 1x of each, and the pairing a browser really makes (the 16 px icon in a 1x tab,
 * the 32 px icon in a 2x tab), on a light and a dark page.
 * @param {{ size: number, draft: Buffer, patched: Buffer, edits: number, changed: number }[]} pairs sizes 16 and 32
 */
export async function patchSheet(pairs) {
    const sections = [];
    for (const { size, draft, patched, edits, changed } of pairs) {
        const scale = size / 16;
        const strips = [];
        for (const [page, background] of pages) {
            const items = [];
            for (const [name, png] of [['draft', draft], ['patched', patched]]) {
                items.push({ input: await enlarge(png, size, ENLARGEMENT), width: size * ENLARGEMENT, height: size * ENLARGEMENT, caption: `${name}, ${page} page\n${ENLARGEMENT}x, nearest${name === 'patched' ? `\n${edits} edits, ${changed} px changed` : ''}` });
            }
            for (const [name, png] of [['draft', draft], ['patched', patched]]) {
                items.push({ input: png, width: size, height: size, caption: `${name}\n1x` });
            }
            for (const [name, png] of [['draft', draft], ['patched', patched]]) {
                items.push(await tabItem(png, size, scale, background, `${name}, ${size} px`));
            }
            strips.push({ background, items });
        }
        sections.push({ title: `${size} px: area-coverage draft and the draft with its pixel-fix patch`, strips });
    }
    return assemble(sections);
}

/** The picture cut to a shape (an SVG element drawn in a square of `side`), with transparent corners. */
async function masked(png, side, shape) {
    const resized = await sharp(png).resize(side, side, { kernel: 'lanczos3' }).ensureAlpha().png().toBuffer();
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}">${shape}</svg>`);
    return sharp(resized).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

/**
 * The plate icons and the platform icons as built, then the platform icons under the shapes the platforms cut them to: the maskable icon
 * under a circle and a squircle with its safe circle drawn on a copy, and the apple icons under the iOS rounded square.
 * @param {{ plates: { size: number, png: Buffer }[], apples: { size: number, png: Buffer }[], maskable: Buffer }} icons
 */
export async function sizesSheet({ plates, apples, maskable }) {
    const side = MASK_PREVIEW_SIDE;
    const shown = async ({ size, png }) => {
        const display = Math.min(size, side);
        return { input: display === size ? png : await sharp(png).resize(display, display, { kernel: 'lanczos3' }).png().toBuffer(), width: display, height: display, caption: size > side ? `${size}\nshown at ${side}` : `${size}` };
    };
    const sections = [
        { title: 'Plate icons (img/icon-*): transparent corners, lines from 64 px up', strips: await Promise.all(pages.map(async ([, background]) => ({ background, items: await Promise.all(plates.map(shown)) }))) },
        { title: 'Apple icons (img/apple-icon-*): opaque, plate colour edge to edge', strips: await Promise.all(pages.map(async ([, background]) => ({ background, items: await Promise.all(apples.map(shown)) }))) },
    ];
    const guide = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><circle cx="${side / 2}" cy="${side / 2}" r="${(side * SAFE_ZONE_DIAMETER) / 2}" fill="none" stroke="${GUIDE_COLOUR}" stroke-width="1.5" stroke-dasharray="5 4"/></svg>`);
    const raw = await sharp(maskable).resize(side, side, { kernel: 'lanczos3' }).png().toBuffer();
    const apple = apples.find(({ size }) => size === 512)?.png ?? apples.at(-1).png;
    const items = [
        { input: await sharp(raw).composite([{ input: guide }]).png().toBuffer(), width: side, height: side, caption: 'maskable-512\nsafe circle (central 80%) dashed' },
        { input: await masked(maskable, side, `<circle cx="${side / 2}" cy="${side / 2}" r="${side / 2}"/>`), width: side, height: side, caption: 'maskable under a circle' },
        { input: await masked(maskable, side, `<path d="${serialisePath(plateOutline('square', side))}"/>`), width: side, height: side, caption: `maskable under a squircle (n = ${SQUIRCLE_EXPONENT})` },
        { input: await masked(apple, side, `<rect width="${side}" height="${side}" rx="${side * IOS_CORNER_SHARE}"/>`), width: side, height: side, caption: 'apple-icon-512 under the iOS\nrounded square (corner 22.37%)' },
    ];
    sections.push({ title: 'Platform masks', strips: pages.map(([, background]) => ({ background, items })) });
    return assemble(sections);
}
