import sharp from 'sharp';
import { buildContactSheet } from './contact-sheet.mjs';
import { srgbToOklab } from './pixel-colour.mjs';

export const KIND = { skin: 1, warm: 2 };
const KIND_NAMES = { [KIND.skin]: 'skin', [KIND.warm]: 'warm' };
const TINT = { [KIND.skin]: [255, 0, 0], [KIND.warm]: [255, 230, 0] };
const TINT_STRENGTH = 0.7;

/**
 * Every number the detector uses, so a run can be repeated and a change is visible in a diff.
 * Distances are OKLab with the lightness difference halved, because an ear in shadow is darker than the cheek but keeps its hue.
 */
export const DEFAULTS = {
    // Largest weighted OKLab distance from the cheek colour that still reads as skin.
    // An ear remnant is darker and more orange than the cheek (about 0.13 away), so this is well above the 0.03 that separates two cheek tones.
    threshold: 0.2,
    // A skin-like pixel must keep this share of the cheek's chroma, which is what keeps the white sticker and the page out.
    minChromaShare: 0.5,
    // Largest hue difference from the cheek, in degrees, for skin and for the warm outline class.
    skinHue: 45,
    warmHue: 50,
    warmChroma: 0.05,
    warmLightness: 0.2,
    // Radius of the opening that separates the face from anything thinner than 2 * openRadius + 1 pixels attached to it.
    openRadius: 7,
    // Warm pixels this close to the face outline are the face's own contour line, not an ear outline.
    contourRadius: 3,
    // Skin deeper inside the face outline than this (eyes, open mouth, chin) is the face. A remnant lies within this band of the contour.
    contourBand: 8,
    // Rows count as "the face's rows" when the opened face is this share of its widest row or more.
    faceRowShare: 0.6,
    // Warm pixels thicker than twice this radius are an eye or an ear, not a contour line.
    lineRadius: 2,
    // Skin outside the opened face must be at least 2 * rimRadius + 1 pixels thick to count, which drops the rim the opening leaves
    // along a jagged contour.
    rimRadius: 1,
    // Smallest component, in pixels, worth reporting.
    minPixels: 8,
    // Search zone as shares of the face width: how far out from the face sides, and how far above and below its rows.
    reachOut: 0.35,
    reachUp: 0.1,
    reachDown: 0.1,
    patchRadius: 3,
};

const SPEC_KEYS = new Set(['name', 'crop', 'skin', 'ignore', 'faceless']);

const hueOf = ([, a, b]) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
const chromaOf = ([, a, b]) => Math.hypot(a, b);
const hueGap = (one, other) => Math.abs(((one - other + 540) % 360) - 180);

function parseRect(value, label, bounds) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isInteger)) {
        throw new Error(`${label} must be four whole numbers [x, y, w, h].`);
    }
    const [x, y, width, height] = value;
    if (width < 1 || height < 1 || x < 0 || y < 0 || x + width > bounds.width || y + height > bounds.height) {
        throw new Error(`${label} [${value.join(', ')}] is outside the ${bounds.width}x${bounds.height} image.`);
    }
    return { x, y, width, height };
}

/**
 * Parses the head list: `{ name, crop: [x, y, w, h], skin: [x, y], ignore?: [[x, y, w, h], ...], faceless?: boolean }`.
 * `skin` is a point on the cheek (or, for a head with no face, a cheek anywhere on the sheet). Coordinates are source pixels.
 * @param {any} raw
 * @param {{ width: number, height: number }} image
 */
export function parseHeadSpec(raw, image) {
    if (!Array.isArray(raw)) {
        throw new Error('The head spec must be a list of heads.');
    }
    if (raw.length === 0) {
        throw new Error('The head spec needs at least one head.');
    }
    const names = new Set();
    return raw.map((head, index) => {
        for (const key of Object.keys(head ?? {})) {
            if (!SPEC_KEYS.has(key)) {
                throw new Error(`Head ${index + 1}: unknown key "${key}". Known keys: ${[...SPEC_KEYS].join(', ')}.`);
            }
        }
        if (typeof head.name !== 'string' || !head.name.trim()) {
            throw new Error(`Head ${index + 1} needs a name.`);
        }
        if (names.has(head.name)) {
            throw new Error(`Head name "${head.name}" is a duplicate.`);
        }
        names.add(head.name);
        const label = `Head "${head.name}"`;
        if (head.skin === undefined) {
            throw new Error(`${label} needs skin: [x, y], a point on the cheek.`);
        }
        const [skinX, skinY] = Array.isArray(head.skin) ? head.skin : [];
        if (!Number.isInteger(skinX) || !Number.isInteger(skinY) || skinX < 0 || skinY < 0 || skinX >= image.width || skinY >= image.height) {
            throw new Error(`${label}: skin point [${[].concat(head.skin).join(', ')}] is outside the ${image.width}x${image.height} image.`);
        }
        if (head.ignore !== undefined && !Array.isArray(head.ignore)) {
            throw new Error(`${label}: ignore must be a list of [x, y, w, h].`);
        }
        return {
            name: head.name,
            crop: parseRect(head.crop, `${label}: crop`, image),
            skin: { x: skinX, y: skinY },
            ignore: (head.ignore ?? []).map((rect, at) => parseRect(rect, `${label}: ignore ${at + 1}`, image)),
            faceless: head.faceless === true,
        };
    });
}

/** All (dx, dy) with dx² + dy² <= radius², for a round structuring element. */
function discOffsets(radius) {
    const offsets = [];
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy <= radius * radius) {
                offsets.push([dx, dy]);
            }
        }
    }
    return offsets;
}

/** Erosion; `outside` is what a pixel beyond the crop counts as, so a shape cut by the crop edge is not eaten at the cut. */
function erode(mask, width, height, radius, outside) {
    const offsets = discOffsets(radius);
    const result = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            result[y * width + x] = offsets.every(([dx, dy]) => {
                const nx = x + dx;
                const ny = y + dy;
                return nx < 0 || ny < 0 || nx >= width || ny >= height ? outside : mask[ny * width + nx] === 1;
            }) ? 1 : 0;
        }
    }
    return result;
}

function dilate(mask, width, height, radius) {
    const offsets = discOffsets(radius);
    const result = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (mask[y * width + x] === 0) {
                continue;
            }
            for (const [dx, dy] of offsets) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
                    result[ny * width + nx] = 1;
                }
            }
        }
    }
    return result;
}

/** 8-connected components of a mask, as lists of pixel indexes. */
function components(mask, width, height) {
    const seen = new Uint8Array(width * height);
    const found = [];
    for (let start = 0; start < mask.length; start++) {
        if (mask[start] === 0 || seen[start] === 1) {
            continue;
        }
        const members = [];
        const stack = [start];
        seen[start] = 1;
        while (stack.length > 0) {
            const at = stack.pop();
            members.push(at);
            const x = at % width;
            const y = (at - x) / width;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    const next = ny * width + nx;
                    if (nx >= 0 && ny >= 0 && nx < width && ny < height && mask[next] === 1 && seen[next] === 0) {
                        seen[next] = 1;
                        stack.push(next);
                    }
                }
            }
        }
        found.push(members);
    }
    return found;
}

/** Convex hull of integer points (Andrew's monotone chain), counter-clockwise. */
function convexHull(points) {
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list) => {
        const chain = [];
        for (const point of list) {
            while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
                chain.pop();
            }
            chain.push(point);
        }
        chain.pop();
        return chain;
    };
    return [...half(sorted), ...half([...sorted].reverse())];
}

/** The pixels whose centres lie inside a convex polygon. */
function fillPolygon(polygon, width, height) {
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        const centre = y + 0.5;
        let low = Infinity;
        let high = -Infinity;
        for (let at = 0; at < polygon.length; at++) {
            const [x1, y1] = polygon[at];
            const [x2, y2] = polygon[(at + 1) % polygon.length];
            if ((y1 <= centre && centre < y2) || (y2 <= centre && centre < y1)) {
                const x = x1 + ((centre - y1) * (x2 - x1)) / (y2 - y1);
                low = Math.min(low, x);
                high = Math.max(high, x);
            }
        }
        for (let x = Math.max(0, Math.ceil(low - 0.5)); x <= Math.min(width - 1, Math.floor(high - 0.5)); x++) {
            mask[y * width + x] = 1;
        }
    }
    return mask;
}

const median = (values) => [...values].sort((a, b) => a - b)[(values.length - 1) >> 1];

function sampleSkin(raster, point, radius) {
    const channels = [[], [], []];
    for (let y = Math.max(0, point.y - radius); y <= Math.min(raster.height - 1, point.y + radius); y++) {
        for (let x = Math.max(0, point.x - radius); x <= Math.min(raster.width - 1, point.x + radius); x++) {
            for (let c = 0; c < 3; c++) {
                channels[c].push(raster.data[(y * raster.width + x) * 4 + c]);
            }
        }
    }
    return channels.map(median);
}

function detectHead(raster, head, options) {
    const { crop } = head;
    const { width, height } = crop;
    const skinColour = sampleSkin(raster, head.skin, options.patchRadius);
    const skinLab = srgbToOklab(skinColour);
    const skinHue = hueOf(skinLab);
    const skinChroma = chromaOf(skinLab);

    const ignored = new Uint8Array(width * height);
    for (const rect of head.ignore) {
        for (let y = Math.max(rect.y, crop.y); y < Math.min(rect.y + rect.height, crop.y + crop.height); y++) {
            for (let x = Math.max(rect.x, crop.x); x < Math.min(rect.x + rect.width, crop.x + crop.width); x++) {
                ignored[(y - crop.y) * width + (x - crop.x)] = 1;
            }
        }
    }

    const skinMask = new Uint8Array(width * height);
    const warmMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = (y * width + x);
            if (ignored[at] === 1) {
                continue;
            }
            const from = ((y + crop.y) * raster.width + (x + crop.x)) * 4;
            const lab = srgbToOklab([raster.data[from], raster.data[from + 1], raster.data[from + 2]]);
            const gap = hueGap(hueOf(lab), skinHue);
            const distance = Math.hypot(0.5 * (lab[0] - skinLab[0]), lab[1] - skinLab[1], lab[2] - skinLab[2]);
            const isSkin = distance <= options.threshold && chromaOf(lab) >= options.minChromaShare * skinChroma && gap <= options.skinHue;
            skinMask[at] = isSkin ? 1 : 0;
            warmMask[at] = !isSkin && gap <= options.warmHue && chromaOf(lab) >= options.warmChroma && lab[0] >= options.warmLightness ? 1 : 0;
        }
    }

    let zone = { left: 0, right: width - 1, top: 0, bottom: height - 1 };
    let nearFace = new Uint8Array(width * height);
    let candidates = skinMask;
    if (!head.faceless) {
        const faces = components(skinMask, width, height).sort((a, b) => b.length - a.length);
        if (faces.length === 0) {
            throw new Error(`Head "${head.name}": no skin-like pixels in the crop, so no face was found. Check the skin point [${head.skin.x}, ${head.skin.y}] and the threshold.`);
        }
        const face = new Uint8Array(width * height);
        for (const at of faces[0]) {
            face[at] = 1;
        }
        const core = dilate(erode(face, width, height, options.openRadius, true), width, height, options.openRadius);
        const rows = new Array(height).fill(0);
        const rowLeft = new Array(height).fill(width);
        const rowRight = new Array(height).fill(-1);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (core[y * width + x] === 1) {
                    rows[y]++;
                    rowLeft[y] = Math.min(rowLeft[y], x);
                    rowRight[y] = Math.max(rowRight[y], x);
                }
            }
        }
        const widest = Math.max(...rows);
        if (widest === 0) {
            throw new Error(`Head "${head.name}": the face is thinner than the opening radius ${options.openRadius}, so no face core was found.`);
        }
        const faceRows = rows.flatMap((count, y) => (count >= options.faceRowShare * widest ? [y] : []));
        const left = Math.min(...rowLeft);
        const right = Math.max(...rowRight);
        const faceWidth = right - left + 1;
        const top = Math.max(0, Math.round(faceRows[0] - options.reachUp * faceWidth));
        const bottom = faceRows[faceRows.length - 1] + options.reachDown * faceWidth;
        zone = { left: left - options.reachOut * faceWidth, right: right + options.reachOut * faceWidth, top, bottom };

        // The eyes break the face into pieces, so the outline is the hull of the opened face with its top sides carried up to the search
        // zone's top. Skin and eyes inside the outline are the face; a remnant is what sticks out of it.
        const upper = faceRows.slice(0, Math.max(3, Math.ceil(faceRows.length * 0.2)));
        const corners = [[Math.min(...upper.map((y) => rowLeft[y])), top], [Math.max(...upper.map((y) => rowRight[y])) + 1, top]];
        const points = [...corners];
        for (let y = 0; y < height; y++) {
            if (rows[y] > 0) {
                points.push([rowLeft[y], y], [rowRight[y] + 1, y], [rowLeft[y], y + 1], [rowRight[y] + 1, y + 1]);
            }
        }
        const outline = fillPolygon(convexHull(points), width, height);
        nearFace = dilate(outline, width, height, options.contourRadius);
        // Above the first row of the cheeks the skin beside the eyes is temple and forehead. Below it, the opened face is the face.
        const aboveCheeks = (at) => Math.floor(at / width) < faceRows[0];
        const interior = erode(outline, width, height, options.contourBand, false);
        const outside = skinMask.map((value, at) => (value === 1 && core[at] === 0 && interior[at] === 0 && !(outline[at] === 1 && aboveCheeks(at)) ? 1 : 0));
        candidates = dilate(erode(outside, width, height, options.rimRadius, false), width, height, options.rimRadius);
    }

    const inZone = (x, y) => x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom;
    const flags = new Uint8Array(width * height);
    const found = [];
    const claim = (mask, kind) => {
        const eligible = mask.map((value, at) => (value === 1 && inZone(at % width, Math.floor(at / width)) ? 1 : 0));
        for (const members of components(eligible, width, height)) {
            if (members.length < options.minPixels) {
                continue;
            }
            const xs = members.map((at) => at % width);
            const ys = members.map((at) => Math.floor(at / width));
            for (const at of members) {
                flags[at] = kind;
            }
            const x = Math.min(...xs);
            const y = Math.min(...ys);
            found.push({ kind: KIND_NAMES[kind], x: x + crop.x, y: y + crop.y, width: Math.max(...xs) - x + 1, height: Math.max(...ys) - y + 1, pixels: members.length });
        }
    };
    claim(candidates, KIND.skin);
    const thick = dilate(erode(warmMask, width, height, options.lineRadius, false), width, height, options.lineRadius);
    claim(warmMask.map((value, at) => (value === 1 && nearFace[at] === 0 && thick[at] === 0 ? 1 : 0)), KIND.warm);
    return { name: head.name, crop, skinColour, flags, components: found.sort((a, b) => b.pixels - a.pixels) };
}

/**
 * Looks for what is left of a human ear beside each face: skin-coloured pixels in the hair ("skin"), and
 * orange or brown contour lines in the hair ("warm"). It only reports; a person decides which flags are real.
 *
 * Per head: sample the cheek; mark skin-like pixels; take the largest skin area as the face; open it with a disc so anything
 * thinner than the disc (a sliver attached to the contour) is no longer part of the face. The convex outline of what is left
 * also takes in the eyes. Skin-like pixels outside the opened face count, except the temple skin in the outline above the cheeks;
 * warm pixels count when they are outside the outline. Both must lie beside the face's rows.
 * @param {import('./raster.mjs').Raster} raster
 * @param {ReturnType<typeof parseHeadSpec>} heads
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function detectSheet(raster, heads, options = {}) {
    const merged = { ...DEFAULTS, ...options };
    return heads.map((head) => detectHead(raster, head, merged));
}

/** Every flagged pixel as `[x, y, kind]` in source coordinates. */
export function flagList(results) {
    return results.flatMap(({ crop, flags }) => {
        const entries = [];
        for (let at = 0; at < flags.length; at++) {
            if (flags[at] !== 0) {
                entries.push([(at % crop.width) + crop.x, Math.floor(at / crop.width) + crop.y, flags[at]]);
            }
        }
        return entries;
    });
}

/**
 * An RGBA layer of `scale`x`scale` blocks, tinted by kind, for pixels `[x, y, kind]` inside `area`.
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function flagLayer(flags, area, scale) {
    const width = area.width * scale;
    const layer = Buffer.alloc(width * area.height * scale * 4);
    for (const [x, y, kind] of flags) {
        if (x < area.x || y < area.y || x >= area.x + area.width || y >= area.y + area.height) {
            continue;
        }
        for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
                layer.set([...TINT[kind], Math.round(255 * TINT_STRENGTH)], (((y - area.y) * scale + dy) * width + (x - area.x) * scale + dx) * 4);
            }
        }
    }
    return sharp(layer, { raw: { width, height: area.height * scale, channels: 4 } }).png().toBuffer();
}

/**
 * The check sheet: every head's crop at `scale`x (nearest-neighbour) with its flags tinted, skin red and warm yellow.
 * @param {import('./raster.mjs').Raster} raster
 * @param {ReturnType<typeof detectSheet>} results
 */
export async function renderRemnantSheet(raster, results, { scale = 4, columns = 2 } = {}) {
    const source = sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png();
    const full = await source.toBuffer();
    const items = [];
    for (const result of results) {
        const { crop } = result;
        const enlarged = await sharp(full)
            .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
            .resize(crop.width * scale, crop.height * scale, { kernel: 'nearest' })
            .png()
            .toBuffer();
        const layer = await flagLayer(flagList([result]), crop, scale);
        const image = await sharp(enlarged).composite([{ input: layer }]).png().toBuffer();
        const summary = result.components.length === 0 ? 'no flags' : `${result.components.length} flag${result.components.length === 1 ? '' : 's'}`;
        items.push({ image, label: `${result.name}  crop [${crop.x},${crop.y},${crop.width},${crop.height}]  ${summary}` });
    }
    return buildContactSheet(items, { cols: columns, cellWidth: 0, cellHeight: 0, gap: 12, labelHeight: 24, nearest: true, scales: [1], scaleLabels: false });
}
