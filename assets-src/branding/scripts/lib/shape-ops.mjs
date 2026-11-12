// Binary shape operations on a mask (1 = shape, 0 = background) that the logo tools share: opening, components and the bounding box.

const OPAQUE = 128;

/** @param {import('./raster.mjs').Raster} raster */
export const opaqueMask = (raster, minAlpha = OPAQUE) => Uint8Array.from({ length: raster.width * raster.height }, (_, at) => (raster.data[at * 4 + 3] >= minAlpha ? 1 : 0));

/** Counts of shape pixels in the window [at - radius, at + radius] along one line, from a running sum. */
function windowCounts(line, radius) {
    const sums = new Int32Array(line.length + 1);
    for (let at = 0; at < line.length; at++) {
        sums[at + 1] = sums[at] + line[at];
    }
    return Int32Array.from({ length: line.length }, (_, at) => sums[Math.min(line.length, at + radius + 1)] - sums[Math.max(0, at - radius)]);
}

/** One pass of a square window, along rows and then columns: erosion keeps a pixel only if the whole window is shape and inside the canvas. */
function slideWindow(mask, width, height, radius, erode) {
    const pass = (source, lineLength, lineCount, read, write) => {
        const out = new Uint8Array(source.length);
        const line = new Uint8Array(lineLength);
        for (let index = 0; index < lineCount; index++) {
            for (let at = 0; at < lineLength; at++) {
                line[at] = source[read(index, at)];
            }
            const counts = windowCounts(line, radius);
            for (let at = 0; at < lineLength; at++) {
                const full = counts[at] === 2 * radius + 1;
                out[write(index, at)] = (erode ? full : counts[at] > 0) ? 1 : 0;
            }
        }
        return out;
    };
    const byRow = pass(mask, width, height, (y, x) => y * width + x, (y, x) => y * width + x);
    return pass(byRow, height, width, (x, y) => y * width + x, (x, y) => y * width + x);
}

/** Removes everything thinner than 2 * radius + 1 pixels in either direction, and rounds off corners of shapes that are thicker. */
export const openMask = (mask, width, height, radius) => slideWindow(slideWindow(mask, width, height, radius, true), width, height, radius, false);
export const dilateMask = (mask, width, height, radius) => slideWindow(mask, width, height, radius, false);
export const erodeMask = (mask, width, height, radius) => slideWindow(mask, width, height, radius, true);

/**
 * For each shape pixel, the length of the unbroken stretch of shape pixels through it along its row (`horizontal`) or its column.
 * @returns {Uint16Array} 0 for background
 */
export function runLengths(mask, width, height, horizontal) {
    const out = new Uint16Array(mask.length);
    const [outer, inner] = horizontal ? [height, width] : [width, height];
    for (let a = 0; a < outer; a++) {
        let start = 0;
        for (let b = 0; b <= inner; b++) {
            const at = horizontal ? a * width + b : b * width + a;
            if (b < inner && mask[at] === 1) {
                continue;
            }
            for (let c = start; c < b; c++) {
                out[horizontal ? a * width + c : c * width + a] = b - start;
            }
            start = b + 1;
        }
    }
    return out;
}

/**
 * Components of the shape pixels, 8-connected by default; with `connectivity` 4 they are 4-connected, which is how background is
 * labelled when the shape is 8-connected, so a shape never leaks through a diagonal pinch.
 * @returns {{ labels: Int32Array, areas: number[] }} `labels` is 0 for background and 1..n for a component; `areas[k]` is the area of component k + 1
 */
export function labelComponents(mask, width, height, connectivity = 8) {
    const labels = new Int32Array(mask.length);
    const areas = [];
    const queue = new Int32Array(mask.length);
    for (let start = 0; start < mask.length; start++) {
        if (mask[start] === 0 || labels[start] !== 0) {
            continue;
        }
        const label = areas.length + 1;
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        labels[start] = label;
        while (head < tail) {
            const at = queue[head++];
            const x = at % width;
            const y = (at - x) / width;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    const next = ny * width + nx;
                    if (connectivity === 4 && dx !== 0 && dy !== 0) {
                        continue;
                    }
                    if (nx >= 0 && ny >= 0 && nx < width && ny < height && mask[next] === 1 && labels[next] === 0) {
                        labels[next] = label;
                        queue[tail++] = next;
                    }
                }
            }
        }
        areas.push(tail);
    }
    return { labels, areas };
}

/** The mask with every enclosed hole filled: the background that cannot be reached from the canvas border, such as letters cut out of a shape. */
export function fillHoles(mask, width, height) {
    const background = Uint8Array.from(mask, (value) => 1 - value);
    const { labels } = labelComponents(background, width, height, 4);
    const outside = new Set();
    for (let x = 0; x < width; x++) {
        outside.add(labels[x]);
        outside.add(labels[(height - 1) * width + x]);
    }
    for (let y = 0; y < height; y++) {
        outside.add(labels[y * width]);
        outside.add(labels[y * width + width - 1]);
    }
    return Uint8Array.from(mask, (value, at) => (value === 1 || (labels[at] > 0 && !outside.has(labels[at])) ? 1 : 0));
}

/**
 * Splits a picture into its body and what hangs off it: the thin lines, their dots, cords and small charms. The body is whatever
 * survives an opening that removes shapes thinner than `thinWidth`, together with any other piece that is at least `keepShare` of
 * the biggest one. Pixels of the original within the opening's reach of the body stay in it, so the body keeps its true outline and a
 * line leaves a stub of at most `thinWidth` / 2 in the body.
 * The opening is made on the picture with its holes filled, so letters cut out of the body do not leave strips thinner than the
 * window that it would cut away; the holes themselves stay transparent.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ thinWidth: number, keepShare?: number }} options
 * @returns {{ mask: Uint8Array, core: Uint8Array, body: Uint8Array, thin: Uint8Array, radius: number }} pixel masks: everything drawn;
 * the body after the opening (`core`) and after the pixels that the opening rounded off are put back (`body`); and what is not in the body (`thin`)
 */
export function splitThinParts(raster, { thinWidth, keepShare = 0.15 }) {
    if (!Number.isInteger(thinWidth) || thinWidth < 3) {
        throw new Error(`The thin width must be a whole number of pixels, 3 or more; got ${thinWidth}.`);
    }
    const { width, height } = raster;
    const mask = opaqueMask(raster);
    const filled = fillHoles(mask, width, height);
    const radius = Math.floor(thinWidth / 2);
    const opened = openMask(filled, width, height, radius);
    const { labels, areas } = labelComponents(opened, width, height);
    if (areas.length === 0) {
        throw new Error(`Nothing is thicker than ${thinWidth} pixels, so there is no body to keep.`);
    }
    const biggest = Math.max(...areas);
    const core = Uint8Array.from(labels, (label) => (label > 0 && areas[label - 1] >= keepShare * biggest ? 1 : 0));
    const reach = dilateMask(core, width, height, radius);
    const body = Uint8Array.from(mask, (value, at) => (value === 1 && reach[at] === 1 ? 1 : 0));
    const thin = Uint8Array.from(mask, (value, at) => (value === 1 && body[at] === 0 ? 1 : 0));
    return { mask, core, body, thin, radius };
}

/** The picture without the thin parts: the same pixels, byte for byte, where the body is. */
export function dropThinParts(raster, options) {
    const { body } = splitThinParts(raster, options);
    const data = Buffer.alloc(raster.data.length);
    body.forEach((inBody, at) => {
        if (inBody === 1) {
            data.set(raster.data.subarray(at * 4, at * 4 + 4), at * 4);
        }
    });
    return { width: raster.width, height: raster.height, data };
}
