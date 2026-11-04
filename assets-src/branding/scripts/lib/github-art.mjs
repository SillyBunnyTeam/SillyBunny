import { createRaster, crop, hasBinaryAlpha, opaqueBox, paste, readRaster, upscaleNearest } from './raster.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */
/** @typedef {{ x: number, y: number, width: number, height: number, step: number }} ArtPlacement the box of the whole scaled picture, which may reach past the canvas */

/** A drawn piece smaller than this many art pixels, with no neighbour that touches it, is a speck and not part of the sticker. */
export const MIN_PIECE_PIXELS = 40;

/**
 * The pieces of a picture that are too small to be part of the drawing: groups of drawn pixels that touch each other, corners
 * included, and that number fewer than `minPixels`. A real scene has a few big pieces (a sticker, a prop with its own outline); a
 * speck of leftover noise is a handful of pixels.
 * @param {Raster} picture
 * @param {number} [minPixels]
 * @returns {{ pixels: number, x: number, y: number }[]} the size of each speck and where its first pixel is
 */
export function findStrayPieces(picture, minPixels = MIN_PIECE_PIXELS) {
    const { width, height, data } = picture;
    const seen = new Uint8Array(width * height);
    const specks = [];
    for (let start = 0; start < width * height; start++) {
        if (data[start * 4 + 3] === 0 || seen[start] === 1) {
            continue;
        }
        const stack = [start];
        seen[start] = 1;
        let pixels = 0;
        while (stack.length > 0) {
            const at = stack.pop();
            pixels += 1;
            const x = at % width;
            const y = (at - x) / width;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nextX = x + dx;
                    const nextY = y + dy;
                    const next = nextY * width + nextX;
                    if (nextX >= 0 && nextY >= 0 && nextX < width && nextY < height && data[next * 4 + 3] !== 0 && seen[next] === 0) {
                        seen[next] = 1;
                        stack.push(next);
                    }
                }
            }
        }
        if (pixels < minPixels) {
            specks.push({ pixels, x: start % width, y: Math.floor(start / width) });
        }
    }
    return specks;
}

/**
 * A snapped picture cut down to its drawn pixels, one art pixel per pixel. Snapped art has no half-transparent pixels, so a picture
 * that has some is not snapped and is refused: scaling it would show a smooth edge. A drawing that reaches the edge of its picture
 * may have been cut off there, so that is refused too: the sticker must be whole, with transparent pixels all round it. Specks of
 * a few drawn pixels away from the drawing are refused as well, because they are what is left of noise in the master.
 * @param {Raster} picture
 * @param {string} name what the picture is called in an error: its path
 * @returns {Raster}
 */
export function parseArt(picture, name) {
    if (!hasBinaryAlpha(picture)) {
        throw new Error(`${name} has half-transparent pixels, so it is not a snapped picture and cannot be scaled in whole steps.`);
    }
    const box = opaqueBox(picture);
    if (!box) {
        throw new Error(`${name} has no opaque pixels.`);
    }
    if (box.x === 0 || box.y === 0 || box.x + box.width === picture.width || box.y + box.height === picture.height) {
        throw new Error(`${name} has drawn pixels on the edge of the picture, so part of the sticker may be cut off. Leave transparent pixels all round it.`);
    }
    const specks = findStrayPieces(picture);
    if (specks.length > 0) {
        throw new Error(`${name} has ${specks.length} stray piece${specks.length === 1 ? '' : 's'} of under ${MIN_PIECE_PIXELS} drawn pixels outside the sticker (first at ${specks[0].x},${specks[0].y}, ${specks[0].pixels} px). Clear them before the picture is used.`);
    }
    return crop(picture, box);
}

/** @param {string} path @returns {Promise<Raster>} the snapped picture in the file, as {@link parseArt} reads it */
export async function loadArt(path) {
    return parseArt(await readRaster(path), path);
}

const PLACEHOLDER_COLOURS = Object.freeze({ edge: [139, 100, 170, 255], stripes: [[216, 198, 245, 255], [185, 155, 242, 255]] });
const PLACEHOLDER_EDGE = 3;
const PLACEHOLDER_CORNER = 12;
const PLACEHOLDER_STRIPE = 8;

function insideRoundedBox(x, y, width, height, radius) {
    const dx = Math.max(radius - x - 0.5, x + 0.5 - (width - radius), 0);
    const dy = Math.max(radius - y - 0.5, y + 0.5 - (height - radius), 0);
    return dx * dx + dy * dy <= radius * radius;
}

/**
 * A stand-in for a scene that is not drawn yet: a striped slab with a dark edge, `width` by `height` art pixels, with no
 * half-transparent pixel, so it is placed, scaled and checked like the real picture. It is not meant to be shipped.
 * @param {number} width
 * @param {number} height
 * @returns {Raster}
 */
export function makePlaceholderArt(width, height) {
    const slab = createRaster(width, height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!insideRoundedBox(x, y, width, height, PLACEHOLDER_CORNER)) {
                continue;
            }
            const inner = insideRoundedBox(x - PLACEHOLDER_EDGE, y - PLACEHOLDER_EDGE, width - 2 * PLACEHOLDER_EDGE, height - 2 * PLACEHOLDER_EDGE, PLACEHOLDER_CORNER - PLACEHOLDER_EDGE);
            const stripe = Math.floor((x + y) / PLACEHOLDER_STRIPE) % 2;
            slab.data.set(inner ? PLACEHOLDER_COLOURS.stripes[stripe] : PLACEHOLDER_COLOURS.edge, (y * width + x) * 4);
        }
    }
    return slab;
}

/**
 * Draws a snapped picture onto the canvas at a whole number of pixels per art pixel, by copying each art pixel into one square block.
 * The canvas must already hold the solid background; pixels that fall outside it are dropped, which is how a picture bleeds off an edge.
 * @param {Raster} canvas
 * @param {Raster} art
 * @param {{ step: number, x: number, y: number }} where
 * @returns {ArtPlacement}
 */
export function drawArt(canvas, art, { step, x, y }) {
    if (!Number.isInteger(step) || step < 1) {
        throw new Error(`The art step must be a whole number of 1 or more, got ${step}.`);
    }
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
        throw new Error(`The art position must be whole pixels, got ${x}, ${y}.`);
    }
    const scaled = upscaleNearest(art, step);
    paste(canvas, scaled, x, y);
    return { x, y, width: scaled.width, height: scaled.height, step };
}

const colourAt = (raster, x, y) => raster.data.subarray((y * raster.width + x) * 4, (y * raster.width + x) * 4 + 4);

/** What shows at a pixel where the art is transparent: a flat RGBA colour, or the picture that lay under the art. */
const underAt = (under, x, y) => (Array.isArray(under) ? under : colourAt(under, x, y));

/** The first pixel of an art pixel's block that is not what the art says, or undefined when the whole block is as it should be. */
function findOddPixel(picture, { x: left, y: top, step }, column, row, source, under) {
    for (let dy = 0; dy < step; dy++) {
        for (let dx = 0; dx < step; dx++) {
            const x = left + column * step + dx;
            const y = top + row * step + dy;
            const inside = x >= 0 && y >= 0 && x < picture.width && y < picture.height;
            const want = source[3] === 0 && inside ? underAt(under, x, y) : source;
            if (inside && colourAt(picture, x, y).some((value, channel) => value !== want[channel])) {
                return { x, y, got: [...colourAt(picture, x, y)], want: [...want] };
            }
        }
    }
    return undefined;
}

/**
 * Checks a finished picture against the art it was made from: every block of `step` by `step` pixels that starts at the placement's corner
 * (the blocks that the canvas edge cuts included) is the art pixel's colour, or, where the art pixel is transparent, whatever lay under
 * the art. Returns the problems, at most `limit`; none means every art pixel is an even block.
 * @param {Raster} picture
 * @param {ArtPlacement} placement
 * @param {Raster} art
 * @param {number[] | Raster} under RGBA of the solid background under the art, or the picture as it was before the art was drawn
 * @param {number} [limit]
 * @returns {string[]}
 */
export function findArtProblems(picture, placement, art, under, limit = 5) {
    const problems = [];
    for (let row = 0; row < art.height && problems.length < limit; row++) {
        for (let column = 0; column < art.width && problems.length < limit; column++) {
            const odd = findOddPixel(picture, placement, column, row, colourAt(art, column, row), under);
            if (odd) {
                problems.push(`art pixel ${column},${row} is not an even ${placement.step}x${placement.step} block: the picture has [${odd.got}] at ${odd.x},${odd.y}, the art says [${odd.want}]`);
            }
        }
    }
    return problems;
}
