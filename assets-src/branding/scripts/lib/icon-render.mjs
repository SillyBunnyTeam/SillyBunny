import sharp from 'sharp';
import { svgSide } from './logo-sheet.mjs';
import { createRaster } from './raster.mjs';

// Pixels per icon pixel when a draft is drawn before it is averaged down. 64 x 64 samples per pixel make the coverage exact to under 1/4096.
export const DRAFT_SUPERSAMPLE = 64;
// The share of the icon's side that the circle platforms may crop to leaves: the central 80% (Android maskable safe zone).
export const SAFE_ZONE_DIAMETER = 0.8;
// The emblem's farthest point sits this close to the edge of the safe circle, so antialiasing never reaches outside it.
const SAFE_ZONE_FILL = 0.98;
const PLATFORM_SIDE = 1024;

/** The SVG drawn at exactly `size` pixels square, on a transparent background, as straight RGBA. */
export async function rasteriseSvg(svg, size) {
    const { data, info } = await sharp(Buffer.from(svg), { density: (72 * size) / svgSide(svg) }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== size || info.height !== size) {
        throw new Error(`The SVG was drawn at ${info.width}x${info.height} instead of ${size}x${size}.`);
    }
    return { width: size, height: size, data };
}

/** The SVG as PNG bytes at `size` px, drawn directly at that size so every edge is antialiased once. Opaque pictures lose the alpha channel. */
export async function renderPng(svg, size, { opaque = false } = {}) {
    const image = sharp(Buffer.from(svg), { density: (72 * size) / svgSide(svg) });
    const { data, info } = await (opaque ? image.flatten({ background: '#ffffff' }).removeAlpha() : image.ensureAlpha()).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== size || info.height !== size) {
        throw new Error(`The SVG was drawn at ${info.width}x${info.height} instead of ${size}x${size}.`);
    }
    return sharp(data, { raw: { width: size, height: size, channels: info.channels } }).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * The SVG reduced to `size` by `size` by area coverage: it is drawn `supersample` times larger and every output pixel is the plain mean of
 * the block it covers. Colour is averaged weighted by alpha, so a pixel half covered by the plate has the plate colour at alpha 128, not a
 * darker blend, and its alpha is the share of the block the shape covers.
 * @param {string} svg
 * @param {number} size
 * @param {number} [supersample]
 * @returns {Promise<import('./raster.mjs').Raster>}
 */
export async function coverageDraft(svg, size, supersample = DRAFT_SUPERSAMPLE) {
    if (!Number.isInteger(size) || size < 1 || !Number.isInteger(supersample) || supersample < 1) {
        throw new Error(`A draft needs a whole size and a whole supersample; got ${size} and ${supersample}.`);
    }
    const large = await rasteriseSvg(svg, size * supersample);
    const out = createRaster(size, size);
    const blockPixels = supersample * supersample;
    for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
            let alphaSum = 0;
            const weighted = [0, 0, 0];
            for (let y = row * supersample; y < (row + 1) * supersample; y++) {
                let at = (y * large.width + column * supersample) * 4;
                for (let x = 0; x < supersample; x++, at += 4) {
                    const alpha = large.data[at + 3];
                    alphaSum += alpha;
                    weighted[0] += large.data[at] * alpha;
                    weighted[1] += large.data[at + 1] * alpha;
                    weighted[2] += large.data[at + 2] * alpha;
                }
            }
            if (alphaSum === 0) {
                continue;
            }
            out.data.set([...weighted.map((sum) => Math.round(sum / alphaSum)), Math.round(alphaSum / blockPixels)], (row * size + column) * 4);
        }
    }
    return out;
}

/** The SVG's drawing without its outer <svg> element. */
function innerMarkup(svg) {
    const match = /^<svg\b[^>]*>(.*)<\/svg>\s*$/s.exec(svg);
    if (!match) {
        throw new Error('The SVG is not a single <svg> element.');
    }
    return match[1];
}

/** The colour of the plate itself (not its lip) in a logo plate SVG: the fill of the shape drawn inside the clip group. */
export function plateColour(plateSvg) {
    const match = /<g clip-path="[^"]*"><use\b[^>]*\sfill="(#[0-9a-f]{6})"/i.exec(plateSvg);
    if (!match) {
        throw new Error('The plate SVG has no plate fill inside its clip group, so the platform colour cannot be read.');
    }
    return match[1].toLowerCase();
}

/**
 * How far the drawing reaches from the middle of its square viewBox, in viewBox units: the distance to the far corner of the farthest
 * pixel that has any colour. Measured on a 1:1 render, so it is exact to a pixel and never under-reads.
 * @param {string} svg
 */
export async function reachFromCentre(svg) {
    const side = svgSide(svg);
    const pixels = await rasteriseSvg(svg, Math.round(side));
    const middle = pixels.width / 2;
    let reach = 0;
    for (let y = 0; y < pixels.height; y++) {
        for (let x = 0; x < pixels.width; x++) {
            if (pixels.data[(y * pixels.width + x) * 4 + 3] === 0) {
                continue;
            }
            reach = Math.max(reach, Math.hypot(Math.max(Math.abs(x - middle), Math.abs(x + 1 - middle)), Math.max(Math.abs(y - middle), Math.abs(y + 1 - middle))));
        }
    }
    return reach;
}

/**
 * A platform icon as SVG: the plate colour edge to edge with no lip and no rounded corners (the platform crops it), and the emblem centred
 * and as large as the central safe circle allows.
 * @param {{ plate: string, emblem: string, reach: number }} parts `reach` is `reachFromCentre(emblem)`
 */
export function platformSvg({ plate, emblem, reach }) {
    const emblemSide = svgSide(emblem);
    const scale = (SAFE_ZONE_FILL * (SAFE_ZONE_DIAMETER / 2) * PLATFORM_SIDE) / reach;
    const offset = (PLATFORM_SIDE - scale * emblemSide) / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLATFORM_SIDE} ${PLATFORM_SIDE}"><rect width="${PLATFORM_SIDE}" height="${PLATFORM_SIDE}" fill="${plateColour(plate)}"/><g transform="translate(${offset.toFixed(3)} ${offset.toFixed(3)}) scale(${scale.toFixed(5)})">${innerMarkup(emblem)}</g></svg>`;
}
