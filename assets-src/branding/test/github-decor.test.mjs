import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawCells, drawSparkles, moonCells, starCells } from '../scripts/lib/github-decor.mjs';
import { getPixel } from '../test-support/synthetic.mjs';

test('a star is a middle cell with an arm of cells in each of the four directions', () => {
    assert.equal(starCells(1).length, 5);
    assert.equal(starCells(3).length, 13);
    assert.deepEqual(starCells(2).filter(([x, y]) => x !== 0 && y !== 0), [], 'no cell is off the cross');
});

test('a crescent has the cells of the disc that the bite does not cover, and it opens to the right', () => {
    const cells = moonCells(12, { bite: 4, lift: 1 });
    assert.ok(cells.length > 20 && cells.length < Math.PI * 36);
    const key = (x, y) => cells.some(([cellX, cellY]) => cellX === x && cellY === y);
    assert.equal(key(1, 6), true, 'the left rim is drawn');
    assert.equal(key(9, 5), false, 'the middle of the bite is empty');
    assert.deepEqual(moonCells(12, { bite: 4, lift: 1 }), cells, 'the same numbers give the same cells');
});

test('cells are drawn as solid squares of the unit, in one colour, and nothing else is drawn', () => {
    const picture = drawCells([[0, 0], [2, 1]], { unit: 4, colour: '#e4d2f5' });
    assert.deepEqual([picture.width, picture.height], [12, 8]);
    assert.deepEqual(getPixel(picture, 0, 0), [228, 210, 245, 255]);
    assert.deepEqual(getPixel(picture, 3, 3), [228, 210, 245, 255]);
    assert.equal(getPixel(picture, 4, 0)[3], 0);
    assert.deepEqual(getPixel(picture, 11, 7), [228, 210, 245, 255]);
});

test('stars are drawn into one picture, each with its middle cell on its point, and each keeps its own box', () => {
    const { picture, x, y, boxes } = drawSparkles({ colour: '#b99bf2', unit: 6, points: [{ x: 100, y: 50, arm: 2 }, { x: 400, y: 200, arm: 1 }] });
    assert.deepEqual(boxes, [{ x: 88, y: 38, width: 30, height: 30 }, { x: 394, y: 194, width: 18, height: 18 }]);
    assert.deepEqual([x, y, picture.width, picture.height], [88, 38, 324, 174]);
    assert.deepEqual(getPixel(picture, 100 - x + 1, 50 - y + 1), [185, 155, 242, 255], 'the middle cell');
    assert.deepEqual(getPixel(picture, 400 - x, 200 - y), [185, 155, 242, 255]);
    assert.equal(getPixel(picture, 250 - x, 120 - y)[3], 0, 'the space between two stars is empty');
    assert.equal(getPixel(picture, 88 - x, 38 - y)[3], 0, 'the corner of a star box is empty: it is a cross');
});
