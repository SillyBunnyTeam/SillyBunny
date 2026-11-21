import { parseHex } from './github-colour.mjs';
import { createRaster } from './raster.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */

/** The cells of a four-point star: the middle one and an arm of `arm` cells in each direction. */
export function starCells(arm) {
    const cells = [[0, 0]];
    for (let step = 1; step <= arm; step++) {
        cells.push([step, 0], [-step, 0], [0, step], [0, -step]);
    }
    return cells;
}

/** The cells of a crescent: a disc of `diameter` cells from which a disc of the same size, `bite` cells to the right and `lift` up, is cut. */
export function moonCells(diameter, { bite, lift = 0 }) {
    const radius = diameter / 2;
    const inside = (x, y, centreX, centreY) => (x + 0.5 - centreX) ** 2 + (y + 0.5 - centreY) ** 2 <= radius ** 2;
    const cells = [];
    for (let y = 0; y < diameter; y++) {
        for (let x = 0; x < diameter; x++) {
            if (inside(x, y, radius, radius) && !inside(x, y, radius + bite, radius - lift)) {
                cells.push([x, y]);
            }
        }
    }
    return cells;
}

/**
 * Cells drawn as solid squares of `unit` pixels in one colour, on a transparent picture the size of their box.
 * @param {number[][]} cells cell coordinates, which may be negative
 * @param {{ unit: number, colour: string }} style
 * @returns {Raster}
 */
export function drawCells(cells, { unit, colour }) {
    const left = Math.min(...cells.map(([x]) => x));
    const top = Math.min(...cells.map(([, y]) => y));
    const right = Math.max(...cells.map(([x]) => x));
    const bottom = Math.max(...cells.map(([, y]) => y));
    const picture = createRaster((right - left + 1) * unit, (bottom - top + 1) * unit);
    const { r, g, b } = parseHex(colour);
    for (const [cellX, cellY] of cells) {
        for (let dy = 0; dy < unit; dy++) {
            for (let dx = 0; dx < unit; dx++) {
                picture.data.set([r, g, b, 255], (((cellY - top) * unit + dy) * picture.width + (cellX - left) * unit + dx) * 4);
            }
        }
    }
    return picture;
}

/**
 * The stars of a layout: each a four-point star of square cells whose middle cell has its top left corner on the canvas pixel x, y. All stars are drawn into one
 * picture the size of their box, so the layout can place and check it as one thing.
 * @param {{ colour: string, unit: number, points: { x: number, y: number, arm: number }[] }} element
 * @returns {{ picture: Raster, x: number, y: number, boxes: { x: number, y: number, width: number, height: number }[] }} `boxes` holds
 * one box per star, because the stars are far apart and a layout must only keep the logo and the text clear of the stars themselves
 */
export function drawSparkles({ colour, unit, points }) {
    const boxes = points.map(({ x, y, arm }) => ({ left: x - arm * unit, top: y - arm * unit, arm }));
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const right = Math.max(...boxes.map((box) => box.left + (2 * box.arm + 1) * unit));
    const bottom = Math.max(...boxes.map((box) => box.top + (2 * box.arm + 1) * unit));
    const picture = createRaster(right - left, bottom - top);
    const { r, g, b } = parseHex(colour);
    for (const box of boxes) {
        for (const [cellX, cellY] of starCells(box.arm)) {
            for (let dy = 0; dy < unit; dy++) {
                for (let dx = 0; dx < unit; dx++) {
                    const x = box.left - left + (cellX + box.arm) * unit + dx;
                    const y = box.top - top + (cellY + box.arm) * unit + dy;
                    picture.data.set([r, g, b, 255], (y * picture.width + x) * 4);
                }
            }
        }
    }
    const starBoxes = boxes.map((box) => ({ x: box.left, y: box.top, width: (2 * box.arm + 1) * unit, height: (2 * box.arm + 1) * unit }));
    return { picture, x: left, y: top, boxes: starBoxes };
}
