import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { encode } from './codec.js';
import { frameBox, renderFrame, SUBJECT_ALPHA } from './frame.js';
import { masterFile, outputsOf, parseRatio } from './manifest.js';
import { ArtProblem } from './problem.js';
import { createRaster, hasBinaryAlpha, opaqueBox, paste, readRaster, samePixels, sha256, upscaleNearest } from './raster.js';

/**
 * A file as the derive makes it. `picture` is false for data such as a motion description, which is compared by its
 * bytes on every platform.
 * @typedef {{ path: string, bytes: Buffer, sha256: string, picture: boolean }} DerivedFile
 */

const DERIVERS = Object.freeze({ still: deriveStill, scene: deriveScene });

/** Whether the files of an asset are made from masters, as opposed to pinned by their sha256. */
export const isDerived = (asset) => Object.hasOwn(DERIVERS, asset.type);

/**
 * Makes every file of an asset in memory. Nothing is written.
 * @param {string} root The checkout.
 * @param {string} id
 * @param {any} asset A valid manifest asset.
 * @returns {Promise<DerivedFile[]>}
 * @throws {ArtProblem} When a master is missing or does not fit its placement.
 */
export async function deriveAsset(root, id, asset) {
    if (!isDerived(asset)) {
        throw new ArtProblem('not-derived', `${id} is ${asset.type}, so it has no master to derive from.`, { asset: id });
    }
    return DERIVERS[asset.type]({ root, id }, asset);
}

async function readMaster({ root, id }, master) {
    const path = masterFile(root, master);
    if (!existsSync(path)) {
        throw new ArtProblem('master-missing', `The master ${master} does not exist.`, { asset: id, path: master });
    }
    const raster = await readRaster(path);
    // A native-grid master of a figure has one art pixel per image pixel, so a translucent pixel is a soft edge that
    // would ship as one.
    if (!hasBinaryAlpha(raster)) {
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
        files.push({ path: output.path, bytes, sha256: sha256(bytes), picture: true });
    }
    return files;
}

function requireRatioOne({ id }, asset) {
    const { p, q } = parseRatio(asset.ratio);
    if (p !== q) {
        throw new ArtProblem('ratio-unsupported', `${id} is placed at a ratio of ${asset.ratio}; this derive ships masters at ratio 1 only.`, { asset: id });
    }
}

async function deriveStill(context, asset) {
    requireRatioOne(context, asset);
    const base = asset.master ? await readMaster(context, asset.master) : null;
    const baseBox = base ? frameBox(base, asset.frame) : null;
    const files = [];
    if (base) {
        const framed = checkGrid(context, renderFrame(base, baseBox), asset.grid, 'The still');
        files.push(...await encodeOutputs(framed, asset.outputs.filter((output) => output.from === undefined)));
    }
    const frames = new Map();
    for (const [name, frame] of Object.entries(asset.frames ?? {})) {
        const picture = await readMaster(context, frame.master);
        const box = frame.frame ? frameBox(picture, frame.frame) : base ? baseFrameBox(context, base, baseBox, picture, name) : frameBox(picture, asset.frame);
        const framed = checkGrid(context, renderFrame(picture, box), asset.grid, `The frame ${name}`);
        frames.set(name, framed);
        files.push(...await encodeOutputs(framed, frame.outputs));
    }
    for (const output of asset.outputs.filter((candidate) => candidate.from !== undefined)) {
        files.push(...await encodeOutputs(frames.get(output.from), [output]));
    }
    if (asset.motion) {
        files.push(copyMotion(context, asset));
    }
    return files;
}

/**
 * A frame cut with the base's box lines up with the base pixel for pixel, which holds only while the frame's master has
 * the base master's canvas and its figure stands in the same box.
 */
function baseFrameBox({ id }, base, baseBox, picture, name) {
    if (picture.width !== base.width || picture.height !== base.height) {
        throw new ArtProblem('frame-size', `The frame ${name} is ${picture.width}x${picture.height}, but the base master is ${base.width}x${base.height}.`, { asset: id });
    }
    const [one, other] = [opaqueBox(base, SUBJECT_ALPHA), opaqueBox(picture, SUBJECT_ALPHA)];
    if (['x', 'y', 'width', 'height'].some((key) => one?.[key] !== other?.[key])) {
        throw new ArtProblem('frame-box', `The figure of the frame ${name} stands in another box than the base's, so it would sit differently on the page.`, { asset: id });
    }
    return baseBox;
}

async function deriveScene(context, asset) {
    const { id } = context;
    const { p, q } = parseRatio(asset.ratio);
    if (p !== q) {
        throw new ArtProblem('scene-ratio', `${id} is a scene at a ratio of ${asset.ratio}; a scene is derived at ratio 1 only.`, { asset: id });
    }
    const base = await readMaster(context, asset.master);
    const still = checkGrid(context, renderFrame(base, frameBox(base, asset.frame)), asset.grid, 'The scene');
    const files = await encodeOutputs(still, asset.outputs);
    const composed = createRaster(asset.grid[0], asset.grid[1]);
    if (asset.backdrop) {
        const backdrop = checkGrid(context, await readMaster(context, asset.backdrop.master), asset.grid, 'The backdrop');
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
    files.push(copyMotion(context, asset));
    return files;
}

/** The motion description ships as it is, after a check that it names only files of its asset, inside its grid. */
function copyMotion({ root, id }, asset) {
    const { master, output } = asset.motion;
    const path = masterFile(root, master);
    if (!existsSync(path)) {
        throw new ArtProblem('master-missing', `The motion description ${master} does not exist.`, { asset: id, path: master });
    }
    const bytes = readFileSync(path);
    let description;
    try {
        description = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new ArtProblem('motion-invalid', `${master} is not JSON: ${error.message}`, { asset: id, path: master });
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
    return { path: output, bytes, sha256: sha256(bytes), picture: false };
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
