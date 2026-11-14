import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { masterFile, MASTER_ROOT, mastersOf, outputFile, outputsOf, picturesOf } from './manifest.js';
import { needsRecord, recordPathOf, validateRecord } from './provenance.js';
import { hasBinaryAlpha, readRaster, sha256 } from './raster.js';

/** Every file in this folder ships through the manifest, so a file the manifest does not list is a stale one. */
const SHIPPED_ART_FOLDER = 'public/img/sillybunny';

/**
 * The folders whose every file must be an output: the shipped art folder, and each folder under `default/content/`
 * that holds an output, such as an expression pack.
 * @param {any} manifest
 */
export function inventoryFolders(manifest) {
    const folders = new Set([SHIPPED_ART_FOLDER]);
    for (const asset of Object.values(manifest.assets)) {
        for (const { path } of outputsOf(asset)) {
            const folder = posix.dirname(path);
            if (folder.startsWith('default/content/')) {
                folders.add(folder);
            }
        }
    }
    return [...folders].sort();
}

/**
 * @param {string} root
 * @param {any} manifest
 * @returns {{ code: 'unlisted-file', path: string, message: string }[]}
 */
export function unlistedFiles(root, manifest) {
    const listed = new Set(Object.values(manifest.assets).flatMap((asset) => outputsOf(asset).map(({ path }) => path)));
    const problems = [];
    for (const folder of inventoryFolders(manifest)) {
        if (!existsSync(join(root, folder))) {
            continue;
        }
        for (const name of readdirSync(join(root, folder)).sort()) {
            const path = `${folder}/${name}`;
            if (statSync(join(root, folder, name)).isFile() && !listed.has(path)) {
                problems.push({ code: 'unlisted-file', path, message: `${path} ships, but the art manifest does not list it.` });
            }
        }
    }
    return problems;
}

function filesUnder(folder) {
    if (!existsSync(folder)) {
        return [];
    }
    return readdirSync(folder).flatMap((name) => {
        const path = join(folder, name);
        return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
}

/**
 * Checks everything that needs no encoding: the masters exist and are native-grid, each picture master has a current
 * provenance record, no master is left over, every output exists, every pinned file is the one pinned, and nothing
 * ships unlisted.
 * @param {string} root
 * @param {any} manifest A manifest that passed `validateManifest`.
 * @returns {Promise<{ summary: Record<string, number>, problems: object[] }>}
 */
export async function checkArt(root, manifest) {
    const problems = [];
    const masters = new Set();
    const used = new Set();
    let records = 0;
    let incomplete = 0;
    for (const [id, asset] of Object.entries(manifest.assets)) {
        const nativePictures = new Set(picturesOf(asset).map(({ master }) => master));
        for (const master of mastersOf(asset)) {
            masters.add(master);
            used.add(master);
            const path = masterFile(root, master);
            if (!existsSync(path)) {
                problems.push({ code: 'master-missing', asset: id, path: master, message: `The master ${master} does not exist.` });
                continue;
            }
            const bytes = readFileSync(path);
            if (nativePictures.has(master) && ['still', 'scene'].includes(asset.type) && !hasBinaryAlpha(await readRaster(bytes))) {
                problems.push({ code: 'master-not-native', asset: id, path: master, message: `The master ${master} has translucent pixels.` });
            }
            if (!needsRecord(master)) {
                continue;
            }
            const recordPath = recordPathOf(master);
            used.add(recordPath);
            if (!existsSync(masterFile(root, recordPath))) {
                problems.push({ code: 'provenance-missing', asset: id, path: recordPath, message: `The master ${master} has no provenance record.` });
                continue;
            }
            let record;
            try {
                record = JSON.parse(readFileSync(masterFile(root, recordPath), 'utf8'));
            } catch (error) {
                problems.push({ code: 'provenance-invalid', asset: id, path: recordPath, message: `${recordPath} is not JSON: ${error.message}` });
                continue;
            }
            records++;
            incomplete += record.incomplete === undefined ? 0 : 1;
            for (const problem of validateRecord(record, { file: posix.basename(master), sha256: sha256(bytes) })) {
                problems.push({ ...problem, asset: id, path: recordPath });
            }
        }
        for (const output of outputsOf(asset)) {
            const path = outputFile(root, output.path);
            if (!existsSync(path)) {
                problems.push({ code: 'output-missing', asset: id, path: output.path, message: `${output.path} does not exist.` });
            } else if (asset.type === 'pinned' && sha256(readFileSync(path)) !== output.sha256) {
                problems.push({ code: 'pinned-changed', asset: id, path: output.path, message: `${output.path} is not the pinned file, and it has no master to derive it from.` });
            }
        }
    }
    const masterRoot = join(root, MASTER_ROOT);
    for (const path of filesUnder(masterRoot)) {
        const master = relative(masterRoot, path).split(sep).join('/');
        if (!used.has(master)) {
            problems.push({ code: 'master-unused', path: master, message: `${MASTER_ROOT}/${master} is neither a master of the manifest nor a record of one.` });
        }
    }
    problems.push(...unlistedFiles(root, manifest));
    const assets = Object.values(manifest.assets);
    return {
        summary: {
            assets: assets.length,
            derived: assets.filter((asset) => asset.type !== 'pinned').length,
            pinned: assets.filter((asset) => asset.type === 'pinned').length,
            outputs: assets.reduce((sum, asset) => sum + outputsOf(asset).length, 0),
            pinnedFiles: assets.filter((asset) => asset.type === 'pinned').reduce((sum, asset) => sum + asset.outputs.length, 0),
            masters: masters.size,
            records,
            incompleteRecords: incomplete,
        },
        problems,
    };
}
