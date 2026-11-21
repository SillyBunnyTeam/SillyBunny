import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { approvedName, readLog, sha256 } from './log.mjs';
import { createRaster, crop, opaqueBox, readRaster, unionBox } from './raster.mjs';
import { composeGridScene, gradeSnappedStill, over } from './scene-compose.mjs';
import { parseLayout } from './scene-layout.mjs';
import { VARIANTS } from './breath-pose.mjs';

const PIXEL_DIR = 'approved/pixel';

/**
 * The compose-scene line of the grid scene that was approved as `<scene>.png`. The latest such line wins, so a scene composed again and
 * approved again is the one read.
 * @param {string} rootDir
 * @param {string} scene
 */
export function findApprovedSceneEntry(rootDir, scene) {
    const wanted = `${scene}.png`;
    const entries = readLog(join(rootDir, 'log', 'generations.jsonl')).filter((entry) => entry.template === 'compose-scene' && entry.vars?.grid && entry.outputs.some((output) => output.approved && basename(approvedName(output)) === wanted));
    if (entries.length === 0) {
        throw new Error(`The log has no approved grid scene called ${wanted}. Compose it with compose-scene.mjs --grid and approve it first.`);
    }
    return entries.at(-1);
}

async function readStill(rootDir, name) {
    const path = join(rootDir, ...PIXEL_DIR.split('/'), `${name}.png`);
    if (!existsSync(path)) {
        throw new Error(`${PIXEL_DIR}/${name}.png does not exist.`);
    }
    const bytes = readFileSync(path);
    return { file: `${PIXEL_DIR}/${name}.png`, raster: await readRaster(bytes), sha256: sha256(bytes) };
}

/** The snapped still of a layer and the blink frames (`<still>--half`, `<still>--closed`) that exist for it, each as { file, raster, sha256 }. */
export async function readStillWithBlinks(rootDir, name) {
    const found = { base: await readStill(rootDir, name) };
    for (const variant of VARIANTS.filter((one) => one !== 'base')) {
        if (existsSync(join(rootDir, ...PIXEL_DIR.split('/'), `${name}--${variant}.png`))) {
            found[variant] = await readStill(rootDir, `${name}--${variant}`);
        }
    }
    return found;
}

/**
 * Reads an approved grid scene: the layout and the placements its compose line logged, and the approved stills of its layers. A layer that
 * is measured as a figure is one that breathes; the rest (moon, stars) are the backdrop. The stills are composed again and must give back
 * the approved scene pixel for pixel, and the same placements as the log, or the stills on disk are not the ones the scene was made from.
 * @param {{ rootDir: string, scene: string }} request
 */
export async function loadScene({ rootDir, scene }) {
    const entry = findApprovedSceneEntry(rootDir, scene);
    const layout = parseLayout(JSON.parse(readFileSync(join(rootDir, entry.vars.layout), 'utf8')));
    const layers = [];
    for (const [index, layer] of layout.layers.entries()) {
        if (!layer.pixel) {
            throw new Error(`Layer "${layer.id}" of ${entry.vars.layout} has no "pixel" still.`);
        }
        const still = basename(layer.pixel, '.png');
        const pictures = layer.measure === 'figure' ? await readStillWithBlinks(rootDir, still) : { base: await readStill(rootDir, still) };
        layers.push({ layer, index, still, pictures, isFigure: layer.measure === 'figure' });
    }
    const logged = new Map(entry.vars.placements.map((placement) => [placement.id, placement]));
    const composed = composeGridScene(layout, new Map(layers.map(({ layer, pictures }) => [layer.id, pictures.base.raster])));
    for (const placement of composed.placements) {
        const wanted = logged.get(placement.id);
        if (!wanted || ['left', 'top', 'width', 'height'].some((key) => wanted[key] !== placement[key])) {
            throw new Error(`The approved stills put layer "${placement.id}" at ${placement.left},${placement.top} (${placement.width}x${placement.height}), but the log of ${scene} says ${JSON.stringify(wanted)}.`);
        }
    }
    const approved = await readStill(rootDir, scene);
    if (!approved.raster.data.equals(composed.raster.data) || approved.raster.width !== composed.raster.width) {
        throw new Error(`The approved stills of ${scene} do not compose ${approved.file} pixel for pixel, so they are not the stills it was made from.`);
    }
    const figures = layers.filter(({ isFigure }) => isFigure);
    const statics = layers.filter(({ isFigure }) => !isFigure);
    if (figures.length === 0) {
        throw new Error(`${entry.vars.layout} has no layer measured as a "figure", so nothing in ${scene} breathes.`);
    }
    if (statics.some(({ layer }) => figures.some((figure) => layer.z >= figure.layer.z))) {
        throw new Error(`A static layer of ${scene} is drawn over or with a figure, so it cannot be one backdrop under all the figures.`);
    }
    return { id: scene, entry, layout, grid: composed.grid, scene: approved, placements: new Map(composed.placements.map((placement) => [placement.id, placement])), figures, statics };
}

/**
 * The scene without its figures: the moon and stars, composed as they are in the scene. `null` when the scene has no such layer.
 * @param {Awaited<ReturnType<typeof loadScene>>} scene
 */
export function composeBackdrop({ layout, statics }) {
    if (statics.length === 0) {
        return null;
    }
    const kept = new Set(statics.map(({ layer }) => layer.id));
    const backdropLayout = { ...layout, layers: layout.layers.filter((layer) => kept.has(layer.id)) };
    return composeGridScene(backdropLayout, new Map(statics.map(({ layer, pictures }) => [layer.id, pictures.base.raster]))).raster;
}

/**
 * One figure's poses as layer images. The grade the layer has in the scene is applied to each picture as compose does, after the breath
 * shift; then every picture is cut to one frame, the union of the boxes of all of them, so a layer has one placement whichever pose is
 * showing. The placement is where the frame's top left goes on the scene's grid; the waist row is in the frame's own rows.
 * @param {{ built: ReturnType<typeof import('./breath-pose.mjs').buildBreath>, placement: { left: number, top: number }, grade?: object }} request
 */
export function exportLayer({ built, placement, grade }) {
    const finished = built.poses.map((pose) => ({
        pose,
        variants: Object.fromEntries(Object.entries(pose.variants).map(([variant, { raster }]) => [variant, grade ? gradeSnappedStill(raster, grade) : raster])),
    }));
    const frame = unionBox(finished.flatMap(({ variants }) => Object.values(variants).map((raster) => opaqueBox(raster, 1))));
    const { box, waist } = built;
    return {
        left: placement.left + frame.x - box.x,
        top: placement.top + frame.y - box.y,
        width: frame.width,
        height: frame.height,
        waist: waist - frame.y,
        images: new Map(finished.map(({ pose, variants }) => [pose.name, Object.fromEntries(Object.entries(variants).map(([variant, raster]) => [variant, crop(raster, frame)]))])),
    };
}

/**
 * The scene as one picture with every figure in `pose`, drawn the way the app will: the backdrop, then each layer image at its placement in z order.
 * @param {{ grid: { width: number, height: number }, backdrop: import('./raster.mjs').Raster | null, layers: Array<{ z: number, order: number, left: number, top: number, images: Map<string, { base: import('./raster.mjs').Raster }> }>, pose: string }} request
 */
export function drawScene({ grid, backdrop, layers, pose }) {
    const canvas = backdrop ? { ...backdrop, data: Buffer.from(backdrop.data) } : createRaster(grid.width, grid.height);
    for (const layer of [...layers].sort((a, b) => a.z - b.z || a.order - b.order)) {
        over(canvas, layer.images.get(pose).base, layer.left, layer.top);
    }
    return canvas;
}
