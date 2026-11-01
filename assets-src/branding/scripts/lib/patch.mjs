import sharp from 'sharp';
import { createRaster, crop as cropRaster, paste } from './raster.mjs';

const REQUEST_SIZES = [
    { size: '1024x1024', width: 1024, height: 1024 },
    { size: '1536x1024', width: 1536, height: 1024 },
    { size: '1024x1536', width: 1024, height: 1536 },
];
// Past this magnification the model is shown mostly smoothed pixels, not detail.
const TOO_SMALL_SCALE = 12;
const SHAPE_TOLERANCE = 0.02;
const SPEC_KEYS = new Set(['crop', 'composite', 'instruction']);

const isWhole = (value) => Number.isInteger(value);

function parseRect(value, label, bounds) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === 'number')) {
        throw new Error(`${label} must be four numbers [x, y, w, h].`);
    }
    if (!value.every(isWhole)) {
        throw new Error(`${label} must use whole numbers, got [${value.join(', ')}].`);
    }
    const [x, y, width, height] = value;
    if (width < 1 || height < 1) {
        throw new Error(`${label}: width and height must be at least 1, got [${value.join(', ')}].`);
    }
    if (x < bounds.x || y < bounds.y || x + width > bounds.x + bounds.width || y + height > bounds.y + bounds.height) {
        throw new Error(`${label} [${value.join(', ')}] is ${bounds.inside ? 'not inside its crop' : `outside the ${bounds.width}x${bounds.height} image`}.`);
    }
    return { x, y, width, height };
}

/**
 * Parses patches.json into trusted patches. Coordinates are source-image pixels. A patch without `composite`
 * composites its whole crop.
 * @param {any} raw
 * @param {{ width: number, height: number }} image
 */
export function parsePatchSpec(raw, image) {
    if (!Array.isArray(raw)) {
        throw new Error('The patch spec must be a list of patches.');
    }
    if (raw.length === 0) {
        throw new Error('The patch spec needs at least one patch.');
    }
    return raw.map((patch, index) => {
        const name = `Patch ${index + 1}`;
        for (const key of Object.keys(patch ?? {})) {
            if (!SPEC_KEYS.has(key)) {
                throw new Error(`${name}: unknown key "${key}". Known keys: ${[...SPEC_KEYS].join(', ')}.`);
            }
        }
        const crop = parseRect(patch?.crop, `${name}: crop`, { x: 0, y: 0, width: image.width, height: image.height });
        if (patch.instruction !== undefined && (typeof patch.instruction !== 'string' || !patch.instruction.trim())) {
            throw new Error(`${name}: instruction must be a non-empty string.`);
        }
        let composite = [crop];
        if (patch.composite !== undefined) {
            if (!Array.isArray(patch.composite) || patch.composite.length === 0) {
                throw new Error(`${name}: composite must be a non-empty list of [x, y, w, h].`);
            }
            composite = patch.composite.map((rect, at) => parseRect(rect, `${name}: composite ${at + 1}`, { ...crop, inside: true }));
        }
        return { crop, composite, instruction: patch.instruction?.trim() };
    });
}

/** Picks the supported request size that magnifies the crop the most, which is also the one that needs the least padding. */
export function chooseRequestSize(cropWidth, cropHeight) {
    let best;
    for (const candidate of REQUEST_SIZES) {
        const scale = Math.min(candidate.width / cropWidth, candidate.height / cropHeight);
        if (!best || scale > best.scale) {
            best = { ...candidate, scale };
        }
    }
    return { ...best, tooSmall: best.scale > TOO_SMALL_SCALE };
}

/** Median colour of the crop's outermost ring of pixels, which is background when the crop is cut sensibly. */
export function sampleBorderColour(raster, box) {
    const channels = [[], [], []];
    for (let y = box.y; y < box.y + box.height; y++) {
        for (let x = box.x; x < box.x + box.width; x++) {
            if (x !== box.x && y !== box.y && x !== box.x + box.width - 1 && y !== box.y + box.height - 1) {
                continue;
            }
            for (let c = 0; c < 3; c++) {
                channels[c].push(raster.data[(y * raster.width + x) * 4 + c]);
            }
        }
    }
    return channels.map((values) => values.sort((a, b) => a - b)[(values.length - 1) >> 1]);
}

async function resizeRaster(raster, width, height) {
    const { data } = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } })
        .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { width, height, data };
}

const toPng = (raster) => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png().toBuffer();

/**
 * Cuts the crop out, magnifies it with Lanczos and centres it on a canvas of a supported request size.
 * The padding is the crop's own border colour, so the crop is never stretched to fill the canvas.
 * @returns the PNG to send, plus what `extractPatchResult` needs to undo the scaling
 */
export async function buildPatchRequest(source, box) {
    const plan = chooseRequestSize(box.width, box.height);
    const scaledWidth = Math.min(plan.width, Math.round(box.width * plan.scale));
    const scaledHeight = Math.min(plan.height, Math.round(box.height * plan.scale));
    const background = sampleBorderColour(source, box);
    const canvas = createRaster(plan.width, plan.height);
    for (let at = 0; at < canvas.data.length; at += 4) {
        canvas.data.set([...background, 255], at);
    }
    const left = Math.floor((plan.width - scaledWidth) / 2);
    const top = Math.floor((plan.height - scaledHeight) / 2);
    paste(canvas, await resizeRaster(cropRaster(source, box), scaledWidth, scaledHeight), left, top);
    return {
        png: await toPng(canvas),
        size: plan.size,
        width: plan.width,
        height: plan.height,
        scale: plan.scale,
        tooSmall: plan.tooSmall,
        placement: { left, top, width: scaledWidth, height: scaledHeight },
        background,
    };
}

/**
 * Takes the model's picture back to the crop: undo any size change, cut the padding off and scale the rest to the crop's exact size.
 * @param {Buffer} bytes
 * @param {Awaited<ReturnType<typeof buildPatchRequest>>} request
 * @param {{ width: number, height: number }} box
 */
export async function extractPatchResult(bytes, request, box) {
    const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let result = { width: decoded.info.width, height: decoded.info.height, data: decoded.data };
    const warnings = [];
    if (result.width !== request.width || result.height !== request.height) {
        const drift = Math.abs(result.width / result.height - request.width / request.height) / (request.width / request.height);
        if (drift > SHAPE_TOLERANCE) {
            throw new Error(`The model returned ${result.width}x${result.height}, which has a different shape from the ${request.width}x${request.height} request, so the crop cannot be recovered.`);
        }
        warnings.push(`The model returned ${result.width}x${result.height} instead of ${request.width}x${request.height}; it was scaled to the requested size.`);
        result = await resizeRaster(result, request.width, request.height);
    }
    const { left, top, width, height } = request.placement;
    return { raster: await resizeRaster(cropRaster(result, { x: left, y: top, width, height }), box.width, box.height), warnings };
}

/** Weight of a feathered rect at one pixel: 1 well inside, rising from 1/(feather+1) at the rect's edge pixel. */
function rectWeight(rect, x, y, feather) {
    const depth = Math.min(x - rect.x, rect.x + rect.width - 1 - x, y - rect.y, rect.y + rect.height - 1 - y);
    return feather === 0 ? 1 : Math.min(1, (depth + 1) / (feather + 1));
}

/**
 * Blends the patch result into `target` in place, only inside the composite rects (source-image pixels).
 * A pixel outside every rect is not touched, so it stays byte-identical to the source.
 * @param {{ width: number, data: Uint8Array }} target
 * @param {{ width: number, height: number, data: Uint8Array }} patchRaster the result, at the crop's size
 * @param {{ x: number, y: number, width: number, height: number }} box the crop in source pixels
 * @param {Array<{ x: number, y: number, width: number, height: number }>} rects
 * @param {number} feather
 */
export function compositeOnto(target, patchRaster, box, rects, feather) {
    const weights = new Map();
    for (const rect of rects) {
        for (let y = rect.y; y < rect.y + rect.height; y++) {
            for (let x = rect.x; x < rect.x + rect.width; x++) {
                const key = y * target.width + x;
                weights.set(key, Math.max(weights.get(key) ?? 0, rectWeight(rect, x, y, feather)));
            }
        }
    }
    for (const [key, weight] of weights) {
        const x = key % target.width;
        const y = Math.floor(key / target.width);
        const from = ((y - box.y) * patchRaster.width + (x - box.x)) * 4;
        for (let c = 0; c < 4; c++) {
            const at = key * 4 + c;
            target.data[at] = weight >= 1 ? patchRaster.data[from + c] : Math.round(target.data[at] * (1 - weight) + patchRaster.data[from + c] * weight);
        }
    }
    return target;
}

/**
 * Mean absolute colour difference (0-255, averaged over R, G and B) between the crop before and after, inside the
 * composite rects and in the rest of the crop. `rects` are in crop coordinates. A model that redrew the face
 * shows up as a large difference outside the rects.
 */
export function differenceReport(before, after, rects) {
    const inside = new Set();
    for (const rect of rects) {
        for (let y = rect.y; y < rect.y + rect.height; y++) {
            for (let x = rect.x; x < rect.x + rect.width; x++) {
                inside.add(y * before.width + x);
            }
        }
    }
    const sums = { inside: 0, outside: 0 };
    const counts = { inside: 0, outside: 0 };
    for (let pixel = 0; pixel < before.width * before.height; pixel++) {
        const part = rects.length === 0 || inside.has(pixel) ? 'inside' : 'outside';
        let difference = 0;
        for (let c = 0; c < 3; c++) {
            difference += Math.abs(before.data[pixel * 4 + c] - after.data[pixel * 4 + c]);
        }
        sums[part] += difference / 3;
        counts[part]++;
    }
    return {
        inside: counts.inside ? sums.inside / counts.inside : undefined,
        outside: counts.outside ? sums.outside / counts.outside : undefined,
    };
}
