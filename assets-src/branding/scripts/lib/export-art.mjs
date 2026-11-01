import sharp from 'sharp';
import { srgbToOklab } from './pixel-colour.mjs';
import { createRaster, crop, opaqueBox, paste } from './raster.mjs';

const SPEC_KEYS = new Set(['margin', 'alphaThreshold', 'assets']);
const ASSET_KEYS = new Set(['character', 'master', 'css', 'fit', 'crop', 'margin', 'square', 'webp', 'focus']);
const FITS = ['contain', 'width', 'height'];
export const DENSITIES = [1, 2, 3];
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
// Pixels this faint are the soft tail of the sticker edge or a stray speck, not part of the subject's box.
const DEFAULT_ALPHA_THRESHOLD = 16;
const DEFAULT_MARGIN = 24;

// A smaller-than-lossless encoding is accepted when the picture, composited on grey, differs from the Lanczos resize by less than these
// (OKLab distance x 100). 2 is about the smallest colour step an eye can tell apart, so the mean must sit well under it and the
// worst 1% of pixels under 1.5.
export const MEAN_LIMIT = 0.4;
export const P99_LIMIT = 1.5;
const NEAR_LOSSLESS_LADDER = [40, 50, 60, 70, 80, 90];
const LOSSY_LADDER = [70, 75, 80, 85, 90, 95];
const WEBP_MODES = ['near-lossless', 'lossy'];
const BACKDROP = 128;
const DELTA_SCALE = 100;
const WEBP_EFFORT = 6;
// Lossy at effort 6 is several times slower for a few percent in size, and it is the mode that rarely passes the limits.
const LOSSY_EFFORT = 4;

const isWholeAtLeast1 = (value) => Number.isInteger(value) && value >= 1;

/**
 * Parses the export spec: `{ margin, alphaThreshold, assets: { "<id>": { character, master, css: [128, 64], fit, crop, margin, square, webp, focus } } }`.
 * `css` lists the CSS sizes the asset is placed at, `fit` says what that size measures (`contain`: the longer side, as in a square box;
 * `width`; `height`). `webp` is `auto` (measure and choose), `lossless`, or `{ mode: "near-lossless" | "lossy", quality }`.
 * @param {any} raw
 */
export function parseExportSpec(raw) {
    for (const key of Object.keys(raw ?? {})) {
        if (!SPEC_KEYS.has(key)) {
            throw new Error(`Export spec: unknown key "${key}". Known keys: ${[...SPEC_KEYS].join(', ')}.`);
        }
    }
    const margin = raw.margin ?? DEFAULT_MARGIN;
    const alphaThreshold = raw.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
    if (!Number.isInteger(margin) || margin < 0) {
        throw new Error(`Export spec: margin must be a whole number of 0 or more (source pixels), got ${margin}.`);
    }
    if (!Number.isInteger(alphaThreshold) || alphaThreshold < 1 || alphaThreshold > 255) {
        throw new Error(`Export spec: alphaThreshold must be a whole number from 1 to 255, got ${alphaThreshold}.`);
    }
    const entries = Object.entries(raw.assets ?? {});
    if (entries.length === 0) {
        throw new Error('Export spec: assets needs at least one asset.');
    }
    return { margin, alphaThreshold, assets: entries.map(([id, asset]) => parseAsset(id, asset, margin)) };
}

function parseAsset(id, asset, defaultMargin) {
    const fail = (message) => {
        throw new Error(`Export spec, asset "${id}": ${message}`);
    };
    if (!ID_PATTERN.test(id)) {
        throw new Error(`Export spec: asset id "${id}" must be lowercase letters, digits and hyphens, such as row-reisen.`);
    }
    for (const key of Object.keys(asset)) {
        if (!ASSET_KEYS.has(key)) {
            fail(`unknown key "${key}". Known keys: ${[...ASSET_KEYS].join(', ')}.`);
        }
    }
    if (typeof asset.master !== 'string' || !asset.master) {
        fail('master must be the path of the approved picture.');
    }
    if (!Array.isArray(asset.css) || asset.css.length === 0 || !asset.css.every(isWholeAtLeast1)) {
        fail('css must be a list of whole CSS sizes, such as [128, 64].');
    }
    if (new Set(asset.css).size !== asset.css.length) {
        fail('css has a duplicate size.');
    }
    const fit = asset.fit ?? 'contain';
    if (!FITS.includes(fit)) {
        fail(`fit must be one of ${FITS.join(', ')}, got "${fit}".`);
    }
    if (asset.crop !== undefined && !(Array.isArray(asset.crop) && asset.crop.length === 4 && asset.crop.every(Number.isInteger) && asset.crop[2] > 0 && asset.crop[3] > 0)) {
        fail('crop must be [x, y, width, height] in whole source pixels.');
    }
    const webp = asset.webp ?? 'auto';
    const isForced = webp !== null && typeof webp === 'object' && WEBP_MODES.includes(webp.mode) && Number.isInteger(webp.quality) && webp.quality >= 1 && webp.quality <= 100;
    if (!(webp === 'auto' || webp === 'lossless' || isForced)) {
        fail('webp must be "auto", "lossless", or { "mode": "near-lossless" | "lossy", "quality": 1 to 100 }.');
    }
    if (asset.focus !== undefined && !(Array.isArray(asset.focus) && asset.focus.length === 2 && asset.focus.every((value) => value >= 0 && value <= 1))) {
        fail('focus must be [x, y] as shares of the frame from 0 to 1.');
    }
    const margin = asset.margin ?? defaultMargin;
    if (!Number.isInteger(margin) || margin < 0) {
        fail('margin must be a whole number of 0 or more (source pixels).');
    }
    return { id, character: asset.character ?? id, master: asset.master, css: asset.css, fit, crop: asset.crop, margin, square: asset.square ?? false, webp, focus: asset.focus ?? [0.5, 0.3] };
}

/**
 * The part of the master that is exported, in master pixels: the subject's box (or the crop) plus `margin` on every side, made
 * square when asked. It can reach past the canvas, and `renderFrame` fills that with transparency, so the edge of the sticker
 * never lands on the edge of the picture.
 * @param {import('./raster.mjs').Raster} master
 * @param {{ crop?: number[], margin: number, square: boolean, alphaThreshold?: number }} options
 */
export function frameBox(master, { crop: cropBox, margin, square, alphaThreshold = DEFAULT_ALPHA_THRESHOLD }) {
    let base;
    if (cropBox) {
        const [x, y, width, height] = cropBox;
        if (x < 0 || y < 0 || x + width > master.width || y + height > master.height) {
            throw new Error(`The crop [${cropBox.join(', ')}] is not inside the ${master.width}x${master.height} picture.`);
        }
        base = { x, y, width, height };
    } else {
        base = opaqueBox(master, alphaThreshold);
        if (!base) {
            throw new Error('The picture has no visible subject to frame.');
        }
    }
    const frame = { x: base.x - margin, y: base.y - margin, width: base.width + 2 * margin, height: base.height + 2 * margin };
    if (!square) {
        return frame;
    }
    const side = Math.max(frame.width, frame.height);
    return { x: frame.x - Math.floor((side - frame.width) / 2), y: frame.y - Math.floor((side - frame.height) / 2), width: side, height: side };
}

/** The frame cut out of the master, with transparency where it reaches past the canvas. */
export function renderFrame(master, frame) {
    const left = Math.max(0, frame.x);
    const top = Math.max(0, frame.y);
    const right = Math.min(master.width, frame.x + frame.width);
    const bottom = Math.min(master.height, frame.y + frame.height);
    const framed = createRaster(frame.width, frame.height);
    if (right > left && bottom > top) {
        paste(framed, crop(master, { x: left, y: top, width: right - left, height: bottom - top }), left - frame.x, top - frame.y);
    }
    return framed;
}

/**
 * The size in device pixels of one variant: the CSS size times the density, measured on the side `fit` names.
 * Refuses to enlarge the frame, because an enlarged master would look soft and say nothing true about its pixels.
 */
export function outputSize(frame, { css, density, fit }) {
    const target = css * density;
    const reference = { contain: Math.max(frame.width, frame.height), width: frame.width, height: frame.height }[fit];
    if (target > reference) {
        throw new Error(`A ${css} CSS pixel placement at ${density}x needs ${target} pixels but the frame has only ${reference} on that side; it would upscale.`);
    }
    const scale = target / reference;
    return { width: Math.max(1, Math.round(frame.width * scale)), height: Math.max(1, Math.round(frame.height * scale)) };
}

/** Lanczos3 resize; sharp premultiplies alpha around it, so a colour hidden under a transparent pixel cannot fringe an edge. */
export async function resizeFrame(raster, { width, height }) {
    const data = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } })
        .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer();
    return { width, height, data };
}

const decode = async (webp) => {
    const { data, info } = await sharp(webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
};

/**
 * How far two pictures of one size are apart as an eye sees it: both composited on mid grey, then the OKLab distance (x 100) of
 * each pixel that shows in either. Reports the mean and the 99th percentile of those, the maximum, and how many pixels showed.
 */
export function perceptualDifference(one, two) {
    if (one.width !== two.width || one.height !== two.height) {
        throw new Error(`The pictures must be the same size, got ${one.width}x${one.height} and ${two.width}x${two.height}.`);
    }
    const onGrey = (raster, at) => [0, 1, 2].map((channel) => {
        const alpha = raster.data[at + 3] / 255;
        return raster.data[at + channel] * alpha + BACKDROP * (1 - alpha);
    });
    const distances = [];
    for (let at = 0; at < one.data.length; at += 4) {
        if (one.data[at + 3] === 0 && two.data[at + 3] === 0) {
            continue;
        }
        const a = srgbToOklab(onGrey(one, at));
        const b = srgbToOklab(onGrey(two, at));
        distances.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * DELTA_SCALE);
    }
    if (distances.length === 0) {
        return { mean: 0, p99: 0, max: 0, covered: 0 };
    }
    distances.sort((x, y) => x - y);
    return {
        mean: distances.reduce((sum, value) => sum + value, 0) / distances.length,
        p99: distances[Math.min(distances.length - 1, Math.floor(distances.length * 0.99))],
        max: distances[distances.length - 1],
        covered: distances.length,
    };
}

// The colour under a fully transparent pixel is never seen, so no encoder is asked to keep it (`exact` would also stop near-lossless from rounding anything).
const rawInput = (raster) => ({ raw: { width: raster.width, height: raster.height, channels: 4 } });
const ENCODERS = {
    lossless: (raster) => sharp(raster.data, rawInput(raster)).webp({ lossless: true, effort: WEBP_EFFORT }).toBuffer(),
    // Lossless WebP with the low bits of each pixel rounded first: no chroma subsampling, so edges keep their colour.
    'near-lossless': (raster, quality) => sharp(raster.data, rawInput(raster)).webp({ lossless: true, nearLossless: true, quality, effort: WEBP_EFFORT }).toBuffer(),
    lossy: (raster, quality) => sharp(raster.data, rawInput(raster)).webp({ quality, alphaQuality: 100, effort: LOSSY_EFFORT, smartSubsample: true }).toBuffer(),
};

/** One encoding of every size, each with its bytes and how far it is from the resize. */
async function encodeAll(rasters, mode, quality) {
    const files = [];
    for (const raster of rasters) {
        const buffer = await ENCODERS[mode](raster, quality);
        const difference = mode === 'lossless' ? { mean: 0, p99: 0 } : perceptualDifference(raster, await decode(buffer));
        files.push({ buffer, mode, quality, bytes: buffer.length, mean: difference.mean, p99: difference.p99, passes: difference.mean <= MEAN_LIMIT && difference.p99 <= P99_LIMIT });
    }
    return files;
}

/** The lowest quality on the ladder at which every size passes, or the highest quality tried when none does. */
async function lowestPassing(rasters, mode, ladder) {
    let tried;
    for (const quality of ladder) {
        tried = await encodeAll(rasters, mode, quality);
        if (tried.every((file) => file.passes)) {
            break;
        }
    }
    return tried;
}

const totalBytes = (files) => files.reduce((sum, file) => sum + file.bytes, 0);
const figures = ({ buffer, ...rest }) => rest;

/**
 * Encodes every size of one asset as WebP three ways and decides how the asset is stored: `lossless` (exact), `near-lossless`
 * (lossless WebP after rounding low bits, at the lowest quality of 40 to 90 that keeps every size inside MEAN_LIMIT and P99_LIMIT)
 * and `lossy` (the same test over 70 to 95). `auto` takes the smallest of the ones that pass; an object forces one mode and quality.
 * Every file keeps the figures of all three, so the report shows what each would have cost.
 * @param {import('./raster.mjs').Raster[]} rasters the resized pictures, all sizes of one asset
 * @param {{ webp: 'auto' | 'lossless' | { mode: 'near-lossless' | 'lossy', quality: number } }} options
 */
export async function chooseEncoding(rasters, { webp }) {
    const forced = typeof webp === 'object' ? webp : undefined;
    const ladders = { 'near-lossless': NEAR_LOSSLESS_LADDER, lossy: LOSSY_LADDER };
    const candidates = { lossless: await encodeAll(rasters, 'lossless') };
    for (const mode of WEBP_MODES) {
        if (!forced || forced.mode === mode) {
            candidates[mode] = await lowestPassing(rasters, mode, forced ? [forced.quality] : ladders[mode]);
        }
    }
    const isEligible = (mode, files) => {
        if (forced) {
            return mode === forced.mode;
        }
        return webp === 'auto' ? files.every((file) => file.passes) : mode === 'lossless';
    };
    const [mode, chosen] = Object.entries(candidates)
        .filter(([name, files]) => isEligible(name, files))
        .reduce((best, entry) => (totalBytes(entry[1]) < totalBytes(best[1]) ? entry : best));

    const files = rasters.map((_, index) => ({
        buffer: chosen[index].buffer,
        bytes: chosen[index].bytes,
        mode,
        quality: chosen[index].quality,
        candidates: Object.fromEntries(Object.entries(candidates).map(([name, list]) => [name, figures(list[index])])),
    }));
    return {
        mode,
        quality: chosen[0].quality,
        files,
        totals: Object.fromEntries(Object.entries(candidates).map(([name, list]) => [name, totalBytes(list)])),
    };
}
