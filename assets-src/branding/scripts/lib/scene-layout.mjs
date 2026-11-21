import { parseHexColour } from './rim-recolour.mjs';

// A scene layout is JSON: a canvas and layers. This parses it once, at the edge, into a shape the compositor can trust.

const ANCHORS = ['centre', 'bottom-centre', 'top-left'];
const MEASURES = ['box', 'figure'];

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function parsePoint(value, where) {
    if (!isPlainObject(value) || !isNumber(value.x) || !isNumber(value.y)) {
        throw new Error(`${where} needs a numeric x and y.`);
    }
    return { x: value.x, y: value.y };
}

function parseHeight(value, where) {
    if (isPositive(value)) {
        return value;
    }
    if (isPlainObject(value) && isPositive(value.ratio) && typeof value.of === 'string') {
        return { ratio: value.ratio, of: value.of };
    }
    throw new Error(`${where} height must be a positive number of canvas pixels, or { "ratio": <number>, "of": "<layer id>" }.`);
}

const GRADE_KEYS = new Set(['toward', 'amount', 'lightness', 'keepSticker']);

/**
 * A colour grade for one layer. `toward` and `amount` say what the grade is, so both are required: there is no tint that suits every
 * layer. `lightness` defaults to 0 (the lightness is left alone) and `keepSticker` to true (the shared rim and white band stay as drawn).
 * The result is plain data, with the colour written as a lowercase #rrggbb, and it is what a real run logs.
 */
function parseGrade(value, where) {
    if (!isPlainObject(value)) {
        throw new Error(`${where} grade must be an object like { "toward": "#7d8fd6", "amount": 0.14 }.`);
    }
    for (const key of Object.keys(value)) {
        if (!GRADE_KEYS.has(key)) {
            throw new Error(`${where} grade has an unknown key "${key}". Known keys: ${[...GRADE_KEYS].join(', ')}.`);
        }
    }
    if (typeof value.toward !== 'string') {
        throw new Error(`${where} grade needs "toward", a hex colour such as "#7d8fd6".`);
    }
    let toward;
    try {
        toward = parseHexColour(value.toward);
    } catch {
        throw new Error(`${where} grade toward must be a hex colour such as "#7d8fd6", got "${value.toward}".`);
    }
    if (!isNumber(value.amount) || value.amount < 0 || value.amount > 1) {
        throw new Error(`${where} grade amount must be a number from 0 to 1, got ${JSON.stringify(value.amount)}.`);
    }
    const lightness = value.lightness ?? 0;
    if (!isNumber(lightness) || lightness < -1 || lightness > 1) {
        throw new Error(`${where} grade lightness must be a number from -1 to 1, got ${JSON.stringify(value.lightness)}.`);
    }
    const keepSticker = value.keepSticker ?? true;
    if (typeof keepSticker !== 'boolean') {
        throw new Error(`${where} grade keepSticker must be true or false, got ${JSON.stringify(value.keepSticker)}.`);
    }
    return { toward: `#${toward.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`, amount: value.amount, lightness, keepSticker };
}

function parseLayer(value, index) {
    const where = `Layer ${index + 1}${isPlainObject(value) && typeof value.id === 'string' ? ` ("${value.id}")` : ''}`;
    if (!isPlainObject(value) || typeof value.id !== 'string' || value.id === '') {
        throw new Error(`${where} needs an id.`);
    }
    if (typeof value.image !== 'string' || value.image === '') {
        throw new Error(`${where} needs an image path.`);
    }
    if (!isNumber(value.z)) {
        throw new Error(`${where} needs a numeric z, the stacking order (higher is in front).`);
    }
    const at = value.at ?? 'centre';
    if (!ANCHORS.includes(at)) {
        throw new Error(`${where} has at "${at}"; use ${ANCHORS.join(', ')}.`);
    }
    const measure = value.measure ?? 'box';
    if (!MEASURES.includes(measure)) {
        throw new Error(`${where} has measure "${measure}"; use ${MEASURES.join(' or ')}.`);
    }
    if (value.pixel !== undefined && (typeof value.pixel !== 'string' || value.pixel === '')) {
        throw new Error(`${where} pixel must be the path of the snapped still, such as "approved/pixel/help-reisen.png".`);
    }
    const common = {
        id: value.id,
        image: value.image,
        z: value.z,
        at,
        measure,
        ...(value.pixel === undefined ? {} : { pixel: value.pixel }),
        ...(value.grade === undefined ? {} : { grade: parseGrade(value.grade, where) }),
    };
    if (value.repeat !== undefined) {
        if (!Array.isArray(value.repeat) || value.repeat.length === 0) {
            throw new Error(`${where} repeat must be a list of { x, y, height } points.`);
        }
        const repeat = value.repeat.map((point, at_) => ({ ...parsePoint(point, `${where} repeat ${at_ + 1}`), height: parseHeight(point?.height, `${where} repeat ${at_ + 1}`) }));
        return { ...common, repeat };
    }
    return { ...common, anchor: parsePoint(value.anchor, `${where} anchor`), height: parseHeight(value.height, where) };
}

/**
 * The pixel grid of a scene, in one of two forms. `{ cell }` is a whole number of canvas pixels per art pixel, and both sides of the canvas
 * must divide by it. `{ width, height }` is the size of the native picture in art pixels, so the cell is the canvas divided by it and may be
 * fractional; it must keep the canvas's proportions, or the cell would differ between the two axes.
 */
function parseGrid(value, canvas) {
    const form = 'A layout grid must be { "cell": <whole number of canvas pixels per art pixel> } or { "width": <art pixels>, "height": <art pixels> }, such as { "cell": 4 }.';
    if (!isPlainObject(value)) {
        throw new Error(form);
    }
    for (const key of Object.keys(value)) {
        if (!['cell', 'width', 'height'].includes(key)) {
            throw new Error(`The layout grid has an unknown key "${key}". It takes cell, or width and height.`);
        }
    }
    const byCell = value.cell !== undefined;
    const bySize = value.width !== undefined || value.height !== undefined;
    if (byCell === bySize) {
        throw new Error(form);
    }
    if (byCell) {
        if (!Number.isInteger(value.cell) || value.cell < 1) {
            throw new Error(form);
        }
        if (canvas.width % value.cell !== 0 || canvas.height % value.cell !== 0) {
            throw new Error(`The ${canvas.width} x ${canvas.height} canvas is not a whole number of ${value.cell} pixel cells, so the grid would not cover it.`);
        }
        return { cell: value.cell, width: canvas.width / value.cell, height: canvas.height / value.cell };
    }
    if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1) {
        throw new Error(form);
    }
    if (canvas.width * value.height !== canvas.height * value.width) {
        throw new Error(`A ${value.width} x ${value.height} grid does not keep the proportions of the ${canvas.width} x ${canvas.height} canvas, so its cell would differ between the two axes.`);
    }
    return { cell: canvas.width / value.width, width: value.width, height: value.height };
}

/**
 * @param {unknown} value the parsed JSON
 * @returns {{ canvas: { width: number, height: number }, grid?: { cell: number, width: number, height: number }, layers: Array<{ id: string, image: string, z: number, at: string, measure: string, pixel?: string, grade?: { toward: string, amount: number, lightness: number, keepSticker: boolean }, anchor?: { x: number, y: number }, height?: number | { ratio: number, of: string }, repeat?: Array<{ x: number, y: number, height: number | { ratio: number, of: string } }> }> }}
 */
export function parseLayout(value) {
    if (!isPlainObject(value) || !isPlainObject(value.canvas) || !isPositive(value.canvas.width) || !isPositive(value.canvas.height)) {
        throw new Error('A layout needs a canvas with a positive width and height.');
    }
    if (!Number.isInteger(value.canvas.width) || !Number.isInteger(value.canvas.height)) {
        throw new Error('The canvas width and height must be whole numbers of pixels.');
    }
    if (!Array.isArray(value.layers) || value.layers.length === 0) {
        throw new Error('A layout needs at least one layer.');
    }
    const layers = value.layers.map(parseLayer);
    const ids = new Set();
    for (const { id } of layers) {
        if (ids.has(id)) {
            throw new Error(`Two layers are called "${id}"; ids must be unique.`);
        }
        ids.add(id);
    }
    for (const layer of layers) {
        for (const height of layer.repeat ? layer.repeat.map((point) => point.height) : [layer.height]) {
            if (typeof height === 'object' && !ids.has(height.of)) {
                throw new Error(`Layer "${layer.id}" takes its height from "${height.of}", which is not a layer.`);
            }
        }
    }
    const canvas = { width: value.canvas.width, height: value.canvas.height };
    return { canvas, ...(value.grid === undefined ? {} : { grid: parseGrid(value.grid, canvas) }), layers };
}
