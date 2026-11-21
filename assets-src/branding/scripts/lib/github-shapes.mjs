import { parseHex } from './github-colour.mjs';
import { createRaster } from './raster.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */
/** @typedef {{ x: number, y: number, width: number, height: number }} Box */

/** Paints one square cell of `unit` pixels into a picture. */
function paintCell(picture, cellX, cellY, unit, rgb) {
    for (let dy = 0; dy < unit; dy++) {
        for (let dx = 0; dx < unit; dx++) {
            picture.data.set([...rgb, 255], (((cellY * unit) + dy) * picture.width + cellX * unit + dx) * 4);
        }
    }
}

const rgbOf = (hex) => {
    const { r, g, b } = parseHex(hex);
    return [r, g, b];
};

/**
 * A rectangle of cells, `inset` cells in from the edge of a `widthCells` by `heightCells` panel, with a staircase of `notch` cells cut
 * from every corner (a notch of 1 takes the corner cell only).
 */
function isInStepped(cellX, cellY, { widthCells, heightCells, inset, notch }) {
    const left = cellX - inset;
    const top = cellY - inset;
    const right = widthCells - 1 - inset - cellX;
    const bottom = heightCells - 1 - inset - cellY;
    if (left < 0 || top < 0 || right < 0 || bottom < 0) {
        return false;
    }
    return left + top >= notch && right + top >= notch && left + bottom >= notch && right + bottom >= notch;
}

/**
 * A stepped panel: layers painted one over the next, each a rectangle `inset` cells in with its own corner notch. The outermost layer
 * is the border line, the next one the inner line, and the last one the fill, so every band is whole cells wide.
 * A stud is a square of `cells` cells in a colour at `inset` cells from each corner, drawn over the layers, like the rivets of a plaque.
 * @param {{ widthCells: number, heightCells: number, unit: number, layers: { colour: string, inset: number, notch: number }[], studs?: { colour: string, cells: number, inset: number } }} panel
 * @returns {Raster}
 */
export function steppedPanel({ widthCells, heightCells, unit, layers, studs }) {
    const picture = createRaster(widthCells * unit, heightCells * unit);
    for (const { colour, inset, notch } of layers) {
        const rgb = rgbOf(colour);
        for (let cellY = 0; cellY < heightCells; cellY++) {
            for (let cellX = 0; cellX < widthCells; cellX++) {
                if (isInStepped(cellX, cellY, { widthCells, heightCells, inset, notch })) {
                    paintCell(picture, cellX, cellY, unit, rgb);
                }
            }
        }
    }
    if (studs) {
        const rgb = rgbOf(studs.colour);
        const last = (size) => size - studs.inset - studs.cells;
        for (const cellX of [studs.inset, last(widthCells)]) {
            for (const cellY of [studs.inset, last(heightCells)]) {
                for (let dy = 0; dy < studs.cells; dy++) {
                    for (let dx = 0; dx < studs.cells; dx++) {
                        paintCell(picture, cellX + dx, cellY + dy, unit, rgb);
                    }
                }
            }
        }
    }
    return picture;
}

/**
 * A pixel icon: a grid of symbols (`.` is empty) drawn with `unit` pixels per icon pixel, each symbol in its own colour.
 * @param {{ rows: string[], colours: Record<string, string>, unit: number }} icon `colours` maps every symbol of the grid to a hex colour
 * @returns {Raster}
 */
export function iconPicture({ rows, colours, unit }) {
    const picture = createRaster(rows[0].length * unit, rows.length * unit);
    rows.forEach((row, cellY) => {
        [...row].forEach((symbol, cellX) => {
            if (symbol !== '.') {
                paintCell(picture, cellX, cellY, unit, rgbOf(colours[symbol]));
            }
        });
    });
    return picture;
}

/** The ring a cell is in, counted from the nearest edge of a `widthCells` by `heightCells` rectangle: 0 on the outermost line of cells. */
const ringOf = (cellX, cellY, widthCells, heightCells) => Math.min(cellX, cellY, widthCells - 1 - cellX, heightCells - 1 - cellY);

/** The colour of a ring of a stack of layers (`cells` thick each, outermost first), or undefined past the last one. */
function layerAt(layers, ring) {
    let reached = 0;
    for (const layer of layers) {
        reached += layer.cells;
        if (ring < reached) {
            return layer.colour;
        }
    }
    return undefined;
}

/**
 * A frame round the whole canvas: bands of layers (outermost first, `cells` blocks thick each) on all four edges, and a square boss on
 * each corner. A boss has the same layers as the band, a stepped corner of `notch` blocks cut off its outer corner and shown as the
 * `outside` colour, and an ornament drawn in the space the layers leave. The inside of the frame is left transparent.
 * @param {{ widthCells: number, heightCells: number, unit: number, layers: { colour: string, cells: number }[], boss: { cells: number, notch: number, outside: string, ornaments: { rows: string[], colours: Record<string, string> }[] } }} frame
 * `ornaments` are for the top left, top right, bottom left and bottom right corner, in that order; the colours are hex
 * @returns {{ picture: Raster, boxes: Box[] }} `boxes` are the four bands and the four bosses, so a layout can keep everything else clear of them
 */
export function framePicture({ widthCells, heightCells, unit, layers, boss }) {
    const picture = createRaster(widthCells * unit, heightCells * unit);
    const thickness = layers.reduce((sum, layer) => sum + layer.cells, 0);
    const innerSize = boss.cells - 2 * thickness;
    if (innerSize < 1) {
        throw new Error(`A frame boss of ${boss.cells} blocks has no room inside layers that are ${thickness} blocks thick on each side.`);
    }
    const fill = rgbOf(layers.at(-1).colour);
    const rgbLayers = layers.map((layer) => ({ ...layer, colour: rgbOf(layer.colour) }));
    for (let cellY = 0; cellY < heightCells; cellY++) {
        for (let cellX = 0; cellX < widthCells; cellX++) {
            const colour = layerAt(rgbLayers, ringOf(cellX, cellY, widthCells, heightCells));
            if (colour) {
                paintCell(picture, cellX, cellY, unit, colour);
            }
        }
    }
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
    const boxes = [
        { x: 0, y: 0, width: picture.width, height: thickness * unit },
        { x: 0, y: (heightCells - thickness) * unit, width: picture.width, height: thickness * unit },
        { x: 0, y: thickness * unit, width: thickness * unit, height: picture.height - 2 * thickness * unit },
        { x: picture.width - thickness * unit, y: thickness * unit, width: thickness * unit, height: picture.height - 2 * thickness * unit },
    ];
    corners.forEach(([right, bottom], at) => {
        const originX = right ? widthCells - boss.cells : 0;
        const originY = bottom ? heightCells - boss.cells : 0;
        for (let localY = 0; localY < boss.cells; localY++) {
            for (let localX = 0; localX < boss.cells; localX++) {
                // The corner is worked out as if it were the top left one, then mapped to the corner it is on.
                const fromCornerX = right ? boss.cells - 1 - localX : localX;
                const fromCornerY = bottom ? boss.cells - 1 - localY : localY;
                const colour = fromCornerX + fromCornerY < boss.notch ? rgbOf(boss.outside) : layerAt(rgbLayers, ringOf(localX, localY, boss.cells, boss.cells)) ?? fill;
                paintCell(picture, originX + localX, originY + localY, unit, colour);
            }
        }
        const { rows, colours } = boss.ornaments[at];
        rows.forEach((row, rowAt) => [...row].forEach((symbol, columnAt) => {
            if (symbol !== '.') {
                paintCell(picture, originX + thickness + columnAt, originY + thickness + rowAt, unit, rgbOf(colours[symbol]));
            }
        }));
        boxes.push({ x: originX * unit, y: originY * unit, width: boss.cells * unit, height: boss.cells * unit });
    });
    return { picture, boxes };
}
