import { findOrphans, applyOrphanFixes } from './pixelate.mjs';
import { detectAxes } from './pixel-grid.mjs';
import { oklabToSrgb, srgbToOklab } from './pixel-colour.mjs';
import { createRaster, opaqueBox } from './raster.mjs';
import { distanceToMask, measureRimWidth } from './rim-add.mjs';
import { locateSticker, parseHexColour } from './rim-recolour.mjs';
import { measureFigureScaled } from './scene-measure.mjs';
import { labelComponents } from './shape-ops.mjs';

export const SAMPLES = ['median', 'mode'];
// Pixels at least this opaque are part of the picture; the master's soft sticker edge fades out below it.
const VISIBLE = 128;
// A master pixel this opaque is a solid part of the figure and counts when the snap is measured against it.
const SOLID = 200;
const RIM = 1;
const BAND = 2;
// The middle share of each cell that is read, because the rim of a cell holds the blur from its neighbours.
const INNER_SHARE = 0.6;
// Search window for the pitch, in master pixels. The pictures are drawn at about 2.5 to 4.5 pixels per art pixel.
const DEFAULT_WINDOW = { minCell: 2.2, maxCell: 5 };
const WEAK_STRENGTH = 1.1;
// The sticker's rim and white band colours.
export const STICKER_RIM = [185, 155, 242];
export const STICKER_BAND = [255, 255, 255];
// The widest ring `measureRings` looks for, in art pixels.
const MAX_RING_WIDTH = 16;
// A ring pixel this far from its colour (OKLab distance) counts as broken by the snap.
const RING_TOLERANCE = 0.06;
// An island of this many opaque pixels or fewer is a speck of noise, not part of the figure.
const MIN_ISLAND = 6;
// Colours within this OKLab distance count as one colour when looking for orphans, so sampling noise is not reported as hundreds of lone pixels.
const ORPHAN_TOLERANCE = 0.03;

/** The colour tolerance for finding orphans: none when the picture is on a palette (its colours are exact), the noise margin otherwise. */
export const orphanToleranceFor = (colours) => (colours === undefined ? ORPHAN_TOLERANCE : 0);

const hexOf = (rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
const medianColour = (pixels) => [0, 1, 2].map((channel) => median(pixels.map((pixel) => pixel[channel])));

/**
 * The cell, as one square size for both axes, with how the picture was measured. With `cell` it is taken as given; with `figureHeight`
 * it is the cell at which the picture's opaque box (ears included) is that many art pixels tall; with `bodyHeight` it is the cell at which
 * the figure from head top to feet, ears left out, is that many art pixels tall (the head top is found by `measureFigureScaled`, the same
 * rule `compose-scene` sizes a figure by, and the call fails when it is not found); and with none it is the mean of the pitch found across
 * and the pitch found down. The offsets of the grid are always searched at the chosen cell.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ cell?: number, figureHeight?: number, bodyHeight?: number, window?: { minCell: number, maxCell: number } }} [options]
 */
export function chooseGrid(raster, { cell, figureHeight, bodyHeight, window = DEFAULT_WINDOW } = {}) {
    const box = opaqueBox(raster, VISIBLE);
    if (!box) {
        throw new Error(`The picture has nothing opaque (alpha ${VISIBLE} or more).`);
    }
    if ([cell, figureHeight, bodyHeight].filter((given) => given !== undefined).length > 1) {
        throw new Error('Give a cell, a figure height or a body height, not more than one.');
    }
    if (cell !== undefined && !(cell > 1)) {
        throw new Error(`The cell must be more than 1 master pixel, got ${cell}.`);
    }
    for (const [name, value] of [['figure height', figureHeight], ['body height', bodyHeight]]) {
        if (value !== undefined && !(value >= 8)) {
            throw new Error(`The ${name} must be at least 8 art pixels, got ${value}.`);
        }
    }
    const body = measureFigureScaled(raster);
    if (bodyHeight !== undefined && body.method !== 'head') {
        throw new Error('The head top of this figure could not be found (no row inside the sticker has a long enough run of pixels that are not ear coloured), so a body height cannot be set. Use --cell or --figure-height, or look at the picture.');
    }
    const detected = detectAxes(raster, box, window);
    const wanted = figureHeight ?? bodyHeight;
    const measured = bodyHeight === undefined ? box.height : body.figureHeight;
    const chosen = cell ?? (wanted === undefined ? (detected.across.cell + detected.down.cell) / 2 : measured / wanted);
    if (!(chosen > 1)) {
        throw new Error(`The figure is ${measured} pixels tall, so ${wanted} art pixels would need a cell of ${chosen.toFixed(2)}; it must be more than 1.`);
    }
    const fitted = detectAxes(raster, box, { minCell: chosen, maxCell: chosen });
    return {
        cell: chosen,
        cellSource: cell !== undefined ? 'manual' : bodyHeight !== undefined ? 'body-height' : figureHeight !== undefined ? 'figure-height' : 'detected',
        offsetX: fitted.across.offset,
        offsetY: fitted.down.offset,
        pitchAcross: detected.across.cell,
        pitchDown: detected.down.cell,
        strengthAcross: detected.across.strength,
        strengthDown: detected.down.strength,
        fitAcross: fitted.across.strength,
        fitDown: fitted.down.strength,
        body,
        box,
    };
}

/** One cell's colour from the middle of the cell: the median of the visible pixels, or the median of the commonest 4 bit colour among them. */
function readCell(raster, { x0, y0, cell, sample }) {
    const { width, height, data } = raster;
    const margin = (cell * (1 - INNER_SHARE)) / 2;
    // A pixel belongs to the cell its centre lies in, which is the rule the grid search scores its lines by.
    const left = Math.max(0, Math.ceil(x0 + margin - 0.5));
    const top = Math.max(0, Math.ceil(y0 + margin - 0.5));
    const right = Math.min(width, Math.max(left + 1, Math.ceil(x0 + cell - margin - 0.5)));
    const bottom = Math.min(height, Math.max(top + 1, Math.ceil(y0 + cell - margin - 0.5)));
    const visible = [];
    let total = 0;
    for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
            total++;
            const at = (y * width + x) * 4;
            if (data[at + 3] >= VISIBLE) {
                visible.push([data[at], data[at + 1], data[at + 2]]);
            }
        }
    }
    if (total === 0 || visible.length * 2 < total) {
        return undefined;
    }
    if (sample === 'median') {
        return medianColour(visible);
    }
    const bins = new Map();
    for (const pixel of visible) {
        const key = ((pixel[0] >> 4) << 8) | ((pixel[1] >> 4) << 4) | (pixel[2] >> 4);
        bins.set(key, [...(bins.get(key) ?? []), pixel]);
    }
    const [, winners] = [...bins.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0];
    return medianColour(winners);
}

/**
 * Reads one pixel per cell of the grid: the colour of the middle of the cell, opaque when at least half of the middle is visible
 * in the master, transparent otherwise, so alpha is binary. Nothing is averaged across cells and no resize is involved.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ cell: number, offsetX: number, offsetY: number }} grid
 * @param {'median' | 'mode'} sample
 */
export function sampleGrid(raster, { cell, offsetX, offsetY }, sample = 'median') {
    if (!SAMPLES.includes(sample)) {
        throw new Error(`sample must be one of ${SAMPLES.join(', ')}, got "${sample}".`);
    }
    const columns = Math.floor((raster.width - offsetX) / cell);
    const rows = Math.floor((raster.height - offsetY) / cell);
    const native = createRaster(columns, rows);
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const colour = readCell(raster, { x0: offsetX + column * cell, y0: offsetY + row * cell, cell, sample });
            if (colour) {
                native.data.set([...colour, 255], (row * columns + column) * 4);
            }
        }
    }
    return native;
}

/**
 * How far the snapped picture is from the master it was read from: the mean absolute difference per colour channel (0 to 255)
 * between every solid master pixel and the native pixel of its cell. A smaller cell always scores lower, so compare only
 * snaps of one cell.
 * @param {import('./raster.mjs').Raster} master
 * @param {import('./raster.mjs').Raster} native
 * @param {{ cell: number, offsetX: number, offsetY: number }} grid
 */
export function reprojectionError(master, native, { cell, offsetX, offsetY }) {
    let total = 0;
    let counted = 0;
    for (let y = 0; y < master.height; y++) {
        const row = Math.floor((y + 0.5 - offsetY) / cell);
        for (let x = 0; x < master.width; x++) {
            const column = Math.floor((x + 0.5 - offsetX) / cell);
            const at = (y * master.width + x) * 4;
            if (master.data[at + 3] < SOLID || row < 0 || column < 0 || row >= native.height || column >= native.width) {
                continue;
            }
            const to = (row * native.width + column) * 4;
            if (native.data[to + 3] === 0) {
                continue;
            }
            total += Math.abs(master.data[at] - native.data[to]) + Math.abs(master.data[at + 1] - native.data[to + 1]) + Math.abs(master.data[at + 2] - native.data[to + 2]);
            counted++;
        }
    }
    return counted === 0 ? 0 : total / counted / 3;
}

/**
 * Replaces every colour with the nearest of `count` colours chosen from the picture itself (k-means in OKLab on the distinct colours,
 * seeded from the commonest, then by distance weighted by the square root of how common a colour is, so a small distinct detail such
 * as an eye keeps a colour of its own). This removes the noise of sampling and leaves flat areas of one colour.
 * @param {import('./raster.mjs').Raster} native
 * @param {number} count
 */
export function reduceColours(native, count) {
    if (!Number.isInteger(count) || count < 2) {
        throw new Error(`The number of colours must be a whole number of 2 or more, got ${count}.`);
    }
    const counts = new Map();
    for (let at = 0; at < native.data.length; at += 4) {
        if (native.data[at + 3] === 255) {
            const key = native.data.readUIntBE(at, 3);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    const points = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([key, weight]) => ({ key, weight, lab: srgbToOklab([key >> 16, (key >> 8) & 255, key & 255]) }));
    if (points.length <= count) {
        return { raster: native, colours: points.length };
    }
    const distance = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const centres = [points[0].lab];
    const nearest = points.map((point) => distance(point.lab, centres[0]));
    while (centres.length < count) {
        let pick = 0;
        for (let index = 1; index < points.length; index++) {
            if (Math.sqrt(points[index].weight) * nearest[index] > Math.sqrt(points[pick].weight) * nearest[pick]) {
                pick = index;
            }
        }
        centres.push(points[pick].lab);
        points.forEach((point, index) => {
            nearest[index] = Math.min(nearest[index], distance(point.lab, points[pick].lab));
        });
    }
    let assignment = new Array(points.length).fill(0);
    for (let pass = 0; pass < 12; pass++) {
        assignment = points.map((point) => centres.reduce((best, centre, index) => (distance(point.lab, centre) < distance(point.lab, centres[best]) ? index : best), 0));
        centres.forEach((centre, index) => {
            const members = points.filter((_, at) => assignment[at] === index);
            const weight = members.reduce((sum, point) => sum + point.weight, 0);
            if (weight > 0) {
                centres[index] = [0, 1, 2].map((channel) => members.reduce((sum, point) => sum + point.lab[channel] * point.weight, 0) / weight);
            }
        });
    }
    const palette = centres.map((centre) => oklabToSrgb(centre).map((channel) => Math.min(255, Math.max(0, Math.round(channel)))));
    const target = new Map(points.map((point, index) => [point.key, palette[assignment[index]]]));
    const reduced = { ...native, data: Buffer.from(native.data) };
    for (let at = 0; at < reduced.data.length; at += 4) {
        if (reduced.data[at + 3] === 255) {
            reduced.data.set(target.get(reduced.data.readUIntBE(at, 3)), at);
        }
    }
    return { raster: reduced, colours: new Set(palette.map(hexOf)).size };
}

/** Removes islands of `MIN_ISLAND` opaque pixels or fewer, and fills one-pixel holes, so the silhouette is a clean shape before the rings are built. */
function cleanSilhouette(native) {
    const { width, height } = native;
    const mask = Uint8Array.from({ length: width * height }, (_, at) => (native.data[at * 4 + 3] === 255 ? 1 : 0));
    const { labels, areas } = labelComponents(mask, width, height);
    const cleaned = { ...native, data: Buffer.from(native.data) };
    let specks = 0;
    for (let at = 0; at < mask.length; at++) {
        if (mask[at] === 1 && areas[labels[at] - 1] <= MIN_ISLAND) {
            cleaned.data.fill(0, at * 4, at * 4 + 4);
            specks++;
        }
    }
    const holes = findOrphans(cleaned).filter(({ kind }) => kind === 'hole');
    return { raster: applyOrphanFixes(cleaned, holes), specks, holes: holes.length };
}

/**
 * The rim and white band of the sticker, as they should be: from the figure's silhouette outward in, every opaque pixel within
 * `rimWidth` art pixels (straight-line distance) of transparent space is the rim colour, and the next `bandWidth` are the band
 * colour. `broken` counts the pixels in those two rings that the snap left a visibly wrong colour, which is what a gap looks like.
 * @param {import('./raster.mjs').Raster} native
 * @param {{ rimWidth: number, bandWidth: number, rim: number[], band: number[] }} rings
 */
export function repairRings(native, { rimWidth, bandWidth, rim, band }) {
    const { width, height } = native;
    const clear = Uint8Array.from({ length: width * height }, (_, at) => (native.data[at * 4 + 3] === 0 ? 1 : 0));
    const distance = distanceToMask(clear, width, height);
    const repaired = { ...native, data: Buffer.from(native.data) };
    const near = (at, colour) => {
        const lab = srgbToOklab([native.data[at * 4], native.data[at * 4 + 1], native.data[at * 4 + 2]]);
        const wanted = srgbToOklab(colour);
        return Math.hypot(lab[0] - wanted[0], lab[1] - wanted[1], lab[2] - wanted[2]) <= RING_TOLERANCE;
    };
    const ringClass = new Uint8Array(clear.length);
    let broken = 0;
    let changed = 0;
    for (let at = 0; at < clear.length; at++) {
        if (clear[at] === 1) {
            continue;
        }
        const depth = distance[at];
        const inRim = depth <= rimWidth + 1e-6;
        const colour = inRim ? rim : depth <= rimWidth + bandWidth + 1e-6 ? band : undefined;
        if (!colour) {
            continue;
        }
        ringClass[at] = inRim ? RIM : BAND;
        broken += near(at, colour) ? 0 : 1;
        if (colour.some((channel, index) => native.data[at * 4 + index] !== channel)) {
            repaired.data.set(colour, at * 4);
            changed++;
        }
    }
    return { raster: repaired, broken, changed, ...ringShape(ringClass, width, height) };
}

/**
 * The widths the sticker rings of a snapped picture really have. The rim width is the largest whole number of art pixels within which
 * every opaque pixel is the rim colour, and the band width is the same for the pixels after it in the band colour, so a gap in a ring
 * or a ring that is too thin shows as a smaller width. It reads the finished picture (touch-ups included), not what the repair meant to
 * do. Pixels of the band colour elsewhere (white socks, fur) are art, so they are not counted.
 * @param {import('./raster.mjs').Raster} native
 * @param {{ rim: number[], band: number[] }} colours
 */
export function measureRings(native, { rim, band }) {
    const { width, height } = native;
    const clear = Uint8Array.from({ length: width * height }, (_, at) => (native.data[at * 4 + 3] === 0 ? 1 : 0));
    const depth = distanceToMask(clear, width, height);
    const opaque = [];
    for (let at = 0; at < clear.length; at++) {
        if (clear[at] === 0) {
            opaque.push(at);
        }
    }
    const isColour = (at, colour) => colour.every((channel, index) => native.data[at * 4 + index] === channel);
    const EPSILON = 1e-6;
    const reach = (from, colour) => {
        let widest = 0;
        while (widest < MAX_RING_WIDTH && opaque.every((at) => depth[at] > from + widest + 1 + EPSILON || depth[at] <= from + EPSILON || isColour(at, colour))) {
            widest++;
        }
        return widest;
    };
    const rimWidth = reach(0, rim);
    const bandWidth = reach(rimWidth, band);
    return { rimWidth, bandWidth };
}

/**
 * How continuous the rings are. `pieces` counts the separate 8-connected runs of each ring (a figure with no hole in it has one outline,
 * so one piece, unless the canvas edge cuts it); `isolated` counts ring pixels with no neighbour of their own ring, which would be an orphan.
 */
function ringShape(ringClass, width, height) {
    const shape = {};
    for (const [name, ring] of [['rim', RIM], ['band', BAND]]) {
        const mask = ringClass.map((value) => (value === ring ? 1 : 0));
        const { areas } = labelComponents(mask, width, height);
        let isolated = 0;
        for (let at = 0; at < mask.length; at++) {
            isolated += mask[at] === 1 && hasNoNeighbour(mask, at, width, height) ? 1 : 0;
        }
        shape[name] = { pieces: areas.length, isolated };
    }
    return { rimShape: shape.rim, bandShape: shape.band };
}

const hasNoNeighbour = (mask, at, width, height) => {
    const x = at % width;
    const y = (at - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const inside = x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height;
            if ((dx !== 0 || dy !== 0) && inside && mask[(y + dy) * width + x + dx] === 1) {
                return false;
            }
        }
    }
    return true;
};

/** How many different opaque colours a picture holds. */
export function countColours(raster) {
    const seen = new Set();
    for (let at = 0; at < raster.data.length; at += 4) {
        if (raster.data[at + 3] > 0) {
            seen.add(raster.data.readUIntBE(at, 3));
        }
    }
    return seen.size;
}

/**
 * The widths of the rim and the white band in art pixels, from the master's own: how deep the master's rim and band reach, divided
 * by the cell, rounded, and never under 1.
 * @param {import('./raster.mjs').Raster} master
 * @param {number} cell
 */
export function ringWidths(master, cell) {
    const { band } = locateSticker(master);
    const rim = measureRimWidth(master);
    const bandWidth = band.end - band.start + 1;
    return { rimMaster: rim, bandMaster: bandWidth, rimWidth: Math.max(1, Math.round(rim / cell)), bandWidth: Math.max(1, Math.round(bandWidth / cell)) };
}

/**
 * Snaps a master to a true pixel grid: finds (or is given) the cell, reads one colour per cell, optionally reduces the colours to
 * `colours`, makes alpha binary, and rebuilds the sticker rings so they come out continuous and in the shared rim colour.
 * Touch-ups are not made here; they are a patch applied afterwards, so snapping a master again gives the same file.
 * @param {import('./raster.mjs').Raster} master
 * @param {{ cell?: number, figureHeight?: number, bodyHeight?: number, sample?: 'median' | 'mode', colours?: number, ringRepair?: boolean, rim?: string,
 *   band?: string, rimWidth?: number, bandWidth?: number }} [options]
 */
export function snapRaster(master, { cell, figureHeight, bodyHeight, sample = 'median', colours, ringRepair = true, rim = '#b99bf2', band = '#ffffff', rimWidth, bandWidth } = {}) {
    const warnings = [];
    const grid = chooseGrid(master, { cell, figureHeight, bodyHeight });
    if (grid.cellSource === 'detected' && Math.min(grid.strengthAcross, grid.strengthDown) < WEAK_STRENGTH) {
        warnings.push(`The grid is weak (strength ${grid.strengthAcross.toFixed(2)} across, ${grid.strengthDown.toFixed(2)} down; 1 is chance), so the detected pitch is not to be trusted. Pass --cell, --figure-height or --body-height.`);
    }
    if (grid.cellSource === 'detected' && Math.abs(grid.pitchAcross - grid.pitchDown) / grid.cell > 0.05) {
        warnings.push(`The pitch differs between the axes (${grid.pitchAcross.toFixed(2)} across, ${grid.pitchDown.toFixed(2)} down); the mean ${grid.cell.toFixed(2)} was used as a square cell.`);
    }
    let native = sampleGrid(master, grid, sample);
    let coloursUsed;
    if (colours !== undefined) {
        ({ raster: native, colours: coloursUsed } = reduceColours(native, colours));
    }
    const error = reprojectionError(master, native, grid);
    const cleaned = cleanSilhouette(native);
    native = cleaned.raster;

    let rings;
    if (ringRepair) {
        const given = rimWidth !== undefined && bandWidth !== undefined;
        let widths = { rimWidth, bandWidth };
        try {
            const measured = ringWidths(master, grid.cell);
            widths = { ...measured, ...Object.fromEntries(Object.entries({ rimWidth, bandWidth }).filter(([, value]) => value !== undefined)) };
        } catch (error) {
            // Widths that were given need no measure; the master's own are then only left out of the report.
            if (!given) {
                throw new Error(`The sticker rings could not be measured on the master (${error.message}). Pass --rim-width and --band-width, or --no-ring-repair.`);
            }
        }
        const repaired = repairRings(native, { rimWidth: widths.rimWidth, bandWidth: widths.bandWidth, rim: parseHexColour(rim), band: parseHexColour(band) });
        native = repaired.raster;
        rings = { rimWidth: widths.rimWidth, bandWidth: widths.bandWidth, rimMaster: widths.rimMaster, bandMaster: widths.bandMaster, rim: hexOf(parseHexColour(rim)), band: hexOf(parseHexColour(band)), broken: repaired.broken, changed: repaired.changed, rimShape: repaired.rimShape, bandShape: repaired.bandShape };
    }

    const orphans = findOrphans(native, { tolerance: orphanToleranceFor(colours) });
    const sprite = opaqueBox(native);
    if (sprite && (sprite.x === 0 || sprite.y === 0 || sprite.x + sprite.width === native.width || sprite.y + sprite.height === native.height)) {
        warnings.push('The figure touches the edge of the snapped canvas.');
    }
    return {
        raster: native,
        report: {
            master: { width: master.width, height: master.height, figure: grid.box },
            cell: grid.cell,
            cellSource: grid.cellSource,
            targetFigureHeight: figureHeight ?? null,
            targetBodyHeight: bodyHeight ?? null,
            bodyAtCell: { headTop: grid.body.headTop, feet: grid.body.feet, masterHeight: grid.body.figureHeight, method: grid.body.method },
            offset: { x: grid.offsetX, y: grid.offsetY },
            pitchAcross: grid.pitchAcross,
            pitchDown: grid.pitchDown,
            strengthAcross: grid.strengthAcross,
            strengthDown: grid.strengthDown,
            fit: { across: grid.fitAcross, down: grid.fitDown },
            reprojectionError: error,
            size: { width: native.width, height: native.height },
            figure: sprite,
            figureHeight: sprite?.height,
            sample,
            colours: colours === undefined ? null : colours,
            coloursUsed: coloursUsed ?? null,
            specksRemoved: cleaned.specks,
            holesFilled: cleaned.holes,
            rings: rings ?? null,
            orphans,
            orphansNear: findOrphans(native, { tolerance: ORPHAN_TOLERANCE }).length,
            orphansExact: findOrphans(native).length,
            warnings,
        },
    };
}
