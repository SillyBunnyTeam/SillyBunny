import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const MANIFEST_PATH = 'assets-src/art/art-manifest.json';
export const MASTER_ROOT = 'assets-src/art/master';

export const ASSET_TYPES = Object.freeze(['still', 'scene', 'pair', 'icon', 'ico', 'copy', 'pinned']);
export const KEY_GROUPS = Object.freeze(['home', 'splash']);
const PINNED_CHECKS = Object.freeze(['nearest-pair']);
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RATIO_PATTERN = /^([1-9]\d*)(?:\/([1-9]\d*))?$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._@-]*$/;
// Derived files may only be written where the app serves or seeds art from.
const OUTPUT_PREFIXES = Object.freeze(['public/img/', 'default/content/']);
const ROOT_ICON_PATTERN = /^public\/[a-z-]+\.ico$/;

/**
 * @typedef {{ path: string, sha256: string, encoding?: string, scale?: number, from?: string }} Output
 * @typedef {{ master?: string, outputs: Output[] }} Picture
 */

/**
 * @param {string} root The checkout.
 * @param {string} [manifestPath] Relative to `root`.
 * @returns {{ manifest: any, problems: { code: string, asset?: string, message: string }[] }}
 */
export function readManifest(root, manifestPath = MANIFEST_PATH) {
    const path = join(root, manifestPath);
    if (!existsSync(path)) {
        return { manifest: null, problems: [{ code: 'manifest-missing', message: `${manifestPath} does not exist.` }] };
    }
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        return { manifest: null, problems: [{ code: 'manifest-invalid', message: `${manifestPath} is not JSON: ${error.message}` }] };
    }
    return { manifest, problems: validateManifest(manifest) };
}

/**
 * @param {string} text Such as `1` or `3/2`.
 * @returns {{ p: number, q: number } | null} The ratio as master pixels `p` per `q` placement pixels, in lowest terms,
 *   or null when the text is not a ratio.
 */
export function parseRatio(text) {
    const match = typeof text === 'string' ? RATIO_PATTERN.exec(text) : null;
    if (!match) {
        return null;
    }
    const p = Number(match[1]);
    const q = Number(match[2] ?? 1);
    const divisor = greatestCommonDivisor(p, q);
    return { p: p / divisor, q: q / divisor };
}

const greatestCommonDivisor = (a, b) => (b === 0 ? a : greatestCommonDivisor(b, a % b));

/**
 * Every picture of an asset that has a master: the base, its frames, a scene's backdrop and layer pictures.
 * @param {any} asset
 * @returns {{ role: string, master: string, outputs: Output[] }[]}
 */
export function picturesOf(asset) {
    const pictures = [];
    if (asset.master && asset.type !== 'copy') {
        pictures.push({ role: 'base', master: asset.master, outputs: (asset.outputs ?? []).filter((output) => !output.from) });
    }
    for (const [name, frame] of Object.entries(asset.frames ?? {})) {
        pictures.push({ role: `frame ${name}`, master: frame.master, outputs: frame.outputs });
    }
    if (asset.backdrop) {
        pictures.push({ role: 'backdrop', master: asset.backdrop.master, outputs: asset.backdrop.outputs });
    }
    for (const [layerId, layer] of Object.entries(asset.layers ?? {})) {
        for (const [name, picture] of Object.entries(layer.pictures ?? {})) {
            pictures.push({ role: `layer ${layerId} ${name}`, master: picture.master, outputs: picture.outputs });
        }
    }
    return pictures;
}

/**
 * Every file an asset ships, with the sha256 the manifest records for it.
 * @param {any} asset
 * @returns {Output[]}
 */
export function outputsOf(asset) {
    const outputs = [...(asset.outputs ?? [])];
    for (const frame of Object.values(asset.frames ?? {})) {
        outputs.push(...frame.outputs);
    }
    if (asset.backdrop) {
        outputs.push(...asset.backdrop.outputs);
    }
    for (const layer of Object.values(asset.layers ?? {})) {
        for (const picture of Object.values(layer.pictures ?? {})) {
            outputs.push(...picture.outputs);
        }
    }
    if (asset.motion) {
        outputs.push({ path: asset.motion.output, sha256: asset.motion.sha256 });
    }
    return outputs;
}

/**
 * Every master file an asset reads, pictures and motion descriptions alike.
 * @param {any} asset
 * @returns {string[]}
 */
export function mastersOf(asset) {
    const masters = picturesOf(asset).map(({ master }) => master);
    if (asset.type === 'copy') {
        masters.push(asset.master);
    }
    if (asset.motion) {
        masters.push(asset.motion.master);
    }
    return masters;
}

/**
 * The absolute path of a master, refusing one that would leave the master folder.
 * @param {string} root
 * @param {string} master
 */
export function masterFile(root, master) {
    return confined(join(root, MASTER_ROOT), master);
}

/**
 * The absolute path of an output, refusing one that would leave the checkout.
 * @param {string} root
 * @param {string} output
 */
export function outputFile(root, output) {
    return confined(root, output);
}

function confined(base, relative) {
    const target = resolve(base, relative);
    if (target !== resolve(base) && !target.startsWith(resolve(base) + sep)) {
        throw new Error(`${relative} leaves ${base}.`);
    }
    return target;
}

/**
 * Checks the shape of a manifest: every asset's type and fields, every path, and that no two assets ship the same file.
 * @param {any} manifest
 * @returns {{ code: 'manifest-invalid', asset?: string, message: string }[]}
 */
export function validateManifest(manifest) {
    const problems = [];
    const fail = (message, asset) => problems.push({ code: 'manifest-invalid', ...(asset ? { asset } : {}), message });
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
        fail('The manifest must be an object.');
        return problems;
    }
    onlyKeys(manifest, ['format', 'encoder', 'keys', 'assets'], 'The manifest', fail);
    if (manifest.format !== 1) {
        fail(`format must be 1, got ${JSON.stringify(manifest.format)}.`);
    }
    if (!isPlainObject(manifest.encoder) || !Object.values(manifest.encoder).every((value) => typeof value === 'string')) {
        fail('encoder must map each library to the version the shipped bytes were made with.');
    }
    if (manifest.keys !== undefined) {
        checkKeys(manifest.keys, fail);
    }
    if (!isPlainObject(manifest.assets) || Object.keys(manifest.assets).length === 0) {
        fail('assets must hold at least one asset.');
        return problems;
    }
    const seen = new Map();
    for (const [id, asset] of Object.entries(manifest.assets)) {
        const failAsset = (message) => fail(message, id);
        if (!ID_PATTERN.test(id)) {
            failAsset(`The asset id "${id}" must be lowercase letters, digits and hyphens.`);
        }
        if (!isPlainObject(asset) || !ASSET_TYPES.includes(asset.type)) {
            failAsset(`type must be one of ${ASSET_TYPES.join(', ')}.`);
            continue;
        }
        CHECKERS[asset.type](asset, failAsset, manifest.assets);
        for (const output of outputsOf(asset)) {
            if (typeof output?.path !== 'string') {
                continue;
            }
            if (seen.has(output.path)) {
                failAsset(`${output.path} is also an output of ${seen.get(output.path)}.`);
            }
            seen.set(output.path, id);
        }
    }
    return problems;
}

function checkKeys(keys, fail) {
    if (!isPlainObject(keys)) {
        fail('keys must be an object.');
        return;
    }
    onlyKeys(keys, KEY_GROUPS, 'keys', fail);
    for (const [group, key] of Object.entries(keys)) {
        if (!isPlainObject(key) || !/^\d{8}[a-z]$/.test(key.value) || !SHA256_PATTERN.test(key.stamp)) {
            fail(`keys.${group} needs a value such as 20261105a and a sha256 stamp.`);
        }
        if (group === 'splash' && !/^\d{8}[a-z]$/.test(key?.script)) {
            fail('keys.splash needs the script key of sillybunny-splash.js in index.html.');
        }
    }
}

const COMMON_KEYS = ['type', 'key'];
const CHECKERS = {
    still(asset, fail) {
        onlyKeys(asset, [...COMMON_KEYS, 'master', 'ratio', 'frame', 'grid', 'rings', 'outputs', 'frames', 'motion'], 'The still', fail);
        checkKey(asset, fail);
        checkPlacement(asset, fail);
        if (asset.master !== undefined) {
            checkMaster(asset.master, '.png', fail);
        }
        if (asset.frames !== undefined) {
            if (!isPlainObject(asset.frames) || Object.keys(asset.frames).length === 0) {
                fail('frames must name at least one frame.');
            } else {
                for (const [name, frame] of Object.entries(asset.frames)) {
                    checkName(name, 'A frame', fail);
                    checkPicture(frame, `frame ${name}`, fail);
                }
            }
        }
        checkOutputs(asset.outputs, 'outputs', fail, { encoded: true });
        for (const output of asset.outputs ?? []) {
            if (output.from !== undefined && !asset.frames?.[output.from]) {
                fail(`The output ${output.path} repeats the frame "${output.from}", which the still does not have.`);
            }
        }
        if (asset.master === undefined && (asset.outputs ?? []).some((output) => output.from === undefined)) {
            fail('A still with no master of its own must take every output from a frame.');
        }
        if (asset.motion !== undefined) {
            checkMotion(asset.motion, fail);
        }
    },
    scene(asset, fail) {
        onlyKeys(asset, [...COMMON_KEYS, 'master', 'ratio', 'frame', 'grid', 'outputs', 'backdrop', 'layers', 'compose', 'motion'], 'The scene', fail);
        checkKey(asset, fail);
        checkPlacement(asset, fail);
        checkMaster(asset.master, '.png', fail);
        checkOutputs(asset.outputs, 'outputs', fail, { encoded: true });
        if (asset.backdrop !== undefined) {
            checkPicture(asset.backdrop, 'the backdrop', fail);
        }
        if (!isPlainObject(asset.layers) || Object.keys(asset.layers).length === 0) {
            fail('layers must name at least one layer.');
        } else {
            for (const [layerId, layer] of Object.entries(asset.layers)) {
                checkName(layerId, 'A layer', fail);
                onlyKeys(layer, ['box', 'pictures'], `Layer ${layerId}`, fail);
                if (!isWholeList(layer?.box, 4) || layer.box[2] < 1 || layer.box[3] < 1) {
                    fail(`Layer ${layerId} needs a box of [left, top, width, height] in whole art pixels.`);
                }
                if (!isPlainObject(layer?.pictures) || Object.keys(layer.pictures).length === 0) {
                    fail(`Layer ${layerId} needs at least one picture.`);
                    continue;
                }
                for (const [name, picture] of Object.entries(layer.pictures)) {
                    checkName(name, 'A picture', fail);
                    checkPicture(picture, `layer ${layerId} picture ${name}`, fail);
                }
            }
        }
        if (!isPlainObject(asset.compose) || typeof asset.compose.pose !== 'string') {
            fail('compose needs the pose whose pictures, drawn over the backdrop, give the still.');
        }
        checkMotion(asset.motion, fail);
    },
    pair(asset, fail) {
        onlyKeys(asset, [...COMMON_KEYS, 'master', 'ratio', 'grid', 'opaque', 'outputs'], 'The pair', fail);
        checkKey(asset, fail);
        checkMaster(asset.master, '.png', fail);
        checkRatio(asset.ratio, fail);
        checkGrid(asset.grid, fail);
        if (typeof asset.opaque !== 'boolean') {
            fail('opaque must be true or false: whether the pair ships without an alpha channel.');
        }
        checkOutputs(asset.outputs, 'outputs', fail, { encoded: true });
        const outputs = Array.isArray(asset.outputs) ? asset.outputs : [];
        const scales = outputs.map((output) => output?.scale ?? 1);
        if (scales.length !== 2 || scales[0] !== 1 || scales[1] !== 2 || outputs.some((output) => output?.from !== undefined)) {
            fail('A pair ships exactly two outputs: the picture at scale 1, then the same picture at scale 2.');
        }
    },
    icon(asset, fail) {
        onlyKeys(asset, [...COMMON_KEYS, 'master', 'grid', 'outputs'], 'The icon', fail);
        checkKey(asset, fail);
        checkMaster(asset.master, '.png', fail);
        checkGrid(asset.grid, fail);
        checkOutputs(asset.outputs, 'outputs', fail, { encoded: true });
    },
    ico(asset, fail, assets) {
        onlyKeys(asset, [...COMMON_KEYS, 'entries', 'outputs'], 'The ICO', fail);
        checkKey(asset, fail);
        if (!Array.isArray(asset.entries) || asset.entries.length === 0) {
            fail('entries must list the icons the ICO holds, smallest first.');
        } else {
            for (const entry of asset.entries) {
                if (assets[entry]?.type !== 'icon') {
                    fail(`The entry "${entry}" is not an icon of the manifest.`);
                }
            }
        }
        checkOutputs(asset.outputs, 'outputs', fail, { encoded: false });
    },
    copy(asset, fail) {
        onlyKeys(asset, [...COMMON_KEYS, 'master', 'outputs'], 'The copy', fail);
        checkKey(asset, fail);
        checkMaster(asset.master, null, fail);
        checkOutputs(asset.outputs, 'outputs', fail, { encoded: false });
    },
    pinned(asset, fail) {
        onlyKeys(asset, [...COMMON_KEYS, 'reason', 'checks', 'outputs'], 'The pinned asset', fail);
        checkKey(asset, fail);
        if (typeof asset.reason !== 'string' || asset.reason.length === 0) {
            fail('A pinned asset needs the reason it has no master.');
        }
        if (asset.checks !== undefined && (!Array.isArray(asset.checks) || !asset.checks.every((check) => PINNED_CHECKS.includes(check)))) {
            fail(`checks may hold ${PINNED_CHECKS.join(', ')}.`);
        }
        if (asset.checks?.includes('nearest-pair') && asset.outputs?.length !== 2) {
            fail('A nearest pair needs exactly two outputs: the picture and its x2.');
        }
        checkOutputs(asset.outputs, 'outputs', fail, { encoded: false });
    },
};

function checkKey(asset, fail) {
    if (asset.key !== null && !KEY_GROUPS.includes(asset.key)) {
        fail(`key must be null or one of ${KEY_GROUPS.join(', ')}.`);
    }
}

function checkRatio(ratio, fail) {
    if (!parseRatio(ratio)) {
        fail('ratio must be "1" or master pixels per placement pixel as "p/q", such as "3/2".');
    }
}

function checkPlacement(asset, fail) {
    checkRatio(asset.ratio, fail);
    checkFrame(asset.frame, fail);
    checkGrid(asset.grid, fail);
    if (asset.rings !== undefined && asset.rings !== null) {
        const rings = asset.rings;
        if (!isPlainObject(rings) || !Number.isInteger(rings.rim) || rings.rim < 1 || !Number.isInteger(rings.band) || rings.band < 1 || Object.keys(rings).length !== 2) {
            fail('rings must be null or { "rim": <art pixels>, "band": <art pixels> }.');
        }
    }
}

function checkFrame(frame, fail) {
    const isFrame = isPlainObject(frame) && (
        (frame.mode === 'canvas' && Object.keys(frame).length === 1)
        || (frame.mode === 'subject' && Number.isInteger(frame.margin) && frame.margin >= 0 && Object.keys(frame).length === 2)
    );
    if (!isFrame) {
        fail('frame must be { "mode": "canvas" } or { "mode": "subject", "margin": <whole art pixels> }.');
    }
}

function checkGrid(grid, fail) {
    if (!isWholeList(grid, 2) || grid[0] < 1 || grid[1] < 1) {
        fail('grid must be [width, height] in whole art pixels.');
    }
}

function checkPicture(picture, where, fail) {
    if (!isPlainObject(picture)) {
        fail(`${where} must be { "master", "outputs" }.`);
        return;
    }
    onlyKeys(picture, ['master', 'outputs'], where, fail);
    checkMaster(picture.master, '.png', fail);
    checkOutputs(picture.outputs, `${where} outputs`, fail, { encoded: true });
}

function checkMotion(motion, fail) {
    if (!isPlainObject(motion)) {
        fail('motion must be { "master", "output", "sha256" }.');
        return;
    }
    onlyKeys(motion, ['master', 'output', 'sha256'], 'motion', fail);
    checkMaster(motion.master, '.json', fail);
    checkOutputPath(motion.output, fail);
    if (!SHA256_PATTERN.test(motion.sha256 ?? '')) {
        fail(`The sha256 of ${motion.output} must be 64 lowercase hex digits.`);
    }
}

function checkMaster(master, extension, fail) {
    if (typeof master !== 'string' || !isSafeRelative(master) || (extension && !master.endsWith(extension))) {
        fail(`The master ${JSON.stringify(master)} must be a path inside ${MASTER_ROOT}${extension ? ` ending in ${extension}` : ''}.`);
    }
}

function checkOutputs(outputs, where, fail, { encoded }) {
    if (!Array.isArray(outputs) || outputs.length === 0) {
        fail(`${where} must list at least one file.`);
        return;
    }
    for (const output of outputs) {
        if (!isPlainObject(output)) {
            fail(`${where} must hold objects.`);
            continue;
        }
        onlyKeys(output, encoded ? ['path', 'sha256', 'encoding', 'scale', 'from'] : ['path', 'sha256'], `The output ${output.path}`, fail);
        checkOutputPath(output.path, fail);
        if (!SHA256_PATTERN.test(output.sha256 ?? '')) {
            fail(`The sha256 of ${output.path} must be 64 lowercase hex digits.`);
        }
        if (encoded && typeof output.encoding !== 'string') {
            fail(`The output ${output.path} needs an encoding.`);
        }
        if (output.scale !== undefined && (!Number.isInteger(output.scale) || output.scale < 1)) {
            fail(`The scale of ${output.path} must be a whole number of 1 or more.`);
        }
    }
}

function checkOutputPath(path, fail) {
    const allowed = typeof path === 'string' && isSafeRelative(path) && (OUTPUT_PREFIXES.some((prefix) => path.startsWith(prefix)) || ROOT_ICON_PATTERN.test(path));
    if (!allowed) {
        fail(`The output ${JSON.stringify(path)} must be a path under ${OUTPUT_PREFIXES.join(' or ')}, or an .ico file in public/.`);
    }
}

function checkName(name, what, fail) {
    if (!NAME_PATTERN.test(name)) {
        fail(`${what} name "${name}" must be lowercase letters, digits and hyphens.`);
    }
}

function onlyKeys(object, known, where, fail) {
    if (!isPlainObject(object)) {
        return;
    }
    for (const key of Object.keys(object)) {
        if (!known.includes(key)) {
            fail(`${where} has an unknown key "${key}". Known keys: ${known.join(', ')}.`);
        }
    }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isWholeList = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isInteger);
const isSafeRelative = (path) => !isAbsolute(path) && !path.includes('\\') && path.split('/').every((segment) => SEGMENT_PATTERN.test(segment) && segment !== '..' && segment !== '.');
