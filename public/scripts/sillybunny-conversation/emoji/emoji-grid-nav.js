/**
 * Where the arrow keys take the focus in the chooser's sections. Pure: a model of how many cells each section has and
 * how many columns the layout gives them, and a function from a position and a key to the next position. The chooser reads
 * the columns from its layout and keeps the DOM in step; a section that is not built yet still has a count, so a move into
 * it is answered, and the chooser builds the section before it puts the focus there.
 *
 * A position is `{ section, index }`. Every section starts a new line, so a line never mixes two sections.
 *
 * @typedef {{ section: number, index: number }} GridPosition
 */

/**
 * @param {number[]} counts The number of cells of each section.
 * @param {number} columns
 */
export function createGridModel(counts, columns) {
    const width = Math.max(1, columns);
    const rowsOf = section => Math.ceil(counts[section] / width);
    const rowOf = position => Math.floor(position.index / width);
    const columnOf = position => position.index % width;
    const rowStart = (section, row) => row * width;
    const rowEnd = (section, row) => Math.min(counts[section], (row + 1) * width) - 1;
    const nonEmpty = section => counts[section] > 0;

    const first = () => {
        const section = counts.findIndex((_count, index) => nonEmpty(index));
        return section === -1 ? null : { section, index: 0 };
    };
    const last = () => {
        const section = counts.findLastIndex((_count, index) => nonEmpty(index));
        return section === -1 ? null : { section, index: counts[section] - 1 };
    };

    /** The cell on a line of a section that is in a column, or the last cell of a line that is shorter. */
    const onLine = (section, row, column) => ({ section, index: Math.min(rowStart(section, row) + column, rowEnd(section, row)) });

    const adjacentSection = (section, step) => {
        for (let next = section + step; next >= 0 && next < counts.length; next += step) {
            if (nonEmpty(next)) {
                return next;
            }
        }
        return -1;
    };

    return {
        counts,
        columns: width,
        rowsOf,
        rowOf,
        columnOf,
        first,
        last,
        right(position) {
            if (position.index + 1 < counts[position.section]) {
                return { section: position.section, index: position.index + 1 };
            }
            const next = adjacentSection(position.section, 1);
            return next === -1 ? null : { section: next, index: 0 };
        },
        left(position) {
            if (position.index > 0) {
                return { section: position.section, index: position.index - 1 };
            }
            const previous = adjacentSection(position.section, -1);
            return previous === -1 ? null : { section: previous, index: counts[previous] - 1 };
        },
        down(position) {
            const row = rowOf(position);
            if (row + 1 < rowsOf(position.section)) {
                return onLine(position.section, row + 1, columnOf(position));
            }
            const next = adjacentSection(position.section, 1);
            return next === -1 ? null : onLine(next, 0, columnOf(position));
        },
        up(position) {
            const row = rowOf(position);
            if (row > 0) {
                return onLine(position.section, row - 1, columnOf(position));
            }
            const previous = adjacentSection(position.section, -1);
            return previous === -1 ? null : onLine(previous, rowsOf(previous) - 1, columnOf(position));
        },
        lineStart: position => ({ section: position.section, index: rowStart(position.section, rowOf(position)) }),
        lineEnd: position => ({ section: position.section, index: rowEnd(position.section, rowOf(position)) }),
        /** The first cell of the next section (`1`), or of this one when the position is past its start and the step is `-1`, or of the previous one. */
        sectionStep(position, step) {
            if (step < 0 && position.index > 0) {
                return { section: position.section, index: 0 };
            }
            const target = adjacentSection(position.section, step);
            return target === -1 ? null : { section: target, index: 0 };
        },
    };
}

/**
 * @param {ReturnType<typeof createGridModel>} model
 * @param {GridPosition} position
 * @param {string} key A `KeyboardEvent.key`.
 * @param {{ ctrl?: boolean, pageRows?: number }} [options]
 * @returns {GridPosition|null} Where the key takes the focus, or null when it does not move it (an edge, or another key).
 */
export function moveInGrid(model, position, key, { ctrl = false, pageRows = 1 } = {}) {
    if (model.first() === null) {
        return null;
    }
    switch (key) {
        case 'ArrowRight': return model.right(position);
        case 'ArrowLeft': return model.left(position);
        case 'ArrowDown': return model.down(position);
        case 'ArrowUp': return model.up(position);
        case 'Home': return ctrl ? model.first() : model.lineStart(position);
        case 'End': return ctrl ? model.last() : model.lineEnd(position);
        case 'PageDown':
        case 'PageUp': {
            const step = key === 'PageDown' ? model.down : model.up;
            let current = position;
            for (let line = 0; line < Math.max(1, pageRows); line++) {
                const next = step(current);
                if (next === null) {
                    break;
                }
                current = next;
            }
            return current;
        }
        default: return null;
    }
}
