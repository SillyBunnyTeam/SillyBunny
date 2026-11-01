import sharp from 'sharp';
import { measureRings, STICKER_BAND, STICKER_RIM } from './pixel-snap.mjs';
import { distanceToMask } from './rim-add.mjs';
import { createRaster, crop, hasBinaryAlpha, opaqueBox } from './raster.mjs';
import { parseHexColour } from './rim-recolour.mjs';
import { gradeRaster } from './scene-grade.mjs';
import { measureFigure, measureFigureScaled } from './scene-measure.mjs';

// Pixels fainter than this are noise left by the model, not part of a picture, so they do not count when trimming.
export const TRIM_ALPHA = 8;

/**
 * The height of every layer in canvas pixels, with `{ ratio, of }` heights worked out from the layer they refer to.
 * A repeating layer has one height per point, so it cannot be the layer another one is measured against.
 * @param {ReturnType<import('./scene-layout.mjs').parseLayout>} layout
 * @returns {Map<string, number>} layer id to its height, for layers that have a single height
 */
export function resolveHeights(layout) {
    const byId = new Map(layout.layers.map((layer) => [layer.id, layer]));
    const resolved = new Map();
    const resolve = (id, path) => {
        if (resolved.has(id)) {
            return resolved.get(id);
        }
        if (path.includes(id)) {
            throw new Error(`The heights of ${[...path, id].join(' -> ')} refer to each other in a circle.`);
        }
        const layer = byId.get(id);
        if (layer.repeat) {
            throw new Error(`Layer "${id}" repeats, so another layer cannot take its height from it.`);
        }
        const height = typeof layer.height === 'number' ? layer.height : resolve(layer.height.of, [...path, id]) * layer.height.ratio;
        if (typeof layer.height !== 'number' && byId.get(layer.height.of).measure !== layer.measure) {
            throw new Error(`Layer "${id}" takes a ratio of "${layer.height.of}", which is measured as ${byId.get(layer.height.of).measure}, not ${layer.measure}.`);
        }
        resolved.set(id, height);
        return height;
    };
    for (const layer of layout.layers.filter(({ repeat }) => !repeat)) {
        resolve(layer.id, []);
    }
    return resolved;
}

/** Draws `source` over `target` at (left, top), by the usual straight alpha rule; whatever falls outside the target is dropped. */
export function over(target, source, left, top) {
    for (let y = 0; y < source.height; y++) {
        const ty = top + y;
        if (ty < 0 || ty >= target.height) {
            continue;
        }
        for (let x = 0; x < source.width; x++) {
            const tx = left + x;
            const from = (y * source.width + x) * 4;
            const alpha = source.data[from + 3] / 255;
            if (tx < 0 || tx >= target.width || alpha === 0) {
                continue;
            }
            const to = (ty * target.width + tx) * 4;
            const below = target.data[to + 3] / 255;
            const outAlpha = alpha + below * (1 - alpha);
            for (let channel = 0; channel < 3; channel++) {
                target.data[to + channel] = Math.round((source.data[from + channel] * alpha + target.data[to + channel] * below * (1 - alpha)) / outAlpha);
            }
            target.data[to + 3] = Math.round(outAlpha * 255);
        }
    }
    return target;
}

async function scale(raster, width, height) {
    const data = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } })
        .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer();
    return { width, height, data };
}

const topLeftOf = ({ x, y }, at, width, height) => ({
    centre: [Math.round(x - width / 2), Math.round(y - height / 2)],
    'bottom-centre': [Math.round(x - width / 2), Math.round(y - height)],
    'top-left': [Math.round(x), Math.round(y)],
})[at];

/**
 * Composes a scene: each layer's picture is trimmed to its alpha box, scaled with Lanczos to its height (keeping its aspect), placed
 * graded if the layer has a `grade`, placed by its anchor and drawn in z order. A `figure` layer is sized by its head-to-feet height, ears left out where they can be told
 * apart, so two characters whose pictures were drawn at different sizes come out at the heights the layout gives them.
 * @param {ReturnType<import('./scene-layout.mjs').parseLayout>} layout
 * @param {Map<string, import('./raster.mjs').Raster>} pictures layer id to its picture
 * @returns {Promise<{ raster: import('./raster.mjs').Raster, placements: object[] }>}
 */
export async function composeScene(layout, pictures) {
    const heights = resolveHeights(layout);
    const canvas = createRaster(layout.canvas.width, layout.canvas.height);
    const placements = [];
    const ordered = layout.layers.map((layer, index) => ({ layer, index })).sort((a, b) => a.layer.z - b.layer.z || a.index - b.index);
    for (const { layer } of ordered) {
        const picture = pictures.get(layer.id);
        if (!picture) {
            throw new Error(`There is no picture for layer "${layer.id}".`);
        }
        const box = opaqueBox(picture, TRIM_ALPHA);
        if (!box) {
            throw new Error(`The picture for layer "${layer.id}" is empty.`);
        }
        const trimmed = crop(picture, box);
        const measured = layer.measure === 'figure' ? measureFigure(trimmed) : undefined;
        const sourceHeight = measured ? measured.figureHeight : trimmed.height;
        const points = layer.repeat ?? [{ x: layer.anchor.x, y: layer.anchor.y, height: heights.get(layer.id) }];
        for (const [pointIndex, point] of points.entries()) {
            const height = typeof point.height === 'number' ? point.height : heights.get(point.height.of) * point.height.ratio;
            const factor = height / sourceHeight;
            const width = Math.max(1, Math.round(trimmed.width * factor));
            const fullHeight = Math.max(1, Math.round(trimmed.height * factor));
            const resized = await scale(trimmed, width, fullHeight);
            const scaled = layer.grade ? gradeRaster(resized, { ...layer.grade, toward: parseHexColour(layer.grade.toward) }) : resized;
            const [left, top] = topLeftOf(point, layer.at, width, fullHeight);
            over(canvas, scaled, left, top);
            placements.push({
                id: layer.id,
                point: pointIndex,
                left,
                top,
                width,
                height: fullHeight,
                scale: Math.round(factor * 1e4) / 1e4,
                measure: layer.measure,
                // How the height was measured, which is `box` when the head could not be told from the ears.
                method: measured?.method ?? 'box',
                targetHeight: Math.round(height * 100) / 100,
            });
        }
    }
    return { raster: canvas, placements };
}

/**
 * Grades a snapped still. With `keepSticker` the pixels of both rings are put back as they were, by the rings' own definition (every
 * pixel within the rim and band widths of transparent space) rather than by the detection that suits smooth art, which in a ring only
 * a few art pixels wide leaves some band pixels at the diagonals to be tinted.
 */
function gradeSnappedStill(picture, grade) {
    const graded = gradeRaster(picture, { ...grade, toward: parseHexColour(grade.toward) });
    if (!grade.keepSticker) {
        return graded;
    }
    const { rimWidth, bandWidth } = measureRings(picture, { rim: STICKER_RIM, band: STICKER_BAND });
    const clear = Uint8Array.from({ length: picture.width * picture.height }, (_, at) => (picture.data[at * 4 + 3] === 0 ? 1 : 0));
    const depth = distanceToMask(clear, picture.width, picture.height);
    for (let at = 0; at < clear.length; at++) {
        if (clear[at] === 0 && depth[at] <= rimWidth + bandWidth + 1e-6) {
            picture.data.copy(graded.data, at * 4, at * 4, at * 4 + 4);
        }
    }
    return graded;
}

/**
 * Composes a scene on the native pixel grid: the canvas divided by `layout.grid.cell` (which may be fractional when the grid is given as a native size), with each layer's snapped still placed as it is, at a
 * whole art pixel, and nothing resized. A layout's anchors are in canvas pixels and become `round(anchor / cell)`; its heights say how tall
 * a figure should come out, but the figure's height is the one it was snapped at, so they are only reported: the height wanted (the
 * canvas height divided by the cell), the height the still has, and, for a layer sized as a ratio of another, the ratio wanted and
 * the ratio the stills give. A grade is applied to the still before it is placed.
 * @param {ReturnType<import('./scene-layout.mjs').parseLayout>} layout a layout with a `grid`
 * @param {Map<string, import('./raster.mjs').Raster>} pictures layer id to its snapped still
 * @returns {{ raster: import('./raster.mjs').Raster, placements: object[], grid: { cell: number, width: number, height: number } }}
 */
export function composeGridScene(layout, pictures) {
    if (!layout.grid) {
        throw new Error('The layout has no "grid", so it cannot be composed on the pixel grid. Add { "cell": 4 } (canvas pixels per art pixel) or { "width": 760, "height": 380 } (art pixels) to it.');
    }
    const { cell, width, height } = layout.grid;
    const heights = resolveHeights(layout);
    const native = { width, height };
    const canvas = createRaster(native.width, native.height);

    const stills = new Map();
    for (const layer of layout.layers) {
        const picture = pictures.get(layer.id);
        if (!picture) {
            throw new Error(`There is no picture for layer "${layer.id}".`);
        }
        if (!hasBinaryAlpha(picture)) {
            throw new Error(`The picture for layer "${layer.id}" has translucent pixels, so it is not a snapped still. Grid mode places pixel art only; snap it first with snap.mjs.`);
        }
        const box = opaqueBox(picture, 1);
        if (!box) {
            throw new Error(`The picture for layer "${layer.id}" is empty.`);
        }
        const trimmed = crop(picture, box);
        const measured = layer.measure === 'figure' ? measureFigureScaled(trimmed) : undefined;
        // The grade is applied to the whole still, then cut to the same box, so the rings read off it are the ones that get placed. They are
        // measured on the still's own canvas, not the trimmed box, which has no transparent pixels beyond its edge.
        const gradedStill = layer.grade ? gradeSnappedStill(picture, layer.grade) : picture;
        const placed = crop(gradedStill, box);
        const rings = layer.measure === 'figure' ? measureRings(gradedStill, { rim: STICKER_RIM, band: STICKER_BAND }) : undefined;
        stills.set(layer.id, { trimmed, placed, measured, artHeight: measured ? measured.figureHeight : trimmed.height, rings });
    }

    const placements = [];
    const ordered = layout.layers.map((layer, index) => ({ layer, index })).sort((a, b) => a.layer.z - b.layer.z || a.index - b.index);
    for (const { layer } of ordered) {
        const { trimmed, placed, measured, artHeight, rings } = stills.get(layer.id);
        const points = layer.repeat ?? [{ x: layer.anchor.x, y: layer.anchor.y, height: layer.height }];
        for (const [pointIndex, point] of points.entries()) {
            const wanted = (typeof point.height === 'number' ? point.height : heights.get(point.height.of) * point.height.ratio) / cell;
            const anchor = { x: Math.round(point.x / cell), y: Math.round(point.y / cell) };
            const [left, top] = topLeftOf(anchor, layer.at, trimmed.width, trimmed.height);
            over(canvas, placed, left, top);
            const ratio = typeof point.height === 'object' ? { of: point.height.of, wanted: point.height.ratio, actual: Math.round((artHeight / stills.get(point.height.of).artHeight) * 1e4) / 1e4 } : undefined;
            placements.push({
                id: layer.id,
                point: pointIndex,
                left,
                top,
                width: trimmed.width,
                height: trimmed.height,
                scale: 1,
                measure: layer.measure,
                method: measured?.method ?? 'box',
                targetHeight: Math.round(wanted * 100) / 100,
                figureHeight: artHeight,
                ...(rings ? { rings } : {}),
                ...(ratio ? { ratio } : {}),
            });
        }
    }
    return { raster: canvas, placements, grid: { cell, ...native } };
}
