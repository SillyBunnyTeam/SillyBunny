import { fitToGrid, placementStep } from './fit.js';
import { parseRatio } from './manifest.js';
import { upscaleNearest } from './raster.js';
import { rebuildRings } from './rings.js';

/**
 * Brings a master onto its placement grid. This comes before the frame is cut, so the frame's margin counts placement
 * pixels. A fitted master gets its sticker painted again on its own canvas, where a figure cut by the canvas border has
 * no edge along the cut; the frame's padding would give it one.
 * @param {{ id: string }} context
 * @param {any} asset
 * @returns {(raster: import('./raster.js').Raster) => import('./raster.js').Raster}
 * @throws {ArtProblem} When the ratio is one the derive refuses.
 */
export function placementOf({ id }, asset) {
    const ratio = parseRatio(asset.ratio);
    const { step, factor } = placementStep(ratio, id);
    if (step === 'enlarge') {
        return (raster) => upscaleNearest(raster, factor);
    }
    if (step === 'fit') {
        return (raster) => {
            const fitted = fitToGrid(raster, ratio);
            return asset.rings ? rebuildRings(fitted, asset.rings).raster : fitted;
        };
    }
    return (raster) => raster;
}
