import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRectInside, eraseWithRings } from '../scripts/lib/github-repair.mjs';
import { measureRings } from '../scripts/lib/pixel-snap.mjs';
import { createRaster, getPixel } from '../test-support/synthetic.mjs';

const RIM = [185, 155, 242];
const BAND = [255, 255, 255];
const BODY = [90, 80, 100];
const PRONG = [150, 140, 170];
const RINGS = { rimWidth: 2, bandWidth: 2, rim: RIM, band: BAND };
const DEPTH = RINGS.rimWidth + RINGS.bandWidth;

/** A snapped sticker round the given filled boxes, with its rim and band drawn as the snap draws them: by how deep a pixel is. */
function stickerOf(width, height, parts) {
    const inside = (x, y) => parts.some(({ box }) => x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height);
    const raster = createRaster(width, height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let nearest = Infinity;
            for (const part of parts) {
                const dx = Math.max(part.box.x - x, x - (part.box.x + part.box.width - 1), 0);
                const dy = Math.max(part.box.y - y, y - (part.box.y + part.box.height - 1), 0);
                nearest = Math.min(nearest, Math.hypot(dx, dy));
            }
            if (nearest > DEPTH) {
                continue;
            }
            const part = parts.find(({ box }) => inside(x, y) && x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height);
            const colour = part ? part.colour : nearest <= RINGS.bandWidth ? BAND : RIM;
            raster.data.set([...colour, 255], (y * width + x) * 4);
        }
    }
    return raster;
}

const BODY_BOX = { x: 20, y: 10, width: 14, height: 14 };
const PRONGS = [{ x: 24, y: 24, width: 2, height: 6 }, { x: 28, y: 24, width: 2, height: 6 }];
const ERASE = { x: 12, y: 24, width: 30, height: 15 };

const withProngs = () => stickerOf(60, 50, [{ box: BODY_BOX, colour: BODY }, ...PRONGS.map((box) => ({ box, colour: PRONG }))]);
const pixelsOf = (raster, test) => {
    const found = [];
    for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
            if (test(getPixel(raster, x, y), x, y)) {
                found.push([x, y]);
            }
        }
    }
    return found;
};

test('erasing the prongs of a plug takes their rings with them and draws the rings whole along the body', () => {
    const before = withProngs();
    assert.equal(pixelsOf(before, ([r, g, b]) => [r, g, b].join() === PRONG.join()).length, 24, 'the prongs are there to start with');
    const { raster, erased, grown } = eraseWithRings(before, [ERASE], RINGS);

    assert.deepEqual(pixelsOf(raster, ([r, g, b, a]) => a === 255 && [r, g, b].join() === PRONG.join()), [], 'no prong is left');
    assert.ok(erased > 24 && grown > 0);
    const bottom = BODY_BOX.y + BODY_BOX.height;
    const middle = BODY_BOX.x + 7;
    for (let down = 0; down < 4; down++) {
        const [r, g, b, a] = getPixel(raster, middle, bottom + down);
        assert.equal(a, 255, `ring pixel ${down} below the body`);
        assert.deepEqual([r, g, b], down < RINGS.bandWidth ? BAND : RIM);
    }
    assert.equal(getPixel(raster, middle, bottom + DEPTH)[3], 0, 'and nothing past the rim');
    const measured = measureRings(raster, { rim: RIM, band: BAND });
    assert.deepEqual([measured.rimWidth, measured.bandWidth], [2, 2], 'the rings measure as wide as every other ring');
});

// Three more parts stand round the box, each with its figure on the row or column next to it (above it is the last row of the body). Figure
// cannot be grown back the way a ring can, so a box that is one pixel wider shows in the picture.
const NEIGHBOURS = [{ x: 7, y: 26, width: 5, height: 6 }, { x: 42, y: 26, width: 5, height: 6 }, { x: 18, y: 39, width: 8, height: 3 }];
const withNeighbours = () => stickerOf(60, 50, [{ box: BODY_BOX, colour: BODY }, ...PRONGS.map((box) => ({ box, colour: PRONG })), ...NEIGHBOURS.map((box) => ({ box, colour: BODY }))]);

const insideBox = (box, x, y) => x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
const changedOutside = (before, after, box) => pixelsOf(after, (pixel, x, y) => !insideBox(box, x, y) && pixel.join() !== getPixel(before, x, y).join()).length;

test('nothing outside the repaired box changes, with drawn pixels touching the box on all four sides', () => {
    const before = withNeighbours();
    const strips = {
        above: { x: ERASE.x, y: ERASE.y - 1, width: ERASE.width, height: 1 },
        below: { x: ERASE.x, y: ERASE.y + ERASE.height, width: ERASE.width, height: 1 },
        left: { x: ERASE.x - 1, y: ERASE.y, width: 1, height: ERASE.height },
        right: { x: ERASE.x + ERASE.width, y: ERASE.y, width: 1, height: ERASE.height },
    };
    for (const [side, strip] of Object.entries(strips)) {
        assert.ok(pixelsOf(before, ([, , , alpha], x, y) => alpha === 255 && insideBox(strip, x, y)).length > 0, `a drawn pixel is next to the box on its ${side} side, so a wider box would be seen`);
    }
    const { raster } = eraseWithRings(before, [ERASE], RINGS);
    assert.equal(changedOutside(before, raster, ERASE), 0);
    assert.ok(pixelsOf(raster, ([r, g, b, a], x, y) => insideBox(ERASE, x, y) && a === 255 && [r, g, b].join() === PRONG.join()).length === 0, 'and the work inside the box was done');

    for (const [side, wider] of Object.entries({
        above: { ...ERASE, y: ERASE.y - 1, height: ERASE.height + 1 },
        below: { ...ERASE, height: ERASE.height + 1 },
        left: { ...ERASE, x: ERASE.x - 1, width: ERASE.width + 1 },
        right: { ...ERASE, width: ERASE.width + 1 },
    })) {
        assert.ok(changedOutside(before, eraseWithRings(before, [wider], RINGS).raster, ERASE) > 0, `a box one pixel wider on its ${side} side changes the picture outside the box`);
    }
});

test('a corner of the body is rounded by the rings that are grown, and the repair is the same every time', () => {
    const { raster } = eraseWithRings(withProngs(), [ERASE], RINGS);
    const bottom = BODY_BOX.y + BODY_BOX.height;
    assert.equal(getPixel(raster, BODY_BOX.x - 4, bottom + 3)[3], 0, 'the far corner of the ring is cut off, as a rounded edge is');
    assert.equal(getPixel(raster, BODY_BOX.x, bottom)[3], 255);
    const again = eraseWithRings(withProngs(), [ERASE], RINGS).raster;
    assert.equal(Buffer.compare(raster.data, again.data), 0);
});

test('a repair box must be whole pixels inside the picture', () => {
    const picture = withProngs();
    for (const box of [{ x: -1, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 0, height: 5 }, { x: 50, y: 0, width: 20, height: 5 }, { x: 1.5, y: 0, width: 5, height: 5 }]) {
        assert.throws(() => eraseWithRings(picture, [box], RINGS), /whole pixels inside the 60x50 picture/);
    }
    assert.doesNotThrow(() => assertRectInside(picture, { x: 0, y: 0, width: 60, height: 50 }));
});

test('a repair box may touch every edge of the picture and no more: the last pixel is inside, one past it is refused', () => {
    const picture = withProngs();
    assert.deepEqual([picture.width, picture.height], [60, 50]);
    const inside = [
        { x: 59, y: 0, width: 1, height: 1 },
        { x: 0, y: 49, width: 1, height: 1 },
        { x: 59, y: 49, width: 1, height: 1 },
        { x: 55, y: 45, width: 5, height: 5 },
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 0, y: 0, width: 60, height: 1 },
        { x: 0, y: 0, width: 1, height: 50 },
    ];
    for (const box of inside) {
        assert.doesNotThrow(() => assertRectInside(picture, box), JSON.stringify(box));
    }
    const oneTooFar = [
        { x: 60, y: 0, width: 1, height: 1 },
        { x: 0, y: 50, width: 1, height: 1 },
        { x: 56, y: 45, width: 5, height: 5 },
        { x: 55, y: 46, width: 5, height: 5 },
        { x: 0, y: 0, width: 61, height: 50 },
        { x: 0, y: 0, width: 60, height: 51 },
        { x: -1, y: 0, width: 5, height: 5 },
        { x: 0, y: -1, width: 5, height: 5 },
        { x: 0, y: 0, width: 0, height: 5 },
        { x: 0, y: 0, width: 5, height: 0 },
        { x: 0, y: 0, width: Number.NaN, height: 5 },
        { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 5 },
        { x: 0, y: 0, width: '5', height: 5 },
    ];
    for (const box of oneTooFar) {
        assert.throws(() => assertRectInside(picture, box), /must be whole pixels inside the 60x50 picture/, JSON.stringify(box));
    }
});
