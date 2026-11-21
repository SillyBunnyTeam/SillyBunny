import sharp from 'sharp';
import { crop } from './raster.mjs';

const BACKGROUND = { r: 58, g: 58, b: 66, alpha: 1 };
const BACKDROP = { r: 112, g: 112, b: 120, alpha: 1 };
const GAP = 16;
const LABEL_HEIGHT = 36;
const OVERVIEW_SCALE = 3;
const CROP_SCALE = 6;

const escapeXml = (text) => text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&apos;' })[c]);

/** A label of one or two lines; a line break in the text starts the second line. */
const labelSvg = (text, width) => {
    const lines = text.split('\n').map((line, at) => `<text x="2" y="${14 + at * 15}" font-family="sans-serif" font-size="13" fill="#ffffff">${escapeXml(line)}</text>`);
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_HEIGHT}">${lines.join('')}</svg>`);
};

const BOX_KEYS = ['x', 'y', 'width', 'height'];

function parseBox(raw, name) {
    if (!BOX_KEYS.every((key) => Number.isInteger(raw?.[key]))) {
        throw new Error(`${name}: a box needs whole numbers ${BOX_KEYS.join(', ')} in master pixels.`);
    }
    if (raw.width < 1 || raw.height < 1 || raw.x < 0 || raw.y < 0) {
        throw new Error(`${name}: the box ${JSON.stringify(raw)} is empty or starts outside the picture.`);
    }
    return { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
}

/**
 * Parses review/<id>.json: where to look closely, in master pixels. `faces` give the left and right side of a head (the user checks both
 * for human ears), `hands` give one box each.
 * @param {any} raw
 * @param {{ width: number, height: number }} master
 * @returns {{ faces: Array<{ name: string, left: object, right: object }>, hands: Array<{ name: string, box: object }> }}
 */
export function parseRegions(raw, master) {
    const faces = (raw?.faces ?? []).map((face, index) => ({
        name: String(face.name ?? `face ${index + 1}`),
        left: parseBox(face.left, `faces[${index}].left`),
        right: parseBox(face.right, `faces[${index}].right`),
    }));
    const hands = (raw?.hands ?? []).map((hand, index) => ({ name: String(hand.name ?? `hand ${index + 1}`), box: parseBox(hand.box, `hands[${index}].box`) }));
    for (const box of [...faces.flatMap((face) => [face.left, face.right]), ...hands.map((hand) => hand.box)]) {
        if (box.x + box.width > master.width || box.y + box.height > master.height) {
            throw new Error(`The box ${JSON.stringify(box)} reaches outside the ${master.width}x${master.height} master.`);
        }
    }
    return { faces, hands };
}

const toPng = (raster) => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png().toBuffer();

/** A snapped raster enlarged by whole-number nearest-neighbour copying. */
async function nearestPng(raster, scale) {
    return sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).resize(raster.width * scale, raster.height * scale, { kernel: 'nearest' }).png().toBuffer();
}

/**
 * The same area of the master and of the snap, both at `scale` times the snap's pixel size: the snap by copying pixels, the master with
 * a smooth resize. The area is widened to whole art pixels so the two cover exactly the same ground.
 */
async function lookCloser(master, native, grid, box, scale) {
    const first = { column: Math.max(0, Math.floor((box.x - grid.offsetX) / grid.cell)), row: Math.max(0, Math.floor((box.y - grid.offsetY) / grid.cell)) };
    const last = { column: Math.min(native.width, Math.ceil((box.x + box.width - grid.offsetX) / grid.cell)), row: Math.min(native.height, Math.ceil((box.y + box.height - grid.offsetY) / grid.cell)) };
    const columns = last.column - first.column;
    const rows = last.row - first.row;
    const left = Math.min(master.width - 1, Math.round(grid.offsetX + first.column * grid.cell));
    const top = Math.min(master.height - 1, Math.round(grid.offsetY + first.row * grid.cell));
    const width = Math.min(master.width - left, Math.round(columns * grid.cell));
    const height = Math.min(master.height - top, Math.round(rows * grid.cell));
    const masterPng = await sharp(master.data, { raw: { width: master.width, height: master.height, channels: 4 } })
        .extract({ left, top, width, height })
        .resize(columns * scale, rows * scale, { kernel: 'lanczos3' })
        .png()
        .toBuffer();
    const snapPng = await nearestPng(crop(native, { x: first.column, y: first.row, width: columns, height: rows }), scale);
    return { masterPng, snapPng, width: columns * scale, height: rows * scale };
}

/** Stacks rows of labelled panels on a flat background; each row is as tall as its tallest panel. */
async function stackRows(rows) {
    const layers = [];
    let top = GAP;
    let sheetWidth = 0;
    for (const row of rows) {
        let left = GAP;
        for (const panel of row) {
            layers.push({ input: await sharp({ create: { width: panel.width, height: panel.height, channels: 4, background: BACKDROP } }).png().toBuffer(), left, top });
            layers.push({ input: panel.png, left, top });
            layers.push({ input: labelSvg(panel.label, panel.width), left, top: top + panel.height });
            left += panel.width + GAP;
        }
        sheetWidth = Math.max(sheetWidth, left);
        top += Math.max(...row.map((panel) => panel.height)) + LABEL_HEIGHT + GAP;
    }
    return sharp({ create: { width: sheetWidth, height: top, channels: 4, background: BACKGROUND } }).composite(layers).png().toBuffer();
}

/**
 * The review sheet of one snap, for a person to check by eye:
 *  1. the master and the snap at the same size, side by side;
 *  2. the snap at 1x and 2x with nearest-neighbour scaling;
 *  3. both sides of each face at 6x, the master beside the snap, for ears that should not be there;
 *  4. each hand at 6x in the same way.
 * @param {{ master: import('./raster.mjs').Raster, native: import('./raster.mjs').Raster, grid: { cell: number, offsetX: number, offsetY: number },
 *   regions?: ReturnType<typeof parseRegions>, caption: string }} input
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildSnapSheet({ master, native, grid, regions = { faces: [], hands: [] }, caption }) {
    const overview = { width: native.width * OVERVIEW_SCALE, height: native.height * OVERVIEW_SCALE };
    const masterOverview = await sharp(master.data, { raw: { width: master.width, height: master.height, channels: 4 } })
        .resize(overview.width, overview.height, { kernel: 'lanczos3', fit: 'fill' })
        .png()
        .toBuffer();
    const rows = [
        [
            { ...overview, png: masterOverview, label: `master (smooth resize to ${overview.width}x${overview.height}) - ${caption}` },
            { ...overview, png: await nearestPng(native, OVERVIEW_SCALE), label: `snap ${native.width}x${native.height} at ${OVERVIEW_SCALE}x nearest` },
        ],
        [
            { width: native.width, height: native.height, png: await toPng(native), label: 'snap 1x' },
            { width: native.width * 2, height: native.height * 2, png: await nearestPng(native, 2), label: 'snap 2x nearest' },
        ],
    ];
    for (const face of regions.faces) {
        const [left, right] = await Promise.all([lookCloser(master, native, grid, face.left, CROP_SCALE), lookCloser(master, native, grid, face.right, CROP_SCALE)]);
        rows.push([
            { ...left, png: left.masterPng, label: `${face.name}, left side, master` },
            { ...left, png: left.snapPng, label: `${face.name}, left side, snap ${CROP_SCALE}x` },
            { ...right, png: right.masterPng, label: `${face.name}, right side, master` },
            { ...right, png: right.snapPng, label: `${face.name}, right side, snap ${CROP_SCALE}x` },
        ]);
    }
    for (let at = 0; at < regions.hands.length; at += 2) {
        const row = [];
        for (const hand of regions.hands.slice(at, at + 2)) {
            const closer = await lookCloser(master, native, grid, hand.box, CROP_SCALE);
            row.push({ ...closer, png: closer.masterPng, label: `${hand.name}, master` }, { ...closer, png: closer.snapPng, label: `${hand.name}, snap ${CROP_SCALE}x` });
        }
        rows.push(row);
    }
    return stackRows(rows);
}

/**
 * The same area of the master and of each way of snapping it, at 6x, two to a row, so the ways of sampling can be compared by eye.
 * @param {{ master: import('./raster.mjs').Raster, grid: { cell: number, offsetX: number, offsetY: number },
 *   box: { x: number, y: number, width: number, height: number }, variants: Array<{ label: string, native: import('./raster.mjs').Raster }> }} input
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildSamplingSheet({ master, grid, box, variants }) {
    const panels = [];
    for (const [index, variant] of variants.entries()) {
        const closer = await lookCloser(master, variant.native, grid, box, CROP_SCALE);
        if (index === 0) {
            panels.push({ ...closer, png: closer.masterPng, label: 'master (smooth resize)' });
        }
        panels.push({ ...closer, png: closer.snapPng, label: variant.label });
    }
    const rows = [];
    for (let at = 0; at < panels.length; at += 2) {
        rows.push(panels.slice(at, at + 2));
    }
    return stackRows(rows);
}

const THUMB = 380;

/**
 * The head top (red) and feet (green) the figure measure found, drawn over each picture, so a head top that is really a raised hand shows.
 * A flagged picture has its label in red.
 * @param {Array<{ label: string, raster: import('./raster.mjs').Raster, headTop: number, feet: number, flagged?: boolean }>} items
 * @param {{ columns?: number }} [options]
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildBodyCheckSheet(items, { columns = 4 } = {}) {
    if (items.length === 0) {
        throw new Error('The body check sheet has nothing on it.');
    }
    const layers = [];
    const rowHeight = THUMB + LABEL_HEIGHT + GAP;
    for (const [index, item] of items.entries()) {
        const left = GAP + (index % columns) * (THUMB + GAP);
        const top = GAP + Math.floor(index / columns) * rowHeight;
        const scale = THUMB / Math.max(item.raster.width, item.raster.height);
        const picture = await sharp(item.raster.data, { raw: { width: item.raster.width, height: item.raster.height, channels: 4 } })
            .resize(THUMB, THUMB, { kernel: 'lanczos3', fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
        const lines = [[item.headTop, '#ff3030'], [item.feet, '#30ff60']].map(([y, colour]) => `<line x1="0" x2="${THUMB}" y1="${(y * scale).toFixed(1)}" y2="${(y * scale).toFixed(1)}" stroke="${colour}" stroke-width="1.5"/>`).join('');
        layers.push({ input: await sharp({ create: { width: THUMB, height: THUMB, channels: 4, background: BACKDROP } }).png().toBuffer(), left, top });
        layers.push({ input: picture, left, top });
        layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB}" height="${THUMB}">${lines}</svg>`), left, top });
        const text = `<text x="2" y="14" font-family="sans-serif" font-size="13" fill="${item.flagged ? '#ff8080' : '#ffffff'}">${escapeXml(item.label)}</text>`;
        layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB}" height="${LABEL_HEIGHT}">${text}</svg>`), left, top: top + THUMB });
    }
    const rows = Math.ceil(items.length / columns);
    return sharp({ create: { width: GAP + columns * (THUMB + GAP), height: GAP + rows * rowHeight, channels: 4, background: BACKGROUND } }).composite(layers).png().toBuffer();
}

/**
 * Each review box drawn over its picture and labelled, so a box can be checked against what it is meant to hold. Faces are orange and hands blue.
 * @param {{ label: string, raster: import('./raster.mjs').Raster, regions: ReturnType<typeof parseRegions> }} item
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildBoxCheckSheet({ raster, regions }) {
    const rect = (box, colour, name) => `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="${colour}" stroke-width="3"/><text x="${box.x + 4}" y="${box.y + 20}" font-family="sans-serif" font-size="20" fill="${colour}" stroke="#000" stroke-width="0.5">${escapeXml(name)}</text>`;
    const marks = [
        ...regions.faces.flatMap((face) => [rect(face.left, '#ff9020', `${face.name} L`), rect(face.right, '#ff9020', `${face.name} R`)]),
        ...regions.hands.map((hand) => rect(hand.box, '#40b0ff', hand.name)),
    ].join('');
    return sharp({ create: { width: raster.width, height: raster.height, channels: 4, background: BACKDROP } })
        .composite([
            { input: await toPng(raster) },
            { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${raster.width}" height="${raster.height}">${marks}</svg>`) },
        ])
        .png()
        .toBuffer();
}

/** An area of a raster, as whole pixels clamped to the raster. */
const clampRect = (rect, raster) => {
    const x = Math.max(0, Math.min(raster.width - 1, Math.floor(rect.x)));
    const y = Math.max(0, Math.min(raster.height - 1, Math.floor(rect.y)));
    return { x, y, width: Math.max(1, Math.min(raster.width - x, Math.ceil(rect.x + rect.width) - x)), height: Math.max(1, Math.min(raster.height - y, Math.ceil(rect.y + rect.height) - y)) };
};

const ITEMS_PER_ROW = 3;
const WIDE_PER_ROW = 3;

/**
 * The review sheet of a scene composed on the pixel grid, for a person to check by eye:
 *  1. the smooth composite and the grid composite at the same size (the grid one enlarged by nearest-neighbour copying to the canvas);
 *  2. the grid composite at 2x nearest;
 *  3. each face side and hand: the same area of both, the smooth one resized to match, the grid one at 6x nearest.
 * An item's `gridArea` is in art pixels of the grid composite and its `smoothArea` is in pixels of the smooth composite. An item with no
 * `smoothArea` is shown from the grid composite alone, at 6x, as a wider look at a whole face or hand.
 * @param {{ smooth: import('./raster.mjs').Raster, grid: import('./raster.mjs').Raster, items: Array<{ label: string, gridArea: object, smoothArea?: object }>, caption: string }} input
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildCompositeSheet({ smooth, grid, items, caption }) {
    const rows = [
        [
            { width: smooth.width, height: smooth.height, png: await toPng(smooth), label: `smooth composite, ${smooth.width}x${smooth.height} - ${caption}` },
            {
                width: smooth.width,
                height: smooth.height,
                png: await sharp(grid.data, { raw: { width: grid.width, height: grid.height, channels: 4 } }).resize(smooth.width, smooth.height, { kernel: 'nearest', fit: 'fill' }).png().toBuffer(),
                label: `grid composite ${grid.width}x${grid.height}, enlarged to the same size by nearest`,
            },
        ],
        [{ width: grid.width * 2, height: grid.height * 2, png: await nearestPng(grid, 2), label: 'grid composite 2x nearest' }],
    ];
    const pairs = [];
    const wide = [];
    for (const item of items) {
        const area = clampRect(item.gridArea, grid);
        const width = area.width * CROP_SCALE;
        const height = area.height * CROP_SCALE;
        if (!item.smoothArea) {
            wide.push([{ width, height, png: await nearestPng(crop(grid, area), CROP_SCALE), label: `${item.label}, grid ${CROP_SCALE}x` }]);
            continue;
        }
        const around = clampRect(item.smoothArea, smooth);
        const smoothPng = await sharp(smooth.data, { raw: { width: smooth.width, height: smooth.height, channels: 4 } })
            .extract({ left: around.x, top: around.y, width: around.width, height: around.height })
            .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
            .png()
            .toBuffer();
        pairs.push([
            { width, height, png: smoothPng, label: `${item.label}, smooth` },
            { width, height, png: await nearestPng(crop(grid, area), CROP_SCALE), label: `${item.label}, grid ${CROP_SCALE}x` },
        ]);
    }
    for (let at = 0; at < pairs.length; at += ITEMS_PER_ROW) {
        rows.push(pairs.slice(at, at + ITEMS_PER_ROW).flat());
    }
    for (let at = 0; at < wide.length; at += WIDE_PER_ROW) {
        rows.push(wide.slice(at, at + WIDE_PER_ROW).flat());
    }
    return stackRows(rows);
}
