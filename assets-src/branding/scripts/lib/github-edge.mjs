import { parseHex } from './github-colour.mjs';
import { createRaster } from './raster.mjs';
import { blendOver } from './github-vector.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */
/**
 * @typedef {object} Edge
 * @property {{ colour: string, width: number } | undefined} outline `colour` is a hex colour; `width` is whole pixels all round the ink
 * @property {{ colour: string, alpha: number, offset: { x: number, y: number }, step: number, steps: number } | undefined} shadow the shadow is
 * `steps` bands of `step` pixels each past the outline (or the ink), moved by `offset`, the nearest band at `alpha` and each further one fainter
 */

/** The share of a pixel that counts as ink: the same half as everywhere else in the build. */
const INK_ALPHA = 128;

/**
 * The most that an edge adds on any side of the ink, in pixels. A picture with an edge is drawn on a canvas this much larger all round.
 * @param {Edge} edge
 */
function edgeReach({ outline, shadow }) {
    const outlineReach = outline?.width ?? 0;
    const shadowReach = shadow ? shadow.steps * shadow.step + Math.max(Math.abs(shadow.offset.x), Math.abs(shadow.offset.y)) : 0;
    return outlineReach + shadowReach;
}

/** Grows a mask by `radius` pixels in every direction, with a square reach, so a diagonal edge grows in steps of whole pixels. */
function dilate(mask, width, height, radius) {
    if (radius === 0) {
        return mask;
    }
    const across = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
        let lastInk = -Infinity;
        const row = y * width;
        for (let x = 0; x < width; x++) {
            lastInk = mask[row + x] ? x : lastInk;
            across[row + x] = x - lastInk <= radius ? 1 : 0;
        }
        lastInk = Infinity;
        for (let x = width - 1; x >= 0; x--) {
            lastInk = mask[row + x] ? x : lastInk;
            across[row + x] = across[row + x] || lastInk - x <= radius ? 1 : 0;
        }
    }
    const grown = new Uint8Array(mask.length);
    for (let x = 0; x < width; x++) {
        let lastInk = -Infinity;
        for (let y = 0; y < height; y++) {
            lastInk = across[y * width + x] ? y : lastInk;
            grown[y * width + x] = y - lastInk <= radius ? 1 : 0;
        }
        lastInk = Infinity;
        for (let y = height - 1; y >= 0; y--) {
            lastInk = across[y * width + x] ? y : lastInk;
            grown[y * width + x] = grown[y * width + x] || lastInk - y <= radius ? 1 : 0;
        }
    }
    return grown;
}

const moved = (mask, width, height, dx, dy) => {
    const shifted = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const fromX = x - dx;
            const fromY = y - dy;
            shifted[y * width + x] = fromX >= 0 && fromY >= 0 && fromX < width && fromY < height ? mask[fromY * width + fromX] : 0;
        }
    }
    return shifted;
};

function paintMask(layer, mask, rgb, alpha) {
    for (let at = 0; at < mask.length; at++) {
        if (mask[at]) {
            layer.data.set([...rgb, alpha], at * 4);
        }
    }
}

/**
 * Draws an outline and a stepped shadow round a picture of ink. The outline is hard-edged and is the ink grown by whole pixels. The shadow
 * is made of bands, each one nearer the ink darker than the next, and is cast by the outline and the ink together, so it reads as one shape.
 * @param {Raster} ink a picture with transparent pixels round its drawing
 * @param {Edge} edge colours are hex
 * @returns {{ picture: Raster, reach: number, ring: Uint8Array, ink: Uint8Array }} `picture` is `reach` pixels larger on every side; `ring` is
 * 1 where the outline lies outside the ink and `ink` 1 where the ink is, both in the coordinates of `picture`
 */
export function paintEdge(ink, edge) {
    const reach = edgeReach(edge);
    const width = ink.width + 2 * reach;
    const height = ink.height + 2 * reach;
    const inkMask = new Uint8Array(width * height);
    for (let y = 0; y < ink.height; y++) {
        for (let x = 0; x < ink.width; x++) {
            inkMask[(y + reach) * width + x + reach] = ink.data[(y * ink.width + x) * 4 + 3] >= INK_ALPHA ? 1 : 0;
        }
    }
    const silhouette = edge.outline ? dilate(inkMask, width, height, edge.outline.width) : inkMask;
    const ring = Uint8Array.from(silhouette, (value, at) => (value && !inkMask[at] ? 1 : 0));

    const picture = createRaster(width, height);
    if (edge.shadow) {
        const { colour, alpha, offset, step, steps } = edge.shadow;
        const { r, g, b } = parseHex(colour);
        const bands = new Uint8Array(width * height);
        const shades = new Uint8Array(width * height);
        for (let band = steps; band >= 1; band--) {
            const grown = moved(dilate(silhouette, width, height, band * step), width, height, offset.x, offset.y);
            // Each band is fainter than the one inside it, and a pixel takes the shade of the nearest band that holds it.
            const shade = Math.round(255 * alpha * (steps - band + 1) / steps);
            for (let at = 0; at < grown.length; at++) {
                if (grown[at]) {
                    bands[at] = band;
                    shades[at] = shade;
                }
            }
        }
        for (let at = 0; at < shades.length; at++) {
            if (bands[at]) {
                picture.data.set([r, g, b, shades[at]], at * 4);
            }
        }
    }
    if (edge.outline) {
        const { r, g, b } = parseHex(edge.outline.colour);
        paintMask(picture, silhouette, [r, g, b], 255);
    }
    blendOver(picture, ink, reach, reach);
    return { picture, reach, ring, ink: inkMask };
}
