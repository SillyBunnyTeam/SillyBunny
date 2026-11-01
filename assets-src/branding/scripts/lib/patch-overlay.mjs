import sharp from 'sharp';
import { buildContactSheet } from './contact-sheet.mjs';
import { flagLayer } from './ear-remnants.mjs';

// A green that does not occur in the sheets, the hair or the skin, so an outline is never mistaken for art.
export const OUTLINE = [57, 255, 20];

const requireWhole = (name, value) => {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`The overlay ${name} must be a whole number of 1 or more.`);
    }
};

/**
 * One crop enlarged with nearest-neighbour blocks, with a one pixel outline just inside the edge of every composite rect.
 * @param {Buffer | string} input the picture the spec is written for
 * @param {{ crop: { x: number, y: number, width: number, height: number }, composite: Array<{ x: number, y: number, width: number, height: number }> }} patch a parsed patch
 * @param {number} scale
 * @param {Array<[number, number, number]>} [flags] `[x, y, kind]` pixels from ear-remnants, tinted under the outlines
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function outlineCrop(input, { crop, composite }, scale, flags = []) {
    const enlarged = await sharp(input)
        .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
        .resize(crop.width * scale, crop.height * scale, { kernel: 'nearest' })
        .png()
        .toBuffer();
    // The stroke is centred on a half pixel, so it covers exactly the outermost pixel row or column of the scaled rect.
    const outlines = composite.map((rect) => {
        const left = (rect.x - crop.x) * scale + 0.5;
        const top = (rect.y - crop.y) * scale + 0.5;
        return `<rect x="${left}" y="${top}" width="${rect.width * scale - 1}" height="${rect.height * scale - 1}" fill="none" stroke="rgb(${OUTLINE.join(',')})" stroke-width="1" shape-rendering="crispEdges"/>`;
    });
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width * scale}" height="${crop.height * scale}">${outlines.join('')}</svg>`);
    const layers = flags.length > 0 ? [{ input: await flagLayer(flags, crop, scale) }, { input: overlay }] : [{ input: overlay }];
    return sharp(enlarged).composite(layers).png().toBuffer();
}

/**
 * A check sheet for a patch spec: every crop at `scale`x with its composite rects outlined, so the rects can be judged by eye before any call is paid for.
 * @param {Buffer | string} input
 * @param {Parameters<typeof outlineCrop>[1][]} patches parsed patches
 * @param {{ scale?: number, columns?: number, flags?: Array<[number, number, number]> }} [options]
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function renderPatchOverlay(input, patches, { scale = 2, columns = 2, flags = [] } = {}) {
    requireWhole('scale', scale);
    requireWhole('columns', columns);
    const items = [];
    for (const [index, patch] of patches.entries()) {
        const { x, y, width, height } = patch.crop;
        items.push({ image: await outlineCrop(input, patch, scale, flags), label: `patch ${index + 1}  crop [${x},${y},${width},${height}]  shown ${scale}x` });
    }
    return buildContactSheet(items, { cols: columns, cellWidth: 0, cellHeight: 0, gap: 12, labelHeight: 24, nearest: true, scales: [1], scaleLabels: false });
}
