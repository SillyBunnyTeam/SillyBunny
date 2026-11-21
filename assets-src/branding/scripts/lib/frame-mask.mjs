import { createRaster } from './raster.mjs';
import { distanceToMask } from './rim-add.mjs';
import { opaqueMask } from './shape-ops.mjs';

export const DEFAULTS = Object.freeze({
    // A pixel at least this opaque belongs to the picture. Fainter ones are the soft edge of the model's drawing or its smudges.
    minAlpha: 160,
    // How far apart (largest difference of one colour channel, 0 to 255) two pixels may be and still count as the same drawing.
    colourTolerance: 60,
    // How many pixels the two pictures may be shifted against each other before a difference is believed.
    shift: 2,
    // The radius of the opening that removes thin differences, such as the ring that one picture's sticker has and the other's has not.
    openRadius: 3,
    // Differences of fewer pixels than this are specks.
    minPixels: 150,
    // Changed pieces closer to each other than this are joined into one (a closing), so that the parts of a body between two moved arms come with them.
    closeRadius: 0,
    // How far the changed area is grown so that the cut runs outside what moved, where the two pictures agree, in pixels.
    growRadius: 8,
    // A pocket of the base that the changed area encloses is filled when it has fewer pixels than this.
    maxPocket: 1500,
    // Within this many pixels of a part to keep, the outline of the cut area turns into the base's outline, so the cut meets the kept part's outline instead of ending in a step. 0 turns it off.
    stitchRadius: 24,
    // A hole in a picture's figure with fewer pixels than this is a flaw of the drawing (a pixel the model left translucent), not a gap between an arm and the body.
    maxHole: 300,
});

const NEIGHBOURS_4 = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const NEIGHBOURS_8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** The mask of the pixels of a box (the part of it that is on the canvas). */
export function boxMask(box, width, height) {
    const mask = new Uint8Array(width * height);
    for (let y = Math.max(0, box.y); y < Math.min(height, box.y + box.height); y++) {
        mask.fill(1, y * width + Math.max(0, box.x), y * width + Math.min(width, box.x + box.width));
    }
    return mask;
}

export const unionOf = (...masks) => Uint8Array.from(masks[0], (_, at) => (masks.some((mask) => mask[at] === 1) ? 1 : 0));
export const withoutOf = (one, two) => Uint8Array.from(one, (value, at) => (value === 1 && two[at] === 0 ? 1 : 0));
export const countOf = (mask) => mask.reduce((total, value) => total + value, 0);

/** The mask grown by `radius` pixels (a disc): it also holds every pixel within that distance of it. */
export function discDilate(mask, width, height, radius) {
    if (radius <= 0) {
        return mask;
    }
    return Uint8Array.from(distanceToMask(mask, width, height), (distance) => (distance <= radius + 1e-9 ? 1 : 0));
}

/** The mask shrunk by `radius` pixels: what is left when everything within that distance of its outside is taken away. The canvas edge is not outside. */
export function discErode(mask, width, height, radius) {
    if (radius <= 0) {
        return mask;
    }
    const outside = Uint8Array.from(mask, (value) => 1 - value);
    const distance = distanceToMask(outside, width, height);
    return Uint8Array.from(mask, (value, at) => (value === 1 && distance[at] > radius + 1e-9 ? 1 : 0));
}

/** An erosion followed by a dilation: the parts of the mask thinner than twice `radius` are gone and the rest keeps its shape. */
export const discOpen = (mask, width, height, radius) => (radius <= 0 ? mask : discDilate(discErode(mask, width, height, radius), width, height, radius));

/**
 * The 8-connected pieces of a mask, biggest first.
 * @returns {{ label: Int32Array, pieces: { id: number, pixels: number }[] }} `label` is 0 outside the mask and the piece's id (from 1) inside it
 */
export function piecesOf(mask, width, height) {
    const label = new Int32Array(width * height);
    const pieces = [];
    const stack = [];
    for (let start = 0; start < mask.length; start++) {
        if (mask[start] === 0 || label[start] !== 0) {
            continue;
        }
        const id = pieces.length + 1;
        let pixels = 0;
        label[start] = id;
        stack.push(start);
        while (stack.length > 0) {
            const at = stack.pop();
            pixels++;
            const x = at % width;
            const y = (at - x) / width;
            for (const [dx, dy] of NEIGHBOURS_8) {
                const next = (y + dy) * width + x + dx;
                if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height && mask[next] === 1 && label[next] === 0) {
                    label[next] = id;
                    stack.push(next);
                }
            }
        }
        pieces.push({ id, pixels });
    }
    return { label, pieces: pieces.sort((a, b) => b.pixels - a.pixels) };
}

/** The mask without its pieces of fewer than `minPixels` pixels. */
export function dropSpecks(mask, width, height, minPixels) {
    const { label, pieces } = piecesOf(mask, width, height);
    const small = new Set(pieces.filter(({ pixels }) => pixels < minPixels).map(({ id }) => id));
    return Uint8Array.from(mask, (value, at) => (value === 1 && !small.has(label[at]) ? 1 : 0));
}

/** The mask with every hole of fewer than `maxPixels` pixels filled: a part of the outside that the mask encloses, with no way out to the canvas edge. */
export function fillPockets(mask, width, height, maxPixels) {
    const outside = Uint8Array.from(mask, (value) => 1 - value);
    const { label, pieces } = piecesOf(outside, width, height);
    const reachesEdge = new Set();
    for (let x = 0; x < width; x++) {
        reachesEdge.add(label[x]);
        reachesEdge.add(label[(height - 1) * width + x]);
    }
    for (let y = 0; y < height; y++) {
        reachesEdge.add(label[y * width]);
        reachesEdge.add(label[y * width + width - 1]);
    }
    const pockets = new Set(pieces.filter(({ id, pixels }) => pixels < maxPixels && !reachesEdge.has(id)).map(({ id }) => id));
    return Uint8Array.from(mask, (value, at) => (value === 1 || pockets.has(label[at]) ? 1 : 0));
}

/**
 * The picture a model's edit shows once its smudges are gone: every pixel that is at least `minAlpha` opaque and in the biggest connected piece
 * (the figure and what it holds) is fully opaque with its own colour, and every other pixel is transparent. A hole in the figure of fewer than `maxHole`
 * pixels is filled with the colours the picture has there. What the model left in the background (faint dark clouds, blobs at the edge) is not joined
 * to the figure by pixels that opaque, so it is dropped.
 * @param {import('./raster.mjs').Raster} picture
 * @returns {{ raster: import('./raster.mjs').Raster, mask: Uint8Array, dropped: { pixels: number, pieces: number } }}
 */
export function cleanPicture(picture, minAlpha = DEFAULTS.minAlpha, maxHole = DEFAULTS.maxHole) {
    const { width, height } = picture;
    const opaque = opaqueMask(picture, minAlpha);
    const { label, pieces } = piecesOf(opaque, width, height);
    if (pieces.length === 0) {
        throw new Error(`The picture has no pixel that is ${minAlpha} opaque or more, so there is no figure in it.`);
    }
    const mask = fillPockets(Uint8Array.from(label, (id) => (id === pieces[0].id ? 1 : 0)), width, height, maxHole);
    const raster = createRaster(width, height);
    for (let at = 0; at < mask.length; at++) {
        if (mask[at] === 1) {
            picture.data.copy(raster.data, at * 4, at * 4, at * 4 + 3);
            raster.data[at * 4 + 3] = 255;
        }
    }
    return { raster, mask, dropped: { pixels: countOf(opaque) - pieces[0].pixels, pieces: pieces.length - 1 } };
}

/** How far apart two pixels are: 255 when only one of them is opaque, otherwise the largest difference of one colour channel. */
function pixelDistance(one, oneAt, two, twoAt) {
    const isOpaque = one.data[oneAt + 3] !== 0;
    if (isOpaque !== (two.data[twoAt + 3] !== 0)) {
        return 255;
    }
    return isOpaque ? Math.max(Math.abs(one.data[oneAt] - two.data[twoAt]), Math.abs(one.data[oneAt + 1] - two.data[twoAt + 1]), Math.abs(one.data[oneAt + 2] - two.data[twoAt + 2])) : 0;
}

/**
 * The pixels where two cleaned pictures of one size show something different. A pixel counts as different when no pixel of `edit` within `shift`
 * pixels of it has nearly its colour, so a drawing that the edit moved by a pixel or two is not a difference.
 * @param {import('./raster.mjs').Raster} base
 * @param {import('./raster.mjs').Raster} edit
 */
export function differenceMask(base, edit, { colourTolerance = DEFAULTS.colourTolerance, shift = DEFAULTS.shift } = {}) {
    const { width, height } = base;
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = y * width + x;
            if (base.data[at * 4 + 3] === 0 && edit.data[at * 4 + 3] === 0) {
                continue;
            }
            let nearest = 255;
            for (let dy = -shift; dy <= shift && nearest >= colourTolerance; dy++) {
                for (let dx = -shift; dx <= shift; dx++) {
                    if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height) {
                        nearest = Math.min(nearest, pixelDistance(base, at * 4, edit, ((y + dy) * width + x + dx) * 4));
                    }
                }
            }
            mask[at] = nearest >= colourTolerance ? 1 : 0;
        }
    }
    return mask;
}

/**
 * How many pixels the sticker of the base reaches past the edit's. It is found where the two should agree (`within`, a mask of parts that did not
 * move): the radius, up to `limit`, by which growing the edit's silhouette makes it most like the base's there.
 * @returns {{ radius: number, score: number }} the radius and how alike the silhouettes are then (1 is the same)
 */
export function stickerExtra({ baseMask, editMask, within, width, height, limit = 12 }) {
    let best = { radius: 0, score: -1 };
    for (let radius = 0; radius <= limit; radius++) {
        const grown = discDilate(editMask, width, height, radius);
        let both = 0;
        let either = 0;
        for (let at = 0; at < within.length; at++) {
            if (within[at] === 1) {
                both += grown[at] & baseMask[at];
                either += grown[at] | baseMask[at];
            }
        }
        const score = either === 0 ? 0 : both / either;
        if (score > best.score + 1e-9) {
            best = { radius, score };
        }
    }
    return best;
}

/**
 * The picture with its silhouette grown by `radius` pixels (a diamond, one pixel a round). A new pixel takes the colour of the pixel it grew from.
 * @param {import('./raster.mjs').Raster} picture
 */
export function growSilhouette(picture, radius) {
    const { width, height } = picture;
    const grown = { ...picture, data: Buffer.from(picture.data) };
    const taken = new Uint8Array(width * height);
    let frontier = [];
    for (let at = 0; at < taken.length; at++) {
        if (picture.data[at * 4 + 3] !== 0) {
            taken[at] = 1;
            frontier.push(at);
        }
    }
    for (let round = 0; round < radius; round++) {
        const next = [];
        for (const at of frontier) {
            const x = at % width;
            const y = (at - x) / width;
            for (const [dx, dy] of NEIGHBOURS_4) {
                const near = (y + dy) * width + x + dx;
                if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height && taken[near] === 0) {
                    taken[near] = 1;
                    grown.data.set(grown.data.subarray(at * 4, at * 4 + 4), near * 4);
                    next.push(near);
                }
            }
        }
        frontier = next;
    }
    return grown;
}

/** The signed distance of every pixel from the edge of a mask: positive inside it, negative outside, and 0.5 or -0.5 at the pixels next to the edge. */
function signedDistance(mask, width, height) {
    const toInside = distanceToMask(mask, width, height);
    const toOutside = distanceToMask(Uint8Array.from(mask, (value) => 1 - value), width, height);
    return Float64Array.from(mask, (value, at) => (value === 1 ? toOutside[at] - 0.5 : 0.5 - toInside[at]));
}

/**
 * The frame's silhouette made continuous where the cut meets a part to keep. In the cut area, within `radius` pixels of `protectedMask`, the outline is the
 * edit's outline only gradually: the signed distance from the outline of the base and of the edit are mixed, all base at the kept part and all edit at `radius`
 * pixels from it, and a pixel is opaque where the mix is positive. A new part that the edit has (a tail beside the skirt) so runs into the kept outline instead
 * of ending against it in a step. A pixel that is opaque in the mix but in neither picture takes the colour of the nearest pixel that has one.
 * @param {{ frame: import('./raster.mjs').Raster, cut: Uint8Array, protectedMask: Uint8Array, baseMask: Uint8Array, editRaster: import('./raster.mjs').Raster, baseRaster: import('./raster.mjs').Raster, radius: number }} request
 */
export function stitchSilhouette({ frame, cut, protectedMask, baseMask, editRaster, baseRaster, radius }) {
    const { width, height } = frame;
    if (radius <= 0 || !protectedMask.includes(1)) {
        return frame;
    }
    const near = distanceToMask(protectedMask, width, height);
    const editMask = opaqueMask(editRaster, 1);
    const sdBase = signedDistance(baseMask, width, height);
    const sdEdit = signedDistance(editMask, width, height);
    const sources = createRaster(width, height);
    for (let at = 0; at < cut.length; at++) {
        const from = editMask[at] === 1 ? editRaster : baseMask[at] === 1 ? baseRaster : undefined;
        if (from) {
            from.data.copy(sources.data, at * 4, at * 4, at * 4 + 3);
            sources.data[at * 4 + 3] = 255;
        }
    }
    const filled = growSilhouette(sources, Math.ceil(radius));
    const stitched = { ...frame, data: Buffer.from(frame.data) };
    for (let at = 0; at < cut.length; at++) {
        if (cut[at] === 0 || near[at] > radius) {
            continue;
        }
        const share = near[at] / radius;
        const isOpaque = (1 - share) * sdBase[at] + share * sdEdit[at] > 0;
        if (isOpaque && filled.data[at * 4 + 3] !== 0) {
            filled.data.copy(stitched.data, at * 4, at * 4, at * 4 + 4);
        } else {
            stitched.data.fill(0, at * 4, at * 4 + 4);
        }
    }
    return stitched;
}

/**
 * Takes from `edit` only what changed. Both pictures are cleaned to binary alpha first (`cleanPicture`). The changed area is where they show something
 * different (a colour that no pixel of the other is near, or a pixel of the figure that the other lacks), without the thin outlines that differ only
 * because one has a sticker and the other has not; specks are dropped; the parts in `keep` are taken out; and what is left is grown by `growRadius`
 * (and taken out of `keep` again), so the cut runs a little way outside what moved, where the two pictures are the same. Inside that area every
 * pixel is the edit's (cleaned, fully opaque), with its silhouette grown by the sticker that the base has and the edit lacks; outside it every pixel is the
 * base's own, byte for byte, so snapping the frame on the base's grid gives the base's snap there. Only the silhouette within `stitchRadius` of a kept part is
 * blended (`stitchSilhouette`); no colour is.
 * @param {{ base: import('./raster.mjs').Raster, edit: import('./raster.mjs').Raster, keep?: { name: string, box: { x: number, y: number, width: number, height: number } }[], settings?: Partial<typeof DEFAULTS> }} request
 */
export function composeFrame({ base, edit, keep = [], settings = {} }) {
    const options = { ...DEFAULTS, ...settings };
    const { width, height } = base;
    if (edit.width !== width || edit.height !== height) {
        throw new Error(`The edit is ${edit.width}x${edit.height} and the base is ${width}x${height}; they must be the same size.`);
    }
    const cleanBase = cleanPicture(base, options.minAlpha, options.maxHole);
    const cleanEdit = cleanPicture(edit, options.minAlpha, options.maxHole);
    const protectedMask = keep.length === 0 ? new Uint8Array(width * height) : unionOf(...keep.map(({ box }) => boxMask(box, width, height)));
    const sticker = stickerExtra({ baseMask: cleanBase.mask, editMask: cleanEdit.mask, within: protectedMask, width, height });
    const grownEdit = growSilhouette(cleanEdit.raster, sticker.radius);

    const changed = dropSpecks(discOpen(differenceMask(cleanBase.raster, grownEdit, options), width, height, options.openRadius), width, height, options.minPixels);
    const joined = options.closeRadius > 0 ? discErode(discDilate(changed, width, height, options.closeRadius), width, height, options.closeRadius) : changed;
    const moved = withoutOf(joined, protectedMask);
    const grown = fillPockets(discDilate(moved, width, height, options.growRadius), width, height, options.maxPocket);
    const cut = withoutOf(grown, protectedMask);

    const composed = createRaster(width, height);
    for (let at = 0; at < cut.length; at++) {
        const source = cut[at] === 1 ? grownEdit : base;
        source.data.copy(composed.data, at * 4, at * 4, at * 4 + 4);
    }
    const frame = stitchSilhouette({ frame: composed, cut, protectedMask, baseMask: cleanBase.mask, editRaster: grownEdit, baseRaster: cleanBase.raster, radius: options.stitchRadius });
    return {
        raster: frame,
        cut,
        moved,
        sticker,
        dropped: { edit: cleanEdit.dropped, base: cleanBase.dropped },
        held: { changedInKeep: countOf(withoutOf(joined, moved)), grownIntoKeep: countOf(withoutOf(grown, cut)) },
        settings: options,
    };
}
