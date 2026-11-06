import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readLog, sha256 } from './log.mjs';
import { SAMPLES } from './pixel-snap.mjs';
import { readRaster } from './raster.mjs';

const MIN_HASH_PREFIX = 8;
// Art pixels around --frame-region that may change too: a blink moves the lid a pixel or two past the eye, and the cell edges of the grid round it outward.
export const FRAME_MARGIN = 2;

const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');
const fileSha = (path) => sha256(readFileSync(path));

/**
 * Parses `--frame-region x,y,w,h`: whole master pixels, the width and height at least 1.
 * @param {string} text
 */
export function parseFrameRegion(text) {
    const parts = text.split(',').map((part) => part.trim());
    const [x, y, width, height] = parts.map(Number);
    if (parts.length !== 4 || ![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1) {
        throw new Error(`--frame-region must be x,y,w,h in whole master pixels (width and height at least 1), got "${text}".`);
    }
    return { x, y, width, height };
}

/**
 * The logged outputs of snaps that a target names, oldest first. A file is matched by its path (the approved copy or the file the snap
 * logged) and its current sha256, so two approved copies with the same bytes (`splash-reisen` and `splash-both-reisen`) stay apart. A sha256, in
 * full or as a prefix of 8 hex digits or more, is matched alone, and is refused when it names more than one picture.
 */
function matchingOutputs({ rootDir, entries, from }) {
    const outputs = entries.flatMap((entry) => (entry.outputs ?? []).map((output) => ({ entry, output })));
    const path = isAbsolute(from) || existsSync(from) ? resolve(from) : resolve(rootDir, from);
    if (existsSync(path)) {
        const logPath = toLogPath(rootDir, path);
        const sha = fileSha(path);
        const logged = outputs.filter(({ output }) => output.file === logPath || (output.approved && output.approvedAs && `approved/${output.approvedAs}` === logPath));
        if (logged.length === 0) {
            throw new Error(`${logPath} is not the output of a logged snap. Give approved/pixel/<id>.png, the raw/ file a snap logged, or the sha256 of a snap.`);
        }
        const current = logged.filter(({ output }) => output.sha256 === sha);
        if (current.length === 0) {
            throw new Error(`${logPath} (sha256 ${sha.slice(0, 16)}) is not the picture the log recorded for it, so it was changed after the snap. Refusing to take a grid from it.`);
        }
        return { matches: current, path };
    }
    if (!new RegExp(`^[0-9a-f]{${MIN_HASH_PREFIX},64}$`, 'i').test(from)) {
        throw new Error(`--grid-from "${from}" is not a file, and not a sha256 of at least ${MIN_HASH_PREFIX} hex digits.`);
    }
    const matches = outputs.filter(({ output }) => output.sha256.startsWith(from.toLowerCase()));
    if (matches.length === 0) {
        throw new Error(`--grid-from "${from}" is not the sha256 of a logged snap.`);
    }
    return { matches, path: undefined };
}

/**
 * The approved snap a frame is made on the grid of: `from` is its file (approved/pixel/<id>.png, or the raw/ file the snap logged) or its sha256.
 * The log entry of the snap says how it was made, so everything the grid needs is read from there; a picture that no snap made has no
 * grid to take. Re-runs that logged the same bytes more than once give the latest entry.
 * @param {{ rootDir: string, from: string }} request
 */
export async function findBaseSnap({ rootDir, from }) {
    const entries = readLog(join(rootDir, 'log', 'generations.jsonl')).filter((entry) => entry.template === 'pixel-snap');
    const { matches, path } = matchingOutputs({ rootDir, entries, from });
    const ids = [...new Set(matches.map(({ entry }) => entry.vars?.id))];
    if (ids.length > 1) {
        throw new Error(`--grid-from "${from}" is the sha256 of more than one picture (${ids.join(', ')}). Give the file path of the one you mean.`);
    }
    const shas = [...new Set(matches.map(({ output }) => output.sha256))];
    if (shas.length > 1) {
        throw new Error(`--grid-from "${from}" starts more than one sha256 (${shas.map((sha) => sha.slice(0, 16)).join(', ')}). Give more digits, or the file path.`);
    }
    const { entry, output } = matches.at(-1);
    const location = path ?? [output.approved && output.approvedAs ? join(rootDir, 'approved', output.approvedAs) : undefined, join(rootDir, output.file)]
        .find((candidate) => candidate && existsSync(candidate) && fileSha(candidate) === output.sha256);
    if (!location) {
        throw new Error(`The snap "${entry.vars.id}" (sha256 ${output.sha256.slice(0, 16)}) is in the log, but neither its approved copy nor ${output.file} is on disk with that content.`);
    }
    return { id: entry.vars.id, vars: entry.vars, sha256: output.sha256, file: toLogPath(rootDir, location), raster: await readRaster(location) };
}

/**
 * The options that make a snap use the grid and settings of the base: cell, offset, sampling, colours and rings, exactly as logged.
 * @param {Awaited<ReturnType<typeof findBaseSnap>>} base
 */
export function gridOptionsOf({ id, vars }) {
    const { cell, offset, sample, colours, ringRepair, rings } = vars;
    const fail = (what) => {
        throw new Error(`The log entry of the snap "${id}" does not record ${what}, so a frame cannot take its grid. Snap the base again.`);
    };
    if (!(cell > 1)) {
        fail('its cell');
    }
    if (!Number.isFinite(offset?.x) || !Number.isFinite(offset?.y)) {
        fail('its grid offset');
    }
    if (!SAMPLES.includes(sample)) {
        fail('how it was sampled');
    }
    if (typeof ringRepair !== 'boolean') {
        fail('whether its rings were rebuilt');
    }
    if (ringRepair && !(Number.isInteger(rings?.rimWidth) && Number.isInteger(rings?.bandWidth) && typeof rings?.rim === 'string' && typeof rings?.band === 'string')) {
        fail('its ring widths and colours');
    }
    return {
        cell,
        offset: { x: offset.x, y: offset.y },
        sample,
        colours: colours ?? undefined,
        ringRepair,
        ...(ringRepair ? { rimWidth: rings.rimWidth, bandWidth: rings.bandWidth, rim: rings.rim, band: rings.band } : {}),
    };
}

/**
 * The touch-ups file the base snap was made with, which the frame gets too so the two stay the same wherever the frame did not change. It
 * must still be the file the log recorded; `undefined` when the base had none.
 * @param {string} rootDir
 * @param {Awaited<ReturnType<typeof findBaseSnap>>} base
 */
export function baseFixesFile(rootDir, { id, vars }) {
    if (!vars.fixes) {
        return undefined;
    }
    const path = resolve(rootDir, vars.fixes.file);
    if (!existsSync(path) || fileSha(path) !== vars.fixes.sha256) {
        throw new Error(`The snap "${id}" was made with the touch-ups in ${vars.fixes.file}, and that file ${existsSync(path) ? 'has changed' : 'is missing'} since. A frame gets the same touch-ups, so restore the file or snap the base again.`);
    }
    return vars.fixes.file;
}

/** A frame is called `<base id>--<name>`, so its id says which picture it belongs to and the approved copy cannot take another picture's name. */
export function assertFrameId(id, baseId) {
    const prefix = `${baseId}--`;
    if (!id.startsWith(prefix) || id.length === prefix.length) {
        throw new Error(`The id of a frame of "${baseId}" must be "${prefix}<name>" (such as ${prefix}blink), got "${id}". Pass --id, or name the picture that way.`);
    }
}

const isSamePixel = (one, two, at) => (one[at + 3] === 0 && two[at + 3] === 0) || (one[at] === two[at] && one[at + 1] === two[at + 1] && one[at + 2] === two[at + 2] && one[at + 3] === two[at + 3]);

/**
 * The pixels (as indexes, row by row) at which two pictures of one size differ. A pixel that is transparent in both is the same, whatever
 * colour is hidden under it.
 * @param {import('./raster.mjs').Raster} before
 * @param {import('./raster.mjs').Raster} after
 */
export function changedPixels(before, after) {
    if (before.width !== after.width || before.height !== after.height) {
        throw new Error(`The pictures are ${before.width}x${before.height} and ${after.width}x${after.height}; they must be the same size to be compared.`);
    }
    const changed = [];
    for (let at = 0; at < before.data.length; at += 4) {
        if (!isSamePixel(before.data, after.data, at)) {
            changed.push(at / 4);
        }
    }
    return changed;
}

/** The smallest box around pixels given as indexes of a picture `width` wide, or `null` for none. */
export function boxOfPixels(indexes, width) {
    if (indexes.length === 0) {
        return null;
    }
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const index of indexes) {
        const x = index % width;
        const y = (index - x) / width;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
    }
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** A box of art pixels as the box of master pixels it covers on the grid, rounded outward. */
export function masterBoxOf(box, { cell, offset }) {
    const x = Math.floor(offset.x + box.x * cell);
    const y = Math.floor(offset.y + box.y * cell);
    return { x, y, width: Math.ceil(offset.x + (box.x + box.width) * cell) - x, height: Math.ceil(offset.y + (box.y + box.height) * cell) - y };
}

/** The art pixels a region of master pixels may change: every cell it touches, plus `FRAME_MARGIN` art pixels all round. It may reach past the canvas. */
export function allowedArtBox(region, { cell, offset }) {
    const left = Math.floor((region.x - offset.x) / cell) - FRAME_MARGIN;
    const top = Math.floor((region.y - offset.y) / cell) - FRAME_MARGIN;
    const right = Math.ceil((region.x + region.width - offset.x) / cell) + FRAME_MARGIN;
    const bottom = Math.ceil((region.y + region.height - offset.y) / cell) + FRAME_MARGIN;
    return { x: left, y: top, width: right - left, height: bottom - top };
}

const isInside = (box, x, y) => x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
const boxText = (box) => `${box.width}x${box.height} at ${box.x},${box.y}`;

/**
 * Compares a frame snap with its base snap and reports what changed: the number of art pixels and their box, in art pixels and in master pixels.
 * It refuses a frame that changed nothing (the patch is missing) and, with a `region` in master pixels, one that changed pixels outside the
 * region and its margin, which is how a blink that disturbed more than the eyes is told from one that did not.
 * @param {{ base: import('./raster.mjs').Raster, frame: import('./raster.mjs').Raster, grid: { cell: number, offset: { x: number, y: number } },
 *   baseId: string, region?: { x: number, y: number, width: number, height: number }, masterSize: { width: number, height: number } }} request
 */
export function checkFrame({ base, frame, grid, baseId, region, masterSize }) {
    if (region && (region.x + region.width > masterSize.width || region.y + region.height > masterSize.height)) {
        throw new Error(`--frame-region ${region.x},${region.y},${region.width},${region.height} is not inside the ${masterSize.width}x${masterSize.height} picture.`);
    }
    if (base.width !== frame.width || base.height !== frame.height) {
        throw new Error(`The frame snaps to ${frame.width}x${frame.height} art pixels and its base "${baseId}" is ${base.width}x${base.height}. A frame is a patched copy of the base's master, the same size, so the picture given with --in is not one.`);
    }
    const changed = changedPixels(base, frame);
    if (changed.length === 0) {
        throw new Error(`The frame is identical to its base "${baseId}" on the grid: no art pixel changed. Check that --in is the patched picture.`);
    }
    const box = boxOfPixels(changed, frame.width);
    const summary = { changed: changed.length, box, masterBox: masterBoxOf(box, grid), region: region ?? null, allowed: null };
    if (!region) {
        return summary;
    }
    const allowed = allowedArtBox(region, grid);
    const outside = changed.filter((index) => !isInside(allowed, index % frame.width, Math.floor(index / frame.width)));
    if (outside.length > 0) {
        const outsideBox = boxOfPixels(outside, frame.width);
        throw new Error(`${outside.length} of the ${changed.length} art pixels that changed lie outside --frame-region ${region.x},${region.y},${region.width},${region.height} plus ${FRAME_MARGIN} art px: they are in the box ${boxText(outsideBox)} art px (${boxText(masterBoxOf(outsideBox, grid))} master px). A blink should change only the eyes; check the patch, or widen the region. Nothing was written.`);
    }
    return { ...summary, allowed };
}
