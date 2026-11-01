import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { sniffImage } from './images.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { readRaster } from './raster.mjs';
import { resolveOutDir } from './run.mjs';
import { composeScene } from './scene-compose.mjs';
import { parseLayout } from './scene-layout.mjs';

const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');

/**
 * Composes a scene from a layout file and writes the picture. A real run logs it as a derived output (no model call, so it costs
 * nothing) with the hash of every input picture in `refs`; a `preview` run writes only under out/ and logs nothing, so a placeholder
 * standing in for a picture that has not been made yet never reaches the log.
 * @param {{ rootDir: string, layoutPath: string, outPath: string, stage?: string, overrides?: Record<string, string>, preview?: boolean, now: () => Date }} request
 * `overrides` maps a layer id to a picture to use in place of the one the layout names
 */
export async function runComposeScene({ rootDir, layoutPath, outPath, stage, overrides = {}, preview = false, now }) {
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
    const paths = new Map(layout.layers.map((layer) => [layer.id, resolve(rootDir, overrides[layer.id] ?? layer.image)]));
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
    const { raster, placements } = await composeScene(layout, pictures);
    const grades = Object.fromEntries(layout.layers.filter((layer) => layer.grade).map((layer) => [layer.id, layer.grade]));

    const png = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
    mkdirSync(dirname(absoluteOut), { recursive: true });
    writeFileSync(absoluteOut, png, { flag: 'wx' });
    if (!preview) {
        const refHashes = [...new Set([...inputs].sort((a, b) => a.z - b.z).map(({ sha256: hash }) => hash))];
        appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
            time: now().toISOString(),
            stage,
            provider: 'local',
            model: 'compose-scene',
            template: 'compose-scene',
            vars: {
                layout: toLogPath(rootDir, resolve(layoutPath)),
                inputs: inputs.map(({ id, file }) => `${id}=${file}`),
                placements: placements.map(({ id, left, top, width, height, scale }) => ({ id, left, top, width, height, scale })),
                // Only for a graded scene, so the line of a scene without grades is as it always was.
                ...(Object.keys(grades).length > 0 ? { grades } : {}),
            },
            refHashes,
            size: `${raster.width}x${raster.height}`,
            outputs: [{ file: logOut, sha256: sha256(png) }],
            estimatedUsd: 0,
        }));
    }
    return { file: logOut, placements, inputs, grades, size: { width: raster.width, height: raster.height } };
}
