import sharp from 'sharp';
import { createRaster, crop, opaqueBox } from './raster.mjs';

// The card is stored as 8 bit RGB, losslessly. Adaptive filtering picks the best PNG filter for each row, which suits a smooth gradient with a sprite on it, where the default filter compresses badly. Do not raise
// `effort`: from 10 up sharp turns on palette quantisation, which changes pixels, so `palette` is set to false to keep it off.
const CARD_PNG = { compressionLevel: 9, adaptiveFiltering: true, palette: false };
const rawInput = ({ width, height }, channels) => ({ raw: { width, height, channels } });

/**
 * How much of a row's solid pixels are the colours of the sticker: the rim colour (within `rimTolerance`, a distance in RGB) or white.
 * A row of the picture's art scores near 0, the rim and the white band score near 1, and a row that has no solid pixel is `undefined`.
 */
function stickerShareOfRow(raster, row, box, { solidAlpha, sticker }) {
    let solid = 0;
    let stickerColoured = 0;
    for (let x = box.x; x < box.x + box.width; x++) {
        const at = (row * raster.width + x) * 4;
        if (raster.data[at + 3] < solidAlpha) {
            continue;
        }
        solid++;
        const [r, g, b] = [raster.data[at], raster.data[at + 1], raster.data[at + 2]];
        const isRim = Math.hypot(r - sticker.rim[0], g - sticker.rim[1], b - sticker.rim[2]) <= sticker.rimTolerance;
        if (isRim || Math.min(r, g, b) >= sticker.whiteFloor) {
            stickerColoured++;
        }
    }
    return solid === 0 ? undefined : stickerColoured / solid;
}

/**
 * Cuts the sprite for the card. The sprite is a waist-up picture whose sticker (a white band and a rim) runs round the whole outline, so along
 * the waist cut there is a white and a lavender line. This trims the picture to its visible box, then walks up from the bottom to the first row
 * that is not the sticker (most of its solid pixels are not rim or white), which is the last row of art, and cuts `inset` rows above that
 * too, so no blended pixel of the band is left. The sticker still runs up the sides, and ends flush with the cut.
 * @param {import('./raster.mjs').Raster} raster
 * @param {ReturnType<import('./card-config.mjs').parseCardConfig>['sprite']} options
 * @returns {{ sprite: import('./raster.mjs').Raster, box: { x: number, y: number, width: number, height: number }, cut: { visibleBottom: number, lastArtRow: number, stickerRows: number, lastKeptRow: number } }}
 */
export function trimSprite(raster, options) {
    const { alphaThreshold, sticker } = options;
    const visible = opaqueBox(raster, alphaThreshold);
    if (!visible) {
        throw new Error(`The card art has no pixel with alpha ${alphaThreshold} or more, so there is nothing to put on the card.`);
    }
    const visibleBottom = visible.y + visible.height - 1;
    let lastArtRow = visibleBottom;
    while (lastArtRow >= visible.y) {
        const share = stickerShareOfRow(raster, lastArtRow, visible, options);
        if (share !== undefined && share < sticker.rowShare) {
            break;
        }
        lastArtRow--;
    }
    if (lastArtRow < visible.y) {
        throw new Error('Every row of the card art looks like the sticker (rim or white), so the waist cut cannot be found. Check --art, or the sticker colours in card-config.json.');
    }
    const stickerRows = visibleBottom - lastArtRow;
    if (stickerRows > sticker.maxRows) {
        throw new Error(`${stickerRows} rows at the bottom of the card art look like the sticker, more than the ${sticker.maxRows} that sprite.sticker.maxRows allows, so a white or lavender part of the art may have been taken for it. Check the picture, or raise maxRows.`);
    }
    const lastKeptRow = lastArtRow - sticker.inset;
    if (lastKeptRow <= visible.y) {
        throw new Error('Nothing is left of the card art above the waist cut.');
    }
    const cut = crop(raster, { x: visible.x, y: visible.y, width: visible.width, height: lastKeptRow - visible.y + 1 });
    const tight = opaqueBox(cut, alphaThreshold);
    return { sprite: crop(cut, tight), box: { x: visible.x + tight.x, y: visible.y + tight.y, width: tight.width, height: tight.height }, cut: { visibleBottom, lastArtRow, stickerRows, lastKeptRow } };
}

/**
 * Where the sprite goes on the card: the largest size that keeps the whole sprite (ear tips and sides included) inside the canvas,
 * `sideMargin` from each side and `topMargin` from the top, centred, with its last row on the last row of the canvas.
 * @param {{ width: number, height: number }} sprite
 * @param {{ width: number, height: number }} canvas
 * @param {{ sideMargin: number, topMargin: number }} margins
 */
export function placeSprite(sprite, canvas, { sideMargin, topMargin }) {
    const scale = Math.min((canvas.width - 2 * sideMargin) / sprite.width, (canvas.height - topMargin) / sprite.height);
    const width = Math.min(canvas.width, Math.max(1, Math.round(sprite.width * scale)));
    const height = Math.min(canvas.height, Math.max(1, Math.round(sprite.height * scale)));
    return { scale, width, height, left: Math.round((canvas.width - width) / 2), top: canvas.height - height };
}

/** The vertical gradient as RGB bytes, `top` on the first row and `bottom` on the last, each channel rounded. */
export function gradientBackground({ width, height }, { top, bottom }) {
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
        const t = height === 1 ? 0 : y / (height - 1);
        const rgb = top.map((channel, index) => Math.round(channel + (bottom[index] - channel) * t));
        for (let x = 0; x < width; x++) {
            data.set(rgb, (y * width + x) * 3);
        }
    }
    return data;
}

/**
 * Draws the card: the sprite, scaled with Lanczos (the pictures are freely resized avatars, so nothing is snapped to a grid), over the
 * gradient. The result has no alpha channel, so it is opaque by construction.
 * @param {import('./raster.mjs').Raster} sprite
 * @param {{ canvas: { width: number, height: number }, background: { top: number[], bottom: number[] } }} look
 * @param {ReturnType<typeof placeSprite>} placement
 * @returns {Promise<{ rgb: Buffer, png: Buffer }>}
 */
export async function renderCard(sprite, { canvas, background }, placement) {
    const scaled = await sharp(sprite.data, rawInput(sprite, 4))
        .resize(placement.width, placement.height, { kernel: 'lanczos3', fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer();
    const rgb = await sharp(gradientBackground(canvas, background), rawInput(canvas, 3))
        .composite([{ input: scaled, ...rawInput(placement, 4), left: placement.left, top: placement.top }])
        .removeAlpha()
        .raw()
        .toBuffer();
    const png = await sharp(rgb, rawInput(canvas, 3)).png(CARD_PNG).toBuffer();
    return { rgb, png };
}

/**
 * The square of the card a chat avatar shows. The app draws an avatar with `object-fit: cover; object-position: center` (public/style.css, `.avatar img`)
 * in a square box, so it shows the full width of the card and the band of that height from the vertical middle; this is that band.
 */
export function coverBox(canvas) {
    const side = Math.min(canvas.width, canvas.height);
    return { x: Math.floor((canvas.width - side) / 2), y: Math.floor((canvas.height - side) / 2), width: side, height: side };
}

/** A square picture with every pixel outside the inscribed circle made transparent, the edge covered by its share of the pixel. */
export function circleMask(raster) {
    const out = createRaster(raster.width, raster.height);
    const radius = raster.width / 2;
    for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
            const at = (y * raster.width + x) * 4;
            const coverage = Math.min(1, Math.max(0, radius - Math.hypot(x + 0.5 - radius, y + 0.5 - radius) + 0.5));
            out.data.set(raster.data.subarray(at, at + 3), at);
            out.data[at + 3] = Math.round(raster.data[at + 3] * coverage);
        }
    }
    return out;
}

/**
 * The avatar crops of a card at each size, square and in a circle, as PNG files named `<name>-<size>-square.png` and `<name>-<size>-circle.png`.
 * @param {Buffer} rgb the card, 3 bytes per pixel
 * @param {{ width: number, height: number }} canvas
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {number[]} sizes
 * @returns {Promise<{ size: number, shape: 'square' | 'circle', raster: import('./raster.mjs').Raster, png: Buffer }[]>}
 */
export async function renderAvatars(rgb, canvas, box, sizes) {
    const avatars = [];
    for (const size of sizes) {
        const square = await sharp(rgb, rawInput(canvas, 3))
            .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
            .resize(size, size, { kernel: 'lanczos3', fit: 'fill' })
            .ensureAlpha()
            .raw()
            .toBuffer();
        const squareRaster = { width: size, height: size, data: square };
        for (const [shape, raster] of [['square', squareRaster], ['circle', circleMask(squareRaster)]]) {
            avatars.push({ size, shape, raster, png: await sharp(raster.data, rawInput(raster, 4)).png({ compressionLevel: 9 }).toBuffer() });
        }
    }
    return avatars;
}

/**
 * One picture to judge the avatars by: every avatar at its own size (1x) on a light and on a dark backdrop, the way a chat shows them.
 * @param {Awaited<ReturnType<typeof renderAvatars>>} avatars
 * @param {{ lightBackdrop: number[], darkBackdrop: number[] }} backdrops
 */
export async function renderAvatarSheet(avatars, { lightBackdrop, darkBackdrop }) {
    const gap = 16;
    const rowHeight = Math.max(...avatars.map(({ size }) => size)) + 2 * gap;
    const width = avatars.reduce((sum, { size }) => sum + size + gap, gap);
    const layers = [];
    const rows = [lightBackdrop, darkBackdrop];
    for (const [index, backdrop] of rows.entries()) {
        layers.push({ input: { create: { width, height: rowHeight, channels: 3, background: { r: backdrop[0], g: backdrop[1], b: backdrop[2] } } }, left: 0, top: index * rowHeight });
        let left = gap;
        for (const avatar of avatars) {
            layers.push({ input: await sharp(avatar.raster.data, rawInput(avatar.raster, 4)).png().toBuffer(), left, top: index * rowHeight + gap });
            left += avatar.size + gap;
        }
    }
    return sharp({ create: { width, height: rowHeight * rows.length, channels: 3, background: { r: 255, g: 255, b: 255 } } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
