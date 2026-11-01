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

// Both pixels of a pair must be at least this opaque to count as an edge, so the sticker's soft outer edge and what lies under it do not.
const SOLID = 200;
// Candidate offsets are tried this far apart, in source pixels.
const OFFSET_STEP = 0.25;

/**
 * Colour change between neighbouring solid pixels, summed along each column boundary and each row boundary of the box.
 * Index i holds the energy between pixel i and pixel i + 1 (image coordinates), so a grid line at position p is index round(p) - 1.
 */
function solidEdgeProfiles(raster, box) {
    const { width, height, data } = raster;
    const across = new Float64Array(width);
    const down = new Float64Array(height);
    const change = (a, b) => Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]);
    for (let y = box.y; y < box.y + box.height; y++) {
        for (let x = box.x; x < box.x + box.width; x++) {
            const at = (y * width + x) * 4;
            if (data[at + 3] < SOLID) {
                continue;
            }
            if (x + 1 < box.x + box.width && data[at + 7] >= SOLID) {
                across[x] += change(at, at + 4);
            }
            if (y + 1 < box.y + box.height && data[at + width * 4 + 3] >= SOLID) {
                down[y] += change(at, at + width * 4);
            }
        }
    }
    return { across, down };
}

/** The best grid of one axis for one cell size: the offset (0 up to the cell) whose lines carry the most edge energy, and how many times the average. */
function bestAxisOffset(profile, from, to, cell) {
    let total = 0;
    for (let at = from; at < to; at++) {
        total += profile[at];
    }
    const mean = total / (to - from);
    let best = { offset: 0, ratio: 0 };
    for (let offset = 0; offset < cell; offset += OFFSET_STEP) {
        let sum = 0;
        let lines = 0;
        for (let position = offset; position <= to; position += cell) {
            const index = Math.round(position) - 1;
            if (index >= from && index < to) {
                sum += profile[index];
                lines++;
            }
        }
        const ratio = lines === 0 || mean === 0 ? 0 : sum / lines / mean;
        if (ratio > best.ratio) {
            best = { offset, ratio };
        }
    }
    return best;
}

/**
 * The grid of each axis on its own. A picture drawn "on a grid" by a model is rarely exact, so the pitch across and the pitch
 * down can differ, and so can how well each fits. Only edges between solid pixels inside `box` count. `strength` is the
 * edge energy on the grid lines divided by the average edge energy of a position: 1 means no better than chance, and a
 * clean drawn grid scores several times that. The cell is searched in steps fine enough that the grid drifts under a third of a pixel
 * across the box, so a fractional pitch (3.35) is found, and `minCell` equal to `maxCell` only finds the offsets.
 * @param {{ width: number, height: number, data: Uint8Array }} raster RGBA
 * @param {{ x: number, y: number, width: number, height: number }} box the area to analyse
 * @param {{ minCell: number, maxCell: number }} window cell sizes to try, in source pixels
 * @returns {{ across: { cell: number, offset: number, strength: number }, down: { cell: number, offset: number, strength: number } }}
 *   offsets are in image coordinates: grid line k of an axis is at offset + k * cell
 */
export function detectAxes(raster, box, { minCell, maxCell }) {
    if (!(minCell > 1) || maxCell < minCell) {
        throw new Error(`Grid search window is wrong: minCell ${minCell} must be above 1 and not above maxCell ${maxCell}.`);
    }
    if (box.width < 1 || box.height < 1) {
        throw new Error('Grid search box is empty.');
    }
    const profiles = solidEdgeProfiles(raster, box);
    const along = (profile, from, length) => {
        let best;
        for (let cell = minCell; cell <= maxCell; cell += Math.max(0.0005, (0.3 * cell) / length)) {
            const { offset, ratio } = bestAxisOffset(profile, from, from + length, cell);
            if (!best || ratio > best.strength) {
                best = { cell, offset, strength: ratio };
            }
            if (minCell === maxCell) {
                break;
            }
        }
        return best;
    };
    return { across: along(profiles.across, box.x, box.width), down: along(profiles.down, box.y, box.height) };
}
