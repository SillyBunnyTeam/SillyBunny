import { createRaster, crop, opaqueBox, paste } from './raster.js';

/** Pixels fainter than this are a soft tail or a stray speck, not part of the subject's box. */
export const SUBJECT_ALPHA = 16;

/**
 * The part of a picture that ships: the whole canvas, or the subject's box with `margin` pixels on every side. The box
 * may reach past the canvas, and `renderFrame` fills that part with transparency, so the sticker edge never touches the
 * edge of the file.
 * @param {import('./raster.js').Raster} raster
 * @param {{ mode: 'canvas' } | { mode: 'subject', margin: number }} frame
 * @returns {import('./raster.js').Box}
 */
export function frameBox(raster, frame) {
    if (frame.mode === 'canvas') {
        return { x: 0, y: 0, width: raster.width, height: raster.height };
    }
    const box = opaqueBox(raster, SUBJECT_ALPHA);
    if (!box) {
        throw new Error('The picture has no visible subject to frame.');
    }
    return { x: box.x - frame.margin, y: box.y - frame.margin, width: box.width + 2 * frame.margin, height: box.height + 2 * frame.margin };
}

/**
 * The box cut out of the picture. Where the box reaches past the canvas the result is transparent, and the colour
 * under every transparent pixel is zero.
 * @param {import('./raster.js').Raster} raster
 * @param {import('./raster.js').Box} box
 * @returns {import('./raster.js').Raster}
 */
export function renderFrame(raster, box) {
    const left = Math.max(0, box.x);
    const top = Math.max(0, box.y);
    const right = Math.min(raster.width, box.x + box.width);
    const bottom = Math.min(raster.height, box.y + box.height);
    const framed = createRaster(box.width, box.height, raster.channels);
    if (right > left && bottom > top) {
        paste(framed, crop(raster, { x: left, y: top, width: right - left, height: bottom - top }), left - box.x, top - box.y);
    }
    return framed;
}
