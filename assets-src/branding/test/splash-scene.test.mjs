import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unionBox } from '../scripts/lib/raster.mjs';
import { drawLayers, layOutPair, layerOf } from '../scripts/lib/splash-scene.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const block = (width, height, box, colour) => {
    const raster = createRaster(width, height);
    for (let y = box.y; y < box.y + box.height; y++) {
        for (let x = box.x; x < box.x + box.width; x++) {
            setPixel(raster, x, y, colour);
        }
    }
    return raster;
};

test('a layer is cut to the box that holds the figure in every pose, so one placement serves them all', () => {
    const layer = layerOf(new Map([['a', block(40, 50, { x: 10, y: 5, width: 8, height: 20 }, [255, 0, 0])], ['b', block(40, 50, { x: 14, y: 8, width: 20, height: 30 }, [0, 255, 0])]]));
    assert.deepEqual(layer.box, { x: 10, y: 5, width: 24, height: 33 });
    assert.deepEqual([layer.width, layer.height], [24, 33]);
    assert.deepEqual(getPixel(layer.frames.get('a'), 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(getPixel(layer.frames.get('b'), 4, 3), [0, 255, 0, 255]);
    assert.equal(layer.silhouette[0], 1);
    assert.equal(layer.silhouette[32 * 24 + 23], 1, 'the silhouette is every pose together');
    assert.throws(() => layerOf(new Map([['x', createRaster(5, 5)]])), /pose "x" is empty/);
    assert.deepEqual(unionBox([{ x: 1, y: 2, width: 3, height: 4 }, { x: 0, y: 0, width: 2, height: 2 }]), { x: 0, y: 0, width: 4, height: 6 });
});

test('two characters stand on one row, the right one as near as it can be without a pixel closer than the gap in any pose, and the canvas is the boxes and a margin', () => {
    const tall = layerOf(new Map([['idle', block(30, 60, { x: 0, y: 0, width: 20, height: 60 }, [255, 0, 0])], ['call', block(30, 60, { x: 0, y: 0, width: 28, height: 10 }, [255, 0, 0])]]));
    const short = layerOf(new Map([['raised', block(30, 40, { x: 0, y: 0, width: 10, height: 40 }, [0, 0, 255])], ['strike', block(30, 40, { x: 0, y: 30, width: 30, height: 10 }, [0, 0, 255])]]));
    const laid = layOutPair({ left: { id: 'left', ...tall }, right: { id: 'right', ...short }, gap: 3, margin: 5 });
    const [one, two] = laid.layers;
    assert.deepEqual([one.id, one.z, two.id, two.z], ['left', 1, 'right', 2]);
    assert.equal(one.top + one.height, two.top + two.height, 'their last rows are the same row');
    assert.equal(two.left - one.left, 23, 'the right one\'s strike pose (30 wide, on the feet row) must clear the left one\'s 20 wide body and 3 pixels of gap');
    assert.deepEqual([laid.width, laid.height], [two.left + two.width + 5, 60 + 10]);
    const wide = layOutPair({ left: { id: 'left', ...tall }, right: { id: 'right', ...short }, gap: 10, margin: 5 });
    assert.equal(wide.layers[1].left - wide.layers[0].left, 30, 'a larger gap pushes it further out');
    const near = layOutPair({ left: { id: 'left', ...tall }, right: { id: 'right', ...short }, gap: 0, margin: 0 });
    assert.equal(near.layers[0].left, 0);
    assert.equal(near.layers[1].left, 20, 'with no gap it stands right against the body');
});

test('a right character that is the taller of the two moves everything down so no layer starts above the canvas', () => {
    const small = layerOf(new Map([['a', block(20, 20, { x: 0, y: 0, width: 20, height: 20 }, [255, 0, 0])]]));
    const big = layerOf(new Map([['a', block(20, 50, { x: 0, y: 0, width: 20, height: 50 }, [0, 0, 255])]]));
    const laid = layOutPair({ left: { id: 'l', ...small }, right: { id: 'r', ...big }, gap: 0, margin: 2 });
    assert.deepEqual(laid.layers.map(({ top }) => top), [32, 2]);
    assert.equal(laid.height, 54);
});

test('the scene is drawn in z order with the pose each layer is asked for, and a pose a layer lacks is refused', () => {
    const left = layerOf(new Map([['idle', block(10, 10, { x: 0, y: 0, width: 10, height: 10 }, [255, 0, 0])]]));
    const right = layerOf(new Map([['raised', block(10, 10, { x: 0, y: 0, width: 10, height: 10 }, [0, 0, 255])]]));
    const layers = [{ id: 'l', z: 1, left: 0, top: 0, ...left }, { id: 'r', z: 2, left: 5, top: 0, ...right }];
    const drawn = drawLayers({ width: 20, height: 10, layers, poseOf: (id) => (id === 'l' ? 'idle' : 'raised') });
    assert.deepEqual(getPixel(drawn, 2, 2), [255, 0, 0, 255]);
    assert.deepEqual(getPixel(drawn, 7, 2), [0, 0, 255, 255], 'the one with the higher z is in front');
    assert.throws(() => drawLayers({ width: 20, height: 10, layers, poseOf: () => 'call' }), /has no pose "call"/);
});
