import { posix } from 'node:path';

/** The most files a sprites item may hold: the app's limit, `MAX_SPRITE_FILES` in `src/sillybunny-managed-content.js`. */
export const MAX_PACK_FILES = 256;
const PACK_KEYS = Object.freeze(['type', 'key', 'grid', 'frames']);
const FOLDER_PATTERN = /^default\/content\/[^/]+$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The folder of a pack under `default/content/`, which the app seeds as one sprites item. Null for an entry that has no
 * output yet or whose first output is not in such a folder; the entry's own check reports that.
 * @param {any} asset
 * @returns {string | null}
 */
export function packFolderOf(asset) {
    const [first] = Object.values(asset.frames ?? {});
    const path = first?.outputs?.[0]?.path;
    const folder = typeof path === 'string' ? posix.dirname(path) : null;
    return folder !== null && FOLDER_PATTERN.test(folder) ? folder : null;
}

/**
 * Checks the shape of a pack entry: an expression pack whose masters are the expressions' native-grid sprites, all on one
 * grid, and whose files are lossless WebP at one whole step, one per expression, named after it, in one folder of
 * `default/content/`. That folder is the sprites item the app manages.
 * @param {any} asset
 * @param {(message: string) => void} fail
 * @param {{ onlyKeys: Function, checkGrid: Function, checkName: Function, checkPicture: Function }} checks
 *   The manifest's own checks of keys, grids, names and pictures.
 */
export function checkPackEntry(asset, fail, { onlyKeys, checkGrid, checkName, checkPicture }) {
    onlyKeys(asset, PACK_KEYS, 'The pack', fail);
    if (asset.key !== null) {
        fail('key must be null: the app seeds a pack from default/content/, which no art cache key covers.');
    }
    checkGrid(asset.grid, fail);
    const frames = asset.frames;
    if (!isPlainObject(frames) || Object.keys(frames).length === 0) {
        fail('frames must name at least one expression: its master and the file that ships it.');
        return;
    }
    if (Object.keys(frames).length > MAX_PACK_FILES) {
        fail(`A pack ships at most ${MAX_PACK_FILES} files, which is what the app's sprites item takes.`);
    }
    const folders = new Set();
    const scales = new Set();
    for (const [name, picture] of Object.entries(frames)) {
        checkName(name, 'An expression', fail);
        checkPicture(picture, `expression ${name}`, fail);
        const outputs = isPlainObject(picture) && Array.isArray(picture.outputs) ? picture.outputs : [];
        if (outputs.length !== 1) {
            fail(`The expression ${name} ships exactly one file, got ${outputs.length}.`);
            continue;
        }
        const [output] = outputs;
        if (output.encoding !== 'webp-lossless') {
            fail(`The file of ${name} must be encoded webp-lossless: a pack is never stored lossy, whatever its size, got ${JSON.stringify(output.encoding)}.`);
        }
        if (typeof output.path === 'string' && posix.basename(output.path) !== `${name}.webp`) {
            fail(`The file of ${name} must be named after it, ${name}.webp, because the app names an expression by its file, got ${posix.basename(output.path)}.`);
        }
        if (output.from !== undefined) {
            fail(`The file of ${name} has the unknown key "from": a pack has no frames to repeat.`);
        }
        scales.add(output.scale ?? 1);
        if (typeof output.path === 'string') {
            folders.add(posix.dirname(output.path));
        }
    }
    if (scales.size > 1) {
        fail(`A pack ships its sprites at one step, so every file has the same scale, got ${[...scales].sort().join(', ')}.`);
    }
    if (folders.size > 1 || (folders.size === 1 && ![...folders].every((folder) => FOLDER_PATTERN.test(folder)))) {
        fail(`A pack ships into one folder directly under default/content/, the sprites item the app manages, got ${[...folders].join(', ')}.`);
    }
}
