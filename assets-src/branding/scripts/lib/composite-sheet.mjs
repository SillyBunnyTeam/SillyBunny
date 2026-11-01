import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readLog } from './log.mjs';
import { opaqueBox, readRaster } from './raster.mjs';
import { composeGridScene, composeScene, TRIM_ALPHA } from './scene-compose.mjs';
import { parseLayout } from './scene-layout.mjs';
import { buildCompositeSheet, parseRegions } from './snap-sheet.mjs';

// Art pixels of room added around a box for the wider look, so a hand that runs past its box is still whole.
const WIDE_MARGIN = 6;
const pad = (area) => ({ x: area.x - WIDE_MARGIN, y: area.y - WIDE_MARGIN, width: area.width + 2 * WIDE_MARGIN, height: area.height + 2 * WIDE_MARGIN });

/** How the snap of `pixelFile` was made, from the log: the cell and the offsets its grid started at. */
function snapGridOf(rootDir, pixelFile) {
    const entry = readLog(join(rootDir, 'log', 'generations.jsonl')).findLast((one) => one.template === 'pixel-snap' && one.outputs.some((output) => output.file === pixelFile));
    if (!entry) {
        throw new Error(`The log has no pixel-snap of ${pixelFile}, so the review boxes cannot be placed on the grid composite.`);
    }
    return { cell: entry.vars.cell, offsetX: entry.vars.offset.x, offsetY: entry.vars.offset.y };
}

/**
 * The review sheet of a grid scene against the smooth composite of the same layout. A layer with a `review/<name>-<layer id>.json`
 * has its face and hand boxes (in the pixels of its still) carried to the grid composite through the still's snap grid and its placement,
 * and to the smooth composite through its smooth placement.
 * @param {{ rootDir: string, gridLayoutPath: string, smoothPath: string, gridPath: string, name: string }} request
 * `gridLayoutPath` is `layouts/<name>.grid.json`; the smooth layout is `layouts/<name>.json` beside it
 */
export async function compositeSheetFor({ rootDir, gridLayoutPath, smoothPath, gridPath, name }) {
    const smoothLayoutPath = gridLayoutPath.replace(/\.grid\.json$/, '.json');
    if (smoothLayoutPath === gridLayoutPath) {
        throw new Error(`${gridLayoutPath} is not a grid layout (layouts/<name>.grid.json).`);
    }
    const gridLayout = parseLayout(JSON.parse(readFileSync(gridLayoutPath, 'utf8')));
    const smoothLayout = parseLayout(JSON.parse(readFileSync(smoothLayoutPath, 'utf8')));
    if (!gridLayout.grid) {
        throw new Error(`${gridLayoutPath} has no "grid".`);
    }
    const stills = new Map();
    const raws = new Map();
    for (const layer of gridLayout.layers) {
        stills.set(layer.id, await readRaster(resolve(rootDir, layer.pixel)));
    }
    for (const layer of smoothLayout.layers) {
        raws.set(layer.id, await readRaster(resolve(rootDir, layer.image)));
    }
    const smoothPlacements = (await composeScene(smoothLayout, raws)).placements;
    const gridPlacements = composeGridScene(gridLayout, stills).placements;

    const [smooth, grid] = [await readRaster(smoothPath), await readRaster(gridPath)];
    const items = [];
    const wideItems = [];
    for (const layer of gridLayout.layers) {
        const reviewPath = join(rootDir, 'review', `${name}-${layer.id}.json`);
        if (!existsSync(reviewPath)) {
            continue;
        }
        const regions = parseRegions(JSON.parse(readFileSync(reviewPath, 'utf8')), { width: 1024, height: 1024 });
        const snap = snapGridOf(rootDir, layer.pixel);
        const stillBox = opaqueBox(stills.get(layer.id), 1);
        const rawBox = opaqueBox(raws.get(layer.id), TRIM_ALPHA);
        const placed = gridPlacements.find((placement) => placement.id === layer.id);
        const smoothPlaced = smoothPlacements.find((placement) => placement.id === layer.id);
        const boxes = [
            ...regions.faces.flatMap((face) => [[`${layer.id} ${face.name} left`, face.left], [`${layer.id} ${face.name} right`, face.right]]),
            ...regions.hands.map((hand) => [`${layer.id} ${hand.name}`, hand.box]),
        ];
        for (const [label, box] of boxes) {
            const gridArea = {
                x: placed.left + (box.x - snap.offsetX) / snap.cell - stillBox.x,
                y: placed.top + (box.y - snap.offsetY) / snap.cell - stillBox.y,
                width: box.width / snap.cell,
                height: box.height / snap.cell,
            };
            const smoothArea = {
                x: smoothPlaced.left + (box.x - rawBox.x) * smoothPlaced.scale,
                y: smoothPlaced.top + (box.y - rawBox.y) * smoothPlaced.scale,
                width: box.width * smoothPlaced.scale,
                height: box.height * smoothPlaced.scale,
            };
            items.push({ label, gridArea, smoothArea });
        }
        // A wider look at the grid version alone: the whole face (both sides and between), and each hand with room around it.
        const toGrid = (box) => ({ x: placed.left + (box.x - snap.offsetX) / snap.cell - stillBox.x, y: placed.top + (box.y - snap.offsetY) / snap.cell - stillBox.y, width: box.width / snap.cell, height: box.height / snap.cell });
        for (const face of regions.faces) {
            const left = toGrid(face.left);
            const right = toGrid(face.right);
            wideItems.push({ label: `${layer.id} ${face.name}`, gridArea: pad({ x: left.x, y: Math.min(left.y, right.y), width: right.x + right.width - left.x, height: Math.max(left.height, right.height) }) });
        }
        for (const hand of regions.hands) {
            wideItems.push({ label: `${layer.id} ${hand.name}`, gridArea: pad(toGrid(hand.box)) });
        }
    }
    return buildCompositeSheet({ smooth, grid, items: [...items, ...wideItems], caption: `${name}, cell ${gridLayout.grid.cell.toFixed(4)}` });
}
