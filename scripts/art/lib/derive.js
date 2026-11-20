import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { deriveCard } from './card.js';
import { encode } from './codec.js';
import { frameBox, renderFrame, SUBJECT_ALPHA } from './frame.js';
import { encodeIco } from './ico.js';
import { masterFile, outputsOf, parseRatio } from './manifest.js';
import { buildPlayerDescription, isRunDescription } from './motion.js';
import { placementOf } from './placement.js';
import { ArtProblem } from './problem.js';
import { createRaster, hasBinaryAlpha, isOpaque, opaqueBox, paste, readRaster, samePixels, sha256, upscaleNearest } from './raster.js';
import { fitScene } from './scene-fit.js';

/**
 * A file as the derive makes it. A `picture` or an `ico` may be compared by its decoded pixels on a platform whose
 * encoder gives other bytes, and a `card` by its decoded pixels and its card text; `data`, such as a motion description,
 * is compared by its bytes everywhere.
 * @typedef {{ path: string, bytes: Buffer, sha256: string, kind: 'picture' | 'card' | 'ico' | 'data' }} DerivedFile
 */

const DERIVERS = Object.freeze({
    still: deriveStill,
    scene: deriveScene,
    pair: derivePair,
    icon: deriveIcon,
    ico: deriveIco,
    copy: deriveCopy,
    card: (context, asset) => deriveCard(context, asset, { readMaster }),
});

export { placementOf };

/** Whether the files of an asset are made from masters, as opposed to pinned by their sha256. */
export const isDerived = (asset) => Object.hasOwn(DERIVERS, asset.type);

/**
 * Makes every file of an asset in memory. Nothing is written.
 * @param {string} root The checkout.
 * @param {string} id
 * @param {any} asset A valid manifest asset.
 * @param {any} manifest The manifest that holds the asset, which an ICO reads its icons from.
 * @returns {Promise<DerivedFile[]>}
 * @throws {ArtProblem} When a master is missing or does not fit its placement.
 */
export async function deriveAsset(root, id, asset, manifest) {
    if (!isDerived(asset)) {
        throw new ArtProblem('not-derived', `${id} is ${asset.type}, so it has no master to derive from.`, { asset: id });
    }
    return DERIVERS[asset.type]({ root, id, manifest }, asset);
}

async function readMaster({ root, id }, master, { native = true } = {}) {
    const path = masterFile(root, master);
    if (!existsSync(path)) {
        throw new ArtProblem('master-missing', `The master ${master} does not exist.`, { asset: id, path: master });
    }
    const raster = await readRaster(path);
    // A native-grid master of a figure has one art pixel per image pixel, so a translucent pixel is a soft edge that
    // would ship as one. An icon is drawn smooth at its own size, so it may have them.
    if (native && !hasBinaryAlpha(raster)) {
        throw new ArtProblem('master-not-native', `The master ${master} has translucent pixels, so it is not a native-grid master.`, { asset: id, path: master });
    }
    return raster;
}

function checkGrid({ id }, raster, grid, what) {
    if (raster.width !== grid[0] || raster.height !== grid[1]) {
        throw new ArtProblem('grid-mismatch', `${what} is ${raster.width}x${raster.height} art pixels, but its placement grid is ${grid[0]}x${grid[1]}.`, {
            asset: id,
            expected: grid,
            actual: [raster.width, raster.height],
        });
    }
    return raster;
}

async function encodeOutputs(raster, outputs) {
    const files = [];
    for (const output of outputs) {
        const scaled = (output.scale ?? 1) > 1 ? upscaleNearest(raster, output.scale) : raster;
        const bytes = await encode(scaled, output.encoding);
        files.push({ path: output.path, bytes, sha256: sha256(bytes), kind: 'picture' });
    }
    return files;
}

async function deriveStill(context, asset) {
    const place = placementOf(context, asset);
    const baseMaster = asset.master ? await readMaster(context, asset.master) : null;
    const base = baseMaster ? place(baseMaster) : null;
    const baseBox = base ? frameBox(base, asset.frame) : null;
    const files = [];
    if (base) {
        const framed = checkGrid(context, renderFrame(base, baseBox), asset.grid, 'The still');
        files.push(...await encodeOutputs(framed, asset.outputs.filter((output) => output.from === undefined)));
    }
    const frames = new Map();
    for (const [name, frame] of Object.entries(asset.frames ?? {})) {
        const master = await readMaster(context, frame.master);
        const picture = place(master);
        const box = base ? baseFrameBox(context, { baseMaster, baseBox }, { master, picture, name }) : frameBox(picture, asset.frame);
        const framed = checkGrid(context, renderFrame(picture, box), asset.grid, `The frame ${name}`);
        frames.set(name, framed);
        files.push(...await encodeOutputs(framed, frame.outputs));
    }
    for (const output of asset.outputs.filter((candidate) => candidate.from !== undefined)) {
        files.push(...await encodeOutputs(frames.get(output.from), [output]));
    }
    if (asset.motion) {
        files.push(await copyMotion(context, asset));
    }
    return files;
}

/**
 * A frame is cut with the base's box, so it lines up with the base pixel for pixel. That holds only while the frame's
 * master has the base master's canvas, and the cut keeps the whole frame only while its figure lies inside the box.
 * The canvases are compared before a fit, because two canvases of different sizes may fit to one size.
 */
function baseFrameBox({ id }, { baseMaster, baseBox }, { master, picture, name }) {
    if (master.width !== baseMaster.width || master.height !== baseMaster.height) {
        throw new ArtProblem('frame-size', `The frame ${name} is ${master.width}x${master.height}, but the base master is ${baseMaster.width}x${baseMaster.height}.`, { asset: id });
    }
    const figure = opaqueBox(picture, SUBJECT_ALPHA);
    if (figure && (figure.x < baseBox.x || figure.y < baseBox.y || figure.x + figure.width > baseBox.x + baseBox.width || figure.y + figure.height > baseBox.y + baseBox.height)) {
        throw new ArtProblem('frame-box', `The figure of the frame ${name} reaches past the base's box, so the cut would lose part of it.`, { asset: id });
    }
    return baseBox;
}

async function deriveScene(context, asset) {
    const { id } = context;
    const { p, q } = parseRatio(asset.ratio);
    if (p !== q) {
        return deriveFittedScene(context, asset);
    }
    const base = await readMaster(context, asset.master);
    const box = frameBox(base, asset.frame);
    const still = checkGrid(context, renderFrame(base, box), asset.grid, 'The scene');
    const files = await encodeOutputs(still, asset.outputs);
    const composed = createRaster(asset.grid[0], asset.grid[1]);
    if (asset.backdrop) {
        // The backdrop is drawn on the scene master's canvas and cut with the still's box, so it lies on the still's pixels.
        const drawn = await readMaster(context, asset.backdrop.master);
        if (drawn.width !== base.width || drawn.height !== base.height) {
            throw new ArtProblem('backdrop-size', `The backdrop is ${drawn.width}x${drawn.height}, but the scene master is ${base.width}x${base.height}.`, { asset: id });
        }
        const backdrop = renderFrame(drawn, box);
        files.push(...await encodeOutputs(backdrop, asset.backdrop.outputs));
        paste(composed, backdrop, 0, 0);
    }
    for (const [layerId, layer] of Object.entries(asset.layers)) {
        const [left, top, width, height] = layer.box;
        if (left < 0 || top < 0 || left + width > asset.grid[0] || top + height > asset.grid[1]) {
            throw new ArtProblem('layer-box', `The box of layer ${layerId} reaches past the scene.`, { asset: id });
        }
        if (!layer.pictures[asset.compose.pose]) {
            throw new ArtProblem('composition-mismatch', `Layer ${layerId} has no "${asset.compose.pose}" picture to compose the still from.`, { asset: id });
        }
        for (const [name, picture] of Object.entries(layer.pictures)) {
            const raster = checkGrid(context, await readMaster(context, picture.master), [width, height], `The picture ${name} of layer ${layerId}`);
            files.push(...await encodeOutputs(raster, picture.outputs));
            if (name === asset.compose.pose) {
                paste(composed, raster, left, top);
            }
        }
    }
    // The player lays the layer pictures over the backdrop at whole art pixels, so they must give the still back exactly.
    if (!samePixels(composed, still)) {
        throw new ArtProblem('composition-mismatch', `The backdrop and the "${asset.compose.pose}" pictures of the layers, drawn in order, do not give the still.`, { asset: id });
    }
    files.push(await copyMotion(context, asset));
    return files;
}

/**
 * A scene at a ratio above 1. Its layers are measured on the placement grid, not read from the manifest: each layer's
 * `box` is where `fitScene` finds the layer's pictures, so the manifest's box is only a record of it. The files carry
 * `layerBoxes`, which `derive --write` records and `prove` compares.
 * @returns {Promise<DerivedFile[] & { layerBoxes: Record<string, number[]> }>}
 */
async function deriveFittedScene(context, asset) {
    const { id } = context;
    const place = placementOf(context, asset);
    const run = await readRunOf(context, asset);
    const master = await readMaster(context, asset.master);
    let backdrop = null;
    if (asset.backdrop) {
        backdrop = await readMaster(context, asset.backdrop.master);
        if (backdrop.width !== master.width || backdrop.height !== master.height) {
            throw new ArtProblem('backdrop-size', `The backdrop is ${backdrop.width}x${backdrop.height}, but the scene master is ${master.width}x${master.height}.`, { asset: id });
        }
    }
    const layers = [];
    for (const [layerId, layer] of Object.entries(asset.layers)) {
        const placed = run.breath.layers.find((candidate) => candidate.id === layerId);
        if (!placed || !['left', 'top', 'width', 'height'].every((key) => Number.isInteger(placed[key]))) {
            throw new ArtProblem('motion-mismatch', `${asset.motion.master}: the run does not place the layer ${layerId} at whole pixels of the scene's master.`, { asset: id, path: asset.motion.master });
        }
        if (placed.left < 0 || placed.top < 0 || placed.left + placed.width > master.width || placed.top + placed.height > master.height) {
            throw new ArtProblem('layer-box', `The layer ${layerId} reaches past the scene's master.`, { asset: id });
        }
        if (!layer.pictures[asset.compose.pose]) {
            throw new ArtProblem('composition-mismatch', `Layer ${layerId} has no "${asset.compose.pose}" picture to compose the still from.`, { asset: id });
        }
        const pictures = {};
        for (const [name, picture] of Object.entries(layer.pictures)) {
            pictures[name] = checkGrid(context, await readMaster(context, picture.master), [placed.width, placed.height], `The picture ${name} of layer ${layerId}`);
        }
        layers.push({ id: layerId, z: placed.z, left: placed.left, top: placed.top, pictures });
    }
    // A stable sort, so layers of one z keep the order of the manifest.
    layers.sort((one, other) => one.z - other.z);
    const fitted = fitScene({ id, master, backdrop, layers, pose: asset.compose.pose, place, frame: asset.frame });
    const files = await encodeOutputs(checkGrid(context, fitted.still, asset.grid, 'The scene'), asset.outputs);
    if (asset.backdrop) {
        files.push(...await encodeOutputs(fitted.backdrop, asset.backdrop.outputs));
    }
    const measured = structuredClone(asset);
    for (const [layerId, layer] of Object.entries(asset.layers)) {
        measured.layers[layerId].box = fitted.layers[layerId].box;
        for (const [name, picture] of Object.entries(layer.pictures)) {
            files.push(...await encodeOutputs(fitted.layers[layerId].pictures[name], picture.outputs));
        }
    }
    files.push(await copyMotion(context, measured));
    return Object.assign(files, { layerBoxes: Object.fromEntries(Object.entries(fitted.layers).map(([layerId, { box }]) => [layerId, box])) });
}

/** The layers of a scene at a fit whose recorded box is not the box the derive measured. */
export function staleLayerBoxes(asset, files) {
    return Object.entries(files.layerBoxes ?? {})
        .filter(([layer, box]) => box.some((value, at) => value !== asset.layers[layer].box[at]))
        .map(([layer, box]) => ({ layer, recorded: asset.layers[layer].box, box }));
}

/** The run's description of a fitted scene, which places each layer in the master's pixels. */
async function readRunOf({ root, id }, asset) {
    const { master } = asset.motion;
    const path = masterFile(root, master);
    if (!existsSync(path)) {
        throw new ArtProblem('master-missing', `The motion description ${master} does not exist.`, { asset: id, path: master });
    }
    let run;
    try {
        run = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new ArtProblem('motion-invalid', `${master} is not JSON: ${error.message}`, { asset: id, path: master });
    }
    if (!isRunDescription(run) || run.kind !== 'motion-frames' || !Array.isArray(run.breath?.layers)) {
        throw new ArtProblem('motion-invalid', `${master}: ${id} is a scene at the ratio ${asset.ratio}, so its layers are measured on the placement grid, and that needs a run's description of motion frames, which places each layer in the master's pixels.`, { asset: id, path: master });
    }
    return run;
}

/**
 * A picture and the same picture at twice its size, as the greeting ships. The whole canvas ships. An opaque pair is
 * written without an alpha channel even when its master has one, because the shipped files have none.
 */
async function derivePair(context, asset) {
    const master = await readMaster(context, asset.master);
    if (asset.opaque && !isOpaque(master)) {
        throw new ArtProblem('master-not-opaque', `The master ${asset.master} has transparent pixels, but the pair is opaque.`, { asset: context.id, path: asset.master });
    }
    const placed = placementOf(context, asset)(asset.opaque ? { ...master, channels: 3 } : master);
    return encodeOutputs(checkGrid(context, placed, asset.grid, 'The pair'), asset.outputs);
}

async function deriveIcon(context, asset) {
    const picture = checkGrid(context, await readMaster(context, asset.master, { native: false }), asset.grid, 'The icon');
    return encodeOutputs(picture, asset.outputs);
}

async function deriveIco(context, asset) {
    const entries = [];
    for (const entry of asset.entries) {
        const icon = context.manifest.assets[entry];
        const [first] = await deriveIcon({ ...context, id: entry }, icon);
        entries.push({ size: icon.grid[0], png: first.bytes });
    }
    const bytes = encodeIco(entries);
    return asset.outputs.map(({ path }) => ({ path, bytes, sha256: sha256(bytes), kind: 'ico' }));
}

/** A master that is shipped as it is, such as the vector logo. */
function deriveCopy({ root, id }, asset) {
    const path = masterFile(root, asset.master);
    if (!existsSync(path)) {
        throw new ArtProblem('master-missing', `The master ${asset.master} does not exist.`, { asset: id, path: asset.master });
    }
    const bytes = readFileSync(path);
    return asset.outputs.map((output) => ({ path: output.path, bytes, sha256: sha256(bytes), kind: 'data' }));
}

/**
 * The motion description ships as it is, or, when a run of the art pipeline left it, as the player's description built
 * from it. Either is checked to name only files of its asset, inside its grid.
 */
async function copyMotion({ root, id }, asset) {
    const { master, output } = asset.motion;
    const path = masterFile(root, master);
    if (!existsSync(path)) {
        throw new ArtProblem('master-missing', `The motion description ${master} does not exist.`, { asset: id, path: master });
    }
    let bytes = readFileSync(path);
    let description;
    try {
        description = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new ArtProblem('motion-invalid', `${master} is not JSON: ${error.message}`, { asset: id, path: master });
    }
    if (isRunDescription(description)) {
        ({ description, bytes } = await buildPlayerDescription({ root, id }, asset, description));
    }
    const fail = (message) => {
        throw new ArtProblem('motion-invalid', `${master}: ${message}`, { asset: id, path: master });
    };
    if (description.grid && (description.grid.width !== asset.grid[0] || description.grid.height !== asset.grid[1])) {
        fail(`its grid is ${description.grid.width}x${description.grid.height}, but the asset's is ${asset.grid[0]}x${asset.grid[1]}.`);
    }
    const shipped = new Set(outputsOf(asset).map((file) => posix.basename(file.path)));
    for (const name of pictureNamesIn(description)) {
        if (!shipped.has(name)) {
            fail(`it names ${name}, which the asset does not ship.`);
        }
    }
    for (const layer of description.layers ?? []) {
        if (layer.left < 0 || layer.top < 0 || layer.left + layer.width > asset.grid[0] || layer.top + layer.height > asset.grid[1]) {
            fail(`the layer ${layer.id} reaches past the grid.`);
        }
    }
    return { path: output, bytes, sha256: sha256(bytes), kind: 'data' };
}

/** Every string in a description that names a picture file. */
function pictureNamesIn(value) {
    if (typeof value === 'string') {
        return /\.(webp|png)$/.test(value) ? [value] : [];
    }
    if (value && typeof value === 'object') {
        return Object.values(value).flatMap(pictureNamesIn);
    }
    return [];
}
