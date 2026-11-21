import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crop } from '../lib/raster.js';
import { distanceToMask, measureRings, rebuildRings, STICKER } from '../lib/rings.js';
import { paint, pixelAt } from '../test-support/pictures.js';

const CLEAR = [0, 0, 0, 0];
const ART = [200, 120, 220, 255];
const RIM = [...STICKER.rim, 255];
const BAND = [...STICKER.band, 255];

const disc = (size, centre, radius) => paint(size, size, (x, y) => ((x - centre) ** 2 + (y - centre) ** 2 <= radius ** 2 ? ART : CLEAR));

test('the distance to a mask is the straight-line distance to its nearest pixel', () => {
    const [width, height] = [13, 9];
    const mask = Uint8Array.from({ length: width * height }, (_, at) => ((at * 7919) % 11 === 0 ? 1 : 0));

    const distance = distanceToMask(mask, width, height);

    for (let at = 0; at < mask.length; at++) {
        let nearest = Infinity;
        for (let other = 0; other < mask.length; other++) {
            if (mask[other] === 1) {
                nearest = Math.min(nearest, Math.hypot((at % width) - (other % width), Math.floor(at / width) - Math.floor(other / width)));
            }
        }
        assert.ok(Math.abs(distance[at] - nearest) < 1e-9, `pixel ${at}`);
    }
});

test('the rings are painted from the silhouette in and measure at their widths', () => {
    const { raster, changed } = rebuildRings(disc(24, 12, 9), { rim: 2, band: 2 });

    assert.deepEqual(measureRings(raster), { rim: 2, band: 2 });
    assert.ok(changed > 0);
    assert.deepEqual([pixelAt(raster, 12, 3), pixelAt(raster, 12, 6), pixelAt(raster, 12, 12)], [RIM, BAND, ART]);
    assert.deepEqual(rebuildRings(raster, { rim: 2, band: 2 }).changed, 0);
});

test('a gap in a ring measures as a smaller width', () => {
    const { raster } = rebuildRings(disc(24, 12, 9), { rim: 2, band: 2 });
    raster.data.set(ART, (3 * 24 + 12) * 4);

    assert.deepEqual(measureRings(raster), { rim: 0, band: 0 });
});

test('a figure cut by the canvas border gets no ring along the cut', () => {
    const cut = paint(20, 10, (x, y) => (x >= 3 && x < 17 && y >= 3 ? ART : CLEAR));

    const { raster } = rebuildRings(cut, { rim: 2, band: 2 });

    assert.deepEqual([pixelAt(raster, 10, 9), pixelAt(raster, 10, 3), pixelAt(raster, 3, 9)], [ART, RIM, RIM]);
});

test('a rim that ends flush with the canvas border keeps its colour and measures at its width', () => {
    const drawn = rebuildRings(paint(24, 20, (x, y) => (x >= 4 && x < 20 && y >= 4 && y < 16 ? ART : CLEAR)), { rim: 2, band: 2 }).raster;
    const flush = crop(drawn, { x: 0, y: 0, width: 24, height: 16 });
    assert.deepEqual([pixelAt(flush, 12, 15), pixelAt(flush, 12, 14), pixelAt(flush, 12, 13)], [RIM, RIM, BAND], 'the rim runs along the last row');

    assert.deepEqual(measureRings(flush), { rim: 2, band: 2 });
    assert.equal(rebuildRings(flush, { rim: 2, band: 2 }).changed, 0);
});
