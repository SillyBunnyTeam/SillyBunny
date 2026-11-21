import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectPlateGrid, fitMoon, findPlateShift, snapBackdrop } from './github-backdrop.mjs';
import { SNAPPED_DIR } from './github-paths.mjs';
import { encodePng, readRaster } from './raster.mjs';

const CONFIG_KEYS = new Set(['plates']);
const PLATE_KEYS = new Set(['master', 'note', 'light', 'like', 'detect', 'variants', 'compare']);
const COMPARE_KEYS = new Set(['against', 'boxes', 'moonCentres', 'moonRadii']);
const VARIANT_KEYS = new Set(['note', 'cell', 'step', 'x', 'y', 'columns', 'rows', 'at', 'bleed']);

/** The name that a snapped plate has, which a layout names as the source of its backdrop. */
export const backdropName = (plate, variant) => `backdrop-${plate}-${variant}`;

/** @param {string} rootDir */
export function loadBackdropConfig(rootDir) {
    const path = join(rootDir, 'github-backdrops.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const unknown = Object.keys(config).find((key) => !CONFIG_KEYS.has(key));
    if (unknown) {
        throw new Error(`${path} has an unknown key "${unknown}". Known keys: ${[...CONFIG_KEYS].join(', ')}.`);
    }
    for (const [plate, entry] of Object.entries(config.plates)) {
        const where = `${path}: plate "${plate}"`;
        const stray = Object.keys(entry).find((key) => !PLATE_KEYS.has(key));
        if (stray) {
            throw new Error(`${where} has an unknown key "${stray}".`);
        }
        if (typeof entry.master !== 'string') {
            throw new Error(`${where} needs a "master", the path of its picture.`);
        }
        if (entry.light === null || typeof entry.light !== 'object' || !Number.isInteger(entry.light.x) || Object.keys(entry.light).some((key) => key !== 'x')) {
            throw new Error(`${where} needs "light": { "x": n }, the whole blocks that its light moves a shadow to the right (0 for a light straight above).`);
        }
        assertCrops(entry, config.plates, where);
        if (entry.compare) {
            assertCompare(entry.compare, config.plates, where);
        }
    }
    return config;
}

/** A plate has crops of its own (a grid to detect and variants), or takes those of the plate that it is `like`, an edit of it. */
function assertCrops(entry, plates, where) {
    if (entry.like !== undefined) {
        const base = plates[entry.like];
        if (!base || base.like !== undefined || 'detect' in entry || 'variants' in entry) {
            throw new Error(`${where} is like "${entry.like}", which must be another plate with crops of its own, and a plate that is like another has none.`);
        }
        return;
    }
    if (!entry.detect?.box || !entry.detect.windows) {
        throw new Error(`${where} needs "detect" (the box and the cell windows to find its grid in) or "like".`);
    }
    if (!entry.variants || Object.keys(entry.variants).length === 0) {
        throw new Error(`${where} needs "variants", its crops.`);
    }
    assertVariants(entry.variants, where);
}

/** What an edited plate is compared with, and where: the regions in which a shift is looked for, and the moon. */
function assertCompare(compare, plates, where) {
    const stray = Object.keys(compare).find((key) => !COMPARE_KEYS.has(key));
    if (stray) {
        throw new Error(`${where}: compare has an unknown key "${stray}".`);
    }
    if (!plates[compare.against]) {
        throw new Error(`${where}: compare.against "${compare.against}" is not a plate.`);
    }
    if (!compare.boxes || Object.keys(compare.boxes).length === 0 || !compare.moonCentres || !compare.moonRadii) {
        throw new Error(`${where}: compare needs boxes, moonCentres and moonRadii.`);
    }
}

function assertVariants(variants, where) {
    for (const [name, variant] of Object.entries(variants)) {
        const stray = Object.keys(variant).find((key) => !VARIANT_KEYS.has(key));
        if (stray) {
            throw new Error(`${where}: variant "${name}" has an unknown key "${stray}".`);
        }
        if (!Number.isInteger(variant.step) || variant.step < 1 || !(variant.cell > 0)) {
            throw new Error(`${where}: variant "${name}" needs a whole step of 1 or more and a cell above 0.`);
        }
        if (!Number.isFinite(variant.x) || !Number.isFinite(variant.y)) {
            throw new Error(`${where}: variant "${name}" needs "x" and "y", the master pixel where its first art pixel starts.`);
        }
    }
}

/**
 * A plate with its crops, whether it has them or takes them from the plate that it is like.
 * @param {ReturnType<typeof loadBackdropConfig>} config
 * @param {string} plate
 */
export function resolvePlate(config, plate) {
    const entry = config.plates[plate];
    const base = entry.like === undefined ? entry : config.plates[entry.like];
    return { ...entry, detect: base.detect, variants: base.variants };
}

/**
 * Whether the night plate is the day plate edited in place: the shift of its edges in each region, and the moon found in each.
 * @param {import('./raster.mjs').Raster} day
 * @param {import('./raster.mjs').Raster} night
 * @param {{ boxes: Record<string, { x: number, y: number, width: number, height: number }>, moonCentres: { x: number, y: number, width: number, height: number }, moonRadii: { min: number, max: number } }} compare
 * the regions to compare, the centres to try for the moon, and the radii
 */
export function comparePlates(day, night, { boxes, moonCentres, moonRadii }) {
    const regions = Object.entries(boxes).map(([name, box]) => ({ name, ...findPlateShift(day, night, box) }));
    const dayMoon = fitMoon(day, moonCentres, moonRadii);
    const nightMoon = fitMoon(night, moonCentres, moonRadii);
    return { regions, moon: { day: dayMoon, night: nightMoon, dx: nightMoon.x - dayMoon.x, dy: nightMoon.y - dayMoon.y, dradius: nightMoon.radius - dayMoon.radius } };
}

/**
 * Snaps the variants of a plate (all of them, or those named in `only`) into out/github/snapped, each with the plate's own detected grid.
 * @param {{ rootDir: string, plate: string, config: ReturnType<typeof loadBackdropConfig>, only?: string[] }} request
 */
export async function snapPlate({ rootDir, plate, config, only }) {
    const master = await readRaster(join(rootDir, config.plates[plate].master));
    const { detect, variants: crops } = resolvePlate(config, plate);
    const unknown = (only ?? []).find((variant) => !Object.hasOwn(crops, variant));
    if (unknown) {
        throw new Error(`The plate "${plate}" has no "${unknown}" crop. Its crops: ${Object.keys(crops).join(', ')}.`);
    }
    const grid = detectPlateGrid(master, detect.box, detect.windows);
    const variants = [];
    for (const [variant, window] of Object.entries(crops).filter(([name]) => !only || only.includes(name))) {
        const picture = snapBackdrop(master, grid, window);
        const file = join(SNAPPED_DIR, `${backdropName(plate, variant)}.png`);
        const png = await encodePng(picture);
        mkdirSync(dirname(join(rootDir, file)), { recursive: true });
        writeFileSync(join(rootDir, file), png);
        variants.push({ variant, file, columns: picture.width, rows: picture.height, step: window.step, cell: window.cell, window, png });
    }
    return { plate, master, grid, variants };
}

const gridAxis = ({ cell, offset, strength }) => ({ cell, offset, strength });

/**
 * The snapped variants of plates as the pictures of a logged run. Each is called by the name a layout gives its backdrop, which is the
 * name of its approved copy (approved/pixel/<name>.png). A plate that is an edit of another (`like`) is snapped on a grid of its own.
 * @param {ReturnType<typeof loadBackdropConfig>} config
 * @param {Array<Awaited<ReturnType<typeof snapPlate>>>} snapped
 * @returns {import('./github-snap-log.mjs').LoggedSnap[]}
 */
export const loggedPlates = (config, snapped) => snapped.flatMap(({ plate, grid, variants }) => variants.map(({ variant, columns, rows, window, png }) => {
    const id = backdropName(plate, variant);
    const { master, like } = config.plates[plate];
    const { cell, step, x, y } = window;
    return {
        id,
        png,
        size: { width: columns, height: rows },
        master,
        vars: { id, master, character: null, tool: 'github-backdrop.mjs', plate, variant, like: like ?? null, grid: { across: gridAxis(grid.across), down: gridAxis(grid.down) }, crop: { cell, step, x, y, columns, rows } },
    };
}));
