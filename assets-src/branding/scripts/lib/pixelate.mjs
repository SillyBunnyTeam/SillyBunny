import { detectGrid } from './pixel-grid.mjs';
import { formatHex, paletteIndexFinder } from './pixel-colour.mjs';
import { createRaster, opaqueBox } from './raster.mjs';

const SAMPLES = ['mode', 'centre'];
const WEAK_STRENGTH = 0.2;
// A source within this much of the grid's own size is already native; one cell per pixel.
const NATIVE_CELL = 1.5;
const SEARCH_RANGE = 0.12;
const SHAPE_TOLERANCE = 0.05;
// Share of each cell, from its middle, that votes. The rim is skipped because it holds the blur from neighbouring cells.
const INNER_SHARE = 0.6;
const MAX_FIX_PASSES = 10;

const sameColour = (data, a, b) => data[a] === data[b] && data[a + 1] === data[b + 1] && data[a + 2] === data[b + 2];

/**
 * Reads one cell of the source into a palette index, or -1 for transparent. `mode` lets every pixel of the cell's
 * middle vote for its nearest palette colour; `centre` takes the one pixel at the cell's centre. Neither averages colours,
 * so no colour that is not in the palette can appear.
 */
function sampleCell(raster, findIndex, { x0, y0, cell, sample, alphaThreshold }) {
    const { width, height, data } = raster;
    const read = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) {
            return -1;
        }
        const at = (y * width + x) * 4;
        return data[at + 3] < alphaThreshold ? -1 : findIndex(data[at], data[at + 1], data[at + 2]);
    };
    if (sample === 'centre') {
        return read(Math.floor(x0 + cell / 2), Math.floor(y0 + cell / 2));
    }
    const margin = cell >= 3 ? (cell * (1 - INNER_SHARE)) / 2 : 0;
    const left = Math.ceil(x0 + margin);
    const top = Math.ceil(y0 + margin);
    const right = Math.max(left + 1, Math.floor(x0 + cell - margin));
    const bottom = Math.max(top + 1, Math.floor(y0 + cell - margin));
    const votes = new Map();
    let total = 0;
    for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
            const index = read(x, y);
            votes.set(index, (votes.get(index) ?? 0) + 1);
            total++;
        }
    }
    const clear = votes.get(-1) ?? 0;
    if (clear * 2 >= total) {
        return -1;
    }
    let best = -1;
    let bestVotes = 0;
    for (const [index, count] of votes) {
        if (index >= 0 && (count > bestVotes || (count === bestVotes && index < best))) {
            best = index;
            bestVotes = count;
        }
    }
    return best;
}

/**
 * Orphans: an opaque pixel with no neighbour of its colour among its 8 neighbours, and a transparent pixel with all 8
 * neighbours opaque. Real details can look like orphans (a one-pixel eye highlight), which is why they are reported and not removed.
 * @returns {Array<{ x: number, y: number, kind: 'pixel' | 'hole', colour: string, suggest: string }>}
 */
export function findOrphans(raster) {
    const { width, height, data } = raster;
    const orphans = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;
            const opaque = data[at + 3] > 0;
            const neighbours = [];
            let outside = false;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (dx === 0 && dy === 0) {
                        continue;
                    }
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                        outside = true;
                        continue;
                    }
                    neighbours.push((ny * width + nx) * 4);
                }
            }
            const opaqueNeighbours = neighbours.filter((n) => data[n + 3] > 0);
            const isLone = opaque && !opaqueNeighbours.some((n) => sameColour(data, n, at));
            const isHole = !opaque && !outside && opaqueNeighbours.length === 8;
            if (!isLone && !isHole) {
                continue;
            }
            const tally = new Map();
            for (const n of opaqueNeighbours) {
                const key = formatHex([data[n], data[n + 1], data[n + 2]]);
                tally.set(key, (tally.get(key) ?? 0) + 1);
            }
            const [common] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
            orphans.push({
                x,
                y,
                kind: isHole ? 'hole' : 'pixel',
                colour: isHole ? 'transparent' : formatHex([data[at], data[at + 1], data[at + 2]]),
                suggest: common ?? 'transparent',
            });
        }
    }
    return orphans;
}

/** Returns a copy of the raster with each orphan replaced by its suggestion. */
export function applyOrphanFixes(raster, orphans) {
    const fixed = { ...raster, data: Buffer.from(raster.data) };
    for (const { x, y, suggest } of orphans) {
        const at = (y * raster.width + x) * 4;
        if (suggest === 'transparent') {
            fixed.data.fill(0, at, at + 4);
        } else {
            fixed.data.set([...[1, 3, 5].map((start) => Number.parseInt(suggest.slice(start, start + 2), 16)), 255], at);
        }
    }
    return fixed;
}

/** The orphans' suggestions as a pixel-fix patch, so they can be reviewed, edited and applied with pixel-fix.mjs. */
export const orphansToPatch = (orphans) => orphans.map(({ x, y, suggest }) => ({ x, y, color: suggest }));

/**
 * Turns an enlarged "pixel art" picture into real native-resolution pixel art: finds the grid, reads one palette colour
 * per cell, makes alpha binary and reports orphan pixels. The picture is assumed to span the whole native canvas, so the
 * expected cell is the source size divided by the grid size.
 * @param {import('./raster.mjs').Raster} raster
 * @param {{ grid: { width: number, height: number }, palette: number[][], cell?: number, sample?: 'mode' | 'centre',
 *   alphaThreshold?: number, fixOrphans?: boolean }} options
 */
export function pixelateRaster(raster, { grid, palette, cell, sample = 'mode', alphaThreshold = 128, fixOrphans = false }) {
    if (!SAMPLES.includes(sample)) {
        throw new Error(`sample must be one of ${SAMPLES.join(', ')}, got "${sample}".`);
    }
    if (palette.length === 0) {
        throw new Error('The palette has no colours.');
    }
    if (!opaqueBox(raster, alphaThreshold)) {
        throw new Error(`The picture has nothing opaque (alpha ${alphaThreshold} or more). Key the background out first.`);
    }

    const warnings = [];
    const expectedX = raster.width / grid.width;
    const expectedY = raster.height / grid.height;
    let chosen = cell;
    let detected;
    const wholePicture = { x: 0, y: 0, width: raster.width, height: raster.height };
    if (chosen === undefined) {
        if (Math.abs(expectedX - expectedY) / Math.max(expectedX, expectedY) > SHAPE_TOLERANCE) {
            throw new Error(`The ${raster.width}x${raster.height} picture does not have the shape of a ${grid.width}x${grid.height} grid (cells would be ${expectedX.toFixed(2)} by ${expectedY.toFixed(2)} pixels). Crop or pad it first, or pass a cell size.`);
        }
        const expected = (expectedX + expectedY) / 2;
        if (expected < NATIVE_CELL) {
            chosen = 1;
            warnings.push(`The picture is already close to the native size (${expected.toFixed(2)} pixels per grid cell), so it was read one cell per pixel.`);
        } else {
            detected = detectGrid(raster, wholePicture, { minCell: expected * (1 - SEARCH_RANGE), maxCell: expected * (1 + SEARCH_RANGE) });
            chosen = detected.cell;
        }
    } else if (chosen > 1) {
        // A given cell size still needs the offset, which is the part a person cannot read off a picture.
        detected = detectGrid(raster, wholePicture, { minCell: chosen, maxCell: chosen });
    }
    if (detected && detected.strength < WEAK_STRENGTH) {
        warnings.push(`The grid is weak (strength ${detected.strength.toFixed(2)}): few colour changes fall on one grid. Check the 4x contact sheet, or pass a cell size.`);
    }

    const findIndex = paletteIndexFinder(palette);
    const originX = detected?.offsetX ?? 0;
    const originY = detected?.offsetY ?? 0;
    let native = createRaster(grid.width, grid.height);
    for (let cy = 0; cy < grid.height; cy++) {
        for (let cx = 0; cx < grid.width; cx++) {
            const index = sampleCell(raster, findIndex, { x0: originX + cx * chosen, y0: originY + cy * chosen, cell: chosen, sample, alphaThreshold });
            if (index >= 0) {
                native.data.set([...palette[index], 255], (cy * grid.width + cx) * 4);
            }
        }
    }

    const orphans = findOrphans(native);
    let fixPasses = 0;
    if (fixOrphans) {
        // Replacing a pixel can leave a neighbour without a partner, so repeat until none are left, within a limit.
        for (let found = orphans; found.length > 0 && fixPasses < MAX_FIX_PASSES; found = findOrphans(native)) {
            native = applyOrphanFixes(native, found);
            fixPasses++;
        }
    }
    const orphansRemaining = fixOrphans ? findOrphans(native).length : orphans.length;
    if (fixOrphans && orphansRemaining > 0) {
        warnings.push(`${orphansRemaining} orphan pixels remain after ${fixPasses} fix passes. Fix them by hand with pixel-fix.`);
    }
    const sprite = opaqueBox(native);
    if (sprite && (sprite.x === 0 || sprite.y === 0 || sprite.x + sprite.width === grid.width || sprite.y + sprite.height === grid.height)) {
        warnings.push('The sprite touches the canvas edge, so the snap may have cut it. Check the edges.');
    }
    const used = new Set();
    for (let at = 0; at < native.data.length; at += 4) {
        if (native.data[at + 3] === 255) {
            used.add(native.data.readUIntBE(at, 3));
        }
    }
    return {
        raster: native,
        report: {
            source: { width: raster.width, height: raster.height },
            grid,
            cell: chosen,
            cellSource: cell === undefined ? 'detected' : 'manual',
            strength: detected?.strength,
            offset: detected ? { x: detected.offsetX, y: detected.offsetY } : undefined,
            sample,
            alphaThreshold,
            sprite,
            paletteSize: palette.length,
            coloursUsed: used.size,
            orphans,
            orphansFixed: fixOrphans,
            fixPasses,
            orphansRemaining,
            warnings,
        },
    };
}
