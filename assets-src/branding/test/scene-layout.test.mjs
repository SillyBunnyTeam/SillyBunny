import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLayout } from '../scripts/lib/scene-layout.mjs';

const canvas = { width: 2048, height: 1024 };
const layer = (extra = {}) => ({ id: 'a', image: 'a.png', z: 1, anchor: { x: 10, y: 20 }, height: 100, ...extra });

test('a layout parses into canvas and layers with the defaults filled in', () => {
    const parsed = parseLayout({ canvas, layers: [layer()] });
    assert.deepEqual(parsed.canvas, canvas);
    assert.deepEqual(parsed.layers[0], { id: 'a', image: 'a.png', z: 1, at: 'centre', measure: 'box', anchor: { x: 10, y: 20 }, height: 100 });
});

test('a height can be a ratio of another layer, and a layer can repeat at several points', () => {
    const parsed = parseLayout({
        canvas,
        layers: [
            layer({ id: 'a', measure: 'figure' }),
            layer({ id: 'b', measure: 'figure', height: { ratio: 0.8333, of: 'a' } }),
            { id: 'stars', image: 's.png', z: 0, repeat: [{ x: 5, y: 6, height: 30 }, { x: 7, y: 8, height: { ratio: 0.1, of: 'a' } }] },
        ],
    });
    assert.deepEqual(parsed.layers[1].height, { ratio: 0.8333, of: 'a' });
    assert.equal(parsed.layers[2].repeat.length, 2);
    assert.equal(parsed.layers[2].anchor, undefined);
});

test('a bad layout is refused with a message that names the layer and the field', () => {
    const bad = (layout, pattern) => assert.throws(() => parseLayout(layout), pattern);
    bad(null, /needs a canvas/);
    bad({ canvas: { width: 0, height: 10 }, layers: [layer()] }, /needs a canvas/);
    bad({ canvas: { width: 10.5, height: 10 }, layers: [layer()] }, /whole numbers/);
    bad({ canvas, layers: [] }, /at least one layer/);
    bad({ canvas, layers: [layer({ id: '' })] }, /needs an id/);
    bad({ canvas, layers: [layer({ image: undefined })] }, /Layer 1 \("a"\) needs an image path/);
    bad({ canvas, layers: [layer({ z: 'front' })] }, /needs a numeric z/);
    bad({ canvas, layers: [layer({ at: 'middle' })] }, /at "middle"/);
    bad({ canvas, layers: [layer({ measure: 'ears' })] }, /measure "ears"/);
    bad({ canvas, layers: [layer({ anchor: { x: 1 } })] }, /anchor needs a numeric x and y/);
    bad({ canvas, layers: [layer({ height: -4 })] }, /height must be a positive number/);
    bad({ canvas, layers: [layer({ height: { ratio: 1, of: 'zzz' } })] }, /takes its height from "zzz", which is not a layer/);
    bad({ canvas, layers: [layer(), layer()] }, /Two layers are called "a"/);
    bad({ canvas, layers: [{ id: 's', image: 's.png', z: 0, repeat: [] }] }, /repeat must be a list/);
    bad({ canvas, layers: [{ id: 's', image: 's.png', z: 0, repeat: [{ x: 1, y: 2 }] }] }, /repeat 1 height must be/);
});

test('a grade is parsed with its defaults, the colour written the same way every time', () => {
    const parsed = parseLayout({ canvas, layers: [layer({ grade: { toward: '7D8FD6', amount: 0.14 } }), layer({ id: 'b', grade: { toward: '#7d8fd6', amount: 0, lightness: -0.03, keepSticker: false } })] });
    assert.deepEqual(parsed.layers[0].grade, { toward: '#7d8fd6', amount: 0.14, lightness: 0, keepSticker: true });
    assert.deepEqual(parsed.layers[1].grade, { toward: '#7d8fd6', amount: 0, lightness: -0.03, keepSticker: false });
    assert.ok(!('grade' in parseLayout({ canvas, layers: [layer()] }).layers[0]), 'a layer without a grade has none');
});

test('a bad grade is refused with a message that names the layer and the field', () => {
    const bad = (grade, pattern) => assert.throws(() => parseLayout({ canvas, layers: [layer({ grade })] }), pattern);
    bad('blue', /Layer 1 \("a"\) grade must be an object/);
    bad(null, /grade must be an object/);
    bad({ amount: 0.1 }, /grade needs "toward"/);
    bad({ toward: '#7d8f', amount: 0.1 }, /grade toward must be a hex colour such as "#7d8fd6", got "#7d8f"/);
    bad({ toward: 'blue', amount: 0.1 }, /grade toward must be a hex colour/);
    bad({ toward: '#7d8fd6' }, /grade amount must be a number from 0 to 1/);
    bad({ toward: '#7d8fd6', amount: 1.2 }, /grade amount must be a number from 0 to 1, got 1\.2/);
    bad({ toward: '#7d8fd6', amount: -0.1 }, /grade amount must be a number from 0 to 1/);
    bad({ toward: '#7d8fd6', amount: '0.1' }, /grade amount must be a number from 0 to 1/);
    bad({ toward: '#7d8fd6', amount: 0.1, lightness: 2 }, /grade lightness must be a number from -1 to 1/);
    bad({ toward: '#7d8fd6', amount: 0.1, keepSticker: 'yes' }, /grade keepSticker must be true or false/);
    bad({ toward: '#7d8fd6', amount: 0.1, ammount: 0.2 }, /unknown key "ammount"/);
});
