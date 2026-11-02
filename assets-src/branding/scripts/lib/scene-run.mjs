import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { sniffImage } from './images.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { readRaster } from './raster.mjs';
import { resolveOutDir } from './run.mjs';
import { composeGridScene, composeScene } from './scene-compose.mjs';
import { checkSceneFrame } from './scene-frame.mjs';
import { parseLayout } from './scene-layout.mjs';

const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');

/**
 * Composes a scene from a layout file and writes the picture. A real run logs it as a derived output (no model call, so it costs
 * nothing) with the hash of every input picture in `refs`; a `preview` run writes only under out/ and logs nothing, so a placeholder
 * standing in for a picture that has not been made yet never reaches the log.
 * With `grid` the scene is composed on the layout's pixel grid (see `composeGridScene`): each layer uses its snapped still (the layer's `pixel`
 * picture) and the output is the native-size picture, which a real run logs with the grid in `vars`.
 * With `frameOf` (the base scene's picture) the scene is a frame of that scene: `overrides` must swap in frame stills of the layers they name,
 * and the composed scene is checked against the base scene, which it may differ from only in the pixels the frame stills changed. A scene that
 * differs elsewhere is refused before anything is written, and the base scene is logged in `refs` next to the pictures.
 * @param {{ rootDir: string, layoutPath: string, outPath: string, stage?: string, overrides?: Record<string, string>, preview?: boolean, grid?: boolean, frameOf?: string, now: () => Date }} request
 * `overrides` maps a layer id to a picture to use in place of the one the layout names
 */
export async function runComposeScene({ rootDir, layoutPath, outPath, stage, overrides = {}, preview = false, grid = false, frameOf, now }) {
    const absoluteOut = isAbsolute(outPath) ? outPath : resolve(outPath);
    resolveOutDir(rootDir, dirname(absoluteOut));
    const logOut = toLogPath(rootDir, absoluteOut);
    if (preview && !logOut.startsWith('out/')) {
        throw new Error(`A preview is written under out/ only, not ${logOut}, so it cannot be mistaken for a master.`);
    }
    if (!preview && !stage) {
        throw new Error('Pass the stage (such as s5) for a run that is logged.');
    }
    if (existsSync(absoluteOut)) {
        throw new Error(`${logOut} already exists; pick another name or remove it first.`);
    }

    const layout = parseLayout(JSON.parse(readFileSync(layoutPath, 'utf8')));
    const unknown = Object.keys(overrides).filter((id) => !layout.layers.some((layer) => layer.id === id));
    if (unknown.length > 0) {
        throw new Error(`--set names ${unknown.map((id) => `"${id}"`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in the layout. Layers: ${layout.layers.map((layer) => layer.id).join(', ')}.`);
    }
    if (grid && !layout.grid) {
        throw new Error(`${toLogPath(rootDir, resolve(layoutPath))} has no "grid", so --grid cannot compose it. Add { "cell": 4 } (canvas pixels per art pixel) to the layout.`);
    }
    if (frameOf && (!grid || Object.keys(overrides).length === 0)) {
        throw new Error('--frame-of makes a frame of a scene on the pixel grid: pass --grid and --set <layer>=<frame still> with it.');
    }
    const baseScenePath = frameOf ? resolve(rootDir, frameOf) : undefined;
    if (baseScenePath && !existsSync(baseScenePath)) {
        throw new Error(`--frame-of ${frameOf}: the base scene does not exist.`);
    }
    const unsnapped = grid ? layout.layers.filter((layer) => !layer.pixel && !overrides[layer.id]) : [];
    if (unsnapped.length > 0) {
        throw new Error(`Grid mode needs a snapped still for ${unsnapped.map((layer) => `"${layer.id}"`).join(', ')}. Give the layer a "pixel" picture in the layout (such as approved/pixel/<id>.png) or pass --set <layer>=<picture>.`);
    }
    const paths = new Map(layout.layers.map((layer) => [layer.id, resolve(rootDir, overrides[layer.id] ?? (grid ? layer.pixel : layer.image))]));
    const missing = [...paths].filter(([, path]) => !existsSync(path));
    if (missing.length > 0) {
        throw new Error(`Missing pictures: ${missing.map(([id, path]) => `${id} (${toLogPath(rootDir, path)})`).join(', ')}. Make them first, or pass --set <layer>=<picture>.`);
    }

    const pictures = new Map();
    const inputs = [];
    for (const layer of layout.layers) {
        const path = paths.get(layer.id);
        const bytes = readFileSync(path);
        sniffImage(bytes);
        pictures.set(layer.id, await readRaster(path));
        inputs.push({ id: layer.id, file: toLogPath(rootDir, path), sha256: sha256(bytes), z: layer.z });
    }
    const { raster, placements, grid: composed } = grid ? composeGridScene(layout, pictures) : { ...(await composeScene(layout, pictures)), grid: undefined };
    const frame = frameOf ? await checkFrameOfScene({ rootDir, layout, overrides, pictures, placements, raster, baseScenePath, cell: composed.cell }) : undefined;
    const grades = Object.fromEntries(layout.layers.filter((layer) => layer.grade).map((layer) => [layer.id, layer.grade]));

    const png = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
    mkdirSync(dirname(absoluteOut), { recursive: true });
    writeFileSync(absoluteOut, png, { flag: 'wx' });
    if (!preview) {
        const refHashes = [...new Set([...inputs].sort((a, b) => a.z - b.z).map(({ sha256: hash }) => hash).concat(frame ? [frame.base.sha256] : []))];
        appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
            time: now().toISOString(),
            stage,
            provider: 'local',
            model: 'compose-scene',
            template: 'compose-scene',
            vars: {
                layout: toLogPath(rootDir, resolve(layoutPath)),
                inputs: inputs.map(({ id, file }) => `${id}=${file}`),
                placements: placements.map(({ id, left, top, width, height, scale, rings }) => ({ id, left, top, width, height, scale, ...(rings ? { rings } : {}) })),
                // Only for a scene composed on the grid, whose coordinates above are then in art pixels of the native picture.
                ...(composed ? { grid: { cell: composed.cell, width: composed.width, height: composed.height } } : {}),
                // Only for a graded scene, so the line of a scene without grades is as it always was.
                ...(Object.keys(grades).length > 0 ? { grades } : {}),
                // Only for a frame of a scene: the base scene it was checked against, and the pixels that differ from it.
                ...(frame ? { frameOf: frame.base, frame: { changed: frame.changed, box: frame.box, layers: frame.layers } } : {}),
            },
            refHashes,
            size: `${raster.width}x${raster.height}`,
            outputs: [{ file: logOut, sha256: sha256(png) }],
            estimatedUsd: 0,
        }));
    }
    return { file: logOut, placements, inputs, grades, grid: composed, frame, size: { width: raster.width, height: raster.height } };
}

/** Checks the composed frame against its base scene; the layers named in `overrides` are the ones allowed to change, each against the still the layout names. */
async function checkFrameOfScene({ rootDir, layout, overrides, pictures, placements, raster, baseScenePath, cell }) {
    const baseBytes = readFileSync(baseScenePath);
    sniffImage(baseBytes);
    const swaps = [];
    for (const id of Object.keys(overrides)) {
        const layer = layout.layers.find((candidate) => candidate.id === id);
        if (!layer.pixel) {
            throw new Error(`The layer "${id}" has no "pixel" picture in the layout, so there is no base still to check its frame against.`);
        }
        swaps.push({ id, before: await readRaster(resolve(rootDir, layer.pixel)), after: pictures.get(id), placements: placements.filter((placement) => placement.id === id) });
    }
    const baseName = toLogPath(rootDir, baseScenePath);
    const checked = checkSceneFrame({ base: await readRaster(baseScenePath), frame: raster, swaps, cell, baseName });
    return { ...checked, base: { file: baseName, sha256: sha256(baseBytes) } };
}
