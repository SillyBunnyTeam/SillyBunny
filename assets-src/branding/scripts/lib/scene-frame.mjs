import { opaqueBox } from './raster.mjs';
import { boxOfPixels, changedPixels, masterBoxOf } from './snap-frame.mjs';

const boxText = (box) => `${box.width}x${box.height} at ${box.x},${box.y}`;

/**
 * The scene pixels a swapped layer may change: the pixels in which its frame still differs from its base still, moved to where the layer is
 * placed. The grade and the compositing work one pixel at a time, so a pixel that is the same in both stills comes out the same in both scenes.
 */
function pixelsOfSwap({ id, before, after, placements }, scene) {
    const boxBefore = opaqueBox(before, 1);
    const boxAfter = opaqueBox(after, 1);
    if (before.width !== after.width || before.height !== after.height) {
        throw new Error(`The frame still of "${id}" is ${after.width}x${after.height} art pixels and its base still ${before.width}x${before.height}. A frame is a snap on the base's grid (snap.mjs --grid-from), so the two are the same size.`);
    }
    if (!boxBefore || !boxAfter || ['x', 'y', 'width', 'height'].some((key) => boxBefore[key] !== boxAfter[key])) {
        throw new Error(`The figure of the frame still of "${id}" is at ${boxAfter ? boxText(boxAfter) : 'nowhere'} and the base still's at ${boxBefore ? boxText(boxBefore) : 'nowhere'}. The layer is placed by that box, so the frame would sit differently and everything around it would move.`);
    }
    const allowed = new Set();
    for (const index of changedPixels(before, after)) {
        const x = index % before.width;
        const y = (index - x) / before.width;
        for (const { left, top } of placements) {
            const sceneX = left + x - boxAfter.x;
            const sceneY = top + y - boxAfter.y;
            if (sceneX >= 0 && sceneY >= 0 && sceneX < scene.width && sceneY < scene.height) {
                allowed.add(sceneY * scene.width + sceneX);
            }
        }
    }
    return allowed;
}

/**
 * Checks a scene composed with a frame still in place of a layer's base still against the base scene. The two must be identical except in the
 * pixels of the swapped layers' stills that changed (where the eyes close), wherever the layers sit and whatever grade they have; anything else
 * is refused with the box that differs. A frame that changes no pixel of the scene is refused too, because the swap did nothing.
 * @param {{ base: import('./raster.mjs').Raster, frame: import('./raster.mjs').Raster,
 *   swaps: { id: string, before: import('./raster.mjs').Raster, after: import('./raster.mjs').Raster, placements: { left: number, top: number }[] }[], cell: number, baseName: string }} request
 * @returns {{ changed: number, box: { x: number, y: number, width: number, height: number }, canvasBox: { x: number, y: number, width: number, height: number }, layers: string[] }}
 */
export function checkSceneFrame({ base, frame, swaps, cell, baseName }) {
    if (base.width !== frame.width || base.height !== frame.height) {
        throw new Error(`${baseName} is ${base.width}x${base.height} art pixels and the scene composed is ${frame.width}x${frame.height}: it is not the base scene of this layout.`);
    }
    const allowed = new Set();
    for (const swap of swaps) {
        for (const index of pixelsOfSwap(swap, frame)) {
            allowed.add(index);
        }
    }
    const changed = changedPixels(base, frame);
    if (changed.length === 0) {
        throw new Error(`The scene with ${swaps.map(({ id }) => `"${id}"`).join(', ')} swapped is identical to ${baseName}: no pixel changed, so the swap did nothing.`);
    }
    const outside = changed.filter((index) => !allowed.has(index));
    if (outside.length > 0) {
        const box = boxOfPixels(outside, frame.width);
        throw new Error(`${outside.length} of the ${changed.length} scene pixels that changed from ${baseName} are not pixels the swapped stills changed: they are in the box ${boxText(box)} art px (${boxText(masterBoxOf(box, { cell, offset: { x: 0, y: 0 } }))} canvas px). The base scene was not composed from the other pictures of this layout as they are now, or the frame still moved. Nothing was written.`);
    }
    const box = boxOfPixels(changed, frame.width);
    return { changed: changed.length, box, canvasBox: masterBoxOf(box, { cell, offset: { x: 0, y: 0 } }), layers: swaps.map(({ id }) => id) };
}
