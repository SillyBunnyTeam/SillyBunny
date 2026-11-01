/**
 * Finds the grid behind an enlarged "pixel art" picture. A model draws blocks of roughly equal size, so colour
 * changes happen mostly on the lines of one regular grid. For every candidate cell size and offset the code
 * measures how much of the picture's edge energy sits on that grid, and keeps the best.
 *
 * The cell may be fractional (a model that resamples its canvas gives 10.24 pixels per cell). A cell and its
 * multiples fit equally well, so the caller must give a search window around the size it expects.
 */

/** Premultiplied colour difference, so the junk colour under a transparent pixel never counts as an edge. */
function difference(data, a, b) {
    const weightA = data[a + 3] / 255;
    const weightB = data[b + 3] / 255;
    return Math.abs(data[a] * weightA - data[b] * weightB)
        + Math.abs(data[a + 1] * weightA - data[b + 1] * weightB)
        + Math.abs(data[a + 2] * weightA - data[b + 2] * weightB)
        + Math.abs(data[a + 3] - data[b + 3]);
}

function smooth(profile) {
    return profile.map((value, index) => 0.25 * (profile[index - 1] ?? value) + 0.5 * value + 0.25 * (profile[index + 1] ?? value));
}

/** Edge energy per column and per row inside the box. Index i holds the energy between i - 1 and i. */
function edgeProfiles(raster, box) {
    const { width, data } = raster;
    const columns = new Float64Array(box.width);
    const rows = new Float64Array(box.height);
    for (let y = box.y; y < box.y + box.height; y++) {
        for (let x = box.x; x < box.x + box.width; x++) {
            const at = (y * width + x) * 4;
            if (x > box.x) {
                columns[x - box.x] += difference(data, at, at - 4);
            }
            if (y > box.y) {
                rows[y - box.y] += difference(data, at, at - width * 4);
            }
        }
    }
    return { columns: smooth(columns), rows: smooth(rows) };
}

/** How many times more edge energy the grid lines carry than an average position, 1 meaning "no better than chance". */
function lineRatio(profile, mean, cell, offset) {
    let sum = 0;
    let count = 0;
    for (let position = offset < 1 ? offset + cell : offset; position < profile.length - 1; position += cell) {
        sum += profile[Math.round(position)];
        count++;
    }
    return count === 0 ? 0 : sum / count / mean;
}

const PLATEAU = 0.985;

/** Index in the middle of the run of near-best values that contains the best one, so a flat top is not read at its edge. */
function plateauCentre(scores) {
    let top = 0;
    for (const [index, score] of scores.entries()) {
        top = score > scores[top] ? index : top;
    }
    const limit = scores[top] * PLATEAU;
    let first = top;
    let last = top;
    while (first > 0 && scores[first - 1] >= limit) {
        first--;
    }
    while (last < scores.length - 1 && scores[last + 1] >= limit) {
        last++;
    }
    return Math.round((first + last) / 2);
}

function bestOffset(profile, mean, cell) {
    const offsets = [];
    for (let offset = 0; offset < cell; offset += 0.25) {
        offsets.push(offset);
    }
    const ratios = offsets.map((offset) => lineRatio(profile, mean, cell, offset));
    const at = plateauCentre(ratios);
    return { offset: offsets[at], ratio: ratios[at] };
}

const meanOf = (profile) => profile.reduce((sum, value) => sum + value, 0) / Math.max(1, profile.length - 1);

/**
 * @param {{ width: number, height: number, data: Uint8Array }} raster RGBA
 * @param {{ x: number, y: number, width: number, height: number }} box the area to analyse
 * @param {{ minCell: number, maxCell: number }} window cell sizes to try, in source pixels
 * @returns {{ cell: number, offsetX: number, offsetY: number, strength: number }}
 *   offsets are relative to the box origin; strength runs from 0 (no grid) to 1 (every edge on the grid)
 */
export function detectGrid(raster, box, { minCell, maxCell }) {
    if (!(minCell > 1) || maxCell < minCell) {
        throw new Error(`Grid search window is wrong: minCell ${minCell} must be above 1 and not above maxCell ${maxCell}.`);
    }
    if (box.width < 1 || box.height < 1) {
        throw new Error('Grid search box is empty.');
    }
    const { columns, rows } = edgeProfiles(raster, box);
    const columnMean = meanOf(columns);
    const rowMean = meanOf(rows);
    if (columnMean === 0 && rowMean === 0) {
        return { cell: minCell, offsetX: 0, offsetY: 0, strength: 0 };
    }

    const extent = Math.max(box.width, box.height);
    const candidates = [];
    // The step keeps the drift across the whole picture under about a third of a pixel.
    for (let cell = minCell; cell <= maxCell; cell += Math.max(0.0005, (0.35 * cell) / extent)) {
        const x = columnMean > 0 ? bestOffset(columns, columnMean, cell) : { offset: 0, ratio: 1 };
        const y = rowMean > 0 ? bestOffset(rows, rowMean, cell) : { offset: 0, ratio: 1 };
        candidates.push({ cell, offsetX: x.offset, offsetY: y.offset, strength: Math.max(0, ((x.ratio + y.ratio) / 2 - 1) / (cell - 1)) });
    }
    const best = candidates[plateauCentre(candidates.map((candidate) => candidate.strength))];
    return { ...best, strength: Math.min(1, best.strength) };
}
