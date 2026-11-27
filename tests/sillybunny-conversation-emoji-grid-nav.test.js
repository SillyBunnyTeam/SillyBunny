import { describe, expect, test } from '@jest/globals';

const { createGridModel, moveInGrid } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-grid-nav.js');

// Three sections of 10, 3 and 8 cells, 4 columns: rows of 4,4,2 / 3 / 4,4.
const model = createGridModel([10, 3, 8], 4);
const at = (section, index) => ({ section, index });
const go = (position, key, options) => moveInGrid(model, position, key, options);

describe('the grid model', () => {
    test('knows the rows and the columns of each section', () => {
        expect(model.rowsOf(0)).toBe(3);
        expect(model.rowsOf(1)).toBe(1);
        expect(model.columnOf(at(0, 9))).toBe(1);
        expect(model.rowOf(at(0, 9))).toBe(2);
    });

    test('has no cell at all when every section is empty', () => {
        expect(moveInGrid(createGridModel([0, 0], 4), at(0, 0), 'ArrowRight')).toBeNull();
        expect(createGridModel([0, 3, 0], 4).first()).toEqual(at(1, 0));
        expect(createGridModel([0, 3, 0], 4).last()).toEqual(at(1, 2));
    });
});

describe('arrows', () => {
    test('Left and Right move one cell and continue into the next and the previous section', () => {
        expect(go(at(0, 3), 'ArrowRight')).toEqual(at(0, 4));
        expect(go(at(0, 9), 'ArrowRight')).toEqual(at(1, 0));
        expect(go(at(1, 0), 'ArrowLeft')).toEqual(at(0, 9));
        expect(go(at(2, 7), 'ArrowRight')).toBeNull();
        expect(go(at(0, 0), 'ArrowLeft')).toBeNull();
    });

    test('Down and Up move one line, keeping the column, and stop at the last cell of a short line', () => {
        expect(go(at(0, 1), 'ArrowDown')).toEqual(at(0, 5));
        expect(go(at(0, 5), 'ArrowDown')).toEqual(at(0, 9));
        expect(go(at(0, 3), 'ArrowDown')).toEqual(at(0, 7));
        expect(go(at(0, 7), 'ArrowDown')).toEqual(at(0, 9));
        expect(go(at(0, 9), 'ArrowUp')).toEqual(at(0, 5));
        expect(go(at(0, 5), 'ArrowUp')).toEqual(at(0, 1));
    });

    test('Down from the last line goes to the first line of the next section, and Up to its last line', () => {
        expect(go(at(0, 9), 'ArrowDown')).toEqual(at(1, 1));
        expect(go(at(0, 8), 'ArrowDown')).toEqual(at(1, 0));
        expect(go(at(1, 2), 'ArrowDown')).toEqual(at(2, 2));
        expect(go(at(2, 2), 'ArrowUp')).toEqual(at(1, 2));
        expect(go(at(2, 0), 'ArrowUp')).toEqual(at(1, 0));
        expect(go(at(1, 1), 'ArrowUp')).toEqual(at(0, 9));
        expect(go(at(0, 2), 'ArrowUp')).toBeNull();
        expect(go(at(2, 6), 'ArrowDown')).toBeNull();
    });
});

describe('the other keys', () => {
    test('Home and End go to the ends of the line', () => {
        expect(go(at(0, 6), 'Home')).toEqual(at(0, 4));
        expect(go(at(0, 5), 'End')).toEqual(at(0, 7));
        expect(go(at(0, 9), 'Home')).toEqual(at(0, 8));
        expect(go(at(0, 8), 'End')).toEqual(at(0, 9));
    });

    test('Ctrl+Home and Ctrl+End go to the first and the last cell of everything', () => {
        expect(go(at(1, 1), 'Home', { ctrl: true })).toEqual(at(0, 0));
        expect(go(at(1, 1), 'End', { ctrl: true })).toEqual(at(2, 7));
    });

    test('Page Down and Page Up move by a number of lines, across sections, and stop where the cells end', () => {
        expect(go(at(0, 1), 'PageDown', { pageRows: 2 })).toEqual(at(0, 9));
        expect(go(at(0, 1), 'PageDown', { pageRows: 3 })).toEqual(at(1, 1));
        expect(go(at(2, 5), 'PageDown', { pageRows: 5 })).toEqual(at(2, 5));
        expect(go(at(2, 5), 'PageUp', { pageRows: 2 })).toEqual(at(1, 1));
        expect(go(at(0, 5), 'PageUp', { pageRows: 5 })).toEqual(at(0, 1));
    });

    test('answers null for a key that it does not move with', () => {
        expect(go(at(0, 0), 'a')).toBeNull();
        expect(go(at(0, 0), 'Enter')).toBeNull();
    });
});

describe('sections', () => {
    test('jump to the first cell of the next or the previous non-empty section', () => {
        expect(model.sectionStep(at(0, 5), 1)).toEqual(at(1, 0));
        expect(model.sectionStep(at(1, 2), 1)).toEqual(at(2, 0));
        expect(model.sectionStep(at(2, 3), -1)).toEqual(at(2, 0));
        expect(model.sectionStep(at(1, 0), -1)).toEqual(at(0, 0));
        expect(model.sectionStep(at(2, 0), 1)).toBeNull();
        expect(model.sectionStep(at(0, 0), -1)).toBeNull();
    });

    test('skip an empty section', () => {
        const sparse = createGridModel([4, 0, 4], 4);
        expect(sparse.sectionStep(at(0, 0), 1)).toEqual(at(2, 0));
        expect(sparse.sectionStep(at(2, 0), -1)).toEqual(at(0, 0));
    });
});
