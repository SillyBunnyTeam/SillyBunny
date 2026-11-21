import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('../../assets-src/art/art-manifest.json', import.meta.url));

/**
 * The manifest that `scripts/art` derives the shipped art from. The app's tests read it as data: deriving and the byte
 * proof run in the `scripts/art` package (`npm test --prefix scripts/art`).
 * @returns {{ assets: Record<string, any> }}
 */
export function readArtManifest() {
    return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

/**
 * Every picture an asset ships, with the size in pixels that its placement gives it.
 * @param {any} asset
 * @returns {{ path: string, width: number, height: number }[]}
 */
export function picturesWithSizes(asset) {
    const sized = (outputs, [width, height]) => outputs.map(({ path, scale = 1 }) => ({ path, width: width * scale, height: height * scale }));
    if (!asset.grid) {
        return [];
    }
    const pictures = [...sized(asset.outputs, asset.grid)];
    for (const frame of Object.values(asset.frames ?? {})) {
        pictures.push(...sized(frame.outputs, asset.grid));
    }
    if (asset.backdrop) {
        pictures.push(...sized(asset.backdrop.outputs, asset.grid));
    }
    for (const layer of Object.values(asset.layers ?? {})) {
        for (const picture of Object.values(layer.pictures)) {
            pictures.push(...sized(picture.outputs, layer.box.slice(2)));
        }
    }
    return pictures;
}

/**
 * Every file an asset ships.
 * @param {any} asset
 * @returns {string[]}
 */
export function shippedFilesOf(asset) {
    const files = asset.outputs.map(({ path }) => path);
    for (const frame of Object.values(asset.frames ?? {})) {
        files.push(...frame.outputs.map(({ path }) => path));
    }
    files.push(...(asset.backdrop?.outputs ?? []).map(({ path }) => path));
    for (const layer of Object.values(asset.layers ?? {})) {
        for (const picture of Object.values(layer.pictures)) {
            files.push(...picture.outputs.map(({ path }) => path));
        }
    }
    if (asset.motion) {
        files.push(asset.motion.output);
    }
    return files;
}
