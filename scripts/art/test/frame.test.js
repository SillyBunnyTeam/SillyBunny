import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameBox, renderFrame } from '../lib/frame.js';
import { paint, pixelAt } from '../test-support/pictures.js';

const SKIN = [240, 200, 180, 255];

test('a subject frame is the subject box with the margin on every side, and may reach past the canvas', () => {
    const picture = paint(8, 6, (x, y) => (x >= 3 && x <= 5 && y <= 2 ? SKIN : [0, 0, 0, 0]));

    assert.deepEqual(frameBox(picture, { mode: 'subject', margin: 2 }), { x: 1, y: -2, width: 7, height: 7 });
    assert.deepEqual(frameBox(picture, { mode: 'canvas' }), { x: 0, y: 0, width: 8, height: 6 });
});

test('a faint speck does not widen the subject box', () => {
    const picture = paint(6, 6, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 15] : x === 3 && y === 3 ? SKIN : [0, 0, 0, 0]));

    assert.deepEqual(frameBox(picture, { mode: 'subject', margin: 0 }), { x: 3, y: 3, width: 1, height: 1 });
});

test('a picture with nothing visible cannot be framed by its subject', () => {
    assert.throws(() => frameBox(paint(2, 2, () => [0, 0, 0, 0]), { mode: 'subject', margin: 2 }), /no visible subject/);
});

test('a rendered frame is transparent past the canvas and zero under every transparent pixel', () => {
    const picture = paint(3, 3, (x, y) => (x === 1 && y === 1 ? SKIN : [77, 77, 77, 0]));

    const framed = renderFrame(picture, { x: -1, y: 0, width: 4, height: 3 });

    assert.deepEqual([framed.width, framed.height], [4, 3]);
    assert.deepEqual(pixelAt(framed, 2, 1), SKIN);
    assert.deepEqual(pixelAt(framed, 0, 0), [0, 0, 0, 0]);
    assert.deepEqual(pixelAt(framed, 1, 0), [0, 0, 0, 0]);
});
