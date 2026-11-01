// A synthetic sticker for the rim tools: a lavender rim, a white band and a small character, with a soft outer edge.
import { createRaster, setPixel } from './synthetic.mjs';

export const SIZE = 90;
export const EDGE = 12;
export const RIM_WIDTH = 5;
export const WHITE_WIDTH = 4;
export const OLD_RIM_A = [172, 150, 212];
export const OLD_RIM_B = [176, 154, 216];
export const WHITE = [255, 255, 255];
export const SKIN = [252, 232, 220];
export const HAIR = [190, 165, 235];
export const DARK = [60, 30, 50];

/** How many pixels in from the square's edge a pixel lies (negative outside it). */
export const inward = (x, y) => Math.min(x - EDGE, y - EDGE, SIZE - 1 - EDGE - x, SIZE - 1 - EDGE - y);

/**
 * A sticker like the model draws one: a lavender rim, a white band, then the character, with a soft outer edge
 * (a half transparent ring and a fully transparent ring that still carries the rim colour). With `borderCut` the character runs off the bottom of the canvas.
 */
export function sticker({ borderCut = false } = {}) {
    const raster = createRaster(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const depth = borderCut ? Math.min(x - EDGE, y - EDGE, SIZE - 1 - EDGE - x) : inward(x, y);
            const rim = (y % 2 === 0 ? OLD_RIM_A : OLD_RIM_B);
            if (depth === -1) {
                setPixel(raster, x, y, [...rim, 60]);
            } else if (depth === -2) {
                setPixel(raster, x, y, [...rim, 0]);
            } else if (depth >= 0 && depth < RIM_WIDTH) {
                setPixel(raster, x, y, rim);
            } else if (depth === RIM_WIDTH) {
                setPixel(raster, x, y, rim.map((channel, at) => Math.round((channel + WHITE[at]) / 2)));
            } else if (depth > RIM_WIDTH && depth <= RIM_WIDTH + WHITE_WIDTH) {
                setPixel(raster, x, y, WHITE);
            } else if (depth > RIM_WIDTH + WHITE_WIDTH) {
                const isHair = depth <= RIM_WIDTH + WHITE_WIDTH + 4 && x > 30 && x < 50;
                setPixel(raster, x, y, isHair ? HAIR : SKIN);
            }
        }
    }
    setPixel(raster, 45, 45, DARK);
    if (borderCut) {
        for (let y = SIZE - 3; y < SIZE; y++) {
            for (let x = 30; x < 60; x++) {
                setPixel(raster, x, y, HAIR);
            }
        }
    }
    return raster;
}

/** A sticker whose white band is the outermost opaque thing: no lavender ring outside it, only a faint antialiased white edge. */
export function ringlessSticker() {
    const raster = createRaster(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const depth = inward(x, y);
            if (depth === -1) {
                setPixel(raster, x, y, [...WHITE, 90]);
            } else if (depth >= 0 && depth < WHITE_WIDTH) {
                setPixel(raster, x, y, WHITE);
            } else if (depth >= WHITE_WIDTH) {
                setPixel(raster, x, y, SKIN);
            }
        }
    }
    setPixel(raster, 45, 45, DARK);
    return raster;
}

export const SOFT_FRINGE = [183, 155, 226];
// Alpha of the translucent lavender fringe, from the ring touching the white band outwards (inward -1, -2, ...).
export const SOFT_FRINGE_ALPHA = [240, 210, 180, 150, 100, 50];

/** A sticker whose lavender ring outside the white band is only translucent, so it never reaches full opacity. */
export function softFringeSticker() {
    const raster = ringlessSticker();
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const depth = inward(x, y);
            if (depth < 0 && depth >= -SOFT_FRINGE_ALPHA.length) {
                setPixel(raster, x, y, [...SOFT_FRINGE, SOFT_FRINGE_ALPHA[-depth - 1]]);
            }
        }
    }
    return raster;
}
