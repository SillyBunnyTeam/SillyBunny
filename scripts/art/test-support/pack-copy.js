import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { encode } from '../lib/codec.js';
import { MASTER_ROOT, readManifest } from '../lib/manifest.js';
import { sha256 } from '../lib/raster.js';
import { sampleRecord } from './manifests.js';
import { REPO_ROOT, paint } from './pictures.js';
import { copyOfArt, writeFixtureManifest } from './repos.js';

export const REISEN_PACK_FOLDER = 'default/content/Assistant Reisen';
export const PACK_STEP = 4;
export const PACK_GRID = [8, 12];
const MANAGED_FILES = Object.freeze(['sillybunny-managed.json', 'SillyBunny Lexicon.json']);

/** The master path of an expression of the pack that the tests build. */
export const packMasterOf = (name) => `reisen/expressions/${name}.png`;

/**
 * A figure on an 8x12 canvas with a hard alpha: a head over a body cut by the bottom edge. `mark` moves the eyes, so each
 * expression of a pack differs from the next.
 * @param {number} mark
 */
export const packSprite = (mark = 0) => paint(...PACK_GRID, (x, y) => {
    if (y >= 2 && y < 5 && x >= 3 && x < 6) {
        return y === 3 && x === 3 + (mark % 3) ? [30, 20, 60, 255] : [250, 220, 200, 255];
    }
    return y >= 5 && x >= 1 && x < 7 ? [90, 60, 140, 255] : [0, 0, 0, 0];
});

/**
 * A copy of the checkout's art with its pinned files and the managed content, in which `expressions-reisen` is a pack entry
 * made of synthetic 8x12 masters at step 4, with a provenance record for each. Nothing is derived yet, so the files of the
 * pack are still the shipped ones.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ root: string, names: string[] }>}
 */
export async function copyWithPack(t) {
    const root = copyOfArt(t, { pinned: true });
    for (const file of MANAGED_FILES) {
        cpSync(join(REPO_ROOT, 'default/content', file), join(root, 'default/content', file));
    }
    const { manifest } = readManifest(root);
    const pinned = manifest.assets['expressions-reisen'].outputs;
    const names = pinned.map(({ path }) => posix.basename(path, '.webp'));
    const frames = {};
    for (const [at, name] of names.entries()) {
        const bytes = await encode(packSprite(at), 'png');
        const master = packMasterOf(name);
        mkdirSync(join(root, MASTER_ROOT, 'reisen/expressions'), { recursive: true });
        writeFileSync(join(root, MASTER_ROOT, master), bytes);
        writeFileSync(join(root, MASTER_ROOT, master.replace(/\.png$/, '.provenance.json')), `${JSON.stringify({ ...sampleRecord(), file: `${name}.png`, sha256: sha256(bytes) }, null, 4)}\n`);
        frames[name] = { master, outputs: [{ path: pinned[at].path, encoding: 'webp-lossless', scale: PACK_STEP, sha256: pinned[at].sha256 }] };
    }
    manifest.assets['expressions-reisen'] = { type: 'pack', key: null, grid: PACK_GRID, frames };
    writeFixtureManifest(root, manifest);
    return { root, names };
}
