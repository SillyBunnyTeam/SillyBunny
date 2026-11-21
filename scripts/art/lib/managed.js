import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampCardVersion } from './card.js';
import { deriveAsset } from './derive.js';
import { outputFile } from './manifest.js';
import { packFolderOf } from './pack-entry.js';
import { ArtProblem } from './problem.js';
import { sha256 } from './raster.js';

/**
 * The bundled items that the app keeps up to date in a user's data folder. The app seeds them from this folder, and its
 * managed manifest records a fingerprint and a version of each: a user's untouched copy of an earlier version is replaced
 * on its own, and an edited card is offered the new version while its `character_version` is lower. A file that changes
 * without a new version never reaches the installs that hold the earlier one.
 */
export const MANAGED_FOLDER = 'default/content';
const APP_MANAGED = new URL('../../../src/sillybunny-managed-content.js', import.meta.url);

/**
 * The managed items that an entry of each type ships, in the app's item types. A card is one file; a pack is the folder of
 * its sprites, which `files` lists by name, and which the app manages as one `sprites` item.
 */
const ITEMS_OF_ENTRY = Object.freeze({
    card: (asset) => asset.outputs.map(({ path }) => ({ type: 'character', path })),
    pack: (asset) => [{ type: 'sprites', path: packFolderOf(asset), files: Object.values(asset.frames).map(({ outputs }) => posix.basename(outputs[0].path)) }],
});

/**
 * How the items of each type are compared with the managed manifest, by the app's own fingerprints, and, for a type whose
 * file carries its own version, how a new version is written into the file. `isCurrent` gives null when a file of the item
 * does not exist, which `check` reports as a missing output.
 */
const ITEM_TYPES = Object.freeze({
    character: {
        changed: 'fingerprint than the file has now',
        isCurrent: (app, root, item, entry, worldNames) => {
            const path = outputFile(root, item.path);
            return existsSync(path) ? app.fingerprintCard(readFileSync(path), { worldNames }) === entry.fingerprint : null;
        },
        stamp: stampCardVersion,
    },
    sprites: {
        changed: 'hashes than the files have now',
        isCurrent: (app, root, item, entry) => {
            const paths = item.files.map((name) => outputFile(root, posix.join(item.path, name)));
            if (!paths.every((path) => existsSync(path))) {
                return null;
            }
            const now = new Map(item.files.map((name, at) => [name, app.fingerprintSpriteFile(readFileSync(paths[at]))]));
            return entry.files.length === now.size && entry.files.every(({ name, sha256: digest }) => now.get(name) === digest);
        },
    },
});

/** @typedef {{ asset: string, item: string, type: string, path: string, from: number, to: number }} ManagedChange */

async function loadAppManaged() {
    try {
        return await import(APP_MANAGED.href);
    } catch (error) {
        throw new ArtProblem('managed-code-missing', `The app's managed content code (${fileURLToPath(APP_MANAGED)}) could not be loaded: ${error.message}. Run npm ci in the repository root first.`);
    }
}

const manifestNameOf = (app) => `${MANAGED_FOLDER}/${app.MANIFEST_FILE_NAME}`;

/**
 * The managed items that the derived entries of the art manifest ship, each with its file name in the managed folder.
 * @param {any} manifest
 * @returns {{ asset: string, type: string, path: string, filename: string }[]}
 */
export function managedItemsOf(manifest) {
    return Object.entries(manifest.assets).flatMap(([asset, entry]) => (ITEMS_OF_ENTRY[entry.type]?.(entry) ?? [])
        .map((item) => ({ ...item, asset, filename: posix.relative(MANAGED_FOLDER, item.path) })));
}

/**
 * Each managed item that the art manifest ships, against what the managed manifest records for it: `current`, `stale`
 * (its file changed since the recorded version), `missing` (the managed manifest does not hold it) or `unreadable`. A
 * file that does not exist is left to `check`, which reports it as a missing output.
 * @throws {ArtProblem} `managed-code-missing`, `managed-invalid`
 */
async function managedStates(root, manifest) {
    const items = managedItemsOf(manifest);
    if (items.length === 0) {
        return { app: null, states: [] };
    }
    const app = await loadAppManaged();
    let recorded;
    try {
        recorded = app.readManifest(join(root, MANAGED_FOLDER));
    } catch (error) {
        throw new ArtProblem('managed-invalid', error.message, { path: manifestNameOf(app) });
    }
    const worldNames = recorded.items.filter(({ type }) => type === 'world').map(({ filename }) => posix.parse(filename).name);
    const states = items.flatMap((item) => {
        const entry = recorded.items.find(({ filename, type }) => filename === item.filename && type === item.type);
        if (!entry) {
            return [{ ...item, state: 'missing' }];
        }
        try {
            const current = ITEM_TYPES[item.type].isCurrent(app, root, item, entry, worldNames);
            return current === null ? [] : [{ ...item, version: entry.version, state: current ? 'current' : 'stale' }];
        } catch (error) {
            return [{ ...item, state: 'unreadable', reason: error.message }];
        }
    });
    return { app, states };
}

function problemOf(app, state) {
    const where = { asset: state.asset, path: state.path };
    if (state.state === 'stale') {
        const stamp = ITEM_TYPES[state.type].stamp ? ' and writes that version into the card\'s character_version' : '';
        return [{ code: 'managed-stale', ...where, message: `${manifestNameOf(app)} records version ${state.version} of ${state.filename} with another ${ITEM_TYPES[state.type].changed}, so installs that hold version ${state.version} would never get this one. Run node scripts/art/cli.js bump --write, which raises it to version ${state.version + 1}${stamp}.` }];
    }
    if (state.state === 'missing') {
        return [{ code: 'managed-missing', ...where, message: `${state.path} ships from the art manifest, but ${manifestNameOf(app)} does not manage it as a ${state.type}. Add it with node scripts/build-managed-manifest.js ${MANAGED_FOLDER} ${state.type}:${state.filename}, and seed it in ${MANAGED_FOLDER}/index.json.` }];
    }
    if (state.state === 'unreadable') {
        return [{ code: 'managed-invalid', ...where, message: `${state.path} could not be fingerprinted as a ${state.type}: ${state.reason}` }];
    }
    return [];
}

/**
 * The problems `check` reports for the managed items that the art manifest ships: a file that no longer matches what the
 * managed manifest records for it, and a file that the managed manifest does not hold.
 * @param {string} root
 * @param {any} manifest
 * @returns {Promise<object[]>}
 */
export async function managedProblems(root, manifest) {
    try {
        const { app, states } = await managedStates(root, manifest);
        return states.flatMap((state) => problemOf(app, state));
    } catch (error) {
        if (error instanceof ArtProblem) {
            return [error.toJSON()];
        }
        throw error;
    }
}

/**
 * The new versions that `bump --write` gives: every managed item that the art manifest ships and that changed since its
 * recorded version goes up by one. A version is written over a card file, so a card file that is not what its entry
 * derives is refused, as is an item that the managed manifest does not hold.
 * @param {string} root
 * @param {any} manifest
 * @returns {Promise<{ changes: ManagedChange[], problems: object[] }>}
 */
export async function planManaged(root, manifest) {
    let found;
    try {
        found = await managedStates(root, manifest);
    } catch (error) {
        if (error instanceof ArtProblem) {
            return { changes: [], problems: [error.toJSON()] };
        }
        throw error;
    }
    const problems = found.states.filter(({ state }) => state !== 'stale').flatMap((state) => problemOf(found.app, state));
    const changes = [];
    for (const state of found.states.filter((one) => one.state === 'stale')) {
        if (ITEM_TYPES[state.type].stamp) {
            let derived;
            try {
                derived = (await deriveAsset(root, state.asset, manifest.assets[state.asset], manifest)).find(({ path }) => path === state.path);
            } catch (error) {
                if (!(error instanceof ArtProblem)) {
                    throw error;
                }
                problems.push({ asset: state.asset, ...error.toJSON() });
                continue;
            }
            if (derived?.sha256 !== sha256(readFileSync(outputFile(root, state.path)))) {
                problems.push({ code: 'managed-underived', asset: state.asset, path: state.path, message: `${state.path} is not the file its entry derives, so its new version cannot be written into it. Run node scripts/art/cli.js derive --write first.` });
                continue;
            }
        }
        changes.push({ asset: state.asset, item: state.filename, type: state.type, path: state.path, from: state.version, to: state.version + 1 });
    }
    return { changes, problems };
}

function writeAtomically(path, bytes) {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
}

/**
 * Gives each planned item its new version by the app's own rules: the version is written into each card file first, and
 * then the managed manifest is built again from the files with the app's builder, which raises the version of a changed
 * item and keeps its earlier fingerprint. The manifest is written in the form scripts/build-managed-manifest.js writes, and
 * the art manifest's sha256 of each rewritten file is updated in place. When the build fails, or changes an item that was
 * not planned, the card files are put back and nothing is written.
 * @param {string} root
 * @param {any} manifest The art manifest, changed in place.
 * @param {ManagedChange[]} changes
 * @returns {Promise<string[]>} The files written.
 * @throws {ArtProblem} `managed-unrelated`, `managed-invalid`, `managed-code-missing`
 */
export async function applyManaged(root, manifest, changes) {
    if (changes.length === 0) {
        return [];
    }
    const app = await loadAppManaged();
    const folder = join(root, MANAGED_FOLDER);
    let previous;
    try {
        previous = app.readManifest(folder);
    } catch (error) {
        throw new ArtProblem('managed-invalid', error.message, { path: manifestNameOf(app) });
    }
    const stamped = [];
    for (const change of changes.filter(({ type }) => ITEM_TYPES[type].stamp)) {
        const path = outputFile(root, change.path);
        const before = readFileSync(path);
        stamped.push({ change, path, before, after: await ITEM_TYPES[change.type].stamp(before, change.to) });
    }
    for (const { path, after } of stamped) {
        writeAtomically(path, after);
    }
    let built;
    try {
        built = app.buildManifest({ bundledDirectory: folder, entries: previous.items.map(({ filename, type }) => ({ filename, type })), previous });
        const planned = (item) => changes.some((change) => change.item === item.filename && change.type === item.type && change.to === item.version);
        const unplanned = built.items.filter((item, at) => JSON.stringify(item) !== JSON.stringify(previous.items[at]) && !planned(item));
        if (unplanned.length > 0) {
            throw new ArtProblem('managed-unrelated', `${unplanned.map(({ filename }) => filename).join(', ')} changed since the versions ${manifestNameOf(app)} records, and the art manifest does not ship them. Check them, then run node scripts/build-managed-manifest.js ${MANAGED_FOLDER}.`);
        }
    } catch (error) {
        for (const { path, before } of stamped) {
            writeAtomically(path, before);
        }
        throw error instanceof ArtProblem ? error : new ArtProblem('managed-invalid', error.message, { path: manifestNameOf(app) });
    }
    for (const { change, after } of stamped) {
        for (const output of manifest.assets[change.asset].outputs.filter(({ path }) => path === change.path)) {
            output.sha256 = sha256(after);
        }
    }
    const written = stamped.map(({ change }) => change.path);
    const manifestPath = join(folder, app.MANIFEST_FILE_NAME);
    const text = `${JSON.stringify(built, null, 4)}\n`;
    if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== text) {
        writeAtomically(manifestPath, text);
        written.push(manifestNameOf(app));
    }
    return written;
}
