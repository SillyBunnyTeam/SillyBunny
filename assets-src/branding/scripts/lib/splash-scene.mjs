import { createRaster, crop, opaqueBox, unionBox } from './raster.mjs';
import { over } from './scene-compose.mjs';
import { discDilate } from './frame-mask.mjs';

/** One character as layer frames: every pose is cut to the box that holds the figure in all of them, so the layer has one placement whichever pose shows. */
export function layerOf(poses) {
    const names = [...poses.keys()];
    const box = unionBox(names.map((name) => {
        const found = opaqueBox(poses.get(name), 1);
        if (!found) {
            throw new Error(`The pose "${name}" is empty.`);
        }
        return found;
    }));
    const frames = new Map(names.map((name) => [name, crop(poses.get(name), box)]));
    const first = frames.get(names[0]);
    const silhouette = new Uint8Array(first.width * first.height);
    for (const frame of frames.values()) {
        for (let at = 0; at < silhouette.length; at++) {
            silhouette[at] |= frame.data[at * 4 + 3] === 0 ? 0 : 1;
        }
    }
    return { box, width: first.width, height: first.height, frames, silhouette };
}

/** The silhouette of a layer grown by `gap` pixels, on a canvas that is `gap` pixels larger on every side so the growth is not cut off at the layer's box. */
function spreadBy({ silhouette, width, height }, gap) {
    const padded = { width: width + 2 * gap, height: height + 2 * gap, mask: new Uint8Array((width + 2 * gap) * (height + 2 * gap)) };
    for (let y = 0; y < height; y++) {
        padded.mask.set(silhouette.subarray(y * width, (y + 1) * width), (y + gap) * padded.width + gap);
    }
    return { ...padded, mask: discDilate(padded.mask, padded.width, padded.height, gap) };
}

function overlapsAt(fixed, moving, dx, dy) {
    for (let y = 0; y < moving.height; y++) {
        const fy = y + dy;
        if (fy < 0 || fy >= fixed.height) {
            continue;
        }
        for (let x = 0; x < moving.width; x++) {
            const fx = x + dx;
            if (fx >= 0 && fx < fixed.width && moving.mask[y * moving.width + x] === 1 && fixed.mask[fy * fixed.width + fx] === 1) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Lays two characters out side by side on one grid: the feet (the last row of each figure's box) on a common row, the right one as near to the left
 * one as it can be with no pixel of one closer than `gap` art pixels to a pixel of the other in any pose of either. The canvas is the two boxes with `margin`
 * art pixels around them. Each layer's `left` and `top` are where its frame goes on that canvas.
 * @param {{ left: ReturnType<typeof layerOf> & { id: string }, right: ReturnType<typeof layerOf> & { id: string }, gap: number, margin: number }} request
 */
export function layOutPair({ left, right, gap, margin }) {
    const spread = spreadBy(left, gap);
    const moving = { mask: right.silhouette, width: right.width, height: right.height };
    const dy = left.height - right.height;
    let dx = 0;
    while (overlapsAt(spread, moving, dx + gap, dy + gap)) {
        dx++;
        if (dx > left.width + right.width) {
            throw new Error('The two characters cannot be laid out side by side without touching.');
        }
    }
    const top = Math.min(0, dy);
    const placed = [
        { ...left, z: 1, left: 0, top: -top },
        { ...right, z: 2, left: dx, top: dy - top },
    ];
    const width = Math.max(left.width, dx + right.width);
    const height = Math.max(left.height, right.height);
    return { width: width + 2 * margin, height: height + 2 * margin, margin, gap, layers: placed.map((layer) => ({ ...layer, left: layer.left + margin, top: layer.top + margin })) };
}

/** The scene with every layer showing the pose `poseOf(layerId)` names, drawn in z order. */
export function drawLayers({ width, height, layers, poseOf }) {
    const canvas = createRaster(width, height);
    for (const layer of [...layers].sort((a, b) => a.z - b.z)) {
        const frame = layer.frames.get(poseOf(layer.id));
        if (!frame) {
            throw new Error(`The layer ${layer.id} has no pose "${poseOf(layer.id)}".`);
        }
        over(canvas, frame, layer.left, layer.top);
    }
    return canvas;
}
